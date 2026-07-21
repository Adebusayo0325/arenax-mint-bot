/**
 * openSeaEngine.js
 *
 * DATA (floor, listings, sweep, portfolio, contract metadata): api.opensea.io/api/v2 — API key only.
 * There is no public OpenSea REST endpoint for primary-mint "drop" stage/price
 * data — that only exists inside opensea.io's own session-authenticated GraphQL.
 * MINT: 2 routes tried in order:
 *   Route 1 — SIWE + GraphQL (mirrors the actual website mint flow — the only
 *             route that can read/execute real primary-mint "drop" stages)
 *   Route 2 — Seaport order fulfillment (for buying already-listed/relisted items,
 *             not primary mint — uses the real /orders and /listings/fulfillment_data endpoints)
 */

const { ethers } = require('ethers');
const { getProvider } = require('../utils/rpcManager');
const { getGasParams, buildGasParamsFromOverride, getEffectiveFeePerGas } = require('./gasOracle');
const logger = require('../utils/logger');

const OPENSEA_API = 'https://api.opensea.io/api/v2';
const OS_ORIGIN   = 'https://opensea.io';
const OS_GQL      = 'https://gql.opensea.io/graphql';
const SEAPORT     = '0x0000000000000068F116a894984e2DB1123eB395';

const CHAIN_SLUG = {
  1:'ethereum', 8453:'base', 10:'optimism', 42161:'arbitrum',
  137:'matic', 81457:'blast', 7777777:'zora', 59144:'linea',
  56:'bsc', 43114:'avalanche', 33139:'apechain',
};

function apiKey() { return process.env.OPENSEA_API_KEY || ''; }

function apiHeaders() {
  return { 'accept':'application/json','content-type':'application/json', ...(apiKey()?{'x-api-key':apiKey()}:{}) };
}
function webHeaders(cookie='') {
  return {
    'accept':'application/json','content-type':'application/json',
    'origin':OS_ORIGIN,'referer':OS_ORIGIN+'/','x-app-id':'os2-web',
    'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
    ...(cookie?{cookie}:{}),
    ...(apiKey()?{'x-api-key':apiKey()}:{}),
  };
}

async function osFetch(url, opts={}) {
  const res = await fetch(url, {...opts, headers:{...apiHeaders(),...(opts.headers||{})}});
  if (!res.ok) { const t = await res.text().catch(()=>''); throw new Error(`OpenSea ${res.status} [${url.split('/').slice(-2).join('/')}]: ${t.slice(0,150)}`); }
  return res.json();
}

// ── SIWE AUTH ─────────────────────────────────────────────────────────────────
async function osSiweLogin(signer, chainId=1) {
  const addr = ethers.getAddress(signer.address);
  // Try both known nonce endpoints (self-adapting if OpenSea moves it)
  let nonceRes;
  for (const ep of [`${OS_ORIGIN}/__api/auth/siwe/nonce`, `${OS_ORIGIN}/api/auth/siwe/nonce`]) {
    try {
      nonceRes = await fetch(ep, { method:'POST', headers:webHeaders(), body:JSON.stringify({address:addr}) });
      if (nonceRes.ok) break;
    } catch(_) {}
  }
  if (!nonceRes?.ok) throw new Error(`SIWE nonce unreachable (${nonceRes?.status||'network error'}) — falling back to API routes`);
  const nd = await nonceRes.json().catch(()=>({}));
  const nonce = nd.nonce || nd.data?.nonce;
  if (!nonce) throw new Error(`SIWE: no nonce in response`);

  const issuedAt = new Date().toISOString();
  const message = [
    `opensea.io wants you to sign in with your account:`,addr,'',
    'Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).',
    '',`URI: https://opensea.io/`,`Version: 1`,`Chain ID: ${chainId}`,`Nonce: ${nonce}`,`Issued At: ${issuedAt}`,
  ].join('\n');
  const signature = await signer.signMessage(message);

  let verifyRes;
  const vBody = JSON.stringify({
    message:{domain:'opensea.io',address:addr,statement:'Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).',
    uri:'https://opensea.io/',version:'1',chainId:String(chainId),nonce,issuedAt},
    signature, chainArch:'EVM', connectorId:'injected',
  });
  for (const ep of [`${OS_ORIGIN}/__api/auth/siwe/verify`, `${OS_ORIGIN}/api/auth/siwe/verify`]) {
    try {
      verifyRes = await fetch(ep, { method:'POST', headers:webHeaders(), body:vBody });
      if (verifyRes.ok) break;
    } catch(_) {}
  }
  if (!verifyRes?.ok) { const t = await verifyRes?.text().catch(()=>''); throw new Error(`SIWE verify failed (${verifyRes?.status}): ${t.slice(0,100)}`); }

  // Extract session cookie — handle both header formats
  const cookieMap = {};
  const rawCookies = [];
  try { const r = verifyRes.headers.raw?.()?.['set-cookie']||[]; rawCookies.push(...r); } catch(_) {}
  const sc = verifyRes.headers.get('set-cookie');
  if (sc) rawCookies.push(sc);
  for (const c of rawCookies) {
    for (const part of c.split(',')) {
      const [pair] = part.trim().split(';');
      const eq = pair.indexOf('=');
      if (eq>-1) cookieMap[pair.slice(0,eq).trim()] = pair.slice(eq+1).trim();
    }
  }
  if (!cookieMap['access_token']) {
    const body = await verifyRes.json().catch(()=>({}));
    const t = body.access_token||body.token||body.data?.access_token;
    if (t) cookieMap['access_token'] = t;
    else throw new Error('SIWE ok but no access_token in response — OpenSea may have changed cookie format');
  }
  const cookie = Object.entries(cookieMap).map(([k,v])=>`${k}=${v}`).join('; ');
  logger.info(`[OpenSea/SIWE] Authenticated ${addr.slice(0,8)}...`);
  return cookie;
}

// ── GRAPHQL CALLDATA ──────────────────────────────────────────────────────────
async function osFetchCalldataGQL(signer, contractAddr, chainSlug, qty, cookie) {
  const res = await fetch(OS_GQL, {
    method:'POST', headers:webHeaders(cookie),
    body: JSON.stringify({
      id:'DropMintMutation',
      query:`mutation DropMintMutation($input:DropMintInput!){drop{mint(input:$input){transaction{to data value}error}}}`,
      variables:{ input:{ chain:chainSlug, contractAddress:contractAddr, quantity:qty, walletAddress:signer.address } },
    }),
  });
  if (!res.ok) throw new Error(`GQL ${res.status}`);
  const data = await res.json();
  const tx  = data?.data?.drop?.mint?.transaction;
  const err = data?.data?.drop?.mint?.error;
  if (err) throw new Error(`GQL mint: ${err}`);
  if (!tx?.to) throw new Error('GQL mint: no transaction returned');
  return tx;
}

// ── DATA FUNCTIONS (API v2 — floor price, listings, portfolio, sweep) ─────────
// NOTE: OpenSea has no public "Drops" REST resource (confirmed against
// docs.opensea.io/reference — only contract/orders/offers/listings/fulfillment_data
// exist). The old getDropInfo/getDropStages/getMintFulfillmentData here hit
// invented /v2/drops/... paths that always 404'd, so phase-check silently got
// zero real signal from OpenSea. getDropInfo now uses the real Get Contract
// endpoint (verified collection metadata). There is no documented replacement
// for stage/price data — OpenSea only exposes that on opensea.io itself via
// the internal SIWE+GraphQL session (see Route 1 in mintViaOpenSea below).
async function getDropInfo(contractAddress, chainId=1) {
  const chain = CHAIN_SLUG[chainId]||'ethereum';
  try { return await osFetch(`${OPENSEA_API}/chain/${chain}/contract/${contractAddress.toLowerCase()}`); }
  catch(e) { logger.debug(`[OS/Contract] ${e.message}`); return null; }
}
// Deprecated: no public OpenSea endpoint returns primary-mint stage data.
// Kept as a no-op stub (rather than calling a fake URL) so existing callers
// that expect this export don't crash.
async function getDropStages(_contractAddress, _chainId=1) {
  return [];
}
function findActiveStage(stages=[]) {
  const now = Date.now()/1000;
  const active = stages.filter(s => {
    const start = s.start_time ? new Date(s.start_time).getTime()/1000 : 0;
    const end   = s.end_time   ? new Date(s.end_time).getTime()/1000   : Infinity;
    return now>=start && now<end;
  });
  return active.find(s=>s.stage_type==='public')||active[0]||null;
}
async function getFulfillmentData(orderHash, protocolAddress, fulfillerAddress, chainId=1) {
  const chain = CHAIN_SLUG[chainId]||'ethereum';
  return osFetch(`${OPENSEA_API}/listings/fulfillment_data`, {
    method:'POST',
    body: JSON.stringify({ listing:{hash:orderHash,chain,protocol_address:protocolAddress}, fulfiller:{address:fulfillerAddress} }),
  });
}
async function getMintOrders(contractAddress, chainId=1, limit=20) {
  // FIX: this used to call GET /v2/orders/{chain}/seaport/listings, which
  // returns 405 Method Not Allowed on OpenSea's current API (that endpoint's
  // signature-vending behavior changed and it looks to have been retired for
  // GET). The 405 was being misreported to the user as "likely wrong chain
  // selected" — that text was a guess, not a real diagnosis; the actual chain
  // was never the problem. This now uses the same /listings/collection/{slug}/all
  // endpoint that nftManager.js's getFloorListings() already uses successfully.
  const { getCollectionSlug } = require('./nftManager');
  let slug;
  try {
    slug = await getCollectionSlug(contractAddress, chainId);
  } catch (e) {
    throw new Error(`Could not resolve OpenSea collection for ${contractAddress}: ${e.message}`);
  }
  if (!slug) throw new Error(`No OpenSea collection found for ${contractAddress} on chain ${chainId}`);
  const data = await osFetch(`${OPENSEA_API}/listings/collection/${slug}/all?limit=${Math.min(limit,50)}`);
  const listings = data.listings || [];
  // NOTE: order_hash/protocol_address field names below are my best-evidence
  // read of OpenSea's v2 listings response shape (I don't have live network
  // access to confirm against a real response). If mints still fail after
  // this fix, check Render logs for the actual error and we'll adjust the
  // field names to match what's really coming back.
  return listings.map(l => ({
    order_hash: l.order_hash || l.protocol_data?.order_hash,
    protocol_address: l.protocol_address || l.protocol_data?.protocol_address || SEAPORT,
    current_price: l.price?.current?.value,
  })).filter(o => o.order_hash);
}
// Deprecated: no public OpenSea endpoint fulfills primary-mint "drop" stages
// directly. Kept as a no-op stub for backward compatibility — real mint
// execution goes through Route 1 (SIWE+GraphQL) or Route 2 (Seaport orders)
// in mintViaOpenSea below.
async function getMintFulfillmentData(_contractAddress, _walletAddress, _quantity, _stageIndex=0, _chainId=1) {
  return null;
}

// ── PHASE DETECTION ───────────────────────────────────────────────────────────
// OpenSea's public API has no endpoint for primary-mint stage/price data, so
// this can only report what's genuinely available: verified collection
// metadata (Get Contract) and secondary-market Seaport listing prices. It
// deliberately never claims 'verified' phase/price it doesn't actually have —
// the caller (server.js /api/phase) falls back to on-chain SeaDrop detection
// and bytecode fingerprinting for real primary-mint phase, which is the
// correct source of truth since SeaDrop is the actual contract OpenSea drops
// run on.
async function getOpenSeaPhase(contractAddress, chainId=1) {
  if (!apiKey()) return { phase:'UNKNOWN', note:'No OPENSEA_API_KEY set' };
  let collectionNote = null;
  try {
    const contract = await getDropInfo(contractAddress, chainId);
    if (contract) collectionNote = contract.collection ? `OpenSea collection: ${contract.collection}` : 'Contract verified on OpenSea';
  } catch(e) { logger.debug(`[OS/Phase/Contract] ${e.message}`); }
  try {
    const orders = await getMintOrders(contractAddress, chainId, 5);
    if (orders.length>0) {
      const price = orders[0]?.current_price?ethers.formatEther(BigInt(orders[0].current_price)):null;
      return { phase:'PUBLIC', confidence:'heuristic', mintPrice:price, note:`${collectionNote?collectionNote+' — ':''}${orders.length} active Seaport listing(s), price:${price||'free'} ETH (secondary market, not confirmed primary-mint price)`, method:'seaport_orders' };
    }
  } catch(e) { logger.debug(`[OS/Phase/Orders] ${e.message}`); }
  return { phase:'UNKNOWN', confidence:'none', note:collectionNote||'No OpenSea listings found — check SeaDrop/on-chain detection instead' };
}

async function isOpenSeaDrop(contractAddress, chainId=1) {
  if (!apiKey()) return false;
  try { const o = await getMintOrders(contractAddress, chainId, 1); if (o.length>0) return true; } catch {}
  try { const contract = await getDropInfo(contractAddress, chainId); return !!contract; } catch { return false; }
}

// ── TX EXECUTOR ───────────────────────────────────────────────────────────────
async function _exec({ tx, walletAddress, signer, provider, gasParams, effectiveFee, dryRun, spendLimitEth, fn }) {
  const value = tx.value?BigInt(tx.value):0n;
  const data  = tx.data||tx.input||'0x';
  if (spendLimitEth!==null && parseFloat(ethers.formatEther(value))>spendLimitEth)
    return { walletAddress, status:'skipped', error:`Spend limit ${spendLimitEth} ETH < ${ethers.formatEther(value)} ETH` };
  const bal = await provider.getBalance(walletAddress);
  let gasLimit;
  try { const est = await provider.estimateGas({to:tx.to,data,value,from:walletAddress}); gasLimit=est*120n/100n; }
  catch { gasLimit=350000n; }
  if (bal<value+effectiveFee*gasLimit)
    return { walletAddress, status:'failed', error:`Insufficient: have ${parseFloat(ethers.formatEther(bal)).toFixed(5)}, need ~${parseFloat(ethers.formatEther(value+effectiveFee*gasLimit)).toFixed(5)} ETH` };
  if (dryRun) {
    try { await provider.call({to:tx.to,data,value,from:walletAddress}); return {walletAddress,status:'dry-run-ok',fn,value:ethers.formatEther(value)}; }
    catch(e) { return {walletAddress,status:'dry-run-fail',fn,error:e.message?.slice(0,150)}; }
  }
  const sent = await signer.sendTransaction({to:tx.to,data,value,gasLimit,...gasParams});
  logger.info(`[OS/${fn}] tx ${sent.hash} [${walletAddress.slice(0,8)}]`);
  const receipt = await sent.wait();
  return {
    walletAddress, status:receipt.status===1?'success':'failed', fn,
    txHash:sent.hash, gasUsed:receipt.gasUsed.toString(),
    gasCostEth:ethers.formatEther(receipt.gasUsed*(receipt.gasPrice||effectiveFee)),
  };
}

// ── MAIN MINT (3 routes, self-adapting) ──────────────────────────────────────
async function mintViaOpenSea({ contractAddress, walletAddress, privateKey, quantity=1, gweiOverride=null, chainId=1, dryRun=false, spendLimitEth=null }) {
  const provider     = await getProvider(chainId);
  const signer       = new ethers.Wallet(privateKey, provider);
  const gasParams    = gweiOverride ? await buildGasParamsFromOverride(gweiOverride,chainId) : await getGasParams(1.15,chainId);
  const effectiveFee = await getEffectiveFeePerGas(chainId);
  const chainSlug    = CHAIN_SLUG[chainId]||'ethereum';
  const log          = [];

  // Route 1: SIWE + GraphQL
  try {
    const cookie = await osSiweLogin(signer, chainId);
    log.push('SIWE:ok');
    try {
      const tx = await osFetchCalldataGQL(signer, contractAddress, chainSlug, quantity, cookie);
      log.push('GQL:ok');
      return await _exec({tx,walletAddress,signer,provider,gasParams,effectiveFee,dryRun,spendLimitEth,fn:'SIWE+GQL'});
    } catch(e) { log.push(`GQL:${e.message.slice(0,60)}`); logger.warn(`[OS/GQL] ${e.message}`); }
  } catch(e) { log.push(`SIWE:${e.message.slice(0,80)}`); logger.warn(`[OS/SIWE] ${e.message}`); }

  // Route 2: Seaport orders (real listings — secondary market / relisted mints)
  try {
    const orders = await getMintOrders(contractAddress, chainId, quantity*3);
    if (!orders.length) return {walletAddress,status:'failed',error:`No active Seaport orders.\nRoutes: ${log.join(' → ')}`};
    const results = [];
    for (const order of orders.slice(0,quantity)) {
      try {
        const fd = await getFulfillmentData(order.order_hash, order.protocol_address||SEAPORT, walletAddress, chainId);
        const tx = fd?.fulfillment_data?.transaction;
        if (!tx) { results.push({status:'failed',error:'No tx from fulfillment_data'}); continue; }
        results.push(await _exec({tx,walletAddress,signer,provider,gasParams,effectiveFee,dryRun,spendLimitEth,fn:'SeaportOrder'}));
      } catch(e) { results.push({status:'failed',error:e.message?.slice(0,120)}); }
    }
    const ok = results.filter(r=>r.status==='success'||r.status==='dry-run-ok').length;
    return {walletAddress,status:ok===results.length?(dryRun?'dry-run-ok':'success'):ok>0?'partial':'failed',results,fn:'SeaportOrder'};
  } catch(e) {
    return {walletAddress,status:'failed',error:`OpenSea mint failed.\nRoutes tried: ${log.join(' → ')}\nReason: ${e.message.slice(0,200)}`};
  }
}

module.exports = {
  mintViaOpenSea, getOpenSeaPhase, isOpenSeaDrop, osSiweLogin,
  getDropInfo, getDropStages, findActiveStage,
  getMintOrders, getFulfillmentData, getMintFulfillmentData,
  SEAPORT,
};

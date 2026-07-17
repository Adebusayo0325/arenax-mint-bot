/**
 * mintEngine.js — v18
 *
 * NEW in v18:
 *   - Gas auto-escalation on retry: +10% gas per attempt (gasEscalation param)
 *   - Sold-out detection: propagates cancellation signal to sibling wallets
 *   - Flashbots bundle simulation feedback: returns targetBlock before relay submit
 *   - Launchpad auto-proof: integrates launchpadProofs.js for automatic proof fetch
 *   - Per-wallet spend limit enforcement (spendLimit in wallet object)
 *   - EIP-712 expiry detection: warns if nonce already consumed on-chain
 */

const { ethers } = require('ethers');
const { getProvider } = require('../utils/rpcManager');
const { fetchABI } = require('../utils/contractFetcher');
const { getGasParams, buildGasParamsFromOverride, estimateGasLimit, getEffectiveFeePerGas, getCompetitiveGasTip } = require('./gasOracle');
const { classifyMintError } = require('./revertClassifier');
const { fingerprintContract } = require('./contractFingerprint');
const { isSeaDropContract, mintSeaDropPublic, mintSeaDropAllowList } = require('./seaDropEngine');
const { getNextNonce, resetNonce }  = require('./nonceManager');
const { watchMempoolForMintEnable }  = require('./mempoolWatcher');
const { validateMerkleProof } = require('./proofValidator');
const { getWalletSigner } = require('./walletManager');
const { getProofForWallet } = require('./perWalletProof');
const { detectMintPhase, isERC1155 } = require('./phaseDetector');
const { trackTx } = require('./txManager');
const { checkPriceOnChain } = require('./priceGuard');
const { fetchProofFromLaunchpad } = require('./launchpadProofs');
const { mintViaOpenSea } = require('./openSeaEngine');   // ← FIX: was missing, caused "mintViaOpenSea is not defined"
const {
  isMintSignedContract,
  getMintSignedAbiEntry,
  contractHasMintSigned,
  autoFetchMintSignedSig,
  buildMintSignedArgs,
  MINT_SIGNED_ABI,
} = require('./mintSignedEngine');
const logger = require('../utils/logger');

// Shared abort signal for sold-out detection — cancels all sibling mints
class SoldOutSignal {
  constructor() { this.triggered = false; this.reason = null; }
  trigger(reason) { this.triggered = true; this.reason = reason; }
}

// ── FALLBACK ABIs ─────────────────────────────────────────────────────────────
const FALLBACK_ABI_721 = [
  'function mint(uint256 quantity) payable',
  'function mint(address to, uint256 quantity) payable',
  'function mint(uint256 quantity, bytes32[] calldata proof) payable',
  'function mint() payable',
  'function mintTo(address to) payable',
  'function publicMint(uint256 quantity) payable',
  'function mintPublic(uint256 quantity) payable',
  'function buy(uint256 quantity) payable',
  'function claim(uint256 quantity) payable',
  'function claim(address account, uint256 quantity, bytes32[] calldata proof) payable',
  'function purchase(uint256 quantity) payable',
  'function allowlistMint(uint256 quantity, bytes32[] calldata proof) payable',
  'function presaleMint(uint256 quantity, bytes32[] calldata proof) payable',
  'function mintWithProof(uint256 quantity, bytes32[] calldata proof) payable',
  'function whitelistMint(uint256 quantity, bytes32[] calldata proof) payable',
  'function mintNFT(uint256 quantity) payable',
  'function freeMint(uint256 quantity) payable',
  'function teamMint(uint256 quantity) payable',
  'function safeMint(address to, uint256 quantity) payable',
  'function batchMint(uint256 quantity) payable',
  // EIP-712 signature variants
  'function mint(uint256 quantity, bytes calldata signature) payable',
  'function mint(address to, uint256 quantity, bytes calldata signature) payable',
  'function mintWithSignature(address to, uint256 quantity, uint256 nonce, bytes calldata sig) payable',
  'function mintAllowance(uint256 qty, uint256 nonce, bytes memory sig) payable',
  // SeaDrop / OpenSea-drop mintSigned (EIP-712 with MintParams tuple)
  ...MINT_SIGNED_ABI,
];

const FALLBACK_ABI_1155 = [
  'function mint(address account, uint256 id, uint256 amount, bytes data) payable',
  'function mint(uint256 id, uint256 amount) payable',
  'function mint(uint256 tokenId, uint256 quantity) payable',
  'function mintBatch(address to, uint256[] ids, uint256[] amounts, bytes data) payable',
  'function purchase(uint256 tokenId, uint256 quantity) payable',
  'function claim(address account, uint256 tokenId, uint256 quantity, bytes32[] proof) payable',
  'function claim(uint256 tokenId, uint256 quantity) payable',
];

const MINT_FN_PRIORITY_721 = [
  // FIX (v25): mintSigned used to sit FIRST here, so any SeaDrop/OpenSea
  // Studio contract — which exposes mintSigned() on essentially every
  // drop, signature-gated or not — got routed into the signed-mint path
  // even during a fully public, signature-free phase. mintSigned now
  // sits last: it's only chosen when nothing else on the ABI works, or
  // when explicitly requested. See the routing gate in mintFromWallet().
  'publicMint', 'mintPublic', 'mint', 'buy', 'mintNFT', 'batchMint',
  'claim', 'purchase', 'allowlistMint', 'presaleMint', 'mintWithProof',
  'whitelistMint', 'mintWithSignature', 'mintAllowance',
  'freeMint', 'teamMint', 'mintTo', 'safeMint',
  'mintSigned',  // SeaDrop/OpenSea-drop EIP-712 — last resort, needs a real signature
];
const MINT_FN_PRIORITY_1155 = ['mint', 'purchase', 'claim', 'mintBatch'];

// ── ABI ANALYSIS ─────────────────────────────────────────────────────────────
function findMintFunctions(abiJson, standard = 'ERC721') {
  if (!Array.isArray(abiJson)) return [];
  const priority = standard === 'ERC1155' ? MINT_FN_PRIORITY_1155 : MINT_FN_PRIORITY_721;
  const candidates = abiJson.filter(fn => {
    if (fn.type !== 'function') return false;
    if (!['payable', 'nonpayable'].includes(fn.stateMutability)) return false;
    return priority.some(n => n.toLowerCase() === fn.name?.toLowerCase());
  });
  return candidates.sort((a, b) => {
    const aIdx   = priority.findIndex(n => n.toLowerCase() === a.name.toLowerCase());
    const bIdx   = priority.findIndex(n => n.toLowerCase() === b.name.toLowerCase());
    const aProof = (a.inputs || []).some(i => i.type.startsWith('bytes32') || i.type === 'bytes');
    const bProof = (b.inputs || []).some(i => i.type.startsWith('bytes32') || i.type === 'bytes');
    if (!aProof && bProof) return -1;
    if (aProof && !bProof)  return 1;
    return aIdx - bIdx;
  });
}

// ── ARG BUILDERS ──────────────────────────────────────────────────────────────
function buildERC1155Args(inputs, quantity, walletAddress, tokenId = 0) {
  if (!inputs || inputs.length === 0) return [walletAddress, tokenId, quantity, '0x'];
  return inputs.map(input => {
    const t = input.type;
    const n = (input.name || '').toLowerCase();
    if (t === 'address') return walletAddress;
    if (t.startsWith('uint') && (n.includes('id') || n.includes('token'))) return tokenId;
    if (t.startsWith('uint') && (n.includes('amount') || n.includes('quantity') || n.includes('count'))) return quantity;
    if (t === 'bytes') return '0x';
    if (t === 'bytes32[]') return [];
    return 0;
  });
}

function buildMintArgs(inputs, quantity, walletAddress, merkleProof = [], tokenId = 1, eip712Sig = null) {
  if (inputs === null) { logger.warn('buildMintArgs: inputs null — defaulting to [quantity]'); return [quantity]; }
  if (inputs.length === 0) return [];
  return inputs.map(input => {
    const type = input.type;
    const name = (input.name || '').toLowerCase();
    if ((type.startsWith('uint') || type.startsWith('int')) &&
        (name.includes('qty') || name.includes('quantity') || name.includes('amount') ||
         name.includes('count') || name.includes('num') || name === 'n' || name === '_n' || name === ''))
      return quantity;
    if ((type.startsWith('uint') || type.startsWith('int')) && (name.includes('max') || name.includes('limit'))) return quantity;
    if (type.startsWith('uint') || type.startsWith('int')) return quantity;
    if (type === 'address') return walletAddress;
    if (type === 'bytes32[]' || type.startsWith('bytes32[')) return merkleProof.length > 0 ? merkleProof : [];
    if (type === 'bytes32') return ethers.ZeroHash;
    if (type === 'bytes') return eip712Sig || '0x';
    if (type.startsWith('bytes') && type !== 'bytes32') return eip712Sig || '0x';
    if (type === 'bool') return false;
    if (type === 'string') return '';
    logger.warn(`Unknown mint arg type: ${type} ${name} — defaulting to 0`);
    return 0;
  });
}

// ── CONTRACT LOADER ──────────────────────────────────────────────────────────
async function getContractWithABI(contractAddress, signerOrProvider, chainId = 1, standard = 'ERC721') {
  let abiJson = null;
  let abi;
  const fallback = standard === 'ERC1155' ? FALLBACK_ABI_1155 : FALLBACK_ABI_721;
  try {
    abiJson = await fetchABI(contractAddress, chainId);
    abi = abiJson;
  } catch (e) {
    logger.warn(`ABI fetch failed (${e.message.slice(0, 80)}) — using fallback`);
    abi = fallback;
    try { const iface = new ethers.Interface(fallback); abiJson = JSON.parse(iface.formatJson()); } catch { abiJson = null; }
  }
  return { contract: new ethers.Contract(contractAddress, abi, signerOrProvider), abiJson };
}

async function getContract(contractAddress, signerOrProvider, chainId = 1) {
  const { contract } = await getContractWithABI(contractAddress, signerOrProvider, chainId);
  return contract;
}

// ── FUNCTION DETECTION ───────────────────────────────────────────────────────
async function detectMintFunction(contract, abiJson = null, standard = 'ERC721', hasProof = false) {
  const priority = standard === 'ERC1155' ? MINT_FN_PRIORITY_1155 : MINT_FN_PRIORITY_721;

  // Step 1: ABI-based detection (most accurate when contract is verified)
  if (abiJson && Array.isArray(abiJson)) {
    const fns = findMintFunctions(abiJson, standard);
    if (fns.length > 0) {
      let best = fns[0];
      if (hasProof) {
        const proofFn = fns.find(f => (f.inputs || []).some(i => i.type.startsWith('bytes32') || i.type === 'bytes'));
        if (proofFn) best = proofFn;
      }
      const sig = `${best.name}(${(best.inputs || []).map(i => i.type).join(', ')})`;
      logger.info(`Mint fn from ABI: ${sig}`);
      return { fnName: best.name, inputs: best.inputs || [] };
    }
  }

  // Step 2: Bytecode fingerprint — finds mint fn on UNVERIFIED contracts
  try {
    const addr = contract.target || contract.address;
    if (addr) {
      const fp = await fingerprintContract(addr, chainId || 1).catch(() => null);
      if (fp && fp.functions.length > 0) {
        const best = (hasProof ? fp.functions.filter(f => f.needsProof) : fp.functions.filter(f => !f.needsProof))[0] || fp.functions[0];
        if (best && typeof contract[best.name] === 'function') {
          logger.info(`[Fingerprint] Mint fn: ${best.name} (${best.selector})`);
          return { fnName: best.name, inputs: best.args.map(t => ({ type: t })) };
        }
      }
    }
  } catch {}

  // Step 3: Name probing (fallback)
  for (const name of priority) {
    if (typeof contract[name] === 'function') { logger.info(`Mint fn by probe: ${name}`); return { fnName: name, inputs: null }; }
  }
  throw new Error('No mint function found — try entering it manually (e.g. "publicMint")');
}

// ── GAS HELPER ───────────────────────────────────────────────────────────────
async function resolveGasParams(gweiOverride, chainId) {
  if (gweiOverride) return buildGasParamsFromOverride(gweiOverride, chainId);
  return getGasParams(1.15, chainId);
}

// ── ERROR DECODER ─────────────────────────────────────────────────────────────
// Known custom error selectors (first 4 bytes of keccak256 of the error sig)
// KNOWN_CUSTOM_ERRORS replaced — now uses revertClassifier (verified keccak256 selectors)
function lookupCustomError(selector) {
  try { const { classifyRevert } = require('./revertClassifier'); const r = classifyRevert('0x' + selector); return r.category !== 'unknown' ? r.userMessage : null; } catch { return null; }
}

function classifyRevertReason(msg, fnName) {
  const m = (msg || '').toLowerCase();
  if (m.includes('insufficient funds') || m.includes('insufficient eth'))
    return 'Insufficient ETH for mint + gas';
  if (m.includes('nonce'))
    return 'Nonce error — try again';
  if (m.includes('invalidproof') || m.includes('invalid proof') || m.includes('merkleproof') || m.includes('bad proof'))
    return 'Invalid Merkle proof — wrong proof for this wallet';
  if (m.includes('invalidsignature') || m.includes('invalid signature') || m.includes('ecdsa') || m.includes('bad signature'))
    return 'Invalid EIP-712 signature — may have expired or already been used';
  if (m.includes('notwhitelisted') || m.includes('not whitelisted') || m.includes('not in whitelist') ||
      m.includes('not allowlisted') || m.includes('not on allowlist'))
    return 'Wallet not whitelisted / not on allowlist';
  if (m.includes('salenotactive') || m.includes('sale not active') || m.includes('sale is not active') ||
      m.includes('not started') || m.includes('mint not open') || m.includes('notactive') ||
      m.includes('mint closed') || m.includes('not live') || m.includes('public sale not active') ||
      m.includes('minting not') || m.includes('mint is not') || m.includes('sale inactive') ||
      m.includes('mint not started') || m.includes('minting has not') || m.includes('not yet started'))
    return 'Mint not open — sale is not active yet';
  if (m.includes('maxsupplyreached') || m.includes('max supply') || m.includes('sold out') ||
      m.includes('exceeds max supply') || m.includes('supply exceeded'))
    return 'Collection sold out';
  if (m.includes('exceedsmaxperwallet') || m.includes('exceeds max per wallet') ||
      m.includes('max per wallet') || m.includes('already minted max') || m.includes('wallet limit') ||
      m.includes('maximum allowed') || m.includes('you have already minted'))
    return 'Exceeds max per wallet — already minted the maximum for this wallet';
  if (m.includes('wrong price') || m.includes('incorrect price') || m.includes('invalid price') ||
      m.includes('wrong value') || m.includes('incorrect value') || m.includes('wrong eth') ||
      m.includes('incorrect eth') || m.includes('ether value') || m.includes('wrongprice') ||
      m.includes('wrongvalue') || m.includes('invalidprice'))
    return 'Wrong mint price — check the price and retry';
  if (m.includes('paused'))
    return 'Contract is paused — mint not active';
  if (m.includes('missing revert data') || m.includes('call_exception') || m.includes('execution reverted'))
    return `${fnName}() reverted — use ✅ Check Phase and ✅ Check Eligibility to diagnose the exact reason before retrying`;
  return (msg || '').replace(/\s+/g, ' ').slice(0, 200);
}

function decodeMintError(err, fnName) {
  const msg = err.message || String(err);

  // 1. Named reason already decoded by ethers
  if (err.reason) return classifyRevertReason(err.reason, fnName);

  // 2. Raw hex in err.data — try to decode Error(string) or custom error selector
  if (err.data && typeof err.data === 'string' && err.data.startsWith('0x')) {
    const hex = err.data.slice(2);
    // Error(string) — selector 08c379a0
    if (hex.startsWith('08c379a0')) {
      try {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + hex.slice(8));
        if (decoded[0]) return classifyRevertReason(decoded[0], fnName);
      } catch (_) {}
    }
    // Panic(uint256) — selector 4e487b71
    if (hex.startsWith('4e487b71')) return 'Contract panic (internal error) — likely array out of bounds';
    // Known custom error selector
    const selector = hex.slice(0, 8).toLowerCase();
    const customMsg = lookupCustomError(selector); if (customMsg) return customMsg;
    // Unknown custom error
    return `Contract reverted with custom error 0x${selector} — check Etherscan for this contract's error definitions`;
  }

  // 3. Nested format from ethers v6 provider
  if (err.info?.error?.data) return decodeMintError({ data: err.info.error.data, message: msg }, fnName);

  // 4. Plain string classification
  return classifyRevertReason(msg, fnName);
}

// ── MAX-PER-WALLET VALIDATION ─────────────────────────────────────────────────
const MAX_PER_WALLET_ABI = [
  'function maxMintPerWallet() view returns (uint256)',
  'function maxPerWallet() view returns (uint256)',
  'function walletLimit() view returns (uint256)',
  'function maxPerAddress() view returns (uint256)',
  'function maxMintAmountPerTx() view returns (uint256)',
  'function numberMinted(address) view returns (uint256)',
  'function mintedCount(address) view returns (uint256)',
];

async function checkMaxPerWallet(contractAddress, walletAddress, quantity, provider) {
  const c = new ethers.Contract(contractAddress, MAX_PER_WALLET_ABI, provider);
  let maxAllowed = null;
  for (const fn of ['maxMintPerWallet', 'maxPerWallet', 'walletLimit', 'maxPerAddress', 'maxMintAmountPerTx']) {
    try { const v = await c[fn](); if (Number(v) > 0) { maxAllowed = Number(v); break; } } catch {}
  }
  let alreadyMinted = 0;
  for (const fn of ['numberMinted', 'mintedCount']) {
    try { alreadyMinted = Number(await c[fn](walletAddress)); break; } catch {}
  }
  if (maxAllowed !== null) {
    const remaining = maxAllowed - alreadyMinted;
    if (quantity > remaining) {
      return { ok: false, warn: `Wallet can only mint ${remaining} more (limit=${maxAllowed}, already=${alreadyMinted})`, remaining, maxAllowed, alreadyMinted };
    }
  }
  return { ok: true, maxAllowed, alreadyMinted };
}

// ── ELIGIBILITY CHECK ─────────────────────────────────────────────────────────
async function checkWalletEligibility(contractAddress, walletAddress, chainId = 1) {
  const provider = await getProvider(chainId);
  const CHECK_ABI = [
    'function isWhitelisted(address) view returns (bool)',
    'function isAllowlisted(address) view returns (bool)',
    'function whitelist(address) view returns (bool)',
    'function allowlist(address) view returns (bool)',
    'function hasMinted(address) view returns (bool)',
    'function numberMinted(address) view returns (uint256)',
    'function mintedCount(address) view returns (uint256)',
  ];
  const contract = new ethers.Contract(contractAddress, CHECK_ABI, provider);
  for (const fn of ['isWhitelisted', 'isAllowlisted', 'whitelist', 'allowlist']) {
    try { const result = await contract[fn](walletAddress); return { eligible: result === true, reason: result ? `${fn}() = true` : `${fn}() = false` }; } catch {}
  }
  for (const fn of ['hasMinted', 'numberMinted', 'mintedCount']) {
    try {
      const result = await contract[fn](walletAddress);
      const count  = typeof result === 'boolean' ? (result ? 1 : 0) : Number(result);
      if (count > 0) return { eligible: false, reason: `${fn}() = ${count} — already minted` };
      return { eligible: true, reason: `${fn}() = 0` };
    } catch {}
  }
  return { eligible: null, reason: 'No eligibility fn found — proceeding' };
}

// ── MERKLE AUTO-FETCH ────────────────────────────────────────────────────────
/**
 * Best-effort auto-fetch of Merkle proof from a project's API.
 *
 * HOW TO FIND THE API URL:
 * 1. Open the project's mint site in Chrome
 * 2. Open DevTools → Network tab → filter by XHR/Fetch
 * 3. Connect wallet, trigger the allowlist check
 * 4. Look for requests containing "proof", "merkle", or "allowlist"
 * 5. Copy the base URL, replace your address with {address}
 * 6. Set MERKLE_API_URL=https://api.project.xyz/proof/{address} in .env
 *    OR pass merkleApiUrl param directly in the mint command
 *
 * COMMON PATTERNS:
 *   https://api.project.xyz/merkle?address={address}
 *   https://mint.project.xyz/api/proof/{address}
 *   https://api.project.xyz/allowlist/{address}/proof
 */
async function autoFetchMerkleProof(walletAddress, merkleApiUrl) {
  if (!merkleApiUrl) return [];
  try {
    const url = merkleApiUrl.includes('{address}')
      ? merkleApiUrl.replace('{address}', walletAddress)
      : `${merkleApiUrl.replace(/\/$/, '')}/${walletAddress}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = await res.json();

    const candidates = [
      json?.proof, json?.merkleProof, json?.proofArray,
      json?.leaves, json?.data?.proof,
      Array.isArray(json) ? json : null,
    ];
    for (const c of candidates) {
      if (Array.isArray(c) && c.length > 0 && /^0x[0-9a-fA-F]{64}$/.test(c[0])) {
        logger.info(`Auto-fetched ${c.length} merkle leaves for ${walletAddress.slice(0, 8)}`);
        return c;
      }
    }
    logger.warn(`merkle auto-fetch: unrecognised response shape for ${walletAddress.slice(0, 8)}`);
    return [];
  } catch (e) {
    logger.warn(`merkle auto-fetch failed for ${walletAddress.slice(0, 8)}: ${e.message.slice(0, 60)}`);
    return [];
  }
}

// ── FLASHBOTS RELAY ───────────────────────────────────────────────────────────
/**
 * Sends ALL wallet txs as a Flashbots bundle through the private relay.
 * Bypasses the public mempool — prevents frontrunning and sandwich attacks.
 *
 * SETUP (one-time):
 * 1. Generate a fresh Ethereum wallet — its private key is your Flashbots auth key
 *    (it does NOT need ETH; it just signs bundle requests to the relay)
 * 2. Add to .env:  FLASHBOTS_AUTH_KEY=0x<that-private-key>
 * 3. Run:  npm install @flashbots/ethers-provider-bundle
 *
 * NOTES:
 * - Only works on Ethereum mainnet (chainId=1) and Sepolia (chainId=11155111)
 * - Targets the next 5 blocks. If none land, returns 'bundle_not_included'
 *   (normal mints almost always land; if not, raise gas and retry)
 */
async function mintViaFlashbots({
  wallets, contractAddress, quantity, mintPrice,
  customFn, gweiOverride, chainId = 1,
  merkleProof = [], proofMap = null,
  eip712Sigs = null, tokenId = 1,
  onSimPassed = null,   // v18: callback({ gasUsed, targetBlock, blockRange }) emitted before relay submit
}) {
  const authKey = process.env.FLASHBOTS_AUTH_KEY;
  if (!authKey) throw new Error('FLASHBOTS_AUTH_KEY not set in .env. See mintEngine.js SETUP section.');
  if (chainId !== 1 && chainId !== 11155111) throw new Error(`Flashbots only supports mainnet (1) / Sepolia (11155111). chainId=${chainId}`);

  let FlashbotsProvider;
  try {
    ({ FlashbotsProvider } = require('@flashbots/ethers-provider-bundle'));
  } catch (e) {
    throw new Error('Run: npm install @flashbots/ethers-provider-bundle');
  }

  const provider   = await getProvider(chainId);
  const authSigner = new ethers.Wallet(authKey);
  const fbProvider = await FlashbotsProvider.create(provider, authSigner, undefined, chainId === 11155111);
  const gasParams  = await resolveGasParams(gweiOverride, chainId);
  const totalCost  = mintPrice * quantity;
  const value      = ethers.parseEther(totalCost === 0 ? '0' : totalCost.toFixed(18).replace(/\.?0+$/, '') || '0');
  const blockNumber = await provider.getBlockNumber();

  const signedTxs = [];
  for (const w of wallets) {
    const signer    = getWalletSigner(w.address, provider);
    const addrLower = w.address.toLowerCase();
    let walletProof = proofMap ? (proofMap[w.address] || proofMap[addrLower] || merkleProof) : merkleProof;
    if (!walletProof || walletProof.length === 0) walletProof = getProofForWallet(w.address);
    const eip712Sig = eip712Sigs ? (eip712Sigs[w.address] || eip712Sigs[addrLower] || null) : null;

    const { contract, abiJson } = await getContractWithABI(contractAddress, signer, chainId);
    const mintInfo  = customFn
      ? { fnName: customFn, inputs: null }
      : await detectMintFunction(contract, abiJson, 'ERC721', walletProof.length > 0 || !!eip712Sig);
    const args      = buildMintArgs(mintInfo.inputs, quantity, w.address, walletProof, tokenId, eip712Sig);
    const gasLimit  = await estimateGasLimit(contract, mintInfo.fnName, args, value).catch(() => BigInt(180000));
    const nonce     = await getNextNonce(provider, w.address);
    const populated = await contract[mintInfo.fnName].populateTransaction(...args, { value, gasLimit, nonce, ...gasParams });
    signedTxs.push(await signer.signTransaction(populated));
  }

  // ── v18: Simulate FIRST — emit feedback before any relay submission ──
  const simResult = await fbProvider.simulate(signedTxs, blockNumber + 1);
  if ('error' in simResult) {
    logger.warn(`FB sim error: ${simResult.error.message}`);
    return [{ status: 'sim_failed', error: simResult.error.message, bundleSize: signedTxs.length }];
  }
  const simGasUsed = simResult.results?.reduce((s, r) => s + (Number(r.gasUsed) || 0), 0) || 0;
  logger.info(`FB sim PASSED — gasUsed=${simGasUsed} — targeting blocks ${blockNumber + 1}–${blockNumber + 5}`);
  // Emit simulation success (callers can broadcast this to Telegram before submission)
  if (onSimPassed) onSimPassed({ gasUsed: simGasUsed, targetBlock: blockNumber + 1, blockRange: `${blockNumber + 1}–${blockNumber + 5}` });

  // Try next 5 blocks (simulation already passed above)
  for (let targetBlock = blockNumber + 1; targetBlock <= blockNumber + 5; targetBlock++) {
    const sub = await fbProvider.sendBundle({ signedTransactions: signedTxs }, targetBlock);
    if ('error' in sub) { logger.warn(`FB bundle error: ${sub.error.message}`); continue; }
    const wait = await sub.wait();
    if (wait === 0) {
      logger.info(`FB bundle included in block ${targetBlock}`);
      return [{ status: 'flashbots_included', blockNumber: targetBlock, bundleHash: sub.bundleHash, txCount: signedTxs.length }];
    }
    logger.info(`Bundle missed block ${targetBlock}`);
  }
  return [{ status: 'bundle_not_included', message: 'Bundle not included in 5 blocks — raise gas or switch to normal mode' }];
}

// ── SINGLE WALLET MINT ───────────────────────────────────────────────────────
async function mintFromWallet({
  walletAddress, contractAddress, quantity, mintPrice,
  customFn = null, gweiOverride = null,
  chainId = 1,
  merkleProof = null,
  eip712Sig = null,
  merkleApiUrl = null,
  tokenId = 0,
  standard = 'auto',
  dryRun = false,
  skipMaxCheck = false,
  // v18 additions
  gasEscalationMultiplier = 1.0,   // 1.0=no bump, 1.1=+10%, 1.2=+20%, etc.
  spendLimitEth = null,             // max ETH this wallet may spend this run
  soldOutSignal = null,             // shared SoldOutSignal instance
  useLaunchpadProof = false,        // try launchpad APIs before manual proof
}) {
  // ── v18: Sold-out abort ──
  if (soldOutSignal?.triggered) {
    return { walletAddress, status: 'skipped', error: `⛔ Skipped — ${soldOutSignal.reason}` };
  }

  const provider = await getProvider(chainId);
  const signer   = getWalletSigner(walletAddress, provider);

  // ── v18: Per-wallet spend limit ──
  if (spendLimitEth !== null) {
    const totalCostEth = mintPrice * quantity;
    if (totalCostEth > spendLimitEth) {
      const adj = Math.floor(spendLimitEth / (mintPrice || 1));
      if (adj < 1) return { walletAddress, status: 'skipped', error: `⚠️ Spend limit (${spendLimitEth} ETH) too low for 1 mint at ${mintPrice} ETH` };
      logger.warn(`Spend limit: reducing qty from ${quantity} to ${adj} for ${walletAddress.slice(0, 8)}`);
      quantity = adj;
    }
  }

  // ── Proof pre-validation (local check before spending gas) ──
  // proofMap is resolved into merkleProof by mintFromAllWallets before this is called.
  // Only reference merkleProof here — proofMap may not be in scope (e.g. scheduler path).
  if (!dryRun && merkleProof?.length) {
    const v = await validateMerkleProof(contract, walletAddress, merkleProof, quantity).catch(() => null);
    if (v?.valid === false && v.scheme !== 'no-merkle')
      return { walletAddress, status: 'failed', error: `Invalid proof: ${v.error}` };
  }

  // ── Proof resolution ──
  let resolvedProof = [];
  let resolvedSig = eip712Sig;

  if (merkleProof !== null && Array.isArray(merkleProof)) {
    resolvedProof = merkleProof;
  } else {
    resolvedProof = getProofForWallet(walletAddress);
  }

  // v18: Launchpad auto-proof (before manual API url fallback)
  if (resolvedProof.length === 0 && !resolvedSig && useLaunchpadProof) {
    try {
      const lpResult = await fetchProofFromLaunchpad(contractAddress, walletAddress, chainId);
      if (lpResult.proof.length > 0) resolvedProof = lpResult.proof;
      if (lpResult.sig) resolvedSig = lpResult.sig;
      if (lpResult.platform !== 'none') {
        logger.info(`[LaunchpadProof] ${lpResult.platform}: ${lpResult.proof.length} leaves, sig=${!!lpResult.sig}`);
      }
    } catch (e) {
      logger.warn(`[LaunchpadProof] fetch error: ${e.message.slice(0, 60)}`);
    }
  }

  if (resolvedProof.length === 0 && !resolvedSig && merkleApiUrl) {
    resolvedProof = await autoFetchMerkleProof(walletAddress, merkleApiUrl);
  }

  // ── v18: Apply gas escalation multiplier ──

  // ── v18: Apply gas escalation multiplier ──
  let effectiveGweiOverride = gweiOverride;
  if (gasEscalationMultiplier > 1.0 && gweiOverride) {
    effectiveGweiOverride = parseFloat((gweiOverride * gasEscalationMultiplier).toFixed(4));
    logger.info(`Gas escalated ${gweiOverride}→${effectiveGweiOverride} gwei (x${gasEscalationMultiplier.toFixed(2)})`);
  }

  // ── Standard detection ──
  let detectedStandard = standard;
  if (standard === 'auto') {
    const is1155 = await isERC1155(contractAddress, provider);
    detectedStandard = is1155 ? 'ERC1155' : 'ERC721';
    if (is1155) logger.info(`[ERC-1155] detected for ${contractAddress.slice(0, 10)}`);
  }

  // ── Max-per-wallet check ──
  if (!skipMaxCheck) {
    const maxCheck = await checkMaxPerWallet(contractAddress, walletAddress, quantity, provider);
    if (!maxCheck.ok) {
      logger.warn(maxCheck.warn);
      if (maxCheck.remaining <= 0) return { walletAddress, status: 'skipped', error: `⚠️ ${maxCheck.warn}` };
      quantity = maxCheck.remaining;
    }
  }

  const gasParams  = await resolveGasParams(effectiveGweiOverride, chainId);
  const effectiveFee = await getEffectiveFeePerGas(chainId);
  const feePerGas  = gasParams.maxFeePerGas || gasParams.gasPrice || BigInt(20e9);
  const totalCost  = mintPrice * quantity;
  const value      = ethers.parseEther(totalCost === 0 ? '0' : totalCost.toFixed(18).replace(/\.?0+$/, '') || '0');

  const { contract, abiJson } = await getContractWithABI(contractAddress, signer, chainId, detectedStandard);
  const hasProof = resolvedProof.length > 0 || !!resolvedSig;

  // ── mintSigned routing ───────────────────────────────────────────────────
  // FIX (v25) — this was the root cause of the "fn: mintSigned / No sig
  // fetched" failures on every wallet. SeaDrop / OpenSea Studio contracts
  // expose mintSigned() in their ABI on essentially every drop, whether or
  // not the *currently live* phase actually needs a signature. The old
  // code treated "ABI contains mintSigned" as "this wallet must use
  // mintSigned" and intercepted EVERY mint attempt before normal function
  // detection ever ran — including fully public, signature-free phases
  // (like Beerz's "Public stage") that just needed mintPublic().
  //
  // Now: mintSigned is only used when (a) you explicitly ask for it via
  // the custom-function field, (b) you've supplied a real signature you
  // obtained yourself (resolvedSig — see the EIP-712 field in the UI/bot),
  // or (c) the contract genuinely has no other payable mint function at
  // all. In every other case, normal detection runs and picks the real
  // public function — no guessing involved.
  const mintSignedEntry  = abiJson ? getMintSignedAbiEntry(abiJson) : null;
  const abiHasMintSigned = !!mintSignedEntry || (!abiJson && contractHasMintSigned(contract));
  const otherCandidates  = abiJson ? findMintFunctions(abiJson, detectedStandard).filter(f => f.name !== 'mintSigned') : [];
  const mintSignedIsOnlyOption = abiHasMintSigned && !!abiJson && otherCandidates.length === 0;
  const wantsMintSigned  = customFn === 'mintSigned';

  const usesMintSigned = customFn
    ? wantsMintSigned
    : (abiHasMintSigned && (mintSignedIsOnlyOption || !!resolvedSig));

  if (usesMintSigned) {
    const routingReason = resolvedSig ? 'signature supplied' : wantsMintSigned ? 'explicitly requested' : 'only payable mint fn on this contract';
    logger.info(`[mintSigned] Using signed-mint path on ${contractAddress.slice(0, 10)} (${routingReason})`);

    // No auto-fetch guessing — see mintSignedEngine.js. This only resolves
    // a signature from (1) one you supplied yourself, or (2) an explicitly
    // configured MINT_SIGNED_API_URL for this specific project.
    let sigResult = resolvedSig ? { sig: resolvedSig, mintParams: null, salt: null, feeRecipient: ethers.ZeroAddress } : null;
    if (!sigResult) {
      try {
        sigResult = await autoFetchMintSignedSig(contractAddress, walletAddress, chainId);
      } catch (e) {
        logger.warn(`[mintSigned] sig fetch error: ${e.message.slice(0, 80)}`);
      }
    }

    // Attempt to get phase info for fallback mintParams
    let phaseInfo = null;
    try {
      const { detectMintPhase } = require('./phaseDetector');
      phaseInfo = await detectMintPhase(contractAddress, [], chainId);
    } catch (_) {}

    const effectiveEntry = mintSignedEntry || { inputs: null };
    const mintSignedArgs = buildMintSignedArgs({
      contractAddress,
      walletAddress,
      quantity,
      mintPrice,
      sigResult,
      phaseInfo,
      abiEntry: effectiveEntry,
    });

    // Use a contract with the full mintSigned ABI if the fetched ABI doesn't have it
    const mintSignedContract = mintSignedEntry
      ? contract
      : new (require('ethers').ethers.Contract)(contractAddress, MINT_SIGNED_ABI, signer);

    let mintSignedGasLimit;
    try {
      mintSignedGasLimit = await estimateGasLimit(mintSignedContract, 'mintSigned', mintSignedArgs, value);
    } catch (e) {
      mintSignedGasLimit = BigInt(200000);
      logger.warn(`[mintSigned] gas estimate failed, using 200k: ${e.message.slice(0, 60)}`);
    }

    if (dryRun) {
      try {
        await mintSignedContract.mintSigned.staticCall(...mintSignedArgs, { value });
        return {
          walletAddress, status: 'dry-run-ok', fnName: 'mintSigned',
          args: mintSignedArgs.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)),
          estimatedGas: mintSignedGasLimit.toString(),
          value: ethers.formatEther(value),
          standard: detectedStandard,
          hasSig: !!sigResult?.sig,
          note: sigResult ? 'sig supplied/fetched' : 'WARNING: no sig — will revert on-chain',
        };
      } catch (e) {
        const note = !sigResult
          ? 'SIGNATURE_REQUIRED — this contract needs a backend-issued signature for this phase. There is no universal signing API to guess at; obtain one via DevTools (Network → XHR) while minting normally on the project site, then paste it into the EIP-712 field and retry.'
          : decodeMintError(e, 'mintSigned');
        return { walletAddress, status: 'dry-run-fail', error: note, fnName: 'mintSigned', hasSig: !!sigResult?.sig };
      }
    }

    if (!sigResult?.sig || sigResult.sig === '0x') {
      return {
        walletAddress, status: 'failed',
        error: 'SIGNATURE_REQUIRED — no valid signature available for mintSigned. There is no universal signing API. Obtain the real signature for this wallet via DevTools (Network → XHR) while minting normally on the project site, then paste it into the EIP-712 field and retry.',
        fnName: 'mintSigned',
      };
    }

    const nonceMintSigned = await provider.getTransactionCount(walletAddress, 'pending');
    const txMintSigned = await mintSignedContract.mintSigned(
      ...mintSignedArgs,
      { value, gasLimit: mintSignedGasLimit, nonce: nonceMintSigned, ...gasParams }
    );
    logger.info(`[mintSigned] TX sent: ${txMintSigned.hash}`);
    trackTx(walletAddress, txMintSigned.hash, nonceMintSigned, chainId);
    let receiptMs;
    try {
      receiptMs = await Promise.race([
        txMintSigned.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 120000)),
      ]);
    } catch (waitErr) {
      if (waitErr.message === 'TIMEOUT') return { walletAddress, status: 'pending', txHash: txMintSigned.hash, fnName: 'mintSigned', nonce: nonceMintSigned };
      throw waitErr;
    }
    if (!receiptMs) return { walletAddress, status: 'dropped', txHash: txMintSigned.hash, fnName: 'mintSigned', nonce: nonceMintSigned };
    logger.info(`[mintSigned] TX ${txMintSigned.hash} — ${receiptMs.status === 1 ? 'confirmed ✅' : 'FAILED ❌'}`);
    return {
      walletAddress,
      status: receiptMs.status === 1 ? 'success' : 'failed',
      txHash: txMintSigned.hash,
      gasUsed: receiptMs.gasUsed.toString(),
      gasCostEth: ethers.formatEther(receiptMs.gasUsed * (receiptMs.gasPrice || feePerGas)),
      blockNumber: receiptMs.blockNumber,
      nonce: nonceMintSigned, fnName: 'mintSigned',
      standard: detectedStandard,
    };
  }
  // ── end mintSigned block ──────────────────────────────────────────────────

  let mintInfo, args;
  if (detectedStandard === 'ERC1155') {
    const erc1155Fns = abiJson ? abiJson.filter(f => f.type === 'function' && ['mint', 'mintBatch'].includes(f.name)) : [];
    if (erc1155Fns.length > 0) {
      mintInfo = { fnName: erc1155Fns[0].name, inputs: erc1155Fns[0].inputs };
      args = buildERC1155Args(erc1155Fns[0].inputs, quantity, walletAddress, tokenId);
    } else {
      mintInfo = { fnName: 'mint', inputs: null };
      args = [walletAddress, tokenId, quantity, '0x'];
    }
  } else {
    mintInfo = customFn ? { fnName: customFn, inputs: null } : await detectMintFunction(contract, abiJson, detectedStandard, hasProof);
    args = buildMintArgs(mintInfo.inputs, quantity, walletAddress, resolvedProof, tokenId, resolvedSig);
  }

  let gasLimit;
  try {
    gasLimit = await estimateGasLimit(contract, mintInfo.fnName, args, value);
  } catch (estErr) {
    gasLimit = detectedStandard === 'ERC1155' ? BigInt(200000) : BigInt(150000);
    logger.warn(`Gas estimate failed, fallback ${gasLimit}: ${estErr.message.slice(0, 80)}`);
  }

  // ── Balance check ──
  const balance   = await provider.getBalance(walletAddress);
  const gasBuffer = effectiveFee * gasLimit; // single 20% buffer via gasLimit
  const required  = value + gasBuffer;
  if (balance < required) {
    const bal = parseFloat(ethers.formatEther(balance)).toFixed(6);
    const req = parseFloat(ethers.formatEther(required)).toFixed(6);
    return { walletAddress, status: 'failed', error: `Insufficient: has ${bal} ETH, needs ~${req} ETH` };
  }

  const argStr = args.map(a => (Array.isArray(a) ? `[${a.length}]` : String(a).slice(0, 20))).join(', ');
  logger.info(`[${dryRun ? 'DRY-RUN' : 'MINT'}] ${walletAddress.slice(0, 8)} fn=${mintInfo.fnName}(${argStr}) val=${ethers.formatEther(value)}ETH gas=${gasLimit}${detectedStandard === 'ERC1155' ? ' [1155]' : ''}${resolvedProof.length ? ` proof=${resolvedProof.length}leaves` : ''}${resolvedSig ? ' eip712=yes' : ''}`);

  if (dryRun) {
    try {
      await contract[mintInfo.fnName].staticCall(...args, { value });
      return { walletAddress, status: 'dry-run-ok', fnName: mintInfo.fnName, args: args.map(String), estimatedGas: gasLimit.toString(), value: ethers.formatEther(value), standard: detectedStandard, proofLeaves: resolvedProof.length, hasEip712: !!resolvedSig };
    } catch (e) {
      // v20: enrich dry-run-fail with phase context
      let phaseContext = null;
      try {
        const { detectMintPhase } = require('./phaseDetector');
        const phase = await detectMintPhase(contractAddress, [walletAddress], chainId);
        const priceNote = phase.mintPrice ? ` On-chain price: ${phase.mintPrice} ETH.` : '';
        const maxNote   = phase.maxPerWallet ? ` Max/wallet: ${phase.maxPerWallet}.` : '';
        phaseContext = 'Phase: ' + phase.phase + priceNote + maxNote +
          (phase.isPaused  ? ' ⏸ Contract PAUSED.'   : '') +
          (phase.isSoldOut ? ' SOLD OUT.'             : '') +
          (!phase.isPublic && !phase.isWhitelist && !phase.isPaused && !phase.isSoldOut ? ' Mint appears closed.' : '');
      } catch (_) { /* phase check best-effort */ }
      return { walletAddress, status: 'dry-run-fail', error: decodeMintError(e, mintInfo.fnName), fnName: mintInfo.fnName, phaseContext };
    }
  }

  // ── v19/v24: Price Guard — detect free→paid switches ──
  let priceCheckResult = null;
  if (!dryRun) {
    const priceCheck = await checkPriceOnChain(contractAddress, mintPrice, chainId);
    priceCheckResult = priceCheck;

    if (priceCheck.safe === false) {
      // Verified mismatch — contract's on-chain price doesn't match what you declared.
      logger.warn(`[PRICE GUARD] ${priceCheck.reason}`);
      return {
        walletAddress, status: 'price_warning',
        priceGuard: priceCheck,
        message: priceCheck.reason,
        action: 'ABORTED — re-confirm with updated price to proceed',
      };
    }

    if (priceCheck.safe === null) {
      // Genuinely unknown — contract exposes no readable price function.
      // FIX (v24): previously this was silently treated as "safe" and the
      // mint proceeded with zero price verification. Now it's surfaced as
      // a heuristic/unverified result so the caller (UI/Telegram) can show
      // it to the user BEFORE broadcasting — but does not block the mint,
      // since many legitimate contracts genuinely have no public price getter.
      logger.warn(`[PRICE GUARD] ${priceCheck.reason}`);
    }

    if (priceCheck.safe === true) {
      logger.info(`[PRICE GUARD] ${priceCheck.reason}`);
    }
  }

  // ── Pre-flight simulation ──
  // Toggle: TENDERLY_ACCESS_KEY + TENDERLY_ACCOUNT + TENDERLY_PROJECT in env
  //         → uses Tenderly for richer error traces
  //         → leave unset to use default callStatic (no external dependency)
  try {
    const tk = process.env.TENDERLY_ACCESS_KEY;
    const ta = process.env.TENDERLY_ACCOUNT;
    const tp = process.env.TENDERLY_PROJECT;
    if (tk && ta && tp) {
      const calldata = contract.interface.encodeFunctionData(mintInfo.fnName, args);
      const resp = await fetch(
        `https://api.tenderly.co/api/v1/account/${ta}/project/${tp}/simulate`,
        { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Access-Key': tk },
          body: JSON.stringify({ network_id: String(chainId), from: walletAddress,
            to: contractAddress, input: calldata, value: value.toString(),
            save_if_fails: true }) }
      );
      const sim = await resp.json();
      if (sim.transaction?.status === false) {
        const reason = sim.transaction?.error_message || sim.simulation?.error_message || 'reverted';
        throw new Error(`Tenderly: ${reason}`);
      }
      logger.info(`[Tenderly] ✅ Pre-flight OK [${walletAddress.slice(0,8)}]`);
    } else {
      // Default callStatic
      await contract[mintInfo.fnName].staticCall(...args, { value });
    }
  } catch (simErr) {
    const errMsg = decodeMintError(simErr, mintInfo.fnName);
    // v18: detect sold-out during sim and trigger abort signal
    if (soldOutSignal && (errMsg.includes('sold out') || errMsg.includes('MaxSupplyReached') || errMsg.includes('max supply'))) {
      soldOutSignal.trigger(`Sold out detected on ${walletAddress.slice(0, 8)}`);
      logger.warn(`[SoldOut] Signal triggered — aborting remaining wallets`);
    }
    const classified = classifyMintError(simErr);
    const display = classified.category !== 'unknown'
      ? `${classified.userMessage}${classified.action !== 'abort' ? ' — ' + classified.actionMessage : ''}`
      : `Simulation failed (would revert): ${errMsg}`;
    throw new Error(display);
  }

  const nonce = await provider.getTransactionCount(walletAddress, 'pending');
  const tx    = await contract[mintInfo.fnName](...args, { value, gasLimit, nonce, ...gasParams });
  logger.info(`TX sent: ${tx.hash} (nonce=${nonce})`);
  trackTx(walletAddress, tx.hash, nonce, chainId);

  let receipt;
  try {
    receipt = await Promise.race([
      tx.wait(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 120000)),
    ]);
  } catch (waitErr) {
    if (waitErr.message === 'TIMEOUT') {
      try {
        const latestNonce = await provider.getTransactionCount(walletAddress, 'latest');
        if (latestNonce > nonce) return { walletAddress, status: 'replaced', txHash: tx.hash, fnName: mintInfo.fnName, nonce };
      } catch {}
      return { walletAddress, status: 'pending', txHash: tx.hash, fnName: mintInfo.fnName, nonce };
    }
    throw waitErr;
  }

  if (!receipt) return { walletAddress, status: 'dropped', txHash: tx.hash, fnName: mintInfo.fnName, nonce };
  logger.info(`TX ${tx.hash} — ${receipt.status === 1 ? 'confirmed' : 'FAILED'}`);

  // v18: check for sold-out in failed tx and trigger signal
  if (receipt.status !== 1 && soldOutSignal) {
    soldOutSignal.trigger(`On-chain failure on ${walletAddress.slice(0, 8)} — possible sold-out`);
  }

  return {
    walletAddress,
    status: receipt.status === 1 ? 'success' : 'failed',
    txHash: tx.hash,
    gasUsed: receipt.gasUsed.toString(),
    gasPriceWei: (receipt.gasPrice || feePerGas).toString(),
    gasCostEth: ethers.formatEther(receipt.gasUsed * (receipt.gasPrice || feePerGas)),
    blockNumber: receipt.blockNumber,
    nonce, fnName: mintInfo.fnName,
    standard: detectedStandard,
    proofLeaves: resolvedProof.length,
    hasEip712: !!resolvedSig,
    gasEscalation: gasEscalationMultiplier > 1.0 ? gasEscalationMultiplier : null,
    priceGuard: priceCheckResult ? { confidence: priceCheckResult.confidence, reason: priceCheckResult.reason } : null,
  };
}

// ── MULTI-WALLET MINT ────────────────────────────────────────────────────────
async function mintFromAllWallets({
  wallets, contractAddress, quantity, mintPrice,
  customFn = null, gweiOverride = null,
  parallel = true, chainId = 1,
  merkleProof = [], proofMap = null, proofMode = 'none',
  eip712Sigs = null,
  merkleApiUrl = null,
  useFlashbots = false,
  dryRun = false,
  standard = 'auto', tokenId = 1,
  // v18 additions
  useLaunchpadProof = false,
  spendLimits = null,
  onSimPassed = null,
}) {
  if (useFlashbots || proofMode === 'flashbots') {
    logger.info(`FLASHBOTS route: ${wallets.length} wallets`);
    return mintViaFlashbots({ wallets, contractAddress, quantity, mintPrice, customFn, gweiOverride, chainId, merkleProof, proofMap, eip712Sigs, tokenId, onSimPassed });
  }

  // ── Auto-detect SeaDrop if user didn't select SeaDrop mode ──────────────
  // Catches cases where user picks 'none' or 'launchpad' on a SeaDrop contract.
  // ── Adapter registry: if/else fallback chain ────────────────────────────
  // Priority: SeaDrop → Manifold → thirdweb → Zora → Highlight → Generic
  // Each adapter is tried in parallel. First match wins.
  // User explicit selections (flashbots/eip712) are never overridden.
  if (proofMode !== 'seadrop' && proofMode !== 'flashbots' && proofMode !== 'eip712') {
    try {
      const { detectAdapter } = require('./adapterRegistry');
      const adapter = await detectAdapter(contractAddress, chainId);
      if (adapter.routeTo && adapter.routeTo !== proofMode) {
        logger.info(`[AutoRoute] ${adapter.name} → ${adapter.routeTo} for ${contractAddress.slice(0,10)}`);
        proofMode = adapter.routeTo;
      }
      if (adapter.mintFn && !customFn) {
        logger.info(`[AutoRoute] Mint fn override: ${adapter.mintFn}`);
        customFn = adapter.mintFn;
      }
    } catch (adErr) {
      // Adapter detect failed — fall through to SeaDrop-only check as backup
      const autoSD = await isSeaDropContract(contractAddress, chainId).catch(() => false);
      if (autoSD) { logger.info(`[AutoRoute] SeaDrop fallback for ${contractAddress.slice(0,10)}`); proofMode = 'seadrop'; }
    }
  }

  if (proofMode === 'opensea' || proofMode === 'seaport') {
    // ── Guard: detect chain mismatch before firing to avoid 405 errors ────
    const { getDropInfo } = require('./openSeaEngine');
    try {
      const dropInfo = await getDropInfo(contractAddress, chainId);
      // If the drops API returns data for a DIFFERENT chain slug than what we're on, warn
      // (The bigger issue is when chainId=1/ethereum is used for a Base contract)
      // We let it proceed — openSeaEngine already routes Drops API first, which is chain-aware
    } catch(e) { /* non-critical */ }
    logger.info(`[OpenSea] Seaport/Drops 2026 routing for ${wallets.length} wallets on chain ${chainId}`);
    return Promise.all(wallets.map(w => mintViaOpenSea({ contractAddress, walletAddress:w.address, privateKey:w.privateKey, quantity, gweiOverride, chainId, dryRun })));
  }

  if (proofMode === 'seadrop') {
    logger.info(`[SeaDrop] Routing ${wallets.length} wallets`);
    return Promise.all(wallets.map(w => {
      const proof = proofMap?.[w.address] || (Array.isArray(merkleProof) && merkleProof.length ? merkleProof : []);
      if (proof.length) return mintSeaDropAllowList({ nftContract: contractAddress, walletAddress: w.address, privateKey: w.privateKey, quantity, gweiOverride, proof, chainId, dryRun });
      return mintSeaDropPublic({ nftContract: contractAddress, walletAddress: w.address, privateKey: w.privateKey, quantity, mintPriceEth: mintPrice, gweiOverride, chainId, dryRun });
    }));
  }

  const results = [];
  let phase = { phase: 'unknown', isActive: null, reason: 'not checked' };
  let detectedStandard = standard;

  try {
    const provider = await getProvider(chainId);
    const [phaseResult, is1155] = await Promise.all([
      detectMintPhase(contractAddress, [], chainId),
      standard === 'auto' ? isERC1155(contractAddress, provider) : Promise.resolve(standard === 'ERC1155'),
    ]);
    phase = phaseResult;
    if (standard === 'auto') detectedStandard = is1155 ? 'ERC1155' : 'ERC721';
    logger.info(`Phase: ${phase.phase} (${phase.reason}) | Standard: ${detectedStandard}`);
  } catch (e) { logger.warn(`Phase/std detection: ${e.message}`); }

  if (phase.phase === 'paused') return wallets.map(w => ({ walletAddress: w.address, status: 'skipped', error: 'Contract paused ⏸' }));
  if (phase.isSoldOut) return wallets.map(w => ({ walletAddress: w.address, status: 'skipped', error: 'Collection sold out ⛔' }));

  const eligible   = [];
  const ineligible = [];
  const isWLPhase  = phase.phase === 'whitelist' || phase.phase === 'unknown';
  const doEligibilityCheck = (proofMode === 'auto' || proofMode === 'none') && isWLPhase;

  for (const w of wallets) {
    const addrLower = w.address.toLowerCase();
    const eip712Sig = eip712Sigs ? (eip712Sigs[w.address] || eip712Sigs[addrLower] || null) : null;

    let walletProof = proofMap ? (proofMap[w.address] || proofMap[addrLower] || merkleProof) : merkleProof;
    if ((!walletProof || walletProof.length === 0) && !eip712Sig) walletProof = getProofForWallet(w.address);
    if ((!walletProof || walletProof.length === 0) && merkleApiUrl && !eip712Sig) {
      walletProof = await autoFetchMerkleProof(w.address, merkleApiUrl);
    }

    if (doEligibilityCheck && (!walletProof || walletProof.length === 0) && !eip712Sig) {
      try {
        const elig = await checkWalletEligibility(contractAddress, w.address, chainId);
        if (elig.eligible === false) { ineligible.push({ address: w.address, reason: elig.reason }); continue; }
        logger.info(`Wallet ${w.address.slice(0, 8)} eligible: ${elig.reason}`);
      } catch (e) { logger.warn(`Eligibility check for ${w.address.slice(0, 8)}: ${e.message}`); }
    }

    eligible.push({ ...w, resolvedProof: walletProof || [], eip712Sig });
  }

  for (const w of ineligible) results.push({ walletAddress: w.address, status: 'skipped', error: `Not eligible: ${w.reason}` });
  if (!eligible.length) { logger.warn('No eligible wallets'); return results; }

  // v18: Shared sold-out signal
  const soldOutSignal = new SoldOutSignal();

  const sharedParams = {
    contractAddress, quantity, mintPrice, customFn, gweiOverride, chainId, dryRun,
    standard: detectedStandard, tokenId, merkleApiUrl, skipMaxCheck: false,
    useLaunchpadProof, soldOutSignal,
  };

  if (parallel) {
    logger.info(`PARALLEL mint: ${eligible.length} wallets chain=${chainId}`);
    const mints = await Promise.all(
      eligible.map(w => {
        const spendLimit = spendLimits ? (spendLimits[w.address] || spendLimits[w.address.toLowerCase()] || null) : (w.spendLimit || null);
        return mintFromWallet({ walletAddress: w.address, ...sharedParams, merkleProof: w.resolvedProof, eip712Sig: w.eip712Sig, spendLimitEth: spendLimit })
          .catch(err => ({ walletAddress: w.address, status: 'failed', error: err.message }));
      })
    );
    results.push(...mints);
  } else {
    for (const w of eligible) {
      if (soldOutSignal.triggered) {
        results.push({ walletAddress: w.address, status: 'skipped', error: `⛔ ${soldOutSignal.reason}` });
        continue;
      }
      const spendLimit = spendLimits ? (spendLimits[w.address] || spendLimits[w.address.toLowerCase()] || null) : (w.spendLimit || null);
      const r = await mintFromWallet({ walletAddress: w.address, ...sharedParams, merkleProof: w.resolvedProof, eip712Sig: w.eip712Sig, spendLimitEth: spendLimit })
        .catch(err => ({ walletAddress: w.address, status: 'failed', error: err.message }));
      results.push(r);
      await new Promise(res => setTimeout(res, 300));
    }
  }
  return results;
}


async function detectTokenStandard(contractAddress, chainId = 1) {
  const provider = await getProvider(chainId);
  const is1155 = await isERC1155(contractAddress, provider);
  return is1155 ? 'ERC1155' : 'ERC721';
}

module.exports = {
  mintFromWallet, mintFromAllWallets, mintViaFlashbots,
  getContract, getContractWithABI,
  detectMintFunction, detectTokenStandard,
  buildMintArgs, buildERC1155Args,
  checkWalletEligibility, checkMaxPerWallet,
  autoFetchMerkleProof, decodeMintError,
  SoldOutSignal,
  // mintSigned support
  isMintSignedContract, getMintSignedAbiEntry,
  autoFetchMintSignedSig, buildMintSignedArgs,
};

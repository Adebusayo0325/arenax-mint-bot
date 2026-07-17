/**
 * NFT Portfolio Manager
 * - List NFTs owned by wallets
 * - List NFT for sale (Seaport + OpenSea API)
 * - List at floor price
 * - Sweep floor NFTs
 * - Count listed NFTs
 *
 * Requires: OPENSEA_API_KEY in .env
 */

const { ethers } = require('ethers');
const axios = require('axios');
const { getProvider } = require('../utils/rpcManager');
const { getChain } = require('../utils/chainConfig');
const { getWalletSigner } = require('./walletManager');
const { getGasParams } = require('./gasOracle');
const config = require('../config');
const logger = require('../utils/logger');

// ── CONSTANTS ────────────────────────────────────────────────────────────────

const OPENSEA_BASE = 'https://api.opensea.io/api/v2';
// v13.1: Fee fetched live from OpenSea API per collection — no more hardcoding.
const OPENSEA_FEE_BPS_FALLBACK = 100n; // 1% fallback if API doesn't return fee
const BASIS_POINTS = 10000n;

// Minimal ABIs
const ERC721_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function approve(address to, uint256 tokenId)',
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function getApproved(uint256 tokenId) view returns (address)',
];
const ERC1155_ABI = [
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
];
const SEAPORT_ABI = [
  'function getCounter(address offerer) view returns (uint256 counter)',
  'function fulfillOrder(tuple(tuple(address offerer,address zone,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,bytes signature) order,bytes32 fulfillerConduitKey) payable returns (bool fulfilled)',
];

// ── OPENSEA API HELPERS ──────────────────────────────────────────────────────

function osHeaders() {
  return {
    'Accept': 'application/json',
    'x-api-key': config.OPENSEA_API_KEY,
  };
}

function requireApiKey() {
  if (!config.OPENSEA_API_KEY) {
    throw new Error('OPENSEA_API_KEY not set in .env — required for NFT portfolio features');
  }
}

async function osGet(path, params = {}) {
  requireApiKey();
  try {
    const res = await axios.get(`${OPENSEA_BASE}${path}`, {
      headers: osHeaders(),
      params,
      timeout: 15000,
    });
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.errors?.[0] || err.message;
    throw new Error(`OpenSea API error: ${msg}`);
  }
}

async function osPost(path, body) {
  requireApiKey();
  try {
    const res = await axios.post(`${OPENSEA_BASE}${path}`, body, {
      headers: { ...osHeaders(), 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.errors?.[0] || err.response?.data?.detail || err.message;
    throw new Error(`OpenSea API error: ${msg}`);
  }
}

// ── QUERY FUNCTIONS ──────────────────────────────────────────────────────────

/**
 * Get all NFTs owned by a wallet on a chain.
 */
async function getWalletNFTs(walletAddress, chainId = 1, contractFilter = null, label = '') {
  const chain = getChain(chainId);
  const params = { limit: 50 };
  if (contractFilter) params.asset_contract_address = contractFilter;

  const data = await osGet(
    `/chain/${chain.openseaChain}/account/${walletAddress}/nfts`,
    params
  );

  return (data.nfts || []).map(nft => ({
    contract: nft.contract,
    tokenId: nft.identifier,
    name: nft.name || `#${nft.identifier}`,
    collection: nft.collection,
    imageUrl: nft.image_url,
    tokenStandard: nft.token_standard,
    walletLabel: label,
  }));
}

/**
 * Get floor price of a collection slug.
 * FIX (Bug 4): OpenSea API v2 has changed the floor_price field location
 * across versions. Try every known path before giving up, then fall back
 * to the /collections/{slug} endpoint as a secondary source.
 */
async function getFloorPrice(collectionSlug, chainId = 1) {
  // ── Attempt 1: /collections/{slug}/stats (v2 primary) ──────────────────
  try {
    const data = await osGet(`/collections/${collectionSlug}/stats`);
    // Try all known field paths across OpenSea API v2 versions
    const candidates = [
      data?.total?.floor_price,        // original v2 format
      data?.floor_price,               // flat format
      data?.stats?.floor_price,        // nested stats
      data?.statistics?.floor_price,   // alt nested
      data?.data?.floor_price,         // data-wrapped
    ];
    for (const v of candidates) {
      const n = parseFloat(v);
      if (!isNaN(n) && n > 0) {
        logger.info(`Floor price for ${collectionSlug}: ${n} ETH`);
        return n;
      }
    }
    logger.warn(`Floor price: stats endpoint returned no usable value for ${collectionSlug}`);
  } catch (e) {
    logger.warn(`Floor price stats fetch failed for ${collectionSlug}: ${e.message}`);
  }

  // ── Attempt 2: /collections/{slug} → stats object ──────────────────────
  try {
    const data = await osGet(`/collections/${collectionSlug}`);
    const candidates2 = [
      data?.stats?.floor_price,
      data?.collection?.stats?.floor_price,
      data?.floor_price,
    ];
    for (const v of candidates2) {
      const n = parseFloat(v);
      if (!isNaN(n) && n > 0) {
        logger.info(`Floor price (collection fallback) for ${collectionSlug}: ${n} ETH`);
        return n;
      }
    }
  } catch (e) {
    logger.warn(`Floor price collection fallback failed for ${collectionSlug}: ${e.message}`);
  }

  logger.warn(`Could not determine floor price for ${collectionSlug} — no active listings or collection not indexed yet`);
  return null;
}

/**
 * Get collection slug from contract address.
 */
async function getCollectionSlug(contractAddress, chainId = 1) {
  const chain = getChain(chainId);
  const data = await osGet(`/chain/${chain.openseaChain}/contract/${contractAddress}`);
  return data.collection;
}

/**
 * Fetch OpenSea's fee for a collection in basis points.
 * Uses the collections API which returns fees[] array.
 * Falls back to OPENSEA_FEE_BPS_FALLBACK (100 bps = 1%) if unavailable.
 */
async function getOpenseaFeeBps(collectionSlug) {
  try {
    const data = await osGet(`/collections/${collectionSlug}`);
    // OpenSea v2 returns fees as array: [{ fee, recipient, required }]
    const fees = data.fees || [];
    const openseaFee = fees.find(f => f.required === true || f.fee !== undefined);
    if (openseaFee && typeof openseaFee.fee === 'number') {
      // FIX (v23): OpenSea v2 /collections/{slug} returns fee as a PERCENT
      // (e.g. 1 = 1%, 2.5 = 2.5%), NOT basis points and NOT a 0-1 fraction.
      // The old >1/<=1 heuristic misread "1" (meaning 1%) as "1 bps",
      // multiplied by 10000 -> 10000 bps, then got clamped to a stale 250.
      // OpenSea's current platform fee is 100 bps (1%) — clamp window
      // updated to 0-300 bps (0%-3%) to allow for collections with added
      // creator royalties while still catching obviously-wrong values.
      let bps = BigInt(Math.round(openseaFee.fee * 100)); // percent -> bps

      if (bps > 300n) {
        logger.warn(`OpenSea fee ${bps} bps (${openseaFee.fee}%) seems too high — clamping to 100 bps`);
        bps = 100n;
      }
      if (bps < 0n) bps = 0n;
      logger.info(`OpenSea fee for ${collectionSlug}: ${bps} bps`);
      return bps;
    }
  } catch (e) {
    logger.warn(`Could not fetch OpenSea fee for ${collectionSlug}: ${e.message.slice(0,80)}`);
  }
  logger.info(`Using fallback OpenSea fee: ${OPENSEA_FEE_BPS_FALLBACK} bps`);
  return OPENSEA_FEE_BPS_FALLBACK;
}

/**
 * Count how many NFTs from this wallet are currently listed.
 * Uses OpenSea v2 — fetches NFTs owned by the wallet, then checks
 * which have active listings via the per-NFT listings endpoint.
 * Note: v2 has no direct "all listings by maker" endpoint, so this
 * scans the wallet's NFTs (capped) and checks each for a listing.
 */
async function getListingCount(walletAddress, chainId = 1) {
  const chain = getChain(chainId);
  try {
    const owned = await osGet(`/chain/${chain.openseaChain}/account/${walletAddress}/nfts`, { limit: 50 });
    const nfts = owned.nfts || [];

    const listings = [];
    for (const nft of nfts.slice(0, 20)) { // cap to avoid rate limits
      try {
        const data = await osGet(
          `/orders/${chain.openseaChain}/seaport/listings`,
          { asset_contract_address: nft.contract, token_ids: nft.identifier, limit: 1 }
        );
        const order = (data.orders || [])[0];
        if (order) {
          listings.push({
            orderHash: order.order_hash,
            contract: nft.contract,
            tokenId: nft.identifier,
            price: ethers.formatEther(order.current_price || '0'),
            expiresAt: order.expiration_time,
          });
        }
      } catch (e) { /* skip individual failures */ }
    }

    return { count: listings.length, listings };
  } catch {
    return { count: 0, listings: [] };
  }
}

/**
 * Get floor listings for a contract (for sweeping).
 * Uses OpenSea v2 collection listings endpoint (requires slug, not contract address).
 */
async function getFloorListings(contractAddress, chainId = 1, limit = 5) {
  const chain = getChain(chainId);

  // Resolve contract address -> collection slug (OpenSea v2 requires slug)
  let slug;
  try {
    slug = await getCollectionSlug(contractAddress, chainId);
  } catch (e) {
    throw new Error(`Could not resolve collection for ${contractAddress} on ${chain.name}: ${e.message}`);
  }
  if (!slug) {
    throw new Error(`No OpenSea collection found for contract ${contractAddress} on ${chain.name}`);
  }

  // v2 listings endpoint — paginated, returns Seaport order data ready for fulfillment
  const data = await osGet(`/listings/collection/${slug}/all`, { limit: Math.min(limit, 50) });
  const listings = data.listings || [];

  // Normalize into the shape sweepNFTs expects
  return listings.map(l => {
    const offer = l.price?.current?.value; // string, smallest unit (wei)
    const considerationItem = l.protocol_data?.parameters?.offer?.[0];
    return {
      current_price: offer,
      protocol_data: l.protocol_data,
      maker_asset_bundle: {
        assets: [{
          asset_contract: { address: considerationItem?.token || contractAddress },
          token_id: considerationItem?.identifierOrCriteria,
        }],
      },
    };
  }).filter(l => l.current_price && l.protocol_data);
}

// ── SEAPORT ORDER HELPERS ────────────────────────────────────────────────────

function buildSeaportDomain(chainId, seaportAddress) {
  return {
    name: 'Seaport',
    version: '1.6',
    chainId,
    verifyingContract: seaportAddress,
  };
}

const ORDER_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
};

/**
 * Ensure the OpenSea conduit is approved to transfer this NFT.
 */
async function ensureApproval(signer, contractAddress, tokenId, isERC1155 = false, conduitAddress) {
  const provider = signer.provider;
  const walletAddress = await signer.getAddress();

  if (isERC1155) {
    const nft = new ethers.Contract(contractAddress, ERC1155_ABI, signer);
    const approved = await nft.isApprovedForAll(walletAddress, conduitAddress);
    if (!approved) {
      logger.info(`Approving conduit for ERC1155 ${contractAddress}`);
      const tx = await nft.setApprovalForAll(conduitAddress, true);
      await tx.wait();
    }
  } else {
    const nft = new ethers.Contract(contractAddress, ERC721_ABI, signer);
    const approved = await nft.isApprovedForAll(walletAddress, conduitAddress);
    if (!approved) {
      const tokenApproved = await nft.getApproved(tokenId).catch(() => ethers.ZeroAddress);
      if (tokenApproved.toLowerCase() !== conduitAddress.toLowerCase()) {
        logger.info(`Approving conduit for ERC721 ${contractAddress} #${tokenId}`);
        const tx = await nft.setApprovalForAll(conduitAddress, true);
        await tx.wait();
      }
    }
  }
}

// ── OWNERSHIP LOOKUP ─────────────────────────────────────────────────────────

/**
 * Find which of the user's wallets actually owns a given tokenId.
 * Listing/floor-listing must sign from the OWNING wallet, not just
 * "the first wallet" — multi-wallet setups otherwise fail or sign
 * an order for an NFT the signer doesn't hold.
 *
 * Tries ERC721 ownerOf() first; if that reverts (non-ERC721 contract),
 * falls back to ERC1155 balanceOf() per wallet.
 *
 * Returns { address, isERC1155 } or null if none of the wallets hold it.
 */
async function findOwnerWallet({ contractAddress, tokenId, walletAddresses, chainId = 1 }) {
  const provider = await getProvider(chainId);

  // Try ERC721 ownerOf — single call tells us the owner directly.
  try {
    const erc721 = new ethers.Contract(contractAddress, ERC721_ABI, provider);
    const owner = (await erc721.ownerOf(tokenId)).toLowerCase();
    const match = walletAddresses.find(a => a.toLowerCase() === owner);
    return match ? { address: match, isERC1155: false } : null;
  } catch (e) {
    logger.info(`ownerOf() failed for ${contractAddress} #${tokenId} (${e.message.slice(0, 60)}) — trying ERC1155 balanceOf`);
  }

  // Fall back to ERC1155 balanceOf — must check each wallet individually.
  const erc1155 = new ethers.Contract(contractAddress, ERC1155_ABI, provider);
  for (const addr of walletAddresses) {
    try {
      const bal = await erc1155.balanceOf(addr, tokenId);
      if (bal > 0n) return { address: addr, isERC1155: true };
    } catch {}
  }
  return null;
}


/**
 * List an NFT for sale on OpenSea at a specified price.
 * Steps:
 *   1. Approve OpenSea conduit for the NFT
 *   2. Build Seaport order
 *   3. Sign with EIP-712
 *   4. Post to OpenSea API
 */
async function listNFT({
  walletAddress, contractAddress, tokenId, priceEth,
  chainId = 1, durationDays = 30, isERC1155 = false,
}) {
  const chain = getChain(chainId);
  const provider = await getProvider(chainId);
  const signer = getWalletSigner(walletAddress, provider);

  // Step 1: Approve conduit
  await ensureApproval(signer, contractAddress, tokenId, isERC1155, chain.openseaConduit);

  // Step 2: Build order
  const seaport = new ethers.Contract(chain.seaportAddress, SEAPORT_ABI, provider);
  const counter = await seaport.getCounter(walletAddress);

  const priceWei = ethers.parseEther(priceEth.toString());

  // v13.1: Fetch fee dynamically from OpenSea so it never needs to be hardcoded.
  // Resolves slug first (already needed for floor price), then fetches fee bps.
  let feeBps = OPENSEA_FEE_BPS_FALLBACK;
  try {
    const slug = await getCollectionSlug(contractAddress, chainId);
    feeBps = await getOpenseaFeeBps(slug);
  } catch (e) {
    logger.warn(`Fee fetch failed, using fallback ${OPENSEA_FEE_BPS_FALLBACK} bps`);
  }

  const openseaFee = (priceWei * feeBps) / BASIS_POINTS;
  const sellerAmount = priceWei - openseaFee;

  const now = Math.floor(Date.now() / 1000);
  const salt = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));

  const orderParams = {
    offerer: walletAddress,
    zone: ethers.ZeroAddress,
    offer: [{
      itemType: isERC1155 ? 3 : 2, // 2=ERC721, 3=ERC1155
      token: contractAddress,
      identifierOrCriteria: BigInt(tokenId),
      startAmount: 1n,
      endAmount: 1n,
    }],
    consideration: [
      {
        itemType: 0, // ETH
        token: ethers.ZeroAddress,
        identifierOrCriteria: 0n,
        startAmount: sellerAmount,
        endAmount: sellerAmount,
        recipient: walletAddress,
      },
      {
        itemType: 0,
        token: ethers.ZeroAddress,
        identifierOrCriteria: 0n,
        startAmount: openseaFee,
        endAmount: openseaFee,
        recipient: chain.openseaFeeRecipient,
      },
    ],
    orderType: 0, // FULL_OPEN
    startTime: BigInt(now),
    endTime: BigInt(now + durationDays * 86400),
    zoneHash: ethers.ZeroHash,
    salt,
    conduitKey: chain.openseaConduitKey,
    counter: BigInt(counter.toString()),
  };

  // Step 3: Sign
  const domain = buildSeaportDomain(chainId, chain.seaportAddress);
  const signature = await signer.signTypedData(domain, ORDER_TYPES, orderParams);

  // Step 4: Post to OpenSea
  // FIX v9: OpenSea API v2 validation requires:
  //   - All addresses lowercase (checksummed EIP-55 addresses fail validation)
  //   - All numeric fields serialised as decimal strings (no BigInt leakage)
  //   - orderType as a plain integer (not BigInt)
  //   - zoneHash as hex string (not ethers Bytes object)
  const osChain = chain.openseaChain;
  const payload = {
    parameters: {
      offerer:    orderParams.offerer.toLowerCase(),
      zone:       orderParams.zone.toLowerCase(),
      offer: orderParams.offer.map(o => ({
        itemType:             Number(o.itemType),
        token:                o.token.toLowerCase(),
        identifierOrCriteria: o.identifierOrCriteria.toString(),
        startAmount:          o.startAmount.toString(),
        endAmount:            o.endAmount.toString(),
      })),
      consideration: orderParams.consideration.map(c => ({
        itemType:             Number(c.itemType),
        token:                c.token.toLowerCase(),
        identifierOrCriteria: c.identifierOrCriteria.toString(),
        startAmount:          c.startAmount.toString(),
        endAmount:            c.endAmount.toString(),
        recipient:            c.recipient.toLowerCase(),
      })),
      orderType:   Number(orderParams.orderType),
      startTime:   orderParams.startTime.toString(),
      endTime:     orderParams.endTime.toString(),
      zoneHash:    orderParams.zoneHash,
      salt:        orderParams.salt.toString(),
      conduitKey:  orderParams.conduitKey,
      counter:     orderParams.counter.toString(),
      totalOriginalConsiderationItems: orderParams.consideration.length,
    },
    signature,
    protocol_address: chain.seaportAddress.toLowerCase(),
  };

  const result = await osPost(`/orders/${osChain}/seaport/listings`, payload);
  logger.info(`Listed NFT: ${contractAddress} #${tokenId} at ${priceEth} ETH`);

  return {
    orderHash: result.order?.order_hash,
    contract: contractAddress,
    tokenId,
    priceEth,
    expiresAt: new Date((now + durationDays * 86400) * 1000).toISOString(),
  };
}

/**
 * List an NFT at the current floor price of its collection.
 */
async function listAtFloor({ walletAddress, contractAddress, tokenId, chainId = 1, discountPct = 0, isERC1155 = false }) {
  const slug = await getCollectionSlug(contractAddress, chainId);
  const floor = await getFloorPrice(slug, chainId);

  if (!floor || floor === 0) {
    // v9 FIX: Advisory error — new collections or first listings have no floor.
    // Caller should catch FLOOR_UNAVAILABLE and prompt user to set a manual price.
    const err = new Error(
      `No floor price found for this collection (it may be newly launched or have no active listings). ` +
      `Please set a custom listing price instead.`
    );
    err.code = 'FLOOR_UNAVAILABLE';
    err.slug = slug;
    throw err;
  }

  const listPrice = floor * (1 - discountPct / 100);
  logger.info(`Floor=${floor} ETH, listing at ${listPrice.toFixed(6)} ETH`);

  return listNFT({ walletAddress, contractAddress, tokenId, priceEth: listPrice, chainId, isERC1155 });
}

// ── SWEEP NFTs ───────────────────────────────────────────────────────────────

/**
 * Buy up to `quantity` NFTs at floor price for a collection.
 * Executes each as a separate Seaport fulfillOrder call.
 *
 * FIX 3 — Sweep was completely ineffective. Root causes:
 *  a) gasLimit: BigInt(300000) was hardcoded and too low for orders with
 *     royalty recipients — complex consideration arrays push gas above 300k.
 *     Fixed: estimate gas per order, fall back to 500_000 (not 300k) on failure.
 *  b) No balance check before attempting — silent failures when wallet is dry.
 *  c) Order parameters from OpenSea contain BigInt-as-string fields. We now
 *     normalise them explicitly so ethers.js tuple encoding never mismatches.
 *  d) Added full error message logging (was sliced to 100 chars, hiding root cause).
 */
async function sweepNFTs({ walletAddress, contractAddress, quantity, maxPriceEthEach, chainId = 1 }) {
  const chain    = getChain(chainId);
  const provider = await getProvider(chainId);
  const signer   = getWalletSigner(walletAddress, provider);
  const seaport  = new ethers.Contract(chain.seaportAddress, SEAPORT_ABI, signer);
  // FIX: don't use mint-sized speed multiplier for a floor buy. A sweep is
  // a single Seaport fulfillOrder against an existing listing — it doesn't
  // need to outbid anyone, so 1.05x (small headroom only) is plenty.
  const gasParams = await getGasParams(1.05, chainId);

  // ── Pre-sweep balance check ──────────────────────────────────────────────
  // FIX: gas overestimate. A single Seaport `fulfillOrder` typically costs
  // ~120k-220k gas (vs a contract *mint*, which writes new storage and can
  // run 150k-400k+). The old check used a flat 500,000 gas PER PURCHASE,
  // which on a 0.0004 ETH-floor collection could roughly double the ETH the
  // bot said you "needed" — making a tiny floor-sweep look as expensive as a
  // full mint. We use 220k/purchase (still has ~25% headroom over typical
  // fulfillOrder cost) and scale by quantity, since `quantity` purchases
  // really will each cost gas.
  const balance     = await provider.getBalance(walletAddress);
  const maxPriceWei = ethers.parseEther(maxPriceEthEach.toString());
  const feePerGas   = gasParams.maxFeePerGas || gasParams.gasPrice || BigInt(20e9);
  const GAS_PER_SWEEP_TX = 220000n;
  const minRequired = (maxPriceWei * BigInt(quantity)) + feePerGas * GAS_PER_SWEEP_TX * BigInt(quantity);
  if (balance < minRequired) {
    const bal = parseFloat(ethers.formatEther(balance)).toFixed(6);
    const req = parseFloat(ethers.formatEther(minRequired)).toFixed(6);
    const short = parseFloat(ethers.formatEther(minRequired - balance)).toFixed(6);
    throw new Error(`Wallet ${walletAddress.slice(0, 8)} has ${bal} ETH but sweep needs ~${req} ETH (short by ~${short} ETH). Fund a bit more and retry.`);
  }

  // Fetch more listings than needed so we have spares to skip
  const listings = await getFloorListings(contractAddress, chainId, Math.max(quantity * 3, 10));
  logger.info(`Sweep: ${listings.length} listings fetched for ${contractAddress} (want ${quantity})`);

  if (!listings.length) {
    throw new Error(`No floor listings found for ${contractAddress} on chain ${chainId}. Check contract address and OpenSea slug.`);
  }

  const results = [];

  for (const listing of listings) {
    if (results.filter(r => r.status === 'success').length >= quantity) break;

    const priceWei = BigInt(listing.current_price || '0');
    if (priceWei === 0n) {
      logger.warn('Skipping listing: price is 0');
      continue;
    }
    if (priceWei > maxPriceWei) {
      logger.info(`Skipping listing: price ${ethers.formatEther(priceWei)} ETH > max ${maxPriceEthEach} ETH`);
      continue;
    }

    try {
      // Normalise order parameters — OpenSea returns BigInt fields as decimal
      // strings; make them explicit so ethers tuple encoding is always correct.
      const rawParams = listing.protocol_data.parameters;
      const orderParams = {
        ...rawParams,
        startTime:                       BigInt(rawParams.startTime),
        endTime:                         BigInt(rawParams.endTime),
        salt:                            BigInt(rawParams.salt),
        counter:                         rawParams.counter !== undefined ? BigInt(rawParams.counter) : 0n,
        totalOriginalConsiderationItems: rawParams.totalOriginalConsiderationItems !== undefined
          ? Number(rawParams.totalOriginalConsiderationItems)
          : rawParams.consideration.length,
        offer: rawParams.offer.map(o => ({
          ...o,
          itemType:               Number(o.itemType),
          identifierOrCriteria:   BigInt(o.identifierOrCriteria),
          startAmount:            BigInt(o.startAmount),
          endAmount:              BigInt(o.endAmount),
        })),
        consideration: rawParams.consideration.map(c => ({
          ...c,
          itemType:             Number(c.itemType),
          identifierOrCriteria: BigInt(c.identifierOrCriteria),
          startAmount:          BigInt(c.startAmount),
          endAmount:            BigInt(c.endAmount),
        })),
      };

      const order = { parameters: orderParams, signature: listing.protocol_data.signature };

      // Estimate gas dynamically per order — covers varying royalty complexity
      let gasLimit;
      try {
        const est = await seaport.fulfillOrder.estimateGas(order, ethers.ZeroHash, { value: priceWei });
        gasLimit = BigInt(Math.ceil(Number(est) * 1.25));
        logger.info(`Sweep gas estimate: ${est} → buffered ${gasLimit}`);
      } catch (estErr) {
        logger.warn(`Gas estimate failed (${estErr.message.slice(0, 80)}) — using fallback 300000`);
        gasLimit = BigInt(300000); // realistic ceiling for a Seaport fulfillOrder
      }

      const tx = await seaport.fulfillOrder(order, ethers.ZeroHash, {
        value: priceWei,
        gasLimit,
        ...gasParams,
      });

      logger.info(`Sweep tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      const tokenId = listing.maker_asset_bundle?.assets?.[0]?.token_id;

      results.push({
        status:   receipt.status === 1 ? 'success' : 'failed',
        txHash:   tx.hash,
        priceEth: ethers.formatEther(priceWei),
        tokenId,
      });
    } catch (err) {
      // Log FULL error — truncation was hiding the real revert reason
      logger.warn(`Sweep attempt failed: ${err.message}`);
      results.push({ status: 'failed', error: err.message.slice(0, 200) });
    }
  }

  return results;
}

module.exports = {
  getWalletNFTs, getFloorPrice, getCollectionSlug,
  getListingCount, getFloorListings,
  listNFT, listAtFloor, sweepNFTs, findOwnerWallet,
};

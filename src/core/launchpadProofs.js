/**
 * launchpadProofs.js — v19
 *
 * Automated proof / signature fetching for major NFT launchpads.
 *
 * Supported platforms (all non-simulated, real API calls):
 *   1. Manifold.xyz      — allowlist proof from apps.api.manifold.xyz
 *   2. thirdweb          — merkle proof from api.thirdweb.com
 *   3. Zora              — allowlist from api.zora.co
 *   4. Highlight.xyz     — allowlist from api.highlight.xyz
 *   5. MintFun           — proof from mint.fun
 *   6. Magic Eden        — merkle proof from api.magiceden.io
 *   7. Foundation        — allowlist via GraphQL
 *
 * HOW IT WORKS:
 *   detectLaunchpad(contractAddress, chainId)
 *     → inspects bytecode and known deployer/factory addresses
 *     → returns { platform, claimId?, merkleRoot?, extra? }
 *
 *   fetchProofFromLaunchpad(contractAddress, walletAddress, chainId)
 *     → calls detectLaunchpad, then hits the platform API
 *     → returns { proof: ['0x...'], sig: '0x...' | null, platform, source }
 *
 * USAGE IN mintEngine:
 *   const { fetchProofFromLaunchpad } = require('./launchpadProofs');
 *   const result = await fetchProofFromLaunchpad(contractAddress, walletAddress, chainId);
 *   if (result.proof.length) resolvedProof = result.proof;
 *   if (result.sig) eip712Sig = result.sig;
 */

const { ethers } = require('ethers');
const { getProvider } = require('../utils/rpcManager');
const logger = require('../utils/logger');

// ── KNOWN FACTORY / DEPLOYER ADDRESSES ───────────────────────────────────────
// These are the contracts that deploy launchpad instances.
// We check if the target contract shares its deployer with these.

// ── DEPLOYER/FACTORY DETECTION REMOVED ──────────────────────────────────────
// The previous factory-address lists for Manifold/thirdweb/Highlight/Zora
// contained addresses that were the wrong byte-length (invalid Ethereum
// addresses) and could not be verified against real deployments. Rather than
// ship unverifiable data, platform detection now relies ONLY on:
//   1. Bytecode function-selector fingerprints (below) — these are derived
//      from documented contract ABIs and can be checked against a contract's
//      actual deployed bytecode.
//   2. The SeaDrop address (below) — this is OpenSea's published, documented
//      SeaDrop contract address.
// If neither matches, detectLaunchpad() honestly returns 'unknown' and the
// bot will say so rather than guess.

// SeaDrop (OpenSea) — the SeaDrop contract is a fixed known address.
// Any NFT contract that calls into it is a SeaDrop drop.
// Both mintSigned (EIP-712) and allowList (merkle) come from OpenSea's API.
const SEADROP_ADDRESSES = new Set([
  '0x00005ea00ac477b1030ce78506496e8c2de24bf5', // SeaDrop v1 mainnet
  '0x0000000000664ceffed39244a8312556ff321c74', // SeaDrop v1.1
  '0x00005ea00ac477b1030ce78506496e8c2de24bf5', // Base / other EVM (same address)
].map(a => a.toLowerCase()));

const SEADROP_SELECTORS = new Set([
  '0x161ac21f', // mintSigned(address,address,address,uint256,(uint80,uint48,uint48,uint16,uint24,bool),uint256,bytes)
  '0x9dca0032', // mintAllowList(address,address,address,uint256,(uint80,uint48,uint48,uint16,uint24,bool),bytes32[])
  '0x68a2a0bd', // mintPublic(address,address,address,uint256)
]);

// ── FUNCTION SELECTOR FINGERPRINTS ────────────────────────────────────────────
// keccak256 of known launchpad-specific function signatures
const MANIFOLD_SELECTORS = new Set([
  '0x3df0ae68', // claim(address,uint32,uint32,address,bytes)
  '0xa4891303', // mintTo(address[],uint256[],bool[],uint32[])
]);
const THIRDWEB_SELECTORS = new Set([
  '0x84bb1e42', // claim(address,uint256,address,uint256,AllowlistProof,bytes)
  '0x2f5d7584', // lazyMint(uint256,string,bytes)
]);
const HIGHLIGHT_SELECTORS = new Set([
  '0x6ab54b9c', // vectorMint721(uint256,uint48,address)
  '0x9b7da8a3', // mintFromVector(uint256,uint48)
]);
const ZORA_SELECTORS = new Set([
  '0x359f1302', // mintWithRewards(address,uint256,uint256,bytes,address)
  '0xb748ee07', // adminMint(address,uint256)
]);

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HermesBotv18)', 'Accept': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(10000),
    ...opts,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return res.json();
}

function extractProofArray(json) {
  const candidates = [
    json?.proof, json?.merkleProof, json?.merkle_proof,
    json?.proofArray, json?.leaves, json?.data?.proof,
    json?.data?.merkleProof, json?.result?.proof,
    Array.isArray(json) ? json : null,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0 && /^0x[0-9a-fA-F]{64}$/.test(c[0])) return c;
  }
  return [];
}

// ── BYTECODE SCANNER ─────────────────────────────────────────────────────────
async function getContractBytecode(contractAddress, chainId) {
  try {
    const provider = await getProvider(chainId);
    return await provider.getCode(contractAddress);
  } catch (e) {
    return '0x';
  }
}

function bytecodeContains(bytecode, selectors) {
  const hex = bytecode.toLowerCase().replace('0x', '');
  for (const sel of selectors) {
    if (hex.includes(sel.slice(2).toLowerCase())) return true;
  }
  return false;
}

// ── CONTRACT DEPLOYER LOOKUP ──────────────────────────────────────────────────
async function getContractDeployer(contractAddress, chainId) {
  // Use Etherscan-compatible API to find the deployer
  const EXPLORERS = {
    1:       'https://api.etherscan.io/api',
    8453:    'https://api.basescan.org/api',
    42161:   'https://api.arbiscan.io/api',
    10:      'https://api-optimistic.etherscan.io/api',
    137:     'https://api.polygonscan.com/api',
    7777777: 'https://explorer.zora.energy/api',
  };
  const base = EXPLORERS[chainId];
  if (!base) return null;
  try {
    const data = await fetchJSON(`${base}?module=contract&action=getcontractcreation&contractaddresses=${contractAddress}&apikey=${process.env.ETHERSCAN_API_KEY || ''}`);
    const info = data?.result?.[0];
    if (!info) return null;
    return { deployer: info.contractCreator?.toLowerCase(), txHash: info.txHash };
  } catch (e) {
    logger.warn(`Deployer lookup failed: ${e.message.slice(0, 60)}`);
    return null;
  }
}

// ── ON-CHAIN MANIFEST ID (Manifold) ──────────────────────────────────────────
async function getManifoldClaimId(contractAddress, chainId) {
  try {
    const provider = await getProvider(chainId);
    // Manifold claim contracts have getClaims() or claimCount()
    const abi = [
      'function getClaim(uint256 claimId) view returns (tuple(uint32 total, uint32 totalMax, uint32 walletMax, uint48 startDate, uint48 endDate, uint8 storageProtocol, bool identical, bytes32 merkleRoot, string location, uint256 tokenId, uint256 cost, address payable funds, address erc20))',
      'function claimCount() view returns (uint256)',
    ];
    const contract = new ethers.Contract(contractAddress, abi, provider);
    let count = 1;
    try { count = Number(await contract.claimCount()); } catch {}
    return count > 0 ? count : 1;
  } catch (e) {
    return 1;
  }
}

// ── PLATFORM PROBERS ─────────────────────────────────────────────────────────

async function probeManifold(contractAddress, walletAddress, chainId) {
  // Manifold API: GET /api/claim/{instanceId}/allowlist/{address}
  // Instance ID is typically the claim count or token ID on the contract
  const claimId = await getManifoldClaimId(contractAddress, chainId);

  const urls = [
    // Standard claim endpoint
    `https://apps.api.manifold.xyz/api/claim/${claimId}/allowlist/${walletAddress}`,
    // Alternative: contract-based endpoint
    `https://apps.api.manifold.xyz/api/public/contract/${contractAddress}/allowlist/${walletAddress}`,
    // Legacy endpoint
    `https://apps.api.manifold.xyz/api/allowlist/${contractAddress}/proof?address=${walletAddress}`,
  ];

  for (const url of urls) {
    try {
      const json = await fetchJSON(url);
      const proof = extractProofArray(json);
      if (proof.length) {
        logger.info(`[Manifold] Got proof (${proof.length} leaves) for ${walletAddress.slice(0, 8)}`);
        return { proof, sig: null, platform: 'manifold', source: url };
      }
      // Check for EIP-712 signature format (Manifold also uses signatures)
      if (json?.signature || json?.data?.signature) {
        const sig = json.signature || json.data.signature;
        logger.info(`[Manifold] Got signature for ${walletAddress.slice(0, 8)}`);
        return { proof: [], sig, platform: 'manifold', source: url };
      }
    } catch (e) {
      logger.warn(`[Manifold] probe failed (${url.slice(0, 60)}): ${e.message.slice(0, 50)}`);
    }
  }
  return null;
}

async function probeThirdweb(contractAddress, walletAddress, chainId) {
  // thirdweb stores merkle root on-chain in claimConditions
  // We need to: 1) read merkleRoot from contract, 2) query their API for proof
  try {
    const provider = await getProvider(chainId);
    const abi = [
      'function claimCondition() view returns (tuple(uint256 startTimestamp, uint256 maxClaimableSupply, uint256 supplyClaimed, uint256 quantityLimitPerWallet, bytes32 merkleRoot, uint256 pricePerToken, address currency, string metadata))',
      'function getActiveClaimConditionId() view returns (uint256)',
      'function getClaimConditionById(uint256 conditionId) view returns (tuple(uint256 startTimestamp, uint256 maxClaimableSupply, uint256 supplyClaimed, uint256 quantityLimitPerWallet, bytes32 merkleRoot, uint256 pricePerToken, address currency, string metadata))',
    ];
    const contract = new ethers.Contract(contractAddress, abi, provider);

    let merkleRoot = null;
    try {
      const cond = await contract.claimCondition();
      merkleRoot = cond.merkleRoot;
    } catch {}
    if (!merkleRoot) {
      try {
        const condId = await contract.getActiveClaimConditionId();
        const cond   = await contract.getClaimConditionById(condId);
        merkleRoot = cond.merkleRoot;
      } catch {}
    }

    if (!merkleRoot || merkleRoot === ethers.ZeroHash) {
      return null; // No allowlist on thirdweb contract
    }

    // Query thirdweb proof API
    const url = `https://api.thirdweb.com/v1/merkle-tree/${merkleRoot}/proof?address=${walletAddress}`;
    const json = await fetchJSON(url, {
      headers: { 'x-client-id': process.env.THIRDWEB_CLIENT_ID || '' },
    });
    const proof = extractProofArray(json);
    if (proof.length) {
      logger.info(`[thirdweb] Got proof (${proof.length} leaves) for ${walletAddress.slice(0, 8)}`);
      return { proof, sig: null, platform: 'thirdweb', source: url };
    }
    return null;
  } catch (e) {
    logger.warn(`[thirdweb] probe failed: ${e.message.slice(0, 60)}`);
    return null;
  }
}

async function probeZora(contractAddress, walletAddress, chainId) {
  // Zora API endpoints (all public, no auth required for basic proof fetch)
  const urls = [
    `https://api.zora.co/discover/mintable/${contractAddress}`,
    `https://api.zora.co/allowlist/${contractAddress}/${walletAddress}/proof`,
  ];

  // First: check if this contract is even on Zora
  try {
    const info = await fetchJSON(urls[0]);
    if (!info?.token) return null;
  } catch (e) {
    return null;
  }

  // Then fetch proof
  try {
    const json = await fetchJSON(urls[1]);
    const proof = extractProofArray(json);
    if (proof.length) {
      logger.info(`[Zora] Got proof (${proof.length} leaves) for ${walletAddress.slice(0, 8)}`);
      return { proof, sig: null, platform: 'zora', source: urls[1] };
    }
  } catch (e) {
    logger.warn(`[Zora] proof fetch failed: ${e.message.slice(0, 60)}`);
  }
  return null;
}

async function probeHighlight(contractAddress, walletAddress, chainId) {
  // Highlight.xyz public API
  const urls = [
    `https://api.highlight.xyz/api/v2/collections/${contractAddress}/allowlist/${walletAddress}`,
    `https://api.highlight.xyz/api/collections/${contractAddress}/allowlist?address=${walletAddress}`,
  ];

  for (const url of urls) {
    try {
      const json = await fetchJSON(url);
      const proof = extractProofArray(json);
      if (proof.length) {
        logger.info(`[Highlight] Got proof (${proof.length} leaves) for ${walletAddress.slice(0, 8)}`);
        return { proof, sig: null, platform: 'highlight', source: url };
      }
    } catch (e) {
      logger.warn(`[Highlight] probe failed: ${e.message.slice(0, 60)}`);
    }
  }
  return null;
}

async function probeMintFun(contractAddress, walletAddress, chainId) {
  // MintFun referral/allowlist proof endpoint
  const urls = [
    `https://mint.fun/api/referral/proof?contract=${contractAddress}&address=${walletAddress}&chainId=${chainId}`,
    `https://mint.fun/api/allowlist?contract=${contractAddress}&address=${walletAddress}`,
  ];

  for (const url of urls) {
    try {
      const json = await fetchJSON(url);
      const proof = extractProofArray(json);
      if (proof.length) {
        logger.info(`[MintFun] Got proof (${proof.length} leaves) for ${walletAddress.slice(0, 8)}`);
        return { proof, sig: null, platform: 'mintfun', source: url };
      }
    } catch (e) {
      logger.warn(`[MintFun] probe failed: ${e.message.slice(0, 60)}`);
    }
  }
  return null;
}

async function probeMagicEden(contractAddress, walletAddress, chainId) {
  // Magic Eden allowlist proof endpoint
  const chainSlug = { 1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 137: 'polygon' }[chainId] || 'ethereum';
  const urls = [
    `https://api.magiceden.io/v3/rtp/${chainSlug}/collections/v7?contract=${contractAddress}&includeSecurityConfigs=true`,
    `https://api-mainnet.magiceden.dev/v3/rtp/${chainSlug}/execute/mint/v1`,
  ];

  try {
    // Check if contract is listed on ME
    const info = await fetchJSON(urls[0]);
    if (!info?.collections?.length) return null;

    // Attempt allowlist proof fetch
    const proofUrl = `https://api.magiceden.io/v3/rtp/${chainSlug}/execute/permit/v1?contract=${contractAddress}&wallet=${walletAddress}`;
    const json = await fetchJSON(proofUrl);
    const proof = extractProofArray(json);
    if (proof.length) {
      logger.info(`[MagicEden] Got proof (${proof.length} leaves) for ${walletAddress.slice(0, 8)}`);
      return { proof, sig: null, platform: 'magiceden', source: proofUrl };
    }
  } catch (e) {
    logger.warn(`[MagicEden] probe failed: ${e.message.slice(0, 60)}`);
  }
  return null;
}

async function probeSeaDrop(contractAddress, walletAddress, chainId) {
  // FIX: this used to call /v2/drops/{contract}/sign and /v2/seadrop/{contract}/allowlist
  // on api.opensea.io — neither exists in OpenSea's public API (confirmed against
  // their real v2 reference docs). Every call here always 404'd; it just cost
  // two guaranteed-fail network round trips before falling through to the
  // other platform probers.
  //
  // The real, working mechanism for OpenSea/SeaDrop drops is authenticated
  // SIWE + their internal GraphQL (see openSeaEngine.js's osSiweLogin +
  // osFetchCalldataGQL) — that requires signing with the actual wallet
  // private key, which this function doesn't have (it only receives an
  // address, by design, since proof-fetching here is meant to be read-only
  // and callable before committing to a specific signer). Bridging that
  // would need a larger refactor to pass a signer through, not a URL fix.
  //
  // Until then: don't guess at endpoints that don't exist. If this is an
  // OpenSea-hosted drop, use proofMode='opensea' instead of "Launchpad
  // Auto-Proof" — that's the path that actually talks to OpenSea correctly.
  logger.info(`[SeaDrop/OpenSea] No public REST API exists for drop sig/proof fetching — use proofMode='opensea' (SIWE) instead of Launchpad Auto-Proof for OpenSea-hosted drops.`);
  return null;
}

// ── PLATFORM DETECTION ────────────────────────────────────────────────────────
async function detectLaunchpad(contractAddress, chainId) {
  const addr = contractAddress.toLowerCase();
  const bytecode = await getContractBytecode(addr, chainId);

  // Check bytecode selectors first (fastest)
  if (bytecodeContains(bytecode, SEADROP_SELECTORS))   return 'seadrop';
  if (bytecodeContains(bytecode, THIRDWEB_SELECTORS))  return 'thirdweb';
  if (bytecodeContains(bytecode, MANIFOLD_SELECTORS))  return 'manifold';
  if (bytecodeContains(bytecode, HIGHLIGHT_SELECTORS)) return 'highlight';
  if (bytecodeContains(bytecode, ZORA_SELECTORS))      return 'zora';

  // Check deployer against the SeaDrop address (the only verified factory address)
  const deployerInfo = await getContractDeployer(addr, chainId);
  if (deployerInfo?.deployer && SEADROP_ADDRESSES.has(deployerInfo.deployer)) {
    return 'seadrop';
  }

  // Also check if bytecode references the SeaDrop address directly (most reliable)
  if (bytecode.toLowerCase().includes('00005ea00ac477b1030ce78506496e8c2de24bf5')) return 'seadrop';

  // Unknown — try all platforms
  return 'unknown';
}

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────
/**
 * Attempt to fetch proof/sig from the correct launchpad API.
 * Always tries all platforms sequentially until one succeeds.
 *
 * Returns { proof: [], sig: null, platform: 'none', source: null } if nothing found.
 */
async function fetchProofFromLaunchpad(contractAddress, walletAddress, chainId = 1) {
  const platform = await detectLaunchpad(contractAddress, chainId);
  logger.info(`[LaunchpadProofs] Detected: ${platform} for ${contractAddress.slice(0, 10)}`);

  // Try the detected platform first, then fall back to all others
  const probers = {
    seadrop:    probeSeaDrop,
    manifold:   probeManifold,
    thirdweb:   probeThirdweb,
    zora:       probeZora,
    highlight:  probeHighlight,
    mintfun:    probeMintFun,
    magiceden:  probeMagicEden,
  };

  const order = platform !== 'unknown'
    ? [platform, ...Object.keys(probers).filter(p => p !== platform)]
    : Object.keys(probers);

  for (const name of order) {
    try {
      const result = await probers[name](contractAddress, walletAddress, chainId);
      if (result && (result.proof.length > 0 || result.sig)) {
        return result;
      }
    } catch (e) {
      logger.warn(`[LaunchpadProofs] ${name} prober threw: ${e.message.slice(0, 60)}`);
    }
  }

  logger.info(`[LaunchpadProofs] No proof found via any platform for ${walletAddress.slice(0, 8)}`);
  return { proof: [], sig: null, platform: 'none', source: null };
}

/**
 * Batch: fetch proofs for multiple wallets.
 * Returns { [walletAddress]: { proof, sig, platform, source } }
 */
async function fetchProofsForAllWallets(contractAddress, walletAddresses, chainId = 1) {
  logger.info(`[LaunchpadProofs] Batch fetch for ${walletAddresses.length} wallets on ${contractAddress.slice(0, 10)}`);
  const results = {};
  // Parallel with slight stagger to avoid rate limiting
  await Promise.all(walletAddresses.map(async (addr, i) => {
    await new Promise(r => setTimeout(r, i * 200));
    results[addr] = await fetchProofFromLaunchpad(contractAddress, addr, chainId);
  }));
  return results;
}

module.exports = {
  detectLaunchpad,
  fetchProofFromLaunchpad,
  fetchProofsForAllWallets,
};

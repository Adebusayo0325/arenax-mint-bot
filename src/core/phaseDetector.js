/**
 * phaseDetector.js — v16
 * Auto-detects mint phase (public/whitelist/paused/not-started) and
 * per-wallet eligibility WITHOUT requiring a manual Merkle proof paste.
 *
 * Strategy:
 * 1. Try to read common phase flags from the contract (paused, saleActive, etc.)
 * 2. Try to read per-wallet minted count / allowlist mapping
 * 3. Try a static-call dry-run with empty proof → if it doesn't revert on
 *    "proof" related error, wallet is in a public phase
 * 4. Return a structured result so bot can auto-route to correct mint path
 */

const { ethers } = require('ethers');
const { getProvider } = require('../utils/rpcManager');
const logger = require('../utils/logger');

// ── Phase detection ABI fragments ─────────────────────────────────────────────
const PHASE_ABI = [
  // Pause / sale flags
  'function paused() view returns (bool)',
  'function saleIsActive() view returns (bool)',
  'function publicSaleActive() view returns (bool)',
  'function presaleActive() view returns (bool)',
  'function whitelistMintEnabled() view returns (bool)',
  'function allowlistMintEnabled() view returns (bool)',
  'function mintEnabled() view returns (bool)',
  'function isLive() view returns (bool)',
  'function isMintOpen() view returns (bool)',
  'function mintOpen() view returns (bool)',
  'function revealed() view returns (bool)',
  'function phase() view returns (uint256)',
  'function currentPhase() view returns (uint8)',
  'function salePhase() view returns (uint8)',
  'function mintPhase() view returns (uint256)',

  // Supply
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function maxTotalSupply() view returns (uint256)',

  // Price
  'function mintPrice() view returns (uint256)',
  'function price() view returns (uint256)',
  'function cost() view returns (uint256)',
  'function publicPrice() view returns (uint256)',
  'function presalePrice() view returns (uint256)',

  // Per-wallet limits
  'function maxMintPerWallet() view returns (uint256)',
  'function maxPerWallet() view returns (uint256)',
  'function walletLimit() view returns (uint256)',
  'function maxMintAmountPerTx() view returns (uint256)',
  'function maxPerAddress() view returns (uint256)',
  'function numberMinted(address) view returns (uint256)',
  'function mintedCount(address) view returns (uint256)',
  'function hasMinted(address) view returns (bool)',
  '_numberMinted(address) view returns (uint256)',

  // Allowlist mappings
  'function isWhitelisted(address) view returns (bool)',
  'function isAllowlisted(address) view returns (bool)',
  'function whitelist(address) view returns (bool)',
  'function allowlist(address) view returns (bool)',
  'function allowlistClaimed(address) view returns (bool)',

  // Merkle root (to detect if WL mint requires proof)
  'function merkleRoot() view returns (bytes32)',
  'function whitelistMerkleRoot() view returns (bytes32)',
  'function allowlistMerkleRoot() view returns (bytes32)',
];

// ── Phase integer → label mapping ─────────────────────────────────────────────
function phaseLabel(n) {
  const map = {
    0: 'PAUSED/CLOSED',
    1: 'WHITELIST',
    2: 'PUBLIC',
    3: 'PUBLIC',
    4: 'ENDED',
  };
  return map[Number(n)] || `PHASE_${n}`;
}

// ── Safe call helper ──────────────────────────────────────────────────────────
async function tryCall(contract, fn, args = []) {
  try { return await contract[fn](...args); } catch { return null; }
}

// ── Main phase detection ──────────────────────────────────────────────────────
async function detectMintPhase(contractAddress, walletAddresses = [], chainId = 1) {
  const provider = await getProvider(chainId);
  const contract = new ethers.Contract(contractAddress, PHASE_ABI, provider);

  const result = {
    phase: 'UNKNOWN',      // PAUSED | WHITELIST | PUBLIC | ENDED | UNKNOWN
    isPublic: false,
    isWhitelist: false,
    isPaused: false,
    isSoldOut: false,
    mintPrice: null,       // in ETH string
    maxPerWallet: null,
    totalSupply: null,
    maxSupply: null,
    hasMerkleRoot: false,
    wallets: {},           // walletAddress → { eligible, alreadyMinted, mintedCount }
    raw: {},
  };

  // ── 1. Pause check ──────────────────────────────────────────────────────────
  const paused = await tryCall(contract, 'paused');
  if (paused === true) {
    result.phase = 'PAUSED';
    result.isPaused = true;
  }

  // ── 2. Sale active flags ─────────────────────────────────────────────────
  const saleIsActive     = await tryCall(contract, 'saleIsActive');
  const publicSaleActive = await tryCall(contract, 'publicSaleActive');
  const mintEnabled      = await tryCall(contract, 'mintEnabled');
  const isLive           = await tryCall(contract, 'isLive');
  const isMintOpen       = await tryCall(contract, 'isMintOpen');
  const mintOpen         = await tryCall(contract, 'mintOpen');
  const presaleActive    = await tryCall(contract, 'presaleActive');
  const wlEnabled        = await tryCall(contract, 'whitelistMintEnabled');
  const alEnabled        = await tryCall(contract, 'allowlistMintEnabled');

  result.raw = { paused, saleIsActive, publicSaleActive, mintEnabled, isLive, isMintOpen, mintOpen, presaleActive, wlEnabled, alEnabled };

  // ── 3. Phase enum ──────────────────────────────────────────────────────────
  const phaseVal    = await tryCall(contract, 'phase');
  const currentPhase = await tryCall(contract, 'currentPhase');
  const salePhase   = await tryCall(contract, 'salePhase');
  const mintPhase   = await tryCall(contract, 'mintPhase');

  const phaseNum = phaseVal ?? currentPhase ?? salePhase ?? mintPhase ?? null;
  if (phaseNum !== null) {
    result.raw.phaseNum = phaseNum.toString();
    const label = phaseLabel(phaseNum);
    if (result.phase === 'UNKNOWN') result.phase = label;
  }

  // ── 4. Determine public vs whitelist ──────────────────────────────────────
  const anyPublicFlag = saleIsActive === true || publicSaleActive === true ||
                        mintEnabled === true || isLive === true ||
                        isMintOpen === true || mintOpen === true;
  const anyWLFlag = presaleActive === true || wlEnabled === true || alEnabled === true;

  if (anyPublicFlag && !anyWLFlag) {
    result.phase = 'PUBLIC';
    result.isPublic = true;
  } else if (anyWLFlag && !anyPublicFlag) {
    result.phase = 'WHITELIST';
    result.isWhitelist = true;
  } else if (anyPublicFlag && anyWLFlag) {
    // Both — likely transitioning or multi-phase; lean PUBLIC
    result.phase = 'PUBLIC+WHITELIST';
    result.isPublic = true;
    result.isWhitelist = true;
  }

  if (paused === true) {
    result.phase = 'PAUSED';
    result.isPublic = false;
    result.isWhitelist = false;
    result.isPaused = true;
  }

  // ── 5. Merkle root detection ───────────────────────────────────────────────
  const merkleRoot  = await tryCall(contract, 'merkleRoot');
  const wlRoot      = await tryCall(contract, 'whitelistMerkleRoot');
  const alRoot      = await tryCall(contract, 'allowlistMerkleRoot');
  const hasRoot = (r) => r && r !== ethers.ZeroHash;
  result.hasMerkleRoot = hasRoot(merkleRoot) || hasRoot(wlRoot) || hasRoot(alRoot);

  // ── 6. Price detection ────────────────────────────────────────────────────
  for (const fn of ['mintPrice', 'price', 'cost', 'publicPrice', 'presalePrice']) {
    const v = await tryCall(contract, fn);
    if (v !== null && v !== undefined) {
      result.mintPrice = parseFloat(ethers.formatEther(v)).toFixed(6);
      break;
    }
  }

  // ── 7. Max per wallet ─────────────────────────────────────────────────────
  for (const fn of ['maxMintPerWallet', 'maxPerWallet', 'walletLimit', 'maxPerAddress', 'maxMintAmountPerTx']) {
    const v = await tryCall(contract, fn);
    if (v !== null && Number(v) > 0) {
      result.maxPerWallet = Number(v);
      break;
    }
  }

  // ── 8. Supply ─────────────────────────────────────────────────────────────
  const totalSupply = await tryCall(contract, 'totalSupply');
  const maxSupply   = await tryCall(contract, 'maxSupply') ?? await tryCall(contract, 'maxTotalSupply');
  if (totalSupply !== null) result.totalSupply = Number(totalSupply);
  if (maxSupply !== null)   result.maxSupply   = Number(maxSupply);
  if (result.totalSupply !== null && result.maxSupply !== null && result.totalSupply >= result.maxSupply) {
    result.phase = 'SOLD_OUT';
    result.isSoldOut = true;
  }

  // ── 9. Per-wallet eligibility ─────────────────────────────────────────────
  for (const walletAddress of walletAddresses) {
    const info = { eligible: null, alreadyMinted: false, mintedCount: 0, reason: '' };

    // Check minted count
    for (const fn of ['numberMinted', 'mintedCount', '_numberMinted']) {
      const v = await tryCall(contract, fn, [walletAddress]);
      if (v !== null) {
        info.mintedCount = Number(v);
        if (info.mintedCount > 0) {
          info.alreadyMinted = true;
          if (result.maxPerWallet && info.mintedCount >= result.maxPerWallet) {
            info.eligible = false;
            info.reason = `Already minted ${info.mintedCount}/${result.maxPerWallet}`;
          }
        }
        break;
      }
    }

    // hasMinted bool
    if (info.eligible === null) {
      const hm = await tryCall(contract, 'hasMinted', [walletAddress]);
      if (hm === true) {
        info.eligible = false;
        info.reason = 'hasMinted() = true';
        info.alreadyMinted = true;
      }
    }

    // Allowlist/whitelist check
    if (info.eligible === null && result.isWhitelist) {
      for (const fn of ['isWhitelisted', 'isAllowlisted', 'whitelist', 'allowlist']) {
        const v = await tryCall(contract, fn, [walletAddress]);
        if (v === true) { info.eligible = true; info.reason = `${fn}() = true ✅`; break; }
        if (v === false) { info.eligible = false; info.reason = `${fn}() = false ❌`; break; }
      }
    }

    // Already claimed check
    if (info.eligible === null) {
      const ac = await tryCall(contract, 'allowlistClaimed', [walletAddress]);
      if (ac === true) { info.eligible = false; info.reason = 'allowlistClaimed = true'; }
    }

    // Default: if public phase and no disqualifier found → eligible
    if (info.eligible === null && result.isPublic) {
      info.eligible = true;
      info.reason = 'Public mint — no restrictions detected';
    }

    if (info.eligible === null) {
      info.reason = 'Could not determine eligibility on-chain';
    }

    result.wallets[walletAddress] = info;
  }

  // ── v24/v25: Confidence tagging ──────────────────────────────────────────
  // FIX: phase detection is a heuristic (probes ~10 common getter names).
  // Many custom contracts expose none of them, in which case `phase` stays
  // 'UNKNOWN' but the bot previously presented this with the same visual
  // weight as a verified PAUSED/PUBLIC reading. Now every result carries a
  // `confidence` flag so the UI can visibly distinguish "we read this from
  // the contract" vs "we're guessing because nothing matched":
  //   'verified' — at least one real PHASE-determining flag (pause/sale-active/
  //                 phase enum/merkle root) was successfully read
  //   'heuristic' — phase is UNKNOWN/PUBLIC-by-default with no PHASE signal
  //                 at all; this is a guess, not a reading
  //
  // FIX (v25): this used to also count totalSupply/maxSupply/mintPrice as
  // "verified" signals. Those are real on-chain reads, but they say nothing
  // about PHASE — a contract can expose totalSupply() while having zero
  // pause/sale-active concept at all. That produced the confusing
  // "PHASE: UNKNOWN, CONFIDENCE: verified" contradiction users would see for
  // any contract that exposes supply/price getters but no phase getters
  // (common for OpenSea Studio/Seaport-based drops, which don't expose a
  // paused()/saleIsActive() the way ERC721 mint contracts usually do).
  // Confidence is now scoped to signals that actually inform PHASE.
  const phaseSignalFound = (
    result.raw.paused !== null || result.raw.saleIsActive !== null ||
    result.raw.publicSaleActive !== null || result.raw.mintEnabled !== null ||
    result.raw.isLive !== null || result.raw.isMintOpen !== null ||
    result.raw.mintOpen !== null || result.raw.presaleActive !== null ||
    result.raw.wlEnabled !== null || result.raw.alEnabled !== null ||
    result.raw.phaseNum !== undefined ||
    result.hasMerkleRoot
  );
  result.confidence = phaseSignalFound ? 'verified' : 'heuristic';
  if (!phaseSignalFound) {
    result.reason = '⚠️ No phase/sale-state getters found on this contract — phase is a default guess, not a verified reading. This is common for OpenSea Studio/Seaport drops, which often don\'t expose a standard paused()/saleIsActive() getter. Check the project\'s OpenSea page/Discord for the actual mint status.';
  } else {
    result.reason = result.reason || `Phase determined from on-chain reads (${result.phase})`;
  }

  logger.info(`Phase detect [${contractAddress.slice(0,10)}]: phase=${result.phase} confidence=${result.confidence} public=${result.isPublic} wl=${result.isWhitelist} paused=${result.isPaused} merkle=${result.hasMerkleRoot}`);
  return result;
}

/**
 * Poll for mint to open — used by schedule flow.
 * Fires callback when phase becomes PUBLIC or WHITELIST-open.
 * Returns { phase, mintPrice, maxPerWallet } when open.
 */
async function pollUntilOpen(contractAddress, chainId, { intervalMs = 5000, maxWaitMs = 3600000, onPoll } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const result = await detectMintPhase(contractAddress, [], chainId);
      if (onPoll) onPoll(result);
      if (result.isPublic || result.isWhitelist) return result;
      if (result.isSoldOut) throw new Error('Collection sold out before mint opened');
    } catch (e) {
      logger.warn(`pollUntilOpen error: ${e.message.slice(0,80)}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Mint did not open within the polling window');
}

// ── ERC-1155 detection ────────────────────────────────────────────────────────
const ERC1155_CHECK_ABI = [
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
];
const ERC1155_INTERFACE_ID = '0xd9b67a26';

async function isERC1155(contractAddress, provider) {
  try {
    const c = new ethers.Contract(contractAddress, ERC1155_CHECK_ABI, provider);
    return await c.supportsInterface(ERC1155_INTERFACE_ID);
  } catch { return false; }
}

module.exports = { detectMintPhase, pollUntilOpen, isERC1155 };

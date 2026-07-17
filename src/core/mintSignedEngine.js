/**
 * mintSignedEngine.js — v1
 *
 * Handles EIP-712 / mintSigned style contracts (e.g. OpenSea Seaport-drop,
 * Lit Punkerz, and similar contracts that require a backend-issued signature).
 *
 * HOW mintSigned WORKS:
 *   The contract function signature (from CatchMint / Etherscan) is:
 *
 *   function mintSigned(
 *     address nftContract,
 *     address feeRecipient,
 *     address minterIfNotPayer,
 *     uint256 quantity,
 *     MintParams calldata mintParams,   ← a tuple with price, times, limits etc.
 *     uint256 salt,
 *     bytes calldata signature           ← backend-issued EIP-712 sig
 *   ) external payable
 *
 *   The backend issues a signature over (nftContract, minter, mintParams, salt).
 *   Without a valid sig the call always reverts — that's what you were hitting.
 *
 * HOW WE GET THE SIG (auto-fetch):
 *   Most projects using this pattern host a /api/mint-signed or similar endpoint.
 *   We detect the pattern from the ABI and try known endpoint patterns.
 *   Set MINT_SIGNED_API_URL in .env to hard-code a project's endpoint, or
 *   let autoFetchMintSignedSig() probe the common patterns.
 *
 * DETECTION:
 *   isMintSignedContract(abiJson) → bool
 *   getMintSignedAbiEntry(abiJson) → ABI entry | null
 *
 * USAGE (called automatically from mintEngine when pattern detected):
 *   const { buildMintSignedArgs, autoFetchMintSignedSig, isMintSignedContract } = require('./mintSignedEngine');
 */

const { ethers } = require('ethers');
const logger = require('../utils/logger');

// ── Full ABI for the mintSigned pattern ───────────────────────────────────────
// MintParams tuple as seen on OpenSea-drop / SeaDrop style contracts
const MINT_SIGNED_ABI = [
  // OpenSea SeaDrop style (most common)
  `function mintSigned(
    address nftContract,
    address feeRecipient,
    address minterIfNotPayer,
    uint256 quantity,
    tuple(
      uint80 mintPrice,
      uint48 startTime,
      uint48 endTime,
      uint16 maxTotalMintableByWallet,
      uint24 feeBps,
      bool restrictFeeRecipients
    ) mintParams,
    uint256 salt,
    bytes signature
  ) payable`,

  // SeaDrop v2 / extended tuple
  `function mintSigned(
    address nftContract,
    address feeRecipient,
    address minterIfNotPayer,
    uint256 quantity,
    tuple(
      uint256 mintPrice,
      uint256 maxTotalMintableByWallet,
      uint256 startTime,
      uint256 endTime,
      uint256 dropStageIndex,
      uint256 maxTokenSupplyForStage,
      uint256 feeBps,
      bool restrictFeeRecipients
    ) mintParams,
    uint256 salt,
    bytes signature
  ) payable`,

  // Simpler variant (no nftContract arg)
  `function mintSigned(
    address feeRecipient,
    address minterIfNotPayer,
    uint256 quantity,
    tuple(
      uint80 mintPrice,
      uint48 startTime,
      uint48 endTime,
      uint16 maxTotalMintableByWallet,
      uint24 feeBps,
      bool restrictFeeRecipients
    ) mintParams,
    uint256 salt,
    bytes signature
  ) payable`,
];

// ── Detection helpers ─────────────────────────────────────────────────────────

/**
 * Returns true if the ABI contains a mintSigned function.
 */
function isMintSignedContract(abiJson) {
  if (!Array.isArray(abiJson)) return false;
  return abiJson.some(f => f.type === 'function' && f.name === 'mintSigned');
}

/**
 * Returns the ABI entry for mintSigned, or null.
 */
function getMintSignedAbiEntry(abiJson) {
  if (!Array.isArray(abiJson)) return null;
  return abiJson.find(f => f.type === 'function' && f.name === 'mintSigned') || null;
}

/**
 * Returns true if the contract object (ethers) has mintSigned attached.
 */
function contractHasMintSigned(contract) {
  return typeof contract?.mintSigned === 'function';
}

// ── Sig fetching ──────────────────────────────────────────────────────────────

/**
 * Fetches a mintSigned signature from a project's API — but ONLY if you've
 * explicitly configured one via MINT_SIGNED_API_URL.
 *
 * FIX (v25): this function used to "auto-fetch" by guessing at URL patterns
 * that don't correspond to any real, documented API
 * (`<contract>.vercel.app/api/sign`, `api.opensea.io/.../drops/.../sign`,
 * `api.<slug>.xyz/mint/sign/...`). None of these exist for the vast
 * majority of projects — they were invented patterns, not discovered ones.
 * Worse, OpenSea Studio / SeaDrop allowlist phases (GTD, FCFS) are signed
 * by an endpoint that lives *inside* opensea.io's authenticated session —
 * it isn't a public REST API and was never going to respond to a guess.
 * Probing it just burned time and produced the confusing "no sig fetched"
 * failures.
 *
 * There is no universal signing endpoint. So this function now does
 * exactly one thing: call the URL *you* configured for *this* project,
 * because you found it yourself (DevTools → Network → XHR while minting
 * normally) and know it's real. If you haven't set one, this returns null
 * immediately — no guessing, no silent probing.
 *
 * For projects with no public signing API at all (most OpenSea Studio
 * allowlist phases), the only legitimate route is the Manual Provider:
 * you obtain the actual signature once per eligible wallet through the
 * real mint site, then paste it into the bot's EIP-712 field so the bot
 * can broadcast the transaction. See buildMintSignedArgs() below.
 *
 * To find a real per-project URL (only works if the project genuinely
 * exposes one):
 *   1. Open the mint site in desktop Chrome (or via adb/scrcpy from Android)
 *   2. DevTools → Network → XHR — filter by "sign" or "mint"
 *   3. Connect wallet and click Mint
 *   4. Copy the request URL, replace your wallet address with {address}
 *   5. Set in .env:  MINT_SIGNED_API_URL=https://... (with {address} placeholder)
 */
async function autoFetchMintSignedSig(contractAddress, walletAddress, chainId = 1) {
  const envUrl = process.env.MINT_SIGNED_API_URL;
  if (!envUrl) {
    logger.warn(`[mintSigned] No MINT_SIGNED_API_URL configured — not guessing. Use the EIP-712 manual-signature field instead.`);
    return null;
  }

  const url = envUrl
    .replace('{address}', walletAddress)
    .replace('{contract}', contractAddress)
    .replace('{chainId}', chainId);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.warn(`[mintSigned] Configured API returned ${res.status} for ${walletAddress.slice(0, 8)}`);
      return null;
    }
    const json = await res.json();

    const sig =
      json?.signature || json?.sig || json?.data?.signature ||
      json?.result?.signature || json?.mintSignature || null;

    const mintParams =
      json?.mintParams || json?.params || json?.data?.mintParams ||
      json?.result?.mintParams || null;

    const salt =
      json?.salt ?? json?.data?.salt ?? json?.result?.salt ?? null;

    const feeRecipient =
      json?.feeRecipient || json?.data?.feeRecipient ||
      json?.result?.feeRecipient || ethers.ZeroAddress;

    if (sig && sig.startsWith('0x')) {
      logger.info(`[mintSigned] Got sig from configured API (${new URL(url).hostname}) for ${walletAddress.slice(0, 8)}`);
      return { sig, mintParams, salt, feeRecipient };
    }
    logger.warn(`[mintSigned] Configured API responded but had no usable signature field for ${walletAddress.slice(0, 8)}`);
    return null;
  } catch (e) {
    logger.warn(`[mintSigned] Configured API fetch failed: ${e.message.slice(0, 80)}`);
    return null;
  }
}

// ── Arg builder ───────────────────────────────────────────────────────────────

/**
 * Builds the args array for a mintSigned call.
 *
 * If we have a full sigResult (from autoFetchMintSignedSig), we use its
 * mintParams directly. Otherwise we build a best-effort mintParams from
 * on-chain phase data.
 *
 * @param {object} opts
 * @param {string} opts.contractAddress   - The NFT contract address
 * @param {string} opts.walletAddress     - Minter wallet
 * @param {number} opts.quantity          - How many to mint
 * @param {number} opts.mintPrice         - Mint price in ETH
 * @param {object|null} opts.sigResult    - Result from autoFetchMintSignedSig
 * @param {object|null} opts.phaseInfo    - From detectMintPhase (for fallback params)
 * @param {object} opts.abiEntry          - The mintSigned ABI entry
 * @returns {Array} args ready for contract.mintSigned(...args)
 */
function buildMintSignedArgs({ contractAddress, walletAddress, quantity, mintPrice, sigResult, phaseInfo, abiEntry }) {
  const inputs = abiEntry?.inputs || [];
  const hasNftContractArg = inputs.length > 0 && inputs[0]?.name === 'nftContract';

  const feeRecipient = sigResult?.feeRecipient || ethers.ZeroAddress;
  const salt = sigResult?.salt ?? Math.floor(Math.random() * 1e15);
  const sig = sigResult?.sig || '0x';

  // Build mintParams tuple — prefer fetched, fall back to phase data
  let mintParams;
  if (sigResult?.mintParams) {
    mintParams = sigResult.mintParams;
  } else {
    // Best-effort from phase info / price
    const priceWei = ethers.parseEther(mintPrice?.toString() || '0');
    const now = Math.floor(Date.now() / 1000);
    mintParams = {
      mintPrice: priceWei,
      startTime: now - 60,
      endTime: now + 86400,
      maxTotalMintableByWallet: phaseInfo?.maxPerWallet || 10,
      feeBps: 250,          // 2.5% — common default
      restrictFeeRecipients: false,
    };
  }

  if (hasNftContractArg) {
    return [contractAddress, feeRecipient, walletAddress, quantity, mintParams, salt, sig];
  } else {
    return [feeRecipient, walletAddress, quantity, mintParams, salt, sig];
  }
}

// ── Interface builder (for attaching to ethers contract) ──────────────────────

/**
 * Returns an ethers Interface that includes all mintSigned variants.
 * Useful when the on-chain ABI fetch fails and we need a fallback.
 */
function getMintSignedInterface() {
  return new ethers.Interface(MINT_SIGNED_ABI);
}

module.exports = {
  isMintSignedContract,
  getMintSignedAbiEntry,
  contractHasMintSigned,
  autoFetchMintSignedSig,
  buildMintSignedArgs,
  getMintSignedInterface,
  MINT_SIGNED_ABI,
};

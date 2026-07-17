/**
 * priceGuard.js — v19
 *
 * Guards against devs silently switching a free/cheap mint to paid.
 * Reads on-chain price at mint time and compares to what user declared.
 *
 * HOW IT WORKS:
 *   1. Before minting, call checkPriceOnChain(contractAddress, declaredPriceEth, chainId)
 *   2. If the on-chain price is higher than declared, returns { safe: false, onChainEth, delta }
 *   3. Caller can warn user or abort
 *
 * PRICE FUNCTIONS PROBED (in priority order):
 *   mintPrice(), price(), cost(), publicPrice(), presalePrice(), getPrice(),
 *   MINT_PRICE(), PUBLIC_PRICE(), pricePerToken(), tokenPrice()
 */

const { ethers } = require('ethers');
const { getProvider } = require('../utils/rpcManager');
const logger = require('../utils/logger');

const PRICE_ABI = [
  'function mintPrice() view returns (uint256)',
  'function price() view returns (uint256)',
  'function cost() view returns (uint256)',
  'function publicPrice() view returns (uint256)',
  'function presalePrice() view returns (uint256)',
  'function getPrice() view returns (uint256)',
  'function MINT_PRICE() view returns (uint256)',
  'function PUBLIC_PRICE() view returns (uint256)',
  'function pricePerToken() view returns (uint256)',
  'function tokenPrice() view returns (uint256)',
  'function weiCostPerToken() view returns (uint256)',
  'function mintFee() view returns (uint256)',
];

const PRICE_FNS = [
  'mintPrice', 'price', 'cost', 'publicPrice', 'presalePrice',
  'getPrice', 'MINT_PRICE', 'PUBLIC_PRICE', 'pricePerToken',
  'tokenPrice', 'weiCostPerToken', 'mintFee',
];

/**
 * Fetch the on-chain mint price. Returns ETH as a float, or null if unreadable.
 */
async function fetchOnChainPrice(contractAddress, chainId = 1) {
  try {
    const provider = await getProvider(chainId);
    const contract = new ethers.Contract(contractAddress, PRICE_ABI, provider);
    for (const fn of PRICE_FNS) {
      try {
        const raw = await contract[fn]();
        const eth = parseFloat(ethers.formatEther(raw));
        if (eth >= 0) {
          logger.info(`priceGuard: ${fn}() = ${eth} ETH on-chain`);
          return { eth, fn };
        }
      } catch { /* fn not found, try next */ }
    }
    return null; // contract doesn't expose a price fn — free mint or custom
  } catch (e) {
    logger.warn(`priceGuard: fetchOnChainPrice failed: ${e.message.slice(0, 80)}`);
    return null;
  }
}

/**
 * Compare declared price vs on-chain price.
 *
 * @param contractAddress
 * @param declaredPriceEth  — what the user entered in the bot (0 for freemint)
 * @param chainId
 * @param tolerancePct      — allow up to X% difference before flagging (default 5%)
 *
 * @returns {
 *   safe: bool,          — false = price mismatch, warn user
 *   onChainEth: float,   — what the contract says
 *   declaredEth: float,  — what the user declared
 *   delta: float,        — onChainEth - declaredEth
 *   priceFn: string,     — which function was read
 *   reason: string       — human-readable explanation
 * }
 */
async function checkPriceOnChain(contractAddress, declaredPriceEth, chainId = 1, tolerancePct = 5) {
  const result = await fetchOnChainPrice(contractAddress, chainId);

  if (!result) {
    // FIX (v24): "can't determine" was previously reported as safe: true,
    // which is the exact "unknown treated as safe" pattern that makes this
    // dangerous for a tool that spends real money. Now reports safe: null
    // (genuinely unknown) so callers MUST handle it explicitly — they can't
    // accidentally treat "we have no idea" the same as "we checked and it's fine".
    return {
      safe: null,
      confidence: 'unknown',
      onChainEth: null,
      declaredEth: declaredPriceEth,
      delta: null,
      priceFn: null,
      reason: '⚠️ Could not read any price function on this contract — price cannot be verified on-chain. Confirm the mint price manually before sending.',
    };
  }

  const { eth: onChainEth, fn: priceFn } = result;
  const delta = onChainEth - declaredPriceEth;
  const toleranceEth = (declaredPriceEth * tolerancePct) / 100;

  // Free mint declared but now paid
  if (declaredPriceEth === 0 && onChainEth > 0) {
    return {
      safe: false,
      confidence: 'verified',
      onChainEth, declaredEth: declaredPriceEth,
      delta, priceFn,
      reason: `⚠️ PRICE ALERT: You declared FREE but contract now charges ${onChainEth} ETH! Dev may have switched to paid mint.`,
    };
  }

  // Price increased beyond tolerance
  if (delta > toleranceEth && delta > 0.0001) {
    return {
      safe: false,
      confidence: 'verified',
      onChainEth, declaredEth: declaredPriceEth,
      delta, priceFn,
      reason: `⚠️ PRICE ALERT: On-chain price is ${onChainEth} ETH but you entered ${declaredPriceEth} ETH (+${delta.toFixed(6)} ETH difference). Possible price change.`,
    };
  }

  return {
    safe: true,
    confidence: 'verified',
    onChainEth, declaredEth: declaredPriceEth,
    delta, priceFn,
    reason: `Price OK: on-chain ${onChainEth} ETH matches declared ${declaredPriceEth} ETH`,
  };
}

module.exports = { checkPriceOnChain, fetchOnChainPrice };

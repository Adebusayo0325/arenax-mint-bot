const { getProvider } = require('../utils/rpcManager');
const logger = require('../utils/logger');

/**
 * FIX: Old code set maxFeePerGas = maxPriorityFeePerGas = gweiOverride.
 * That wastes money. Correct EIP-1559:
 *   - maxPriorityFeePerGas = tip (what miner keeps)
 *   - maxFeePerGas = baseFee * 1.35 + tip (cap you'll pay at most)
 * You only ever pay baseFee + tip, never the full maxFee unless base spikes.
 */
async function getGasParams(speedMultiplier = 1.15, chainId) {
  const provider = await getProvider(chainId);
  const feeData = await provider.getFeeData();

  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    // Scale the tip by the speed multiplier
    let tip = BigInt(Math.ceil(Number(feeData.maxPriorityFeePerGas) * speedMultiplier));

    // FIX (v23): the network's reported priority fee can be extremely low
    // (e.g. 0.26 gwei) during quiet periods, but a GTD mint needs to compete
    // for block inclusion against other minters bidding higher. A 0.3 gwei
    // auto-tip can leave a tx pending indefinitely during any gas spike.
    // Enforce a sane floor of 1 gwei on mainnet-style chains so "auto" mode
    // isn't dangerously passive. Users can still override via gweiOverride.
    const MIN_TIP_WEI = BigInt(1e9); // 1 gwei floor
    if (tip < MIN_TIP_WEI) tip = MIN_TIP_WEI;

    // Estimate current base fee from fee data
    // EIP-1559: maxFeePerGas = baseFee * 2 + tip (ethers default)
    // Actual base fee ≈ (maxFeePerGas - maxPriorityFeePerGas) / 2
    const estimatedBase = (feeData.maxFeePerGas - feeData.maxPriorityFeePerGas) / 2n;

    // Give headroom for 3 blocks of base fee increase (max 12.5%/block ≈ 1.42x for 3 blocks)
    const maxFee = BigInt(Math.ceil(Number(estimatedBase) * 1.45 * speedMultiplier)) + tip;
    const finalMax = maxFee < tip * 2n ? tip * 2n : maxFee;

    logger.info(
      `Gas EIP-1559: base≈${(Number(estimatedBase)/1e9).toFixed(2)} ` +
      `tip=${(Number(tip)/1e9).toFixed(2)} max=${(Number(finalMax)/1e9).toFixed(2)} gwei`
    );
    return { maxFeePerGas: finalMax, maxPriorityFeePerGas: tip };
  }

  // Legacy chains (BSC, etc.)
  const gasPrice = BigInt(Math.ceil(Number(feeData.gasPrice) * speedMultiplier));
  logger.info(`Gas legacy: ${(Number(gasPrice)/1e9).toFixed(2)} gwei`);
  return { gasPrice };
}

/**
 * When user specifies a gwei override, treat it as the PRIORITY TIP,
 * not as both maxFee and tip. Then compute maxFee properly from current baseFee.
 */
async function buildGasParamsFromOverride(gweiOverride, chainId) {
  const provider = await getProvider(chainId);
  const tip = ethers_parseUnits(gweiOverride.toString(), 'gwei');

  try {
    const feeData = await provider.getFeeData();
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      const estimatedBase = (feeData.maxFeePerGas - feeData.maxPriorityFeePerGas) / 2n;
      const maxFee = BigInt(Math.ceil(Number(estimatedBase) * 1.35)) + tip;
      const finalMax = maxFee < tip * 2n ? tip * 2n : maxFee;
      logger.info(
        `Gas override: tip=${gweiOverride}gwei maxFee=${(Number(finalMax)/1e9).toFixed(2)}gwei`
      );
      return { maxFeePerGas: finalMax, maxPriorityFeePerGas: tip };
    }
  } catch (e) {
    // fall through to legacy
  }

  logger.info(`Gas override (legacy): ${gweiOverride}gwei`);
  return { gasPrice: tip };
}

// Lazy require ethers to avoid circular dep issues
function ethers_parseUnits(val, unit) {
  const { ethers } = require('ethers');
  return ethers.parseUnits(val, unit);
}

async function estimateGasLimit(contract, method, args, value) {
  try {
    const estimate = await contract[method].estimateGas(...args, { value });
    // +20% buffer is sufficient; +25% was wasting gas budget on balance checks
    const buffered = BigInt(Math.ceil(Number(estimate) * 1.20));
    logger.info(`Gas limit: estimated=${estimate} buffered=${buffered}`);
    return buffered;
  } catch (err) {
    // FIX v13: fallback was 400000 — 2-3x too high for a typical ERC721 mint (120k-180k).
    // High fallback made wallet balance checks fail on properly-funded wallets because
    // gasBuffer = feePerGas * 400000 * 1.2 >> actual cost. Now 150000 (safe for most mints).
    logger.warn(`Gas estimate failed: ${err.message.slice(0, 100)} — fallback 150000`);
    return BigInt(150000);
  }
}

/**
 * Lightweight gas params for simple ETH transfers (21000 gas).
 * Uses a lower speed multiplier than mints — no need to compete for priority.
 */
async function getFundingGasParams(chainId) {
  return getGasParams(1.05, chainId); // 5% tip bump vs 15% for mints
}


/**
 * Returns the *effective* fee-per-gas for balance checks.
 * Uses baseFee + tip (what you actually pay), NOT maxFeePerGas (the worst-case cap).
 * One 20% safety buffer is applied via estimateGasLimit's padded gasLimit — no double buffer.
 */
async function getEffectiveFeePerGas(chainId) {
  try {
    const provider = await getProvider(chainId);
    const feeData  = await provider.getFeeData();
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      const estimatedBase = (feeData.maxFeePerGas - feeData.maxPriorityFeePerGas) / 2n;
      return estimatedBase + feeData.maxPriorityFeePerGas;
    }
    return feeData.gasPrice || BigInt(20e9);
  } catch {
    return BigInt(20e9);
  }
}


async function getCompetitiveGasTip(chainId, percentile = 75) {
  try {
    const provider = await getProvider(chainId);
    const block = await provider.getBlock('latest', true);
    if (!block?.transactions?.length) return BigInt(1.5e9);
    const tips = block.transactions.map(tx => tx.maxPriorityFeePerGas || 0n).filter(t => t > 0n).sort((a,b)=>(a<b?-1:1));
    if (!tips.length) return BigInt(1.5e9);
    const trimmed = tips.slice(0, Math.max(1, Math.floor(tips.length * 0.95)));
    const idx = Math.min(Math.floor(trimmed.length * percentile / 100), trimmed.length - 1);
    return trimmed[idx];
  } catch { return BigInt(1.5e9); }
}

module.exports = { getGasParams, buildGasParamsFromOverride, estimateGasLimit, getFundingGasParams, getEffectiveFeePerGas, getCompetitiveGasTip
};

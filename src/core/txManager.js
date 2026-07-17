/**
 * txManager.js — v16
 * Gas bump / cancel for stuck pending transactions.
 * Also tracks pending txs per wallet so we can query them.
 */

const { ethers } = require('ethers');
const { getProvider } = require('../utils/rpcManager');
const { getWalletSigner } = require('./walletManager');
const { getGasParams } = require('./gasOracle');
const logger = require('../utils/logger');

// In-memory registry of pending txs: walletAddress → [{ hash, nonce, chainId, sentAt }]
const pendingTxs = {};

function trackTx(walletAddress, txHash, nonce, chainId) {
  const key = walletAddress.toLowerCase();
  if (!pendingTxs[key]) pendingTxs[key] = [];
  pendingTxs[key].push({ hash: txHash, nonce, chainId, sentAt: Date.now() });
}

function getPendingTxs(walletAddress) {
  return pendingTxs[walletAddress.toLowerCase()] || [];
}

function clearTxRecord(walletAddress, nonce) {
  const key = walletAddress.toLowerCase();
  if (pendingTxs[key]) pendingTxs[key] = pendingTxs[key].filter(t => t.nonce !== nonce);
}

/**
 * Speed up (replace) a stuck tx by re-sending with higher gas.
 * Uses RBF (Replace By Fee) — same nonce, 10-20% higher gas.
 *
 * @returns { status, newTxHash, oldHash }
 */
async function speedUpTx(walletAddress, oldTxHash, chainId = 1) {
  const provider = await getProvider(chainId);
  const signer   = getWalletSigner(walletAddress, provider);

  // Fetch the original tx
  const origTx = await provider.getTransaction(oldTxHash);
  if (!origTx) throw new Error(`Transaction ${oldTxHash} not found`);

  // Check it's still pending
  const receipt = await provider.getTransactionReceipt(oldTxHash);
  if (receipt) {
    return { status: receipt.status === 1 ? 'already_confirmed' : 'already_failed', oldHash: oldTxHash };
  }

  // Get current gas params and bump by 15% above original
  const origMaxFee  = origTx.maxFeePerGas || origTx.gasPrice || BigInt(20e9);
  const origTip     = origTx.maxPriorityFeePerGas || BigInt(1e9);

  // EIP-1559 bump: +15% on both, then re-check current baseFee
  const newTip    = (origTip * 115n) / 100n;
  const newMaxFee = (origMaxFee * 115n) / 100n;

  logger.info(`Speed-up tx ${oldTxHash.slice(0,12)} nonce=${origTx.nonce} oldTip=${Number(origTip)/1e9}gwei newTip=${Number(newTip)/1e9}gwei`);

  const newTx = await signer.sendTransaction({
    to: origTx.to,
    data: origTx.data,
    value: origTx.value,
    nonce: origTx.nonce,
    gasLimit: origTx.gasLimit,
    maxFeePerGas: newMaxFee,
    maxPriorityFeePerGas: newTip,
    chainId,
  });

  logger.info(`Speed-up tx sent: ${newTx.hash}`);
  return { status: 'replaced', newTxHash: newTx.hash, oldHash: oldTxHash, nonce: origTx.nonce };
}

/**
 * Cancel a stuck tx by sending a 0-value self-transfer with same nonce and higher gas.
 */
async function cancelTx(walletAddress, oldTxHash, chainId = 1) {
  const provider = await getProvider(chainId);
  const signer   = getWalletSigner(walletAddress, provider);

  const origTx = await provider.getTransaction(oldTxHash);
  if (!origTx) throw new Error(`Transaction ${oldTxHash} not found`);

  const receipt = await provider.getTransactionReceipt(oldTxHash);
  if (receipt) {
    return { status: receipt.status === 1 ? 'already_confirmed' : 'already_failed', oldHash: oldTxHash };
  }

  const origMaxFee = origTx.maxFeePerGas || origTx.gasPrice || BigInt(20e9);
  const origTip    = origTx.maxPriorityFeePerGas || BigInt(1e9);
  const newTip    = (origTip * 120n) / 100n;
  const newMaxFee = (origMaxFee * 120n) / 100n;

  logger.info(`Cancelling tx ${oldTxHash.slice(0,12)} nonce=${origTx.nonce}`);

  // Self-transfer to cancel (0-value, same nonce)
  const cancelTxn = await signer.sendTransaction({
    to: walletAddress,
    value: 0n,
    nonce: origTx.nonce,
    gasLimit: 21000n,
    maxFeePerGas: newMaxFee,
    maxPriorityFeePerGas: newTip,
    chainId,
  });

  logger.info(`Cancel tx sent: ${cancelTxn.hash}`);
  return { status: 'cancel_sent', cancelTxHash: cancelTxn.hash, oldHash: oldTxHash, nonce: origTx.nonce };
}

/**
 * Check tx status: pending / confirmed / failed / not_found
 */
async function checkTxStatus(txHash, chainId = 1) {
  const provider = await getProvider(chainId);
  const receipt  = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    const tx = await provider.getTransaction(txHash);
    return tx ? { status: 'pending', hash: txHash } : { status: 'not_found', hash: txHash };
  }
  return {
    status: receipt.status === 1 ? 'confirmed' : 'failed',
    hash: txHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
  };
}

module.exports = { speedUpTx, cancelTx, checkTxStatus, trackTx, getPendingTxs, getAllPendingTxs, clearTxRecord };

// Get all pending txs across all wallets (flat hash→info map for UI display)
function getAllPendingTxs() {
  const result = {};
  for (const [wallet, txs] of Object.entries(pendingTxs)) {
    for (const tx of txs) {
      result[tx.hash] = { walletAddress: wallet, nonce: tx.nonce, chainId: tx.chainId, timestamp: tx.sentAt };
    }
  }
  return result;
}

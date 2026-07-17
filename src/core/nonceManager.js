/**
 * nonceManager.js — Per-wallet nonce tracking for rapid sequential sends.
 * Prevents "nonce too low" errors when master wallet funds multiple sub-wallets.
 * Auto-resets after 30s inactivity so stale state never blocks a mint.
 */
const logger = require('../utils/logger');
const TTL = 30000;
const cache = new Map();

async function getNextNonce(provider, address) {
  const key = address.toLowerCase();
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && (now - cached.updatedAt) < TTL) {
    const next = cached.next;
    cache.set(key, { next: next + 1, updatedAt: now });
    logger.info(`[Nonce] ${address.slice(0,8)} cached=${next}`);
    return next;
  }
  const onChain = await provider.getTransactionCount(address, 'pending');
  cache.set(key, { next: onChain + 1, updatedAt: now });
  logger.info(`[Nonce] ${address.slice(0,8)} chain=${onChain}`);
  return onChain;
}

function resetNonce(address) {
  cache.delete(address.toLowerCase());
}

function invalidateAll() {
  cache.clear();
}

module.exports = { getNextNonce, resetNonce, invalidateAll };

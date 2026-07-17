/**
 * mempoolWatcher.js — WebSocket pending-tx monitor.
 *
 * Fires onFound() the moment an owner/admin sends a tx to the contract
 * that looks like a "enable mint" call — BEFORE it's confirmed.
 * This is how serious FCFS bots detect the exact moment mint opens.
 *
 * Requires ALCHEMY_WS_RPC or BASE_WS_RPC etc in env (wss:// URLs).
 * Falls back gracefully if no WebSocket RPC is configured.
 */
const { ethers } = require('ethers');
const logger    = require('../utils/logger');

// 4-byte selectors for common "enable mint" functions
// Verified via keccak256(signature).slice(0,8)
const MINT_ENABLE_SELECTORS = new Set([
  '0x3f4ba83a', // unpause() ✓
  '0x8456cb59', // pause() ✓
  '0x2b707c71', // setPublicMintActive(bool) ✓
  '0xd04ef285', // setMintingActive(bool) ✓
  '0xc4e37095', // setSaleState(bool) ✓
  '0xf5ee3348', // setLive(bool) ✓
  '0x9293a5c7', // setPublicSaleState(bool) ✓
  '0xe2e06fa3', // setPublicSaleActive(bool) ✓
  '0x0e2d56cf', // setPublicMint(bool) ✓
  '0xe797ec1b', // enableMinting() ✓
]);

/**
 * Start watching the mempool for mint-enable txs targeting contractAddress.
 *
 * @param {string}   contractAddress  NFT contract to watch
 * @param {Function} onFound          Called with { txHash, from, selector } when detected
 * @param {number}   chainId
 * @param {number}   timeoutMs        Auto-stop after N ms (default 10 min)
 * @returns {{ stop: Function } | null}
 */
async function watchMempoolForMintEnable(contractAddress, onFound, chainId = 1, timeoutMs = 600000) {
  const wsKey  = chainId === 1 ? 'ALCHEMY_WS_RPC' : `CHAIN_${chainId}_WS_RPC`;
  const wsUrl  = process.env[wsKey] || process.env.ALCHEMY_WS_RPC;
  if (!wsUrl || !wsUrl.startsWith('wss://')) {
    logger.warn(`[Mempool] No WebSocket RPC configured (set ${wsKey}=wss://...) — mempool watch unavailable`);
    return null;
  }

  let stopped = false;
  let ws;

  try {
    ws = new ethers.WebSocketProvider(wsUrl);
    const target = contractAddress.toLowerCase();
    logger.info(`[Mempool] 👁️  Watching for mint-enable on ${contractAddress.slice(0,10)}...`);

    ws.on('pending', async (txHash) => {
      if (stopped) return;
      try {
        const tx = await ws.getTransaction(txHash);
        if (!tx || tx.to?.toLowerCase() !== target) return;
        const selector = tx.data?.slice(0, 10) || '';
        // Only fire on known mint-enable selectors — NOT on every owner tx
        if (!selector || !MINT_ENABLE_SELECTORS.has(selector)) return;
        logger.info(`[Mempool] 🔥 Mint-enable tx: ${selector} on ${contractAddress.slice(0,10)}`);
        onFound({ txHash, from: tx.from, selector, contractAddress, raw: tx.data?.slice(0, 50) });
      } catch { /* ignore individual tx errors */ }
    });

    const timer = setTimeout(() => { stopped = true; ws.destroy(); logger.info('[Mempool] Watcher auto-stopped (timeout)'); }, timeoutMs);

    return {
      stop() {
        stopped = true;
        clearTimeout(timer);
        try { ws.destroy(); } catch {}
        logger.info('[Mempool] Watcher stopped manually');
      },
    };
  } catch (e) {
    logger.warn(`[Mempool] Failed to start: ${e.message}`);
    return null;
  }
}

module.exports = { watchMempoolForMintEnable, MINT_ENABLE_SELECTORS };

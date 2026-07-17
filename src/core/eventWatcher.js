const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { getProvider } = require('../utils/rpcManager');

const activeWatchers = new Map();

async function watchContractEvents(contractAddress, chainId = 1, handlers = {}) {
  const key = `${contractAddress.toLowerCase()}:${chainId}`;
  if (activeWatchers.has(key)) return activeWatchers.get(key);

  let provider;
  try { provider = await getProvider(chainId); } catch (e) { logger.warn(`[EventWatcher] No provider: ${e.message}`); return null; }

  const target = contractAddress.toLowerCase();
  let transferCount = 0, transferWindow = Date.now(), stopped = false;

  const logListener = async (log) => {
    if (stopped || log.address.toLowerCase() !== target) return;
    if (log.topics[0] === ethers.id('Transfer(address,address,uint256)')) {
      const now = Date.now();
      if (now - transferWindow > 30000) { transferCount = 0; transferWindow = now; }
      if (++transferCount >= 20) { handlers.onSoldOut?.({ contractAddress, chainId, transferCount }); }
      return;
    }
    const ENABLE_SIGS = [
      ethers.id('PublicMintActive()'), ethers.id('MintEnabled(bool)'),
      ethers.id('PublicSaleStart()'), ethers.id('PublicSaleActivated()'),
      ethers.id('Unpaused(address)'), ethers.id('SaleStateChanged(bool)'),
      ethers.id('PublicDropUpdated(address,(uint80,uint48,uint48,uint16,uint16,bool))'),
    ];
    if (ENABLE_SIGS.includes(log.topics[0])) {
      logger.info(`[EventWatcher] 🟢 Mint-enable event on ${contractAddress.slice(0,10)}`);
      handlers.onMintEnabled?.({ contractAddress, chainId, log });
    }
    handlers.onEvent?.({ contractAddress, chainId, log });
  };

  provider.on({ address: contractAddress }, logListener);
  logger.info(`[EventWatcher] 👁️  Watching ${contractAddress.slice(0,10)} chain=${chainId}`);

  const watcher = {
    contractAddress, chainId,
    stop() { stopped = true; try { provider.off({ address: contractAddress }, logListener); } catch {} activeWatchers.delete(key); },
  };
  activeWatchers.set(key, watcher);
  return watcher;
}

function getActiveWatchers() { return Array.from(activeWatchers.keys()); }

module.exports = { watchContractEvents, getActiveWatchers };

const { ethers } = require('ethers');
const { getChain } = require('./chainConfig');
const config = require('../config');
const logger = require('./logger');

const LATENCY_TIMEOUT_MS = 3000;

async function getProvider(chainId) {
  chainId = parseInt(chainId || config.DEFAULT_CHAIN_ID);
  const chain = getChain(chainId);
  const urls = [...config.getRpcUrls(chainId), ...chain.publicRpcs].filter(Boolean);
  if (!urls.length) throw new Error(`No RPCs configured for chain ${chainId}`);

  const race = urls.map(async (url) => {
    const start = Date.now();
    const p = new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), LATENCY_TIMEOUT_MS));
    await Promise.race([p.getBlockNumber(), timeout]);
    return { url, latency: Date.now() - start, provider: p };
  });

  const results = await Promise.allSettled(race);
  const winners = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
    .sort((a, b) => a.latency - b.latency);

  if (winners.length) {
    const w = winners[0];
    logger.info(`RPC [chain=${chainId}] ${w.url.slice(0, 50)} (${w.latency}ms, ${winners.length}/${urls.length} alive)`);
    return w.provider;
  }
  throw new Error(`All RPCs failed for chain ${chainId} (${chain.name}). Add CHAIN_${chainId}_RPC to .env`);
}

module.exports = { getProvider };

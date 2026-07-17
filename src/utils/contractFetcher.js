const axios = require('axios');
const { getChain } = require('./chainConfig');
const config = require('../config');
const logger = require('./logger');

async function fetchABI(contractAddress, chainId = 1) {
  const chain = getChain(parseInt(chainId));

  if (!chain.explorerApi) {
    throw new Error(`No explorer API available for ${chain.name}`);
  }

  // Use chain-specific key, fall back to ETHERSCAN_API_KEY
  const apiKey = chain.explorerApiKeyEnv
    ? (process.env[chain.explorerApiKeyEnv] || config.ETHERSCAN_API_KEY || '')
    : config.ETHERSCAN_API_KEY || '';

  const url = `${chain.explorerApi}?module=contract&action=getabi&address=${contractAddress}&apikey=${apiKey}`;
  const res = await axios.get(url, { timeout: 10000 });

  if (res.data.status !== '1') {
    throw new Error(`ABI not verified on ${chain.name}: ${res.data.message || res.data.result}`);
  }

  logger.info(`ABI fetched: ${contractAddress} on ${chain.name}`);
  return JSON.parse(res.data.result);
}

module.exports = { fetchABI };

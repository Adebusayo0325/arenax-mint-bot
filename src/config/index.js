require('dotenv').config();

const DEFAULT_CHAIN_ID = parseInt(process.env.CHAIN_ID || '1');

const config = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  ALLOWED_USER_ID: parseInt(process.env.ALLOWED_USER_ID),
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,
  MASTER_PRIVATE_KEY: process.env.MASTER_PRIVATE_KEY,
  WALLET_ENCRYPT_PASSWORD: process.env.WALLET_ENCRYPT_PASSWORD,
  WEBAPP_API_TOKEN: process.env.WEBAPP_API_TOKEN,
  WEBAPP_URL: process.env.WEBAPP_URL,
  RENDER_URL: process.env.RENDER_URL,
  PORT: process.env.PORT || 3000,
  DEFAULT_CHAIN_ID,
  OPENSEA_API_KEY: process.env.OPENSEA_API_KEY || '',
  DRY_RUN: process.env.DRY_RUN === 'true',
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',

  // ── Redis (optional — enables persistent schedules across restarts) ──
  // Toggle: set REDIS_URL in Render env to enable. Leave unset for JSON-only.
  REDIS_URL: process.env.REDIS_URL || null,

  // WebSocket RPCs for mempool monitoring (wss:// URLs from Alchemy/QuickNode)
  // Set ALCHEMY_WS_RPC=wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY in Render
  ALCHEMY_WS_RPC: process.env.ALCHEMY_WS_RPC || null,
  getRpcWsUrls(chainId) {
    const custom = process.env[`CHAIN_${chainId}_WS_RPC`];
    if (custom) return [custom];
    if (chainId === 1 && process.env.ALCHEMY_WS_RPC) return [process.env.ALCHEMY_WS_RPC];
    return [];
  },

  // ── Tenderly (optional — richer pre-flight simulation traces) ──
  // Toggle: set all three below in Render env to enable Tenderly simulation.
  // Leave unset to use the default callStatic simulation.
  TENDERLY_ACCESS_KEY: process.env.TENDERLY_ACCESS_KEY || null,
  TENDERLY_ACCOUNT:    process.env.TENDERLY_ACCOUNT    || null,
  TENDERLY_PROJECT:    process.env.TENDERLY_PROJECT    || null,

  // Returns ordered RPC URL list for a chain.
  // Priority: env-specific → legacy ALCHEMY/INFURA (chain 1) → chain public RPCs
  getRpcUrls(chainId) {
    chainId = parseInt(chainId || DEFAULT_CHAIN_ID);
    const specific = process.env[`CHAIN_${chainId}_RPC`];
    if (specific) return [specific];
    if (chainId === 1) {
      return [process.env.ALCHEMY_RPC, process.env.INFURA_RPC].filter(Boolean);
    }
    return []; // chainConfig publicRpcs used as fallback in rpcManager
  },
};

module.exports = config;

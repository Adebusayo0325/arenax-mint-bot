// All supported EVM chains — add CHAIN_<ID>_RPC to .env to use any of them
const CHAINS = {
  1: {
    name: 'Ethereum', shortName: 'eth', symbol: 'ETH',
    explorer: 'https://etherscan.io',
    explorerApi: 'https://api.etherscan.io/api',
    explorerApiKeyEnv: 'ETHERSCAN_API_KEY',
    openseaChain: 'ethereum',
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    openseaConduit: '0x1e0049783f008a0085193e00003d00cd54003c71',
    openseaConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
    openseaFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
    defaultRpcEnvs: ['ALCHEMY_RPC', 'INFURA_RPC'],
    publicRpcs: ['https://eth.llamarpc.com', 'https://cloudflare-eth.com', 'https://rpc.ankr.com/eth'],
  },
  8453: {
    name: 'Base', shortName: 'base', symbol: 'ETH',
    explorer: 'https://basescan.org',
    explorerApi: 'https://api.basescan.org/api',
    explorerApiKeyEnv: 'BASESCAN_API_KEY',
    openseaChain: 'base',
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    openseaConduit: '0x1e0049783f008a0085193e00003d00cd54003c71',
    openseaConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
    openseaFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
    defaultRpcEnvs: ['BASE_RPC', 'CHAIN_8453_RPC'],
    publicRpcs: ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://rpc.ankr.com/base'],
  },
  42161: {
    name: 'Arbitrum', shortName: 'arb', symbol: 'ETH',
    explorer: 'https://arbiscan.io',
    explorerApi: 'https://api.arbiscan.io/api',
    explorerApiKeyEnv: 'ARBISCAN_API_KEY',
    openseaChain: 'arbitrum',
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    openseaConduit: '0x1e0049783f008a0085193e00003d00cd54003c71',
    openseaConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
    openseaFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
    defaultRpcEnvs: ['ARBITRUM_RPC'],
    publicRpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.llamarpc.com'],
  },
  10: {
    name: 'Optimism', shortName: 'op', symbol: 'ETH',
    explorer: 'https://optimistic.etherscan.io',
    explorerApi: 'https://api-optimistic.etherscan.io/api',
    explorerApiKeyEnv: 'OPTIMISM_API_KEY',
    openseaChain: 'optimism',
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    openseaConduit: '0x1e0049783f008a0085193e00003d00cd54003c71',
    openseaConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
    openseaFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
    defaultRpcEnvs: ['OPTIMISM_RPC'],
    publicRpcs: ['https://mainnet.optimism.io', 'https://optimism.llamarpc.com'],
  },
  137: {
    name: 'Polygon', shortName: 'matic', symbol: 'POL',
    explorer: 'https://polygonscan.com',
    explorerApi: 'https://api.polygonscan.com/api',
    explorerApiKeyEnv: 'POLYGONSCAN_API_KEY',
    openseaChain: 'matic',
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    openseaConduit: '0x1e0049783f008a0085193e00003d00cd54003c71',
    openseaConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
    openseaFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
    defaultRpcEnvs: ['POLYGON_RPC'],
    publicRpcs: ['https://polygon-rpc.com', 'https://polygon.llamarpc.com'],
  },
  56: {
    name: 'BNB Chain', shortName: 'bnb', symbol: 'BNB',
    explorer: 'https://bscscan.com',
    explorerApi: 'https://api.bscscan.com/api',
    explorerApiKeyEnv: 'BSCSCAN_API_KEY',
    openseaChain: 'bsc',
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    openseaConduit: '0x1e0049783f008a0085193e00003d00cd54003c71',
    openseaConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
    openseaFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
    defaultRpcEnvs: ['BSC_RPC'],
    publicRpcs: ['https://bsc-dataseed.binance.org', 'https://bsc.llamarpc.com'],
  },
  81457: {
    name: 'Blast', shortName: 'blast', symbol: 'ETH',
    explorer: 'https://blastscan.io',
    explorerApi: 'https://api.blastscan.io/api',
    explorerApiKeyEnv: 'BLASTSCAN_API_KEY',
    openseaChain: 'blast',
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    openseaConduit: '0x1e0049783f008a0085193e00003d00cd54003c71',
    openseaConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
    openseaFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
    defaultRpcEnvs: ['BLAST_RPC'],
    publicRpcs: ['https://rpc.blast.io', 'https://blast.llamarpc.com'],
  },
  59144: {
    name: 'Linea', shortName: 'linea', symbol: 'ETH',
    explorer: 'https://lineascan.build',
    explorerApi: 'https://api.lineascan.build/api',
    explorerApiKeyEnv: 'LINEASCAN_API_KEY',
    openseaChain: 'linea',
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    openseaConduit: '0x1e0049783f008a0085193e00003d00cd54003c71',
    openseaConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
    openseaFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
    defaultRpcEnvs: ['LINEA_RPC'],
    publicRpcs: ['https://rpc.linea.build', 'https://linea.llamarpc.com'],
  },
  7777777: {
    name: 'Zora', shortName: 'zora', symbol: 'ETH',
    explorer: 'https://explorer.zora.energy',
    explorerApi: null,
    openseaChain: 'zora',
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    openseaConduit: '0x1e0049783f008a0085193e00003d00cd54003c71',
    openseaConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
    openseaFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
    defaultRpcEnvs: ['ZORA_RPC'],
    publicRpcs: ['https://rpc.zora.energy'],
  },
  43114: {
    name: 'Avalanche', shortName: 'avax', symbol: 'AVAX',
    explorer: 'https://snowscan.xyz',
    explorerApi: 'https://api.snowscan.xyz/api',
    explorerApiKeyEnv: 'SNOWSCAN_API_KEY',
    openseaChain: 'avalanche',
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    openseaConduit: '0x1e0049783f008a0085193e00003d00cd54003c71',
    openseaConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
    openseaFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
    defaultRpcEnvs: ['AVAX_RPC'],
    publicRpcs: ['https://api.avax.network/ext/bc/C/rpc', 'https://rpc.ankr.com/avalanche'],
  },
  33139: {
    name: 'ApeChain', shortName: 'apechain', symbol: 'APE',
    explorer: 'https://apescan.io',
    explorerApi: 'https://api.apescan.io/api',
    explorerApiKeyEnv: 'APESCAN_API_KEY',
    openseaChain: 'ape_chain',
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    openseaConduit: '0x1e0049783f008a0085193e00003d00cd54003c71',
    openseaConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
    openseaFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
    defaultRpcEnvs: ['APECHAIN_RPC', 'CHAIN_33139_RPC'],
    publicRpcs: ['https://apechain.calderachain.xyz/http', 'https://rpc.apechain.com'],
  },
  4663: {
    name: 'Robinhood Chain', shortName: 'rh', symbol: 'ETH',
    explorer: 'https://robinhoodchain.blockscout.com',
    explorerApi: null, // Blockscout — no Etherscan-style key-based API confirmed yet
    // NOTE: openseaChain slug is a best-guess from OpenSea's URL pattern
    // (opensea.io/tokens/chain/robinhood) — this chain launched July 1 2026
    // and I don't have a way to verify the exact API slug string live. If
    // OpenSea-specific features (phase check, listings) 404/error on this
    // chain specifically, this is the first thing to check/correct.
    openseaChain: 'robinhood',
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    openseaConduit: '0x1e0049783f008a0085193e00003d00cd54003c71',
    openseaConduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
    openseaFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
    defaultRpcEnvs: ['ROBINHOOD_RPC', 'CHAIN_4663_RPC'],
    publicRpcs: ['https://rpc.mainnet.chain.robinhood.com'],
  },
};

function getChain(chainId) {
  return CHAINS[parseInt(chainId)] || CHAINS[1];
}

function getChainList() {
  return Object.entries(CHAINS).map(([id, c]) => ({ id: parseInt(id), ...c }));
}

function getChainEmoji(chainId) {
  const map = { 1:'⟠', 8453:'🔵', 42161:'🔷', 10:'🔴', 137:'💜', 56:'🟡', 81457:'🔥', 59144:'🟢', 7777777:'🎨', 43114:'🔺', 33139:'🦍', 4663:'🏹' };
  return map[parseInt(chainId)] || '🔗';
}

module.exports = { CHAINS, getChain, getChainList, getChainEmoji };

const logger = require('../utils/logger');

const seaDropAdapter = {
  id: 'seadrop', name: '🌊 SeaDrop (OpenSea)', chains: [1, 8453, 10, 42161],
  async detect(contract, chainId) {
    try {
      const { isSeaDropContract, getSeaDropPhase } = require('./seaDropEngine');
      if (!await isSeaDropContract(contract, chainId)) return false;
      // Only route to SeaDrop if the drop IS configured (startTime != 0)
      // Seaport-based OpenSea Studio drops have startTime=0 and will revert
      const phase = await getSeaDropPhase(contract, chainId).catch(() => null);
      if (phase?.phase === 'NOT_CONFIGURED') {
        logger.info(`[Adapter] SeaDrop contract but drop not configured → generic fallback`);
        return false;
      }
      return true;
    } catch { return false; }
  },
  async getPhase(contract, chainId) { const { getSeaDropPhase } = require('./seaDropEngine'); return getSeaDropPhase(contract, chainId); },
  async getProof() { return { proof: [], sig: null }; },
  mintFn: 'mintPublic', routeTo: 'seadrop',
};

const manifoldAdapter = {
  id: 'manifold', name: '🎨 Manifold', chains: [1, 8453, 137],
  async detect(contract, chainId) {
    try { const { detectLaunchpad } = require('./launchpadProofs'); return await detectLaunchpad(contract, chainId) === 'manifold'; }
    catch { return false; }
  },
  async getPhase() { return null; },
  async getProof(contract, wallet, chainId) {
    try { const { fetchProofFromLaunchpad } = require('./launchpadProofs'); return await fetchProofFromLaunchpad(contract, wallet, chainId); }
    catch { return { proof: [], sig: null }; }
  },
  mintFn: null, routeTo: null,
};

const thirdwebAdapter = {
  id: 'thirdweb', name: '🔷 thirdweb', chains: [1, 8453, 42161, 10, 137],
  async detect(contract, chainId) {
    try { const { detectLaunchpad } = require('./launchpadProofs'); return await detectLaunchpad(contract, chainId) === 'thirdweb'; }
    catch { return false; }
  },
  async getPhase() { return null; },
  async getProof(contract, wallet, chainId) {
    try { const { fetchProofFromLaunchpad } = require('./launchpadProofs'); return await fetchProofFromLaunchpad(contract, wallet, chainId); }
    catch { return { proof: [], sig: null }; }
  },
  mintFn: 'claim', routeTo: null,
};

const zoraAdapter = {
  id: 'zora', name: '🟡 Zora', chains: [7777777, 1, 8453],
  async detect(contract, chainId) {
    try { const { detectLaunchpad } = require('./launchpadProofs'); return await detectLaunchpad(contract, chainId) === 'zora'; }
    catch { return false; }
  },
  async getPhase() { return null; },
  async getProof() { return { proof: [], sig: null }; },
  mintFn: 'mint', routeTo: null,
};

const genericAdapter = {
  id: 'generic', name: '⚙️ Generic', chains: [],
  async detect() { return true; },
  async getPhase() { return null; },
  async getProof() { return { proof: [], sig: null }; },
  mintFn: null, routeTo: null,
};


const openSeaAdapter = {
  id:'opensea', name:'🌊 OpenSea (Seaport)', chains:[1,8453,10,42161,137],
  async detect(c,cid){ try{ if(!process.env.OPENSEA_API_KEY)return false; return await require('./openSeaEngine').isOpenSeaDrop(c,cid); }catch{return false;} },
  async getPhase(c,cid){ return require('./openSeaEngine').getOpenSeaPhase(c,cid); },
  async getProof(){ return {proof:[],sig:null}; },
  mintFn:'fulfillAvailableAdvancedOrders', routeTo:'opensea',
};

const ADAPTERS = [seaDropAdapter, manifoldAdapter, thirdwebAdapter, zoraAdapter, genericAdapter];

async function detectAdapter(contractAddress, chainId = 1) {
  const results = await Promise.all(
    ADAPTERS.map(async (a) => {
      if (a.chains.length && !a.chains.includes(parseInt(chainId))) return false;
      try { return await a.detect(contractAddress, chainId); } catch { return false; }
    })
  );
  for (let i = 0; i < ADAPTERS.length; i++) {
    if (results[i]) {
      logger.info(`[AdapterRegistry] ${contractAddress.slice(0,10)} → ${ADAPTERS[i].name}`);
      return ADAPTERS[i];
    }
  }
  return genericAdapter;
}

async function getProofForWallet(contractAddress, walletAddress, chainId = 1) {
  const adapter = await detectAdapter(contractAddress, chainId);
  try { return { ...(await adapter.getProof(contractAddress, walletAddress, chainId)), adapter: adapter.id }; }
  catch (e) { return { proof: [], sig: null, adapter: adapter.id, error: e.message }; }
}

module.exports = { ADAPTERS, detectAdapter, getProofForWallet };

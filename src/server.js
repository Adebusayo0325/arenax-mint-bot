require('dotenv').config();
const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const { ethers } = require('ethers');
const { getWallets, addWallet, removeWallet, getWalletSigner, setWalletLabel, setWalletSpendLimit } = require('./core/walletManager');
const { mintFromAllWallets, checkWalletEligibility, detectTokenStandard } = require('./core/mintEngine');
const { isSeaDropContract, getSeaDropPhase } = require('./core/seaDropEngine');
const { watchMempoolForMintEnable } = require('./core/mempoolWatcher');
const { watchContractEvents, getActiveWatchers } = require('./core/eventWatcher');
const { detectAdapter } = require('./core/adapterRegistry');
const activeMempoolWatchers = new Map(); // contractAddress → { stop }
const { validateProofMap } = require('./core/proofValidator');
const { detectMintPhase } = require('./core/phaseDetector');
const { fundWallets, getMasterBalance, drainWallet, autoBalanceWallets } = require('./core/fundingManager');
const { scheduleAllWallets, cancelSchedule, getActiveSchedules, loadScheduleResults } = require('./core/scheduler');
const { getWalletNFTs, getListingCount, listNFT, listAtFloor, sweepNFTs, getFloorPrice, getCollectionSlug } = require('./core/nftManager');
const { getGasParams } = require('./core/gasOracle');
const axios = require('axios');
const { getProvider } = require('./utils/rpcManager');
const { PORT, BOT_TOKEN, WEBAPP_API_TOKEN } = require('./config');
const config = require('./config');
const logger    = require('./utils/logger');
const { v4: uuidv4 } = require('uuid');

// ── MINT HISTORY STORE (in-memory, persisted to disk) ────────────────────────
const HISTORY_FILE = require('path').join(__dirname, '..', 'mint-history.json');
let mintHistory = [];
try {
  if (require('fs').existsSync(HISTORY_FILE)) {
    mintHistory = JSON.parse(require('fs').readFileSync(HISTORY_FILE, 'utf8'));
  }
} catch(e) { mintHistory = []; }

function saveMintHistory() {
  try { require('fs').writeFileSync(HISTORY_FILE, JSON.stringify(mintHistory.slice(-500), null, 2)); } catch(e) {}
}

function recordMintSession({ contractAddress, collectionName, collectionImage, chainId, results, dryRun }) {
  if (dryRun) return; // don't log dry-runs
  const successCount = results.filter(r => r.status === 'success').length;
  const failCount    = results.filter(r => r.status === 'failed').length;
  mintHistory.push({
    id:              uuidv4(),
    timestamp:       new Date().toISOString(),
    contractAddress,
    collectionName:  collectionName || contractAddress.slice(0, 10) + '...',
    collectionImage: collectionImage || null,
    chainId:         chainId || 1,
    successCount,
    failCount,
    totalCount:      results.length,
    results:         results.map(r => ({ wallet: r.walletAddress?.slice(0,10), status: r.status, txHash: r.txHash, error: r.error })),
  });
  saveMintHistory();
}

const app = express();

// Render (and most PaaS hosts) sit behind a reverse proxy that sets
// X-Forwarded-For. Without trust proxy, express-rate-limit throws
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and can't correctly identify
// per-IP request counts. '1' trusts exactly one hop (the platform's
// own proxy) — safe default for single-proxy PaaS deployments.
app.set('trust proxy', 1);
app.use(express.json());

// ── SERVE WEBAPP — inject token server-side so it's never in static files ────
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'webapp/index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  // Inject token as a runtime window variable before </head>
  // The static app.js reads window.__API_TOKEN__ — no hardcoded secrets in files.
  html = html.replace('</head>', `<script>window.__API_TOKEN__="${WEBAPP_API_TOKEN || ''}";</script>\n</head>`);
  res.send(html);
});
app.use(express.static(path.join(__dirname, 'webapp')));

// ── BOT ───────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  require('./bot/index');
}
if (process.env.NODE_ENV === 'production') {
  const bot = require('./bot/index');
  app.post(`/bot${BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

// ── API AUTH MIDDLEWARE ────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  const token = req.headers['x-api-token'];
  if (!WEBAPP_API_TOKEN || token !== WEBAPP_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── RATE LIMITING ────────────────────────────────────────────────────────────
// General API limit: 60 requests/min per IP
const rateLimit = require('express-rate-limit');
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down' },
}));

// Tighter limit on mint/schedule (gas-spending actions): 10/min per IP
const mintLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Mint rate limit exceeded — wait a minute' },
});
app.use('/api/mint', mintLimiter);
app.use('/api/schedule', mintLimiter);

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', chain: process.env.CHAIN_ID || 1, ts: Date.now() }));

// FIX: the webapp's "Smart Fund" calculator (calcSmartFund/estMintGas/
// estFundingGas in app.js) had no real gas endpoint to call at all — it used
// a hardcoded, frozen-at-write-time gwei table with zero connection to
// actual network conditions. This is the real endpoint it should call instead.
app.get('/api/gas', async (req, res) => {
  try {
    const chainId = parseInt(req.query.chainId || 1);
    const competitive = req.query.priorityGas === 'true';
    const params = await getGasParams(competitive ? 1.15 : 1.0, chainId, competitive);
    const gwei = params.maxFeePerGas
      ? Number(params.maxFeePerGas) / 1e9
      : Number(params.gasPrice) / 1e9;
    res.json({ chainId, gwei, maxFeePerGas: params.maxFeePerGas?.toString() || null, maxPriorityFeePerGas: params.maxPriorityFeePerGas?.toString() || null, gasPrice: params.gasPrice?.toString() || null, live: true });
  } catch (e) {
    res.status(500).json({ error: e.message, live: false });
  }
});

// ── KEEP-ALIVE: self-ping every 14 min to prevent Render free-tier sleep ──────
// This fixes net::ERR_CONNECTION_CLOSED in the Telegram mini-app.
if (process.env.RENDER_EXTERNAL_URL || process.env.WEBAPP_URL) {
  const pingUrl = (process.env.RENDER_EXTERNAL_URL || process.env.WEBAPP_URL).replace(/\/$/, '') + '/health';
  setInterval(() => {
    fetch(pingUrl).catch(() => {}); // silent — just keeps dyno awake
  }, 14 * 60 * 1000); // 14 minutes
  console.log('[keep-alive] Self-ping enabled →', pingUrl);
}


// ── WALLET ROUTES ─────────────────────────────────────────────────────────────
app.get('/api/wallets', async (req, res) => {
  try {
    const wallets = getWallets();
    res.json({ wallets: wallets.map(w => ({ address: w.address, label: w.label, spendLimit: w.spendLimit ?? null })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Returns each wallet's native balance on the given chain (parallel fetch)
app.get('/api/wallets/balances', async (req, res) => {
  try {
    const chainId = parseInt(req.query.chainId || 1);
    const provider = await getProvider(chainId);
    const wallets = getWallets();
    const balances = await Promise.all(wallets.map(async w => {
      try {
        const bal = await provider.getBalance(w.address);
        return { address: w.address, label: w.label, balance: ethers.formatEther(bal) };
      } catch (e) {
        return { address: w.address, label: w.label, balance: null, error: e.message };
      }
    }));
    res.json({ balances });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/wallets/add', (req, res) => {
  try {
    const { privateKey, label, spendLimit } = req.body;
    if (!privateKey) return res.status(400).json({ error: 'Private key required' });
    const limit = (spendLimit === undefined || spendLimit === null || spendLimit === '') ? null : parseFloat(spendLimit);
    const address = addWallet(privateKey, label || '', limit);
    res.json({ address, spendLimit: limit });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/wallets/:address', (req, res) => {
  try { removeWallet(req.params.address); res.json({ success: true }); }
  catch(e) { res.status(400).json({ error: e.message }); }
});

// v18: Rename wallet label
app.patch('/api/wallets/:address/label', (req, res) => {
  try {
    const { label } = req.body;
    if (!label && label !== '') return res.status(400).json({ error: 'label required' });
    setWalletLabel(req.params.address, label);
    res.json({ success: true, label });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// v18: Set per-wallet spend limit
app.patch('/api/wallets/:address/spend-limit', (req, res) => {
  try {
    const { limitEth } = req.body;
    setWalletSpendLimit(req.params.address, limitEth === undefined ? null : limitEth);
    res.json({ success: true, limitEth: limitEth ?? null });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ── BALANCE ───────────────────────────────────────────────────────────────────
app.get('/api/balance', async (req, res) => {
  try { res.json(await getMasterBalance(parseInt(req.query.chainId || 1))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/master', async (req, res) => {
  try { res.json(await getMasterBalance(parseInt(req.query.chainId || 1))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mint', async (req, res) => {
  try {
    const {
      contractAddress, quantity, mintPrice, customFn, gweiOverride, parallel, chainId,
      merkleProof, proofMap, eip712Sigs, proofMode, dryRun, walletAddresses, walletFilter,
      useFlashbots, useLaunchpadProof, merkleApiUrl, tokenId, priorityGas,
    } = req.body;
    if (!contractAddress || !/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) return res.status(400).json({ error: 'Invalid contract address' });
    if (!quantity || quantity < 1 || quantity > 100) return res.status(400).json({ error: 'Quantity must be 1–100' });
    if (mintPrice === undefined || mintPrice < 0) return res.status(400).json({ error: 'Invalid mint price' });

    let wallets = getWallets();
    const filterList = walletFilter || walletAddresses;
    if (Array.isArray(filterList) && filterList.length) {
      const selected = new Set(filterList.map(a => a.toLowerCase()));
      wallets = wallets.filter(w => selected.has(w.address.toLowerCase()));
    }
    if (!wallets.length) return res.status(400).json({ error: 'No wallets loaded' });

    // Build per-wallet spend limits from wallet objects
    const spendLimits = {};
    wallets.forEach(w => { if (w.spendLimit != null) spendLimits[w.address] = w.spendLimit; });

    const results = await mintFromAllWallets({
      wallets, contractAddress, quantity, mintPrice,
      customFn: customFn || null,
      gweiOverride: gweiOverride || null,
      parallel: parallel !== false,
      chainId: parseInt(chainId || 1),
      merkleProof: Array.isArray(merkleProof) ? merkleProof : [],
      proofMap: proofMap || null,
      eip712Sigs: eip712Sigs || null,
      proofMode: proofMode || 'none',
      useFlashbots: useFlashbots === true,
      useLaunchpadProof: useLaunchpadProof === true,
      spendLimits,
      tokenId: tokenId || null,
      merkleApiUrl: merkleApiUrl || null,
      dryRun: dryRun === true,
      priorityGas: priorityGas === true,
    });

    // v9: Record mint session to history (fetch collection metadata for chart display)
    let collectionName = null, collectionImage = null;
    try {
      const slug = await getCollectionSlug(contractAddress, chainId || 1).catch(() => null);
      if (slug && config.OPENSEA_API_KEY) {
        const meta = await axios.get(`https://api.opensea.io/api/v2/collections/${slug}`, {
          headers: { 'x-api-key': config.OPENSEA_API_KEY }, timeout: 8000,
        }).catch(() => null);
        if (meta?.data) {
          collectionName  = meta.data.name || slug;
          collectionImage = meta.data.image_url || meta.data.banner_image_url || null;
        }
      }
    } catch(e) { /* metadata fetch is best-effort */ }
    recordMintSession({ contractAddress, collectionName, collectionImage, chainId: chainId || 1, results, dryRun });

    // Discord alert for webapp-triggered mints
    if (!dryRun) {
      try {
        const { notifyMintResult } = require('./utils/discord');
        const ok = results.filter(r => r.status === 'success').length;
        notifyMintResult({ contractAddress, chainId: chainId||1, results, source:'webapp', success:ok, failed:results.length-ok }).catch(()=>{});
      } catch {}
    }

    res.json({ results });
  } catch(e) {
    logger.error(`Mint error: ${e.message}`);
    res.status(500).json({ error: e.message, results: [] });
  }
});

// ── SCHEDULE ──────────────────────────────────────────────────────────────────
app.post('/api/schedule', async (req, res) => {
  try {
    const {
      contractAddress, mintTime, quantity, mintPrice, customFn, gweiOverride,
      timeoutSeconds, chainId, dryRun, merkleProof, merkleApiUrl,
      walletFilter, walletAddresses,
      triggerMode, phaseCheckIntervalMs,
      gasEscalatePercent, proofMode, eip712Sigs, useLaunchpadProof, useFlashbots,
      priorityGas,
    } = req.body;
    if (!contractAddress || !/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) return res.status(400).json({ error: 'Invalid contract address' });

    const mode = triggerMode || 'time'; // 'time' | 'phase' | 'both'
    const waitForPhase = mode === 'phase' || mode === 'both';

    // FIX (v26): same 3s grace window as scheduler.js — a mintTime of
    // "right now" is valid and should fire immediately, not get rejected
    // for being a few hundred ms stale by the time the request lands.
    if (mode !== 'phase') {
      if (!mintTime) return res.status(400).json({ error: 'Set a mint time, or switch to Phase-poll mode' });
      const targetMs = new Date(mintTime).getTime();
      if (isNaN(targetMs)) return res.status(400).json({ error: 'Invalid mint time format' });
      if (targetMs < Date.now() - 3000) return res.status(400).json({ error: 'Mint time is in the past — set a future time or use Phase-poll mode' });
    }

    // Prevent duplicate schedules for same contract+time (the 6-copy bug)
    if (mintTime) {
      const dupe = getActiveSchedules().find(s =>
        s.contractAddress?.toLowerCase() === contractAddress.toLowerCase() &&
        s.mintTime === mintTime
      );
      if (dupe) return res.status(409).json({
        error: `Already scheduled for this contract at ${mintTime} (ID: ${dupe.id}). Cancel it first.`,
        existingId: dupe.id,
      });
    }

    const scheduleId = uuidv4();
    const filterList = walletFilter || walletAddresses || null;

    // FIX (v26): this is the actual root cause of the screenshot bug.
    // The route used to call scheduleAllWallets(...) WITHOUT await and
    // WITHOUT .catch(), then immediately respond with a fake "Scheduled ✅".
    // Any throw inside (e.g. the "past time" check, or any RPC/wallet error)
    // became a silent unhandled promise rejection — invisible to the user,
    // invisible in the Active Schedules list, and the webapp had already
    // told them it worked. Now we await it. The HTTP response still returns
    // immediately (we don't make the user's browser wait for the whole mint
    // to finish) via a fire-and-forget pattern, but errors are now CAUGHT
    // and logged loudly, and — critically — scheduler.js itself now cleans
    // up its own state on failure (see scheduleAllWallets wrapper), so a
    // crashed schedule no longer leaves a ghost entry stuck at "0s" forever.
    res.json({ scheduleId, message: 'Scheduled' });

    scheduleAllWallets({
      scheduleId, contractAddress,
      mintTime: mode === 'phase' ? null : mintTime,
      quantity, mintPrice,
      customFn: customFn || null, gweiOverride: gweiOverride || null,
      chainId: chainId || 1,
      timeoutMs: (timeoutSeconds || 60) * 1000,
      dryRun: dryRun === true,
      merkleProof: Array.isArray(merkleProof) ? merkleProof : [],
      walletFilter: Array.isArray(filterList) && filterList.length ? filterList : null,
      waitForPhase,
      phaseCheckIntervalMs: phaseCheckIntervalMs || 5000,
      gasEscalatePercent: gasEscalatePercent || 10,
      proofMode: proofMode || 'none',
      eip712Sigs: eip712Sigs || null,
      useLaunchpadProof: useLaunchpadProof === true,
      merkleApiUrl: merkleApiUrl || null,
      useFlashbots: useFlashbots === true,
      priorityGas: priorityGas === true,
      onCountdown: () => {}, onStart: () => logger.info(`Schedule ${scheduleId} firing`),
      onWalletUpdate: () => {},
      onComplete: (results) => logger.info(`Schedule ${scheduleId} done: ${JSON.stringify(results)}`),
    }).catch(err => {
      // This is the catch that was completely missing before. The schedule
      // already cleaned up its own state (schedules{} + schedule-results.json)
      // inside scheduler.js's wrapper — this just makes sure it's loud in
      // the server logs too, so it shows up in Render's log viewer.
      logger.error(`Schedule ${scheduleId} failed: ${err.message}`);
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/schedules',       (req, res) => res.json({ schedules: getActiveSchedules() }));
app.get('/api/schedules/results', (req, res) => res.json({ results: loadScheduleResults().reverse() }));
app.delete('/api/schedules/:id',(req, res) => res.json({ cancelled: cancelSchedule(req.params.id) }));

// ── Chain auto-detect: checks which chain(s) a contract address is deployed on ──
// Tries all chains in parallel with public RPCs; returns matches.
app.get('/api/detect-chain', async (req, res) => {
  const { contract } = req.query;
  if (!contract || !/^0x[a-fA-F0-9]{40}$/.test(contract)) return res.status(400).json({ error: 'Invalid contract address' });
  const { CHAINS } = require('./utils/chainConfig');
  const { getProvider } = require('./utils/rpcManager');
  const results = await Promise.allSettled(
    Object.keys(CHAINS).map(async cid => {
      const chainId = parseInt(cid);
      const provider = await getProvider(chainId);
      const code = await Promise.race([
        provider.getCode(contract),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      return { chainId, name: CHAINS[chainId].name, hasCode: code && code !== '0x' };
    })
  );
  const found = results
    .filter(r => r.status === 'fulfilled' && r.value.hasCode)
    .map(r => ({ chainId: r.value.chainId, name: r.value.name }));
  res.json({ contract, chains: found });
});

// v35: Phase detection endpoint — OpenSea → SeaDrop → fingerprint → standard
app.get('/api/phase', async (req, res) => {
  try {
    const { contract, chainId } = req.query;
    const cid = parseInt(chainId || 1);
    if (!contract || !/^0x[a-fA-F0-9]{40}$/.test(contract)) return res.status(400).json({ error: 'Invalid contract address' });

    const [phase, standard] = await Promise.all([
      detectMintPhase(contract, [], cid),
      detectTokenStandard(contract, cid),
    ]);

    let mintFunctions = phase.mintFunctions || [];
    let launchpad = 'unknown';
    try { const { detectLaunchpad } = require('./core/launchpadProofs'); launchpad = await detectLaunchpad(contract, cid); } catch {}

    // 1. OpenSea 2026 Drops API check (primary mints) + Seaport fallback
    let openSea = null;
    if (process.env.OPENSEA_API_KEY) {
      try {
        const { getOpenSeaPhase } = require('./core/openSeaEngine');
        openSea = await getOpenSeaPhase(contract, cid);
        if (openSea?.phase === 'PUBLIC') {
          phase.phase = 'PUBLIC'; phase.confidence = 'verified';
          const method = openSea.method === 'drops_api' ? 'OpenSea Drops 2026' : 'OpenSea Seaport';
          const extra = openSea.stageName ? ` [${openSea.stageName}]` : openSea.ordersAvailable ? ` (${openSea.ordersAvailable} orders)` : '';
          phase.reason = `${method}${extra} — price: ${openSea.mintPrice||'free'} ETH`;
          if (openSea.mintPrice) phase.mintPrice = openSea.mintPrice;
          if (openSea.maxPerWallet) phase.maxPerWallet = openSea.maxPerWallet;
        }
      } catch(e) { logger.warn(`[OpenSea] ${e.message.slice(0,60)}`); }
    }

    // 2. SeaDrop check (direct mintPublic via SeaDrop dropper)
    let seaDrop = null;
    if (phase.phase === 'UNKNOWN' || phase.phase === 'unknown') {
      try {
        const { isSeaDropContract, getSeaDropPhase } = require('./core/seaDropEngine');
        if (await isSeaDropContract(contract, cid)) {
          seaDrop = await getSeaDropPhase(contract, cid);
          if (seaDrop && !seaDrop.error && seaDrop.phase !== 'NOT_CONFIGURED') {
            phase.phase = seaDrop.phase; phase.confidence = 'verified';
            phase.reason = `SeaDrop: price=${seaDrop.mintPrice} ETH, maxPerWallet=${seaDrop.maxPerWallet}`;
          }
        }
      } catch {}
    }

    // 3. Bytecode fingerprint — works on unverified contracts
    let fingerprint = null;
    try {
      const { fingerprintContract } = require('./core/contractFingerprint');
      fingerprint = await fingerprintContract(contract, cid);
      if (fingerprint.functions.length > 0) {
        const existing = new Set(mintFunctions);
        fingerprint.functions.forEach(f => existing.add(f.name));
        mintFunctions = Array.from(existing);
      }
    } catch {}

    res.json({ phase, standard, mintFunctions, launchpad, openSea, seaDrop, fingerprint, detectedChainId: cid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// v18: Eligibility check for all wallets
app.get('/api/eligibility', async (req, res) => {
  try {
    const { contract, chainId } = req.query;
    if (!contract) return res.status(400).json({ error: 'contract required' });
    const wallets = getWallets();
    const results = await Promise.all(wallets.map(async w => {
      const check = await checkWalletEligibility(contract, w.address, parseInt(chainId || 1)).catch(e => ({ eligible: null, reason: e.message }));
      return { address: w.address, label: w.label, ...check };
    }));
    res.json({ results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FUND / DRAIN ──────────────────────────────────────────────────────────────
app.post('/api/fund', async (req, res) => {
  try {
    // Accept both amountEthEach (new) and amountEth (old UI compat), same for wallet param
    const amount = req.body.amountEthEach || req.body.amountEth;
    const chainId = req.body.chainId;
    const walletParam = req.body.walletAddresses || req.body.walletFilter;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount — enter a positive ETH value' });
    let wallets = getWallets();
    if (Array.isArray(walletParam) && walletParam.length) {
      const set = new Set(walletParam.map(a => a.toLowerCase()));
      wallets = wallets.filter(w => set.has(w.address.toLowerCase()));
    }
    if (!wallets.length) return res.status(400).json({ error: 'No matching wallets selected' });
    res.json({ results: await fundWallets(wallets.map(w => w.address), parseFloat(amount), parseInt(chainId || 1)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/drain', async (req, res) => {
  try {
    const { chainId, walletAddresses } = req.body;
    let wallets = getWallets();
    if (Array.isArray(walletAddresses) && walletAddresses.length) {
      const set = new Set(walletAddresses.map(a => a.toLowerCase()));
      wallets = wallets.filter(w => set.has(w.address.toLowerCase()));
    }
    if (!wallets.length) return res.status(400).json({ error: 'No matching wallets selected' });
    const results = [];
    for (const w of wallets) results.push(await drainWallet(w.address, getWalletSigner, parseInt(chainId || 1)).catch(e => ({ address: w.address, status: 'failed', error: e.message })));
    res.json({ results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── NFT ROUTES ────────────────────────────────────────────────────────────────
app.get('/api/nfts', async (req, res) => {
  try {
    const { walletAddress, chainId, contractAddress } = req.query;
    if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' });
    const nfts = await getWalletNFTs(walletAddress, parseInt(chainId || 1), contractAddress || null);
    res.json({ nfts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/nfts/all', async (req, res) => {
  try {
    const chainId = parseInt(req.query.chainId || 1);
    const contractFilter = req.query.contract || null; // v19: filter by contract
    // Wallet filter: comma-separated addresses. Omit entirely to keep the
    // old "show everything" behavior — this is purely additive.
    const walletFilter = req.query.wallets
      ? new Set(String(req.query.wallets).split(',').map(a => a.trim().toLowerCase()).filter(Boolean))
      : null;
    let wallets = getWallets();
    if (walletFilter) wallets = wallets.filter(w => walletFilter.has(w.address.toLowerCase()));
    let all = [];
    const errors = [];
    for (const w of wallets) {
      try {
        // v19: pass wallet label so UI can show "W1", "Hot", etc instead of raw address
        const nfts = await getWalletNFTs(w.address, chainId, contractFilter, w.label || '');
        nfts.forEach(n => {
          n.wallet = w.address;
          n.walletLabel = w.label || w.address.slice(0,6);
        });
        all = all.concat(nfts);
      } catch (err) {
        logger.warn(`NFT fetch failed for ${w.address}: ${err.message}`);
        errors.push({ wallet: w.address, walletLabel: w.label || '', error: err.message });
      }
    }
    res.json({ nfts: all, count: all.length, errors });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/nfts/listed', async (req, res) => {
  try {
    const chainId = parseInt(req.query.chainId || 1);
    const wallets = getWallets();
    const results = [];
    for (const w of wallets) {
      const data = await getListingCount(w.address, chainId).catch(() => ({ count: 0, listings: [] }));
      results.push({ wallet: w.address, ...data });
    }
    const totalCount = results.reduce((s, r) => s + r.count, 0);
    res.json({ totalCount, wallets: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/nfts/floor', async (req, res) => {
  try {
    const { slug, chainId } = req.query;
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const floor = await getFloorPrice(slug, parseInt(chainId || 1));
    res.json({ floor });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nfts/list', async (req, res) => {
  try {
    const { walletAddress, contractAddress, tokenId, priceEth, chainId, durationDays } = req.body;
    if (!walletAddress || !contractAddress || !tokenId || !priceEth) return res.status(400).json({ error: 'Missing required fields' });
    const result = await listNFT({ walletAddress, contractAddress, tokenId, priceEth, chainId: parseInt(chainId || 1), durationDays: durationDays || 30 });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nfts/list-floor', async (req, res) => {
  try {
    const { walletAddress, contractAddress, tokenId, chainId } = req.body;
    if (!walletAddress || !contractAddress || !tokenId) return res.status(400).json({ error: 'Missing fields' });
    const result = await listAtFloor({ walletAddress, contractAddress, tokenId, chainId: parseInt(chainId || 1) });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nfts/sweep', async (req, res) => {
  try {
    const { walletAddress, walletAddresses, contractAddress, slug, quantity, maxPriceEthEach, maxPriceEth, chainId } = req.body;
    // frontend sends slug field (may be contract address or slug string)
    let resolvedContract = contractAddress;
    if (!resolvedContract && slug) {
      if (/^0x[a-fA-F0-9]{40}$/.test(slug)) resolvedContract = slug;
      else return res.status(400).json({ error: 'Sweep needs a contract address (0x...), not a collection slug.' });
    }
    const maxPrice = maxPriceEthEach || maxPriceEth;
    const addrs = Array.isArray(walletAddresses) && walletAddresses.length
      ? walletAddresses
      : (walletAddress ? [walletAddress] : []);
    if (!addrs.length || !resolvedContract || !quantity || !maxPrice) return res.status(400).json({ error: 'Missing fields: need walletAddress, contractAddress, quantity, maxPriceEth' });

    // FIX: each selected wallet runs its OWN independent sweep of `quantity`
    // NFTs (not split between them) — pick the wallet(s) you want to spend
    // from, the bot buys `quantity` floor NFTs from each.
    let results = [];
    for (const addr of addrs) {
      try {
        const r = await sweepNFTs({ walletAddress: addr, contractAddress, quantity, maxPriceEthEach, chainId: parseInt(chainId || 1) });
        results = results.concat((r || []).map(x => ({ ...x, wallet: addr })));
      } catch (e) {
        results.push({ wallet: addr, status: 'failed', error: e.message });
      }
    }
    res.json({ results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MASTER WALLET ─────────────────────────────────────────────────────────────
// SECURITY HARDENING: web-based master-key changes are disabled.
// WEBAPP_API_TOKEN (the only thing that gated this) is injected into every
// visitor's page source (see the '/' route above) — anyone who loads the
// URL gets it. That made this endpoint a real attack surface on the single
// most sensitive secret in the system: submit any private key over HTTP,
// server holds it in memory, uses it for real fund operations from then on.
// Master key changes now require Telegram (real per-user ALLOWED_USER_ID
// gating, not a shared token — see bot/index.js) or Render's dashboard
// directly, both of which need something stronger than this token.
app.post('/api/master/set', (req, res) => {
  res.status(403).json({
    error: 'Web-based master key changes are disabled for security. Use the Telegram bot (properly authenticated per-user) or update MASTER_PRIVATE_KEY directly in Render → Environment.',
  });
});

// ── AUTO-BALANCE ─────────────────────────────────────────────────────────────
app.post('/api/wallets/auto-balance', async (req, res) => {
  try {
    const { minEth = 0.005, targetEth = 0.02, chainId = 1 } = req.body;
    const wallets = getWallets();
    if (!wallets.length) return res.status(400).json({ error: 'No wallets loaded' });
    const results = await autoBalanceWallets(wallets.map(w => w.address), minEth, targetEth, parseInt(chainId));
    res.json({ results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MINT HISTORY ROUTES ──────────────────────────────────────────────────────
app.get('/api/mint-history', (req, res) => {
  const data = mintHistory.slice(-200);
  res.json({ sessions: data, history: data }); // both keys: inline script reads .sessions, app.js (currently unused) reads .history
});

app.delete('/api/mint-history', (req, res) => {
  mintHistory = [];
  saveMintHistory();
  res.json({ ok: true });
});

// ── STATUS ───────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    version:        'v10',
    discordWebhook: !!process.env.DISCORD_WEBHOOK_URL,
    allowedUserId:  !!process.env.ALLOWED_USER_ID,
    openSeaKey:     !!process.env.OPENSEA_API_KEY,
    wallets:        getWallets().length,
  });
});

// ── KEEP ALIVE ────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production' && process.env.RENDER_URL) {
  require('./utils/keepAlive').keepAlive(process.env.RENDER_URL);
}



// ── Event watcher API ─────────────────────────────────────────────────────
app.post('/api/events/watch', async (req, res) => {
  const { contract, chainId = 1 } = req.body;
  if (!contract) return res.status(400).json({ error: 'contract required' });
  const w = await watchContractEvents(contract, parseInt(chainId), {
    onMintEnabled: (e) => logger.info(`[Event] Mint enabled: ${e.event?.name}`),
    onSoldOut:     (e) => logger.info(`[Event] Sold out burst: ${e.transferCount} txs`),
  });
  res.json(w ? { status: 'watching', contract } : { status: 'unavailable', note: 'Provider connected but no WS events — RPC may not support event subscriptions' });
});

app.get('/api/events/watchers', (req, res) => {
  res.json({ watchers: getActiveWatchers() });
});

// ── Adapter detect API ──────────────────────────────────────────────────────
app.get('/api/adapter', async (req, res) => {
  const { contract, chainId = 1 } = req.query;
  if (!contract) return res.status(400).json({ error: 'contract required' });
  try {
    const adapter = await detectAdapter(contract, parseInt(chainId));
    res.json({ adapterId: adapter.id, adapterName: adapter.name, mintFn: adapter.mintFn, routeTo: adapter.routeTo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Mempool watch API ──────────────────────────────────────────────────────
app.post('/api/mempool/watch', async (req, res) => {
  const { contract, chainId = 1 } = req.body;
  if (!contract) return res.status(400).json({ error: 'contract required' });
  if (activeMempoolWatchers.has(contract)) {
    return res.json({ status: 'already watching', contract });
  }
  const watcher = await watchMempoolForMintEnable(contract, (event) => {
    logger.info(`[Mempool API] Mint-enable tx: ${event.txHash}`);
    // Future: trigger scheduled mint immediately
  }, parseInt(chainId));
  if (watcher) {
    activeMempoolWatchers.set(contract, watcher);
    res.json({ status: 'watching', contract, note: 'Will fire when owner enables mint' });
  } else {
    res.json({ status: 'unavailable', note: 'Set ALCHEMY_WS_RPC=wss://... in Render env' });
  }
});

app.post('/api/mempool/stop', async (req, res) => {
  const { contract } = req.body;
  const w = activeMempoolWatchers.get(contract);
  if (w) { w.stop(); activeMempoolWatchers.delete(contract); }
  res.json({ status: 'stopped', contract });
});

// ── v19 ROUTE ALIASES (backward compat for old UI) ────────────────────────────
// /api/list, /api/sweep, /api/schedule-results — old names in the HTML
app.post('/api/list',            (req,res,next) => { req.url='/api/nfts/list';       return app._router.handle(req,res,next); });
app.post('/api/sweep',           (req,res,next) => { req.url='/api/nfts/sweep';      return app._router.handle(req,res,next); });
app.get('/api/schedule-results', (req,res,next) => { req.url='/api/schedules/results'; return app._router.handle(req,res,next); });
// POST /api/master (HTML sent to this; canonical is /api/master/set)
// SECURITY HARDENING: disabled — see /api/master/set above for why.
app.post('/api/master', (req, res) => {
  res.status(403).json({
    error: 'Web-based master key changes are disabled for security. Use the Telegram bot (properly authenticated per-user) or update MASTER_PRIVATE_KEY directly in Render → Environment.',
  });
});

// POST /api/collect — alias for /api/drain (drains all wallets → master)
app.post('/api/collect', async (req, res) => {
  try {
    const { chainId } = req.body;
    const wallets = getWallets();
    if (!wallets.length) return res.status(400).json({ error: 'No wallets loaded' });
    const results = [];
    for (const w of wallets) {
      results.push(await drainWallet(w.address, getWalletSigner, parseInt(chainId || 1)).catch(e => ({ address: w.address, status: 'failed', error: e.message })));
    }
    res.json({ results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auto-balance — alias for /api/wallets/auto-balance
app.post('/api/auto-balance', async (req, res) => {
  try {
    const { minEth = 0.005, targetEth = 0.02, chainId = 1 } = req.body;
    const wallets = getWallets();
    if (!wallets.length) return res.status(400).json({ error: 'No wallets loaded' });
    const results = await autoBalanceWallets(wallets.map(w => w.address), minEth, targetEth, parseInt(chainId));
    res.json({ results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ── END ALIASES ───────────────────────────────────────────────────────────────

app.listen(PORT, () => logger.info(`Hermès Bot running on :${PORT}`));
module.exports = app;

const { getWallets, addWallet, removeWallet, getWalletSigner, setWalletLabel, setWalletSpendLimit } = require('../core/walletManager');
const {
  mintFromAllWallets, mintViaFlashbots,
  detectTokenStandard, checkWalletEligibility,
} = require('../core/mintEngine');
const { detectMintPhase } = require('../core/phaseDetector');
const { speedUpTx, cancelTx, checkTxStatus, getPendingTxs, getAllPendingTxs } = require('../core/txManager');
const { parseAndStoreProofs, getProofForWallet, getProofSummary, clearProofs } = require('../core/perWalletProof');
const { fundWallets, getMasterBalance, drainWallet, autoBalanceWallets } = require('../core/fundingManager');
const { scheduleAllWallets, cancelSchedule, getActiveSchedules, batchSchedule } = require('../core/scheduler');
const { getWalletNFTs, getListingCount, listNFT, listAtFloor, sweepNFTs, getFloorPrice, getCollectionSlug, findOwnerWallet } = require('../core/nftManager');
const { fetchProofsForAllWallets } = require('../core/launchpadProofs');
const { getProvider } = require('../utils/rpcManager');
const { getChain, getChainEmoji } = require('../utils/chainConfig');
const { ethers } = require('ethers');
const keyboards = require('./keyboard');
const logger = require('../utils/logger');
const { notifyMintResult, notifyScheduleCountdown } = require('../utils/discord');
const config = require('../config');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ── SESSION STORE ─────────────────────────────────────────────────────────────
const SESSION_FILE = path.join(__dirname, '../../sessions.json');
function loadSessions() {
  try { if (fs.existsSync(SESSION_FILE)) return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch(e) {}
  return {};
}
function saveSessions(s) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(s), 'utf8'); } catch(e) {}
}
let sessions = loadSessions();

// ── KNOWN CONTRACTS ───────────────────────────────────────────────────────────
const KNOWN_CONTRACTS_FILE = path.join(__dirname, '../../known-contracts.json');
function loadKnownContracts() {
  try { if (fs.existsSync(KNOWN_CONTRACTS_FILE)) return new Set(JSON.parse(fs.readFileSync(KNOWN_CONTRACTS_FILE, 'utf8'))); } catch(e) {}
  return new Set();
}
function saveKnownContracts(set) {
  try { fs.writeFileSync(KNOWN_CONTRACTS_FILE, JSON.stringify([...set]), 'utf8'); } catch(e) {} 
}
let knownContracts = loadKnownContracts();
function markContractKnown(address) { knownContracts.add(address.toLowerCase()); saveKnownContracts(knownContracts); }
function isKnownContract(address) { return knownContracts.has(address.toLowerCase()); }

function getSession(userId) {
  if (!sessions[userId]) sessions[userId] = { step: null, data: {}, chainId: config.DEFAULT_CHAIN_ID };
  if (!sessions[userId].chainId) sessions[userId].chainId = config.DEFAULT_CHAIN_ID;
  return sessions[userId];
}
function clearSession(userId) {
  const chainId = sessions[userId]?.chainId || config.DEFAULT_CHAIN_ID;
  sessions[userId] = { step: null, data: {}, chainId };
  saveSessions(sessions);
}
function saveSession() { saveSessions(sessions); }

// ── HELPERS ───────────────────────────────────────────────────────────────────
function formatCountdown(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function chainLabel(chainId) {
  const c = getChain(chainId);
  return `${getChainEmoji(chainId)} ${c.name}`;
}
function phaseEmoji(phase) {
  if (phase === 'public') return '✅';
  if (phase === 'whitelist') return '🔒';
  if (phase === 'paused') return '⏸';
  if (phase === 'closed') return '❌';
  return '❓';
}
function proofModeLabel(mode, proofMap, merkleProof) {
  if (mode === 'none') return 'none (public mint)';
  if (mode === 'auto') return 'auto (on-chain eligibility check)';
  if (mode === 'map' || (proofMap && Object.keys(proofMap).length > 0)) return `per-wallet JSON (${proofMap ? Object.keys(proofMap).length : 0} wallets)`;
  if (mode === 'single' || (merkleProof && merkleProof.length > 0)) return `single proof (${merkleProof ? merkleProof.length : 0} leaves)`;
  return 'none';
}

// ── PHASE DETECTION ON CONTRACT ENTRY ────────────────────────────────────────
async function detectContractInfo(contractAddress, chainId) {
  try {
    const [phase, standard] = await Promise.all([
      detectMintPhase(contractAddress, [], chainId),
      detectTokenStandard(contractAddress, chainId),
    ]);
    return { phase, standard };
  } catch (e) {
    return {
      phase: { phase: 'unknown', confidence: 'heuristic', isActive: null, reason: `Detection failed: ${e.message.slice(0, 80)}` },
      standard: 'ERC721',
    };
  }
}

// ── START ─────────────────────────────────────────────────────────────────────
async function handleStart(bot, msg) {
  const { id, first_name } = msg.from;
  const session = getSession(id);
  await bot.sendMessage(id,
    `⚜️ *HERMÈS BOT* — Welcome, ${first_name}\n\n` +
    `🔗 Chain: *${chainLabel(session.chainId)}*\n\n` +
    `Multi-chain NFT mint engine. Auto-phase detection, per-wallet eligibility routing, gas escalation, launchpad auto-proof.`,
    { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu }
  );
}

// ── MAIN CALLBACK ROUTER ──────────────────────────────────────────────────────
async function handleCallback(bot, query) {
  const userId = query.from.id;
  let data     = query.data;
  const session = getSession(userId);

  try { await bot.answerCallbackQuery(query.id); } catch(e) {
    if (e.message?.includes('query is too old') || e.message?.includes('ETELEGRAM')) return;
  }

  // ── NAVIGATION ──
  if (data === 'menu_main') return bot.sendMessage(userId, `📋 Main Menu\n🔗 Chain: *${chainLabel(session.chainId)}*`, { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
  // v19: price guard update
  if (data.startsWith('price_update_')) {
    const newPrice = parseFloat(data.replace('price_update_', ''));
    if (!isNaN(newPrice)) {
      session.data.mintPrice = newPrice; saveSession();
      return bot.sendMessage(userId, `✅ Price updated to *${newPrice} ETH*. Confirming mint...\n\nTap confirm again to fire.`, { parse_mode: 'Markdown', reply_markup: keyboards.confirmMenu('mint') });
    }
  }
  if (data === 'confirm_mint_force') {
    // Proceed with declared price despite guard warning — fall through to confirm_mint logic
    data = 'confirm_mint';
  }
  if (data === 'menu_cancel') { clearSession(userId); return bot.sendMessage(userId, '❌ Cancelled.', { reply_markup: keyboards.mainMenu }); }

  // ── CHAIN ──
  if (data === 'menu_chain') {
    return bot.sendMessage(userId, `🔗 *Select Chain*\n\nCurrent: *${chainLabel(session.chainId)}*`, { parse_mode: 'Markdown', reply_markup: keyboards.chainMenu });
  }
  if (data.startsWith('chain_')) {
    const chainId = parseInt(data.replace('chain_', ''));
    session.chainId = chainId; saveSession();
    return bot.sendMessage(userId, `✅ Switched to *${chainLabel(chainId)}*\n\n⚠️ Set \`CHAIN_${chainId}_RPC\` in .env for best performance.`, { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
  }

  // ── WALLETS ──
  if (data === 'menu_wallets') {
    const wallets = getWallets();
    if (!wallets.length) { session.step = 'awaiting_privkey'; saveSession(); return bot.sendMessage(userId, '👛 No wallets yet.\n\nSend a private key to add one:', { reply_markup: keyboards.cancelMenu }); }
    return bot.sendMessage(userId, `👛 *Your Wallets* (${wallets.length})`, { parse_mode: 'Markdown', reply_markup: keyboards.walletsMenu(wallets) });
  }
  if (data === 'wallet_add') { session.step = 'awaiting_privkey'; saveSession(); return bot.sendMessage(userId, '🔑 Send the *private key* to add.\n\n⚠️ It will be auto-deleted.', { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }); }
  if (data.startsWith('wallet_info_')) {
    const address = data.replace('wallet_info_', '');
    const wallets = getWallets();
    const w = wallets.find(w => w.address === address);
    try {
      const provider = await getProvider(session.chainId);
      const balance = await provider.getBalance(address);
      return bot.sendMessage(userId,
        `👛 *Wallet Info*\n\n` +
        `📍 \`${address}\`\n` +
        `🏷 Label: *${w?.label || 'Unnamed'}*\n` +
        `💰 Balance: *${ethers.formatEther(balance)} ${getChain(session.chainId).symbol}*\n` +
        `🚦 Spend limit: *${w?.spendLimit != null ? w.spendLimit + ' ETH' : 'Unlimited'}*`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: '✏️ Rename', callback_data: `wallet_rename_${address}` }, { text: '🚦 Set Spend Limit', callback_data: `wallet_limit_${address}` }],
          [{ text: '🗑 Remove', callback_data: `wallet_remove_${address}` }],
          [{ text: '🔙 Back', callback_data: 'menu_wallets' }],
        ]}}
      );
    } catch(e) { return bot.sendMessage(userId, `❌ ${e.message}`, { reply_markup: keyboards.backMenu }); }
  }
  // v18: Wallet rename
  if (data.startsWith('wallet_rename_')) {
    const address = data.replace('wallet_rename_', '');
    session.step = 'awaiting_wallet_rename'; session.data.renameAddress = address; saveSession();
    return bot.sendMessage(userId, `✏️ *Rename Wallet*\n\n\`${address.slice(0, 8)}...\`\n\nSend new label (e.g. "Hot1" or "Sniper2"):`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }
  // v18: Wallet spend limit
  if (data.startsWith('wallet_limit_')) {
    const address = data.replace('wallet_limit_', '');
    session.step = 'awaiting_spend_limit'; session.data.limitAddress = address; saveSession();
    return bot.sendMessage(userId, `🚦 *Set Spend Limit*\n\n\`${address.slice(0, 8)}...\`\n\nMax ETH this wallet may spend per mint run?\ne.g. \`0.05\` or \`none\` to remove limit:`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }
  if (data.startsWith('wallet_remove_')) {
    const address = data.replace('wallet_remove_', '');
    session.step = 'confirm_remove'; session.data.removeAddress = address; saveSession();
    return bot.sendMessage(userId, `⚠️ Remove wallet \`${address.slice(0, 8)}...\`?`, { parse_mode: 'Markdown', reply_markup: keyboards.confirmMenu('remove_wallet') });
  }
  if (data === 'confirm_remove_wallet') { removeWallet(session.data.removeAddress); clearSession(userId); return bot.sendMessage(userId, '✅ Wallet removed.', { reply_markup: keyboards.mainMenu }); }

  // ── BALANCE ──
  if (data === 'menu_balance') {
    try {
      const { address, balance } = await getMasterBalance(session.chainId);
      return bot.sendMessage(userId, `🏦 *Master Wallet* (${chainLabel(session.chainId)})\n\n📍 \`${address}\`\n💰 Balance: *${balance} ${getChain(session.chainId).symbol}*`, { parse_mode: 'Markdown', reply_markup: keyboards.backMenu });
    } catch(e) { return bot.sendMessage(userId, `❌ ${e.message}`, { reply_markup: keyboards.backMenu }); }
  }

  // ── FUND ──
  if (data === 'menu_fund') {
    const wallets = getWallets();
    if (!wallets.length) return bot.sendMessage(userId, '⚠️ No wallets. Add wallets first.', { reply_markup: keyboards.mainMenu });
    session.step = 'awaiting_fund_amount'; saveSession();
    return bot.sendMessage(userId, `💰 *Fund Wallets*\n\n${wallets.length} wallet(s).\n\nETH per wallet? e.g. \`0.05\``, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }

  // ── MINT ──
  if (data === 'menu_mint') {
    if (!getWallets().length) return bot.sendMessage(userId, '⚠️ No wallets. Add wallets first.', { reply_markup: keyboards.mainMenu });
    session.step = 'awaiting_contract'; session.data = {}; saveSession();
    return bot.sendMessage(userId,
      `⚜️ *Mint NFT*\n🔗 Chain: *${chainLabel(session.chainId)}*\n\nStep 1 — Contract address:`,
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
    );
  }

  // ── PROOF MODE (inline button selection) ──
  if (data === 'proof_none') {
    session.data.proofMode = 'none'; session.data.merkleProof = []; session.data.proofMap = null;
    return _advanceToNextMintStep(bot, userId, session);
  }
  if (data === 'proof_auto') {
    session.data.proofMode = 'auto'; session.data.merkleProof = []; session.data.proofMap = null;
    return _advanceToNextMintStep(bot, userId, session);
  }
  if (data === 'proof_json') {
    session.data.proofMode = 'awaiting_json'; saveSession();
    return bot.sendMessage(userId,
      `📋 *Per-Wallet Proof JSON*\n\nPaste a JSON object mapping wallet address → proof array:\n\n` +
      `\`\`\`\n{"0xAddr1":["0xabc...","0xdef..."],"0xAddr2":["0x..."]}\n\`\`\`\n\n` +
      `Keys can be any case — matched case-insensitively.`,
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
    );
  }
  if (data === 'proof_single') {
    session.data.proofMode = 'awaiting_single'; saveSession();
    return bot.sendMessage(userId,
      `🔑 *Single Proof for All Wallets*\n\nPaste comma-separated 0x hex values:\n\`0xabc...,0xdef...,0x123...\``,
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
    );
  }


  // ── v17: EIP-712 Signature mode ──
  if (data === 'proof_eip712') {
    session.data.proofMode = 'eip712'; saveSession();
    return bot.sendMessage(userId,
      `✗️ *EIP-712 Signature Mint*\n\n` +
      `Paste a JSON map of wallet -> off-chain signature:\n\n` +
      `\`{"0xWallet1":"0xSig1","0xWallet2":"0xSig2"}\`\n\n` +
      `ℹ️ *How to get signatures:*\n` +
      `1. Open mint site in Chrome DevTools -> Network -> XHR\n` +
      `2. Connect each wallet, look for requests with "signature" in response\n` +
      `3. Copy the sig value for each wallet`,
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
    );
  }
  // ── v17: Flashbots mode ──
  if (data === 'proof_flashbots') {
    if (!process.env.FLASHBOTS_AUTH_KEY) {
      return bot.sendMessage(userId,
        `🔒 *Flashbots Setup Required*\n\n` +
        `FLASHBOTS_AUTH_KEY not set in .env\n\n` +
        `*Setup:*\n` +
        `1. Generate any ETH wallet -- its private key is your auth key\n` +
        `2. Add to .env: \`FLASHBOTS_AUTH_KEY=0x<privkey>\`\n` +
        `3. Run: \`npm install @flashbots/ethers-provider-bundle\`\n` +
        `4. Restart and try again`,
        { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
      );
    }
    session.data.proofMode = 'flashbots'; session.data.useFlashbots = true; saveSession();
    return _advanceToNextMintStep(bot, userId, session);
  }
  // ── v17: Check Phase ──
  if (data === 'menu_check_phase') {
    session.step = 'awaiting_phase_contract'; saveSession();
    return bot.sendMessage(userId,
      `🔍 *Check Mint Phase*\n\nEnter contract address to probe phase, price, max per wallet, merkle root:`,
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
    );
  }
  // ── v17: Eligibility ──
  if (data === 'menu_eligibility') {
    session.step = 'awaiting_elig_contract'; saveSession();
    return bot.sendMessage(userId, `✅ *Check Eligibility*\n\nEnter contract address to check all wallets:`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }
  // ── v17: Load Proofs ──
  if (data === 'menu_load_proofs') {
    const summary = getProofSummary();
    return bot.sendMessage(userId,
      `🔐 *Merkle Proof Manager*\n\n` +
      (summary ? `*Loaded:*\n${summary}\n\n` : `No proofs loaded.\n\n`) +
      `Paste JSON map or line format:\n` +
      `\`{"0xWallet":["0xleaf1","0xleaf2"]}\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '🗑 Clear All Proofs', callback_data: 'proofs_clear' }],
        [{ text: '🔙 Back', callback_data: 'menu_main' }],
      ]}}
    );
  }
  if (data === 'proofs_clear') { clearProofs(); return bot.sendMessage(userId, '✅ All proofs cleared.', { reply_markup: keyboards.mainMenu }); }

  // ── v18: Launchpad auto-proof ──
  if (data === 'proof_launchpad') {
    session.data.proofMode = 'launchpad'; session.data.useLaunchpadProof = true;
    return _advanceToNextMintStep(bot, userId, session);
  }
  if (data === 'sched_proof_launchpad') {
    session.data.proofMode = 'launchpad'; session.data.useLaunchpadProof = true;
    return _advanceToScheduleConfirm(bot, userId, session);
  }

  // ── v18: Batch schedule ──
  if (data === 'menu_batch_schedule') {
    session.step = 'batch_awaiting_contracts'; session.data = { batchContracts: [] }; saveSession();
    return bot.sendMessage(userId,
      `📦 *Batch Schedule — Multi-Contract*\n\n` +
      `Queue multiple contracts in one session. Each fires at its own time.\n\n` +
      `Step 1 — Send first contract address:`,
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
    );
  }
  // ── v17: TX Manager ──
  if (data === 'menu_tx_manager') {
    return bot.sendMessage(userId,
      `⛽ *TX Manager*\n\n` +
      `\`/speedup <txHash>\` -- bump gas +15% RBF\n` +
      `\`/cancel_tx <txHash>\` -- cancel stuck tx\n` +
      `\`/txstatus <txHash>\` -- check confirmed/pending/failed`,
      { parse_mode: 'Markdown', reply_markup: keyboards.backMenu }
    );
  }
  // ── v17: Schedule EIP-712 / Flashbots proof modes ──
  if (data === 'sched_proof_eip712') {
    session.data.proofMode = 'eip712'; saveSession();
    return bot.sendMessage(userId, `✗️ EIP-712 for schedule -- paste JSON map wallet->sig:`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }
  if (data === 'sched_proof_flashbots') {
    if (!process.env.FLASHBOTS_AUTH_KEY) return bot.sendMessage(userId, '❌ FLASHBOTS_AUTH_KEY not set. See .env setup.', { reply_markup: keyboards.cancelMenu });
    session.data.proofMode = 'flashbots'; session.data.useFlashbots = true; saveSession();
    return _advanceToScheduleConfirm(bot, userId, session);
  }
  // ── v17: Schedule trigger modes ──
  if (data === 'sched_trigger_time') {
    session.data.waitForPhase = false; session.step = 'awaiting_schedule_time'; saveSession();
    return bot.sendMessage(userId, `⏰ *When to fire?*\n\n\u2022 Send *seconds from now* (e.g. \`30\` = fire in 30s) \u2014 easiest\n\u2022 Or send ISO time: \`2026-06-20T15:00:00Z\``, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }
  if (data === 'sched_trigger_phase') {
    session.data.waitForPhase = true; session.data.mintTime = null; saveSession();
    return bot.sendMessage(userId, `🔍 Phase polling -- will fire when contract opens. Choose proof mode:`, { parse_mode: 'Markdown', reply_markup: keyboards.scheduleProofModeMenu });
  }
  if (data === 'sched_trigger_both') {
    session.data.waitForPhase = true; session.step = 'awaiting_schedule_time'; saveSession();
    return bot.sendMessage(userId, `🔀 Wait until time then phase poll. Enter time (ISO):`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }

  // ── SCHEDULE ──
  if (data === 'menu_schedule') {
    if (!getWallets().length) return bot.sendMessage(userId, '⚠️ No wallets.', { reply_markup: keyboards.mainMenu });
    session.step = 'awaiting_schedule_contract'; session.data = {}; saveSession();
    return bot.sendMessage(userId, `⏰ *Schedule Mint*\n🔗 Chain: *${chainLabel(session.chainId)}*\n\nStep 1 — Contract address:`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }

  // ── SCHEDULE PROOF MODE ──
  if (data === 'sched_proof_none') {
    session.data.proofMode = 'none'; session.data.merkleProof = []; session.data.proofMap = null;
    return _advanceToScheduleConfirm(bot, userId, session);
  }
  if (data === 'sched_proof_auto') {
    session.data.proofMode = 'auto'; session.data.merkleProof = []; session.data.proofMap = null;
    return _advanceToScheduleConfirm(bot, userId, session);
  }
  if (data === 'sched_proof_json') {
    session.data.proofMode = 'sched_awaiting_json'; saveSession();
    return bot.sendMessage(userId, `📋 Per-wallet proof JSON:\n\`{"0xAddr1":["0xproof"],"0xAddr2":["0xproof"]}\``, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }
  if (data === 'sched_proof_single') {
    session.data.proofMode = 'sched_awaiting_single'; saveSession();
    return bot.sendMessage(userId, `🔑 Single proof (all wallets) — comma-separated 0x values:`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }

  // ── ACTIVE SCHEDULES ──
  if (data === 'menu_schedules') {
    const active = getActiveSchedules();
    if (!active.length) return bot.sendMessage(userId, '📅 No active schedules.', { reply_markup: keyboards.backMenu });
    const list = active.map(s => `🔹 \`${s.id.slice(0,8)}\` | ${chainLabel(s.chainId || 1)}\n📄 \`${s.contractAddress.slice(0,10)}...\` ⏰ ${s.mintTime}`).join('\n\n');
    return bot.sendMessage(userId, `📅 *Active Schedules*\n\n${list}\n\nTo cancel: \`/cancel ID\``, { parse_mode: 'Markdown', reply_markup: keyboards.backMenu });
  }

  // ── PENDING TXS (gas manager) ──
  if (data === 'menu_pending') {
    const pending = getAllPendingTxs();
    const entries = Object.entries(pending);
    if (!entries.length) return bot.sendMessage(userId, '✅ No pending transactions tracked.', { reply_markup: keyboards.backMenu });
    const list = entries.slice(0, 10).map(([hash, info]) => {
      const age = Math.round((Date.now() - info.timestamp) / 1000);
      return `🔹 \`${hash.slice(0, 10)}...\`\n👛 ${info.walletAddress.slice(0, 8)}... | nonce ${info.nonce} | ${age}s ago`;
    }).join('\n\n');
    return bot.sendMessage(userId,
      `⚡ *Pending Transactions* (${entries.length})\n\n${list}\n\nTap a tx to speed up or cancel:`,
      { parse_mode: 'Markdown', reply_markup: keyboards.pendingTxMenu(pending) }
    );
  }
  if (data.startsWith('pending_info_')) {
    const txHash = data.replace('pending_info_', '');
    const info = getAllPendingTxs()[txHash];
    if (!info) return bot.sendMessage(userId, '❌ TX no longer tracked (confirmed or already replaced).', { reply_markup: keyboards.backMenu });
    const age = Math.round((Date.now() - info.timestamp) / 1000);
    return bot.sendMessage(userId,
      `⚡ *Pending TX*\n\n🔗 \`${txHash}\`\n👛 \`${info.walletAddress}\`\n⛓ Chain: ${chainLabel(info.chainId)}\n🔢 Nonce: ${info.nonce}\n⏱ Age: ${age}s\n\nAction:`,
      { parse_mode: 'Markdown', reply_markup: keyboards.pendingTxActionMenu(txHash) }
    );
  }
  if (data.startsWith('speedup_')) {
    const txHash = data.replace('speedup_', '');
    const info = getAllPendingTxs()[txHash];
    if (!info) return bot.sendMessage(userId, '❌ TX not found — may have been confirmed already.', { reply_markup: keyboards.mainMenu });
    await bot.sendMessage(userId, `⚡ Speeding up \`${txHash.slice(0, 10)}...\` at 1.4× gas...`, { parse_mode: 'Markdown' });
    try {
      const result = await speedUpTx(info.walletAddress, txHash, info.chainId, 1.4);
      const chain = getChain(info.chainId);
      return bot.sendMessage(userId,
        `✅ *Speed Up Sent*\n\n🆕 New TX: \`${result.newTxHash}\`\n🔗 [View](${chain.explorer}/tx/${result.newTxHash})\nNonce: ${result.nonce}`,
        { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu }
      );
    } catch(e) { return bot.sendMessage(userId, `❌ Speed up failed: ${e.message}`, { reply_markup: keyboards.mainMenu }); }
  }
  if (data.startsWith('canceltx_')) {
    const txHash = data.replace('canceltx_', '');
    const info = getAllPendingTxs()[txHash];
    if (!info) return bot.sendMessage(userId, '❌ TX not found — may have been confirmed already.', { reply_markup: keyboards.mainMenu });
    session.step = 'confirm_cancel_tx'; session.data.cancelTxHash = txHash; session.data.cancelTxInfo = info; saveSession();
    return bot.sendMessage(userId, `🚫 Cancel \`${txHash.slice(0, 10)}...\`?\n\nThis sends a 0 ETH self-transfer at nonce ${info.nonce} to replace the stuck tx.`, { parse_mode: 'Markdown', reply_markup: keyboards.confirmMenu('cancel_tx') });
  }
  if (data === 'confirm_cancel_tx') {
    const { cancelTxHash, cancelTxInfo } = session.data;
    clearSession(userId);
    await bot.sendMessage(userId, `🚫 Cancelling \`${cancelTxHash.slice(0, 10)}...\`...`, { parse_mode: 'Markdown' });
    try {
      const result = await cancelTx(cancelTxInfo.walletAddress, cancelTxHash, cancelTxInfo.chainId);
      const chain = getChain(cancelTxInfo.chainId);
      return bot.sendMessage(userId,
        `✅ *Cancel TX Sent*\n\n🔗 Cancel TX: \`${result.cancelTxHash}\`\n[View](${chain.explorer}/tx/${result.cancelTxHash})\nNonce: ${result.nonce}`,
        { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu }
      );
    } catch(e) { return bot.sendMessage(userId, `❌ Cancel failed: ${e.message}`, { reply_markup: keyboards.mainMenu }); }
  }

  // ── DRAIN ──
  if (data === 'menu_drain') {
    const wallets = getWallets();
    if (!wallets.length) return bot.sendMessage(userId, '⚠️ No wallets.', { reply_markup: keyboards.mainMenu });
    session.step = 'confirm_drain'; saveSession();
    return bot.sendMessage(userId, `💸 *Withdraw All*\n\nSend ETH from ${wallets.length} wallet(s) back to master. Confirm?`, { parse_mode: 'Markdown', reply_markup: keyboards.confirmMenu('drain') });
  }
  if (data === 'confirm_drain') {
    const wallets = getWallets();
    await bot.sendMessage(userId, `💸 Withdrawing ${wallets.length} wallet(s)...`);
    const results = [];
    for (const w of wallets) results.push(await drainWallet(w.address, getWalletSigner, session.chainId).catch(e => ({ address: w.address, status: 'failed', error: e.message })));
    const summary = results.map(r => `${r.status === 'drained' ? '✅' : '❌'} ${r.address.slice(0,6)}...${r.address.slice(-4)} → ${r.status}`).join('\n');
    clearSession(userId);
    return bot.sendMessage(userId, `✅ *Withdrawal Done*\n\n${summary}`, { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
  }

  // ── NFT PORTFOLIO ──
  if (data === 'menu_nft') return bot.sendMessage(userId, `🎨 *NFT Portfolio*\n🔗 ${chainLabel(session.chainId)}`, { parse_mode: 'Markdown', reply_markup: keyboards.nftMenu });
  if (data === 'nft_list') {
    await bot.sendMessage(userId, '⏳ Loading NFTs...');
    try {
      const wallets = getWallets();
      if (!wallets.length) return bot.sendMessage(userId, '⚠️ No wallets loaded.', { reply_markup: keyboards.backMenu });
      let all = [], lastError = null;
      for (const w of wallets) {
        try { const nfts = await getWalletNFTs(w.address, session.chainId); nfts.forEach(n => { n.wallet = w.address; }); all = all.concat(nfts); } catch (err) { lastError = err.message; }
      }
      if (!all.length) return bot.sendMessage(userId, `📭 No NFTs found.${lastError ? `\n\n⚠️ ${lastError}` : ''}`, { reply_markup: keyboards.nftMenu });
      const lines = all.slice(0, 20).map(n => `• ${n.name} | \`${n.contract.slice(0,8)}...\` #${n.tokenId}\n  📍 ${n.wallet.slice(0,8)}...`).join('\n\n');
      return bot.sendMessage(userId, `🎨 *Your NFTs* (${all.length})\n🔗 ${chainLabel(session.chainId)}\n\n${lines}`, { parse_mode: 'Markdown', reply_markup: keyboards.nftMenu });
    } catch(e) { return bot.sendMessage(userId, `❌ ${e.message}`, { reply_markup: keyboards.nftMenu }); }
  }
  if (data === 'nft_listed_count') {
    await bot.sendMessage(userId, '⏳ Checking listed NFTs...');
    try {
      const wallets = getWallets(); let totalCount = 0; const lines = [];
      for (const w of wallets) {
        const { count, listings } = await getListingCount(w.address, session.chainId);
        totalCount += count;
        if (count > 0) lines.push(`• ${w.address.slice(0,8)}... — *${count}* listed\n${listings.slice(0,3).map(l => `  📄 #${l.tokenId} @ ${parseFloat(l.price).toFixed(4)} ETH`).join('\n')}`);
      }
      return bot.sendMessage(userId, `📊 *Listed NFTs*\n🔗 ${chainLabel(session.chainId)}\n\n*Total: ${totalCount}*\n\n${lines.join('\n\n') || 'No listings found.'}`, { parse_mode: 'Markdown', reply_markup: keyboards.nftMenu });
    } catch(e) { return bot.sendMessage(userId, `❌ ${e.message}`, { reply_markup: keyboards.nftMenu }); }
  }
  if (data === 'nft_list_sale') { session.step = 'nft_awaiting_contract'; session.data = { nftAction: 'list_sale' }; saveSession(); return bot.sendMessage(userId, `💰 *List NFT*\n\nStep 1/3 — Contract address:`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }); }
  if (data === 'nft_list_floor') { session.step = 'nft_awaiting_contract'; session.data = { nftAction: 'list_floor' }; saveSession(); return bot.sendMessage(userId, `📈 *List at Floor*\n\nStep 1/2 — Contract address:`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }); }
  if (data === 'nft_sweep') { session.step = 'nft_sweep_contract'; session.data = {}; saveSession(); return bot.sendMessage(userId, `🧹 *Sweep NFTs*\n\nStep 1/3 — Collection contract:`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }); }

  // ── LOGS ──
  if (data === 'menu_logs') {
    const logFile = path.join(__dirname, '../../logs/bot.log');
    if (!fs.existsSync(logFile)) return bot.sendMessage(userId, '📋 No logs yet.', { reply_markup: keyboards.backMenu });
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-20).join('\n');
    return bot.sendMessage(userId, `📋 *Last 20 Logs*\n\n\`\`\`\n${lines}\n\`\`\``, { parse_mode: 'Markdown', reply_markup: keyboards.backMenu });
  }

  // ── CONFIRM HANDLERS ──
  if (data === 'confirm_mint_now')  return handleConfirmMint(bot, query);
  if (data === 'confirm_schedule')  return handleConfirmSchedule(bot, query);
  if (data === 'confirm_fund')      return handleConfirmFund(bot, query);
  if (data === 'confirm_nft_list')  return handleConfirmNFTList(bot, query);
  if (data === 'confirm_nft_floor') return handleConfirmNFTFloor(bot, query);
  if (data === 'confirm_nft_sweep') return handleConfirmNFTSweep(bot, query);
}

// ── PROOF MODE MENU FOR SCHEDULE ──────────────────────────────────────────────
function scheduleProofModeMenu() {
  return {
    inline_keyboard: [
      [{ text: '🔓 None (public mint)', callback_data: 'sched_proof_none' }],
      [{ text: '🤖 Auto (on-chain eligibility check)', callback_data: 'sched_proof_auto' }],
      [{ text: '📋 Per-wallet JSON map', callback_data: 'sched_proof_json' }],
      [{ text: '🔑 Single proof for all wallets', callback_data: 'sched_proof_single' }],
      [{ text: '❌ Cancel', callback_data: 'menu_cancel' }],
    ],
  };
}

// ── ADVANCE HELPERS ───────────────────────────────────────────────────────────
async function _advanceToNextMintStep(bot, userId, session) {
  session.step = 'awaiting_dry_run'; saveSession();
  return bot.sendMessage(userId,
    `✅ Proof mode: *${proofModeLabel(session.data.proofMode, session.data.proofMap, session.data.merkleProof)}*\n\n` +
    `Last step — Dry run?\n\n\`yes\` — simulate only, no tx\n\`no\` — fire real transactions`,
    { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
  );
}

async function _advanceToScheduleConfirm(bot, userId, session) {
  const wallets = getWallets();
  const delay = Math.round((new Date(session.data.mintTime) - Date.now()) / 1000);
  session.step = 'confirm_schedule'; saveSession();
  return bot.sendMessage(userId,
    `⏰ *Confirm Schedule*\n\n` +
    `🔗 Chain: *${chainLabel(session.chainId)}*\n` +
    `📄 Contract: \`${session.data.contractAddress}\`\n` +
    `🕐 Time: *${session.data.mintTime}*\n` +
    `⏳ In: *${formatCountdown(delay)}*\n` +
    `🔢 Qty: *${session.data.quantity}*/wallet\n` +
    `💰 Price: *${session.data.mintPrice} ETH*\n` +
    `🔐 Proof: *${proofModeLabel(session.data.proofMode, session.data.proofMap, session.data.merkleProof)}*\n` +
    `🔄 Retry: *${session.data.timeoutMs / 1000}s*\n` +
    `👛 Wallets: *${wallets.length}*\n\n` +
    `⚡ Phase detected at launch time automatically.`,
    { parse_mode: 'Markdown', reply_markup: keyboards.confirmMenu('schedule') }
  );
}

// ── MESSAGE HANDLER ───────────────────────────────────────────────────────────
async function handleMessage(bot, msg) {
  const userId = msg.from.id;
  const text   = msg.text?.trim();
  const session = getSession(userId);
  if (!text) return;

  // /cancel
  if (text.startsWith('/cancel')) {
    const id = text.split(' ')[1];
    if (id) {
      const ok = cancelSchedule(id);
      return bot.sendMessage(userId, ok ? `✅ Schedule \`${id}\` cancelled.` : '❌ Not found.', { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
    }
    return;
  }
  if (text.startsWith('/')) return;

  // ── ADD WALLET ──
  if (session.step === 'awaiting_privkey') {
    try {
      // v18: ask for label after key
      const address = addWallet(text);
      clearSession(userId);
      await bot.deleteMessage(userId, msg.message_id).catch(() => {});
      session.step = 'awaiting_wallet_label_new'; session.data.newWalletAddress = address; saveSession();
      return bot.sendMessage(userId,
        `✅ Wallet added!\n\n📍 \`${address}\`\n\nGive it a label? (e.g. "Hot1", "Sniper2")\nOr send \`skip\` to leave unnamed.`,
        { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
      );
    } catch(err) { return bot.sendMessage(userId, `❌ ${err.message}`, { reply_markup: keyboards.cancelMenu }); }
  }

  // v18: wallet label after adding
  if (session.step === 'awaiting_wallet_label_new') {
    const label = text.toLowerCase() === 'skip' ? '' : text.trim().slice(0, 20);
    try {
      if (label) setWalletLabel(session.data.newWalletAddress, label);
      clearSession(userId);
      return bot.sendMessage(userId, `✅ Wallet ready!\n🏷 Label: *${label || 'Unnamed'}*\n📍 \`${session.data.newWalletAddress}\``, { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
    } catch(e) { clearSession(userId); return bot.sendMessage(userId, '✅ Wallet added (label not set).', { reply_markup: keyboards.mainMenu }); }
  }

  // v18: rename wallet
  if (session.step === 'awaiting_wallet_rename') {
    const label = text.trim().slice(0, 20);
    try {
      setWalletLabel(session.data.renameAddress, label);
      clearSession(userId);
      return bot.sendMessage(userId, `✅ Renamed to *${label}*`, { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
    } catch(e) { return bot.sendMessage(userId, `❌ ${e.message}`, { reply_markup: keyboards.cancelMenu }); }
  }

  // v18: per-wallet spend limit
  if (session.step === 'awaiting_spend_limit') {
    const limitEth = text.toLowerCase() === 'none' ? null : parseFloat(text);
    if (text.toLowerCase() !== 'none' && (isNaN(limitEth) || limitEth <= 0)) {
      return bot.sendMessage(userId, '❌ Enter a valid ETH amount or `none` to remove limit.', { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
    }
    try {
      setWalletSpendLimit(session.data.limitAddress, limitEth);
      clearSession(userId);
      return bot.sendMessage(userId,
        `✅ Spend limit: *${limitEth === null ? 'Unlimited' : limitEth + ' ETH'}* for \`${session.data.limitAddress.slice(0, 8)}...\``,
        { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu }
      );
    } catch(e) { return bot.sendMessage(userId, `❌ ${e.message}`, { reply_markup: keyboards.cancelMenu }); }
  }

  // v18: batch schedule contract entry
  if (session.step === 'batch_awaiting_contracts') {
    if (text.toLowerCase() === 'done') {
      if (!session.data.batchContracts.length) {
        return bot.sendMessage(userId, '❌ Add at least one contract first.', { reply_markup: keyboards.cancelMenu });
      }
      session.step = 'batch_awaiting_qty'; saveSession();
      return bot.sendMessage(userId,
        `📦 *${session.data.batchContracts.length} contract(s) queued*\n\n${session.data.batchContracts.map((c,i) => `${i+1}. \`${c.address.slice(0,10)}...\` @ ${c.mintTime}`).join('\n')}\n\nQty per wallet for all contracts?`,
        { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
      );
    }
    const parts = text.split(/\s+/);
    if (!ethers.isAddress(parts[0])) return bot.sendMessage(userId, '❌ Invalid address. Send: `0xContract YYYY-MM-DDTHH:MM:SSZ` or `done` to finish.', { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
    const mintTime = parts[1] || null;
    if (mintTime && isNaN(new Date(mintTime))) return bot.sendMessage(userId, '❌ Invalid time. Format: `2026-06-20T15:00:00Z`', { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
    session.data.batchContracts.push({ address: parts[0], mintTime });
    saveSession();
    return bot.sendMessage(userId,
      `✅ Added contract ${session.data.batchContracts.length}.\n\nSend another \`0xContract time\` or \`done\` to configure.`,
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
    );
  }
  if (session.step === 'batch_awaiting_qty') {
    const qty = parseInt(text);
    if (isNaN(qty) || qty < 1) return bot.sendMessage(userId, '❌ Invalid qty.', { reply_markup: keyboards.cancelMenu });
    session.data.batchQty = qty; session.step = 'batch_awaiting_price'; saveSession();
    return bot.sendMessage(userId, `✅ Qty set.\n\nPrice per NFT (ETH)? Free → \`0\``, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }
  if (session.step === 'batch_awaiting_price') {
    const price = parseFloat(text);
    if (isNaN(price) || price < 0) return bot.sendMessage(userId, '❌ Invalid price.', { reply_markup: keyboards.cancelMenu });
    session.data.batchPrice = price;
    const total = session.data.batchContracts.length * price * session.data.batchQty * getWallets().length;
    clearSession(userId);
    // Fire the batch
    await bot.sendMessage(userId,
      `📦 *Batch Scheduling ${session.data?.batchContracts?.length || '?'} contracts...*\n\nEach will fire at its scheduled time.\nTotal max spend: ~${total.toFixed(4)} ETH`,
      { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu }
    );
    const jobs = (session.data.batchContracts || []).map(c => ({
      scheduleId: uuidv4(),
      contractAddress: c.address,
      mintTime: c.mintTime,
      quantity: session.data.batchQty,
      mintPrice: session.data.batchPrice,
      chainId: session.chainId,
      timeoutMs: 60000,
    }));
    batchSchedule(jobs, {
      onJobStart: (job, i) => bot.sendMessage(userId, `🔥 *Contract ${i+1}/${jobs.length} firing!*\n\`${job.contractAddress.slice(0, 10)}...\``, { parse_mode: 'Markdown' }),
      onJobDone: (job, i, results) => {
        const ok = results.filter(r => r.status === 'success').length;
        bot.sendMessage(userId, `✅ Contract ${i+1} done — ${ok}/${results.length} minted\n\`${job.contractAddress.slice(0, 10)}...\``, { parse_mode: 'Markdown' });
      },
    }).catch(e => bot.sendMessage(userId, `❌ Batch error: ${e.message.slice(0, 100)}`, { reply_markup: keyboards.mainMenu }));
    return;
  }

  // ── FUND FLOW ──
  if (session.step === 'awaiting_fund_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) return bot.sendMessage(userId, '❌ Invalid amount.', { reply_markup: keyboards.cancelMenu });
    session.data.fundAmount = amount; session.step = 'confirm_fund_msg'; saveSession();
    const w = getWallets();
    return bot.sendMessage(userId, `💰 *Confirm Funding*\n\n${w.length} wallets × ${amount} ETH\nTotal: *${(amount * w.length).toFixed(6)} ETH*`, { parse_mode: 'Markdown', reply_markup: keyboards.confirmMenu('fund') });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ── MINT FLOW ──
  // ────────────────────────────────────────────────────────────────────────────
  if (session.step === 'awaiting_contract') {
    if (!ethers.isAddress(text)) return bot.sendMessage(userId, '❌ Invalid address.', { reply_markup: keyboards.cancelMenu });
    session.data.contractAddress = text; saveSession();

    // Auto-detect phase and token standard in background
    await bot.sendMessage(userId, `⏳ Analysing contract...`);
    const { phase, standard } = await detectContractInfo(text, session.chainId);
    session.data.detectedPhase = phase;
    session.data.detectedStandard = standard;

    const isFirst = !isKnownContract(text);
    const firstNote = isFirst ? `\n\n⚠️ *First time minting this contract.* Dry run recommended.` : '';
    const confBadge = phase.confidence === 'heuristic' ? ' [⚠️ GUESS]' : phase.confidence === 'verified' ? ' [✓ verified]' : '';
    const phaseNote = `\n\n🎯 *Phase:* ${phaseEmoji(phase.phase)} ${phase.phase.toUpperCase()}${confBadge} — ${phase.reason}`;
    const stdNote = standard === 'ERC1155' ? `\n🏷 *Standard:* ERC-1155 detected` : '';

    // If ERC-1155, need token ID next
    if (standard === 'ERC1155') {
      session.step = 'awaiting_token_id'; saveSession();
      return bot.sendMessage(userId,
        `✅ Contract set.${phaseNote}${stdNote}${firstNote}\n\n` +
        `🏷 ERC-1155 detected — Token ID? (e.g. \`1\`)`,
        { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
      );
    }

    session.step = 'awaiting_quantity'; saveSession();
    return bot.sendMessage(userId,
      `✅ Contract set.${phaseNote}${firstNote}\n\nStep 2 — NFTs per wallet? e.g. \`2\``,
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
    );
  }

  if (session.step === 'awaiting_token_id') {
    const tokenId = parseInt(text);
    if (isNaN(tokenId) || tokenId < 0) return bot.sendMessage(userId, '❌ Invalid token ID.', { reply_markup: keyboards.cancelMenu });
    session.data.tokenId = tokenId; session.step = 'awaiting_quantity'; saveSession();
    return bot.sendMessage(userId, `✅ Token ID: ${tokenId}\n\nStep 3 — Quantity per wallet? e.g. \`2\``, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }

  if (session.step === 'awaiting_quantity') {
    const qty = parseInt(text);
    if (isNaN(qty) || qty < 1 || qty > 100) return bot.sendMessage(userId, '❌ Qty must be 1–100.', { reply_markup: keyboards.cancelMenu });
    session.data.quantity = qty; session.step = 'awaiting_mint_price'; saveSession();
    return bot.sendMessage(userId, `✅ Qty set.\n\nStep 3 — Mint price per NFT (ETH)?\nFree mint → \`0\``, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }

  if (session.step === 'awaiting_mint_price') {
    const price = parseFloat(text);
    if (isNaN(price) || price < 0) return bot.sendMessage(userId, '❌ Invalid price.', { reply_markup: keyboards.cancelMenu });
    session.data.mintPrice = price; session.step = 'awaiting_custom_fn'; saveSession();
    return bot.sendMessage(userId,
      `✅ Price set.\n\nStep 4 — Mint function name?\n\nCommon: \`mint\` \`publicMint\` \`claim\`\nSend \`auto\` to detect automatically`,
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
    );
  }

  if (session.step === 'awaiting_custom_fn') {
    session.data.customFn = text.toLowerCase() === 'auto' ? null : text;
    session.step = 'awaiting_gwei'; saveSession();
    return bot.sendMessage(userId,
      `✅ Function: ${session.data.customFn || 'auto-detect'}\n\nStep 5 — Gas priority tip override (Gwei)?\n\`auto\` or a number e.g. \`5\``,
      { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
    );
  }

  if (session.step === 'awaiting_gwei') {
    session.data.gweiOverride = text.toLowerCase() === 'auto' ? null : parseFloat(text);
    session.step = 'awaiting_proof_mode'; saveSession();

    const phase = session.data.detectedPhase;
    const phaseHint = phase
      ? `\n\n🎯 Phase: ${phaseEmoji(phase.phase)} *${phase.phase}* — ${phase.reason}`
      : '';
    const hint = phase?.phase === 'whitelist'
      ? `\n\n💡 WL phase detected — use *Auto* to check eligibility, or paste per-wallet proofs.`
      : phase?.phase === 'public'
      ? `\n\n💡 Public phase active — *None* is fine unless a custom allowlist is used.`
      : '';

    return bot.sendMessage(userId,
      `✅ Gas: ${session.data.gweiOverride ? session.data.gweiOverride + ' gwei' : 'auto'}${phaseHint}${hint}\n\nStep 6 — Whitelist / Proof mode:`,
      { parse_mode: 'Markdown', reply_markup: keyboards.proofModeMenu }
    );
  }

  // Proof mode: awaiting JSON map input
  if (session.step === 'awaiting_proof_mode' && (session.data.proofMode === 'awaiting_json')) {
    try {
      const raw = JSON.parse(text);
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Must be an object');
      // Validate values are arrays of 0x hex strings
      for (const [addr, proof] of Object.entries(raw)) {
        if (!Array.isArray(proof)) throw new Error(`${addr}: proof must be an array`);
        if (proof.some(p => !/^0x[0-9a-fA-F]{64}$/.test(p))) throw new Error(`${addr}: each proof element must be 0x + 64 hex chars`);
      }
      session.data.proofMap = raw;
      session.data.proofMode = 'map';
      return _advanceToNextMintStep(bot, userId, session);
    } catch(e) {
      return bot.sendMessage(userId,
        `❌ Invalid JSON: ${e.message}\n\nExpected: \`{"0xAddr":["0xproof1","0xproof2"],...}\``,
        { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }
      );
    }
  }

  // Proof mode: awaiting single proof for all wallets
  if (session.step === 'awaiting_proof_mode' && session.data.proofMode === 'awaiting_single') {
    const parts = text.split(/[,\s]+/).map(s => s.trim()).filter(s => /^0x[0-9a-fA-F]{64}$/.test(s));
    if (!parts.length) return bot.sendMessage(userId, '❌ Each element must be 0x-prefixed 32-byte hex.\nSend `none` to skip.', { reply_markup: keyboards.cancelMenu });
    session.data.merkleProof = parts;
    session.data.proofMode = 'single';
    return _advanceToNextMintStep(bot, userId, session);
  }

  if (session.step === 'awaiting_dry_run') {
    session.data.dryRun = text.toLowerCase() === 'yes';
    session.step = 'confirm_mint'; saveSession();
    const wallets = getWallets();
    const phase = session.data.detectedPhase;
    const phaseStr = phase ? `${phaseEmoji(phase.phase)} ${phase.phase} — ${phase.reason}` : '❓ unknown';
    return bot.sendMessage(userId,
      `🖼 *Confirm Mint*\n\n` +
      `🔗 Chain: *${chainLabel(session.chainId)}*\n` +
      `📄 Contract: \`${session.data.contractAddress}\`\n` +
      `🏷 Standard: *${session.data.detectedStandard || 'ERC721'}*\n` +
      (session.data.tokenId !== undefined ? `🔢 Token ID: *${session.data.tokenId}*\n` : '') +
      `🎯 Phase: *${phaseStr}*\n` +
      `🔢 Qty/wallet: *${session.data.quantity}*\n` +
      `💰 Price: *${session.data.mintPrice} ETH*\n` +
      `⚙️ Function: *${session.data.customFn || 'auto-detect'}*\n` +
      `⛽ Gas tip: *${session.data.gweiOverride ? session.data.gweiOverride + ' gwei' : 'auto'}*\n` +
      `🔐 Proof: *${proofModeLabel(session.data.proofMode, session.data.proofMap, session.data.merkleProof)}*\n` +
      `🧪 Dry run: *${session.data.dryRun ? 'YES — simulate only' : 'NO — live tx'}*\n` +
      `👛 Wallets: *${wallets.length}*\n\n` +
      `Total cost: *${(session.data.mintPrice * session.data.quantity * wallets.length).toFixed(6)} ETH*\n\nFire? 🔥`,
      { parse_mode: 'Markdown', reply_markup: keyboards.confirmMenu('mint_now') }
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ── SCHEDULE FLOW ──
  // ────────────────────────────────────────────────────────────────────────────
  if (session.step === 'awaiting_schedule_contract') {
    if (!ethers.isAddress(text)) return bot.sendMessage(userId, '❌ Invalid address.', { reply_markup: keyboards.cancelMenu });
    session.data.contractAddress = text; saveSession();
    await bot.sendMessage(userId, `⏳ Checking contract...`);
    const { phase, standard } = await detectContractInfo(text, session.chainId);
    session.data.detectedPhase = phase;
    session.data.detectedStandard = standard;

    const phaseNote = `\n\n🎯 *Phase right now:* ${phaseEmoji(phase.phase)} ${phase.phase} — ${phase.reason}\n_(Phase is re-checked at launch time — this is just a preview)_`;
    const stdNote = standard === 'ERC1155' ? `\n🏷 *Standard:* ERC-1155` : '';

    if (standard === 'ERC1155') {
      session.step = 'awaiting_schedule_token_id'; saveSession();
      return bot.sendMessage(userId, `✅ Contract set.${phaseNote}${stdNote}\n\nToken ID? e.g. \`1\``, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
    }
    session.step = 'awaiting_schedule_trigger'; saveSession();
    return bot.sendMessage(userId, `✅ Contract set.${phaseNote}\n\nHow should this schedule trigger?`, { parse_mode: 'Markdown', reply_markup: keyboards.scheduleTriggerMenu });
  }

  if (session.step === 'awaiting_schedule_token_id') {
    const tokenId = parseInt(text);
    if (isNaN(tokenId) || tokenId < 0) return bot.sendMessage(userId, '❌ Invalid token ID.', { reply_markup: keyboards.cancelMenu });
    session.data.tokenId = tokenId; session.step = 'awaiting_schedule_time'; saveSession();
    return bot.sendMessage(userId, `✅ Token ID: ${tokenId}\n\nMint time? Format: \`YYYY-MM-DD HH:MM:SS\``, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }

  if (session.step === 'awaiting_schedule_time') {
    const trimmed = text.trim();
    // Shorthand: plain integer = seconds from now (e.g. send "30" = fire in 30s)
    // This is the most critical UX for competitive minting — no ISO typing under pressure
    if (/^\d+$/.test(trimmed)) {
      const secs = parseInt(trimmed);
      if (secs < 1 || secs > 86400) return bot.sendMessage(userId, '\u274C Seconds must be 1\u201386400.', { reply_markup: keyboards.cancelMenu });
      const target = new Date(Date.now() + secs * 1000);
      session.data.mintTime = target.toISOString();
      session.step = 'awaiting_schedule_quantity'; saveSession();
      return bot.sendMessage(userId, `\u2705 Firing in *${secs}s* at \`${target.toISOString()}\`\n\nNFTs per wallet?`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
    }
    // Full ISO/datetime string
    const parsed = new Date(trimmed);
    if (isNaN(parsed) || parsed.getTime() < Date.now() - 3000) return bot.sendMessage(userId, '\u274C Invalid or past time. Send seconds from now (e.g. `30`) or ISO string.', { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
    session.data.mintTime = trimmed; session.step = 'awaiting_schedule_quantity'; saveSession();
    return bot.sendMessage(userId, `\u2705 Time: ${trimmed}\n\nNFTs per wallet?`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }

  if (session.step === 'awaiting_schedule_quantity') {
    const qty = parseInt(text);
    if (isNaN(qty) || qty < 1 || qty > 100) return bot.sendMessage(userId, '❌ Qty 1–100.', { reply_markup: keyboards.cancelMenu });
    session.data.quantity = qty; session.step = 'awaiting_schedule_price'; saveSession();
    return bot.sendMessage(userId, `✅ Qty set.\n\nPrice per NFT (ETH)? Free → \`0\``, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }

  if (session.step === 'awaiting_schedule_price') {
    const price = parseFloat(text);
    if (isNaN(price) || price < 0) return bot.sendMessage(userId, '❌ Invalid price.', { reply_markup: keyboards.cancelMenu });
    session.data.mintPrice = price; session.step = 'awaiting_schedule_timeout'; saveSession();
    return bot.sendMessage(userId, `✅ Price set.\n\nRetry timeout (seconds)? e.g. \`60\``, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }

  if (session.step === 'awaiting_schedule_timeout') {
    const t = parseInt(text);
    if (isNaN(t) || t < 10 || t > 300) return bot.sendMessage(userId, '❌ Timeout 10–300 seconds.', { reply_markup: keyboards.cancelMenu });
    session.data.timeoutMs = t * 1000;
    session.step = 'awaiting_schedule_proof'; saveSession();

    const phase = session.data.detectedPhase;
    const phaseHint = phase?.phase === 'whitelist'
      ? `\n\n💡 Currently in WL phase — use *Auto* for on-chain eligibility, or provide proofs.`
      : `\n\n💡 Phase will be re-detected at launch time automatically.`;

    return bot.sendMessage(userId,
      `✅ Timeout set.${phaseHint}\n\nProof mode for this schedule:`,
      { parse_mode: 'Markdown', reply_markup: keyboards.scheduleProofModeMenu }
    );
  }

  // Schedule proof JSON/single inline inputs
  if (session.data.proofMode === 'sched_awaiting_json') {
    try {
      const raw = JSON.parse(text);
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Must be an object');
      for (const [addr, proof] of Object.entries(raw)) {
        if (!Array.isArray(proof)) throw new Error(`${addr}: proof must be array`);
        if (proof.some(p => !/^0x[0-9a-fA-F]{64}$/.test(p))) throw new Error(`${addr}: invalid proof element`);
      }
      session.data.proofMap = raw;
      session.data.proofMode = 'map';
      return _advanceToScheduleConfirm(bot, userId, session);
    } catch(e) {
      return bot.sendMessage(userId, `❌ Invalid JSON: ${e.message}`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
    }
  }
  if (session.data.proofMode === 'sched_awaiting_single') {
    const parts = text.split(/[,\s]+/).map(s => s.trim()).filter(s => /^0x[0-9a-fA-F]{64}$/.test(s));
    if (!parts.length) return bot.sendMessage(userId, '❌ Invalid proof format.', { reply_markup: keyboards.cancelMenu });
    session.data.merkleProof = parts;
    session.data.proofMode = 'single';
    return _advanceToScheduleConfirm(bot, userId, session);
  }


  // ── v17: Phase contract check step ──
  if (session.step === 'awaiting_phase_contract') {
    if (!ethers.isAddress(text)) return bot.sendMessage(userId, '❌ Invalid address.', { reply_markup: keyboards.cancelMenu });
    await bot.sendMessage(userId, '⏳ Probing contract...');
    try {
      const { phase, standard } = await detectContractInfo(text, session.chainId);
      const wallets = getWallets();
      const priceStr = phase.mintPrice ? `• Mint price: *${phase.mintPrice} ETH*
` : '';
      const maxStr   = phase.maxPerWallet ? `• Max/wallet: *${phase.maxPerWallet}*
` : '';
      const supplyStr = (phase.totalSupply !== undefined && phase.maxSupply) ? `• Supply: *${phase.totalSupply}/${phase.maxSupply}*
` : '';
      const merkleStr = phase.hasMerkleRoot ? `• Merkle root: ✅ (WL proof required)
` : '';
      clearSession(userId);
      return bot.sendMessage(userId,
        `🔍 *Contract Info*

` +
        `📄 \`${text}\`
` +
        `🎯 Phase: ${phaseEmoji(phase.phase)} *${phase.phase.toUpperCase()}*
` +
        `ℹ️ ${phase.reason}
` +
        `🏷 Standard: *${standard}*
` +
        priceStr + maxStr + supplyStr + merkleStr,
        { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu }
      );
    } catch(e) { clearSession(userId); return bot.sendMessage(userId, `❌ ${e.message.slice(0,120)}`, { reply_markup: keyboards.mainMenu }); }
  }

  // ── v17: Eligibility check step ──
  if (session.step === 'awaiting_elig_contract') {
    if (!ethers.isAddress(text)) return bot.sendMessage(userId, '❌ Invalid address.', { reply_markup: keyboards.cancelMenu });
    await bot.sendMessage(userId, '⏳ Checking eligibility for all wallets...');
    const wallets = getWallets();
    const results = [];
    for (const w of wallets) {
      try {
        const { eligible, reason } = await checkWalletEligibility(text, w.address, session.chainId);
        const proof = getProofForWallet(w.address);
        results.push(`${eligible === true ? '✅' : eligible === false ? '❌' : '❓'} \`${w.address.slice(0,8)}...\` — ${reason}${proof.length ? ` 🔐 ${proof.length} leaves` : ''}`);
      } catch(e) { results.push(`❓ \`${w.address.slice(0,8)}...\` — Error: ${e.message.slice(0,40)}`); }
    }
    clearSession(userId);
    return bot.sendMessage(userId, `✅ *Eligibility Results*\n\n${results.join('\n')}`, { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
  }

  // ── v17: Load proofs (perWalletProof) via message ──
  if (session.step === 'awaiting_proof_mode' && session.data.proofMode === 'eip712') {
    try {
      const raw = JSON.parse(text);
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Must be JSON object');
      session.data.eip712Sigs = raw;
      return _advanceToNextMintStep(bot, userId, session);
    } catch(e) { return bot.sendMessage(userId, `❌ Invalid JSON: ${e.message}

Expected: \`{"0xWallet":"0xSig"}\``, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }); }
  }
  if (session.data.proofMode === 'sched_eip712') {
    try {
      const raw = JSON.parse(text);
      session.data.eip712Sigs = raw; session.data.proofMode = 'eip712';
      return _advanceToScheduleConfirm(bot, userId, session);
    } catch(e) { return bot.sendMessage(userId, `❌ Invalid JSON: ${e.message}`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu }); }
  }
  // Proof paste for load proofs menu
  if (!session.step || session.step === 'idle') {
    // Accept proof map paste at any time
    if (text.startsWith('{') || text.includes(':0x')) {
      try {
        const result = parseAndStoreProofs(text);
        return bot.sendMessage(userId,
          `🔐 *Proofs Loaded*

✅ ${result.parsed} wallet(s) stored${result.errors.length ? `
⚠️ ${result.errors.join(', ')}` : ''}`,
          { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu }
        );
      } catch(e) {}
    }
  }

  // ── NFT FLOWS ──
  if (session.step === 'nft_awaiting_contract') {
    if (!ethers.isAddress(text)) return bot.sendMessage(userId, '❌ Invalid address.', { reply_markup: keyboards.cancelMenu });
    session.data.nftContract = text; session.step = 'nft_awaiting_tokenid'; saveSession();
    return bot.sendMessage(userId, `✅ Contract set.\n\nStep 2${session.data.nftAction === 'list_floor' ? '/2' : '/3'} — Token ID?`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }
  if (session.step === 'nft_awaiting_tokenid') {
    session.data.tokenId = text;
    if (session.data.nftAction === 'list_floor') {
      session.step = 'confirm_nft_floor'; saveSession();
      await bot.sendMessage(userId, '⏳ Fetching floor price...');
      try {
        const slug = await getCollectionSlug(session.data.nftContract, session.chainId);
        const floor = await getFloorPrice(slug, session.chainId);
        session.data.collectionSlug = slug;
        if (!floor || floor === 0) {
          session.data.nftAction = 'list_manual'; session.step = 'nft_awaiting_price'; saveSession();
          return bot.sendMessage(userId, `⚠️ *No Floor Found*\n\nNo active listings yet — you set the floor!\n\nEnter your listing price (ETH):`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
        }
        return bot.sendMessage(userId, `📈 *List at Floor*\n\n📄 \`${session.data.nftContract}\`\n🔢 Token: #${text}\n💰 Floor: *${floor} ETH*\n\nList at floor?`, { parse_mode: 'Markdown', reply_markup: keyboards.confirmMenu('nft_floor') });
      } catch(e) { return bot.sendMessage(userId, `❌ ${e.message}`, { reply_markup: keyboards.cancelMenu }); }
    }
    session.step = 'nft_awaiting_price'; saveSession();
    return bot.sendMessage(userId, `✅ Token set.\n\nStep 3/3 — Listing price (ETH)?`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }
  if (session.step === 'nft_awaiting_price') {
    const price = parseFloat(text);
    if (isNaN(price) || price <= 0) return bot.sendMessage(userId, '❌ Invalid price.', { reply_markup: keyboards.cancelMenu });
    session.data.listPrice = price; session.step = 'confirm_nft_list'; saveSession();
    return bot.sendMessage(userId, `💰 *Confirm Listing*\n\n📄 \`${session.data.nftContract}\`\n🔢 Token #${session.data.tokenId}\n💰 *${price} ETH*`, { parse_mode: 'Markdown', reply_markup: keyboards.confirmMenu('nft_list') });
  }
  if (session.step === 'nft_sweep_contract') {
    if (!ethers.isAddress(text)) return bot.sendMessage(userId, '❌ Invalid address.', { reply_markup: keyboards.cancelMenu });
    session.data.sweepContract = text; session.step = 'nft_sweep_qty'; saveSession();
    return bot.sendMessage(userId, `✅ Contract set.\n\nStep 2/3 — How many to buy?`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }
  if (session.step === 'nft_sweep_qty') {
    const qty = parseInt(text);
    if (isNaN(qty) || qty < 1 || qty > 20) return bot.sendMessage(userId, '❌ Qty 1–20.', { reply_markup: keyboards.cancelMenu });
    session.data.sweepQty = qty; session.step = 'nft_sweep_price'; saveSession();
    return bot.sendMessage(userId, `✅ Qty set.\n\nStep 3/3 — Max price per NFT (ETH)?`, { parse_mode: 'Markdown', reply_markup: keyboards.cancelMenu });
  }
  if (session.step === 'nft_sweep_price') {
    const price = parseFloat(text);
    if (isNaN(price) || price <= 0) return bot.sendMessage(userId, '❌ Invalid price.', { reply_markup: keyboards.cancelMenu });
    session.data.sweepMaxPrice = price; session.step = 'confirm_nft_sweep'; saveSession();
    return bot.sendMessage(userId, `🧹 *Confirm Sweep*\n\n🔗 ${chainLabel(session.chainId)}\n📄 \`${session.data.sweepContract}\`\n🔢 Qty: *${session.data.sweepQty}*\n💰 Max/each: *${price} ETH*\nTotal max: *${(price * session.data.sweepQty).toFixed(4)} ETH*`, { parse_mode: 'Markdown', reply_markup: keyboards.confirmMenu('nft_sweep') });
  }
}

// ── CONFIRM MINT ──────────────────────────────────────────────────────────────
async function handleConfirmMint(bot, query) {
  const userId = query.from.id;
  const session = getSession(userId);
  try { await bot.answerCallbackQuery(query.id); } catch(e) {}

  const {
    contractAddress, quantity, mintPrice, customFn, gweiOverride, dryRun,
    merkleProof = [], proofMap = null, proofMode = 'none',
    eip712Sigs = null, useFlashbots = false,
    detectedStandard = 'ERC721', tokenId = 1,
    useLaunchpadProof = false,
  } = session.data;
  const { chainId } = session;
  const wallets = getWallets();
  clearSession(userId);

  // ── v18: EIP-712 Expiry Detection ──────────────────────────────────────────
  if (eip712Sigs && !dryRun) {
    const expiredWallets = [];
    try {
      const provider = await getProvider(chainId);
      const nonceAbi = ['function nonces(address) view returns (uint256)'];
      const nonceContract = new (require('ethers').ethers.Contract)(contractAddress, nonceAbi, provider);
      for (const [addr, sig] of Object.entries(eip712Sigs)) {
        try {
          const onChainNonce = Number(await nonceContract.nonces(addr));
          // Simple heuristic: if nonce > 0 the sig may have been used
          if (onChainNonce > 0) {
            expiredWallets.push(`⚠️ \`${addr.slice(0,8)}...\` nonce=${onChainNonce} (sig may be used/expired)`);
          }
        } catch {}
      }
    } catch {}
    if (expiredWallets.length) {
      await bot.sendMessage(userId,
        `⚠️ *Proof Expiry Warning*\n\n${expiredWallets.join('\n')}\n\nSigs may have been consumed. Proceeding anyway — bot will report errors per wallet.`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  // ── v18: Launchpad auto-proof fetch (show status) ──────────────────────────
  if (useLaunchpadProof && !dryRun && !eip712Sigs && merkleProof.length === 0) {
    await bot.sendMessage(userId, '🔍 *Fetching proofs from launchpad APIs...*', { parse_mode: 'Markdown' });
    try {
      const proofResults = await fetchProofsForAllWallets(contractAddress, wallets.map(w => w.address), chainId);
      const found = Object.values(proofResults).filter(r => r.proof.length > 0 || r.sig);
      if (found.length) {
        await bot.sendMessage(userId, `✅ *Launchpad proofs found for ${found.length}/${wallets.length} wallets*\nPlatform: ${found[0].platform}`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(userId, '⚠️ No proofs found via launchpad APIs — minting without proof.', { parse_mode: 'Markdown' });
      }
    } catch (e) {
      await bot.sendMessage(userId, `⚠️ Launchpad proof fetch error: ${e.message.slice(0, 80)}`, { parse_mode: 'Markdown' });
    }
  }

  // Auto-balance wallets before real mints
  if (!dryRun) {
    try {
      const minEth = parseFloat(mintPrice) * quantity + 0.005;
      const targetEth = minEth * 1.5;
      const balResults = await autoBalanceWallets(wallets.map(w => w.address), minEth, targetEth, chainId);
      const topped = balResults.filter(r => r.status === 'topped_up');
      const failed = balResults.filter(r => r.status === 'master_insufficient' || r.status === 'failed');
      if (topped.length) await bot.sendMessage(userId, `⛽ *Auto-topped ${topped.length} wallet(s)* before mint.`, { parse_mode: 'Markdown' });
      if (failed.length) await bot.sendMessage(userId, `⚠️ *${failed.length} wallet(s) could not be topped up* — master may be low.`, { parse_mode: 'Markdown' });
    } catch(balErr) { logger.warn(`Auto-balance failed: ${balErr.message}`); }
  }

  await bot.sendMessage(userId, dryRun ? '🧪 *Simulating mint...*' : '🚀 *Minting — auto-detecting phase and routing eligibility...*', { parse_mode: 'Markdown' });

  // Build spend limits from wallet objects
  const spendLimits = {};
  wallets.forEach(w => { if (w.spendLimit != null) spendLimits[w.address] = w.spendLimit; });

  const results = await mintFromAllWallets({
    wallets, contractAddress, quantity, mintPrice,
    customFn, gweiOverride, chainId,
    merkleProof, proofMap, proofMode,
    eip712Sigs, useFlashbots,
    parallel: true, dryRun,
    standard: detectedStandard, tokenId,
    useLaunchpadProof,
    spendLimits: Object.keys(spendLimits).length ? spendLimits : null,
    // v18: FB sim feedback → send Telegram message
    onSimPassed: useFlashbots ? ({ gasUsed, targetBlock, blockRange }) => {
      bot.sendMessage(userId, `✅ *Bundle sim passed!*\n⛽ Gas: ${gasUsed.toLocaleString()}\n🎯 Targeting blocks ${blockRange}\nSubmitting to Flashbots relay...`, { parse_mode: 'Markdown' }).catch(() => {});
    } : null,
  });

  if (!dryRun) markContractKnown(contractAddress);

  const chain = getChain(chainId);
  notifyMintResult({ contractAddress, collectionName: contractAddress.slice(0,10), chainId, results, dryRun, explorerBase: chain.explorer }).catch(() => {});

  const summary = results.map(r => {
    const wallet = wallets.find(w => w.address === r.walletAddress);
    const label  = wallet?.label ? `(${wallet.label}) ` : '';
    const icon   = (r.status === 'success' || r.status === 'dry-run-ok') ? '✅' : r.status === 'skipped' ? '⏭' : '❌';
    const tx     = r.txHash ? `\n🔗 [tx](${chain.explorer}/tx/${r.txHash})` : '';
    const err    = r.error ? `\n⚠️ ${r.error.slice(0, 80)}` : '';
    const gas    = r.gasEscalation ? ` ⬆️ gas x${r.gasEscalation.toFixed(2)}` : '';
    return `${icon} ${label}\`${r.walletAddress.slice(0,8)}...\` ${r.status}${gas}${tx}${err}`;
  }).join('\n\n');

  const ok   = results.filter(r => r.status === 'success' || r.status === 'dry-run-ok').length;
  const skip = results.filter(r => r.status === 'skipped').length;
  const fail = results.filter(r => r.status === 'failed' || r.status === 'dry-run-fail').length;

  return bot.sendMessage(userId,
    `🏁 *${dryRun ? 'Dry Run' : 'Mint'} Complete*\n✅ ${ok} | ⏭ ${skip} skipped | ❌ ${fail}\n\n${summary}`,
    { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu }
  );
}

// ── CONFIRM SCHEDULE ──────────────────────────────────────────────────────────
async function handleConfirmSchedule(bot, query) {
  const userId = query.from.id;
  const session = getSession(userId);
  if (session?._confirming) { try { await bot.answerCallbackQuery(query.id); } catch(e) {} return; }
  if (session) session._confirming = true;
  try { await bot.answerCallbackQuery(query.id); } catch(e) {}

  const {
    contractAddress, mintTime, quantity, mintPrice, timeoutMs,
    merkleProof = [], proofMap = null, proofMode = 'none',
    eip712Sigs = null, useFlashbots = false, waitForPhase = false,
    detectedStandard = 'ERC721', tokenId = 1,
    useLaunchpadProof = false,
  } = session.data;
  const { chainId } = session;
  const scheduleId = uuidv4();
  clearSession(userId);

  const triggerStr = waitForPhase ? (mintTime ? 'time + phase poll' : 'phase poll only') : `time (${mintTime})`;
  await bot.sendMessage(userId,
    `✅ *Scheduled!*\n\n⏰ Trigger: *${triggerStr}*\n🔗 ${chainLabel(chainId)}\n🆔 \`${scheduleId.slice(0,8)}\`\n🔐 Proof: ${proofModeLabel(proofMode, proofMap, merkleProof)}${useFlashbots ? ' 🔒 Flashbots' : ''}\n\nTo cancel: \`/cancel ${scheduleId.slice(0,8)}\``,
    { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu }
  );

  scheduleAllWallets({
    scheduleId, contractAddress, mintTime, quantity, mintPrice,
    chainId, timeoutMs,
    merkleProof, proofMap, proofMode,
    eip712Sigs, useFlashbots, waitForPhase,
    standard: detectedStandard, tokenId,
    useLaunchpadProof,
    onCountdown: (secs) => {
      bot.sendMessage(userId, `⏳ *${formatCountdown(secs)}*`, { parse_mode: 'Markdown' });
      notifyScheduleCountdown({ contractAddress, mintTime, secondsLeft: secs }).catch(() => {});
    },
    onPhaseDetected: (phase) => {
      bot.sendMessage(userId, `🎯 *Launch phase:* ${phaseEmoji(phase.phase)} ${phase.phase} — ${phase.reason}`, { parse_mode: 'Markdown' });
    },
    onStart: () => bot.sendMessage(userId, `🔥 *FIRING!* Parallel mint from all wallets...`, { parse_mode: 'Markdown' }),
    onWalletUpdate: ({ walletAddress, attempts, status, txHash }) => {
      if (status === 'success') bot.sendMessage(userId, `✅ \`${walletAddress.slice(0,8)}...\` minted (${attempts} tries)\n🔗 \`${txHash?.slice(0,20)}...\``, { parse_mode: 'Markdown' });
      if (status === 'skipped') bot.sendMessage(userId, `⏭ \`${walletAddress.slice(0,8)}...\` skipped — not eligible`, { parse_mode: 'Markdown' });
    },
    onComplete: (results) => {
      const ok   = results.filter(r => r.status === 'success').length;
      const skip = results.filter(r => r.status === 'skipped').length;
      const fail = results.length - ok - skip;
      const lines = results.map(r => `${r.status === 'success' ? '✅' : r.status === 'skipped' ? '⏭' : r.status === 'timeout' ? '⏰' : '❌'} \`${r.walletAddress.slice(0,8)}...\` ${r.status} (${r.attempts || 0} tries)`).join('\n');
      bot.sendMessage(userId, `🏁 *Schedule Done*\n\n✅ ${ok} | ⏭ ${skip} skipped | ❌ ${fail}\n\n${lines}`, { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
    },
  }).catch(err => {
    // FIX (v26): this catch did not exist before. Any throw inside
    // scheduleAllWallets — a past-time check, an RPC failure, anything —
    // previously vanished as a silent unhandled rejection. The user had
    // already been told "✅ Scheduled!" and then heard nothing, forever,
    // with no way to know the schedule had actually died. Now they get
    // a real message the moment it fails.
    logger.error(`Schedule ${scheduleId} failed: ${err.message}`);
    bot.sendMessage(userId,
      `❌ *Schedule Failed*\n\n🆔 \`${scheduleId.slice(0,8)}\`\n\n${err.message}\n\nNothing was sent on-chain. Set a valid future time, or use Phase-poll mode if you don't have an exact time.`,
      { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu }
    );
  });
}

// ── CONFIRM FUND ──────────────────────────────────────────────────────────────
async function handleConfirmFund(bot, query) {
  const userId = query.from.id;
  const session = getSession(userId);
  try { await bot.answerCallbackQuery(query.id); } catch(e) {}
  await bot.sendMessage(userId, `💸 Funding wallets on ${chainLabel(session.chainId)}...`);
  const wallets = getWallets();
  const results = await fundWallets(wallets.map(w => w.address), session.data.fundAmount, session.chainId);
  const summary = results.map(r => `${r.status === 'funded' ? '✅' : '❌'} ${r.address.slice(0,6)}...${r.address.slice(-4)} → ${r.status}`).join('\n');
  clearSession(userId);
  return bot.sendMessage(userId, `✅ *Funding Done*\n\n${summary}`, { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
}

// ── NFT CONFIRM HANDLERS ──────────────────────────────────────────────────────
async function handleConfirmNFTList(bot, query) {
  const userId = query.from.id;
  const session = getSession(userId);
  try { await bot.answerCallbackQuery(query.id); } catch(e) {}
  await bot.sendMessage(userId, '⏳ Listing NFT...');
  const { nftContract, tokenId, listPrice } = session.data;
  const wallets = getWallets();
  if (!wallets.length) return bot.sendMessage(userId, '❌ No wallets.', { reply_markup: keyboards.mainMenu });
  try {
    // FIX: search ALL wallets for the one that actually holds this tokenId —
    // previously always used wallets[0], which fails (or signs from the wrong
    // address) whenever the NFT sits in any other wallet.
    const owner = await findOwnerWallet({ contractAddress: nftContract, tokenId, walletAddresses: wallets.map(w => w.address), chainId: session.chainId });
    if (!owner) {
      clearSession(userId);
      return bot.sendMessage(userId, `❌ None of your wallets hold \`${nftContract.slice(0,10)}...\` #${tokenId}.`, { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
    }
    const result = await listNFT({ walletAddress: owner.address, contractAddress: nftContract, tokenId, priceEth: listPrice, chainId: session.chainId, isERC1155: owner.isERC1155 });
    clearSession(userId);
    return bot.sendMessage(userId, `✅ *NFT Listed!*\n\n📄 \`${nftContract}\`\n🔢 #${tokenId}\n💰 *${listPrice} ETH*\n👛 \`${owner.address.slice(0,8)}...\`\n🔑 Order: \`${result.orderHash?.slice(0,16)}...\``, { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
  } catch(e) { clearSession(userId); return bot.sendMessage(userId, `❌ List failed: ${e.message.slice(0, 120)}`, { reply_markup: keyboards.mainMenu }); }
}

async function handleConfirmNFTFloor(bot, query) {
  const userId = query.from.id;
  const session = getSession(userId);
  try { await bot.answerCallbackQuery(query.id); } catch(e) {}
  await bot.sendMessage(userId, '⏳ Listing at floor...');
  const { nftContract, tokenId } = session.data;
  const wallets = getWallets();
  if (!wallets.length) return bot.sendMessage(userId, '❌ No wallets.', { reply_markup: keyboards.mainMenu });
  try {
    // FIX: same as above — find the wallet that actually owns this token
    // instead of assuming wallets[0].
    const owner = await findOwnerWallet({ contractAddress: nftContract, tokenId, walletAddresses: wallets.map(w => w.address), chainId: session.chainId });
    if (!owner) {
      clearSession(userId);
      return bot.sendMessage(userId, `❌ None of your wallets hold \`${nftContract.slice(0,10)}...\` #${tokenId}.`, { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
    }
    const result = await listAtFloor({ walletAddress: owner.address, contractAddress: nftContract, tokenId, chainId: session.chainId, isERC1155: owner.isERC1155 });
    clearSession(userId);
    return bot.sendMessage(userId, `✅ *Listed at Floor!*\n\n📄 \`${nftContract}\`\n🔢 #${tokenId}\n💰 *${result.priceEth?.toFixed(4)} ETH*\n👛 \`${owner.address.slice(0,8)}...\``, { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
  } catch(e) { clearSession(userId); return bot.sendMessage(userId, `❌ List failed: ${e.message.slice(0, 120)}`, { reply_markup: keyboards.mainMenu }); }
}

async function handleConfirmNFTSweep(bot, query) {
  const userId = query.from.id;
  const session = getSession(userId);
  try { await bot.answerCallbackQuery(query.id); } catch(e) {}
  const { sweepContract, sweepQty, sweepMaxPrice } = session.data;
  await bot.sendMessage(userId, `🧹 Sweeping ${sweepQty} NFTs...`);
  const wallets = getWallets();
  if (!wallets.length) { clearSession(userId); return bot.sendMessage(userId, '❌ No wallets.', { reply_markup: keyboards.mainMenu }); }
  try {
    // FIX: iterate ALL wallets instead of only wallets[0]. A sweep is a series
    // of purchases — if the first wallet runs out of funds (or hits its
    // sweepQty) before reaching the target quantity, move on to the next
    // wallet and keep buying until the quantity is met or wallets run out.
    const allResults = [];
    let remaining = sweepQty;
    for (const w of wallets) {
      if (remaining <= 0) break;
      try {
        const results = await sweepNFTs({ walletAddress: w.address, contractAddress: sweepContract, quantity: remaining, maxPriceEthEach: sweepMaxPrice, chainId: session.chainId });
        results.forEach(r => { r.wallet = w.address; });
        allResults.push(...results);
        remaining -= results.filter(r => r.status === 'success').length;
      } catch (e) {
        allResults.push({ status: 'failed', error: e.message.slice(0, 120), wallet: w.address });
      }
    }
    const ok = allResults.filter(r => r.status === 'success');
    const summary = allResults.map(r => {
      const label = r.wallet ? ` (\`${r.wallet.slice(0,8)}...\`)` : '';
      return `${r.status === 'success' ? '✅' : '❌'} #${r.tokenId || '?'} @ ${r.priceEth || '?'} ETH${label}${r.error ? ` — ${r.error.slice(0,40)}` : ''}`;
    }).join('\n');
    clearSession(userId);
    return bot.sendMessage(userId, `🧹 *Sweep Done*\n\n✅ ${ok.length}/${sweepQty} bought\n\n${summary}`, { parse_mode: 'Markdown', reply_markup: keyboards.mainMenu });
  } catch(e) { clearSession(userId); return bot.sendMessage(userId, `❌ Sweep failed: ${e.message.slice(0, 120)}`, { reply_markup: keyboards.mainMenu }); }
}

module.exports = {
  handleStart, handleCallback, handleMessage,
  handleConfirmMint, handleConfirmSchedule, handleConfirmFund,
  handleConfirmNFTList, handleConfirmNFTFloor, handleConfirmNFTSweep,
};

/**
 * scheduler.js — v18
 *
 * NEW in v18:
 *   - Gas auto-escalation on retry: +10% per attempt (gasEscalatePercent param)
 *   - Sold-out detection: abort remaining wallets immediately on sold-out signal
 *   - Multi-contract batch scheduling: batchSchedule([{contract, ...opts}])
 *   - Session persistence: schedules survive process restart via schedules.json
 */

const { getWallets }        = require('./walletManager');
const { rSet, rGet }        = require('../utils/redisClient');
const REDIS_SCHEDULES_KEY   = 'hermes:schedules-meta';

const cancelledIds = new Set();
function isCancelled(id) {
  return cancelledIds.has(id) || schedules[id]?.cancelled === true;
}
const { mintFromWallet, mintFromAllWallets, mintViaFlashbots, SoldOutSignal } = require('./mintEngine');
const { detectMintPhase }   = require('./phaseDetector');
const { getProofForWallet } = require('./perWalletProof');
const logger = require('../utils/logger');
const fs   = require('fs');
const path = require('path');

const SCHEDULES_FILE = path.join(__dirname, '../../schedules-persist.json');
const SCHEDULE_RESULTS_FILE = path.join(__dirname, '../../schedule-results.json');
const schedules = {};

// ── COMPLETED SCHEDULE RESULTS ──────────────────────────────────────────────
// v23 FIX: previously, when a scheduled mint fired, the only record was a
// logger.info() call — invisible to the webapp/Telegram. The schedule entry
// was deleted from `schedules` immediately, so "Active Schedules" just showed
// nothing with zero indication of whether it fired, succeeded, or errored.
// Now every completion (success, failure, sold-out, cancelled, or error) is
// appended here and persisted to disk so the UI can show what happened.
function loadScheduleResults() {
  try {
    if (fs.existsSync(SCHEDULE_RESULTS_FILE)) {
      return JSON.parse(fs.readFileSync(SCHEDULE_RESULTS_FILE, 'utf8'));
    }
  } catch (e) { logger.warn(`Schedule results read: ${e.message}`); }
  return [];
}

function recordScheduleResult(scheduleId, contractAddress, chainId, outcome, results) {
  try {
    const history = loadScheduleResults();
    history.push({
      scheduleId, contractAddress, chainId, outcome,
      results, completedAt: new Date().toISOString(),
    });
    // Keep last 100
    const trimmed = history.slice(-100);
    fs.writeFileSync(SCHEDULE_RESULTS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (e) { logger.warn(`Schedule results write: ${e.message}`); }
}

// ── SESSION PERSISTENCE ───────────────────────────────────────────────────────
function persistSchedulesMeta() {
  try {
    const meta = Object.entries(schedules).map(([id, s]) => ({
      id, contractAddress: s.contractAddress, mintTime: s.mintTime, chainId: s.chainId,
      cancelled: s.cancelled || false, createdAt: s.createdAt || Date.now(),
    }));
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(meta, null, 2), 'utf8');
    // Redis backup — fire and forget, never blocks
    rSet(REDIS_SCHEDULES_KEY, JSON.stringify(meta)).catch(() => {});
  } catch (e) { logger.warn(`Schedule persist write: ${e.message}`); }
}

async function loadPersistedSchedulesMeta() {
  // Try Redis first (survives process restarts better than JSON on Render)
  try {
    const cached = await rGet(REDIS_SCHEDULES_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        logger.info(`[Redis] Loaded ${parsed.length} schedule(s) from Redis`);
        return parsed;
      }
    }
  } catch (e) { logger.warn(`[Redis] Load failed: ${e.message}`); }
  // Fall back to JSON file
  try {
    if (!fs.existsSync(SCHEDULES_FILE)) return [];
    return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
  } catch (e) { return []; }
}

// ── MINT WITH RETRY + GAS ESCALATION ─────────────────────────────────────────
async function mintWithRetry({
  walletAddress, contractAddress, quantity, mintPrice,
  customFn, gweiOverride, chainId = 1,
  merkleProof = null, eip712Sig = null, merkleApiUrl = null,
  tokenId = 0, standard = 'auto',
  dryRun = false, timeoutMs = 60000,
  // v18: gas escalation
  gasEscalatePercent = 10,   // bump gas by this % each retry (0 = disabled)
  spendLimitEth = null,
  soldOutSignal = null,
  useLaunchpadProof = false,
  priorityGas = false,
  onAttempt,
}) {
  const deadline = Date.now() + timeoutMs;
  let attempts   = 0;
  let currentGwei = gweiOverride;

  while (Date.now() < deadline) {
    // v18: sold-out check before each attempt
    if (soldOutSignal?.triggered) {
      return { walletAddress, status: 'skipped', error: `⛔ ${soldOutSignal.reason}`, attempts };
    }

    attempts++;

    // v18: escalate gas each retry (+10% by default)
    if (attempts > 1 && gasEscalatePercent > 0 && currentGwei) {
      currentGwei = parseFloat((currentGwei * (1 + gasEscalatePercent / 100)).toFixed(4));
      logger.info(`[GasEscalation] Attempt ${attempts}: ${gweiOverride}→${currentGwei} gwei (+${gasEscalatePercent}%)`);
    } else if (attempts > 1 && gasEscalatePercent > 0 && !currentGwei) {
      // Auto gas: escalation via multiplier
      const multiplier = Math.pow(1 + gasEscalatePercent / 100, attempts - 1);
      logger.info(`[GasEscalation] Attempt ${attempts}: auto gas x${multiplier.toFixed(3)}`);
    }

    const gasEscalationMultiplier = attempts > 1 && gasEscalatePercent > 0
      ? Math.pow(1 + gasEscalatePercent / 100, attempts - 1)
      : 1.0;

    try {
      const result = await mintFromWallet({
        walletAddress, contractAddress, quantity, mintPrice,
        customFn, gweiOverride: currentGwei, chainId,
        merkleProof, eip712Sig, merkleApiUrl,
        tokenId, standard, dryRun,
        gasEscalationMultiplier,
        spendLimitEth,
        soldOutSignal,
        useLaunchpadProof,
        priorityGas,
      });

      if (result.status === 'dry-run-fail') {
        if (onAttempt) onAttempt({ walletAddress, attempts, status: 'dry-run-fail', error: result.error });
        return { ...result, attempts };
      }
      if (result.status === 'skipped') {
        if (onAttempt) onAttempt({ walletAddress, attempts, status: 'skipped', error: result.error });
        return { ...result, attempts };
      }
      if (result.status === 'success' || result.status === 'dry-run-ok' || result.status === 'pending') {
        if (onAttempt) onAttempt({ walletAddress, attempts, status: result.status, txHash: result.txHash });
        return { ...result, attempts };
      }

      // v18: sold-out from result → trigger signal
      if (result.error && (result.error.includes('sold out') || result.error.includes('MaxSupplyReached'))) {
        if (soldOutSignal) soldOutSignal.trigger(`Sold out — ${walletAddress.slice(0, 8)}`);
        return { ...result, attempts };
      }

      // Insufficient balance — retrying won't help, balance won't change on its own
      if (result.error && result.error.startsWith('Insufficient:')) {
        logger.warn(`Attempt ${attempts} INSUFFICIENT (not retrying) [${walletAddress.slice(0, 8)}]: ${result.error}`);
        return { walletAddress, status: 'failed', error: result.error, attempts };
      }
      // Invalid proof — retrying won't help
      if (result.error && result.error.startsWith('Invalid proof:')) {
        return { walletAddress, status: 'failed', error: result.error, attempts };
      }
      logger.warn(`Attempt ${attempts} non-success [${walletAddress.slice(0, 8)}]: ${result.error || result.status}`);
      if (onAttempt) onAttempt({ walletAddress, attempts, status: 'retrying', error: result.error, gasGwei: currentGwei });
    } catch (err) {
      const msg = err.message || '';
      const isTerminal =
        err.code === 'CALL_EXCEPTION' ||
        err instanceof ReferenceError ||
        err instanceof TypeError ||
        msg.includes('execution reverted') ||
        msg.includes('UNPREDICTABLE_GAS_LIMIT') ||
        msg.includes('is not defined') ||
        msg.includes('is not a function') ||
        msg.toLowerCase().includes('revert');
      if (isTerminal) {
        logger.warn(`Attempt ${attempts} TERMINAL [${walletAddress.slice(0,8)}]: ${msg.slice(0,100)}`);
        return { walletAddress, status: 'failed', error: msg.slice(0, 120), attempts };
      }
      logger.warn(`Attempt ${attempts} threw [${walletAddress.slice(0,8)}]: ${msg.slice(0,80)}`);
      if (onAttempt) onAttempt({ walletAddress, attempts, status: 'retrying', error: msg, gasGwei: currentGwei });
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  return { walletAddress, status: 'timeout', attempts };
}

// ── SMART SCHEDULE ───────────────────────────────────────────────────────────
// ── TELEGRAM NOTIFICATION ON COMPLETION ─────────────────────────────────────
// v23: schedules previously fired silently — the only trace was a
// logger.info() that nobody sees unless watching Render logs in real time.
// Lazy-require avoids a circular dependency at module-load time.
const outcomeEmoji = { success: '✅', partial: '⚠️', failed: '❌', sold_out: '🚫', paused: '⏸' };

async function notifyScheduleComplete(scheduleId, contractAddress, chainId, outcome, results) {
  try {
    const { ALLOWED_USER_ID } = require('../config');
    if (!ALLOWED_USER_ID) return; // no user configured — nothing to notify
    const bot = require('../bot/index');

    const successCount = results.filter(r => r.status === 'success').length;
    const total = results.length;
    let msg = `${outcomeEmoji[outcome] || '❓'} *Schedule Fired*\n\n`;
    msg += `Contract: \`${contractAddress.slice(0, 10)}...\`\n`;
    msg += `Result: *${successCount}/${total} succeeded*\n\n`;
    for (const r of results.slice(0, 10)) {
      const icon = r.status === 'success' ? '✅' : r.status === 'skipped' ? '⏭' : '❌';
      msg += `${icon} ${r.walletAddress ? r.walletAddress.slice(0, 8) + '...' : ''} — ${r.status}`;
      if (r.error) msg += ` (${r.error.slice(0, 60)})`;
      if (r.txHash) msg += ` — [tx](${r.txHash})`;
      msg += '\n';
    }
    await bot.sendMessage(ALLOWED_USER_ID, msg, { parse_mode: 'Markdown' });
  } catch (e) {
    logger.warn(`Schedule completion notification failed: ${e.message}`);
  }
}

async function _scheduleAllWalletsInner({
  scheduleId, contractAddress, mintTime, quantity, mintPrice,
  customFn, gweiOverride, chainId = 1,
  merkleProof = [], proofMap = null, proofMode = 'none',
  eip712Sigs = null,
  merkleApiUrl = null,
  useFlashbots = false,
  dryRun = false, tokenId = 0, standard = 'auto',
  timeoutMs = 60000,
  waitForPhase = false,
  phaseCheckIntervalMs = 5000,
  phaseMaxWaitMs = 3600000,
  // v18 additions
  gasEscalatePercent = 10,
  useLaunchpadProof = false,
  spendLimits = null,
  priorityGas = false,
  walletFilter = null, // v20: array of wallet addresses to restrict this schedule to (null = all wallets)
  // Callbacks
  onCountdown, onStart, onPhaseDetected, onPhaseUpdate, onWalletUpdate, onComplete, onSimPassed,
}) {
  const now    = Date.now();
  const target = mintTime ? new Date(mintTime).getTime() : null;

  // FIX (v26): register the schedule BEFORE any validation that can throw.
  // Previously the "time is in the past" throw happened before this line ran,
  // so a near-instant or already-past mintTime died as a silent unhandled
  // rejection — never appeared in schedules{}, Cancel did nothing, and the
  // webapp had already shown "Scheduled" because server.js responded
  // before awaiting this function at all. Registering first means even a
  // rejected schedule is visible and gets cleaned up properly below.
  // Dedup: reject same contract+time to prevent 6x duplicate schedules
  if (contractAddress && mintTime) {
    const dk = `${contractAddress.toLowerCase()}:${mintTime}`;
    const dup = Object.values(schedules).find(s => `${s.contractAddress?.toLowerCase()}:${s.mintTime}`===dk && !s.cancelled);
    if (dup) { logger.warn(`[Scheduler] Duplicate rejected: ${dk}`); return { scheduleId, duplicate: true }; }
  }
  schedules[scheduleId] = { cancelled: false, mintTime, contractAddress, chainId, createdAt: Date.now(), status: 'pending' };
  persistSchedulesMeta();

  // FIX (v26): treat "in the past" as a tiny grace window (3s) instead of an
  // exact-millisecond check. A mintTime of "now" submitted from a slow mobile
  // connection routinely arrives 1-2s late — that's not a real error, it just
  // means "fire immediately." Only reject if it's meaningfully stale.
  if (target && target < now - 3000) {
    delete schedules[scheduleId];
    persistSchedulesMeta();
    throw new Error(`Mint time is ${Math.round((now - target) / 1000)}s in the past — set a future time or use Phase-poll mode`);
  }

  logger.info(`Schedule ${scheduleId.slice(0, 8)}: mintTime=${mintTime || 'immediate'} waitForPhase=${waitForPhase} chain=${chainId} proofMode=${proofMode} flashbots=${useFlashbots} gasEscalate=${gasEscalatePercent}%`);

  // ── Step 1: Clock countdown ──
  if (target) {
    const delay = target - now;
    logger.info(`Waiting ${Math.round(delay / 1000)}s for clock time`);

    const countdownInterval = setInterval(() => {
      if (isCancelled(scheduleId)) { clearInterval(countdownInterval); return; }
      const remaining = Math.max(0, target - Date.now());
      if (remaining <= 0) { clearInterval(countdownInterval); return; }
      if (onCountdown) onCountdown(Math.round(remaining / 1000));
    }, 10000);

    const t5 = target - 5000;
    if (t5 > Date.now()) {
      await new Promise(r => setTimeout(r, t5 - Date.now()));
      for (let i = 5; i > 0; i--) {
        if (isCancelled(scheduleId)) { clearInterval(countdownInterval); return { cancelled: true }; }
        if (onCountdown) onCountdown(i);
        await new Promise(r => setTimeout(r, 1000));
      }
    } else {
      await new Promise(r => setTimeout(r, Math.max(0, target - Date.now())));
    }
    clearInterval(countdownInterval);
    if (isCancelled(scheduleId)) return { cancelled: true };
  }

  // ── Step 2: Phase detection at fire time ──
  try {
    const phase = await detectMintPhase(contractAddress, [], chainId);
    logger.info(`[FIRE TIME] Phase: ${phase.phase} — ${phase.reason}`);
    if (onPhaseDetected) onPhaseDetected(phase);
    // UNKNOWN always fires — only hard-skip PAUSED/SOLD_OUT/ENDED
    const mintClosed = phase.phase !== 'UNKNOWN' && (
      phase.phase === 'PAUSED' || phase.phase === 'paused' || phase.isPaused === true ||
      phase.phase === 'SOLD_OUT' || phase.phase === 'ENDED' ||
      (phase.confidence === 'verified' && phase.isPublic === false && !phase.isWhitelist)
    );
    if (mintClosed) {
      let wallets = getWallets();
      if (Array.isArray(walletFilter) && walletFilter.length) {
        const filterSet = new Set(walletFilter.map(a => a.toLowerCase()));
        wallets = wallets.filter(w => filterSet.has(w.address.toLowerCase()));
      }
      if (onComplete) onComplete(wallets.map(w => ({ walletAddress: w.address, status: 'skipped', error: 'Contract paused ⏸' })));
      const closeReason = phase.phase === 'PAUSED' ? 'paused' : 'closed';
      recordScheduleResult(scheduleId, contractAddress, chainId, closeReason, wallets.map(w => ({ walletAddress: w.address, status: 'skipped', error: 'Contract paused at fire time' })));
      notifyScheduleComplete(scheduleId, contractAddress, chainId, 'paused', wallets.map(w => ({ walletAddress: w.address, status: 'skipped', error: 'Contract paused at fire time' })));
      delete schedules[scheduleId]; persistSchedulesMeta();
      return [];
    }
  } catch (e) { logger.warn(`Phase detect at fire time: ${e.message}`); }

  // ── Step 3: Phase polling (if enabled) ──
  if (waitForPhase) {
    logger.info(`Phase polling for ${contractAddress.slice(0, 10)} every ${phaseCheckIntervalMs}ms`);
    const phaseStart = Date.now();
    let lastPhase = null;

    while (Date.now() - phaseStart < phaseMaxWaitMs) {
      if (isCancelled(scheduleId)) return { cancelled: true };
      try {
        const phaseInfo = await detectMintPhase(contractAddress, [], chainId);
        if (phaseInfo.phase !== lastPhase) {
          lastPhase = phaseInfo.phase;
          logger.info(`Phase change: ${phaseInfo.phase}`);
          if (onPhaseUpdate) onPhaseUpdate(phaseInfo);
        }
        if (phaseInfo.isPublic || phaseInfo.isWhitelist || phaseInfo.phase === 'public' || phaseInfo.phase === 'whitelist') {
          logger.info(`Phase OPEN: ${phaseInfo.phase} — firing mint`);
          if (onPhaseUpdate) onPhaseUpdate({ ...phaseInfo, open: true });
          break;
        }
        if (phaseInfo.isSoldOut) {
          logger.warn('Sold out — aborting');
          if (onComplete) onComplete([{ status: 'sold_out', contractAddress }]);
          recordScheduleResult(scheduleId, contractAddress, chainId, 'sold_out', [{ status: 'sold_out', contractAddress }]);
          notifyScheduleComplete(scheduleId, contractAddress, chainId, 'sold_out', [{ status: 'sold_out', contractAddress }]);
          delete schedules[scheduleId]; persistSchedulesMeta();
          return { soldOut: true };
        }
      } catch (e) { logger.warn(`Phase poll error: ${e.message.slice(0, 80)}`); }
      await new Promise(r => setTimeout(r, phaseCheckIntervalMs));
    }
  }

  if (isCancelled(scheduleId)) return { cancelled: true };
  if (onStart) onStart();

  // ── Step 4: Fire ──
  let wallets = getWallets();
  if (Array.isArray(walletFilter) && walletFilter.length) {
    const filterSet = new Set(walletFilter.map(a => a.toLowerCase()));
    wallets = wallets.filter(w => filterSet.has(w.address.toLowerCase()));
    logger.info(`Schedule ${scheduleId.slice(0, 8)}: filtered to ${wallets.length}/${filterSet.size} requested wallets`);
  }
  logger.info(`FIRING — ${wallets.length} wallets chain=${chainId} flashbots=${useFlashbots} gasEscalate=${gasEscalatePercent}%`);

  // FIX: mirrors the exact same auto-detect block mintFromAllWallets() runs
  // in mintEngine.js. Without this, a schedule created via Telegram (which
  // only ever sends proofMode='auto', never the literal string 'opensea')
  // would never resolve to OpenSea/SeaDrop routing below — even after
  // adding the explicit 'opensea'/'seaport'/'seadrop' branch, since that
  // branch only matches if one of those literal strings is already set.
  // The webapp's Schedule form sends the literal strings directly, so it
  // didn't need this — but Telegram does.
  if (proofMode !== 'seadrop' && proofMode !== 'flashbots' && proofMode !== 'eip712') {
    try {
      const { detectAdapter } = require('./adapterRegistry');
      const adapter = await detectAdapter(contractAddress, chainId);
      if (adapter.routeTo && adapter.routeTo !== proofMode) {
        logger.info(`[Schedule/AutoRoute] ${adapter.name} → ${adapter.routeTo} for ${contractAddress.slice(0,10)}`);
        proofMode = adapter.routeTo;
      }
    } catch (adErr) {
      logger.warn(`[Schedule/AutoRoute] adapter detect failed: ${adErr.message.slice(0,100)}`);
    }
  }

  let results;

  if (useFlashbots || proofMode === 'flashbots') {
    try {
      results = await mintViaFlashbots({
        wallets, contractAddress, quantity, mintPrice,
        customFn, gweiOverride, chainId,
        merkleProof, proofMap, eip712Sigs, tokenId,
        onSimPassed, priorityGas,
      });
    } catch (err) {
      results = [{ status: 'failed', error: err.message }];
    }
  } else if (proofMode === 'opensea' || proofMode === 'seaport' || proofMode === 'seadrop') {
    // FIX: this branch didn't exist before — scheduled mints for OpenSea/
    // Seaport/SeaDrop silently fell through to the generic per-wallet retry
    // loop below, which guesses at standard ERC721 mint() function names.
    // That has no chance of working on an OpenSea Studio drop (no public
    // mint() function at all — it's fulfilled via Seaport/SIWE) and ignores
    // SeaDrop's on-chain price-reading entirely. Routing through
    // mintFromAllWallets reuses the exact same dispatch logic live "Mint Now"
    // already uses correctly, so Schedule can't silently drift out of sync
    // with Mint again.
    try {
      results = await mintFromAllWallets({
        wallets, contractAddress, quantity, mintPrice,
        gweiOverride, chainId, dryRun, proofMode,
        merkleProof, proofMap, tokenId,
        spendLimits, priorityGas, parallel: true,
      });
    } catch (err) {
      results = wallets.map(w => ({ walletAddress: w.address, status: 'failed', error: err.message }));
    }
  } else {
    // v18: shared sold-out signal across wallets
    const soldOutSig = new SoldOutSignal();

    results = await Promise.all(
      wallets.map((w, idx) => {
        const addrLower = w.address.toLowerCase();
        const eip712Sig = eip712Sigs ? (eip712Sigs[w.address] || eip712Sigs[addrLower] || null) : null;
        let walletProof = proofMap ? (proofMap[w.address] || proofMap[addrLower] || merkleProof) : merkleProof;
        if ((!walletProof || walletProof.length === 0) && !eip712Sig) walletProof = getProofForWallet(w.address);
        const spendLimit = spendLimits ? (spendLimits[w.address] || spendLimits[addrLower] || null) : (w.spendLimit || null);

        return mintWithRetry({
          walletAddress: w.address, contractAddress, quantity, mintPrice,
          customFn, gweiOverride, chainId, dryRun,
          merkleProof: walletProof, eip712Sig, merkleApiUrl,
          tokenId, standard, timeoutMs,
          gasEscalatePercent,
          spendLimitEth: spendLimit,
          soldOutSignal: soldOutSig,
          useLaunchpadProof,
          priorityGas,
          onAttempt: onWalletUpdate,
        });
      })
    );
  }

  delete schedules[scheduleId]; persistSchedulesMeta();
  const successCount = results.filter(r => r.status === 'success').length;
  const outcome = successCount === results.length ? 'success' : successCount > 0 ? 'partial' : 'failed';
  recordScheduleResult(scheduleId, contractAddress, chainId, outcome, results);
  if (onComplete) onComplete(results);
  notifyScheduleComplete(scheduleId, contractAddress, chainId, outcome, results);
  return results;
}

// FIX (v26): public entry point — guarantees that ANY failure anywhere inside
// the schedule lifecycle (validation throw, RPC error, wallet fetch error,
// a bug we haven't even thought of yet) still does three things instead of
// vanishing as a silent unhandled rejection:
//   1. Removes the dead entry from schedules{} so it doesn't haunt the
//      Active Schedules list forever at "0s" with a Cancel button that does
//      nothing.
//   2. Records the failure in schedule-results.json so it's visible in
//      history instead of just disappearing.
//   3. Re-throws so the caller (server.js route, or Telegram command) can
//      surface the REAL error to the user instead of a fake "Scheduled ✅".
async function scheduleAllWallets(opts) {
  try {
    return await _scheduleAllWalletsInner(opts);
  } catch (err) {
    const { scheduleId, contractAddress, chainId = 1 } = opts || {};
    logger.error(`Schedule ${scheduleId?.slice(0, 8) || '?'} crashed: ${err.message}`);
    if (scheduleId && schedules[scheduleId]) {
      delete schedules[scheduleId];
      persistSchedulesMeta();
    }
    if (scheduleId) {
      try {
        recordScheduleResult(scheduleId, contractAddress, chainId, 'failed', [{ status: 'failed', error: err.message }]);
      } catch { /* already recorded by inner throw path, or storage unavailable — non-fatal */ }
    }
    throw err;
  }
}


/**
 * Queue multiple contracts in one scheduled session.
 * Each job fires in parallel at its own mintTime.
 * Returns array of per-contract result arrays.
 *
 * @param {Array} jobs — array of scheduleAllWallets param objects (each needs scheduleId)
 * @param {Function} onJobStart  — called with (job, index) when a job fires
 * @param {Function} onJobDone   — called with (job, index, results) when a job completes
 */
async function batchSchedule(jobs, { onJobStart, onJobDone } = {}) {
  logger.info(`[BatchSchedule] Queuing ${jobs.length} contracts`);

  const batchResults = await Promise.all(
    jobs.map(async (job, idx) => {
      try {
        if (onJobStart) onJobStart(job, idx);
        const results = await scheduleAllWallets(job);
        if (onJobDone) onJobDone(job, idx, results);
        return { contractAddress: job.contractAddress, scheduleId: job.scheduleId, results };
      } catch (err) {
        logger.error(`[BatchSchedule] Job ${idx} (${job.contractAddress?.slice(0, 10)}) failed: ${err.message}`);
        if (onJobDone) onJobDone(job, idx, [{ status: 'error', error: err.message }]);
        return { contractAddress: job.contractAddress, scheduleId: job.scheduleId, error: err.message };
      }
    })
  );

  return batchResults;
}

function cancelSchedule(scheduleId) {
  const key = Object.keys(schedules).find(k => k.startsWith(scheduleId) || k === scheduleId);
  if (key) {
    cancelledIds.add(key);
    if (schedules[key]) schedules[key].cancelled = true;
    delete schedules[key];
    persistSchedulesMeta();
    return true;
  }
  return false;
}

function getActiveSchedules() {
  return Object.entries(schedules).map(([id, s]) => ({
    id, contractAddress: s.contractAddress, mintTime: s.mintTime, chainId: s.chainId,
    createdAt: s.createdAt,
  }));
}

module.exports = { scheduleAllWallets, cancelSchedule, getActiveSchedules, mintWithRetry, batchSchedule, loadScheduleResults };

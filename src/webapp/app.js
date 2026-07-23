// Token injected by server into window.__API_TOKEN__ — never hardcoded in files
const API_TOKEN = window.__API_TOKEN__ || '';
const H = { 'Content-Type': 'application/json', 'x-api-token': API_TOKEN };
let currentChainId = parseInt(localStorage.getItem('chainId') || '1');
let _scheduleTickInterval = null;

// ── HAMBURGER / MOBILE NAV ────────────────────────────────────────────────────
function toggleMobileNav() {
  const btn = document.getElementById('hamburger-btn');
  const nav = document.getElementById('mobile-nav');
  const overlay = document.getElementById('mn-overlay');
  const open = nav.classList.toggle('open');
  btn.classList.toggle('open', open);
  overlay.classList.toggle('open', open);
}
function closeMobileNav() {
  document.getElementById('hamburger-btn')?.classList.remove('open');
  document.getElementById('mobile-nav')?.classList.remove('open');
  document.getElementById('mn-overlay')?.classList.remove('open');
}
function mobileNavGo(page) {
  // Sync desktop tabs
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
  // Sync mobile items
  document.querySelectorAll('.mobile-nav-item').forEach(t => t.classList.toggle('active', t.dataset.page === page));
  // Show page
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'instant' });
  closeMobileNav();
  // FIX: this used to have its own hardcoded loaders map (overview/wallets/
  // fund/mint only) — nft, schedule, history, and master were silently
  // missing, so mobile users (the primary way this bot is actually used)
  // navigating to Portfolio via the bottom nav got an empty wallet
  // checklist and no NFT load at all. Now it calls the same shared
  // function the desktop tab click handler uses, so both paths stay in
  // sync automatically instead of needing two lists kept manually aligned.
  if (typeof loadPageWalletChecks === 'function') loadPageWalletChecks(page);
  if (page === 'overview') loadOverview();
  if (page === 'nft' && typeof loadNFTs === 'function') { loadNFTs(); if (typeof populateListWallet === 'function') populateListWallet(); }
  if (page === 'wallets') loadWallets();
  if (page === 'history' && typeof loadHistory === 'function') loadHistory();
  if (page === 'master' && typeof loadMasterInfo === 'function') loadMasterInfo();
}

// ── SMART AUTO-FUND ───────────────────────────────────────────────────────────
// ETH gas cost per funding tx per chain (21000 gas * typical base fee)
const CHAIN_BASE_GWEI = { 1: 12, 8453: 0.008, 10: 0.002, 42161: 0.1, 137: 30, 56: 1, 81457: 0.001, 43114: 25, 59144: 0.05, 7777777: 0.0001, 4663: 0.01 };
// FIX: these used to just return CHAIN_BASE_GWEI[chainId] synchronously —
// a frozen, hardcoded guess with zero connection to actual network gas
// conditions. Now they call the real /api/gas endpoint (backed by
// getGasParams reading live provider.getFeeData()). The hardcoded table is
// kept ONLY as a fallback if that call fails (e.g. offline), so this never
// throws and always returns a usable number — but it's now genuinely live
// gas whenever the network call succeeds.
async function estFundingGasLive(chainId) {
  try {
    const data = await api(`/api/gas?chainId=${chainId}`);
    if (data.live && data.gwei) return (21000 * data.gwei * 1e9) / 1e18;
  } catch (e) { /* fall through to estimate */ }
  const gwei = CHAIN_BASE_GWEI[chainId] || 10;
  return (21000 * gwei * 1e9) / 1e18; // ETH — fallback estimate, not live
}
async function estMintGasLive(chainId) {
  try {
    const data = await api(`/api/gas?chainId=${chainId}`);
    if (data.live && data.gwei) return (180000 * data.gwei * 1e9) / 1e18;
  } catch (e) { /* fall through to estimate */ }
  const gwei = CHAIN_BASE_GWEI[chainId] || 10;
  return (180000 * gwei * 1e9) / 1e18; // ETH — fallback estimate, not live
}
// Kept for any other synchronous callers — clearly named as an estimate,
// not a live reading, so it's not confused with the async versions above.
function estFundingGas(chainId) {
  const gwei = CHAIN_BASE_GWEI[chainId] || 10;
  return (21000 * gwei * 1e9) / 1e18; // ETH — static estimate, NOT live
}
function estMintGas(chainId) {
  const gwei = CHAIN_BASE_GWEI[chainId] || 10;
  return (180000 * gwei * 1e9) / 1e18; // ETH — static estimate, NOT live
}

async function calcSmartFund() {
  const mintPrice = parseFloat(document.getElementById('ov-mint-price')?.value) || 0;
  const qty       = parseInt(document.getElementById('ov-mint-qty')?.value)     || 1;
  const chainId   = parseInt(document.getElementById('ov-ab-chain')?.value)     || 1;
  const mintCost  = mintPrice * qty;
  const mintGas   = await estMintGasLive(chainId);
  const fundGas   = await estFundingGasLive(chainId);

  // Smart target = mintCost + mintGas * 1.3 (30% buffer) — we also account for funding gas not being wasted
  const target    = parseFloat((mintCost + mintGas * 1.3).toFixed(6));
  const sym       = (CHAINS[chainId] || CHAINS[1]).symbol;

  // Fill the target input
  const tInput = document.getElementById('ov-target');
  if (tInput) tInput.value = target;

  // Show preview
  const preview = document.getElementById('ov-fund-preview');
  if (preview) preview.style.display = 'flex';

  document.getElementById('fp-mint-cost').textContent = `${mintCost.toFixed(6)} ${sym}`;
  document.getElementById('fp-mint-gas').textContent  = `~${mintGas.toFixed(6)} ${sym}`;
  document.getElementById('fp-fund-gas').textContent  = `~${fundGas.toFixed(6)} ${sym}`;
  document.getElementById('fp-target').textContent    = `${target} ${sym}`;

  // Estimate total from master (need wallet count)
  try {
    const w = await api('/api/wallets');
    const n = w.wallets.length;
    const total = parseFloat(((target + fundGas) * n).toFixed(6));
    document.getElementById('fp-total').textContent = `${total} ${sym} (${n} wallets)`;
    const msg = document.getElementById('ov-fund-msg');
    if (msg) {
      const ratio = target / (mintCost || 0.001);
      if (ratio > 2) {
        msg.style.display = '';
        msg.innerHTML = `<div class="fund-warning">⚠️ Previous target was ${(parseFloat(document.getElementById('ov-target')?.value)||0.005).toFixed(4)} ${sym} — ${Math.round((parseFloat(document.getElementById('ov-target')?.value)||0.005)/target*100-100)}% excess. Optimal: ${target} ${sym}</div>`;
      } else {
        msg.style.display = '';
        msg.innerHTML = `<div class="fund-ok">✅ Target ${target} ${sym} is correctly sized for this mint.</div>`;
      }
    }
  } catch(e) {}
}
function clearFundPreview() {
  document.getElementById('ov-fund-preview').style.display = 'none';
  document.getElementById('ov-fund-msg').style.display = 'none';
}

// ── EXECUTION FLOW STATE MACHINE ──────────────────────────────────────────────
let _execResolve = null; // promise resolver for CONFIRM step
let _execPayload = null;

function openExec() {
  document.getElementById('exec-overlay')?.classList.add('open');
  document.getElementById('exec-close-btn').disabled = true;
}
function closeExec() {
  document.getElementById('exec-overlay')?.classList.remove('open');
  // Re-enable mint button
  const btn = document.getElementById('m-btn');
  if (btn) btn.disabled = false;
}

function xStep(id, state, desc, detail) {
  const el = document.getElementById(`xs-${id}`);
  if (!el) return;
  el.className = `exec-step ${state}`;
  const bullet = document.getElementById(`xb-${id}`);
  if (bullet) bullet.textContent = state === 'done' ? '✓' : state === 'error' ? '✕' : state === 'active' ? '⟳' : (id === 'setup'?'1':id==='preflight'?'2':id==='confirm'?'3':id==='execute'?'4':'5');
  if (desc) document.getElementById(`xd-${id}`).textContent = desc;
  if (detail !== undefined) document.getElementById(`xdet-${id}`).textContent = detail;
}

function confirmExec(go) {
  if (_execResolve) { _execResolve(go); _execResolve = null; }
  document.getElementById('exec-confirm-area').style.display = 'none';
  document.getElementById('exec-subtitle').textContent = go ? 'Executing on-chain…' : 'Cancelled by user';
}

async function startExecFlow() {
  const contract  = document.getElementById('m-contract')?.value.trim();
  const qty       = parseInt(document.getElementById('m-qty')?.value) || 1;
  const price     = parseFloat(document.getElementById('m-price')?.value) || 0;
  const fn        = document.getElementById('m-fn')?.value.trim() || null;
  const gwei      = parseFloat(document.getElementById('m-gwei')?.value) || null;
  const isDryRun  = document.getElementById('m-dryrun')?.checked || false;
  const priorityGas = document.getElementById('m-priority-gas')?.checked || false;
  const proofMode = document.getElementById('m-proof-mode')?.value || 'opensea';
  const wallets   = getChecked('m-wallet-select');

  if (!contract) { toast('Enter contract address', 'red'); return; }
  if (!wallets.length) { toast('Select at least one wallet', 'red'); return; }

  const btn = document.getElementById('m-btn');
  if (btn) btn.disabled = true;
  document.getElementById('m-results').innerHTML = '';
  setStatus('m-status', '', '');

  // Build proof data
  let merkleProof = [], proofMap = null, eip712Sigs = null, useFlashbots = false, useLaunchpadProof = false;
  if (proofMode === 'single') {
    const raw = document.getElementById('m-proof')?.value.trim();
    merkleProof = raw ? raw.split(/[,\s]+/).filter(s => /^0x[0-9a-fA-F]{64}$/.test(s)) : [];
  } else if (proofMode === 'map') {
    try { proofMap = JSON.parse(document.getElementById('m-proof-map')?.value.trim()); }
    catch { toast('Invalid proof JSON', 'red'); if(btn) btn.disabled=false; return; }
  } else if (proofMode === 'eip712') {
    try { eip712Sigs = JSON.parse(document.getElementById('m-eip712')?.value.trim()); }
    catch { toast('Invalid EIP-712 JSON', 'red'); if(btn) btn.disabled=false; return; }
  } else if (proofMode === 'flashbots') { useFlashbots = true; }
  else if (proofMode === 'launchpad') { useLaunchpadProof = true; }

  _execPayload = {
    contractAddress: contract, quantity: qty, mintPrice: price,
    customFn: fn, gweiOverride: gwei, parallel: true,
    chainId: currentChainId, merkleProof, proofMap, eip712Sigs,
    proofMode, useFlashbots, useLaunchpadProof, priorityGas,
    walletFilter: wallets,
  };

  openExec();
  const sym = (CHAINS[currentChainId] || CHAINS[1]).symbol;

  // Reset all steps
  ['setup','preflight','confirm','execute','results'].forEach(s => xStep(s, '', s==='setup'?'Configure route & wallets':s==='preflight'?'Simulate & check balances':s==='confirm'?'Approve spend & gas':s==='execute'?'Submit mint to chain':'Receipts & outcomes', ''));
  document.getElementById('exec-subtitle').textContent = 'Setting up…';

  // ── STEP 1: SETUP
  xStep('setup', 'active', 'Validating…', '');
  await sleep(200);
  const chain = (CHAINS[currentChainId]||CHAINS[1]).name;
  xStep('setup', 'done', `${chain} · ${wallets.length} wallet(s) · ${proofMode}`, `Contract: ${contract.slice(0,10)}…${contract.slice(-6)} | Qty: ${qty} | Price: ${price} ${sym}`);

  // ── STEP 2: PREFLIGHT — dry run
  xStep('preflight', 'active', 'Simulating transactions…', 'Running dry-run…');
  document.getElementById('exec-subtitle').textContent = 'Simulating…';
  let preflightOk = 0, preflightFail = 0, preflightResults = [];
  try {
    const dr = await api('/api/mint', { method:'POST', body: JSON.stringify({ ..._execPayload, dryRun: true }) });
    preflightResults = dr.results || [];
    preflightOk   = preflightResults.filter(r => r.status==='dry-run-ok'||r.status==='success').length;
    preflightFail = preflightResults.filter(r => r.status!=='dry-run-ok'&&r.status!=='success').length;
    const summary = preflightResults.map(r=>`${r.walletAddress?.slice(0,8)||r.wallet||'?'}: ${r.status}${r.error?` — ${r.error.slice(0,50)}`:''}${r.fn?` [${r.fn}]`:''}`).join('\n');
    xStep('preflight', preflightFail === wallets.length ? 'error' : 'done',
      `${preflightOk}/${wallets.length} simulate OK, ${preflightFail} issue(s)`, summary);
    if (preflightFail === wallets.length && !isDryRun) {
      xStep('confirm','error','All wallets failed simulation','Check balances, contract phase, and proof mode');
      xStep('execute','','Skipped — preflight failed','');
      xStep('results','','','');
      document.getElementById('exec-subtitle').textContent = 'Preflight failed — no wallets can mint';
      document.getElementById('exec-close-btn').disabled = false;
      if (btn) btn.disabled = false;
      return;
    }
  } catch(e) {
    xStep('preflight', 'error', 'Simulation call failed', e.message?.slice(0,120));
    document.getElementById('exec-subtitle').textContent = 'Preflight error — check network';
    document.getElementById('exec-close-btn').disabled = false;
    if (btn) btn.disabled = false;
    return;
  }

  // ── STEP 3: CONFIRM (skip for dry run)
  if (isDryRun) {
    xStep('confirm','done','Dry-run mode — skipped confirmation','');
    xStep('execute','done','Dry-run complete — no tx sent','');
    xStep('results','done',`${preflightOk}/${wallets.length} would succeed`,
      preflightResults.map(r=>`${r.walletAddress?.slice(0,8)||r.wallet||'?'}: ${r.status}${r.error?' — '+r.error.slice(0,60):''}`).join('\n'));
    renderExecResults(preflightResults);
    document.getElementById('exec-subtitle').textContent = '✅ Dry run complete';
    document.getElementById('exec-close-btn').disabled = false;
    // Mirror to main page results
    document.getElementById('m-results').innerHTML = preflightResults.map(r=>buildResultCard(r,currentChainId)).join('');
    if (btn) btn.disabled = false;
    return;
  }

  // Show gas estimate + confirm dialog
  xStep('confirm', 'active', 'Review gas estimate…', '');
  document.getElementById('exec-subtitle').textContent = 'Awaiting your confirmation…';
  const estMG = await estMintGasLive(currentChainId);
  const area  = document.getElementById('exec-confirm-area');
  area.style.display = '';
  document.getElementById('exec-gas-rows').innerHTML = `
    <div class="exec-gas-row"><span class="ek">Wallets minting</span><span class="ev">${preflightOk} / ${wallets.length}</span></div>
    <div class="exec-gas-row"><span class="ek">Est. mint gas / wallet</span><span class="ev">~${estMG.toFixed(5)} ${sym}</span></div>
    <div class="exec-gas-row"><span class="ek">Total gas est.</span><span class="ev">~${(estMG*preflightOk).toFixed(5)} ${sym}</span></div>
    <div class="exec-gas-row"><span class="ek">Mint cost total</span><span class="ev">${(price*qty*preflightOk).toFixed(5)} ${sym}</span></div>
  `;

  const userConfirmed = await new Promise(res => { _execResolve = res; });
  if (!userConfirmed) {
    xStep('confirm','error','Cancelled by user','');
    xStep('execute','','Cancelled','');
    document.getElementById('exec-subtitle').textContent = 'Cancelled';
    document.getElementById('exec-close-btn').disabled = false;
    if (btn) btn.disabled = false;
    return;
  }
  xStep('confirm','done','Confirmed — executing live','');

  // ── STEP 4: EXECUTE
  xStep('execute','active','Sending transactions…','Submitting to chain…');
  document.getElementById('exec-subtitle').textContent = 'On-chain… do not close';
  let results = [];
  try {
    const live = await api('/api/mint', { method:'POST', body: JSON.stringify({ ..._execPayload, dryRun: false }) });
    results = live.results || [];
    const ok   = results.filter(r => r.status==='success').length;
    const fail = results.filter(r => r.status!=='success').length;
    const hashes = results.filter(r=>r.txHash).map(r=>`${r.walletAddress?.slice(0,8)||r.wallet||'?'}: ${r.txHash}`).join('\n');
    xStep('execute','done',`${ok} minted, ${fail} failed`, hashes || 'No tx hashes');
  } catch(e) {
    xStep('execute','error','Execution error', e.message?.slice(0,120));
    document.getElementById('exec-subtitle').textContent = '❌ Execution error';
    document.getElementById('exec-close-btn').disabled = false;
    if (btn) btn.disabled = false;
    return;
  }

  // ── STEP 5: RESULTS
  const okCount = results.filter(r=>r.status==='success').length;
  xStep('results','done',`${okCount}/${results.length} minted successfully`,'');
  document.getElementById('xb-results').textContent = String(results.length);
  renderExecResults(results);
  document.getElementById('exec-subtitle').textContent = `✅ Done — ${okCount}/${results.length} minted`;
  document.getElementById('exec-close-btn').disabled = false;
  // Mirror to main page
  document.getElementById('m-results').innerHTML = results.map(r=>buildResultCard(r,currentChainId)).join('');
  setStatus('m-status', `✅ Done — ${okCount}/${results.length} minted`, 'ok');
  if (btn) btn.disabled = false;
}

function renderExecResults(results) {
  const list = document.getElementById('exec-results-list');
  if (!list) return;
  list.innerHTML = results.map(r => {
    const ok = r.status==='success'||r.status==='dry-run-ok';
    const addr = r.walletAddress?.slice(0,8)||r.wallet||'?';
    const color = ok ? 'var(--green)' : 'var(--red)';
    const icon = ok ? '✓' : '✕';
    return `<div style="display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12px">
      <span style="color:${color};font-weight:700;font-size:14px">${icon}</span>
      <span style="font-family:var(--mono)">${addr}…</span>
      <span style="color:${color};flex:1;text-align:right">${r.status}${r.error?` · ${r.error.slice(0,40)}`:''}${r.txHash?` · ${r.txHash.slice(0,10)}…`:''}</span>
    </div>`;
  }).join('');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const CHAINS = {
  1: { name: 'Ethereum', symbol: 'ETH', explorer: 'https://etherscan.io' },
  8453: { name: 'Base', symbol: 'ETH', explorer: 'https://basescan.org' },
  42161: { name: 'Arbitrum', symbol: 'ETH', explorer: 'https://arbiscan.io' },
  10: { name: 'Optimism', symbol: 'ETH', explorer: 'https://optimistic.etherscan.io' },
  137: { name: 'Polygon', symbol: 'POL', explorer: 'https://polygonscan.com' },
  56: { name: 'BNB Chain', symbol: 'BNB', explorer: 'https://bscscan.com' },
  81457: { name: 'Blast', symbol: 'ETH', explorer: 'https://blastscan.io' },
  59144: { name: 'Linea', symbol: 'ETH', explorer: 'https://lineascan.build' },
  7777777: { name: 'Zora', symbol: 'ETH', explorer: 'https://explorer.zora.energy' },
  43114: { name: 'Avalanche', symbol: 'AVAX', explorer: 'https://snowscan.xyz' },
  33139: { name: 'ApeChain', symbol: 'APE', explorer: 'https://apescan.io' },
  4663: { name: 'Robinhood Chain', symbol: 'ETH', explorer: 'https://robinhoodchain.blockscout.com' },
};

const API_BASE = window.location.origin;

// ── HELPERS ───────────────────────────────────────────────────────────────────
function toast(msg, type = '', duration = null) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `toast ${type} show`;
  clearTimeout(el._timer); el._timer = setTimeout(() => el.classList.remove('show'), duration || (type === 'red' ? 7000 : 3000));
}
function setStatus(id, msg, type = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg; el.className = `status ${type}`;
}
function api(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } })
    .then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      return data;
    });
}

// ── CHAIN SELECTOR ────────────────────────────────────────────────────────────
function updateChainDisplay() {
  const chain = CHAINS[currentChainId] || CHAINS[1];
  // FIX: this used to do document.querySelectorAll('.chain-pill').forEach(el =>
  // el.textContent = chain.name) — .chain-pill is the DIV THAT WRAPS the real
  // <select id="global-chain"> dropdown (plus the chain-dot indicator).
  // Setting .textContent on it destroys BOTH children, replacing the entire
  // interactive select with a plain static text node showing just the chain
  // name. This ran on every page load, right after the code that correctly
  // set the select's value — so the dropdown was being set up correctly and
  // then immediately destroyed a moment later. This is almost certainly THE
  // root cause of "the chain switcher is static and doesn't work" — after
  // this ran, it genuinely wasn't a dropdown anymore. The select already
  // displays its own selected option's text natively; nothing here needs to
  // touch it at all.
  document.querySelectorAll('.unit-symbol').forEach(el => {
    el.textContent = chain.symbol || 'ETH';
  });
}

// [removed: dead chain-select listener — element no longer exists in current HTML,
//  chain switching is handled by the inline script's switchToChain()]

// ── TABS ──────────────────────────────────────────────────────────────────────
// NOTE: index.html inline script registers its own tab handler for page-specific
// loaders (loadWalletChecks, loadNFTs, loadMasterInfo etc.). This handler here
// only handles schedule-interval cleanup and page visibility toggling.
// Do NOT duplicate page-load calls here — that causes double-fetch and the
// null-textContent crash on Portfolio (nft-listed-count / nft-count missing).
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const targetPage = document.getElementById(`page-${tab.dataset.page}`);
    if (targetPage) targetPage.classList.add('active');
    // FIX (Bug 2): reset scroll to top on every tab switch — prevents mobile
    // "content disappeared" problem where user scrolled down in prior tab.
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (tab.dataset.page !== 'schedule' && _scheduleTickInterval) {
      clearInterval(_scheduleTickInterval); _scheduleTickInterval = null;
    }
    // Page-specific loaders are handled exclusively by the inline script in
    // index.html. Only schedule-tick management lives here now.
  });
});

// [removed: dead duplicate loadOverview() — the inline script in index.html
//  defines its own loadOverview() that loads after this file and always wins;
//  this copy also referenced ov-address/ov-balance, which don't exist in the
//  current HTML, so it would have crashed if it ever somehow ran]

// [removed: dead duplicate loadWallets() + w-refresh listener — the inline
//  script's loadWallets() always wins (loads after this file), and w-refresh
//  doesn't exist in the current HTML so this listener never attached anyway]

// Generic wallet checklist renderer — used on Mint, Fund, and Sweep pages so
// the user can pick exactly which wallet(s) an action applies to.
// containerId: the <div> to render into
// prefix: unique id prefix for this instance's controls/balances (e.g. 'm', 'f', 'sw')
async function renderWalletSelect(containerId, prefix) {
  const c = document.getElementById(containerId);
  if (!c) return;
  c.innerHTML = '<div class="empty-text">Loading wallets...</div>';
  try {
    const data = await api('/api/wallets');
    if (!data.wallets.length) { c.innerHTML = '<div class="empty-text">No wallets yet — add one in the Wallets tab.</div>'; return; }

    c.innerHTML = `
      <div class="wallet-select-controls">
        <button type="button" class="btn btn-outline btn-sm" data-act="all">Select All</button>
        <button type="button" class="btn btn-outline btn-sm" data-act="none">Deselect All</button>
      </div>
      ` + data.wallets.map((w, i) => `
        <label class="wallet-select-item">
          <input type="checkbox" value="${w.address}" checked/>
          <span class="wallet-select-addr">${w.address.slice(0,8)}...${w.address.slice(-6)}</span>
          <span class="wallet-select-lbl">${w.label || `Wallet ${i + 1}`}</span>
          <span class="wallet-select-bal" id="${prefix}wb-${w.address}">⏳</span>
        </label>`).join('');

    c.querySelector('[data-act="all"]').addEventListener('click', () => {
      c.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true);
    });
    c.querySelector('[data-act="none"]').addEventListener('click', () => {
      c.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
    });

    try {
      const balData = await api(`/api/wallets/balances?chainId=${currentChainId}`);
      balData.balances.forEach(b => {
        const el = document.getElementById(`${prefix}wb-${b.address}`);
        if (el) el.textContent = b.balance !== null ? `${parseFloat(b.balance).toFixed(5)} ${(CHAINS[currentChainId] || CHAINS[1]).symbol}` : '—';
      });
    } catch (e) {
      c.querySelectorAll('.wallet-select-bal').forEach(el => el.textContent = '—');
    }
  } catch(e) { c.innerHTML = '<div class="empty-text">Failed to load wallets</div>'; }
}

// Returns the addresses checked inside a wallet-select container
function getSelectedWallets(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input[type=checkbox]:checked`)).map(cb => cb.value);
}

// Backwards-compatible name used by the mint page
function loadWalletSelect() { return renderWalletSelect('m-wallet-select', 'm'); }

// [removed: dead w-add-btn/w-newkey/w-newlabel wallet-add listener — these
//  elements don't exist in the current HTML. This was the original broken
//  "Add Wallet" code (posted to the wrong endpoint too); the live version
//  is addWallet() in index.html's inline script, already fixed separately.]

async function removeWalletUI(address) {
  if (!confirm(`Remove wallet ${address.slice(0,8)}...?`)) return;
  try {
    await api(`/api/wallets/${address}`, { method: 'DELETE' });
    toast('Wallet removed', 'gold');
    loadWallets();
  } catch(e) { toast(`Failed: ${e.message}`, 'red'); }
}

// ── MINT ──────────────────────────────────────────────────────────────────────
// [old mint listener removed — see v20 override below]

// ── SCHEDULE ──────────────────────────────────────────────────────────────────
// Fire-in-N-seconds helper — calculates datetime from now and fills the picker
document.getElementById('s-delay-set')?.addEventListener('click', () => {
  const secs = parseInt(document.getElementById('s-delay-sec').value);
  if (!secs || secs < 1) { toast('Enter a positive number of seconds', 'red'); return; }
  const target = new Date(Date.now() + secs * 1000);
  // datetime-local needs "YYYY-MM-DDTHH:MM:SS" in local time
  const pad = n => String(n).padStart(2, '0');
  const local = `${target.getFullYear()}-${pad(target.getMonth()+1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}:${pad(target.getSeconds())}`;
  document.getElementById('s-time').value = local;
  document.getElementById('s-delay-preview').textContent = `→ ${target.toLocaleTimeString()}`;
  toast(`Time set: fires in ${secs}s at ${target.toLocaleTimeString()}`, 'green');
});

document.getElementById('s-trigger-mode')?.addEventListener('change', (e) => {
  const phaseField = document.getElementById('s-phase-interval-field');
  const timeField  = document.getElementById('s-time');
  if (phaseField) phaseField.style.display = (e.target.value === 'phase' || e.target.value === 'both') ? '' : 'none';
  if (timeField)  timeField.placeholder = e.target.value === 'phase' ? 'Not required for phase-only mode' : '';
});

document.getElementById('s-btn')?.addEventListener('click', async () => {
  const contract = document.getElementById('s-contract').value.trim();
  const time     = document.getElementById('s-time').value;
  const qty      = parseInt(document.getElementById('s-qty').value);
  const price    = parseFloat(document.getElementById('s-price').value);
  const fn       = document.getElementById('s-fn').value.trim();
  const gwei     = document.getElementById('s-gwei').value.trim();
  const timeout  = parseInt(document.getElementById('s-timeout').value) || 60;
  const dryRun   = document.getElementById('s-dryrun').checked;
  const triggerMode = document.getElementById('s-trigger-mode')?.value || 'time';
  const phaseInterval = parseInt(document.getElementById('s-phase-interval')?.value) || 5000;
  // v15: merkle proof for scheduled whitelist mints
  const sProofRaw   = document.getElementById('s-proof').value.trim();
  const sMerkleProof = sProofRaw
    ? sProofRaw.split(/[,\s]+/).map(s => s.trim()).filter(s => /^0x[0-9a-fA-F]{64}$/.test(s))
    : [];

  const selectedWallets = getSelectedWallets('s-wallet-select');
  if (!selectedWallets.length) { setStatus('s-status', '❌ Select at least one wallet', 'err'); return; }

  // v18: gas escalation + proof mode (merged inline to avoid stale-state race)
  const gasEscalate = parseInt(document.getElementById('s-gas-escalate')?.value) || 10;
  const proofMode   = document.getElementById('s-proof-mode')?.value || 'none';
  let eip712Sigs = null;
  if (proofMode === 'eip712') {
    try { eip712Sigs = JSON.parse(document.getElementById('s-eip712')?.value.trim()); } catch { toast('Invalid EIP-712 JSON', 'red'); return; }
  }
  const schedExtra = { gasEscalatePercent: gasEscalate, proofMode, eip712Sigs, useLaunchpadProof: proofMode === 'launchpad', useFlashbots: proofMode === 'flashbots' };

  if (!contract || isNaN(qty) || isNaN(price)) { setStatus('s-status', '❌ Fill contract, qty and price', 'err'); return; }

  let mintTime = null;
  if (triggerMode !== 'phase') {
    if (!time) { setStatus('s-status', '❌ Set a mint time, or switch to Phase-poll-only mode', 'err'); return; }
    mintTime = new Date(time).toISOString();
    // FIX (v26): 3s grace window matches scheduler.js/server.js — typing
    // "now" and hitting submit a moment later shouldn't be rejected.
    if (new Date(mintTime).getTime() < Date.now() - 3000) { setStatus('s-status', '❌ Time is in the past', 'err'); return; }
  } else if (time) {
    // user can still set a "don't poll before this time" anchor — optional
    mintTime = new Date(time).toISOString();
  }

  setStatus('s-status', dryRun ? '🧪 Dry-run scheduled...' : '⏳ Scheduling...', 'loading');
  document.getElementById('s-btn').disabled = true;
  try {
    const data = await api('/api/schedule', {
      method: 'POST',
      body: JSON.stringify({
        contractAddress: contract, mintTime, quantity: qty, mintPrice: price,
        customFn: fn || null, gweiOverride: gwei ? parseFloat(gwei) : null,
        timeoutSeconds: timeout, chainId: currentChainId, dryRun, merkleProof: sMerkleProof,
        walletFilter: selectedWallets,
        triggerMode, phaseCheckIntervalMs: phaseInterval,
        ...schedExtra,
      }),
    });
    if (data.error) { setStatus('s-status', `❌ ${data.error}`, 'err'); }
    else {
      const modeLabel = triggerMode === 'phase' ? 'phase-poll' : triggerMode === 'both' ? 'time + phase-poll' : 'time';
      setStatus('s-status', `✅ Scheduled (${modeLabel}, ${selectedWallets.length} wallets)! ID: ${data.scheduleId.slice(0,8)}${dryRun ? ' (dry run)' : ''}`, 'ok');
      toast('Mint scheduled', 'green');
      setTimeout(loadSchedules, 500);
      // FIX (v26): a schedule can die almost instantly (bad time, RPC error,
      // etc). Previously nothing told the user — the Active list just never
      // showed it and Results never got checked. Now we poll Results too,
      // right after firing, so a fast failure shows up within a few seconds
      // instead of looking like the request vanished into nothing.
      setTimeout(loadScheduleResults, 4000);
      setTimeout(loadScheduleResults, 10000);
    }
  } catch(e) { setStatus('s-status', `❌ ${e.message}`, 'err'); }
  document.getElementById('s-btn').disabled = false;
});

async function loadSchedules() {
  const c = document.getElementById('s-list');
  try {
    const data = await api('/api/schedules');
    if (_scheduleTickInterval) { clearInterval(_scheduleTickInterval); _scheduleTickInterval = null; }
    if (!data.schedules.length) { c.innerHTML = '<div class="empty"><div class="empty-icon">📅</div><div class="empty-text">No schedules</div></div>'; return; }
    c.innerHTML = data.schedules.map(s => {
      const rem = Math.max(0, Math.round((new Date(s.mintTime) - Date.now()) / 1000));
      return `<div class="schedule-item"><div class="schedule-info"><div class="schedule-contract">${s.contractAddress.slice(0,12)}...${s.contractAddress.slice(-6)}</div><div class="schedule-time">${new Date(s.mintTime).toLocaleString()}</div><div class="schedule-countdown" data-mint-time="${s.mintTime}">⏳ ${formatTime(rem)}</div></div><button class="btn btn-danger btn-sm" onclick="cancelSchedule('${s.id}')">Cancel</button></div>`;
    }).join('');

    // Live countdown — ticks every second without re-fetching from the server.
    // Once a countdown hits 0, refresh the whole list (schedule likely fired).
    _scheduleTickInterval = setInterval(() => {
      let anyHitZero = false;
      document.querySelectorAll('.schedule-countdown').forEach(el => {
        const mintTime = el.dataset.mintTime;
        const rem = Math.max(0, Math.round((new Date(mintTime) - Date.now()) / 1000));
        el.textContent = `⏳ ${formatTime(rem)}`;
        if (rem === 0) anyHitZero = true;
      });
      if (anyHitZero) {
        clearInterval(_scheduleTickInterval);
        _scheduleTickInterval = null;
        setTimeout(loadSchedules, 3000); // give the scheduler a moment to fire, then refresh
      }
    }, 1000);
  } catch(e) { c.innerHTML = '<div class="empty"><div class="empty-icon">❌</div></div>'; }
}
async function cancelSchedule(id) {
  try { await api(`/api/schedules/${id}`, { method: 'DELETE' }); toast('Cancelled', 'gold'); loadSchedules(); }
  catch(e) { toast('Cancel failed', 'red'); }
}
document.getElementById('s-refresh')?.addEventListener('click', loadSchedules);

// ── SCHEDULE RESULTS (what happened when a schedule fired) ──────────────────
async function loadScheduleResults() {
  const c = document.getElementById('sr-list');
  if (!c) return;
  try {
    const data = await api('/api/schedules/results');
    const results = data.results || [];
    if (!results.length) { c.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">No completed schedules yet</div></div>'; return; }

    const outcomeIcon = { success: '✅', partial: '⚠️', failed: '❌', sold_out: '🚫', paused: '⏸' };
    c.innerHTML = results.slice(0, 10).map(r => {
      const chain = CHAINS[r.chainId] || CHAINS[1];
      const successCount = (r.results || []).filter(x => x.status === 'success').length;
      const total = (r.results || []).length;
      const detail = (r.results || []).map(x => {
        const tx = x.txHash ? `<a href="${chain.explorer}/tx/${x.txHash}" target="_blank" style="color:${(CHAINS[r.chainId]||CHAINS[1]).symbol==='APE'?'#00E5FF':'#f0b429'}">🔗 tx</a>` : '';
        return `<div style="font-size:11px;color:#888;margin-top:2px">${x.walletAddress ? x.walletAddress.slice(0,8)+'...' : ''} — ${x.status}${x.error ? `: ${x.error.slice(0,80)}` : ''} ${tx}</div>`;
      }).join('');
      return `<div style="padding:10px;margin:6px 0;background:#1a1a2e;border-radius:8px;font-size:12px">
        ${outcomeIcon[r.outcome] || '❓'} <b>${r.outcome.toUpperCase()}</b> — ${successCount}/${total} succeeded
        <div style="font-size:11px;color:#888;margin-top:2px">${r.contractAddress.slice(0,10)}... · ${new Date(r.completedAt).toLocaleString()}</div>
        ${detail}
      </div>`;
    }).join('');
  } catch(e) { c.innerHTML = '<div class="empty"><div class="empty-icon">❌</div><div class="empty-text">Failed to load</div></div>'; }
}
document.getElementById('sr-refresh')?.addEventListener('click', loadScheduleResults);

function formatTime(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  if (h > 0) return `${h}h ${m}m ${sec}s`; if (m > 0) return `${m}m ${sec}s`; return `${sec}s`;
}

// ── FUND / DRAIN ──────────────────────────────────────────────────────────────
// Fund button uses onclick="doFund()" defined in index.html — no duplicate handler here.
// Drain button (d-btn) is handled by the drain section in index.html similarly.

// ── NFT PORTFOLIO ─────────────────────────────────────────────────────────────
// FIX (Bug 1): These functions are overridden by the inline <script> in index.html
// which runs after this file. These stay here as null-guarded fallbacks so they
// can never crash when called from stale code paths.
async function loadNFTs() {
  const c = document.getElementById('nft-list');
  if (!c) return;
  c.innerHTML = '<div class="empty"><div class="empty-icon">⏳</div><div class="empty-text">Loading NFTs...</div></div>';
  try {
    const contractFilter = document.getElementById('nft-contract-filter')?.value?.trim() || '';
    const contractParam = contractFilter ? `&contract=${encodeURIComponent(contractFilter)}` : '';
    const data = await api(`/api/nfts/all?chainId=${currentChainId}${contractParam}`);
    // FIX: null-guard — nft-count may not exist in all index.html versions
    const countEl = document.getElementById('nft-count');
    if (countEl) countEl.textContent = data.count || (data.nfts||[]).length;
    const nfts = data.nfts || [];
    if (!nfts.length) {
      c.innerHTML = (data.errors&&data.errors.length)
        ? `<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-text">${data.errors[0].error}</div></div>`
        : '<div class="empty"><div class="empty-icon">🎨</div><div class="empty-text">No NFTs on this chain</div></div>';
      return;
    }
    c.innerHTML = nfts.slice(0, 30).map(n => `
      <div class="nft-card">
        <div class="nft-thumb">${(n.imageUrl||n.image_url) ? `<img src="${n.imageUrl||n.image_url}" loading="lazy" onerror="this.style.display='none'"/>` : '🖼'}</div>
        <div class="nft-meta">
          <div class="nft-name">${n.name||'#'+(n.tokenId||n.identifier)}</div>
          <div class="nft-detail">${(n.contract||n.contractAddress||'').slice(0,10)}… #${n.tokenId||n.identifier}</div>
          <div class="nft-detail" style="color:var(--gold)">${n.walletLabel||n.wallet?.slice(0,10)||''}</div>
        </div>
        <button class="nft-list-btn" onclick="prefillList('${n.contract||n.contractAddress}','${n.tokenId||n.identifier}')">List</button>
      </div>`).join('');
  } catch(e) { c.innerHTML = `<div class="empty"><div class="empty-icon">❌</div><div class="empty-text">${e.message}</div></div>`; }
}

async function loadListedCount() {
  try {
    const data = await api(`/api/nfts/listed?chainId=${currentChainId}`);
    // FIX: null-guards — these IDs may not exist in all index.html versions
    const countEl = document.getElementById('nft-listed-count');
    if (countEl) countEl.textContent = data.totalCount || 0;
    const c = document.getElementById('nft-listed-list');
    if (!c) return;
    if (!data.totalCount) { c.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">No active listings</div></div>'; return; }
    c.innerHTML = (data.wallets||[]).filter(w => w.count > 0).map(w =>
      `<div class="listed-wallet"><strong>${w.wallet.slice(0,8)}...</strong> — ${w.count} listed
       ${(w.listings||[]).map(l => `<div class="listed-item">📄 #${l.tokenId} @ ${parseFloat(l.price).toFixed(4)} ${(CHAINS[currentChainId]||CHAINS[1]).symbol}</div>`).join('')}</div>`
    ).join('');
  } catch(e) {
    const el = document.getElementById('nft-listed-count');
    if (el) el.textContent = '?';
  }
}
function openListModal(wallet, contract, tokenId) {
  document.getElementById('list-wallet').value  = wallet;
  document.getElementById('list-contract').value = contract;
  document.getElementById('list-tokenid').value  = tokenId;
  document.getElementById('list-price').value    = '';
  document.getElementById('list-modal').style.display = 'flex';
}
document.getElementById('list-modal-close')?.addEventListener('click', () => {
  document.getElementById('list-modal').style.display = 'none';
});
document.getElementById('list-confirm-btn')?.addEventListener('click', async () => {
  const wallet   = document.getElementById('list-wallet').value;
  const contract = document.getElementById('list-contract').value;
  const tokenId  = document.getElementById('list-tokenid').value;
  const price    = parseFloat(document.getElementById('list-price').value);
  if (isNaN(price) || price <= 0) { toast('Enter valid price', 'red'); return; }
  document.getElementById('list-confirm-btn').disabled = true;
  try {
    const data = await api('/api/nfts/list', { method: 'POST', body: JSON.stringify({ walletAddress: wallet, contractAddress: contract, tokenId, priceEth: price, chainId: currentChainId }) });
    if (data.error) throw new Error(data.error);
    toast(`Listed #${tokenId} @ ${price} ${(CHAINS[currentChainId] || CHAINS[1]).symbol}`, 'green');
    document.getElementById('list-modal').style.display = 'none';
    loadNFTs(); loadListedCount();
  } catch(e) { toast(`List failed: ${e.message}`, 'red', 9000); }
  document.getElementById('list-confirm-btn').disabled = false;
});

async function listAtFloor(wallet, contract, tokenId) {
  if (!confirm(`List #${tokenId} at floor price?`)) return;
  const errContainer = document.getElementById('nft-action-error');
  if (errContainer) errContainer.innerHTML = '';
  try {
    const data = await api('/api/nfts/list-floor', { method: 'POST', body: JSON.stringify({ walletAddress: wallet, contractAddress: contract, tokenId, chainId: currentChainId }) });
    if (data.error) throw new Error(data.error);
    toast(`Listed at floor!`, 'green'); loadNFTs(); loadListedCount();
  } catch(e) {
    const msg = e.message || '';
    // ── v13: Parse OpenSea errors into readable cards ──────────────────────
    let title = '❌ Floor Listing Failed';
    let detail = msg;
    let hint = '';

    if (msg.includes('No floor price found') || msg.includes('no active listings')) {
      title = '⚠️ No Floor Price Yet';
      detail = 'This collection has no active listings on OpenSea — it may be newly launched or you\'re the first to list.';
      hint = '💡 Use the <strong>💰 List</strong> button instead and set your own price.';
    } else if (msg.includes('validation') || msg.includes('422') || msg.includes('400')) {
      title = '⚠️ OpenSea Validation Error';
      detail = 'OpenSea rejected the listing order. Common causes: NFT not yet indexed by OpenSea, wrong chain, or approval not set.';
      hint = `<details style="margin-top:6px"><summary style="cursor:pointer;color:#aaa;font-size:11px">Raw error ▸</summary><pre style="font-size:10px;white-space:pre-wrap;color:#888;margin-top:4px">${msg.slice(0, 400)}</pre></details>`;
    } else if (msg.toLowerCase().includes('opensea api error')) {
      title = '⚠️ OpenSea API Error';
      detail = msg.replace('OpenSea API error:', '').trim().slice(0, 200);
      hint = '💡 Check your OPENSEA_API_KEY is valid and not rate-limited.';
    } else if (msg.includes('No OpenSea collection found')) {
      title = '⚠️ Collection Not Found';
      detail = 'OpenSea doesn\'t have this contract indexed yet. It may be too new.';
      hint = '💡 Try again in a few minutes, or list manually.';
    }

    toast('Floor listing failed — see error below', 'red', 5000);
    if (errContainer) {
      errContainer.innerHTML = `
        <div class="api-error-box">
          <div style="font-weight:700;font-size:13px;margin-bottom:6px">${title}</div>
          <div style="margin-bottom:${hint ? '8px' : '0'}">${detail}</div>
          ${hint ? `<div>${hint}</div>` : ''}
        </div>`;
    } else {
      toast(`Floor list failed: ${msg.slice(0,100)}`, 'red', 10000);
    }
  }
}

document.getElementById('nft-refresh')?.addEventListener('click', () => { loadNFTs(); loadListedCount(); });

// [removed: dead sweep-btn listener block — sweep-btn/sweep-contract/
//  sweep-price/sweep-qty don't exist in current HTML; doSweep() in the
//  inline script is the live implementation]

// [removed: dead "master wallet" block (loadMaster/master-set-btn/master-clear-btn)
//  — none of its element IDs exist in current HTML. The live equivalents are
//  setMaster()/loadMasterInfo() in the inline script.]

// [removed: dead auto-balance block — ab-run-btn/ab-min/ab-target/ab-status
//  don't exist in current HTML; autoBalance() in the inline script is the
//  live implementation]

// [removed: dead checkDiscordStatus() — discord-status element doesn't exist
//  in current HTML and this function's only call site was removed above]

// ── INIT ──────────────────────────────────────────────────────────────────────
// FIX: this used to be document.getElementById('chain-select').value = ... with
// no null-check. That element doesn't exist in the current HTML, so this threw
// a TypeError on every single page load and silently killed everything after it
// in this block (updateChainDisplay/loadOverview/loadWalletSelect/checkDiscordStatus
// never ran). loadOverview/loadWalletSelect were dead duplicates anyway (the
// inline script's loadWalletChecks('m-wallet-select') already covers wallet-select
// init), and discord-status doesn't exist either — so only updateChainDisplay()
// is actually worth keeping here.
//
// FIX #2: this was still targeting the wrong id even after being made safe —
// the real dropdown is #global-chain, not #chain-select. Without this fix,
// even once chain selection started persisting to localStorage correctly,
// the visible dropdown would never reflect the restored value on a fresh
// page load — it would always visually show Ethereum (the first <option>)
// regardless of what was actually saved, looking exactly like a stuck/static
// selector even though the underlying state was correct.
const chainSelectEl = document.getElementById('global-chain');
if (chainSelectEl) chainSelectEl.value = currentChainId;
updateChainDisplay();


// ── MINT HISTORY ─────────────────────────────────────────────────────────────
let historyChart = null;

async function loadMintHistory() {
  try {
    const data = await api('/api/mint-history');
    const history = (data.history || []).slice().reverse(); // newest first
    renderHistoryChart(history);
    renderHistoryCards(history);
  } catch(e) {
    console.error('History load failed:', e);
  }
}

function renderHistoryChart(history) {
  const canvas = document.getElementById('history-chart');
  const empty  = document.getElementById('history-empty');

  if (!history.length) {
    canvas.style.display = 'none';
    empty.style.display  = 'block';
    return;
  }
  canvas.style.display = 'block';
  empty.style.display  = 'none';

  // Show last 20 sessions on chart
  const display = history.slice(0, 20).reverse();
  const labels  = display.map(h => {
    const d = new Date(h.timestamp);
    return `${h.collectionName?.slice(0,14) || 'Unknown'}\n${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
  });

  if (historyChart) { historyChart.destroy(); historyChart = null; }

  historyChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Success',
          data: display.map(h => h.successCount),
          backgroundColor: 'rgba(96, 230, 150, 0.85)',
          borderColor:     'rgba(96, 230, 150, 1)',
          borderWidth: 1,
          borderRadius: 6,
        },
        {
          label: 'Failed',
          data: display.map(h => h.failCount),
          backgroundColor: 'rgba(224, 96, 160, 0.85)',
          borderColor:     'rgba(224, 96, 160, 1)',
          borderWidth: 1,
          borderRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { labels: { color: '#c0b8d8', font: { family: 'Space Grotesk', size: 13 } } },
        title: {
          display: true,
          text: 'ArenaX Mint Bot — Session History',
          color: '#e0d8f8',
          font: { family: 'Space Grotesk', size: 16, weight: '700' },
          padding: { bottom: 16 },
        },
        tooltip: {
          callbacks: {
            afterBody: (items) => {
              const h = display[items[0].dataIndex];
              return [`Total: ${h.totalCount}`, `Contract: ${h.contractAddress?.slice(0,14)}...`];
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#888', font: { size: 10 } }, grid: { color: '#1e1e30' } },
        y: { ticks: { color: '#888', stepSize: 1 }, grid: { color: '#1e1e30' }, beginAtZero: true },
      },
    },
  });
}

function renderHistoryCards(history) {
  const container = document.getElementById('history-cards');
  container.innerHTML = '';

  history.slice(0, 50).forEach(h => {
    const successPct = h.totalCount > 0 ? Math.round((h.successCount / h.totalCount) * 100) : 0;
    const statusColor = successPct === 100 ? '#60e696' : successPct >= 50 ? '#f0b840' : '#e060a0';
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'display:grid;grid-template-columns:56px 1fr auto;gap:14px;align-items:center;padding:14px 16px;';
    card.innerHTML = `
      <div style="width:52px;height:52px;border-radius:12px;overflow:hidden;background:#1a1a2e;border:2px solid #2a2a4e;flex-shrink:0;">
        ${h.collectionImage
          ? `<img src="${h.collectionImage}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.parentNode.innerHTML='<div style=\\'display:flex;align-items:center;justify-content:center;height:100%;font-size:22px;\\'>🖼️</div>';"/>`
          : '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:22px;">🖼️</div>'
        }
      </div>
      <div>
        <div style="font-weight:700;font-size:14px;color:#e0d8f8;margin-bottom:2px;">${h.collectionName || 'Unknown Collection'}</div>
        <div style="font-size:11px;color:#666;font-family:'Space Mono',monospace;">${h.contractAddress?.slice(0,8)}...${h.contractAddress?.slice(-6)}</div>
        <div style="font-size:12px;color:#888;margin-top:4px;">${new Date(h.timestamp).toLocaleString()}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:22px;font-weight:700;color:${statusColor};">${successPct}%</div>
        <div style="font-size:12px;color:#60e696;">✓ ${h.successCount}</div>
        <div style="font-size:12px;color:#e060a0;">✗ ${h.failCount}</div>
      </div>
    `;
    container.appendChild(card);
  });
}

// Download chart as PNG with branding
document.getElementById('history-download-btn')?.addEventListener('click', async () => {
  const canvas = document.getElementById('history-chart');
  if (!canvas || canvas.style.display === 'none') {
    toast('No history to download yet', 'red'); return;
  }

  // Create offscreen canvas with padding + branding
  const offscreen = document.createElement('canvas');
  const padding = 32;
  offscreen.width  = canvas.width  + padding * 2;
  offscreen.height = canvas.height + padding * 2 + 48; // extra space for branding bar
  const ctx = offscreen.getContext('2d');

  // Background
  ctx.fillStyle = '#0d0d1a';
  ctx.fillRect(0, 0, offscreen.width, offscreen.height);

  // Chart
  ctx.drawImage(canvas, padding, padding);

  // Branding bar at bottom
  const barY = offscreen.height - 42;
  ctx.fillStyle = '#13132a';
  ctx.fillRect(0, barY, offscreen.width, 42);

  ctx.font = 'bold 14px "Space Grotesk", sans-serif';
  ctx.fillStyle = '#c0a0f8';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚡ ArenaX Mint Bot', padding, barY + 14);

  ctx.font = '12px "Space Mono", monospace';
  ctx.fillStyle = '#666';
  ctx.fillText('arenax-mint-bot.onrender.com', padding, barY + 30);

  ctx.font = '12px "Space Grotesk", sans-serif';
  ctx.fillStyle = '#555';
  ctx.textAlign = 'right';
  ctx.fillText(new Date().toLocaleString(), offscreen.width - padding, barY + 22);

  // Download
  const link = document.createElement('a');
  link.download = `arenax-mint-history-${new Date().toISOString().slice(0,10)}.png`;
  link.href = offscreen.toDataURL('image/png');
  link.click();
  toast('Chart downloaded!', 'green');
});

document.getElementById('history-clear-btn')?.addEventListener('click', async () => {
  if (!confirm('Clear all mint history? This cannot be undone.')) return;
  try {
    await api('/api/mint-history', { method: 'DELETE' });
    if (historyChart) { historyChart.destroy(); historyChart = null; }
    document.getElementById('history-cards').innerHTML = '';
    document.getElementById('history-chart').style.display = 'none';
    document.getElementById('history-empty').style.display = 'block';
    toast('History cleared', 'green');
  } catch(e) { toast('Clear failed: ' + e.message, 'red'); }
});

// ═══════════════════════════════════════════════════════════════════
// v18 ADDITIONS — Phase Check, Eligibility, Proof Mode UI, Spend Limits
// ═══════════════════════════════════════════════════════════════════

// ── PROOF MODE TOGGLE ────────────────────────────────────────────────────────
function onMintProofModeChange() {
  const mode = document.getElementById('m-proof-mode')?.value || 'none';
  const show = (id, visible) => { const el = document.getElementById(id); if (el) el.style.display = visible ? '' : 'none'; };
  show('m-proof-single-field', mode === 'single');
  show('m-proof-map-field',    mode === 'map');
  show('m-eip712-field',       mode === 'eip712');
}

document.getElementById('s-proof-mode')?.addEventListener('change', (e) => {
  const el = document.getElementById('s-eip712-field');
  if (el) el.style.display = e.target.value === 'eip712' ? '' : 'none';
});

// [removed: dead PHASE CHECK block (pc-btn/pc-contract/pc-result) and dead
//  ELIGIBILITY CHECK block (el-btn/el-result) — none of these elements exist
//  in current HTML. checkPhase()/checkEligibility() in the inline script
//  (wired to pi-contract/el-contract) are the live implementations.]

// ── WALLET SPEND LIMIT & LABEL (in wallet list) ───────────────────────────────
async function renameWallet(address) {
  const label = prompt(`New label for ${address.slice(0,8)}... (e.g. "Hot1", "Sniper2"):`);
  if (!label) return;
  try {
    await api(`/api/wallets/${address}/label`, { method: 'PATCH', body: JSON.stringify({ label }) });
    toast(`Renamed to "${label}"`, 'green');
    loadWallets();
  } catch(e) { toast(`Failed: ${e.message}`, 'red'); }
}

async function setSpendLimit(address) {
  const sym = (CHAINS[currentChainId] || CHAINS[1]).symbol;
  const input = prompt(`Spend limit for ${address.slice(0,8)}... (${sym}, e.g. 0.05) — leave blank to remove:`);
  if (input === null) return;
  const limitEth = input === '' ? null : parseFloat(input);
  try {
    await api(`/api/wallets/${address}/spend-limit`, { method: 'PATCH', body: JSON.stringify({ limitEth }) });
    toast(limitEth === null ? 'Spend limit removed' : `Limit set: ${limitEth} ${sym}`, 'green');
    loadWallets();
  } catch(e) { toast(`Failed: ${e.message}`, 'red'); }
}

// Override loadWallets to show label, spend limit, and action buttons
async function loadWallets() {
  const c = document.getElementById('w-list');
  c.innerHTML = '<div class="empty"><div class="empty-icon">⏳</div><div class="empty-text">Loading...</div></div>';
  try {
    const data = await api('/api/wallets');
    if (!data.wallets.length) { c.innerHTML = '<div class="empty"><div class="empty-icon">👛</div><div class="empty-text">No wallets yet.</div></div>'; return; }
    c.innerHTML = data.wallets.map((w, i) => `
      <div class="wallet-item">
        <div class="wallet-left">
          <div class="wallet-avatar">${w.label ? w.label.slice(0,2).toUpperCase() : i + 1}</div>
          <div>
            <div class="wallet-addr">${w.address.slice(0,8)}...${w.address.slice(-6)}</div>
            <div class="wallet-lbl">${w.label || `Wallet ${i + 1}`}${w.spendLimit != null ? ` · 🚦 ${w.spendLimit} ${(CHAINS[currentChainId] || CHAINS[1]).symbol} max` : ''}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <div class="wallet-bal" id="wb-${w.address}">⏳</div>
          <button class="btn btn-outline btn-sm" onclick="renameWallet('${w.address}')">✏️</button>
          <button class="btn btn-outline btn-sm" onclick="setSpendLimit('${w.address}')">🚦</button>
          <button class="btn btn-danger btn-sm" onclick="removeWalletUI('${w.address}')">✕</button>
        </div>
      </div>`).join('');
    try {
      const balData = await api(`/api/wallets/balances?chainId=${currentChainId}`);
      balData.balances.forEach(b => {
        const el = document.getElementById(`wb-${b.address}`);
        if (el) el.textContent = b.balance !== null ? `${parseFloat(b.balance).toFixed(5)} ${(CHAINS[currentChainId] || CHAINS[1]).symbol}` : '—';
      });
    } catch {}
  } catch(e) { c.innerHTML = '<div class="empty"><div class="empty-icon">❌</div><div class="empty-text">Failed</div></div>'; }
}

// ── MINT: wire proof mode into POST body ───────────────────────────────────────
// Override the existing m-btn click handler
document.getElementById('m-btn')?.addEventListener('click', async () => {
  const contract = document.getElementById('m-contract')?.value.trim();
  const qty      = parseInt(document.getElementById('m-qty')?.value);
  const price    = parseFloat(document.getElementById('m-price')?.value) || 0;
  const fn       = document.getElementById('m-fn')?.value.trim() || null;
  const gwei     = parseFloat(document.getElementById('m-gwei')?.value) || null;
  const dryRun   = document.getElementById('m-dryrun')?.checked || false;
  const parallel = document.getElementById('m-mode')?.value === 'true';
  const proofMode = document.getElementById('m-proof-mode')?.value || 'none';
  const selectedWallets = getSelectedWallets('m-wallet-select');

  if (!contract || !qty || qty < 1) { toast('Fill in contract and quantity', 'red'); return; }

  // Build proof params
  let merkleProof = [];
  let proofMap    = null;
  let eip712Sigs  = null;
  let useFlashbots = false;
  let useLaunchpadProof = false;

  if (proofMode === 'single') {
    const raw = document.getElementById('m-proof')?.value.trim();
    merkleProof = raw ? raw.split(/[,\s]+/).filter(s => /^0x[0-9a-fA-F]{64}$/.test(s)) : [];
  } else if (proofMode === 'map') {
    try { proofMap = JSON.parse(document.getElementById('m-proof-map')?.value.trim()); } catch { toast('Invalid proof JSON', 'red'); return; }
  } else if (proofMode === 'eip712') {
    try { eip712Sigs = JSON.parse(document.getElementById('m-eip712')?.value.trim()); } catch { toast('Invalid EIP-712 JSON', 'red'); return; }
  } else if (proofMode === 'flashbots') {
    useFlashbots = true;
  } else if (proofMode === 'launchpad') {
    useLaunchpadProof = true;
  }

  const btn = document.getElementById('m-btn');
  btn.disabled = true;
  setStatus('m-status', '🚀 Minting...', 'loading');
  document.getElementById('m-results').innerHTML = '';

  try {
    const data = await api('/api/mint', {
      method: 'POST',
      body: JSON.stringify({
        contractAddress: contract, quantity: qty, mintPrice: price,
        customFn: fn || null, gweiOverride: gwei, dryRun, parallel,
        chainId: currentChainId, merkleProof, proofMap, eip712Sigs,
        proofMode, useFlashbots, useLaunchpadProof,
        walletFilter: selectedWallets.length ? selectedWallets : null,
      }),
    });
    setStatus('m-status', `✅ Done — ${data.results?.length || 0} wallets`, 'ok');
    const chain = CHAINS[currentChainId] || CHAINS[1];
    const sym = (CHAINS[currentChainId] || CHAINS[1]).symbol;
    document.getElementById('m-results').innerHTML = (data.results || []).map(r => {
      const icon = r.status === 'success' ? '✅' : r.status === 'skipped' ? '⏭' : r.status === 'dry-run-ok' ? '🧪' : '❌';
      const tx   = r.txHash ? `<a href="${chain.explorer}/tx/${r.txHash}" target="_blank" style="color:#f0b429">🔗 tx</a>` : '';
      const gas  = r.gasEscalation ? ` ⬆️ gas x${r.gasEscalation.toFixed(2)}` : '';
      const gasReport = r.gasCostEth ? `<br><span style="color:#00E5FF;font-size:11px">⛽ ${parseInt(r.gasUsed).toLocaleString()} units · ${parseFloat(r.gasCostEth).toFixed(6)} ${sym}</span>` : '';
      return `<div style="padding:8px;margin:4px 0;background:#1a1a2e;border-radius:8px;font-size:12px">
        ${icon} <code>${r.walletAddress?.slice(0,10)}...</code> <b>${r.status}</b>${gas} ${tx}
        ${r.fnName ? `<br><span style="color:#888;font-size:11px">fn: ${r.fnName}</span>` : ''}
        ${gasReport}
        ${r.error ? `<br><span style="color:#e74c3c">${r.error.slice(0,160)}</span>` : ''}
        ${r.phaseContext ? `<br><span style="color:#f0b429;font-size:11px">🔍 ${r.phaseContext}</span>` : ''}
        ${r.proofLeaves ? `<br><span style="color:#60e696;font-size:11px">🔐 ${r.proofLeaves} proof leaves used</span>` : ''}
      </div>`;
    }).join('');
  } catch(e) { setStatus('m-status', `❌ ${e.message}`, 'err'); }
  btn.disabled = false;
}, { once: false });

console.log('HERMÈS BOT v20 webapp loaded');

// ═══════════════════════════════════════════════════════════════════
// HERMÈS v3 — New UI compatibility layer
// Replaces the old click handler wiring with functions that match
// the new HTML IDs and use getChecked() instead of getSelectedWallets()
// ═══════════════════════════════════════════════════════════════════

// Override toast for new UI
const _origToast = window.toast || function(){};
window.toast = function(msg, type, duration) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `show ${type==='red'||type==='error'?'red':'green'}`;
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => { el.className = ''; }, duration || 3000);
};

// getChecked is defined inline in index.html — also expose as getSelectedWallets for backward compat
function getSelectedWallets(containerId) {
  return [...(document.querySelectorAll(`#${containerId} input[type=checkbox]:checked`) || [])].map(cb => cb.value);
}

// Override doMint to use correct function name & new result renderer
async function doMint() {
  const contract  = document.getElementById('m-contract')?.value.trim();
  const qty       = parseInt(document.getElementById('m-qty')?.value) || 1;
  const price     = parseFloat(document.getElementById('m-price')?.value) || 0;
  const fn        = document.getElementById('m-fn')?.value.trim() || null;
  const gwei      = parseFloat(document.getElementById('m-gwei')?.value) || null;
  const dryRun    = document.getElementById('m-dryrun')?.checked || false;
  const proofMode = document.getElementById('m-proof-mode')?.value || 'opensea';
  const wallets   = getChecked('m-wallet-select');

  if (!contract) { toast('Enter contract address', 'red'); return; }
  if (qty < 1)   { toast('Qty must be ≥ 1', 'red'); return; }

  let merkleProof = [], proofMap = null, eip712Sigs = null, useFlashbots = false, useLaunchpadProof = false;
  if (proofMode === 'single') {
    const raw = document.getElementById('m-proof')?.value.trim();
    merkleProof = raw ? raw.split(/[,\s]+/).filter(s => /^0x[0-9a-fA-F]{64}$/.test(s)) : [];
  } else if (proofMode === 'map') {
    try { proofMap = JSON.parse(document.getElementById('m-proof-map')?.value.trim()); }
    catch { toast('Invalid proof JSON', 'red'); return; }
  } else if (proofMode === 'eip712') {
    try { eip712Sigs = JSON.parse(document.getElementById('m-eip712')?.value.trim()); }
    catch { toast('Invalid EIP-712 JSON', 'red'); return; }
  } else if (proofMode === 'flashbots') {
    useFlashbots = true;
  } else if (proofMode === 'launchpad') {
    useLaunchpadProof = true;
  }

  const btn = document.getElementById('m-btn');
  if (btn) btn.disabled = true;
  setStatus('m-status', '🚀 Minting…', 'loading');
  document.getElementById('m-results').innerHTML = '';

  try {
    const data = await api('/api/mint', {
      method: 'POST',
      body: JSON.stringify({
        contractAddress: contract, quantity: qty, mintPrice: price,
        customFn: fn, gweiOverride: gwei, dryRun, parallel: true,
        chainId: currentChainId, merkleProof, proofMap, eip712Sigs,
        proofMode, useFlashbots, useLaunchpadProof,
        walletFilter: wallets.length ? wallets : null,
      }),
    });
    const ok = (data.results||[]).filter(r => r.status === 'success').length;
    setStatus('m-status', `✅ Done — ${ok}/${data.results?.length||0} minted`, 'ok');
    document.getElementById('m-results').innerHTML = (data.results||[]).map(r => buildResultCard(r, currentChainId)).join('');
  } catch(e) {
    setStatus('m-status', `❌ ${e.message}`, 'err');
  }
  if (btn) btn.disabled = false;
}

// Schedule
async function doSchedule() {
  const contract   = document.getElementById('s-contract')?.value.trim();
  const mintTime   = document.getElementById('s-time')?.value;
  const qty        = parseInt(document.getElementById('s-qty')?.value) || 1;
  const price      = parseFloat(document.getElementById('s-price')?.value) || 0;
  const gwei       = parseFloat(document.getElementById('s-gwei')?.value) || null;
  const dryRun     = document.getElementById('s-dryrun')?.checked || false;
  const priorityGas = document.getElementById('s-priority-gas')?.checked || false;
  const proofMode  = document.getElementById('s-proof-mode')?.value || 'opensea';
  const triggerMode = document.getElementById('s-trigger')?.value || 'time';
  const timeout    = parseInt(document.getElementById('s-timeout')?.value) || 60;
  const gasEsc     = parseInt(document.getElementById('s-gas-esc')?.value) || 10;
  const wallets    = getChecked('s-wallet-select');

  if (!contract) { toast('Enter contract address', 'red'); return; }

  const btn = document.getElementById('s-btn');
  if (btn) btn.disabled = true;
  setStatus('s-status', '⏳ Scheduling…', 'loading');

  try {
    const data = await api('/api/schedule', {
      method: 'POST',
      body: JSON.stringify({
        contractAddress: contract, mintTime: mintTime || null,
        quantity: qty, mintPrice: price, gweiOverride: gwei,
        dryRun, proofMode, triggerMode, chainId: currentChainId,
        timeoutSeconds: timeout, gasEscalatePercent: gasEsc,
        walletFilter: wallets.length ? wallets : null, priorityGas,
      }),
    });
    setStatus('s-status', `✅ Scheduled — ID: ${data.scheduleId?.slice(0,8)}…`, 'ok');
    toast('Mint scheduled ✅', 'green');
    loadSchedules();
  } catch(e) {
    setStatus('s-status', `❌ ${e.message}`, 'err');
  }
  if (btn) btn.disabled = false;
}

console.log('HERMÈS v3 UI loaded — mintViaOpenSea import fix applied ✅');

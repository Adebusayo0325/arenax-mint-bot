#!/usr/bin/env node
/**
 * scripts/live-check.js
 * --------------------------------------------------------------------
 * REAL, network-connected smoke test. Run this yourself (Termux/server)
 * where you have actual internet — this is exactly what I couldn't do
 * from my sandbox.
 *
 * It talks to YOUR running Hermès server on localhost, using a fresh
 * throwaway wallet it generates and deletes at the end. It never
 * touches any of your real funded wallets or sends a real transaction.
 *
 * Usage:
 *   1. In one terminal:  npm start
 *   2. In another:        node scripts/live-check.js [contractAddress] [chainId]
 *
 *   Example: node scripts/live-check.js 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D 1
 *   (contract address is optional — omit it to skip the phase-check part)
 * --------------------------------------------------------------------
 */
require('dotenv').config();
const { ethers } = require('ethers');

const BASE = (process.env.WEBAPP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const TOKEN = process.env.WEBAPP_API_TOKEN || '';
const CONTRACT = process.argv[2] || null;
const CHAIN_ID = process.argv[3] || '1';

let pass = 0, fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`✅ ${label}${extra ? ' — ' + extra : ''}`); pass++; }
  else { console.log(`❌ FAIL: ${label}${extra ? ' — ' + extra : ''}`); fail++; }
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'x-api-token': TOKEN } : {}), ...(opts.headers || {}) },
  });
  let body; try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

(async () => {
  console.log(`\nHermès live-check — talking to ${BASE}\n`);

  if (!TOKEN) console.log(`⚠️  WEBAPP_API_TOKEN not set in .env — every /api/* call below will 401. Set it and re-run.\n`);

  // ── 1. Is the server even up? ────────────────────────────────────────
  try {
    const h = await fetch(`${BASE}/health`).then(r => r.json());
    ok('Server is reachable', !!h && h.status === 'ok', JSON.stringify(h));
  } catch (e) {
    console.log(`❌ Cannot reach ${BASE} — is 'npm start' running? (${e.message})`);
    process.exit(1);
  }

  // ── 2. Add Wallet — the exact bug you reported ───────────────────────
  const throwaway = ethers.Wallet.createRandom();
  console.log(`\nUsing a fresh throwaway wallet: ${throwaway.address}`);
  console.log(`(brand new, never funded, deleted automatically at the end)\n`);

  const addRes = await api('/api/wallets/add', {
    method: 'POST',
    body: JSON.stringify({ privateKey: throwaway.privateKey, label: 'live-check-throwaway', spendLimit: 0.01 }),
  });
  ok('Add Wallet returns 200 (was 404 before the fix)', addRes.status === 200, JSON.stringify(addRes.body));
  ok('Returned address matches the wallet just generated',
     addRes.body?.address?.toLowerCase() === throwaway.address.toLowerCase(), addRes.body?.address);

  const listRes = await api('/api/wallets');
  const found = (listRes.body?.wallets || []).find(w => w.address?.toLowerCase() === throwaway.address.toLowerCase());
  ok('New wallet shows up in the wallet list', !!found);
  ok('Spend limit was actually saved (was silently dropped before the fix)',
     found && Number(found.spendLimit) === 0.01, found ? `spendLimit=${found.spendLimit}` : 'not found');

  const delRes = await api(`/api/wallets/${throwaway.address}`, { method: 'DELETE' });
  ok('Throwaway wallet removed — test cleans up after itself', delRes.status === 200, JSON.stringify(delRes.body));

  // ── 3. OpenSea phase-check — the second bug you reported ────────────
  if (CONTRACT) {
    console.log(`\nChecking mint phase/price for ${CONTRACT} on chain ${CHAIN_ID}...\n`);
    const phaseRes = await api(`/api/phase?contract=${CONTRACT}&chainId=${CHAIN_ID}`);
    ok('Phase-check endpoint responds', phaseRes.status === 200, JSON.stringify(phaseRes.body));
    if (phaseRes.body) {
      console.log(`   phase: ${phaseRes.body.phase}`);
      console.log(`   confidence: ${phaseRes.body.confidence}`);
      console.log(`   note: ${phaseRes.body.note}`);
      console.log(`   method: ${phaseRes.body.method || '(on-chain detection)'}`);
    }
    if (!process.env.OPENSEA_API_KEY) {
      console.log(`\n   ⚠️  OPENSEA_API_KEY not set — OpenSea enrichment is skipped, only on-chain SeaDrop/fingerprint detection ran. Expected, not a bug.`);
    }
  } else {
    console.log(`\n⚠️  No contract address given — skipped the live phase-check.`);
    console.log(`   Re-run as: node scripts/live-check.js 0xYourRealContract 1`);
  }

  console.log(`\n${'='.repeat(55)}\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();

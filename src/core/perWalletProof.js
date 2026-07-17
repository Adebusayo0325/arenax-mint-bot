/**
 * perWalletProof.js — v16
 * Manages per-wallet Merkle proof storage and lookup.
 *
 * Supports two input formats:
 * A) JSON map: { "0xAddress": ["0xleaf1","0xleaf2"], ... }
 * B) CSV-like: 0xAddress:0xleaf1,0xleaf2\n0xAddress2:0xleaf3
 *
 * Proofs are stored in proofs.json per-session so if bot restarts
 * mid-mint you can re-paste once.
 */

const fs   = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const PROOFS_FILE = path.join(__dirname, '../../proofs.json');

let _proofMap = {};

// Load from disk on startup
function loadProofs() {
  try {
    if (fs.existsSync(PROOFS_FILE)) {
      _proofMap = JSON.parse(fs.readFileSync(PROOFS_FILE, 'utf8'));
      logger.info(`Loaded ${Object.keys(_proofMap).length} wallet proofs from disk`);
    }
  } catch (e) {
    logger.warn(`Could not load proofs.json: ${e.message}`);
    _proofMap = {};
  }
}

function saveProofs() {
  try { fs.writeFileSync(PROOFS_FILE, JSON.stringify(_proofMap, null, 2), 'utf8'); } catch (e) {}
}

/**
 * Parse a proof input string and store in the map.
 * Returns { parsed: number, errors: string[], map: {...} }
 */
function parseAndStoreProofs(input) {
  const errors = [];
  const map = {};
  const trimmed = input.trim();

  // Try JSON first
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      for (const [addr, proof] of Object.entries(parsed)) {
        const normAddr = addr.toLowerCase();
        const proofArr = Array.isArray(proof) ? proof : proof.toString().split(',').map(s => s.trim());
        const valid = proofArr.filter(p => /^0x[0-9a-fA-F]{64}$/.test(p));
        if (valid.length) {
          map[normAddr] = valid;
        } else {
          errors.push(`No valid leaves for ${addr}`);
        }
      }
    } catch (e) {
      errors.push(`JSON parse error: ${e.message}`);
    }
  } else {
    // Line-by-line format: 0xAddress:0xleaf1,0xleaf2
    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) { errors.push(`Bad line (no colon): ${line.slice(0,40)}`); continue; }
      const addr  = line.slice(0, colonIdx).trim().toLowerCase();
      const leafs = line.slice(colonIdx + 1).split(',').map(s => s.trim());
      const valid = leafs.filter(p => /^0x[0-9a-fA-F]{64}$/.test(p));
      if (!addr.startsWith('0x') || addr.length < 42) { errors.push(`Bad address: ${addr}`); continue; }
      if (!valid.length) { errors.push(`No valid leaves for ${addr}`); continue; }
      map[addr] = valid;
    }
  }

  // Merge into persistent store
  Object.assign(_proofMap, map);
  saveProofs();
  logger.info(`Proofs stored: ${Object.keys(map).length} wallets`);
  return { parsed: Object.keys(map).length, errors, map };
}

/**
 * Get proof for a specific wallet. Returns [] if not found.
 */
function getProofForWallet(walletAddress) {
  return _proofMap[walletAddress.toLowerCase()] || [];
}

/**
 * Returns summary of stored proofs (address → leaf count)
 */
function getProofSummary() {
  return Object.entries(_proofMap).map(([addr, leaves]) => `  ${addr.slice(0,10)}... → ${leaves.length} leaves`).join('\n');
}

function clearProofs() {
  _proofMap = {};
  saveProofs();
}

function hasProofForWallet(walletAddress) {
  const p = _proofMap[walletAddress.toLowerCase()];
  return Array.isArray(p) && p.length > 0;
}

loadProofs();

module.exports = { parseAndStoreProofs, getProofForWallet, getProofSummary, clearProofs, hasProofForWallet };

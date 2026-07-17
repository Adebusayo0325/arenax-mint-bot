const fs    = require('fs');
const path  = require('path');
const { ethers } = require('ethers');
const CryptoJS = require('crypto-js');
const { encryptKey, decryptKey, migrateToV3 } = require('./cryptoEngine'); // v3 AES-GCM
const { WALLET_ENCRYPT_PASSWORD } = require('../config');
const logger = require('../utils/logger');

const WALLETS_DIR  = path.join(__dirname, '../../wallets');
const WALLETS_FILE = path.join(WALLETS_DIR, 'wallets.enc.json');

// Fixed salt per-install — derived from password itself so no extra config needed.
const SALT = CryptoJS.SHA256('arenax-mint-bot-salt-v2').toString();

// ── In-memory wallet cache ─────────────────────────────────────────────────────
// Bot and webapp share the same Node.js process, so they share this module and
// this cache. Any write immediately updates the cache.
let _walletCache = null;

// ── GitHub Gist mirror ────────────────────────────────────────────────────────
// When GITHUB_TOKEN + GITHUB_GIST_ID are set, every saveWallets() call pushes
// the encrypted blob to a *private* GitHub Gist.  On cold start, if the local
// file is missing (Render wiped the FS on respin), we pull from the Gist first
// so wallets added since the last WALLETS_ENCRYPTED snapshot are restored.
//
// Required env vars:
//   GITHUB_TOKEN   — classic PAT with "gist" scope (read + write)
//   GITHUB_GIST_ID — the ID of the private Gist (created once, see README)
//
// The blob stored in the Gist is the same AES-encrypted string that goes to disk
// — the GitHub token only protects access, the encryption key is your
// WALLET_ENCRYPT_PASSWORD.  Even if the Gist were somehow exposed, the contents
// are useless without the password.

const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_GIST_ID = process.env.GITHUB_GIST_ID;
const GIST_FILENAME  = 'wallets.enc.json';
const GIST_API       = `https://api.github.com/gists/${GITHUB_GIST_ID}`;

async function pushToGist(encryptedBlob) {
  if (!GITHUB_TOKEN || !GITHUB_GIST_ID) return;
  try {
    // Dynamic import so the rest of the module stays sync-compatible
    const https = require('https');
    const body  = JSON.stringify({ files: { [GIST_FILENAME]: { content: encryptedBlob } } });
    await new Promise((resolve, reject) => {
      const req = https.request(GIST_API, {
        method: 'PATCH',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'arenax-mint-bot',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            logger.info('Wallets backed up to GitHub Gist ✓');
            resolve();
          } else {
            logger.warn(`Gist push returned HTTP ${res.statusCode}: ${data.slice(0, 120)}`);
            resolve(); // non-fatal
          }
        });
      });
      req.on('error', e => { logger.warn(`Gist push error: ${e.message}`); resolve(); });
      req.write(body);
      req.end();
    });
  } catch (e) {
    logger.warn(`Gist push failed (non-fatal): ${e.message}`);
  }
}

async function pullFromGist() {
  if (!GITHUB_TOKEN || !GITHUB_GIST_ID) return null;
  try {
    const https = require('https');
    const raw   = await new Promise((resolve, reject) => {
      const req = https.request(GIST_API, {
        method: 'GET',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'User-Agent': 'arenax-mint-bot',
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode === 200) resolve(data);
          else { logger.warn(`Gist pull HTTP ${res.statusCode}`); resolve(null); }
        });
      });
      req.on('error', e => { logger.warn(`Gist pull error: ${e.message}`); resolve(null); });
      req.end();
    });
    if (!raw) return null;
    const gist = JSON.parse(raw);
    const content = gist?.files?.[GIST_FILENAME]?.content;
    if (!content) { logger.warn('Gist exists but wallet file not found inside it'); return null; }
    return content;
  } catch (e) {
    logger.warn(`Gist pull failed (non-fatal): ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function deriveKey() {
  return CryptoJS.PBKDF2(WALLET_ENCRYPT_PASSWORD, SALT, { keySize: 256 / 32, iterations: 100000 });
}

function ensureDir() {
  if (!fs.existsSync(WALLETS_DIR)) fs.mkdirSync(WALLETS_DIR, { recursive: true });
}

function encrypt(data) {
  // v3: native AES-256-GCM — authenticated encryption, tamper-detectable
  try {
    const { createCipheriv, randomBytes, scryptSync } = require('crypto');
    const iv  = randomBytes(12); // 96-bit GCM nonce
    const pwd = Buffer.from(WALLET_ENCRYPT_PASSWORD || 'hermes-default', 'utf8');
    const key = scryptSync(pwd, Buffer.from(SALT.slice(0, 32), 'utf8'), 32, { N: 16384, r: 8, p: 1 });
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct  = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v3:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
  } catch (e) {
    // Fallback to v2 CryptoJS if native fails
    logger.warn(`[Wallet] AES-GCM encrypt failed, falling back to v2: ${e.message}`);
    const key  = deriveKey();
    const iv   = CryptoJS.lib.WordArray.random(16);
    const encrypted = CryptoJS.AES.encrypt(JSON.stringify(data), key, { iv });
    return `v2:${iv.toString()}:${encrypted.toString()}`;
  }
}

function decrypt(cipher) {
  // v3: native AES-256-GCM (authenticated encryption)
  if (cipher && cipher.startsWith('v3:')) {
    try {
      const { createDecipheriv, scryptSync } = require('crypto');
      const parts = cipher.split(':');
      const iv  = Buffer.from(parts[1], 'hex');
      const tag = Buffer.from(parts[2], 'hex');
      const ct  = Buffer.from(parts.slice(3).join(':'), 'hex');
      const pwd = Buffer.from(WALLET_ENCRYPT_PASSWORD || 'hermes-default', 'utf8');
      const key = scryptSync(pwd, Buffer.from(SALT.slice(0, 32), 'utf8'), 32, { N: 16384, r: 8, p: 1 });
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'));
    } catch (e) { throw new Error(`v3 wallet decrypt failed: ${e.message}`); }
  }
  // v2: CryptoJS AES with random IV
  if (cipher.startsWith('v2:')) {
    const [, ivHex, ct] = cipher.split(':');
    const key  = deriveKey();
    const iv   = CryptoJS.enc.Hex.parse(ivHex);
    const bytes = CryptoJS.AES.decrypt(ct, key, { iv });
    return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
  }
  // v1: legacy plain AES (backward compat)
  const bytes = CryptoJS.AES.decrypt(cipher, WALLET_ENCRYPT_PASSWORD);
  return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
}

// ── _loadFromStorage — priority order ─────────────────────────────────────────
// 1. On-disk file  (freshest — written by THIS running instance)
// 2. GitHub Gist   (survives full container wipe; async, runs on cold start)
// 3. WALLETS_ENCRYPTED env var (one-time Render snapshot — last resort seed)
//
// Note: loadWallets() is called synchronously at startup, but Gist pull is async.
// We therefore kick off a background Gist restore on first load when the file is
// absent, write it to disk, and replace the cache — any callers that ran before
// the restore completes will get the env-var data (or empty), then the next call
// gets the Gist data.  In practice the restore completes in < 1 s on Render.

function _loadFromStorage() {
  ensureDir();

  // 1. On-disk file — always wins if present
  if (fs.existsSync(WALLETS_FILE)) {
    try {
      const raw = fs.readFileSync(WALLETS_FILE, 'utf8');
      const wallets = decrypt(raw);
      logger.info(`Wallets loaded from disk (${wallets.length} total)`);
      return wallets;
    } catch (e) {
      logger.warn(`Failed to read wallets.enc.json (${e.message}), trying Gist / env…`);
    }
  }

  // 2. GitHub Gist — async restore (fires and forgets; updates cache when done)
  if (GITHUB_TOKEN && GITHUB_GIST_ID) {
    logger.info('No local wallet file — pulling from GitHub Gist…');
    pullFromGist().then(blob => {
      if (!blob) return;
      try {
        const wallets = decrypt(blob);
        // Write to disk so next cold start skips the Gist pull
        ensureDir();
        fs.writeFileSync(WALLETS_FILE, blob, 'utf8');
        _walletCache = wallets;
        logger.info(`Gist restore complete — ${wallets.length} wallet(s) recovered and written to disk`);
      } catch (e) {
        logger.warn(`Gist blob decrypt failed: ${e.message}`);
      }
    });
  }

  // 3. WALLETS_ENCRYPTED env var — one-time seed while Gist pull is in flight
  if (process.env.WALLETS_ENCRYPTED) {
    try {
      const seeded = decrypt(process.env.WALLETS_ENCRYPTED);
      logger.info(`Seeded ${seeded.length} wallet(s) from WALLETS_ENCRYPTED env (no local file yet)`);
      return seeded;
    } catch (e) {
      logger.warn(`Failed to load wallets from WALLETS_ENCRYPTED env: ${e.message}`);
    }
  }

  return [];
}

function loadWallets() {
  if (_walletCache !== null) return _walletCache;
  _walletCache = _loadFromStorage();
  return _walletCache;
}

function saveWallets(wallets) {
  // Update in-memory cache FIRST — bot + webapp are in-sync immediately
  _walletCache = wallets;

  const encrypted = encrypt(wallets);
  ensureDir();
  fs.writeFileSync(WALLETS_FILE, encrypted, 'utf8');
  logger.info(`Wallets saved to disk (${wallets.length} total)`);

  // Mirror to GitHub Gist asynchronously — non-blocking
  pushToGist(encrypted).catch(() => {}); // already logged inside pushToGist
}

function addWallet(privateKey, label = '', spendLimit = null) {
  const wallets = loadWallets();
  const wallet  = new ethers.Wallet(privateKey);
  const exists  = wallets.find(w => w.address === wallet.address);
  if (exists) throw new Error(`Wallet ${wallet.address} already exists`);
  wallets.push({ address: wallet.address, privateKey, label, spendLimit });
  saveWallets(wallets);
  logger.info(`Wallet added: ${wallet.address} label="${label}" spendLimit=${spendLimit}`);
  return wallet.address;
}

function removeWallet(address) {
  let wallets = loadWallets();
  wallets = wallets.filter(w => w.address.toLowerCase() !== address.toLowerCase());
  saveWallets(wallets);
  logger.info(`Wallet removed: ${address}`);
}

// v18: rename / relabel a wallet
function setWalletLabel(address, label) {
  const wallets = loadWallets();
  const w = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
  if (!w) throw new Error(`Wallet not found: ${address}`);
  w.label = label;
  saveWallets(wallets);
  logger.info(`Wallet relabeled ${address.slice(0, 8)}: "${label}"`);
}

// v18: set per-wallet ETH spend limit per run
function setWalletSpendLimit(address, limitEth) {
  const wallets = loadWallets();
  const w = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
  if (!w) throw new Error(`Wallet not found: ${address}`);
  w.spendLimit = limitEth === null ? null : parseFloat(limitEth);
  saveWallets(wallets);
  logger.info(`Spend limit set for ${address.slice(0, 8)}: ${limitEth === null ? 'unlimited' : limitEth + ' ETH'}`);
}

function getWallets() {
  return loadWallets();
}

function getWalletSigner(address, provider) {
  const wallets = loadWallets();
  const found   = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
  if (!found) throw new Error(`Wallet not found: ${address}`);
  return new ethers.Wallet(found.privateKey, provider);
}

module.exports = { addWallet, removeWallet, getWallets, getWalletSigner, setWalletLabel, setWalletSpendLimit };

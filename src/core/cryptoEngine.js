/**
 * cryptoEngine.js — AES-256-GCM authenticated encryption.
 * Ported from ApexMint_Pro/packages/crypto (kdf.ts + secretbox.ts)
 *
 * Replaces CryptoJS (unauthenticated AES-CBC + static salt) with:
 *   scrypt (memory-hard KDF) + random salt per installation
 *   AES-256-GCM (authenticated — tampered ciphertext is rejected)
 *
 * Backward compatible: if ciphertext looks like old CryptoJS format, falls
 * back to CryptoJS decrypt so existing wallets still load.
 *
 * New wallets are always encrypted with v3 (AES-GCM).
 */

const { scrypt, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } = require('crypto');
const path = require('path');
const fs   = require('fs');
const logger = require('../utils/logger');

// ── scrypt parameters (ApexMint defaults: ~64MB, ~200ms on modern CPU) ────────
const KDF = { N: 1 << 15, r: 8, p: 1 };
const KEY_BYTES = 32; // AES-256
const IV_BYTES  = 12; // GCM standard 96-bit nonce
const TAG_BYTES = 16; // GCM auth tag

// ── Installation salt (generated once, persisted) ─────────────────────────────
const SALT_FILE = path.join(__dirname, '../../wallets/.crypto-salt');
const STATIC_FALLBACK_SALT = 'arenax-mint-bot-salt-v2'; // for CryptoJS compat

function getInstallSalt() {
  try {
    if (fs.existsSync(SALT_FILE)) return fs.readFileSync(SALT_FILE, 'utf8').trim();
    const salt = randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(SALT_FILE), { recursive: true });
    fs.writeFileSync(SALT_FILE, salt, 'utf8');
    logger.info('[Crypto] New installation salt generated');
    return salt;
  } catch { return STATIC_FALLBACK_SALT; }
}

// ── Key derivation ────────────────────────────────────────────────────────────
function deriveKey(passphrase, saltHex) {
  return new Promise((resolve, reject) => {
    const salt = Buffer.from(saltHex, 'hex');
    const maxmem = 256 * KDF.N * KDF.r;
    scrypt(passphrase, salt, KEY_BYTES, { ...KDF, maxmem }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

// ── AES-256-GCM seal / open ───────────────────────────────────────────────────
function seal(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 3, iv: iv.toString('hex'), tag: tag.toString('hex'), ct: ct.toString('hex') };
}

function open(key, box) {
  const iv  = Buffer.from(box.iv, 'hex');
  const tag = Buffer.from(box.tag, 'hex');
  const ct  = Buffer.from(box.ct, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch { throw new Error('Decryption failed — wrong passphrase or tampered data'); }
}

// ── Public API ─────────────────────────────────────────────────────────────────
/**
 * Encrypt a private key string with AES-256-GCM.
 * Returns a JSON string safe for storage.
 */
async function encryptKey(privateKey, passphrase) {
  const saltHex = getInstallSalt();
  const key = await deriveKey(passphrase, saltHex);
  const box = seal(key, Buffer.from(privateKey, 'utf8'));
  return JSON.stringify({ ...box, salt: saltHex });
}

/**
 * Decrypt a private key.
 * Handles v3 (AES-GCM) and falls back to CryptoJS v1/v2 for old wallets.
 */
async function decryptKey(ciphertext, passphrase) {
  // Try v3 (AES-GCM) first
  try {
    const box = JSON.parse(ciphertext);
    if (box.v === 3 && box.iv && box.tag && box.ct) {
      const key = await deriveKey(passphrase, box.salt || getInstallSalt());
      return open(key, box);
    }
  } catch {}

  // Fall back to CryptoJS for old wallets
  try {
    const CryptoJS = require('crypto-js');
    const SALT = CryptoJS.SHA256(STATIC_FALLBACK_SALT).toString();
    const decrypted = CryptoJS.AES.decrypt(ciphertext, SALT).toString(CryptoJS.enc.Utf8);
    if (decrypted && decrypted.length >= 64) {
      logger.info('[Crypto] Loaded legacy CryptoJS wallet — will re-encrypt on next save');
      return decrypted;
    }
  } catch {}

  throw new Error('Cannot decrypt wallet — wrong passphrase or unsupported format');
}

/**
 * Re-encrypt a wallet from CryptoJS (v1/v2) to AES-GCM (v3).
 * Call this after a successful CryptoJS decrypt to migrate in-place.
 */
async function migrateToV3(ciphertext, passphrase) {
  const plaintext = await decryptKey(ciphertext, passphrase);
  return encryptKey(plaintext, passphrase);
}

module.exports = { encryptKey, decryptKey, migrateToV3, getInstallSalt };

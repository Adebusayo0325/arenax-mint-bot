/**
 * securityGuard.js
 *
 * Guards against ever sending funds to, or configuring, a known-compromised
 * address again (e.g. a wallet drained via an EIP-7702 delegation sweep —
 * anything sent to it afterward gets auto-forwarded to the attacker).
 *
 * Set COMPROMISED_ADDRESSES in Render env as a comma-separated list.
 * This is intentionally simple and dependency-free so it can be called from
 * anywhere (funding, wallet-add, startup checks) without risk of it being
 * the thing that breaks.
 */
const config = require('../config');
const logger = require('./logger');

function isCompromised(address) {
  if (!address) return false;
  return config.COMPROMISED_ADDRESSES.includes(String(address).toLowerCase());
}

/**
 * Throws a clear, specific error if the address is on the compromised list.
 * Use this at every point that would send funds TO an address, or accept
 * one as a new wallet/master key — fail loud, don't silently skip.
 */
function assertSafeAddress(address, context = 'operation') {
  if (isCompromised(address)) {
    const msg = `🚨 BLOCKED: ${address} is on the compromised-address list (${context}). ` +
      `This address is known to be hacked/drained — refusing to send funds to it or use it. ` +
      `Remove it from COMPROMISED_ADDRESSES in Render env only if you're certain it's safe again.`;
    logger.error(msg);
    throw new Error(msg);
  }
}

/**
 * Startup / periodic sweep: checks the master wallet address and every
 * configured worker wallet against the compromised list. Returns a list of
 * problems found (empty if clean) — never throws, safe to call anywhere,
 * including from the webapp's health-check endpoint.
 */
function scanForCompromisedAddresses(masterAddress, wallets = []) {
  const issues = [];
  if (masterAddress && isCompromised(masterAddress)) {
    issues.push({ role: 'master', address: masterAddress });
  }
  for (const w of wallets) {
    if (isCompromised(w.address)) {
      issues.push({ role: 'wallet', address: w.address, label: w.label || '' });
    }
  }
  return issues;
}

module.exports = { isCompromised, assertSafeAddress, scanForCompromisedAddresses };

const { ethers } = require('ethers');
function sel(sig) { return ethers.id(sig).slice(0, 10); }
const CUSTOM_ERRORS = new Map([
  ['0x914edb0f','not_started'],['0xb7b24097','not_started'],['0x80cb55e2','not_started'],
  ['0x2d0a346e','not_started'],['0x951b974f','not_started'],
  ['0x49084b94','ended'],['0x0bd8a3eb','ended'],
  ['0x52df9fe5','sold_out'],['0xd05cb609','sold_out'],['0xc30436e9','sold_out'],
  ['0x4ef4aa66','sold_out'],['0xe6b99eb1','sold_out'],
  ['0x746f4607','wallet_limit'],['0xf560625a','wallet_limit'],['0xc0e54d73','wallet_limit'],
  ['0x28ab0176','wallet_limit'],['0xddefae28','wallet_limit'],
  ['0x06fb10a9','not_allowlisted'],['0x09bde339','not_allowlisted'],
  ['0x8baa579f','not_allowlisted'],['0xf8eb54de','not_allowlisted'],
  ['0x569e8c11','insufficient_payment'],['0xcd1c8867','insufficient_payment'],['0x2f4613eb','insufficient_payment'],
  ['0x9e87fac8','paused'],['0xd93c0665','paused'],
]);
const ACTIONS = {
  not_started:'retry_when_live', ended:'abort', sold_out:'abort', wallet_limit:'abort',
  not_allowlisted:'needs_allowlist', insufficient_payment:'retry_with_higher_value',
  paused:'retry_backoff', unknown:'retry_backoff',
};
const LABELS = {
  not_started:'⏳ Mint not started yet', ended:'🔚 Mint has ended', sold_out:'🔴 Sold out',
  wallet_limit:'🚫 Wallet limit reached', not_allowlisted:'❌ Not allowlisted / invalid proof',
  insufficient_payment:'💰 Wrong payment amount', paused:'⏸ Contract paused', unknown:'❓ Unknown revert',
};
const RULES = [
  [/not (active|started|live|open)|before start/i,'not_started'],
  [/ended|sale over|closed/i,'ended'], [/sold.?out|max supply|exceeds supply/i,'sold_out'],
  [/per.?wallet|wallet limit|already minted/i,'wallet_limit'],
  [/allow.?list|whitelist|merkle|invalid proof|not eligible/i,'not_allowlisted'],
  [/insufficient payment|wrong price|incorrect payment|wrong value/i,'insufficient_payment'],
  [/paused/i,'paused'],
];
function categorize(msg) { for (const [r,c] of RULES) if (r.test(msg)) return c; return 'unknown'; }
function decodeErrStr(hex) {
  try { const b=hex.slice(10); if(b.length<128) return null; const l=parseInt(b.slice(64,128),16); return Buffer.from(b.slice(128,128+l*2),'hex').toString('utf8'); } catch { return null; }
}
function classifyRevert(data) {
  if (!data) return fin('unknown',null);
  const hex = typeof data==='string'&&data.startsWith('0x') ? data.toLowerCase() : null;
  if (hex && hex.length>=10) {
    const s = hex.slice(0,10);
    if (s==='0x08c379a0') { const m=decodeErrStr(hex); return fin(m?categorize(m):'unknown',m); }
    if (s==='0x4e487b71') return fin('unknown','Solidity panic');
    const c=CUSTOM_ERRORS.get(s); if(c) return fin(c,null);
  }
  if (typeof data==='string') return fin(categorize(data), data.slice(0,200));
  return fin('unknown',null);
}
function fin(cat,reason) { return { category:cat, action:ACTIONS[cat]||'retry_backoff', reason, userMessage:LABELS[cat]||LABELS.unknown, retriable:!['abort','needs_allowlist'].includes(ACTIONS[cat]||'') }; }
function classifyMintError(err) { return classifyRevert(err?.data||err?.error?.data||err?.reason||err?.message||null); }
module.exports = { classifyRevert, classifyMintError };

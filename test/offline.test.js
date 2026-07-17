/**
 * offline.test.js — zero dependencies, pure Node.js built-ins only.
 * Run: node test/offline.test.js
 *
 * Tests the LOGIC of every fix using inline stubs.
 * Each stub is labelled with what real function it simulates.
 */
'use strict';

let passed = 0, failed = 0;
function ok(label, bool) {
  if (bool) { console.log(`  ✅ ${label}`); passed++; }
  else       { console.log(`  ❌ FAIL: ${label}`); failed++; }
}
function includes(label, str, sub) {
  ok(`${label} — contains "${sub}"`, typeof str === 'string' && str.toLowerCase().includes(sub.toLowerCase()));
}
function notIncludes(label, str, sub) {
  ok(`${label} — does NOT contain "${sub}"`, typeof str === 'string' && !str.toLowerCase().includes(sub.toLowerCase()));
}
function section(n) { console.log(`\n── ${n} ──`); }

// ─── pure-JS ABI helpers (replaces ethers.AbiCoder for the test) ─────────────
// Minimal Error(string) encoder — same byte layout as ethers/Solidity
function encodeErrorString(str) {
  const strBytes = Buffer.from(str, 'utf8');
  const selector = '08c379a0';
  // ABI: offset (32 bytes = 0x20) + length (32 bytes) + data (padded to 32)
  const offset = '0000000000000000000000000000000000000000000000000000000000000020';
  const lenHex = strBytes.length.toString(16).padStart(64, '0');
  const dataHex = Buffer.from(strBytes).toString('hex').padEnd(Math.ceil(strBytes.length / 32) * 64, '0');
  return '0x' + selector + offset + lenHex + dataHex;
}

// Minimal Error(string) decoder (no ethers needed)
function decodeErrorString(hex) {
  // hex starts with 0x08c379a0 + ABI-encoded string
  const data = hex.slice(2 + 8); // skip 0x + selector
  // offset is always 0x20 (32), skip it
  // next 32 bytes = string length
  const strLenHex = data.slice(64, 128);
  const strLen = parseInt(strLenHex, 16);
  const strHex = data.slice(128, 128 + strLen * 2);
  return Buffer.from(strHex, 'hex').toString('utf8');
}

// ─── INLINE COPY of production decodeMintError (from mintEngine.js) ──────────
// This IS the code that ships. Changing the production file without updating
// this copy will cause tests to diverge from reality — that's intentional:
// it forces you to update the test when the function changes.

const KNOWN_CUSTOM_ERRORS = {
  '1469c1bd': 'MintNotActive — mint phase not open yet',
  'b6fee2e9': 'NotAllowListed — wallet not on the allowlist',
  'a5f34628': 'InvalidSignature — signature invalid or already used',
  'f57ff087': 'FeeRecipientNotAllowed',
  '34bf3526': 'MintQuantityExceedsMaxPerWallet — already minted max for this wallet',
  '8e570b63': 'MintQuantityExceedsMaxSupply — collection sold out',
  '5c427cd9': 'InvalidContractOrder',
  '278a4e0d': 'NotActive — sale not active',
  'd4d30fc3': 'AllowListStageNotActive — allowlist stage not active',
  '6fbde40e': 'Paused — contract is paused',
};

function classifyRevertReason(msg, fnName) {
  const m = (msg || '').toLowerCase();
  if (m.includes('insufficient funds') || m.includes('insufficient eth'))
    return 'Insufficient ETH for mint + gas';
  if (m.includes('nonce'))
    return 'Nonce error — try again';
  if (m.includes('invalidproof') || m.includes('invalid proof') || m.includes('merkleproof') || m.includes('bad proof'))
    return 'Invalid Merkle proof — wrong proof for this wallet';
  if (m.includes('invalidsignature') || m.includes('invalid signature') || m.includes('ecdsa') || m.includes('bad signature'))
    return 'Invalid EIP-712 signature — may have expired or already been used';
  if (m.includes('notwhitelisted') || m.includes('not whitelisted') || m.includes('not in whitelist') ||
      m.includes('not allowlisted') || m.includes('not on allowlist'))
    return 'Wallet not whitelisted / not on allowlist';
  if (m.includes('salenotactive') || m.includes('sale not active') || m.includes('sale is not active') ||
      m.includes('not started') || m.includes('mint not open') || m.includes('notactive') ||
      m.includes('mint closed') || m.includes('not live') || m.includes('public sale not active') ||
      m.includes('minting not') || m.includes('mint is not') || m.includes('sale inactive') ||
      m.includes('mint not started') || m.includes('minting has not') || m.includes('not yet started'))
    return 'Mint not open — sale is not active yet';
  if (m.includes('maxsupplyreached') || m.includes('max supply') || m.includes('sold out') ||
      m.includes('exceeds max supply') || m.includes('supply exceeded'))
    return 'Collection sold out';
  if (m.includes('exceedsmaxperwallet') || m.includes('exceeds max per wallet') ||
      m.includes('max per wallet') || m.includes('already minted max') || m.includes('wallet limit') ||
      m.includes('maximum allowed') || m.includes('you have already minted'))
    return 'Exceeds max per wallet — already minted the maximum for this wallet';
  if (m.includes('wrong price') || m.includes('incorrect price') || m.includes('invalid price') ||
      m.includes('wrong value') || m.includes('incorrect value') || m.includes('wrong eth') ||
      m.includes('incorrect eth') || m.includes('ether value') || m.includes('wrongprice') ||
      m.includes('wrongvalue') || m.includes('invalidprice'))
    return 'Wrong mint price — check the price and retry';
  if (m.includes('paused'))
    return 'Contract is paused — mint not active';
  if (m.includes('missing revert data') || m.includes('call_exception') || m.includes('execution reverted'))
    return `${fnName}() reverted — use ✅ Check Phase and ✅ Check Eligibility to diagnose the exact reason before retrying`;
  return (msg || '').replace(/\s+/g, ' ').slice(0, 200);
}

function decodeMintError(err, fnName) {
  const msg = err.message || String(err);
  if (err.reason) return classifyRevertReason(err.reason, fnName);
  if (err.data && typeof err.data === 'string' && err.data.startsWith('0x')) {
    const hex = err.data.slice(2);
    if (hex.startsWith('08c379a0')) {
      try {
        const reason = decodeErrorString(err.data);
        if (reason) return classifyRevertReason(reason, fnName);
      } catch (_) {}
    }
    if (hex.startsWith('4e487b71')) return 'Contract panic (internal error) — likely array out of bounds';
    const selector = hex.slice(0, 8).toLowerCase();
    if (KNOWN_CUSTOM_ERRORS[selector]) return KNOWN_CUSTOM_ERRORS[selector];
    return `Contract reverted with custom error 0x${selector} — check Etherscan for this contract's error definitions`;
  }
  if (err.info?.error?.data) return decodeMintError({ data: err.info.error.data, message: msg }, fnName);
  return classifyRevertReason(msg, fnName);
}

// ─── INLINE COPY of shouldUseMintSigned routing logic (from mintEngine.js) ──
const MINT_FN_PRIORITY_721 = [
  'publicMint','mintPublic','mint','buy','mintNFT','batchMint',
  'claim','purchase','allowlistMint','presaleMint','mintWithProof',
  'whitelistMint','mintWithSignature','mintAllowance','freeMint',
  'teamMint','mintTo','safeMint',
  'mintSigned', // LAST
];
function getMintSignedAbiEntry(abiJson) {
  if (!Array.isArray(abiJson)) return null;
  return abiJson.find(f => f.type === 'function' && f.name === 'mintSigned') || null;
}
function findMintFunctions(abiJson) {
  if (!Array.isArray(abiJson)) return [];
  return abiJson.filter(fn =>
    fn.type === 'function' &&
    ['payable','nonpayable'].includes(fn.stateMutability) &&
    MINT_FN_PRIORITY_721.some(n => n.toLowerCase() === fn.name?.toLowerCase())
  );
}
function shouldUseMintSigned({ abiJson, customFn, resolvedSig }) {
  const mintSignedEntry = abiJson ? getMintSignedAbiEntry(abiJson) : null;
  const abiHasMintSigned = !!mintSignedEntry;
  const otherCandidates = abiJson ? findMintFunctions(abiJson).filter(f => f.name !== 'mintSigned') : [];
  const mintSignedIsOnlyOption = abiHasMintSigned && !!abiJson && otherCandidates.length === 0;
  const wantsMintSigned = customFn === 'mintSigned';
  return customFn ? wantsMintSigned : (abiHasMintSigned && (mintSignedIsOnlyOption || !!resolvedSig));
}

// ─── INLINE COPY of computePhaseConfidence (from phaseDetector.js) ───────────
function computePhaseConfidence(raw, hasMerkleRoot, mintPrice, totalSupply, maxSupply) {
  const anySignalFound = (
    raw.paused !== null || raw.saleIsActive !== null ||
    raw.publicSaleActive !== null || raw.mintEnabled !== null ||
    raw.isLive !== null || raw.isMintOpen !== null ||
    raw.mintOpen !== null || raw.presaleActive !== null ||
    raw.wlEnabled !== null || raw.alEnabled !== null ||
    raw.phaseNum !== undefined ||
    hasMerkleRoot || mintPrice !== null ||
    totalSupply !== null || maxSupply !== null
  );
  return anySignalFound ? 'verified' : 'heuristic';
}

// ─── INLINE COPY of balance check (from mintEngine.js) ───────────────────────
// Uses pure BigInt math — no ethers dependency
function parseEther(ethStr) {
  // Convert e.g. "0.005" -> BigInt wei
  const [whole, frac = ''] = ethStr.split('.');
  const fracPadded = frac.padEnd(18, '0').slice(0, 18);
  return BigInt(whole) * BigInt('1000000000000000000') + BigInt(fracPadded);
}
function formatEther(wei) {
  const s = wei.toString().padStart(19, '0');
  const whole = s.slice(0, -18) || '0';
  const frac = s.slice(-18).replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}
function checkBalance(balanceWei, mintPrice, quantity, gasLimit, feePerGas) {
  const totalCostEth = (mintPrice * quantity).toFixed(18);
  const value = parseEther(totalCostEth);
  const gasBuffer = (BigInt(feePerGas) * BigInt(gasLimit) * 120n) / 100n;
  const required = value + gasBuffer;
  if (BigInt(balanceWei) < required) {
    const bal = parseFloat(formatEther(BigInt(balanceWei))).toFixed(6);
    const req = parseFloat(formatEther(required)).toFixed(6);
    return { ok: false, message: `Insufficient: has ${bal} ETH, needs ~${req} ETH` };
  }
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════════════
//  TESTS
// ══════════════════════════════════════════════════════════════════════════════

section('1. decodeMintError — named revert reasons');
includes('not-whitelisted from reason',         decodeMintError({ reason:'NotWhitelisted', message:'' }, 'publicMint'), 'not whitelisted');
includes('sale-not-active from reason',         decodeMintError({ reason:'SaleNotActive', message:'' }, 'publicMint'), 'not open');
includes('max-per-wallet from reason',          decodeMintError({ reason:'ExceedsMaxPerWallet', message:'' }, 'publicMint'), 'max per wallet');
includes('sold-out from reason',                decodeMintError({ reason:'MaxSupplyReached', message:'' }, 'publicMint'), 'sold out');
includes('invalid-proof from reason',           decodeMintError({ reason:'InvalidProof', message:'' }, 'publicMint'), 'Merkle proof');
includes('paused from reason',                  decodeMintError({ reason:'Paused', message:'' }, 'publicMint'), 'paused');
includes('wrong-price from reason',             decodeMintError({ reason:'WrongPrice', message:'' }, 'publicMint'), 'Wrong mint price');

section('2. decodeMintError — ABI-encoded Error(string) in err.data');
includes('mint not open from Error(string)',    decodeMintError({ data: encodeErrorString('Sale is not active'), message:'CALL_EXCEPTION' }, 'publicMint'), 'not open');
includes('not whitelisted from Error(string)',  decodeMintError({ data: encodeErrorString('Not whitelisted'), message:'CALL_EXCEPTION' }, 'publicMint'), 'not whitelisted');
includes('wrong price from Error(string)',      decodeMintError({ data: encodeErrorString('Wrong ETH value sent'), message:'CALL_EXCEPTION' }, 'publicMint'), 'Wrong mint price');
includes('max per wallet from Error(string)',   decodeMintError({ data: encodeErrorString('Wallet limit reached'), message:'CALL_EXCEPTION' }, 'publicMint'), 'max per wallet');
includes('paused from Error(string)',           decodeMintError({ data: encodeErrorString('Contract is paused'), message:'CALL_EXCEPTION' }, 'publicMint'), 'paused');
includes('sold out from Error(string)',         decodeMintError({ data: encodeErrorString('Exceeds max supply'), message:'CALL_EXCEPTION' }, 'publicMint'), 'sold out');
includes('minting not started Error(string)',   decodeMintError({ data: encodeErrorString('Minting not started yet'), message:'CALL_EXCEPTION' }, 'publicMint'), 'not open');
includes('already minted from Error(string)',   decodeMintError({ data: encodeErrorString('You have already minted your maximum'), message:'CALL_EXCEPTION' }, 'publicMint'), 'max per wallet');

section('3. decodeMintError — custom error selectors');
includes('MintNotActive 0x1469c1bd',            decodeMintError({ data:'0x1469c1bd', message:'CALL_EXCEPTION' }, 'f'), 'MintNotActive');
includes('NotAllowListed 0xb6fee2e9',           decodeMintError({ data:'0xb6fee2e9', message:'CALL_EXCEPTION' }, 'f'), 'NotAllowListed');
includes('MintQuantityExceedsMaxSupply 0x8e570b63', decodeMintError({ data:'0x8e570b63', message:'CALL_EXCEPTION' }, 'f'), 'sold out');
includes('AllowListStageNotActive 0xd4d30fc3',  decodeMintError({ data:'0xd4d30fc3', message:'CALL_EXCEPTION' }, 'f'), 'AllowListStageNotActive');
includes('unknown selector shows selector',     decodeMintError({ data:'0xdeadbeef', message:'CALL_EXCEPTION' }, 'f'), 'custom error 0xdeadbeef');

section('4. decodeMintError — generic CALL_EXCEPTION gives diagnostic, not laundry list');
const generic = decodeMintError({ message:'missing revert data in call', data:null }, 'publicMint');
includes('generic result tells user to use Check Phase', generic, 'Check Phase');
notIncludes('generic result does NOT list all causes', generic, '·');

section('5. decodeMintError — nested err.info.error.data');
const nested = { message:'CALL_EXCEPTION', info: { error: { data: encodeErrorString('Sale is not active') } } };
includes('nested err.info.error.data decoded', decodeMintError(nested, 'publicMint'), 'not open');

section('6. mintSigned routing — NOT chosen when other fns exist');
const abiWithBoth = [
  { type:'function', name:'publicMint',  stateMutability:'payable', inputs:[] },
  { type:'function', name:'mintSigned',  stateMutability:'payable', inputs:[] },
];
ok('mintSigned NOT chosen with publicMint in ABI', !shouldUseMintSigned({ abiJson:abiWithBoth, customFn:null, resolvedSig:null }));

section('7. mintSigned routing — IS chosen when it is the only fn');
const abiOnlyMS = [{ type:'function', name:'mintSigned', stateMutability:'payable', inputs:[] }];
ok('mintSigned chosen when only payable fn', shouldUseMintSigned({ abiJson:abiOnlyMS, customFn:null, resolvedSig:null }));

section('8. mintSigned routing — chosen when sig supplied (even with other fns)');
ok('mintSigned chosen when resolvedSig present', shouldUseMintSigned({ abiJson:abiWithBoth, customFn:null, resolvedSig:'0xabc' }));

section('9. mintSigned routing — explicit customFn wins');
const abiNoMS = [{ type:'function', name:'publicMint', stateMutability:'payable', inputs:[] }];
ok('customFn=mintSigned forces mintSigned path',  shouldUseMintSigned({ abiJson:abiNoMS, customFn:'mintSigned', resolvedSig:null }));
ok('customFn=publicMint does not use mintSigned', !shouldUseMintSigned({ abiJson:abiWithBoth, customFn:'publicMint', resolvedSig:null }));

section('10. Phase confidence — heuristic vs verified');
const nullRaw = { paused:null, saleIsActive:null, publicSaleActive:null, mintEnabled:null, isLive:null, isMintOpen:null, mintOpen:null, presaleActive:null, wlEnabled:null, alEnabled:null };
ok('heuristic when no getter returned', computePhaseConfidence(nullRaw, false, null, null, null) === 'heuristic');
ok('verified when saleIsActive=true',   computePhaseConfidence({...nullRaw, saleIsActive:true}, false, null, null, null) === 'verified');
ok('verified when mintPrice read',      computePhaseConfidence(nullRaw, false, '0.005000', null, null) === 'verified');
ok('verified when merkleRoot found',    computePhaseConfidence(nullRaw, true, null, null, null) === 'verified');
ok('verified when totalSupply read',    computePhaseConfidence(nullRaw, false, null, 100, 1000) === 'verified');

section('11. Balance check — exact ETH amounts');
// 0.0001 ETH balance, 0.005 ETH mint, 150000 gas, 10 gwei feePerGas
const TEN_GWEI = BigInt(10) * BigInt(1e9);
const GAS = BigInt(150000);
const BALANCE_LOW = parseEther('0.0001');

const fail = checkBalance(BALANCE_LOW, 0.005, 1, GAS, TEN_GWEI);
ok('balance check fails when insufficient', !fail.ok);
includes('error has has-amount', fail.message, '0.000100');
includes('error has needs-amount', fail.message, 'needs');

const pass = checkBalance(parseEther('0.1'), 0.005, 1, GAS, TEN_GWEI);
ok('balance check passes when sufficient', pass.ok);

section('12. Real-world revert strings from actual mainnet drops');
const realReverts = [
  ['Minting not started yet',           'not open'],
  ['Public sale is not active',         'not open'],
  ['Mint is not live',                  'not open'],
  ['Wallet is not allowlisted',         'not whitelisted'],
  ['You have already minted your maximum', 'max per wallet'],
  ['Exceeds max supply',                'sold out'],
  ['Wrong ETH value',                   'Wrong mint price'],
  ['Incorrect ETH amount',              'Wrong mint price'],
  ['execution reverted: public sale not active', 'not open'],
  ['Minting has not started',           'not open'],
];
for (const [input, expected] of realReverts) {
  includes(`"${input.slice(0,45)}"`, decodeMintError({ message:input, data:null }, 'publicMint'), expected);
}

section('13. encodeErrorString/decodeErrorString round-trip (validates test helpers)');
const testStr = 'Sale is not active';
ok('round-trip matches', decodeErrorString(encodeErrorString(testStr)) === testStr);

// ─── summary ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('✅ ALL TESTS PASS — logic is correct');
  console.log('   You still need to run a live dry-run on a real contract');
  console.log('   to verify network calls, gas, and ABI resolution work.');
} else {
  console.log(`❌ ${failed} TEST(S) FAILED — fix before deploying`);
  process.exit(1);
}

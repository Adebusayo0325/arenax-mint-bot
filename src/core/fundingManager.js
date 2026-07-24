const { ethers } = require('ethers');
// FIX (Bug 3): Do NOT destructure MASTER_PRIVATE_KEY at module load time.
// config.MASTER_PRIVATE_KEY is set once from process.env at startup.
// When the server later sets process.env.MASTER_PRIVATE_KEY via /api/master/set,
// any destructured copy (const { MASTER_PRIVATE_KEY } = require('../config'))
// still holds the original undefined/empty string — so all funding calls fail
// silently. Reading through process.env directly at call time always gets the
// live value whether set in .env at startup or updated at runtime.
const config = require('../config');
const { DEFAULT_CHAIN_ID } = config;
const { getProvider } = require('../utils/rpcManager');
const { getGasParams, getFundingGasParams } = require('./gasOracle');
const { getNextNonce, resetNonce } = require('./nonceManager');
const logger = require('../utils/logger');

// Helper: always reads master key at call-time so runtime /api/master/set works.
function getMasterKey() {
  const key = process.env.MASTER_PRIVATE_KEY || config.MASTER_PRIVATE_KEY;
  if (!key) throw new Error('MASTER_PRIVATE_KEY not set. Add it to your Render environment variables and redeploy, or set it via the Master tab.');
  return key;
}

async function getMasterWallet(chainId) {
  const provider = await getProvider(chainId);
  const wallet = new ethers.Wallet(getMasterKey(), provider);
  if (require('../utils/securityGuard').isCompromised(wallet.address)) {
    logger.error(`🚨 MASTER WALLET (${wallet.address}) IS ON THE COMPROMISED-ADDRESS LIST. Read-only checks (balance) still work, but funding/auto-balance will refuse to use it as a source. Set a new MASTER_PRIVATE_KEY in Render env.`);
  }
  return wallet;
}

async function getMasterBalance(chainId) {
  const master = await getMasterWallet(chainId);
  const balance = await master.provider.getBalance(master.address);
  return {
    address: master.address,
    balance: ethers.formatEther(balance),
    chainId: parseInt(chainId || DEFAULT_CHAIN_ID),
  };
}

// ── FIX 1: Parallel funding — all txs sent simultaneously with sequential nonces ──
// Old code used a for..of with await tx.wait() inside, so each tx waited to be
// mined before the next was even sent. Now we:
//   1. Grab the current pending nonce once
//   2. Send every tx at once (Promise.all), each with nonce + i
//   3. Wait for all confirmations in a second parallel Promise.all
// Net result: N wallets funded in ~1 block instead of N blocks.
async function fundWallets(addresses, amountEthEach, chainId) {
  const { isCompromised } = require('../utils/securityGuard');
  const blocked = addresses.filter(isCompromised);
  const safeAddresses = addresses.filter(a => !isCompromised(a));
  if (blocked.length) {
    logger.error(`🚨 BLOCKED funding to ${blocked.length} known-compromised address(es): ${blocked.join(', ')}`);
  }

  const provider = await getProvider(chainId);
  const master   = new ethers.Wallet(getMasterKey(), provider);
  require('../utils/securityGuard').assertSafeAddress(master.address, 'master wallet as funding source');
  const gasParams = await getFundingGasParams(chainId); // v13: 1.05x tip for ETH sends
  const value    = ethers.parseEther(amountEthEach.toString());

  // Get starting nonce — 'pending' so in-flight txs are counted
  const startNonce = await provider.getTransactionCount(master.address, 'pending');
  logger.info(`Funding ${safeAddresses.length} wallets in parallel | startNonce=${startNonce}`);

  // Phase 1: broadcast all transactions simultaneously
  const sent = await Promise.all(
    safeAddresses.map(async (address, i) => {
      try {
        const tx = await master.sendTransaction({
          to: address,
          value,
          nonce: startNonce + i,
          ...gasParams,
        });
        logger.info(`Broadcast → ${address}: ${amountEthEach} ETH | nonce=${startNonce + i} | tx: ${tx.hash}`);
        return { address, status: 'pending', txHash: tx.hash, _tx: tx };
      } catch (err) {
        logger.error(`Broadcast failed for ${address}: ${err.message}`);
        return { address, status: 'failed', error: err.message, _tx: null };
      }
    })
  );

  // Phase 2: wait for all confirmations in parallel (non-blocking on each other)
  const results = await Promise.all(
    sent.map(async (r) => {
      if (!r._tx) return { address: r.address, status: r.status, error: r.error };
      try {
        await r._tx.wait();
        return { address: r.address, status: 'funded', txHash: r.txHash };
      } catch (err) {
        logger.error(`Confirmation failed for ${r.address}: ${err.message}`);
        return { address: r.address, status: 'failed', txHash: r.txHash, error: err.message };
      }
    })
  );

  const blockedResults = blocked.map(address => ({ address, status: 'blocked', error: 'Address is on the compromised-address list — refused to send funds to it.' }));
  return [...results, ...blockedResults];
}

async function drainWallet(fromAddress, getWalletSigner, chainId) {
  const provider   = await getProvider(chainId);
  const signer     = getWalletSigner(fromAddress, provider);
  const master     = new ethers.Wallet(getMasterKey(), provider);
  require('../utils/securityGuard').assertSafeAddress(master.address, 'drainWallet destination (master)');
  const gasParams = await getFundingGasParams(chainId); // v13: 1.05x tip for ETH sends
  const gasLimit   = BigInt(21000);

  const balance  = await provider.getBalance(fromAddress);
  const gasCost  = gasLimit * (gasParams.maxFeePerGas || gasParams.gasPrice);
  const sendable = balance - gasCost;

  if (sendable <= 0n) {
    return { address: fromAddress, status: 'insufficient', balance: ethers.formatEther(balance) };
  }

  const tx = await signer.sendTransaction({
    to: master.address,
    value: sendable,
    gasLimit,
    ...gasParams,
  });

  await tx.wait();
  logger.info(`Drained ${fromAddress} → master | tx: ${tx.hash}`);
  return { address: fromAddress, status: 'drained', txHash: tx.hash };
}

/**
 * v10: Auto-balance wallets before a mint.
 * Checks each wallet's balance; if below `minEth`, tops it up to `targetEth` from master.
 * Returns a summary of which wallets were topped up and which were already sufficient.
 *
 * @param {string[]} walletAddresses
 * @param {number}   minEth       - top-up threshold (e.g. 0.01)
 * @param {number}   targetEth    - top-up target (e.g. 0.05)
 * @param {number}   chainId
 */
async function autoBalanceWallets(walletAddresses, minEth, targetEth, chainId = 1) {
  if (!walletAddresses?.length) return [];

  // getMasterWallet is async — MUST be awaited or master is a Promise and .privateKey = undefined
  const master  = await getMasterWallet(chainId);
  if (!master?.address) throw new Error('MASTER_PRIVATE_KEY not configured or invalid in Render env. Check Environment → MASTER_PRIVATE_KEY.');
  require('../utils/securityGuard').assertSafeAddress(master.address, 'master wallet as auto-balance source');

  const provider  = master.provider;
  const signer    = master;
  let masterBal = await provider.getBalance(master.address);
  const minWei    = ethers.parseEther(String(minEth));
  const targetWei = ethers.parseEther(String(targetEth));
  if (targetWei <= minWei) throw new Error('Target ETH must be greater than min ETH threshold.');
  const gasParams = await getGasParams(1.05, chainId);
  const TX_GAS_COST = 21000n * (gasParams.maxFeePerGas || gasParams.gasPrice || BigInt(20e9));
  logger.info(`[AutoBalance] master=${master.address.slice(0,8)} bal=${ethers.formatEther(masterBal)} ETH wallets=${walletAddresses.length}`);

  const results = [];
  const { isCompromised } = require('../utils/securityGuard');

  for (const address of walletAddresses) {
    if (isCompromised(address)) {
      logger.error(`🚨 BLOCKED auto-balance top-up to known-compromised address: ${address}`);
      results.push({ address, status: 'blocked', error: 'Address is on the compromised-address list — refused to send funds to it.' });
      continue;
    }
    let bal;
    try { bal = await provider.getBalance(address); }
    catch(e) { results.push({ address, status: 'failed', error: `getBalance: ${e.message.slice(0,60)}` }); continue; }

    if (bal >= minWei) {
      results.push({ address, status: 'sufficient', balance: ethers.formatEther(bal) });
      continue;
    }

    const needed    = targetWei - bal;
    const totalCost = needed + TX_GAS_COST;
    if (masterBal < totalCost) {
      results.push({ address, status: 'master_insufficient', balance: ethers.formatEther(bal), needed: ethers.formatEther(needed), masterBalance: ethers.formatEther(masterBal) });
      continue;
    }

    try {
      const nonce = await getNextNonce(provider, master.address);
      const tx = await signer.sendTransaction({
        to: address,
        value: needed,
        gasLimit: 21000n,
        nonce,
        ...gasParams,
      });
      await tx.wait();
      resetNonce(master.address);
      masterBal -= totalCost;
      logger.info(`[AutoBalance] Topped ${address.slice(0,8)} +${ethers.formatEther(needed)} ETH`);
      results.push({ address, status: 'topped_up', amount: ethers.formatEther(needed), txHash: tx.hash });
    } catch(e) {
      results.push({ address, status: 'failed', error: e.message.slice(0,80) });
    }
  }

  return results;
}

module.exports = { getMasterBalance, fundWallets, drainWallet, autoBalanceWallets };

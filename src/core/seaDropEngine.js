const { ethers } = require('ethers');
const { getProvider } = require('../utils/rpcManager');
const { getGasParams, buildGasParamsFromOverride } = require('./gasOracle');
const logger = require('../utils/logger');

const SEADROP_ADDRESSES = {
  1:     '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  8453:  '0x0000000000664ceffed39244a8312bD895470803',
  10:    '0x0000000000664ceffed39244a8312bD895470803',
  42161: '0x0000000000664ceffed39244a8312bD895470803',
};
const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1F0DF003000390027140000fAa719';

const SEADROP_ABI = [
  'function getPublicDrop(address nftContract) view returns (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)',
  'function getAllowListMerkleRoot(address nftContract) view returns (bytes32)',
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  'function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTokenSupplyForStage, uint16 dropStageIndex, uint16 feeBps, bool restrictFeeRecipients) mintParams, bytes32[] proof) payable',
];

const SEADROP_TOKEN_ABI = [
  'function getAllowedSeaDrop() view returns (address[])',
];

async function isSeaDropContract(contractAddress, chainId = 1) {
  try {
    const provider = await getProvider(chainId);
    const contract = new ethers.Contract(contractAddress, SEADROP_TOKEN_ABI, provider);
    const allowed = await contract.getAllowedSeaDrop();
    const dropper = SEADROP_ADDRESSES[chainId];
    return dropper ? allowed.some(a => a.toLowerCase() === dropper.toLowerCase()) : false;
  } catch { return false; }
}

async function getSeaDropPhase(nftContract, chainId = 1) {
  const dropper = SEADROP_ADDRESSES[chainId];
  if (!dropper) throw new Error(`SeaDrop not deployed on chain ${chainId}`);
  const provider = await getProvider(chainId);
  const seadrop = new ethers.Contract(dropper, SEADROP_ABI, provider);
  const [drop, merkleRoot] = await Promise.all([
    seadrop.getPublicDrop(nftContract),
    seadrop.getAllowListMerkleRoot(nftContract).catch(() => ethers.ZeroHash),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const startTime = Number(drop.startTime);
  const endTime   = Number(drop.endTime);
  const isActive  = startTime > 0 && now >= startTime && (endTime === 0 || now < endTime);
  const hasMerkle = merkleRoot !== ethers.ZeroHash;
  return {
    mintPrice: ethers.formatEther(drop.mintPrice), mintPriceWei: drop.mintPrice,
    startTime, endTime, maxPerWallet: Number(drop.maxTotalMintableByWallet),
    feeBps: Number(drop.feeBps), isActive, hasMerkleAllowList: hasMerkle, merkleRoot,
    phase: isActive ? (hasMerkle ? 'WHITELIST' : 'PUBLIC') : (startTime === 0 ? 'UNKNOWN' : 'PAUSED'),
    confidence: 'verified',
  };
}

async function mintSeaDropPublic({ nftContract, walletAddress, privateKey, quantity = 1, mintPriceEth, gweiOverride = null, chainId = 1, dryRun = false }) {
  const dropper = SEADROP_ADDRESSES[chainId];
  if (!dropper) return { walletAddress, status: 'failed', error: `SeaDrop not on chain ${chainId}` };
  const provider = await getProvider(chainId);
  const signer   = new ethers.Wallet(privateKey, provider);
  const seadrop  = new ethers.Contract(dropper, SEADROP_ABI, signer);
  const drop     = await seadrop.getPublicDrop(nftContract);
  // Guard: startTime=0 AND mintPrice=0 → SeaDrop public drop NOT configured.
  // These are OpenSea Studio drops that mint via Seaport, not SeaDrop directly.
  if (drop.startTime === 0n && drop.mintPrice === 0n) {
    return { walletAddress, status: 'failed',
      error: 'SeaDrop public drop not configured on this contract. This is likely an OpenSea Studio/Seaport drop — mintPublic via SeaDrop will revert. Use the OpenSea mint page directly.' };
  }
  // Always use on-chain price — SeaDrop reverts with IncorrectPayment if wrong.
  // User-entered price is shown as a warning but never used for the actual value.
  const priceWei = drop.mintPrice;
  if (mintPriceEth != null) {
    const userWei = ethers.parseEther(String(mintPriceEth));
    if (userWei !== priceWei && priceWei > 0n)
      logger.info(`[SeaDrop] ⚠️  User price ${mintPriceEth} ETH ignored — on-chain: ${ethers.formatEther(priceWei)} ETH`);
  }
  const value    = priceWei * BigInt(quantity);
  const args     = [nftContract, OPENSEA_FEE_RECIPIENT, walletAddress, BigInt(quantity)];
  const balance  = await provider.getBalance(walletAddress);
  const gasParams = gweiOverride ? await buildGasParamsFromOverride(gweiOverride, chainId) : await getGasParams(1.15, chainId);
  const gasLimit = BigInt(150000);
  const feePerGas = gasParams.maxFeePerGas || gasParams.gasPrice || BigInt(20e9);
  const required  = value + feePerGas * gasLimit;
  if (balance < required) return { walletAddress, status: 'failed', error: `Insufficient: has ${ethers.formatEther(balance)} ETH, needs ~${ethers.formatEther(required)} ETH` };
  if (dryRun) {
    try {
      await seadrop.mintPublic.staticCall(...args, { value });
      return { walletAddress, status: 'dry-run-ok', fn: 'SeaDrop:mintPublic',
        value: ethers.formatEther(value), pricePerNft: ethers.formatEther(priceWei),
        note: `SeaDrop: ${ethers.formatEther(priceWei)} ETH x ${quantity} = ${ethers.formatEther(value)} ETH` };
    } catch (e) {
      const reason = e.message?.includes('IncorrectPayment') ? `IncorrectPayment — sent ${ethers.formatEther(value)} ETH, contract expects ${ethers.formatEther(priceWei)} ETH/NFT` : e.message?.slice(0, 120);
      return { walletAddress, status: 'dry-run-fail', fn: 'SeaDrop:mintPublic',
        error: reason, priceOnChain: ethers.formatEther(priceWei), valueAttempted: ethers.formatEther(value) };
    }
  }
  let tx, receipt;
  try {
    tx = await seadrop.mintPublic(...args, { value, gasLimit, ...gasParams });
    logger.info(`[SeaDrop] mintPublic tx ${tx.hash} [${walletAddress.slice(0, 8)}]`);
    receipt = await tx.wait();
  } catch (e) {
    if (e.message?.includes('IncorrectPayment') || e.message?.includes('incorrect payment')) {
      logger.warn(`[SeaDrop] IncorrectPayment — re-reading price and retrying once`);
      const freshDrop = await seadrop.getPublicDrop(nftContract);
      const freshValue = freshDrop.mintPrice * BigInt(quantity);
      tx = await seadrop.mintPublic(...args, { value: freshValue, gasLimit, ...gasParams });
      receipt = await tx.wait();
    } else throw e;
  }
  return { walletAddress, status: 'success', fn: 'SeaDrop:mintPublic', txHash: tx.hash, gasUsed: receipt.gasUsed.toString() };
}

async function mintSeaDropAllowList({ nftContract, walletAddress, privateKey, quantity = 1, gweiOverride = null, proof = [], chainId = 1, dryRun = false }) {
  const dropper = SEADROP_ADDRESSES[chainId];
  if (!dropper) return { walletAddress, status: 'failed', error: `SeaDrop not on chain ${chainId}` };
  if (!proof?.length) return { walletAddress, status: 'failed', error: 'SeaDrop allowlist requires a Merkle proof' };
  const provider = await getProvider(chainId);
  const signer   = new ethers.Wallet(privateKey, provider);
  const seadrop  = new ethers.Contract(dropper, SEADROP_ABI, signer);
  const drop     = await seadrop.getPublicDrop(nftContract);
  const value    = drop.mintPrice * BigInt(quantity);
  const mintParams = { mintPrice: drop.mintPrice, startTime: drop.startTime, endTime: drop.endTime, maxTokenSupplyForStage: 0, dropStageIndex: 1, feeBps: drop.feeBps, restrictFeeRecipients: drop.restrictFeeRecipients };
  const args = [nftContract, OPENSEA_FEE_RECIPIENT, walletAddress, BigInt(quantity), mintParams, proof];
  if (dryRun) {
    try { await seadrop.mintAllowList.staticCall(...args, { value }); return { walletAddress, status: 'dry-run-ok', fn: 'SeaDrop:mintAllowList' }; }
    catch (e) { return { walletAddress, status: 'dry-run-fail', fn: 'SeaDrop:mintAllowList', error: e.message.slice(0, 120) }; }
  }
  const gasParams = gweiOverride ? await buildGasParamsFromOverride(gweiOverride, chainId) : await getGasParams(1.15, chainId);
  const tx = await seadrop.mintAllowList(...args, { value, gasLimit: 180000n, ...gasParams });
  logger.info(`[SeaDrop] mintAllowList tx ${tx.hash} [${walletAddress.slice(0, 8)}]`);
  const receipt = await tx.wait();
  return { walletAddress, status: 'success', fn: 'SeaDrop:mintAllowList', txHash: tx.hash, gasUsed: receipt.gasUsed.toString() };
}

module.exports = { isSeaDropContract, getSeaDropPhase, mintSeaDropPublic, mintSeaDropAllowList, SEADROP_ADDRESSES, OPENSEA_FEE_RECIPIENT };

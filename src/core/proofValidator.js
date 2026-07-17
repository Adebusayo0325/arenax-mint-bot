const { ethers } = require('ethers');

function verifyProof(root, leaf, proof) {
  let computed = leaf;
  for (const p of proof) {
    if (!p || !p.startsWith('0x')) continue;
    computed = computed <= p
      ? ethers.keccak256(computed + p.slice(2))
      : ethers.keccak256(p + computed.slice(2));
  }
  return computed.toLowerCase() === root.toLowerCase();
}

async function readMerkleRoot(contract) {
  for (const fn of ['merkleRoot', 'getMerkleRoot', 'root', 'allowlistRoot', 'allowListRoot']) {
    try { const r = await contract[fn](); if (r && r !== ethers.ZeroHash) return r; } catch {}
  }
  return ethers.ZeroHash;
}

async function validateMerkleProof(contract, walletAddress, proof, quantity = null) {
  if (!proof?.length) return { valid: false, error: 'Empty proof' };
  const root = await readMerkleRoot(contract);
  if (root === ethers.ZeroHash) return { valid: true, root, scheme: 'no-merkle', note: 'No merkleRoot on contract' };
  const addr = walletAddress.toLowerCase();

  try {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['address'], [addr]);
    const leaf = ethers.keccak256(ethers.keccak256(encoded));
    if (verifyProof(root, leaf, proof)) return { valid: true, root, scheme: 'double-keccak256-abi' };
  } catch {}

  try {
    const leaf = ethers.solidityPackedKeccak256(['address'], [addr]);
    if (verifyProof(root, leaf, proof)) return { valid: true, root, scheme: 'single-keccak256-packed' };
  } catch {}

  if (quantity != null) {
    try {
      const leaf = ethers.solidityPackedKeccak256(['address', 'uint256'], [addr, BigInt(quantity)]);
      if (verifyProof(root, leaf, proof)) return { valid: true, root, scheme: 'address+quantity' };
    } catch {}
  }

  return { valid: false, root, scheme: 'none-matched', error: `Proof invalid against root ${root.slice(0,10)}...` };
}

async function validateProofMap(contract, proofMap, quantity = null) {
  const results = {};
  await Promise.all(Object.entries(proofMap).map(async ([address, proof]) => {
    results[address] = await validateMerkleProof(contract, address, proof, quantity).catch(e => ({ valid: false, error: e.message }));
  }));
  return results;
}

module.exports = { validateMerkleProof, validateProofMap, readMerkleRoot };

const { getChainEmoji, getChain } = require('../utils/chainConfig');

// v18: Added Batch Schedule, Wallet Labels/Limits, Launchpad Auto-Proof
const mainMenu = {
  inline_keyboard: [
    [{ text: '🖼 Mint NFT',         callback_data: 'menu_mint' },        { text: '⏰ Schedule Mint',    callback_data: 'menu_schedule' }],
    [{ text: '📦 Batch Schedule',   callback_data: 'menu_batch_schedule'},{ text: '🔗 Select Chain',     callback_data: 'menu_chain' }],
    [{ text: '🎨 NFT Portfolio',    callback_data: 'menu_nft' },         { text: '💰 Fund Wallets',     callback_data: 'menu_fund' }],
    [{ text: '👛 My Wallets',       callback_data: 'menu_wallets' },     { text: '🏦 Master Balance',   callback_data: 'menu_balance' }],
    [{ text: '💸 Withdraw',         callback_data: 'menu_drain' },       { text: '⚡ Pending Txs',      callback_data: 'menu_pending' }],
    [{ text: '📅 Schedules',        callback_data: 'menu_schedules' },   { text: '🔍 Check Phase',      callback_data: 'menu_check_phase' }],
    [{ text: '✅ Eligibility',      callback_data: 'menu_eligibility' }, { text: '🔐 Load Proofs',      callback_data: 'menu_load_proofs' }],
    [{ text: '⛽ TX Manager',       callback_data: 'menu_tx_manager' },  { text: '📋 Logs',             callback_data: 'menu_logs' }],
  ],
};

const chainMenu = {
  inline_keyboard: [
    [{ text: '⟠ Ethereum (1)',    callback_data: 'chain_1' },      { text: '🔵 Base (8453)',      callback_data: 'chain_8453' }],
    [{ text: '🔷 Arbitrum',       callback_data: 'chain_42161' },  { text: '🔴 Optimism',         callback_data: 'chain_10' }],
    [{ text: '💜 Polygon',        callback_data: 'chain_137' },    { text: '🟡 BNB Chain',        callback_data: 'chain_56' }],
    [{ text: '🔥 Blast',          callback_data: 'chain_81457' },  { text: '🟢 Linea',            callback_data: 'chain_59144' }],
    [{ text: '🎨 Zora',           callback_data: 'chain_7777777' },{ text: '🔺 Avalanche',        callback_data: 'chain_43114' }],
    [{ text: '🔵 ApeChain',       callback_data: 'chain_33139' },  { text: '🏹 Robinhood Chain', callback_data: 'chain_4663' }],
    [{ text: '🔙 Back',           callback_data: 'menu_main' }],
  ],
};

const nftMenu = {
  inline_keyboard: [
    [{ text: '📋 My NFTs',       callback_data: 'nft_list' },     { text: '📊 Listed Count',   callback_data: 'nft_listed_count' }],
    [{ text: '💰 List for Sale', callback_data: 'nft_list_sale' },{ text: '📈 List at Floor',  callback_data: 'nft_list_floor' }],
    [{ text: '🧹 Sweep Floor',   callback_data: 'nft_sweep' }],
    [{ text: '🔙 Back',          callback_data: 'menu_main' }],
  ],
};

// v18: added Launchpad Auto-Proof option
const proofModeMenu = {
  inline_keyboard: [
    [{ text: '🔓 None (public mint)',                callback_data: 'proof_none' }],
    [{ text: '🤖 Auto (on-chain eligibility check)', callback_data: 'proof_auto' }],
    [{ text: '🌐 Launchpad Auto-Proof (v18)',        callback_data: 'proof_launchpad' }],
    [{ text: '📋 Per-wallet JSON map',               callback_data: 'proof_json' }],
    [{ text: '🔑 Single proof for all wallets',      callback_data: 'proof_single' }],
    [{ text: '✍️ EIP-712 Signature (per-wallet)',    callback_data: 'proof_eip712' }],
    [{ text: '🔒 Flashbots (private relay)',         callback_data: 'proof_flashbots' }],
    [{ text: '❌ Cancel', callback_data: 'menu_cancel' }],
  ],
};

// v18: schedule proof modes also include Launchpad
const scheduleProofModeMenu = {
  inline_keyboard: [
    [{ text: '🔓 None (public mint)',                callback_data: 'sched_proof_none' }],
    [{ text: '🤖 Auto (on-chain eligibility check)', callback_data: 'sched_proof_auto' }],
    [{ text: '🌐 Launchpad Auto-Proof (v18)',        callback_data: 'sched_proof_launchpad' }],
    [{ text: '📋 Per-wallet JSON map',               callback_data: 'sched_proof_json' }],
    [{ text: '🔑 Single proof for all wallets',      callback_data: 'sched_proof_single' }],
    [{ text: '✍️ EIP-712 Signature (per-wallet)',    callback_data: 'sched_proof_eip712' }],
    [{ text: '🔒 Flashbots (private relay)',         callback_data: 'sched_proof_flashbots' }],
    [{ text: '❌ Cancel', callback_data: 'menu_cancel' }],
  ],
};

const scheduleTriggerMenu = {
  inline_keyboard: [
    [{ text: '⏰ Time (exact datetime)',            callback_data: 'sched_trigger_time' }],
    [{ text: '🔍 Phase (poll until open)',          callback_data: 'sched_trigger_phase' }],
    [{ text: '🔀 Both (time then poll)',            callback_data: 'sched_trigger_both' }],
    [{ text: '❌ Cancel', callback_data: 'menu_cancel' }],
  ],
};

const cancelMenu = { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'menu_cancel' }]] };
const backMenu   = { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]] };

const confirmMenu = (action) => ({
  inline_keyboard: [[
    { text: '✅ Confirm', callback_data: `confirm_${action}` },
    { text: '❌ Cancel',  callback_data: 'menu_cancel' },
  ]],
});

// v18: wallet list shows label + spend limit indicator
const walletsMenu = (wallets) => ({
  inline_keyboard: [
    ...wallets.map((w, i) => ([{
      text: `${w.label || `Wallet ${i + 1}`} | ${w.address.slice(0, 6)}...${w.address.slice(-4)}${w.spendLimit != null ? ` 🚦${w.spendLimit}E` : ''}`,
      callback_data: `wallet_info_${w.address}`,
    }])),
    [{ text: '➕ Add Wallet', callback_data: 'wallet_add' }],
    [{ text: '🔙 Back', callback_data: 'menu_main' }],
  ],
});

const pendingTxMenu = (pendingTxs) => {
  const entries = Object.entries(pendingTxs);
  if (!entries.length) return backMenu;
  const buttons = entries.slice(0, 10).map(([hash, info]) => ([
    { text: `⚡ ${hash.slice(0, 8)}... ${info.walletAddress.slice(0, 6)}...`, callback_data: `pending_info_${hash}` },
  ]));
  return {
    inline_keyboard: [
      ...buttons,
      [{ text: '🔙 Back', callback_data: 'menu_main' }],
    ],
  };
};

const pendingTxActionMenu = (txHash) => ({
  inline_keyboard: [
    [{ text: '⚡ Speed Up (1.15x gas)', callback_data: `speedup_${txHash}` }],
    [{ text: '🚫 Cancel TX',            callback_data: `canceltx_${txHash}` }],
    [{ text: '🔙 Back',                 callback_data: 'menu_pending' }],
  ],
});

module.exports = {
  mainMenu, chainMenu, nftMenu, cancelMenu, backMenu, confirmMenu,
  walletsMenu, proofModeMenu, scheduleProofModeMenu, scheduleTriggerMenu,
  pendingTxMenu, pendingTxActionMenu,
};

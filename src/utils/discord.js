/**
 * v10: Discord Webhook Notifier
 * Set DISCORD_WEBHOOK_URL in Render env vars to receive mint result notifications.
 * If not set, all functions are no-ops — fully optional.
 */
const axios  = require('axios');
const logger = require('./logger');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

async function sendDiscordEmbed(embed) {
  if (!WEBHOOK_URL) return; // not configured — silent no-op
  try {
    await axios.post(WEBHOOK_URL, { embeds: [embed] }, { timeout: 8000 });
  } catch(e) {
    logger.warn(`Discord webhook failed: ${e.message.slice(0, 80)}`);
  }
}

/**
 * Send a mint session result to Discord.
 * @param {object} opts
 * @param {string} opts.contractAddress
 * @param {string} opts.collectionName
 * @param {number} opts.chainId
 * @param {Array}  opts.results        - mint results array
 * @param {boolean} opts.dryRun
 * @param {string}  opts.explorerBase  - e.g. https://etherscan.io
 */
async function notifyMintResult({ contractAddress, collectionName, chainId, results, dryRun, explorerBase }) {
  if (!WEBHOOK_URL) return;

  const successCount = results.filter(r => r.status === 'success' || r.status === 'dry-run-ok').length;
  const failCount    = results.filter(r => r.status === 'failed'  || r.status === 'dry-run-fail').length;
  const total        = results.length;
  const allGood      = failCount === 0;
  const color        = dryRun ? 0x7289da : allGood ? 0x57f287 : successCount > 0 ? 0xfee75c : 0xed4245;

  const fields = results.slice(0, 10).map(r => {
    const status = r.status === 'success' || r.status === 'dry-run-ok' ? '✅' : '❌';
    const txLink = r.txHash && explorerBase ? `[tx](${explorerBase}/tx/${r.txHash})` : r.txHash?.slice(0,10) || '';
    const err    = r.error ? ` — ${r.error.slice(0,60)}` : '';
    return {
      name:   `${status} ${r.walletAddress?.slice(0,10)}...`,
      value:  `${r.status} ${txLink}${err}`,
      inline: false,
    };
  });

  await sendDiscordEmbed({
    title:       `${dryRun ? '🧪 Dry Run' : '🚀 Mint'} ${dryRun ? 'Simulated' : 'Complete'} — ${collectionName || contractAddress.slice(0,10)}`,
    description: `✅ **${successCount}** success  ❌ **${failCount}** failed  of **${total}** wallets`,
    color,
    fields,
    footer: { text: `ArenaX Mint Bot • Chain ${chainId}` },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Send a scheduled mint countdown notification.
 */
async function notifyScheduleCountdown({ contractAddress, mintTime, secondsLeft }) {
  if (!WEBHOOK_URL || secondsLeft > 300) return; // only notify inside 5 mins
  await sendDiscordEmbed({
    title:       `⏳ Scheduled Mint in ${Math.ceil(secondsLeft / 60)} min`,
    description: `Contract: \`${contractAddress}\`\nTime: **${mintTime}**`,
    color:       0xf0b840,
    footer:      { text: 'ArenaX Mint Bot' },
    timestamp:   new Date().toISOString(),
  });
}

module.exports = { notifyMintResult, notifyScheduleCountdown };

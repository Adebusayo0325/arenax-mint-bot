const TelegramBot = require('node-telegram-bot-api');
const { BOT_TOKEN, ALLOWED_USER_ID, WEBAPP_URL } = require('../config');
const {
  handleStart, handleCallback, handleMessage,
  handleConfirmMint, handleConfirmSchedule, handleConfirmFund,
  handleConfirmNFTList, handleConfirmNFTFloor, handleConfirmNFTSweep,
} = require('./commands');
const logger = require('../utils/logger');

if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing from env');

let bot;
if (process.env.NODE_ENV === 'production') {
  bot = new TelegramBot(BOT_TOKEN);
  bot.setWebHook(`${WEBAPP_URL}/bot${BOT_TOKEN}`);
  logger.info('Bot: webhook mode');
} else {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  logger.info('Bot: polling mode');
}

function isAllowed(userId) {
  // Fail-closed: if ALLOWED_USER_ID is missing/invalid, deny all access.
  // This prevents the bot becoming publicly accessible on misconfiguration.
  if (!ALLOWED_USER_ID || isNaN(ALLOWED_USER_ID)) {
    logger.error('ALLOWED_USER_ID not configured — all bot access denied. Set it in Render env vars.');
    return false;
  }
  return userId === ALLOWED_USER_ID;
}

async function rejectUnauthorized(bot, chatId) {
  try {
    await bot.sendMessage(chatId,
      '🔒 *Unauthorized.*\n\nThis is a private bot. If you own this bot, set `ALLOWED_USER_ID` in your Render environment variables to your Telegram user ID.',
      { parse_mode: 'Markdown' }
    );
  } catch(e) {}
}

bot.onText(/\/start/, async (msg) => {
  if (!isAllowed(msg.from.id)) { await rejectUnauthorized(bot, msg.chat.id); return; }
  await handleStart(bot, msg);
});

bot.on('callback_query', async (query) => {
  if (!isAllowed(query.from.id)) return;
  try {
    if (query.data === 'confirm_mint_now')  return handleConfirmMint(bot, query);
    if (query.data === 'confirm_schedule')  return handleConfirmSchedule(bot, query);
    if (query.data === 'confirm_fund')      return handleConfirmFund(bot, query);
    if (query.data === 'confirm_nft_list')  return handleConfirmNFTList(bot, query);
    if (query.data === 'confirm_nft_floor') return handleConfirmNFTFloor(bot, query);
    if (query.data === 'confirm_nft_sweep') return handleConfirmNFTSweep(bot, query);
    await handleCallback(bot, query);
  } catch (err) {
    if (err.message?.includes('query is too old') || err.message?.includes('ETELEGRAM')) return;
    logger.error(`Callback error: ${err.message}`);
    try { await bot.answerCallbackQuery(query.id, { text: `Error: ${err.message.slice(0,50)}` }); } catch(e) {}
  }
});

bot.on('message', async (msg) => {
  if (!isAllowed(msg.from.id)) { await rejectUnauthorized(bot, msg.chat.id); return; }
  await handleMessage(bot, msg);
});

bot.on('polling_error', (err) => logger.error(`Polling error: ${err.message}`));

module.exports = bot;

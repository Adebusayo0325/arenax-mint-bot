const winston = require('winston');
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../logs');
try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {}

const SENSITIVE_PATTERNS = [
  { pattern: /([&?]x-api-key=)[a-f0-9]{20,}/gi, replacement: '$1[REDACTED]' },
  { pattern: /0x[a-fA-F0-9]{64}/g, replacement: '0x[PRIVATE_KEY_REDACTED]' },
  { pattern: /(Bearer\s+)[A-Za-z0-9\-._~+/]{20,}/g, replacement: '$1[REDACTED]' },
  { pattern: /(x-api-key['":\s]+)[a-f0-9]{20,}/gi, replacement: '$1[REDACTED]' },
];

function scrub(message) {
  if (typeof message !== 'string') return message;
  let out = message;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

const scrubFormat = winston.format((info) => {
  info.message = scrub(String(info.message));
  return info;
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    scrubFormat(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    ...(fs.existsSync(LOG_DIR) ? [new winston.transports.File({ filename: path.join(LOG_DIR, 'bot.log') })] : []),
  ],
});

module.exports = logger;

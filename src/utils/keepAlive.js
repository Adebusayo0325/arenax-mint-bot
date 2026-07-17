const https = require('https');
const logger = require('./logger');

function keepAlive(url) {
  setInterval(() => {
    https.get(url, (res) => {
      logger.info(`Keepalive ping: ${res.statusCode}`);
    }).on('error', (err) => {
      logger.warn(`Keepalive failed: ${err.message}`);
    });
  }, 10 * 60 * 1000);

  logger.info(`Keepalive started → ${url}`);
}

module.exports = { keepAlive };

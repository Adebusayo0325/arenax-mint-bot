/**
 * redisClient.js — graceful Redis wrapper with automatic JSON fallback.
 *
 * Toggle: set REDIS_URL in env → Redis enabled.
 *         Leave it unset     → everything falls back to JSON files silently.
 *
 * Never throws — all methods are safe to call whether Redis is up or not.
 */
const Redis  = require('ioredis');
const config = require('../config');
const logger = require('./logger');

let _client = null;

async function getRedis() {
  if (_client) return _client;
  const url = config.REDIS_URL;
  if (!url) return null;

  try {
    const c = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck:     false,
      lazyConnect:          true,
      connectTimeout:       5000,
    });
    await c.connect();
    c.on('error', e  => { logger.warn(`[Redis] ${e.message}`); _client = null; });
    c.on('close', () => { _client = null; });
    _client = c;
    logger.info('[Redis] ✅ Connected');
    return _client;
  } catch (e) {
    logger.warn(`[Redis] Not available (${e.message}) — JSON fallback active`);
    return null;
  }
}

const safe = fn => fn().catch(() => null);

async function rGet(key)              { const r = await getRedis(); return r ? safe(() => r.get(key))           : null; }
async function rSet(key, val, ex)     { const r = await getRedis(); if (!r) return; ex ? r.set(key,val,'EX',ex).catch(()=>{}) : r.set(key,val).catch(()=>{}); }
async function rDel(key)              { const r = await getRedis(); if (!r) return; r.del(key).catch(()=>{}); }
async function rHSet(h, f, v)         { const r = await getRedis(); if (!r) return; r.hset(h,f,v).catch(()=>{}); }
async function rHDel(h, f)            { const r = await getRedis(); if (!r) return; r.hdel(h,f).catch(()=>{}); }
async function rHGetAll(h)            { const r = await getRedis(); return r ? safe(() => r.hgetall(h)) : null; }
async function isAvailable()          { return (await getRedis()) !== null; }

module.exports = { getRedis, rGet, rSet, rDel, rHSet, rHDel, rHGetAll, isAvailable };

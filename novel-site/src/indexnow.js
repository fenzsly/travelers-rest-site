// IndexNow: tells Bing, Yandex, Seznam, Naver and other participating search engines about new or updated
// pages right away (Google doesn't take part; it uses the sitemap submitted in Search Console).
// Runs every 10 minutes, so uploads, single chapters, scheduled releases and bundled novels are all covered.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR } = require('./db');
const { getSettings } = require('./settings');
const { VISIBLE, RELEASED } = require('./queries');
const { formatNumber } = require('./util');

const KEY_FILE = path.join(DATA_DIR, 'indexnow-key');
const STATE_FILE = path.join(DATA_DIR, 'indexnow-state.json');
const ENDPOINT = 'https://api.indexnow.org/IndexNow';
const EVERY_MS = 10 * 60 * 1000;

function key() {
  if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(16).toString('hex'));
  return fs.readFileSync(KEY_FILE, 'utf8').trim();
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function baseUrl() {
  return (process.env.PUBLIC_URL || '').replace(/\/$/, '');
}

/** URLs released since `since` (unix seconds). On the very first run, the main pages and recent chapters. */
function changedUrls(base, since) {
  const urls = new Set();
  const chapters = db.prepare(`SELECT n.slug, c.number FROM chapters c JOIN novels n ON n.id = c.novel_id
    WHERE ${VISIBLE} AND ${RELEASED} > ? ORDER BY ${RELEASED} DESC LIMIT 5000`).all(since);
  for (const c of chapters) {
    urls.add(`${base}/novel/${c.slug}`);
    urls.add(`${base}/novel/${c.slug}/c/${formatNumber(c.number)}`);
  }
  for (const n of db.prepare('SELECT slug FROM novels WHERE created_at > ? OR updated_at > ?').all(since, since)) urls.add(`${base}/novel/${n.slug}`);
  if (urls.size || !since) urls.add(`${base}/`);
  if (!since) {
    urls.add(`${base}/novels`);
    urls.add(`${base}/about`);
    for (const n of db.prepare('SELECT slug FROM novels').all()) urls.add(`${base}/novel/${n.slug}`);
  }
  return [...urls].slice(0, 10000);
}

async function run({ log = console.log } = {}) {
  const base = baseUrl();
  if (!base || !/^https:\/\//.test(base) || getSettings().search_indexing === '0') return null;
  const state = readState();
  const now = Math.floor(Date.now() / 1000);
  const urls = changedUrls(base, state?.last || 0);
  if (!urls.length) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, last: now, checked: now }));
    return null;
  }
  let result;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: new URL(base).host, key: key(), keyLocation: `${base}/indexnow-key.txt`, urlList: urls }),
      signal: AbortSignal.timeout(20000),
    });
    result = res.ok ? 'ok' : `HTTP ${res.status}`;
  } catch (err) {
    result = `failed: ${err.message}`;
  }
  // On failure keep the old timestamp so the same pages are sent again next time.
  const ok = result === 'ok';
  fs.writeFileSync(STATE_FILE, JSON.stringify({ last: ok ? now : state?.last || 0, checked: now, result, count: urls.length, sentAt: now }));
  log(`IndexNow: ${ok ? `notified search engines about ${urls.length} page(s)` : result}`);
  return { result, count: urls.length };
}

function start() {
  const tick = () => run().catch((err) => console.error('IndexNow error:', err.message));
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, EVERY_MS).unref();
}

function status() {
  return { enabled: /^https:\/\//.test(baseUrl()), state: readState() };
}

module.exports = { key, run, start, status, changedUrls };

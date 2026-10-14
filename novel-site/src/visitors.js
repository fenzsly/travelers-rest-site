// Daily unique visitors / readers, privacy-friendly:
//  - logged-in readers count once per day by account;
//  - guests count once per day by an anonymous code made from (date, IP address, browser) with a secret key.
//    The code can't be turned back into an IP address and changes every day, so nobody is tracked across days.
// Bots are not counted. Raw rows are kept for 120 days; the admin panel shows daily totals.
const { db } = require('./db');
const { BOT_RE } = require('./queries');
const { keyedHash } = require('./security');

const today = () => new Date().toISOString().slice(0, 10);

let cacheDay = '';
const seen = new Set(); // "site:visitor" / "novelId:visitor" already written today
function remember(key) {
  const d = today();
  if (d !== cacheDay) {
    cacheDay = d;
    seen.clear();
    cleanup(); // once a day (and on start)
  }
  if (seen.has(key)) return false;
  if (seen.size > 500000) seen.clear(); // memory safety; the database ignores duplicates anyway
  seen.add(key);
  return true;
}

function visitorId(req) {
  if (req.user) return `u${req.user.id}`;
  return keyedHash(`${today()}|${req.ip}|${req.get('user-agent') || ''}`).slice(0, 20);
}

const isBot = (req) => BOT_RE.test(req.get('user-agent') || '') || !req.get('user-agent');

const insertVisit = db.prepare('INSERT OR IGNORE INTO site_visitors_daily (day, visitor) VALUES (?, ?)');
const insertReader = db.prepare('INSERT OR IGNORE INTO novel_readers_daily (novel_id, day, visitor) VALUES (?, ?, ?)');

/** Count this visitor for today (call on page views). */
function recordVisit(req) {
  if (isBot(req)) return;
  const v = visitorId(req);
  if (remember(`site:${v}`)) insertVisit.run(today(), v);
}

/** Count this visitor as a reader of the novel today (call on chapter views). */
function recordReader(req, novelId) {
  if (isBot(req)) return;
  const v = visitorId(req);
  if (remember(`${novelId}:${v}`)) insertReader.run(novelId, today(), v);
}

function cleanup() {
  db.prepare("DELETE FROM site_visitors_daily WHERE day < date('now', '-120 days')").run();
  db.prepare("DELETE FROM novel_readers_daily WHERE day < date('now', '-120 days')").run();
}

function fillDays(days, rows) {
  const byDay = Object.fromEntries(rows.map((r) => [r.day, r.n]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ day, views: byDay[day] || 0 });
  }
  return out;
}

/** Unique visitors to the whole site per day: [{ day, views }] (views = unique people). */
function siteVisitorsByDay(days = 30) {
  return fillDays(days, db.prepare(`SELECT day, COUNT(*) AS n FROM site_visitors_daily WHERE day >= date('now', ?) GROUP BY day`).all(`-${days - 1} days`));
}

/** Unique readers per day across the given novels (a person reading two novels counts once). */
function readersByDay(days, novelIds) {
  if (!novelIds.length) return fillDays(days, []);
  return fillDays(days, db.prepare(`SELECT day, COUNT(DISTINCT visitor) AS n FROM novel_readers_daily
    WHERE day >= date('now', ?) AND novel_id IN (${novelIds.map(() => '?').join(',')}) GROUP BY day`).all(`-${days - 1} days`, ...novelIds));
}

module.exports = { recordVisit, recordReader, siteVisitorsByDay, readersByDay, visitorId };

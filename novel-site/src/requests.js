// Novel requests: readers suggest novels to translate and vote. The leaderboard resets every week
// (Monday 00:00 UTC): each reader gets one vote per request per week.
const { db, tx } = require('./db');

const REQUEST_STATUS = { open: 'Requested', planned: 'Planned', added: 'Added', declined: 'Declined' };
const LANGUAGES = ['Chinese', 'Korean', 'Japanese', 'Other'];
const DAILY_LIMIT = 5; // new requests per reader per 24 hours
const DAY = 86400000;

/** The week a moment belongs to: { key: 'YYYY-MM-DD' of its Monday (UTC), start, end (ms) }. */
function weekOf(ms = Date.now()) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
  return { key: new Date(start).toISOString().slice(0, 10), start, end: start + 7 * DAY };
}

function columns(week) {
  return {
    sql: `r.*,
      (SELECT COUNT(*) FROM request_votes v WHERE v.request_id = r.id) AS votes,
      (SELECT COUNT(*) FROM request_votes v WHERE v.request_id = r.id AND v.week = ?) AS week_votes,
      (SELECT u.username FROM users u WHERE u.id = r.user_id) AS username,
      (SELECT n.slug FROM novels n WHERE n.id = r.novel_id) AS novel_slug,
      (SELECT n.title FROM novels n WHERE n.id = r.novel_id) AS novel_title`,
    params: [week],
  };
}

const SORTS = {
  week: 'week_votes DESC, votes DESC, r.created_at DESC',
  all: 'votes DESC, r.created_at DESC',
  new: 'r.created_at DESC',
};

/** Normalised title used to spot duplicates ("The Lord's Path!" = "the lords path"). */
function titleKey(title) {
  return String(title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC').replace(/['‘’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function fail(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** Requests for a list. `statuses` is an array; `userId` adds a `voted` flag (voted this week). */
function listRequests({ statuses = ['open', 'planned'], sort = 'week', userId = 0, limit = 50, offset = 0 } = {}) {
  const week = weekOf().key;
  const c = columns(week);
  const marks = statuses.map(() => '?').join(', ');
  return db.prepare(`SELECT ${c.sql}, EXISTS (SELECT 1 FROM request_votes v WHERE v.request_id = r.id AND v.user_id = ? AND v.week = ?) AS voted
    FROM novel_requests r WHERE r.status IN (${marks}) ORDER BY ${SORTS[sort] || SORTS.week} LIMIT ? OFFSET ?`)
    .all(...c.params, userId, week, ...statuses, limit, offset);
}

function countRequests(statuses) {
  return db.prepare(`SELECT COUNT(*) AS n FROM novel_requests WHERE status IN (${statuses.map(() => '?').join(', ')})`).get(...statuses).n;
}

/** This week's leaderboard: requests with at least one vote this week, most votes first. */
function topThisWeek(limit = 5) {
  const c = columns(weekOf().key);
  return db.prepare(`SELECT * FROM (SELECT ${c.sql} FROM novel_requests r WHERE r.status IN ('open', 'planned'))
    WHERE week_votes > 0 ORDER BY week_votes DESC, votes DESC LIMIT ?`).all(...c.params, limit);
}

/** Winners of past weeks: [{ week, start, top: [{ id, title, votes, status, novel_slug }] }], newest first. */
function pastWeeks(weeks = 4, perWeek = 3) {
  const current = weekOf().key;
  const rows = db.prepare(`SELECT v.week, r.id, r.title, r.status, COUNT(*) AS votes,
      (SELECT n.slug FROM novels n WHERE n.id = r.novel_id) AS novel_slug
    FROM request_votes v JOIN novel_requests r ON r.id = v.request_id
    WHERE v.week < ? AND v.week IN (SELECT DISTINCT week FROM request_votes WHERE week < ? ORDER BY week DESC LIMIT ?)
    GROUP BY v.week, r.id ORDER BY v.week DESC, votes DESC, r.created_at ASC`).all(current, current, weeks);
  const out = [];
  for (const row of rows) {
    let w = out.find((x) => x.week === row.week);
    if (!w) out.push(w = { week: row.week, start: Date.parse(`${row.week}T00:00:00Z`), top: [] });
    if (w.top.length < perWeek) w.top.push(row);
  }
  return out;
}

function getRequest(id) {
  const c = columns(weekOf().key);
  return db.prepare(`SELECT ${c.sql} FROM novel_requests r WHERE r.id = ?`).get(...c.params, Number(id)) || null;
}

function cleanLink(link) {
  link = String(link || '').trim();
  if (!link) return '';
  if (!/^https?:\/\//i.test(link)) link = `https://${link}`;
  try {
    const url = new URL(link);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) throw new Error();
    return url.href.slice(0, 300);
  } catch {
    throw fail('That link doesn’t look right. Paste the full address, e.g. https://…');
  }
}

function vote(requestId, userId) {
  db.prepare('INSERT OR IGNORE INTO request_votes (request_id, user_id, week) VALUES (?, ?, ?)').run(requestId, userId, weekOf().key);
}

/**
 * Create a request (and vote for it). If the same novel was already requested, vote for that one instead.
 * Returns { request, duplicate, novel } where `novel` is set when the site already has it.
 */
function createRequest(userId, input) {
  const title = String(input.title || '').replace(/\s+/g, ' ').trim();
  if (title.length < 2 || title.length > 150) throw fail('Please enter the novel’s title (2–150 characters).');
  const key = titleKey(title);
  if (!key) throw fail('Please enter the novel’s title.');

  // Already on the site?
  const novel = db.prepare('SELECT id, slug, title, alt_titles FROM novels').all()
    .find((n) => titleKey(n.title) === key || String(n.alt_titles || '').split(/[,;\n]/).some((t) => titleKey(t) === key));
  if (novel) return { request: null, duplicate: false, novel };

  const existing = db.prepare("SELECT id, status FROM novel_requests WHERE title_key = ? ORDER BY status = 'declined', id LIMIT 1").get(key);
  if (existing) {
    if (['open', 'planned'].includes(existing.status)) vote(existing.id, userId);
    return { request: getRequest(existing.id), duplicate: true, novel: null };
  }

  const recent = db.prepare('SELECT COUNT(*) AS n FROM novel_requests WHERE user_id = ? AND created_at >= unixepoch() - 86400').get(userId).n;
  if (recent >= DAILY_LIMIT) throw fail(`You can request up to ${DAILY_LIMIT} novels a day. Vote for others in the meantime!`);

  const language = LANGUAGES.includes(input.language) ? input.language : '';
  const fields = {
    author: String(input.author || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    link: cleanLink(input.link),
    note: String(input.note || '').trim().slice(0, 600),
  };
  const id = tx(() => {
    const rid = Number(db.prepare('INSERT INTO novel_requests (user_id, title, title_key, author, language, link, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, title, key, fields.author, language, fields.link, fields.note).lastInsertRowid);
    vote(rid, userId);
    return rid;
  });
  return { request: getRequest(id), duplicate: false, novel: null };
}

/** Add or remove the reader's vote for this week. Returns { voted, votes, week_votes }. */
function toggleVote(requestId, userId) {
  const r = db.prepare('SELECT id, status FROM novel_requests WHERE id = ?').get(Number(requestId));
  if (!r) throw Object.assign(new Error('Request not found.'), { status: 404 });
  const week = weekOf().key;
  const had = db.prepare('SELECT 1 FROM request_votes WHERE request_id = ? AND user_id = ? AND week = ?').get(r.id, userId, week);
  if (had) db.prepare('DELETE FROM request_votes WHERE request_id = ? AND user_id = ? AND week = ?').run(r.id, userId, week);
  else {
    if (!['open', 'planned'].includes(r.status)) throw fail('Voting is closed for this request.');
    vote(r.id, userId);
  }
  const fresh = getRequest(r.id);
  return { voted: !had, votes: fresh.votes, week_votes: fresh.week_votes };
}

module.exports = { REQUEST_STATUS, LANGUAGES, DAILY_LIMIT, weekOf, titleKey, listRequests, countRequests, topThisWeek, pastWeeks, getRequest, createRequest, toggleVote };

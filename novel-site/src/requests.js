// Novel requests: readers suggest novels to translate and vote; ranked by votes this week.
const { db, tx } = require('./db');

const REQUEST_STATUS = { open: 'Requested', planned: 'Planned', added: 'Added', declined: 'Declined' };
const LANGUAGES = ['Chinese', 'Korean', 'Japanese', 'Other'];
const DAILY_LIMIT = 5; // new requests per reader per 24 hours

const COLUMNS = `r.*,
  (SELECT COUNT(*) FROM request_votes v WHERE v.request_id = r.id) AS votes,
  (SELECT COUNT(*) FROM request_votes v WHERE v.request_id = r.id AND v.created_at >= unixepoch() - 7 * 86400) AS week_votes,
  (SELECT u.username FROM users u WHERE u.id = r.user_id) AS username,
  (SELECT n.slug FROM novels n WHERE n.id = r.novel_id) AS novel_slug,
  (SELECT n.title FROM novels n WHERE n.id = r.novel_id) AS novel_title`;

const SORTS = {
  week: 'week_votes DESC, votes DESC, r.created_at DESC',
  all: 'votes DESC, r.created_at DESC',
  new: 'r.created_at DESC',
};

/** Normalised title used to spot duplicates ("The Lord's Path!" = "the lords path"). */
function titleKey(title) {
  return String(title || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').replace(/['\u2018\u2019`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function fail(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** Requests for a list. `statuses` is an array; `userId` adds a `voted` flag. */
function listRequests({ statuses = ['open', 'planned'], sort = 'week', userId = 0, limit = 50, offset = 0 } = {}) {
  const marks = statuses.map(() => '?').join(', ');
  return db.prepare(`SELECT ${COLUMNS}, EXISTS (SELECT 1 FROM request_votes v WHERE v.request_id = r.id AND v.user_id = ?) AS voted
    FROM novel_requests r WHERE r.status IN (${marks}) ORDER BY ${SORTS[sort] || SORTS.week} LIMIT ? OFFSET ?`)
    .all(userId, ...statuses, limit, offset);
}

function countRequests(statuses) {
  return db.prepare(`SELECT COUNT(*) AS n FROM novel_requests WHERE status IN (${statuses.map(() => '?').join(', ')})`).get(...statuses).n;
}

/** Top requests by votes in the last 7 days (for the home page). */
function topThisWeek(limit = 5) {
  return db.prepare(`SELECT * FROM (SELECT ${COLUMNS} FROM novel_requests r WHERE r.status IN ('open', 'planned'))
    WHERE week_votes > 0 ORDER BY week_votes DESC, votes DESC LIMIT ?`).all(limit);
}

function getRequest(id) {
  return db.prepare(`SELECT ${COLUMNS} FROM novel_requests r WHERE r.id = ?`).get(Number(id)) || null;
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

  const existing = db.prepare("SELECT id FROM novel_requests WHERE title_key = ? ORDER BY status = 'declined', id LIMIT 1").get(key);
  if (existing) {
    db.prepare('INSERT OR IGNORE INTO request_votes (request_id, user_id) VALUES (?, ?)').run(existing.id, userId);
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
    db.prepare('INSERT INTO request_votes (request_id, user_id) VALUES (?, ?)').run(rid, userId);
    return rid;
  });
  return { request: getRequest(id), duplicate: false, novel: null };
}

/** Add or remove the reader's vote. Returns { voted, votes, week_votes }. */
function toggleVote(requestId, userId) {
  const r = db.prepare('SELECT id, status FROM novel_requests WHERE id = ?').get(Number(requestId));
  if (!r) throw Object.assign(new Error('Request not found.'), { status: 404 });
  const had = db.prepare('SELECT 1 FROM request_votes WHERE request_id = ? AND user_id = ?').get(r.id, userId);
  if (had) db.prepare('DELETE FROM request_votes WHERE request_id = ? AND user_id = ?').run(r.id, userId);
  else {
    if (!['open', 'planned'].includes(r.status)) throw fail('Voting is closed for this request.');
    db.prepare('INSERT INTO request_votes (request_id, user_id) VALUES (?, ?)').run(r.id, userId);
  }
  const fresh = getRequest(r.id);
  return { voted: !had, votes: fresh.votes, week_votes: fresh.week_votes };
}

module.exports = { REQUEST_STATUS, LANGUAGES, DAILY_LIMIT, titleKey, listRequests, countRequests, topThisWeek, getRequest, createRequest, toggleVote };

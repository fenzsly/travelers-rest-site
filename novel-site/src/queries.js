// Reusable SQL shared by public and admin routes.
const { db } = require('./db');
const { hashPassword, verifyPassword } = require('./auth');
const { getSettings } = require('./settings');
const { slugify } = require('./util');

// A chapter is public once its scheduled time (if any) has passed.
const VISIBLE = '(c.publish_at IS NULL OR c.publish_at <= unixepoch())';
// When a chapter was (or will be) released.
const RELEASED = 'COALESCE(c.publish_at, c.created_at)';

const COMMON_COLUMNS = `
  n.*,
  (SELECT ROUND(AVG(score), 1) FROM ratings r WHERE r.novel_id = n.id) AS rating,
  (SELECT COUNT(*) FROM ratings r WHERE r.novel_id = n.id) AS rating_count,
  (SELECT group_concat(g.name, ', ') FROM novel_genres ng JOIN genres g ON g.id = ng.genre_id WHERE ng.novel_id = n.id) AS genre_names,
  (SELECT u.username FROM users u WHERE u.id = n.owner_id) AS translator,
  (SELECT COALESCE(SUM(d.views), 0) FROM novel_views_daily d WHERE d.novel_id = n.id AND d.day >= date('now', '-6 days')) AS views_week,
  (SELECT COALESCE(SUM(d.views), 0) FROM novel_views_daily d WHERE d.novel_id = n.id AND d.day >= date('now', '-29 days')) AS views_month
`;

// Public pages: only released chapters count.
const NOVEL_COLUMNS = `${COMMON_COLUMNS},
  (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id AND ${VISIBLE}) AS chapter_count,
  (SELECT MAX(c.number) FROM chapters c WHERE c.novel_id = n.id AND ${VISIBLE}) AS latest_number,
  COALESCE((SELECT MAX(${RELEASED}) FROM chapters c WHERE c.novel_id = n.id AND ${VISIBLE}), n.updated_at) AS last_release
`;

// Admin panel: every chapter, plus how many are waiting for release.
const ADMIN_NOVEL_COLUMNS = `${COMMON_COLUMNS},
  (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id) AS chapter_count,
  (SELECT MAX(c.number) FROM chapters c WHERE c.novel_id = n.id) AS latest_number,
  (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id AND NOT ${VISIBLE}) AS scheduled_count,
  (SELECT MIN(c.publish_at) FROM chapters c WHERE c.novel_id = n.id AND NOT ${VISIBLE}) AS next_release
`;

const q = {
  novelBySlug: db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n WHERE n.slug = ?`),
  novelById: db.prepare(`SELECT ${ADMIN_NOVEL_COLUMNS} FROM novels n WHERE n.id = ?`),
  genresForNovel: db.prepare('SELECT g.* FROM genres g JOIN novel_genres ng ON ng.genre_id = g.id WHERE ng.novel_id = ? ORDER BY g.name'),
  allGenres: db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM novel_genres ng WHERE ng.genre_id = g.id) AS novel_count FROM genres g ORDER BY g.name`),
  chapterByNumber: db.prepare('SELECT * FROM chapters WHERE novel_id = ? AND number = ?'),
  visibleChapterByNumber: db.prepare(`SELECT c.*, ${RELEASED} AS released_at FROM chapters c WHERE c.novel_id = ? AND c.number = ? AND ${VISIBLE}`),
  chapterById: db.prepare('SELECT * FROM chapters WHERE id = ?'),
  chapterNumbers: db.prepare('SELECT number FROM chapters WHERE novel_id = ?'),
  maxChapterNumber: db.prepare('SELECT MAX(number) AS m FROM chapters WHERE novel_id = ?'),
  touchNovel: db.prepare('UPDATE novels SET updated_at = unixepoch() WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertUser: db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'),
};

const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|discord|telegram|whatsapp|curl|wget|python|headless/i;

/** Count one chapter view (skipping obvious bots) in the totals and today's daily bucket. */
function recordView(novelId, chapterId, userAgent) {
  if (BOT_RE.test(userAgent || '')) return;
  db.prepare('UPDATE chapters SET views = views + 1 WHERE id = ?').run(chapterId);
  db.prepare('UPDATE novels SET views = views + 1 WHERE id = ?').run(novelId);
  db.prepare(`INSERT INTO novel_views_daily (novel_id, day, views) VALUES (?, date('now'), 1)
    ON CONFLICT(novel_id, day) DO UPDATE SET views = views + 1`).run(novelId);
}

/** Clean up a genre name: trimmed, single spaces, 2–40 characters. Throws a user-facing error if invalid. */
function cleanGenreName(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 2 || clean.length > 40) throw Object.assign(new Error('Genre names must be 2–40 characters.'), { status: 400 });
  return clean;
}

/** Create a genre, or return the existing one with the same name/URL. Returns { id, name, created }. */
function createGenre(name) {
  const clean = cleanGenreName(name);
  const slug = slugify(clean);
  const existing = db.prepare('SELECT id, name FROM genres WHERE slug = ? OR name = ? COLLATE NOCASE').get(slug, clean);
  if (existing) return { ...existing, created: false };
  const id = Number(db.prepare('INSERT INTO genres (slug, name) VALUES (?, ?)').run(slug, clean).lastInsertRowid);
  return { id, name: clean, created: true };
}

function setNovelGenres(novelId, genreIds) {
  db.prepare('DELETE FROM novel_genres WHERE novel_id = ?').run(novelId);
  const ins = db.prepare('INSERT OR IGNORE INTO novel_genres (novel_id, genre_id) VALUES (?, ?)');
  for (const gid of genreIds) ins.run(novelId, Number(gid));
}

/** Returns the logged-in user id or throws a user-facing error. */
function login(username, password) {
  const user = q.userByName.get(String(username || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    throw Object.assign(new Error('Wrong username or password.'), { status: 400 });
  }
  return user.id;
}

/** Creates an account. The very first account becomes the admin. */
function register(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  const first = q.userCount.get().n === 0;
  if (!first && getSettings().allow_registration !== '1') {
    throw Object.assign(new Error('Registration is currently closed.'), { status: 400 });
  }
  if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username)) {
    throw Object.assign(new Error('Username must be 3–24 characters: letters, numbers, _ . -'), { status: 400 });
  }
  if (password.length < 8) throw Object.assign(new Error('Password must be at least 8 characters.'), { status: 400 });
  if (q.userByName.get(username)) throw Object.assign(new Error('That username is taken.'), { status: 400 });
  const role = first ? 'admin' : (getSettings().default_role === 'translator' ? 'translator' : 'reader');
  const id = Number(q.insertUser.run(username, hashPassword(password), role).lastInsertRowid);
  if (first) db.prepare('UPDATE users SET is_owner = 1 WHERE id = ?').run(id);
  return id;
}

module.exports = { NOVEL_COLUMNS, ADMIN_NOVEL_COLUMNS, VISIBLE, RELEASED, q, setNovelGenres, cleanGenreName, createGenre, recordView, login, register };

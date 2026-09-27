// Reusable SQL shared by public and admin routes.
const { db } = require('./db');
const { hashPassword, verifyPassword } = require('./auth');
const { getSettings } = require('./settings');

const NOVEL_COLUMNS = `
  n.*,
  (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id) AS chapter_count,
  (SELECT MAX(c.number) FROM chapters c WHERE c.novel_id = n.id) AS latest_number,
  (SELECT ROUND(AVG(score), 1) FROM ratings r WHERE r.novel_id = n.id) AS rating,
  (SELECT COUNT(*) FROM ratings r WHERE r.novel_id = n.id) AS rating_count,
  (SELECT group_concat(g.name, ', ') FROM novel_genres ng JOIN genres g ON g.id = ng.genre_id WHERE ng.novel_id = n.id) AS genre_names,
  (SELECT u.username FROM users u WHERE u.id = n.owner_id) AS translator
`;

const q = {
  novelBySlug: db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n WHERE n.slug = ?`),
  novelById: db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n WHERE n.id = ?`),
  genresForNovel: db.prepare('SELECT g.* FROM genres g JOIN novel_genres ng ON ng.genre_id = g.id WHERE ng.novel_id = ? ORDER BY g.name'),
  allGenres: db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM novel_genres ng WHERE ng.genre_id = g.id) AS novel_count FROM genres g ORDER BY g.name`),
  chapterByNumber: db.prepare('SELECT * FROM chapters WHERE novel_id = ? AND number = ?'),
  chapterById: db.prepare('SELECT * FROM chapters WHERE id = ?'),
  chapterNumbers: db.prepare('SELECT number FROM chapters WHERE novel_id = ?'),
  maxChapterNumber: db.prepare('SELECT MAX(number) AS m FROM chapters WHERE novel_id = ?'),
  touchNovel: db.prepare('UPDATE novels SET updated_at = unixepoch() WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertUser: db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'),
};

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
  return Number(q.insertUser.run(username, hashPassword(password), role).lastInsertRowid);
}

module.exports = { NOVEL_COLUMNS, q, setNovelGenres, login, register };

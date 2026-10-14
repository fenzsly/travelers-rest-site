const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'site.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'reader' CHECK (role IN ('reader','translator','admin')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS novels (
  id                INTEGER PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  alt_titles        TEXT NOT NULL DEFAULT '',
  author            TEXT NOT NULL DEFAULT '',
  original_language TEXT NOT NULL DEFAULT '',
  year              INTEGER,
  status            TEXT NOT NULL DEFAULT 'ongoing' CHECK (status IN ('ongoing','completed','hiatus','dropped')),
  description       TEXT NOT NULL DEFAULT '',
  tags              TEXT NOT NULL DEFAULT '',
  cover             TEXT,
  owner_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  views             INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS genres (
  id   INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS novel_genres (
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (novel_id, genre_id)
);

CREATE TABLE IF NOT EXISTS chapters (
  id         INTEGER PRIMARY KEY,
  novel_id   INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  number     REAL NOT NULL,
  volume     INTEGER,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0,
  views      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (novel_id, number)
);
CREATE INDEX IF NOT EXISTS chapters_recent ON chapters (created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS comments_chapter ON comments (chapter_id, created_at);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  novel_id        INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  last_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, novel_id)
);

CREATE TABLE IF NOT EXISTS ratings (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  score    INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  PRIMARY KEY (user_id, novel_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ---- Migrations for databases created by older versions ----
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
if (!hasColumn('chapters', 'publish_at')) {
  // NULL = released when uploaded (created_at); a timestamp = scheduled release.
  db.exec('ALTER TABLE chapters ADD COLUMN publish_at INTEGER');
}
db.exec(`
CREATE INDEX IF NOT EXISTS chapters_release ON chapters (COALESCE(publish_at, created_at) DESC);

-- One row per novel per day, for the view counter / trending / stats pages.
CREATE TABLE IF NOT EXISTS novel_views_daily (
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  views    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (novel_id, day)
);
CREATE INDEX IF NOT EXISTS novel_views_daily_day ON novel_views_daily (day);
`);

// The site owner (the first account) is protected: other admins can't demote, delete or reset it.
if (!hasColumn('users', 'is_owner')) {
  db.exec('ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0');
}
if (!db.prepare('SELECT 1 FROM users WHERE is_owner = 1').get()) {
  db.exec("UPDATE users SET is_owner = 1 WHERE id = (SELECT MIN(id) FROM users WHERE role = 'admin')");
}

// Optional per-novel search title/description (fall back to the title and synopsis).
if (!hasColumn('novels', 'seo_title')) db.exec("ALTER TABLE novels ADD COLUMN seo_title TEXT NOT NULL DEFAULT ''");
if (!hasColumn('novels', 'seo_description')) db.exec("ALTER TABLE novels ADD COLUMN seo_description TEXT NOT NULL DEFAULT ''");

// Email on accounts (optional), verification and password-reset tokens.
if (!hasColumn('users', 'email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
if (!hasColumn('users', 'email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email COLLATE NOCASE) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
  email      TEXT,
  expires_at INTEGER NOT NULL
);
`);

// Library lists (ranobes-style reading statuses).
if (!hasColumn('bookmarks', 'status')) {
  db.exec("ALTER TABLE bookmarks ADD COLUMN status TEXT NOT NULL DEFAULT 'reading'");
}
db.exec(`
CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY,
  novel_id   INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (novel_id, user_id)
);
`);

db.exec(`
-- Reader reports about a chapter (typos, wrong names, missing text, …).
CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,
  quote      TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS reports_open ON reports (status, created_at);

-- One emoji reaction per reader per chapter.
CREATE TABLE IF NOT EXISTS reactions (
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chapter_id, user_id)
);
`);

// Reader settings (font, size, theme…) saved to the account so they follow the reader to any device.
if (!hasColumn('users', 'prefs')) db.exec("ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}'");

db.exec(`
-- Novels readers would like translated. Ranked by votes (this week / all time).
CREATE TABLE IF NOT EXISTS novel_requests (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  title_key  TEXT NOT NULL,
  author     TEXT NOT NULL DEFAULT '',
  language   TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','planned','added','declined')),
  reply      TEXT NOT NULL DEFAULT '',
  novel_id   INTEGER REFERENCES novels(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS novel_requests_key ON novel_requests (title_key);
-- One vote per reader per request per week (week = the Monday it starts, UTC). The leaderboard resets every Monday.
CREATE TABLE IF NOT EXISTS request_votes (
  request_id INTEGER NOT NULL REFERENCES novel_requests(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (request_id, user_id, week)
);
`);
if (!hasColumn('request_votes', 'week')) {
  // Votes used to be one per reader forever; move them into the week they were cast.
  db.exec(`
    DROP INDEX IF EXISTS request_votes_recent;
    ALTER TABLE request_votes RENAME TO request_votes_old;
    CREATE TABLE request_votes (
      request_id INTEGER NOT NULL REFERENCES novel_requests(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      week       TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (request_id, user_id, week)
    );
    INSERT INTO request_votes (request_id, user_id, week, created_at)
      SELECT request_id, user_id, date(created_at, 'unixepoch', 'weekday 0', '-6 days'), created_at FROM request_votes_old;
    DROP TABLE request_votes_old;
  `);
}
db.exec('CREATE INDEX IF NOT EXISTS request_votes_week ON request_votes (week, request_id)');

db.exec(`
-- "Request update": a logged-in reader asks for new chapters of a novel. One per reader until the next chapter comes out.
CREATE TABLE IF NOT EXISTS update_requests (
  id         INTEGER PRIMARY KEY,
  novel_id   INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS update_requests_novel ON update_requests (novel_id, created_at);
-- When staff were last emailed about a novel's update requests, and when they cleared the list in the panel.
CREATE TABLE IF NOT EXISTS update_request_state (
  novel_id    INTEGER PRIMARY KEY REFERENCES novels(id) ON DELETE CASCADE,
  notified_at INTEGER,
  cleared_at  INTEGER
);
`);

// Replies: a reply points at the top comment of its thread (one level deep, like YouTube).
if (!hasColumn('comments', 'parent_id')) db.exec('ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE');
db.exec(`
CREATE INDEX IF NOT EXISTS comments_parent ON comments (parent_id);
-- On-site notifications (the bell), e.g. "dimpu replied to your comment".
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  link       TEXT NOT NULL,
  text       TEXT NOT NULL,
  read_at    INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, read_at, created_at);
`);

const DEFAULT_GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Harem', 'Historical', 'Horror',
  'Isekai', 'Martial Arts', 'Mecha', 'Mystery', 'Psychological', 'Reincarnation', 'Romance',
  'School Life', 'Sci-fi', 'Slice of Life', 'Supernatural', 'System', 'Tragedy', 'Wuxia', 'Xianxia', 'Xuanhuan',
];
const insertGenre = db.prepare('INSERT OR IGNORE INTO genres (slug, name) VALUES (?, ?)');
for (const name of DEFAULT_GENRES) {
  insertGenre.run(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name);
}

/** Run fn inside a transaction; rolls back if it throws. */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, tx, DATA_DIR };

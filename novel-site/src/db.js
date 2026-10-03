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

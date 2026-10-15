// Titles: cosmetic badges ("Top Reader", "Beta Reader", "Founder"…) shown next to someone's name.
// They don't give any permissions. Anyone can have several; staff with the `titles` permission create and hand them out.
const { db, tx } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS titles (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  icon        TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#8b5cf6',
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 100,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS user_titles (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, title_id)
);
CREATE INDEX IF NOT EXISTS user_titles_title ON user_titles (title_id);
`);

if (!db.prepare("SELECT 1 FROM pragma_table_info('titles') WHERE name = 'auto'").get()) {
  db.exec('ALTER TABLE titles ADD COLUMN auto TEXT'); // set for titles the site hands out by itself
}
// Which registered readers read which chapters on which (India time) day, for the Top Reader title.
db.exec(`CREATE TABLE IF NOT EXISTS user_reads_daily (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  chapter_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, chapter_id)
) WITHOUT ROWID`);

const COLOR = /^#[0-9a-fA-F]{6}$/;

// ---------- Automatic titles ----------
const IST_OFFSET = 5.5 * 3600 * 1000;
/** Today's date in India Standard Time (UTC+5:30), e.g. '2026-10-15'. Top Reader resets at midnight IST. */
const istDay = (t = Date.now()) => new Date(t + IST_OFFSET).toISOString().slice(0, 10);
// Accounts created before 1 December 2026, 00:00 IST.
const ANCIENT_BEFORE = Math.floor((Date.UTC(2026, 11, 1) - IST_OFFSET) / 1000);
const TOP_SHARE = 0.1;

const AUTO = {
  top_reader: { name: 'Top Reader', icon: '🏆', color: '#e0a526', position: 10,
    description: 'Among the top 10% of readers today', rule: 'Given automatically to the top 10% of registered readers by chapters read today (India time). Resets every night at 12:00 AM IST.' },
  ancient: { name: 'Ancient Reader', icon: '📜', color: '#a0784a', position: 20,
    description: 'Joined before December 2026', rule: 'Given automatically to every account created before 1 December 2026 (IST). It stays with them for good.' },
};
for (const [key, t] of Object.entries(AUTO)) {
  if (db.prepare('SELECT 1 FROM titles WHERE auto = ?').get(key)) continue;
  const same = db.prepare('SELECT id FROM titles WHERE name = ?').get(t.name);
  if (same) db.prepare('UPDATE titles SET auto = ? WHERE id = ?').run(key, same.id);
  else db.prepare('INSERT INTO titles (name, icon, color, description, position, auto) VALUES (?, ?, ?, ?, ?, ?)').run(t.name, t.icon, t.color, t.description, t.position, key);
}
const autoId = (key) => db.prepare('SELECT id FROM titles WHERE auto = ?').get(key)?.id;

/** Remember that a signed-in reader read a chapter (counted from real browsers only). */
function recordRead(userId, chapterId) {
  if (userId && chapterId) db.prepare('INSERT OR IGNORE INTO user_reads_daily (user_id, day, chapter_id) VALUES (?, ?, ?)').run(userId, istDay(), chapterId);
}

/** Today's top readers: the top 10% (at least one person) by chapters read, plus anyone tied with the last place. */
function topReaders(day = istDay()) {
  const rows = db.prepare('SELECT user_id, COUNT(*) AS n FROM user_reads_daily WHERE day = ? GROUP BY user_id ORDER BY n DESC').all(day);
  if (!rows.length) return [];
  const cutoff = rows[Math.max(1, Math.ceil(rows.length * TOP_SHARE)) - 1].n;
  return rows.filter((r) => r.n >= cutoff).map((r) => r.user_id);
}

/** Bring the automatic titles up to date. */
function syncAutoTitles() {
  tx(() => {
    const top = autoId('top_reader');
    if (top) {
      db.prepare('DELETE FROM user_titles WHERE title_id = ?').run(top);
      const ins = db.prepare('INSERT OR IGNORE INTO user_titles (user_id, title_id) VALUES (?, ?)');
      for (const uid of topReaders()) ins.run(uid, top);
    }
    const ancient = autoId('ancient');
    if (ancient) {
      db.prepare('DELETE FROM user_titles WHERE title_id = ? AND user_id IN (SELECT id FROM users WHERE created_at >= ?)').run(ancient, ANCIENT_BEFORE);
      db.prepare('INSERT OR IGNORE INTO user_titles (user_id, title_id) SELECT id, ? FROM users WHERE created_at < ?').run(ancient, ANCIENT_BEFORE);
    }
    db.prepare('DELETE FROM user_reads_daily WHERE day < ?').run(istDay(Date.now() - 3 * 86400000));
  });
}

let timer = null;
let lastSync = 0;
/** Keep automatic titles fresh: now, every 2 minutes, and soon after reads. */
function start() {
  if (timer) return;
  syncAutoTitles();
  lastSync = Date.now();
  timer = setInterval(() => { syncAutoTitles(); lastSync = Date.now(); }, 2 * 60000);
  timer.unref();
}
/** Called after a read or a sign-up: update the titles if it's been a little while. */
function nudge() {
  if (Date.now() - lastSync < 20000) return;
  lastSync = Date.now();
  try { syncAutoTitles(); } catch (err) { console.error('Title update failed:', err.message); }
}

/** Clean up a title/role form: name, icon (an emoji or a few characters), colour, description. */
function readBadgeForm(body) {
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) throw Object.assign(new Error('Give it a name.'), { status: 400 });
  return {
    name,
    icon: [...String(body.icon || '').trim()].slice(0, 4).join(''),
    color: COLOR.test(String(body.color || '')) ? String(body.color).toLowerCase() : '#8b5cf6',
    description: String(body.description || '').trim().slice(0, 300),
    position: Math.max(0, Math.min(9999, Math.floor(Number(body.position)) || 100)),
  };
}

function listTitles() {
  return db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM user_titles ut WHERE ut.title_id = t.id) AS members
    FROM titles t ORDER BY t.auto IS NULL, t.position, t.name`).all().map((t) => ({ ...t, rule: t.auto ? AUTO[t.auto]?.rule : null }));
}

function getTitle(id) {
  return db.prepare('SELECT * FROM titles WHERE id = ?').get(Number(id)) || null;
}

function saveTitle(id, body) {
  const f = readBadgeForm(body);
  const clash = db.prepare('SELECT id FROM titles WHERE name = ? AND id != ?').get(f.name, Number(id) || 0);
  if (clash) throw Object.assign(new Error('There is already a title with that name.'), { status: 400 });
  if (id) {
    db.prepare('UPDATE titles SET name = ?, icon = ?, color = ?, description = ?, position = ? WHERE id = ?')
      .run(f.name, f.icon, f.color, f.description, f.position, Number(id));
    return Number(id);
  }
  return Number(db.prepare('INSERT INTO titles (name, icon, color, description, position) VALUES (?, ?, ?, ?, ?)')
    .run(f.name, f.icon, f.color, f.description, f.position).lastInsertRowid);
}

function deleteTitle(id) {
  db.prepare('DELETE FROM titles WHERE id = ? AND auto IS NULL').run(Number(id));
}

function titleIdsOf(userId) {
  return db.prepare('SELECT title_id FROM user_titles WHERE user_id = ?').all(userId).map((r) => r.title_id);
}

function setUserTitles(userId, titleIds) {
  tx(() => {
    db.prepare('DELETE FROM user_titles WHERE user_id = ? AND title_id IN (SELECT id FROM titles WHERE auto IS NULL)').run(userId);
    const ins = db.prepare('INSERT OR IGNORE INTO user_titles (user_id, title_id) SELECT ?, id FROM titles WHERE id = ? AND auto IS NULL');
    for (const id of titleIds) ins.run(userId, Number(id));
  });
}

/** Members of a title (for its page in the admin panel). */
function membersOf(titleId) {
  return db.prepare(`SELECT u.id, u.username FROM user_titles ut JOIN users u ON u.id = ut.user_id WHERE ut.title_id = ? ORDER BY u.username COLLATE NOCASE`).all(Number(titleId));
}

module.exports = { COLOR, readBadgeForm, listTitles, getTitle, saveTitle, deleteTitle, titleIdsOf, setUserTitles, membersOf };

/** Titles to show next to these users' names: { userId: [{ name, icon, color, description }] } */
function titlesFor(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return {};
  const rows = db.prepare(`SELECT ut.user_id, t.name, t.icon, t.color, t.description FROM user_titles ut JOIN titles t ON t.id = ut.title_id
    WHERE ut.user_id IN (${ids.map(() => '?').join(',')}) ORDER BY t.position, t.name`).all(...ids);
  const out = {};
  for (const r of rows) (out[r.user_id] ||= []).push(r);
  return out;
}

Object.assign(module.exports, { titlesFor, recordRead, topReaders, syncAutoTitles, start, nudge, istDay, ANCIENT_BEFORE });

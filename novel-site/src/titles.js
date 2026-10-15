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

const COLOR = /^#[0-9a-fA-F]{6}$/;

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
    FROM titles t ORDER BY t.position, t.name`).all();
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
  db.prepare('DELETE FROM titles WHERE id = ?').run(Number(id));
}

function titleIdsOf(userId) {
  return db.prepare('SELECT title_id FROM user_titles WHERE user_id = ?').all(userId).map((r) => r.title_id);
}

function setUserTitles(userId, titleIds) {
  tx(() => {
    db.prepare('DELETE FROM user_titles WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT OR IGNORE INTO user_titles (user_id, title_id) SELECT ?, id FROM titles WHERE id = ?');
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

module.exports.titlesFor = titlesFor;

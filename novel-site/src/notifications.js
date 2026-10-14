// On-site notifications shown under the bell (replies to your comments, …).
const { db } = require('./db');

function notify(userId, { actorId = null, kind, commentId = null, link, text }) {
  if (!userId || userId === actorId) return; // never notify yourself
  db.prepare('INSERT INTO notifications (user_id, actor_id, kind, comment_id, link, text) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, actorId, kind, commentId, link, String(text).slice(0, 300));
}

function unread(userId, limit = 10) {
  return db.prepare(`SELECT nt.*, u.username AS actor FROM notifications nt LEFT JOIN users u ON u.id = nt.actor_id
    WHERE nt.user_id = ? AND nt.read_at IS NULL ORDER BY nt.created_at DESC LIMIT ?`).all(userId, limit);
}

function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;
}

function recent(userId, limit = 50) {
  return db.prepare(`SELECT nt.*, u.username AS actor FROM notifications nt LEFT JOIN users u ON u.id = nt.actor_id
    WHERE nt.user_id = ? ORDER BY nt.created_at DESC LIMIT ?`).all(userId, limit);
}

/** Mark one as read and return its link (only the owner's own notifications). */
function open(userId, id) {
  const n = db.prepare('SELECT id, link FROM notifications WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!n) return null;
  db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, unixepoch()) WHERE id = ?').run(n.id);
  return n.link;
}

function markAllRead(userId) {
  db.prepare('UPDATE notifications SET read_at = unixepoch() WHERE user_id = ? AND read_at IS NULL').run(userId);
}

module.exports = { notify, unread, unreadCount, recent, open, markAllRead };

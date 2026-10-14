// "Request update": logged-in readers ask for new chapters of a novel. Staff get an email
// (at most once a day per novel) and a leaderboard in the admin panel.
const { db } = require('./db');
const { VISIBLE, RELEASED } = require('./queries');
const { getSettings } = require('./settings');

const NOTIFY_EVERY = 24 * 3600; // seconds between emails about the same novel

/** Requests count as "waiting" until a new chapter is released or staff clear them. */
const SINCE = `MAX(
  COALESCE((SELECT MAX(${RELEASED}) FROM chapters c WHERE c.novel_id = n.id AND ${VISIBLE}), 0),
  COALESCE((SELECT s.cleared_at FROM update_request_state s WHERE s.novel_id = n.id), 0))`;

function waitingSince(novelId) {
  return db.prepare(`SELECT ${SINCE} AS t FROM novels n WHERE n.id = ?`).get(novelId)?.t ?? 0;
}

/** Number of readers waiting for an update, and whether this reader is one of them. */
function status(novelId, userId) {
  const since = waitingSince(novelId);
  const waiting = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM update_requests WHERE novel_id = ? AND created_at > ?').get(novelId, since).n;
  const mine = userId ? !!db.prepare('SELECT 1 FROM update_requests WHERE novel_id = ? AND user_id = ? AND created_at > ?').get(novelId, userId, since) : false;
  return { waiting, mine };
}

/** Record a request. Returns { added, waiting }. Throws a user-facing error for completed novels. */
function requestUpdate(novel, userId) {
  if (novel.status === 'completed') throw Object.assign(new Error('This novel is completed: every chapter is already out.'), { status: 400 });
  const before = status(novel.id, userId);
  if (before.mine) return { added: false, waiting: before.waiting };
  db.prepare('INSERT INTO update_requests (novel_id, user_id) VALUES (?, ?)').run(novel.id, userId);
  return { added: true, waiting: before.waiting + 1 };
}

/**
 * Leaderboard for the admin panel: novels with update requests, most readers waiting first.
 * `ownerId` limits it to one translator's novels.
 */
function leaderboard({ ownerId = null, limit = 100 } = {}) {
  return db.prepare(`SELECT * FROM (
      SELECT n.id, n.slug, n.title, n.status, n.owner_id,
        (SELECT u.username FROM users u WHERE u.id = n.owner_id) AS translator,
        (SELECT MAX(${RELEASED}) FROM chapters c WHERE c.novel_id = n.id AND ${VISIBLE}) AS last_release,
        (SELECT MAX(c.number) FROM chapters c WHERE c.novel_id = n.id AND ${VISIBLE}) AS latest_number,
        (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id AND NOT ${VISIBLE}) AS scheduled,
        (SELECT COUNT(DISTINCT ur.user_id) FROM update_requests ur WHERE ur.novel_id = n.id AND ur.created_at > ${SINCE}) AS waiting,
        (SELECT MAX(ur.created_at) FROM update_requests ur WHERE ur.novel_id = n.id) AS last_request,
        (SELECT COUNT(*) FROM update_requests ur WHERE ur.novel_id = n.id AND ur.created_at >= unixepoch() - 7 * 86400) AS week,
        (SELECT COUNT(*) FROM update_requests ur WHERE ur.novel_id = n.id) AS total
      FROM novels n ${ownerId ? 'WHERE n.owner_id = ?' : ''}
    ) WHERE total > 0 ORDER BY waiting DESC, week DESC, total DESC LIMIT ?`).all(...(ownerId ? [ownerId] : []), limit);
}

/** Number of novels with readers waiting (sidebar badge). */
function waitingNovels(ownerId = null) {
  return db.prepare(`SELECT COUNT(*) AS n FROM novels n WHERE ${ownerId ? 'n.owner_id = ? AND' : ''}
    EXISTS (SELECT 1 FROM update_requests ur WHERE ur.novel_id = n.id AND ur.created_at > ${SINCE})`).get(...(ownerId ? [ownerId] : [])).n;
}

/** Staff saw the requests: hide them from "waiting" (they still count in the totals). */
function clear(novelId) {
  db.prepare(`INSERT INTO update_request_state (novel_id, cleared_at) VALUES (?, unixepoch())
    ON CONFLICT(novel_id) DO UPDATE SET cleared_at = excluded.cleared_at`).run(novelId);
}

/** Email every admin (and the novel's translator) who has an email address. At most once a day per novel. */
async function notifyStaff(novel, waiting, adminLink) {
  const mail = require('./mail');
  if (!mail.isConfigured()) return;
  const state = db.prepare('SELECT notified_at FROM update_request_state WHERE novel_id = ?').get(novel.id);
  if (state?.notified_at && state.notified_at > Math.floor(Date.now() / 1000) - NOTIFY_EVERY) return;
  db.prepare(`INSERT INTO update_request_state (novel_id, notified_at) VALUES (?, unixepoch())
    ON CONFLICT(novel_id) DO UPDATE SET notified_at = excluded.notified_at`).run(novel.id);
  const staff = db.prepare(`SELECT DISTINCT email FROM users WHERE email IS NOT NULL AND (role = 'admin' OR id = ?)`).all(novel.owner_id || 0);
  const site = getSettings().site_name;
  for (const { email } of staff) {
    try {
      await mail.send({
        to: email,
        subject: `📣 Readers want more “${novel.title}” (${waiting} waiting)`,
        text: `${waiting} reader${waiting === 1 ? ' is' : 's are'} waiting for new chapters of “${novel.title}” on ${site}.\n\nSee which novels readers are asking for most:\n${adminLink}\n\nYou’ll get at most one email a day per novel.`,
      });
    } catch (err) {
      console.error('Update-request email failed:', err.message);
    }
  }
}

module.exports = { status, requestUpdate, leaderboard, waitingNovels, clear, notifyStaff };

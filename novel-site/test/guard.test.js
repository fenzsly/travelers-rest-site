const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
const { db } = require('../src/db');
const { saveSettings } = require('../src/settings');
const guard = require('../src/guard');
const updates = require('../src/update-requests');

const fakeReq = (ip, { ua = 'Mozilla/5.0', user = null, session = {} } = {}) => ({ ip, user, session, get: (h) => (h === 'user-agent' ? ua : undefined) });

test('guests are asked to sign up after the free chapters; re-reading does not count', async () => {
  guard.reset();
  saveSettings({ guest_chapter_limit: '3' });
  const req = fakeReq('10.0.0.1');
  for (const id of [1, 2, 3]) {
    assert.strictEqual(await guard.checkChapter(req, id), null);
    req.session.seen = [...(req.session.seen || []), id];
  }
  assert.strictEqual(await guard.checkChapter(req, 2), null); // already read
  assert.deepStrictEqual(await guard.checkChapter(req, 4), { gate: 'signup', limit: 3 });
  // Logged-in readers are not limited.
  assert.strictEqual(await guard.checkChapter(fakeReq('10.0.0.1', { user: { id: 1 } }), 99), null);
  // 0 = no limit.
  saveSettings({ guest_chapter_limit: '0' });
  assert.strictEqual(await guard.checkChapter(req, 5), null);
});


test('more than 40 chapters a minute is slowed down, even when logged in', async () => {
  guard.reset();
  const user = { id: 7 };
  for (let i = 1; i <= guard.PER_MINUTE; i++) assert.strictEqual(await guard.checkChapter(fakeReq('10.0.0.3', { user }), i), null);
  assert.deepStrictEqual(await guard.checkChapter(fakeReq('10.0.0.3', { user }), 999), { gate: 'slow' });
});

test('a fake Googlebot user agent is not trusted', async () => {
  guard.reset();
  assert.strictEqual(await guard.isVerifiedCrawler(fakeReq('127.0.0.1', { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' })), false);
});

test('update requests: one per reader until the next chapter, leaderboard order, mark as seen', () => {
  const users = ['u1', 'u2', 'u3'].map((n) => Number(db.prepare("INSERT INTO users (username, password_hash) VALUES (?, 'x')").run(n).lastInsertRowid));
  const novel = (slug, status = 'ongoing') => db.prepare('SELECT * FROM novels WHERE id = ?').get(Number(db.prepare('INSERT INTO novels (slug, title, status) VALUES (?, ?, ?)').run(slug, slug, status).lastInsertRowid));
  const a = novel('a');
  const b = novel('b');
  db.prepare("INSERT INTO chapters (novel_id, number, content, created_at) VALUES (?, 1, 'x', unixepoch() - 100)").run(a.id);

  assert.deepStrictEqual(updates.requestUpdate(a, users[0]), { added: true, waiting: 1 });
  assert.deepStrictEqual(updates.requestUpdate(a, users[0]), { added: false, waiting: 1 });
  updates.requestUpdate(a, users[1]);
  updates.requestUpdate(b, users[2]);
  assert.deepStrictEqual(updates.status(a.id, users[0]), { waiting: 2, mine: true });
  assert.deepStrictEqual(updates.leaderboard().map((n) => [n.title, n.waiting, n.total]), [['a', 2, 2], ['b', 1, 1]]);
  assert.strictEqual(updates.waitingNovels(), 2);

  // A new chapter: the waiting count resets and readers can ask again.
  db.prepare("INSERT INTO chapters (novel_id, number, content, created_at) VALUES (?, 2, 'x', unixepoch() + 1)").run(a.id);
  db.prepare('UPDATE update_requests SET created_at = created_at - 5 WHERE novel_id = ?').run(a.id);
  assert.deepStrictEqual(updates.status(a.id, users[0]), { waiting: 0, mine: false });

  updates.clear(b.id);
  db.prepare('UPDATE update_requests SET created_at = created_at - 5 WHERE novel_id = ?').run(b.id);
  assert.strictEqual(updates.waitingNovels(), 0);
  assert.throws(() => updates.requestUpdate(novel('done', 'completed'), users[0]), /completed/);
});

test('scrapers that drop cookies hit the per-IP limit', async () => {
  guard.reset();
  saveSettings({ guest_chapter_limit: '20' }); // per IP: max(20 × 3, 60) = 60 chapters a day
  const clock = Date.now;
  let t = clock();
  Date.now = () => (t += 2000); // 2 s apart: stays under the per-minute limit
  try {
    for (let i = 1; i <= 60; i++) assert.strictEqual(await guard.checkChapter(fakeReq('10.0.0.2'), i), null, `chapter ${i}`);
    assert.deepStrictEqual(await guard.checkChapter(fakeReq('10.0.0.2'), 61), { gate: 'signup', limit: 20 });
    assert.strictEqual(await guard.checkChapter(fakeReq('10.0.0.9'), 61), null); // another address is fine
  } finally {
    Date.now = clock;
  }
});

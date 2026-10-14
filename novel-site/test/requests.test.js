const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'requests-test-'));
const { db } = require('../src/db');
const requests = require('../src/requests');
const { cleanPrefs, savePrefs, parsePrefs } = require('../src/prefs');

const user = (name) => Number(db.prepare("INSERT INTO users (username, password_hash) VALUES (?, 'x')").run(name).lastInsertRowid);

test('requests: create, merge duplicates, vote, rank by this week', () => {
  const a = user('alice');
  const b = user('bob');
  const c = user('carol');
  const r1 = requests.createRequest(a, { title: 'The Lord’s Path!', language: 'Korean', link: 'novelupdates.com/series/x' });
  assert.strictEqual(r1.duplicate, false);
  assert.strictEqual(r1.request.votes, 1);
  assert.strictEqual(r1.request.link, 'https://novelupdates.com/series/x');
  // Same novel, different punctuation/case: becomes a vote.
  const dup = requests.createRequest(b, { title: 'the lords path' });
  assert.deepStrictEqual([dup.duplicate, dup.request.id, dup.request.votes], [true, r1.request.id, 2]);

  const r2 = requests.createRequest(c, { title: 'Another Novel' });
  // Votes from earlier weeks don't count for "this week", but do for all time.
  const lastWeek = requests.weekOf(Date.now() - 7 * 86400000).key;
  db.prepare('UPDATE request_votes SET week = ? WHERE request_id = ?').run(lastWeek, r1.request.id);
  requests.toggleVote(r2.request.id, a);
  const week = requests.listRequests({ sort: 'week' });
  assert.deepStrictEqual(week.map((r) => [r.title, r.week_votes, r.votes]), [['Another Novel', 2, 2], ['The Lord’s Path!', 0, 2]]);
  assert.strictEqual(requests.listRequests({ sort: 'all' })[0].votes, 2);
  assert.deepStrictEqual(requests.topThisWeek().map((r) => r.title), ['Another Novel']);

  assert.deepStrictEqual(requests.pastWeeks().map((w) => [w.week, w.top.map((t) => [t.title, t.votes])]), [[lastWeek, [['The Lord’s Path!', 2]]]]);
  // A new week: the same readers can vote again.
  requests.toggleVote(r1.request.id, a);
  assert.deepStrictEqual([requests.getRequest(r1.request.id).week_votes, requests.getRequest(r1.request.id).votes], [1, 3]);

  // Toggling removes the vote.
  assert.strictEqual(requests.toggleVote(r2.request.id, a).voted, false);
  assert.strictEqual(requests.getRequest(r2.request.id).votes, 1);

  assert.throws(() => requests.createRequest(a, { title: 'x' }), /title/);
  assert.throws(() => requests.createRequest(a, { title: 'Good title', link: 'javascript:alert(1)' }), /link/);
});

test('weeks start on Monday 00:00 UTC', () => {
  assert.strictEqual(requests.weekOf(Date.parse('2026-10-14T12:00:00Z')).key, '2026-10-12'); // Wednesday
  assert.strictEqual(requests.weekOf(Date.parse('2026-10-18T23:59:59Z')).key, '2026-10-12'); // Sunday
  assert.strictEqual(requests.weekOf(Date.parse('2026-10-19T00:00:00Z')).key, '2026-10-19'); // Monday
  assert.strictEqual(requests.weekOf(Date.parse('2026-10-14T12:00:00Z')).end, Date.parse('2026-10-19T00:00:00Z'));
});

test('requests: a novel already on the site is pointed to instead', () => {
  const d = user('dave');
  db.prepare("INSERT INTO novels (slug, title, alt_titles) VALUES ('sun-dragon', 'The Sun Dragon', 'Taeyang Yong')").run();
  assert.strictEqual(requests.createRequest(d, { title: 'taeyang yong' }).novel.slug, 'sun-dragon');
});

test('requests: daily limit per reader', () => {
  const e = user('erin');
  for (let i = 0; i < requests.DAILY_LIMIT; i++) requests.createRequest(e, { title: `Limit novel ${i}` });
  assert.throws(() => requests.createRequest(e, { title: 'One too many' }), /a day/);
});

test('reader settings: only allowed values are kept, merged per account', () => {
  assert.deepStrictEqual(cleanPrefs({ font: 'comic', size: 99, line: '1.6', theme: 'light', rtheme: 'sepia', evil: '<x>' }),
    { theme: 'light', rtheme: 'sepia', size: 32, line: 1.6 });
  const f = user('frank');
  savePrefs(f, { size: 21, font: 'sans' });
  savePrefs(f, { theme: 'dark' });
  assert.deepStrictEqual(parsePrefs(db.prepare('SELECT prefs FROM users WHERE id = ?').get(f).prefs), { theme: 'dark', font: 'sans', size: 21 });
  assert.deepStrictEqual(savePrefs(f, {}, { replace: true }), {});
});

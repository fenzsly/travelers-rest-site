const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'titles-test-'));
const { db } = require('../src/db');
const titles = require('../src/titles');

const user = (name, role = 'reader') => Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(name, 'x', role).lastInsertRowid);

test('users can be supporters', () => {
  const id = user('patron', 'supporter');
  assert.strictEqual(db.prepare('SELECT role FROM users WHERE id = ?').get(id).role, 'supporter');
  assert.throws(() => user('weird', 'emperor'));
});

test('titles: create, clean input, give several, delete', () => {
  const a = user('amy');
  const top = titles.saveTitle(null, { name: '  Super   Fan ', icon: '🏆🏆🏆🏆🏆', color: 'red; x', description: 'Best' });
  const t = titles.getTitle(top);
  assert.strictEqual(t.name, 'Super Fan');
  assert.strictEqual([...t.icon].length, 4);
  assert.strictEqual(t.color, '#8b5cf6'); // invalid colour falls back
  assert.throws(() => titles.saveTitle(null, { name: 'super fan' }), /already/);
  assert.throws(() => titles.saveTitle(null, { name: '  ' }), /name/);
  const beta = titles.saveTitle(null, { name: 'Beta', icon: '🧪', color: '#2F9E6E', position: 1 });
  titles.setUserTitles(a, [top, beta, 9999]);
  assert.deepStrictEqual(titles.titlesFor([a])[a].map((x) => x.name), ['Beta', 'Super Fan']);
  assert.strictEqual(titles.getTitle(beta).color, '#2f9e6e');
  titles.deleteTitle(beta);
  assert.deepStrictEqual(titles.titlesFor([a])[a].map((x) => x.name), ['Super Fan']);
  db.prepare('DELETE FROM users WHERE id = ?').run(a);
  assert.deepStrictEqual(titles.titlesFor([a]), {});
});

test('automatic titles: Top Reader (top 10% today, IST) and Ancient Reader', () => {
  const ids = Array.from({ length: 20 }, (_, i) => user(`r${i}`));
  // r0 reads 30 chapters, r1 25, r2 25 (tied), everyone else 1–5
  ids.forEach((id, i) => { const n = i === 0 ? 30 : i < 3 ? 25 : 1 + (i % 5); for (let c = 1; c <= n; c++) titles.recordRead(id, c); });
  titles.recordRead(ids[0], 1); // re-reading the same chapter doesn't count twice
  assert.deepStrictEqual(titles.topReaders().sort(), [ids[0], ids[1], ids[2]].sort()); // top 2 of 20, plus the tie
  titles.syncAutoTitles();
  const names = (id) => (titles.titlesFor([id])[id] || []).map((t) => t.name);
  assert.ok(names(ids[1]).includes('Top Reader'));
  assert.ok(!names(ids[5]).includes('Top Reader'));
  // Ancient Reader: everyone created before 1 Dec 2026 IST, not after
  assert.ok(names(ids[5]).includes('Ancient Reader'));
  const late = user('newbie');
  db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(titles.ANCIENT_BEFORE, late);
  titles.syncAutoTitles();
  assert.ok(!names(late).includes('Ancient Reader'));
  // A new IST day: yesterday's reads no longer count, the title is gone
  db.prepare('UPDATE user_reads_daily SET day = ?').run('2000-01-01');
  titles.syncAutoTitles();
  assert.ok(!names(ids[1]).includes('Top Reader'));
  // automatic titles can't be handed out or deleted by hand
  const top = titles.listTitles().find((t) => t.auto === 'top_reader');
  titles.setUserTitles(late, [top.id]);
  assert.ok(!names(late).includes('Top Reader'));
  titles.deleteTitle(top.id);
  assert.ok(titles.getTitle(top.id));
});

test('IST day boundary', () => {
  assert.strictEqual(titles.istDay(Date.UTC(2026, 9, 15, 18, 29)), '2026-10-15'); // 11:59 PM IST
  assert.strictEqual(titles.istDay(Date.UTC(2026, 9, 15, 18, 30)), '2026-10-16'); // midnight IST
  assert.strictEqual(titles.ANCIENT_BEFORE, Date.UTC(2026, 10, 30, 18, 30) / 1000);
});

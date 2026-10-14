const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'visitors-test-'));
const { db } = require('../src/db');
const visitors = require('../src/visitors');

const req = (ip, ua = 'Mozilla/5.0 (iPhone)', user = null) => ({ ip, user, get: (h) => (h === 'user-agent' ? ua : undefined) });

test('each person counts once per day; bots are ignored; guests are anonymous', () => {
  visitors.recordVisit(req('1.1.1.1'));
  visitors.recordVisit(req('1.1.1.1')); // same person again
  visitors.recordVisit(req('1.1.1.1', 'Mozilla/5.0 (Windows)')); // another device on the same network
  visitors.recordVisit(req('2.2.2.2', 'Googlebot/2.1'));
  visitors.recordVisit(req('3.3.3.3', 'x', { id: 7 }));
  visitors.recordVisit(req('4.4.4.4', 'y', { id: 7 })); // same account elsewhere
  assert.strictEqual(visitors.siteVisitorsByDay(30).at(-1).views, 3);
  const ids = db.prepare('SELECT visitor FROM site_visitors_daily').all().map((r) => r.visitor);
  assert.ok(ids.includes('u7'));
  assert.ok(ids.every((v) => !v.includes('1.1.1.1')));
});

test('unique readers per novel, counted once across several novels', () => {
  const a = Number(db.prepare("INSERT INTO novels (slug, title) VALUES ('a', 'A')").run().lastInsertRowid);
  const b = Number(db.prepare("INSERT INTO novels (slug, title) VALUES ('b', 'B')").run().lastInsertRowid);
  visitors.recordReader(req('5.5.5.5'), a);
  visitors.recordReader(req('5.5.5.5'), b);
  visitors.recordReader(req('6.6.6.6'), a);
  assert.strictEqual(visitors.readersByDay(7, [a]).at(-1).views, 2);
  assert.strictEqual(visitors.readersByDay(7, [a, b]).at(-1).views, 2);
  assert.strictEqual(visitors.readersByDay(7, [a]).length, 7);
});

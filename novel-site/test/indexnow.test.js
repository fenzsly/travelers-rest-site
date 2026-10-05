const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'indexnow-test-'));
const { db } = require('../src/db');
const indexnow = require('../src/indexnow');

test('collects only newly released pages, never scheduled ones', () => {
  const novel = Number(db.prepare("INSERT INTO novels (slug, title) VALUES ('tale', 'Tale')").run().lastInsertRowid);
  const now = Math.floor(Date.now() / 1000);
  const add = db.prepare('INSERT INTO chapters (novel_id, number, title, content, created_at, publish_at) VALUES (?, ?, ?, ?, ?, ?)');
  add.run(novel, 1, 'Old', '<p>x</p>', now - 3600, null);
  add.run(novel, 2, 'New', '<p>x</p>', now - 60, null);
  add.run(novel, 3, 'Later', '<p>x</p>', now - 60, now + 3600);
  const urls = indexnow.changedUrls('https://example.test', now - 600);
  assert.deepStrictEqual(urls.sort(), ['https://example.test/', 'https://example.test/novel/tale', 'https://example.test/novel/tale/c/2'].sort());
  // First run: the main pages and every novel.
  assert.ok(indexnow.changedUrls('https://example.test', 0).includes('https://example.test/about'));
  assert.match(indexnow.key(), /^[0-9a-f]{32}$/);
});

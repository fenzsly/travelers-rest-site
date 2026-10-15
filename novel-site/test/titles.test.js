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
  const top = titles.saveTitle(null, { name: '  Top   Reader ', icon: '🏆🏆🏆🏆🏆', color: 'red; x', description: 'Best' });
  const t = titles.getTitle(top);
  assert.strictEqual(t.name, 'Top Reader');
  assert.strictEqual([...t.icon].length, 4);
  assert.strictEqual(t.color, '#8b5cf6'); // invalid colour falls back
  assert.throws(() => titles.saveTitle(null, { name: 'top reader' }), /already/);
  assert.throws(() => titles.saveTitle(null, { name: '  ' }), /name/);
  const beta = titles.saveTitle(null, { name: 'Beta', icon: '🧪', color: '#2F9E6E', position: 1 });
  titles.setUserTitles(a, [top, beta, 9999]);
  assert.deepStrictEqual(titles.titlesFor([a])[a].map((x) => x.name), ['Beta', 'Top Reader']);
  assert.strictEqual(titles.getTitle(beta).color, '#2f9e6e');
  titles.deleteTitle(beta);
  assert.deepStrictEqual(titles.titlesFor([a])[a].map((x) => x.name), ['Top Reader']);
  db.prepare('DELETE FROM users WHERE id = ?').run(a);
  assert.deepStrictEqual(titles.titlesFor([a]), {});
});

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'genres-test-'));
const { db } = require('../src/db');
const { createGenre } = require('../src/queries');

test('createGenre adds a genre once, cleans the name, and rejects bad names', () => {
  const a = createGenre('  Cultivation   Fantasy ');
  assert.deepStrictEqual([a.name, a.created], ['Cultivation Fantasy', true]);
  assert.strictEqual(db.prepare('SELECT slug FROM genres WHERE id = ?').get(a.id).slug, 'cultivation-fantasy');
  const again = createGenre('cultivation fantasy');
  assert.deepStrictEqual([again.id, again.created], [a.id, false]);
  assert.strictEqual(createGenre('Fantasy').created, false); // built-in genre
  assert.throws(() => createGenre('x'), /2–40 characters/);
  assert.throws(() => createGenre('y'.repeat(41)), /2–40 characters/);
});

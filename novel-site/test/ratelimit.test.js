const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ratelimit-test-'));
const rl = require('../src/ratelimit');

function hit(ip, { method = 'GET', url = '/' } = {}) {
  let status = 200;
  let passed = false;
  const res = { set() { return res; }, status(s) { status = s; return res; }, type() { return res; }, send() { return res; } };
  rl.middleware({ ip, method, path: url, originalUrl: url, headers: {} }, res, () => { passed = true; });
  return passed ? 200 : status;
}

test('pages over the per-minute budget get 429; other addresses are unaffected', () => {
  rl.reset();
  for (let i = 0; i < rl.LIMITS.page; i++) assert.strictEqual(hit('1.1.1.1'), 200);
  assert.strictEqual(hit('1.1.1.1'), 429);
  assert.strictEqual(hit('2.2.2.2'), 200);
  // Static files have their own, bigger budget.
  assert.strictEqual(hit('1.1.1.1', { url: '/static/css/site.css' }), 200);
});

test('form posts have a smaller budget', () => {
  rl.reset();
  for (let i = 0; i < rl.LIMITS.post; i++) assert.strictEqual(hit('3.3.3.3', { method: 'POST', url: '/login' }), 200);
  assert.strictEqual(hit('3.3.3.3', { method: 'POST', url: '/login' }), 429);
});

test('flooding for several minutes gets the address banned and logged for the firewall', () => {
  rl.reset();
  const clock = Date.now;
  let t = clock();
  Date.now = () => t;
  try {
    for (let m = 0; m < rl.STRIKES_TO_BAN; m++) {
      for (let i = 0; i <= rl.LIMITS.page; i++) hit('4.4.4.4');
      t += 61 * 1000;
    }
    assert.strictEqual(hit('4.4.4.4'), 429); // banned, even though it's a new minute
    assert.strictEqual(rl.status().banned, 1);
    assert.match(fs.readFileSync(path.join(process.env.DATA_DIR, 'blocked.log'), 'utf8'), /BLOCK 4\.4\.4\.4/);
  } finally {
    Date.now = clock;
  }
});

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'botcheck-test-'));
const b = require('../src/botcheck');

test('random-letter usernames are spotted, real names are not', () => {
  for (const n of ['gnvrqjxroz', 'pnvzglzjej', 'ijrpiorxyy', 'kdzdoizgjt', 'hquuszouoy', 'mdkfwvhtzt', 'vodfmxyeii', 'xmypngmhll']) assert.ok(b.looksRandom(n), n);
  for (const n of ['reader1', 'fenzsly', 'shadowreader', 'johnsmith', 'michaelangelo', 'sakuraharuno', 'zhangwei', 'krzysztof', 'priyanka', 'jiangchen', 'Gnvrqjxroz1']) assert.ok(!b.looksRandom(n), n);
});

test('sign-up checks: trap field, speed, browser script, per-address limit', () => {
  const real = Date.now;
  const { token, jsKey } = b.signupToken();
  const js = jsKey.split('').reverse().join('');
  const req = (body, ip = '1.1.1.1') => ({ ip, body });
  assert.strictEqual(b.checkSignup(req({ ft: token, js, website: 'http://spam' })), 'trap');
  assert.strictEqual(b.checkSignup(req({ ft: token, js })), 'too-fast');
  assert.strictEqual(b.checkSignup(req({ js })), 'no-token');
  assert.strictEqual(b.checkSignup(req({ ft: token.replace(/.$/, '0'), js })), 'no-token');
  Date.now = () => real() + 5000;
  try {
    assert.strictEqual(b.checkSignup(req({ ft: token, js: '' })), 'no-js');
    assert.strictEqual(b.checkSignup(req({ ft: token, js })), null);
    for (let i = 0; i < b.PER_IP_PER_DAY; i++) b.noteSignup(req({}));
    assert.strictEqual(b.checkSignup(req({ ft: token, js })), 'too-many');
    assert.strictEqual(b.checkSignup(req({ ft: token, js }, '2.2.2.2')), null);
  } finally {
    Date.now = real;
  }
});

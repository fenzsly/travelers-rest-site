// Emergency password reset, run on the server itself (e.g. from Hetzner's web console):
//   cd /opt/novel-site/repo/novel-site && sudo -u novels DATA_DIR=/var/lib/novel-site node scripts/reset-password.js dimpu
// Prints a new random password. With no username, resets the site owner.
// It also turns off two-factor login for that account and logs it out everywhere
// (use this if you lost your phone and your backup codes).
const crypto = require('node:crypto');
const { db } = require('../src/db');
const { hashPassword } = require('../src/auth');

const name = process.argv[2];
const user = name
  ? db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(name)
  : db.prepare('SELECT id, username FROM users WHERE is_owner = 1').get();
if (!user) {
  console.error(name ? `No user named "${name}".` : 'No owner account found.');
  process.exit(1);
}
const password = crypto.randomBytes(9).toString('base64url');
db.prepare(`UPDATE users SET password_hash = ?, totp_enabled = 0, totp_secret = NULL, totp_backup = '[]',
  token_version = token_version + 1 WHERE id = ?`).run(hashPassword(password), user.id);
require('../src/security').log(null, 'admin_reset_password', { userId: user.id, username: user.username, detail: 'server script; two-factor turned off' });
console.log(`New password for ${user.username}: ${password}`);
console.log('Two-factor login is off for this account. Turn it back on in the admin panel under 🔐 Security.');

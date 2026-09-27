// Emergency password reset, run on the server itself (e.g. from Hetzner's web console):
//   cd /opt/novel-site/repo/novel-site && sudo -u novels DATA_DIR=/var/lib/novel-site node scripts/reset-password.js dimpu
// Prints a new random password. With no username, resets the site owner.
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
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
console.log(`New password for ${user.username}: ${password}`);

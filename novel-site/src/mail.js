// Sending email (verification, password resets) through an SMTP service configured in Admin → Email.
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { db } = require('./db');
const { getSettings } = require('./settings');

const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

function isValidEmail(email) {
  return EMAIL_RE.test(String(email || '')) && String(email).length <= 200;
}

function isConfigured() {
  if (process.env.MAIL_OUTBOX) return true;
  const s = getSettings();
  return Boolean(s.smtp_host && s.smtp_from);
}

function smtpPassword(stored) {
  try {
    return require('./security').decrypt(stored);
  } catch {
    throw new Error('The saved email password can’t be read (was the site moved to a new server?). Enter it again in Admin → Email.');
  }
}

function transport() {
  const s = getSettings();
  const port = Number(s.smtp_port) || 587;
  return nodemailer.createTransport({
    host: s.smtp_host,
    port,
    secure: port === 465,
    auth: s.smtp_user ? { user: s.smtp_user, pass: smtpPassword(s.smtp_pass) } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

/** Send a plain-text email with a simple HTML version. Throws if sending fails. */
async function send({ to, subject, text, replyTo }) {
  if (!isConfigured()) throw new Error('Email isn’t set up yet (Admin → Email).');
  const s = getSettings();
  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22252b;max-width:560px">
    ${esc(text).replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}
    <p style="color:#7a808c;font-size:12.5px;margin-top:24px">${esc(s.site_name)}</p></div>`;
  if (process.env.MAIL_OUTBOX) { // automated tests: record instead of sending
    require('node:fs').appendFileSync(process.env.MAIL_OUTBOX, `${JSON.stringify({ to, subject, text, replyTo })}\n`);
    return;
  }
  await transport().sendMail({ from: s.smtp_from, to, subject, text, html, ...(replyTo ? { replyTo } : {}) });
}

/** Create a one-time token (stored hashed). Returns the raw token for the link. */
function createToken(userId, kind, email, hours) {
  const token = crypto.randomBytes(24).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND kind = ?').run(userId, kind);
  db.prepare('INSERT INTO email_tokens (token_hash, user_id, kind, email, expires_at) VALUES (?, ?, ?, ?, unixepoch() + ?)')
    .run(hash, userId, kind, email || null, hours * 3600);
  return token;
}

/** Look up a token without using it up. */
function findToken(token, kind) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return db.prepare('SELECT * FROM email_tokens WHERE token_hash = ? AND kind = ? AND expires_at > unixepoch()').get(hash, kind) || null;
}

function useToken(token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM email_tokens WHERE token_hash = ?').run(hash);
}

async function sendVerification(user, email, baseUrl) {
  const token = createToken(user.id, 'verify', email, 48);
  const s = getSettings();
  await send({
    to: email,
    subject: `Confirm your email for ${s.site_name}`,
    text: `Hi ${user.username},\n\nPlease confirm your email address by opening this link:\n${baseUrl}/verify-email?token=${token}\n\nThe link works for 48 hours. If you didn't create an account on ${s.site_name}, you can ignore this email.`,
  });
}

async function sendPasswordReset(user, baseUrl) {
  const token = createToken(user.id, 'reset', user.email, 1);
  const s = getSettings();
  await send({
    to: user.email,
    subject: `Reset your ${s.site_name} password`,
    text: `Hi ${user.username},\n\nSomeone (hopefully you) asked to reset your password. Choose a new one here:\n${baseUrl}/reset-password?token=${token}\n\nThe link works for 1 hour. If you didn't ask for this, you can ignore this email and your password stays the same.`,
  });
}

module.exports = { isValidEmail, isConfigured, send, findToken, useToken, sendVerification, sendPasswordReset };

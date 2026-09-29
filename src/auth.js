const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db, DATA_DIR } = require('./db');

// Secret: from env, otherwise generated once and kept in the data volume (no setup needed)
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();
const COOKIE = 'exami_sid';
const secureCookie = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';

function login(res, user) {
  const t = jwt.sign({ uid: user.id }, SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE, t, { httpOnly: true, sameSite: 'lax', secure: secureCookie || !!(res.req && res.req.secure), maxAge: 30 * 864e5 });
}
function logout(res) { res.clearCookie(COOKIE); }

// Attach req.user on every request
function loadUser(req, res, next) {
  req.user = null;
  const t = req.cookies && req.cookies[COOKIE];
  if (t) {
    try {
      const { uid } = jwt.verify(t, SECRET);
      const u = db.prepare('SELECT id,email,name,role,quota_mb,disabled FROM users WHERE id=?').get(uid);
      if (u && !u.disabled) req.user = u;
    } catch { /* invalid token */ }
  }
  res.locals.user = req.user;
  next();
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).render('error', { title: 'ไม่มีสิทธิ์', message: 'หน้านี้สำหรับผู้ดูแลระบบเท่านั้น' });
}

const hash = (p) => bcrypt.hashSync(p, 10);
const verify = (p, h) => bcrypt.compareSync(p, h);

// Convert course invitations made before the user registered
function claimInvites(user) {
  db.prepare(`UPDATE OR IGNORE enrollments SET user_id=?, invited_email=NULL, status='approved'
              WHERE user_id IS NULL AND lower(invited_email)=lower(?)`).run(user.id, user.email);
  db.prepare(`DELETE FROM enrollments WHERE user_id IS NULL AND lower(invited_email)=lower(?)`).run(user.email);
}

module.exports = { login, logout, loadUser, requireLogin, requireAdmin, hash, verify, claimInvites };

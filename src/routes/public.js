const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const auth = require('../auth');
const { getSettings } = require('../util');
const { usage, UPLOAD_DIR } = require('../storage');
const { getExam, getQuestions, copyExam } = require('../examService');
const { TYPES } = require('../grading');

const r = express.Router();
const authLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่' });

r.get('/', (req, res) => {
  const stats = {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    exams: db.prepare('SELECT COUNT(*) c FROM exams').get().c,
    attempts: db.prepare("SELECT COUNT(*) c FROM attempts WHERE status='submitted'").get().c,
  };
  const featured = db.prepare(`SELECT e.id,e.title,e.category,e.copy_count,u.name owner_name,(SELECT COUNT(*) FROM questions q WHERE q.exam_id=e.id) qn
    FROM exams e JOIN users u ON u.id=e.owner_id WHERE e.in_library=1 ORDER BY e.copy_count DESC, e.id DESC LIMIT 6`).all();
  res.render('home', { title: 'หน้าแรก', stats, featured });
});

// ---------- Auth ----------
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//')) ? n : '/dashboard';

r.get('/register', (req, res) => res.render('register', { title: 'สมัครสมาชิก', error: null, form: {}, next: req.query.next || '' }));
r.post('/register', authLimiter, (req, res) => {
  const s = getSettings();
  const form = { name: String(req.body.name || '').trim(), email: String(req.body.email || '').trim().toLowerCase() };
  const pw = String(req.body.password || '');
  const err = (m) => res.status(400).render('register', { title: 'สมัครสมาชิก', error: m, form, next: req.body.next || '' });
  const isFirst = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  if (s.allow_register !== '1' && !isFirst) return err('ปิดรับสมัครสมาชิกชั่วคราว');
  if (!form.name || form.name.length > 100) return err('กรุณากรอกชื่อ');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return err('อีเมลไม่ถูกต้อง');
  if (pw.length < 6) return err('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(form.email)) return err('อีเมลนี้ถูกใช้แล้ว');
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
  const role = (isFirst || (adminEmail && adminEmail === form.email)) ? 'admin' : 'user';
  const info = db.prepare('INSERT INTO users(email,password_hash,name,role) VALUES(?,?,?,?)').run(form.email, auth.hash(pw), form.name, role);
  const user = { id: info.lastInsertRowid, email: form.email };
  auth.claimInvites(user);
  auth.login(res, user);
  res.redirect(safeNext(req.body.next));
});

r.get('/login', (req, res) => res.render('login', { title: 'เข้าสู่ระบบ', error: null, email: '', next: req.query.next || '' }));
r.post('/login', authLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !auth.verify(String(req.body.password || ''), u.password_hash))
    return res.status(400).render('login', { title: 'เข้าสู่ระบบ', error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', email, next: req.body.next || '' });
  if (u.disabled) return res.status(403).render('login', { title: 'เข้าสู่ระบบ', error: 'บัญชีนี้ถูกระงับ', email, next: '' });
  auth.claimInvites(u);
  auth.login(res, u);
  res.redirect(safeNext(req.body.next));
});
r.post('/logout', (req, res) => { auth.logout(res); res.redirect('/'); });

r.get('/account', auth.requireLogin, (req, res) => res.render('account', { title: 'บัญชีของฉัน', msg: null, error: null }));
r.post('/account', auth.requireLogin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const name = String(req.body.name || '').trim();
  if (name) db.prepare('UPDATE users SET name=? WHERE id=?').run(name.slice(0, 100), u.id);
  if (req.body.new_password) {
    if (!auth.verify(String(req.body.password || ''), u.password_hash)) return res.render('account', { title: 'บัญชีของฉัน', msg: null, error: 'รหัสผ่านเดิมไม่ถูกต้อง' });
    if (String(req.body.new_password).length < 6) return res.render('account', { title: 'บัญชีของฉัน', msg: null, error: 'รหัสผ่านใหม่สั้นเกินไป' });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hash(String(req.body.new_password)), u.id);
  }
  res.locals.user = db.prepare('SELECT id,email,name,role FROM users WHERE id=?').get(u.id);
  res.render('account', { title: 'บัญชีของฉัน', msg: 'บันทึกแล้ว', error: null });
});

// ---------- Dashboard ----------
r.get('/dashboard', auth.requireLogin, (req, res) => {
  const uid = req.user.id;
  const exams = db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM questions q WHERE q.exam_id=e.id) qn,
      (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id AND a.status='submitted') submitted,
      (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id AND a.status='submitted' AND a.pending_count>0) pending
    FROM exams e WHERE owner_id=? ORDER BY updated_at DESC`).all(uid);
  const courses = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id) ln,
      (SELECT COUNT(*) FROM enrollments en WHERE en.course_id=c.id AND en.status='approved') students,
      (SELECT COUNT(*) FROM enrollments en WHERE en.course_id=c.id AND en.status='pending' AND en.user_id IS NOT NULL) requests
    FROM courses c WHERE owner_id=? ORDER BY id DESC`).all(uid);
  const learning = db.prepare(`SELECT c.id,c.title,en.status,
      (SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id) ln,
      (SELECT COUNT(*) FROM lesson_progress p JOIN lessons l ON l.id=p.lesson_id WHERE l.course_id=c.id AND p.user_id=? AND p.completed_at IS NOT NULL) done
    FROM enrollments en JOIN courses c ON c.id=en.course_id WHERE en.user_id=? AND en.status!='rejected' ORDER BY en.id DESC`).all(uid, uid);
  const results = db.prepare(`SELECT a.*, e.title FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.user_id=? ORDER BY a.id DESC LIMIT 10`).all(uid);
  res.render('dashboard', { title: 'แดชบอร์ด', exams, courses, learning, results, usage: usage(uid) });
});

r.get('/my-results', auth.requireLogin, (req, res) => {
  const results = db.prepare(`SELECT a.*, e.title, e.settings FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.user_id=? ORDER BY a.id DESC`).all(req.user.id);
  res.render('my_results', { title: 'ผลสอบของฉัน', results });
});

// ---------- Public library of shared exam sets ----------
r.get('/library', (req, res) => {
  const q = String(req.query.q || '').trim();
  const cat = String(req.query.cat || '').trim();
  const like = '%' + q + '%';
  const exams = db.prepare(`SELECT e.id,e.title,e.description,e.category,e.copy_count,e.updated_at,u.name owner_name,
      (SELECT COUNT(*) FROM questions x WHERE x.exam_id=e.id) qn
    FROM exams e JOIN users u ON u.id=e.owner_id
    WHERE e.in_library=1 AND (?='' OR e.title LIKE ? OR e.description LIKE ?) AND (?='' OR e.category=?)
    ORDER BY e.copy_count DESC, e.updated_at DESC LIMIT 200`).all(q, like, like, cat, cat);
  const cats = db.prepare(`SELECT category, COUNT(*) n FROM exams WHERE in_library=1 AND category!='' GROUP BY category ORDER BY n DESC`).all();
  res.render('library', { title: 'คลังข้อสอบสาธารณะ', exams, cats, q, cat });
});

r.get('/library/:id', (req, res) => {
  const e = getExam(req.params.id);
  if (!e || (!e.in_library && (!req.user || req.user.id !== e.owner_id))) return res.status(404).render('error', { title: 'ไม่พบชุดข้อสอบ', message: 'ชุดข้อสอบนี้ไม่ได้เผยแพร่ในคลัง' });
  const owner = db.prepare('SELECT name FROM users WHERE id=?').get(e.owner_id);
  res.render('library_view', { title: e.title, exam: e, owner, questions: getQuestions(e.id), TYPES });
});

r.post('/library/:id/copy', auth.requireLogin, (req, res) => {
  const e = getExam(req.params.id);
  if (!e || (!e.in_library && e.owner_id !== req.user.id)) return res.status(404).render('error', { title: 'ไม่พบ', message: 'ไม่พบชุดข้อสอบ' });
  const newId = copyExam(e.id, req.user.id, { asLibraryCopy: e.owner_id !== req.user.id });
  res.redirect(`/exams/${newId}/edit?copied=1`);
});

// ---------- Files (access-controlled) ----------
r.get('/files/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).end();
  let ok = false;
  if (f.kind === 'question_image') ok = true;                   // visible to exam takers
  else if (req.user && (req.user.id === f.owner_id || req.user.role === 'admin')) ok = true;
  else if (f.attempt_id) {
    const at = db.prepare('SELECT token, user_id FROM attempts WHERE id=?').get(f.attempt_id);
    if (at && ((req.query.t && req.query.t === at.token) || (req.user && req.user.id === at.user_id))) ok = true;
  }
  if (!ok) return res.status(403).end();
  const inline = /^image\/|^application\/pdf$|^video\/|^audio\//.test(f.mime);
  res.setHeader('Content-Type', f.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.orig_name)}`);
  if (f.kind !== 'question_image') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
  res.sendFile(path.join(UPLOAD_DIR, f.stored_name));
});

module.exports = r;

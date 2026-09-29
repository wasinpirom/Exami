// Simple courses: lessons with embedded video links + notes + external file links + exam links.
// No files are stored — everything is linked from elsewhere (YouTube, Drive, etc.)
const express = require('express');
const { db } = require('../db');
const { requireLogin } = require('../auth');
const { token, parseJSON, safeUrl, videoEmbed, youtubeId } = require('../util');

const r = express.Router();
const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function ownCourse(req) {
  const c = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!c || (c.owner_id !== req.user.id && req.user.role !== 'admin')) { const e = new Error('ไม่พบคอร์ส หรือคุณไม่มีสิทธิ์'); e.status = 404; throw e; }
  return c;
}
const lessonsOf = (cid) => db.prepare('SELECT * FROM lessons WHERE course_id=? ORDER BY position, id').all(cid);
function enrollment(courseId, user) {
  if (!user) return null;
  return db.prepare('SELECT * FROM enrollments WHERE course_id=? AND user_id=?').get(courseId, user.id);
}
function canLearn(course, user) {
  if (!user) return false;
  if (user.id === course.owner_id || user.role === 'admin') return true;
  const en = enrollment(course.id, user);
  return !!(en && en.status === 'approved');
}

// ---------- Owner ----------
r.post('/courses/new', requireLogin, (req, res) => {
  const n = db.prepare('SELECT COUNT(*) c FROM courses WHERE owner_id=?').get(req.user.id).c + 1;
  const t = String(req.body.title || '').trim() || `คอร์สใหม่ ${n}`;
  const x = db.prepare('INSERT INTO courses(owner_id,title,share_token) VALUES(?,?,?)').run(req.user.id, t.slice(0, 300), token(8));
  res.redirect(`/courses/${x.lastInsertRowid}/edit`);
});

r.get('/courses/:id/edit', requireLogin, (req, res) => {
  const course = ownCourse(req);
  const lessons = lessonsOf(course.id);
  res.render('course_edit', { title: 'จัดการคอร์ส: ' + course.title, course, lessons, saved: !!req.query.saved });
});

r.post('/courses/:id', requireLogin, (req, res) => {
  const c = ownCourse(req); const b = req.body;
  db.prepare('UPDATE courses SET title=?, description=?, cover_url=?, require_approval=?, is_listed=? WHERE id=?')
    .run(String(b.title || c.title).slice(0, 300), String(b.description || '').slice(0, 20000), safeUrl(b.cover_url),
      b.require_approval ? 1 : 0, b.is_listed ? 1 : 0, c.id);
  res.redirect(`/courses/${c.id}/edit?saved=1`);
});
r.post('/courses/:id/delete', requireLogin, (req, res) => { const c = ownCourse(req); db.prepare('DELETE FROM courses WHERE id=?').run(c.id); res.redirect('/dashboard'); });

r.post('/courses/:id/lessons', requireLogin, (req, res) => {
  const c = ownCourse(req);
  const pos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 p FROM lessons WHERE course_id=?').get(c.id).p;
  const x = db.prepare('INSERT INTO lessons(course_id,position,title) VALUES(?,?,?)').run(c.id, pos, String(req.body.title || '').trim() || `บทที่ ${pos + 1}`);
  res.redirect(`/courses/${c.id}/lessons/${x.lastInsertRowid}/edit`);
});

r.get('/courses/:id/lessons/:lid/edit', requireLogin, (req, res) => {
  const course = ownCourse(req);
  const lesson = db.prepare('SELECT * FROM lessons WHERE id=? AND course_id=?').get(req.params.lid, course.id);
  if (!lesson) return res.status(404).render('error', { title: 'ไม่พบบทเรียน', message: '' });
  const exams = db.prepare('SELECT id,title FROM exams WHERE owner_id=? ORDER BY updated_at DESC').all(course.owner_id);
  res.render('lesson_edit', { title: 'แก้ไขบทเรียน', course, lesson, links: parseJSON(lesson.links, []), exams, embed: videoEmbed(lesson.video_url), saved: !!req.query.saved });
});

r.post('/courses/:id/lessons/:lid', requireLogin, (req, res) => {
  const c = ownCourse(req); const b = req.body;
  const titles = [].concat(b.link_title || []), urls = [].concat(b.link_url || []);
  const links = urls.map((u, i) => ({ title: String(titles[i] || '').trim().slice(0, 200), url: safeUrl(u) })).filter(l => l.url);
  let examId = parseInt(b.exam_id) || null;
  if (examId && !db.prepare('SELECT 1 FROM exams WHERE id=? AND owner_id=?').get(examId, c.owner_id)) examId = null;
  db.prepare('UPDATE lessons SET title=?, video_url=?, content_md=?, links=?, exam_id=?, is_preview=? WHERE id=? AND course_id=?')
    .run(String(b.title || 'บทเรียน').slice(0, 300), safeUrl(b.video_url), String(b.content_md || '').slice(0, 100000), JSON.stringify(links), examId,
      b.is_preview ? 1 : 0, req.params.lid, c.id);
  res.redirect(`/courses/${c.id}/lessons/${req.params.lid}/edit?saved=1`);
});

r.post('/courses/:id/lessons/:lid/delete', requireLogin, (req, res) => {
  const c = ownCourse(req);
  db.prepare('DELETE FROM lessons WHERE id=? AND course_id=?').run(req.params.lid, c.id);
  res.redirect(`/courses/${c.id}/edit`);
});

r.post('/courses/:id/lessons/:lid/move', requireLogin, (req, res) => {
  const c = ownCourse(req);
  const ls = lessonsOf(c.id); const i = ls.findIndex(l => l.id === Number(req.params.lid));
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (i >= 0 && j >= 0 && j < ls.length) { [ls[i], ls[j]] = [ls[j], ls[i]]; }
  const up = db.prepare('UPDATE lessons SET position=? WHERE id=?');
  db.transaction(() => ls.forEach((l, k) => up.run(k, l.id)))();
  res.redirect(`/courses/${c.id}/edit`);
});

// Students & enrollment requests
r.get('/courses/:id/students', requireLogin, (req, res) => {
  const course = ownCourse(req);
  const rows = db.prepare(`SELECT en.*, u.name, u.email FROM enrollments en LEFT JOIN users u ON u.id=en.user_id WHERE en.course_id=? ORDER BY en.status, en.id DESC`).all(course.id);
  res.render('course_students', { title: 'ผู้เรียน: ' + course.title, course, rows, msg: req.query.msg || null });
});

r.post('/courses/:id/students', requireLogin, (req, res) => {
  const c = ownCourse(req);
  const emails = String(req.body.emails || '').split(/[\s,;]+/).map(e => e.trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 500);
  let added = 0, invited = 0;
  for (const em of emails) {
    const u = db.prepare('SELECT id FROM users WHERE email=?').get(em);
    if (u) {
      const x = db.prepare(`INSERT INTO enrollments(course_id,user_id,status) VALUES(?,?,'approved') ON CONFLICT(course_id,user_id) DO UPDATE SET status='approved'`).run(c.id, u.id);
      if (x.changes) added++;
    } else if (!db.prepare('SELECT 1 FROM enrollments WHERE course_id=? AND invited_email=?').get(c.id, em)) {
      db.prepare(`INSERT INTO enrollments(course_id,invited_email,status) VALUES(?,?,'approved')`).run(c.id, em); invited++;
    }
  }
  res.redirect(`/courses/${c.id}/students?msg=` + encodeURIComponent(`เพิ่มผู้เรียน ${added} คน, เชิญ (ยังไม่สมัคร) ${invited} อีเมล — ผู้ที่ยังไม่มีบัญชีจะเข้าคอร์สอัตโนมัติเมื่อสมัครด้วยอีเมลนี้`));
});

r.post('/courses/:id/enrollments/:eid/:action', requireLogin, (req, res) => {
  const c = ownCourse(req);
  const a = req.params.action;
  if (a === 'approve') db.prepare(`UPDATE enrollments SET status='approved' WHERE id=? AND course_id=?`).run(req.params.eid, c.id);
  else if (a === 'reject') db.prepare(`UPDATE enrollments SET status='rejected' WHERE id=? AND course_id=?`).run(req.params.eid, c.id);
  else if (a === 'remove') db.prepare(`DELETE FROM enrollments WHERE id=? AND course_id=?`).run(req.params.eid, c.id);
  else if (a === 'approve-all') db.prepare(`UPDATE enrollments SET status='approved' WHERE course_id=? AND status='pending'`).run(c.id);
  res.redirect(`/courses/${c.id}/students`);
});

// Progress matrix
r.get('/courses/:id/progress', requireLogin, (req, res) => {
  const course = ownCourse(req);
  const lessons = lessonsOf(course.id);
  const students = db.prepare(`SELECT u.id,u.name,u.email FROM enrollments en JOIN users u ON u.id=en.user_id WHERE en.course_id=? AND en.status='approved' ORDER BY u.name`).all(course.id);
  const prog = db.prepare(`SELECT p.* FROM lesson_progress p JOIN lessons l ON l.id=p.lesson_id WHERE l.course_id=?`).all(course.id);
  const pm = {}; for (const p of prog) pm[p.user_id + ':' + p.lesson_id] = p;
  const examIds = [...new Set(lessons.map(l => l.exam_id).filter(Boolean))];
  const scores = {};
  if (examIds.length && students.length) {
    const rows = db.prepare(`SELECT user_id, exam_id, MAX(score) score, MAX(max_score) max_score, MAX(pending_count) pend FROM attempts
      WHERE status='submitted' AND exam_id IN (${examIds.join(',')}) AND user_id IS NOT NULL GROUP BY user_id, exam_id`).all();
    for (const x of rows) scores[x.user_id + ':' + x.exam_id] = x;
  }
  res.render('course_progress', { title: 'ความก้าวหน้า: ' + course.title, course, lessons, students, pm, scores });
});

r.get('/courses/:id/progress.csv', requireLogin, (req, res) => {
  const course = ownCourse(req);
  const lessons = lessonsOf(course.id);
  const students = db.prepare(`SELECT u.id,u.name,u.email FROM enrollments en JOIN users u ON u.id=en.user_id WHERE en.course_id=? AND en.status='approved' ORDER BY u.name`).all(course.id);
  const prog = db.prepare(`SELECT p.* FROM lesson_progress p JOIN lessons l ON l.id=p.lesson_id WHERE l.course_id=?`).all(course.id);
  const pm = {}; for (const p of prog) pm[p.user_id + ':' + p.lesson_id] = p;
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['ชื่อ', 'อีเมล', 'เรียนจบ (บท)', ...lessons.map((l, i) => `${i + 1}. ${l.title}`)];
  const rows = students.map(s => {
    const cells = lessons.map(l => { const p = pm[s.id + ':' + l.id]; return !p ? '' : p.completed_at ? 'จบแล้ว' : `ดูแล้ว ${p.watch_percent}%`; });
    return [s.name, s.email, cells.filter(c => c === 'จบแล้ว').length + '/' + lessons.length, ...cells];
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="course-progress-${course.id}.csv"`);
  res.send('﻿' + [head, ...rows].map(x => x.map(esc).join(',')).join('\r\n'));
});

// ---------- Public catalog & learner ----------
r.get('/courses', (req, res) => {
  const courses = db.prepare(`SELECT c.*, u.name owner_name, (SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id) ln,
    (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id AND e.status='approved') students
    FROM courses c JOIN users u ON u.id=c.owner_id WHERE c.is_listed=1 ORDER BY students DESC, c.id DESC LIMIT 200`).all();
  res.render('courses', { title: 'คอร์สเรียน', courses });
});

r.get('/c/:token', (req, res) => {
  const course = db.prepare('SELECT c.*, u.name owner_name FROM courses c JOIN users u ON u.id=c.owner_id WHERE share_token=?').get(req.params.token);
  if (!course) return res.status(404).render('error', { title: 'ไม่พบคอร์ส', message: 'ลิงก์ไม่ถูกต้อง' });
  res.render('course_landing', { title: course.title, course, lessons: lessonsOf(course.id), en: enrollment(course.id, req.user), canLearn: canLearn(course, req.user) });
});

r.post('/c/:token/enroll', requireLogin, (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE share_token=?').get(req.params.token);
  if (!course) return res.status(404).render('error', { title: 'ไม่พบคอร์ส', message: '' });
  const en = enrollment(course.id, req.user);
  if (!en) db.prepare('INSERT INTO enrollments(course_id,user_id,status) VALUES(?,?,?)').run(course.id, req.user.id, course.require_approval ? 'pending' : 'approved');
  else if (en.status === 'rejected') db.prepare(`UPDATE enrollments SET status='pending' WHERE id=?`).run(en.id);
  res.redirect('/c/' + course.share_token);
});

r.get('/learn/:cid', (req, res) => {
  const ls = lessonsOf(req.params.cid);
  if (!ls.length) return res.redirect('/dashboard');
  let target = ls[0];
  if (req.user) {
    const done = new Set(db.prepare(`SELECT lesson_id FROM lesson_progress WHERE user_id=? AND completed_at IS NOT NULL`).all(req.user.id).map(x => x.lesson_id));
    target = ls.find(l => !done.has(l.id)) || ls[0];
  }
  res.redirect(`/learn/${req.params.cid}/${target.id}`);
});

// Course completion certificate
r.get('/learn/:cid/certificate', requireLogin, (req, res) => {
  const course = db.prepare('SELECT c.*, u.name owner_name FROM courses c JOIN users u ON u.id=c.owner_id WHERE c.id=?').get(req.params.cid);
  if (!course || !canLearn(course, req.user)) return res.status(404).render('error', { title: 'ไม่พบ', message: '' });
  const ls = lessonsOf(course.id);
  const done = db.prepare(`SELECT COUNT(*) c, MAX(completed_at) last FROM lesson_progress p JOIN lessons l ON l.id=p.lesson_id WHERE l.course_id=? AND p.user_id=? AND p.completed_at IS NOT NULL`).get(course.id, req.user.id);
  if (!ls.length || done.c < ls.length) return res.status(403).render('error', { title: 'ยังเรียนไม่ครบ', message: `เรียนจบแล้ว ${done.c}/${ls.length} บท — เรียนให้ครบทุกบทเพื่อรับเกียรติบัตร` });
  res.render('certificate', { title: 'เกียรติบัตร', name: req.user.name, what: course.title, kind: 'สำเร็จการเรียนหลักสูตร',
    detail: `จำนวน ${ls.length} บทเรียน`, date: done.last, issuer: course.owner_name, code: 'CR-' + course.id + '-' + req.user.id, verifyUrl: '/c/' + course.share_token });
});

r.get('/learn/:cid/:lid', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.cid);
  const lesson = course && db.prepare('SELECT * FROM lessons WHERE id=? AND course_id=?').get(req.params.lid, course.id);
  if (!lesson) return res.status(404).render('error', { title: 'ไม่พบบทเรียน', message: '' });
  const allowed = canLearn(course, req.user);
  if (!allowed && !lesson.is_preview) {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    return res.redirect('/c/' + course.share_token);
  }
  const lessons = lessonsOf(course.id);
  let progress = {};
  if (req.user) {
    const t = sqlNow();
    db.prepare(`INSERT INTO lesson_progress(user_id,lesson_id,first_viewed_at,last_viewed_at,view_count) VALUES(?,?,?,?,1)
      ON CONFLICT(user_id,lesson_id) DO UPDATE SET last_viewed_at=excluded.last_viewed_at, view_count=view_count+1`).run(req.user.id, lesson.id, t, t);
    progress = Object.fromEntries(db.prepare(`SELECT p.* FROM lesson_progress p JOIN lessons l ON l.id=p.lesson_id WHERE l.course_id=? AND p.user_id=?`)
      .all(course.id, req.user.id).map(p => [p.lesson_id, p]));
  }
  const exam = lesson.exam_id ? db.prepare('SELECT id,title,share_token FROM exams WHERE id=?').get(lesson.exam_id) : null;
  let examResult = null;
  if (exam && req.user) examResult = db.prepare(`SELECT * FROM attempts WHERE exam_id=? AND user_id=? AND status='submitted' ORDER BY score DESC LIMIT 1`).get(exam.id, req.user.id);
  const i = lessons.findIndex(l => l.id === lesson.id);
  res.render('learn', {
    title: lesson.title, course, lesson, lessons, progress, exam, examResult, allowed,
    embed: videoEmbed(lesson.video_url), ytId: youtubeId(lesson.video_url), links: parseJSON(lesson.links, []),
    prev: lessons[i - 1], next: lessons[i + 1], isOwner: req.user && req.user.id === course.owner_id,
    allDone: req.user && lessons.length > 0 && lessons.every(l => progress[l.id] && progress[l.id].completed_at),
  });
});

r.post('/api/progress/:lid', requireLogin, (req, res) => {
  const lesson = db.prepare('SELECT l.*, c.owner_id FROM lessons l JOIN courses c ON c.id=l.course_id WHERE l.id=?').get(req.params.lid);
  if (!lesson) return res.status(404).json({ error: 'not found' });
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(lesson.course_id);
  if (!canLearn(course, req.user)) return res.status(403).json({ error: 'ยังไม่ได้ลงทะเบียนคอร์สนี้' });
  const b = req.body || {}; const t = sqlNow();
  db.prepare(`INSERT INTO lesson_progress(user_id,lesson_id,first_viewed_at,last_viewed_at,view_count) VALUES(?,?,?,?,1) ON CONFLICT DO NOTHING`).run(req.user.id, lesson.id, t, t);
  if (b.watch_percent != null) {
    const w = Math.max(0, Math.min(100, parseInt(b.watch_percent) || 0));
    db.prepare('UPDATE lesson_progress SET watch_percent=MAX(watch_percent,?) WHERE user_id=? AND lesson_id=?').run(w, req.user.id, lesson.id);
  }
  if (b.completed === true) db.prepare('UPDATE lesson_progress SET completed_at=COALESCE(completed_at,?) WHERE user_id=? AND lesson_id=?').run(t, req.user.id, lesson.id);
  if (b.completed === false) db.prepare('UPDATE lesson_progress SET completed_at=NULL WHERE user_id=? AND lesson_id=?').run(req.user.id, lesson.id);
  res.json({ ok: true, progress: db.prepare('SELECT * FROM lesson_progress WHERE user_id=? AND lesson_id=?').get(req.user.id, lesson.id) });
});

module.exports = r;

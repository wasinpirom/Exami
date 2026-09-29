// Exam owner: builder, AI generation, results, grading
const express = require('express');
const { db } = require('../db');
const { requireLogin } = require('../auth');
const { parseJSON, round2, token, fmtDate } = require('../util');
const svc = require('../examService');
const { TYPES, finalScore, recomputeAttempt, responseText, correctAnswerText } = require('../grading');
const { upload, registerFile, usage } = require('../storage');
const ai = require('../ai');

const r = express.Router();

function ownExam(req, res) {
  const e = svc.getExam(req.params.id);
  if (!e || (e.owner_id !== req.user.id && req.user.role !== 'admin')) {
    const err = new Error('ไม่พบแบบทดสอบ หรือคุณไม่มีสิทธิ์'); err.status = 404; throw err;
  }
  return e;
}

r.post('/exams/new', requireLogin, (req, res) => {
  const id = svc.createExam(req.user.id, { title: String(req.body.title || '').trim() || 'แบบทดสอบใหม่' });
  res.redirect(`/exams/${id}/edit`);
});

r.get('/exams/:id/edit', requireLogin, async (req, res) => {
  const exam = ownExam(req, res);
  const questions = svc.getQuestions(exam.id).map(q => ({ ...q, data: parseJSON(q.data, {}) }));
  res.render('exam_edit', { title: 'แก้ไข: ' + exam.title, exam, questions, TYPES, usage: usage(exam.owner_id), aiEnabled: ai.AI.enabled, aiModel: ai.AI.model, copied: !!req.query.copied });
});

r.put('/api/exams/:id', requireLogin, (req, res) => {
  const exam = ownExam(req, res);
  svc.saveExam(exam.id, exam.owner_id, req.body || {});
  const questions = svc.getQuestions(exam.id).map(q => ({ ...q, data: parseJSON(q.data, {}) }));
  res.json({ ok: true, questions });
});

r.post('/api/exams/:id/image', requireLogin, (req, res, next) => {
  const exam = ownExam(req, res);
  upload().single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์' });
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(req.file.mimetype)) {
      require('fs').unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'รองรับเฉพาะรูป PNG, JPG, GIF, WEBP' });
    }
    try {
      const f = registerFile({ file: req.file, ownerId: exam.owner_id, kind: 'question_image' });
      res.json({ ok: true, id: f.id, url: '/files/' + f.id, usage: usage(exam.owner_id) });
    } catch (e) { next(e); }
  });
});

r.post('/exams/:id/delete', requireLogin, (req, res) => { const e = ownExam(req, res); svc.deleteExam(e.id); res.redirect('/dashboard'); });
r.post('/exams/:id/duplicate', requireLogin, (req, res) => {
  const e = ownExam(req, res);
  const id = svc.copyExam(e.id, req.user.id, { asLibraryCopy: false });
  res.redirect(`/exams/${id}/edit`);
});
r.post('/exams/:id/toggle', requireLogin, (req, res) => {
  const e = ownExam(req, res);
  db.prepare('UPDATE exams SET is_open=? WHERE id=?').run(e.is_open ? 0 : 1, e.id);
  res.redirect(req.get('referer') || `/exams/${e.id}/results`);
});
r.post('/exams/:id/new-link', requireLogin, (req, res) => {
  const e = ownExam(req, res);
  db.prepare('UPDATE exams SET share_token=? WHERE id=?').run(token(8), e.id);
  res.redirect(`/exams/${e.id}/edit`);
});

// ---------- AI: generate questions (async job) ----------
r.post('/api/ai/generate', requireLogin, (req, res) => {
  if (!ai.AI.enabled) return res.status(400).json({ error: 'AI ถูกปิดใช้งานบนเซิร์ฟเวอร์นี้' });
  const running = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE user_id=? AND status IN ('queued','running')`).get(req.user.id).c;
  if (running >= 3) return res.status(429).json({ error: 'มีงาน AI ค้างอยู่หลายงาน กรุณารอสักครู่' });
  const b = req.body || {};
  if (!String(b.topic || '').trim() && !String(b.source_text || '').trim()) return res.status(400).json({ error: 'กรุณาระบุหัวข้อ หรือวางเนื้อหา' });
  const id = ai.enqueue(req.user.id, 'generate', {
    mode: b.mode === 'convert' ? 'convert' : 'generate',
    topic: String(b.topic || '').slice(0, 500), source_text: String(b.source_text || '').slice(0, b.mode === 'convert' ? 20000 : 12000),
    count: b.count, types: b.types, difficulty: b.difficulty, language: b.language, points: b.points,
  });
  res.json({ job_id: id });
});

r.get('/api/jobs/:id', requireLogin, (req, res) => {
  const j = db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json({ id: j.id, status: j.status, error: j.error, result: parseJSON(j.result, null), position: ai.queuePosition(j.id) });
});

r.get('/api/ai/status', requireLogin, async (req, res) => res.json(await ai.status()));

// ---------- Results ----------
function loadResults(examId) {
  const exam = svc.getExam(examId);
  const questions = svc.getQuestions(examId);
  const attempts = db.prepare(`SELECT * FROM attempts WHERE exam_id=? ORDER BY status DESC, submitted_at DESC, id DESC`).all(examId);
  const answers = db.prepare(`SELECT a.* FROM answers a JOIN attempts t ON t.id=a.attempt_id WHERE t.exam_id=? AND t.status='submitted'`).all(examId);
  const perQ = {};
  for (const q of questions) perQ[q.id] = { q, n: 0, sum: 0, full: 0 };
  for (const a of answers) {
    const p = perQ[a.question_id]; if (!p || a.status === 'pending') continue;
    const s = Number(finalScore(a)) || 0; p.n++; p.sum += s; if (s >= p.q.points && p.q.points > 0) p.full++;
  }
  const sub = attempts.filter(a => a.status === 'submitted');
  const scores = sub.map(a => a.max_score ? a.score / a.max_score * 100 : 0);
  const stats = {
    submitted: sub.length, inProgress: attempts.length - sub.length,
    pending: sub.filter(a => a.pending_count > 0).length,
    avg: sub.length ? round2(sub.reduce((s, a) => s + a.score, 0) / sub.length) : 0,
    max: sub.length ? Math.max(...sub.map(a => a.score)) : 0,
    min: sub.length ? Math.min(...sub.map(a => a.score)) : 0,
    passed: scores.filter(p => p >= exam.settings.pass_percent).length,
    buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0].map((_, i) => scores.filter(p => (i === 9 ? p >= 90 : p >= i * 10 && p < i * 10 + 10)).length),
  };
  return { exam, questions, attempts, perQ: Object.values(perQ), stats };
}

r.get('/exams/:id/results', requireLogin, (req, res) => {
  ownExam(req, res);
  const data = loadResults(req.params.id);
  const job = db.prepare(`SELECT id,status FROM jobs WHERE type='grade_exam' AND json_extract(input,'$.exam_id')=? ORDER BY id DESC LIMIT 1`).get(Number(req.params.id));
  res.render('exam_results', { title: 'ผลสอบ: ' + data.exam.title, ...data, TYPES, aiEnabled: ai.AI.enabled, lastJob: job });
});

r.get('/exams/:id/results.csv', requireLogin, (req, res) => {
  ownExam(req, res);
  const { exam, questions, attempts } = loadResults(req.params.id);
  const ans = db.prepare(`SELECT a.* FROM answers a JOIN attempts t ON t.id=a.attempt_id WHERE t.exam_id=?`).all(exam.id);
  const map = {}; for (const a of ans) map[a.attempt_id + ':' + a.question_id] = a;
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['ชื่อ', exam.settings.ident_label || 'รหัส', 'สถานะ', 'เริ่ม', 'ส่ง', 'คะแนน', 'เต็ม', 'ร้อยละ', 'รอตรวจ', 'สลับแท็บ',
    ...questions.map((q, i) => `ข้อ${i + 1} (${q.points})`)];
  const rows = attempts.map(a => [a.taker_name, a.taker_ident, a.status === 'submitted' ? 'ส่งแล้ว' : 'กำลังทำ', fmtDate(a.started_at), fmtDate(a.submitted_at),
    a.score, a.max_score, a.max_score ? round2(a.score / a.max_score * 100) : 0, a.pending_count, a.tab_switches,
    ...questions.map(q => { const x = map[a.id + ':' + q.id]; return !x ? '' : x.status === 'pending' ? 'รอตรวจ' : finalScore(x); })]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="exami-results-${exam.id}.csv"`);
  res.send('﻿' + [head, ...rows].map(r => r.map(esc).join(',')).join('\r\n'));
});

// Grade one attempt (teacher view)
r.get('/exams/:id/attempts/:aid', requireLogin, (req, res) => {
  const exam = ownExam(req, res);
  const at = db.prepare('SELECT * FROM attempts WHERE id=? AND exam_id=?').get(req.params.aid, exam.id);
  if (!at) return res.status(404).render('error', { title: 'ไม่พบ', message: 'ไม่พบการสอบนี้' });
  const byId = Object.fromEntries(svc.getQuestions(exam.id).map(q => [q.id, q]));
  const ans = Object.fromEntries(db.prepare('SELECT * FROM answers WHERE attempt_id=?').all(at.id).map(x => [x.question_id, x]));
  const items = parseJSON(at.question_order, []).map(id => byId[id]).filter(Boolean).map(q => {
    const a = ans[q.id] || null;
    const resp = a ? parseJSON(a.response, null) : null;
    return { q, a, type: q.type, typeLabel: TYPES[q.type].label, resp, responseText: responseText(q, resp), correct: correctAnswerText(q), final: a ? finalScore(a) : null };
  });
  const sibs = db.prepare(`SELECT id FROM attempts WHERE exam_id=? AND status='submitted' ORDER BY submitted_at DESC, id DESC`).all(exam.id).map(x => x.id);
  const idx = sibs.indexOf(at.id);
  const job = db.prepare(`SELECT id,status FROM jobs WHERE type='grade_attempt' AND json_extract(input,'$.attempt_id')=? ORDER BY id DESC LIMIT 1`).get(at.id);
  res.render('attempt_grade', { title: 'ตรวจ: ' + at.taker_name, exam, attempt: at, items, prev: sibs[idx - 1], next: sibs[idx + 1], aiEnabled: ai.AI.enabled, job });
});

// Manual score (can be set on top of AI or auto result). manual_score=null → revert to AI/auto
r.post('/api/answers/:id/grade', requireLogin, (req, res) => {
  const a = db.prepare(`SELECT a.*, q.points, t.exam_id, e.owner_id FROM answers a JOIN questions q ON q.id=a.question_id
    JOIN attempts t ON t.id=a.attempt_id JOIN exams e ON e.id=t.exam_id WHERE a.id=?`).get(req.params.id);
  if (!a || (a.owner_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  let manual = b.manual_score === null || b.manual_score === '' || b.manual_score === undefined ? null : Number(b.manual_score);
  if (manual != null) { if (!isFinite(manual)) return res.status(400).json({ error: 'คะแนนไม่ถูกต้อง' }); manual = round2(Math.max(0, Math.min(a.points, manual))); }
  let status = a.status;
  if (manual != null || b.confirm) status = 'graded';
  else if (a.ai_score != null) status = 'ai';
  else if (a.auto_score != null) status = 'auto';
  else status = 'pending';
  db.prepare('UPDATE answers SET manual_score=?, comment=?, status=? WHERE id=?').run(manual, String(b.comment ?? a.comment ?? '').slice(0, 5000), status, a.id);
  recomputeAttempt(a.attempt_id);
  const at = db.prepare('SELECT score,max_score,pending_count FROM attempts WHERE id=?').get(a.attempt_id);
  const na = db.prepare('SELECT * FROM answers WHERE id=?').get(a.id);
  res.json({ ok: true, answer: { ...na, final: finalScore(na) }, attempt: at });
});

r.post('/api/attempts/:aid/ai-grade', requireLogin, (req, res) => {
  const at = db.prepare('SELECT t.*, e.owner_id FROM attempts t JOIN exams e ON e.id=t.exam_id WHERE t.id=?').get(req.params.aid);
  if (!at || (at.owner_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).json({ error: 'not found' });
  if (!ai.AI.enabled) return res.status(400).json({ error: 'AI ถูกปิดใช้งาน' });
  res.json({ job_id: ai.enqueue(req.user.id, 'grade_attempt', { attempt_id: at.id, regrade: !!(req.body || {}).regrade }) });
});

r.post('/api/exams/:id/ai-grade', requireLogin, (req, res) => {
  const e = ownExam(req, res);
  if (!ai.AI.enabled) return res.status(400).json({ error: 'AI ถูกปิดใช้งาน' });
  res.json({ job_id: ai.enqueue(req.user.id, 'grade_exam', { exam_id: e.id, only_pending: true }) });
});

r.post('/exams/:id/attempts/:aid/delete', requireLogin, (req, res) => {
  const e = ownExam(req, res);
  const files = db.prepare('SELECT id FROM files WHERE attempt_id=?').all(req.params.aid);
  const { deleteFile } = require('../storage');
  files.forEach(f => deleteFile(f.id));
  db.prepare('DELETE FROM attempts WHERE id=? AND exam_id=?').run(req.params.aid, e.id);
  res.redirect(`/exams/${e.id}/results`);
});

// Re-run auto grading (e.g. after fixing an answer key)
r.post('/exams/:id/regrade', requireLogin, (req, res) => {
  const e = ownExam(req, res);
  const { autoGrade } = require('../grading');
  const qs = Object.fromEntries(svc.getQuestions(e.id).map(q => [q.id, q]));
  db.transaction(() => {
    const ans = db.prepare(`SELECT a.* FROM answers a JOIN attempts t ON t.id=a.attempt_id WHERE t.exam_id=? AND t.status='submitted'`).all(e.id);
    for (const a of ans) {
      const q = qs[a.question_id]; if (!q) continue;
      const g = autoGrade(q, parseJSON(a.response, null));
      const status = a.status === 'graded' ? 'graded' : a.status === 'ai' && g.status === 'pending' ? 'ai' : g.status;
      db.prepare('UPDATE answers SET auto_score=?, status=? WHERE id=?').run(g.auto_score, status, a.id);
    }
    db.prepare(`SELECT id FROM attempts WHERE exam_id=? AND status='submitted'`).all(e.id).forEach(x => recomputeAttempt(x.id));
  })();
  res.redirect(`/exams/${e.id}/results?regraded=1`);
});

// ---------- Live monitor ----------
r.get('/exams/:id/live', requireLogin, (req, res) => {
  const exam = ownExam(req, res);
  res.render('exam_live', { title: 'ติดตามสด: ' + exam.title, exam, noAds: true });
});
r.get('/api/exams/:id/live', requireLogin, (req, res) => {
  const exam = ownExam(req, res);
  const rows = db.prepare(`SELECT t.id, t.taker_name, t.taker_ident, t.status, t.started_at, t.submitted_at, t.deadline_at, t.last_activity,
      t.tab_switches, t.score, t.max_score, t.pending_count, t.question_order,
      (SELECT COUNT(*) FROM answers a WHERE a.attempt_id=t.id AND a.response NOT IN ('null','""','[]','{}')) answered
    FROM attempts t WHERE t.exam_id=? AND (t.status='in_progress' OR t.submitted_at >= datetime('now','-3 hours'))
    ORDER BY t.status='in_progress' DESC, t.last_activity DESC LIMIT 300`).all(exam.id);
  const now = Date.now(); const toMs = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').getTime() : null;
  res.json({ now: new Date().toISOString(), is_open: !!exam.is_open, attempts: rows.map(t => ({
    id: t.id, name: t.taker_name, ident: t.taker_ident, status: t.status, answered: t.answered, total: parseJSON(t.question_order, []).length,
    tab: t.tab_switches, score: t.score, max: t.max_score, pending: t.pending_count,
    idle: t.last_activity ? Math.round((now - toMs(t.last_activity)) / 1000) : null,
    remaining: t.deadline_at && t.status === 'in_progress' ? Math.max(0, Math.round((toMs(t.deadline_at) - now) / 1000)) : null,
    elapsed: Math.round(((t.submitted_at ? toMs(t.submitted_at) : now) - toMs(t.started_at)) / 1000),
  })) });
});

// ---------- Print (paper exam / answer key) ----------
r.get('/exams/:id/print', requireLogin, (req, res) => {
  const exam = ownExam(req, res);
  const { parseBlanks } = require('../grading');
  const questions = svc.getQuestions(exam.id).map(q => ({ ...q, d: parseJSON(q.data, {}), correct: correctAnswerText(q) }));
  res.render('exam_print', { title: exam.title, exam, questions, key: req.query.key === '1', parseBlanks, TYPES });
});

module.exports = r;

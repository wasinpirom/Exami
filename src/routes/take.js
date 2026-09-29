// Students taking an exam via share link: /t/:token → /a/:attemptToken → /r/:attemptToken
const path = require('path');
const express = require('express');
const { db } = require('../db');
const { token, parseJSON, getSettings } = require('../util');
const { getExam, getQuestions } = require('../examService');
const { studentView, autoGrade, recomputeAttempt, shuffle, finalScore, correctAnswerText, responseText, TYPES } = require('../grading');
const { upload, registerFile, deleteFile } = require('../storage');
const ai = require('../ai');

const r = express.Router();
const now = () => new Date();
const toDate = (s) => s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z') : null;
const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const GRACE_MS = 60e3;

function windowState(e) {
  const s = e.settings;
  if (!e.is_open) return 'ผู้สร้างปิดรับคำตอบแล้ว';
  if (s.open_at && now() < new Date(s.open_at)) return 'ยังไม่ถึงเวลาเปิดสอบ (' + new Date(s.open_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) + ')';
  if (s.close_at && now() > new Date(s.close_at)) return 'หมดเวลาสอบแล้ว';
  return null;
}
function guestTokens(req) { return String(req.cookies.exami_atts || '').split('.').filter(Boolean).slice(-50); }
function myAttempts(req, examId) {
  if (req.user) return db.prepare('SELECT * FROM attempts WHERE exam_id=? AND user_id=? ORDER BY id DESC').all(examId, req.user.id);
  const toks = guestTokens(req); if (!toks.length) return [];
  return db.prepare(`SELECT * FROM attempts WHERE exam_id=? AND token IN (${toks.map(() => '?').join(',')}) ORDER BY id DESC`).all(examId, ...toks);
}

r.get('/t/:token', (req, res) => {
  const e = db.prepare('SELECT id FROM exams WHERE share_token=?').get(req.params.token);
  if (!e) return res.status(404).render('error', { title: 'ไม่พบแบบทดสอบ', message: 'ลิงก์แบบทดสอบไม่ถูกต้อง' });
  const exam = getExam(e.id);
  const qs = getQuestions(exam.id);
  const attempts = myAttempts(req, exam.id);
  res.render('take_start', {
    title: exam.title, exam, qCount: qs.length, maxScore: qs.reduce((s, q) => s + q.points, 0),
    closed: windowState(exam), attempts, error: req.query.err || null,
    isOwner: req.user && req.user.id === exam.owner_id,
  });
});

r.post('/t/:token/start', (req, res) => {
  const e = db.prepare('SELECT id FROM exams WHERE share_token=?').get(req.params.token);
  if (!e) return res.status(404).render('error', { title: 'ไม่พบแบบทดสอบ', message: 'ลิงก์ไม่ถูกต้อง' });
  const exam = getExam(e.id); const s = exam.settings;
  const back = (m) => res.redirect(`/t/${req.params.token}?err=${encodeURIComponent(m)}`);
  const closed = windowState(exam); if (closed) return back(closed);
  if (s.require_login && !req.user) return res.redirect('/login?next=' + encodeURIComponent('/t/' + req.params.token));
  if (s.access_code && String(req.body.access_code || '').trim() !== String(s.access_code).trim()) return back('รหัสเข้าสอบไม่ถูกต้อง');
  const name = String(req.body.name || (req.user && req.user.name) || '').trim().slice(0, 150);
  const ident = String(req.body.ident || '').trim().slice(0, 100);
  if (!name) return back('กรุณากรอกชื่อ-นามสกุล');
  if (s.collect_ident && !ident) return back(`กรุณากรอก${s.ident_label}`);

  // resume an unfinished attempt
  const mine = myAttempts(req, exam.id);
  const open = mine.find(a => a.status === 'in_progress');
  if (open) return res.redirect('/a/' + open.token);

  if (s.max_attempts > 0) {
    let used = mine.filter(a => a.status === 'submitted').length;
    if (!req.user && ident) used = Math.max(used, db.prepare(`SELECT COUNT(*) c FROM attempts WHERE exam_id=? AND taker_ident=? AND status='submitted'`).get(exam.id, ident).c);
    if (used >= s.max_attempts) return back(`คุณทำแบบทดสอบนี้ครบ ${s.max_attempts} ครั้งแล้ว`);
  }
  const qs = getQuestions(exam.id);
  if (!qs.length) return back('แบบทดสอบนี้ยังไม่มีคำถาม');
  const tok = token(16);
  let order = s.shuffle_questions ? shuffle(qs.map(q => q.id), tok) : qs.map(q => q.id);
  if (s.draw_count > 0 && s.draw_count < qs.length) {        // random draw from the question pool
    const picked = new Set(shuffle(qs.map(q => q.id), tok + ':draw').slice(0, s.draw_count));
    order = order.filter(id => picked.has(id));
  }
  const maxScore = qs.filter(q => order.includes(q.id)).reduce((a, q) => a + q.points, 0);
  const deadline = s.time_limit_min > 0 ? new Date(Date.now() + s.time_limit_min * 60e3) : null;
  if (deadline && s.close_at && new Date(s.close_at) < deadline) deadline.setTime(new Date(s.close_at).getTime());
  db.prepare(`INSERT INTO attempts(exam_id,user_id,taker_name,taker_ident,token,question_order,deadline_at,max_score,last_activity) VALUES(?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(exam.id, req.user ? req.user.id : null, name, ident, tok, JSON.stringify(order),
      deadline ? deadline.toISOString().slice(0, 19).replace('T', ' ') : null, maxScore);
  if (!req.user) {
    const toks = guestTokens(req).concat(tok).slice(-50);
    res.cookie('exami_atts', toks.join('.'), { httpOnly: true, sameSite: 'lax', maxAge: 365 * 864e5 });
  }
  res.redirect('/a/' + tok);
});

function loadAttempt(tok) {
  const a = db.prepare('SELECT * FROM attempts WHERE token=?').get(tok);
  if (!a) return null;
  a.exam = getExam(a.exam_id);
  return a;
}
const expired = (a) => a.deadline_at && now().getTime() > toDate(a.deadline_at).getTime() + GRACE_MS;

function saveResponses(a, answers) {
  const qids = new Set(parseJSON(a.question_order, []).map(Number));
  const up = db.prepare(`INSERT INTO answers(attempt_id,question_id,response) VALUES(?,?,?)
    ON CONFLICT(attempt_id,question_id) DO UPDATE SET response=excluded.response`);
  for (const [qid, resp] of Object.entries(answers || {})) {
    if (!qids.has(Number(qid))) continue;
    const q = db.prepare('SELECT type FROM questions WHERE id=?').get(qid);
    if (!q || q.type === 'file') {
      // file answers are set by upload endpoint; only the note can be changed here
      if (q && resp && typeof resp === 'object') {
        const cur = db.prepare('SELECT response FROM answers WHERE attempt_id=? AND question_id=?').get(a.id, qid);
        const c = parseJSON(cur && cur.response, null) || {};
        up.run(a.id, qid, JSON.stringify({ ...c, note: String(resp.note || '').slice(0, 5000) }));
      }
      continue;
    }
    up.run(a.id, qid, JSON.stringify(resp).slice(0, 100000));
  }
}

function submitAttempt(a) {
  db.transaction(() => {
    const qs = getQuestions(a.exam_id);
    const existing = Object.fromEntries(db.prepare('SELECT * FROM answers WHERE attempt_id=?').all(a.id).map(x => [x.question_id, x]));
    const order = new Set(parseJSON(a.question_order, []).map(Number));
    for (const q of qs) {
      if (!order.has(q.id)) continue;
      const ans = existing[q.id];
      const resp = ans ? parseJSON(ans.response, null) : null;
      const g = autoGrade(q, resp);
      if (ans) db.prepare('UPDATE answers SET auto_score=?, status=? WHERE id=?').run(g.auto_score, g.status, ans.id);
      else db.prepare('INSERT INTO answers(attempt_id,question_id,response,auto_score,status) VALUES(?,?,?,?,?)').run(a.id, q.id, 'null', g.auto_score, g.status);
    }
    db.prepare(`UPDATE attempts SET status='submitted', submitted_at=? WHERE id=?`).run(sqlNow(), a.id);
    recomputeAttempt(a.id);
  })();
  const after = db.prepare('SELECT pending_count FROM attempts WHERE id=?').get(a.id);
  if (a.exam.settings.ai_auto_grade && after.pending_count > 0 && ai.AI.enabled) ai.enqueue(a.exam.owner_id, 'grade_attempt', { attempt_id: a.id });
}

r.get('/a/:token', (req, res) => {
  const a = loadAttempt(req.params.token);
  if (!a) return res.status(404).render('error', { title: 'ไม่พบการสอบ', message: 'ลิงก์ไม่ถูกต้อง' });
  if (a.status === 'submitted') return res.redirect('/r/' + a.token);
  if (expired(a)) { submitAttempt(a); return res.redirect('/r/' + a.token); }
  const byId = Object.fromEntries(getQuestions(a.exam_id).map(q => [q.id, q]));
  const questions = parseJSON(a.question_order, []).map(id => byId[id]).filter(Boolean)
    .map(q => studentView(q, { shuffleOptions: a.exam.settings.shuffle_options, seed: a.token }));
  const saved = Object.fromEntries(db.prepare('SELECT question_id, response FROM answers WHERE attempt_id=?').all(a.id).map(x => [x.question_id, parseJSON(x.response, null)]));
  const remaining = a.deadline_at ? Math.max(0, Math.floor((toDate(a.deadline_at) - now()) / 1000)) : null;
  res.render('take', { title: a.exam.title, attempt: a, exam: a.exam, questions, saved, remaining, maxUpload: getSettings().max_upload_mb });
});

r.post('/api/a/:token/save', (req, res) => {
  const a = loadAttempt(req.params.token);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.status === 'submitted') return res.status(409).json({ error: 'ส่งคำตอบไปแล้ว', redirect: '/r/' + a.token });
  if (expired(a)) { submitAttempt(a); return res.status(409).json({ error: 'หมดเวลา', redirect: '/r/' + a.token }); }
  saveResponses(a, req.body.answers);
  db.prepare(`UPDATE attempts SET last_activity=datetime('now') WHERE id=?`).run(a.id);
  res.json({ ok: true, saved_at: new Date().toISOString() });
});

r.post('/api/a/:token/event', (req, res) => {
  db.prepare(`UPDATE attempts SET tab_switches=tab_switches+1, last_activity=datetime('now') WHERE token=? AND status='in_progress'`).run(req.params.token);
  res.json({ ok: true });
});

r.post('/api/a/:token/upload/:qid', (req, res, next) => {
  const a = loadAttempt(req.params.token);
  if (!a || a.status !== 'in_progress' || expired(a)) return res.status(409).json({ error: 'ไม่สามารถอัปโหลดได้' });
  const q = db.prepare(`SELECT * FROM questions WHERE id=? AND exam_id=? AND type='file'`).get(req.params.qid, a.exam_id);
  if (!q) return res.status(400).json({ error: 'คำถามไม่ถูกต้อง' });
  upload().single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์' });
    const accept = String(parseJSON(q.data, {}).accept || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (accept.length && !accept.includes(ext)) {
      require('fs').unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'ประเภทไฟล์ไม่ถูกต้อง อนุญาต: ' + accept.join(', ') });
    }
    try {
      const f = registerFile({ file: req.file, ownerId: a.exam.owner_id, kind: 'answer_file', attemptId: a.id });
      const cur = db.prepare('SELECT response FROM answers WHERE attempt_id=? AND question_id=?').get(a.id, q.id);
      const old = parseJSON(cur && cur.response, null);
      if (old && old.file_id) deleteFile(old.file_id);
      const resp = { file_id: f.id, name: f.orig_name, size: f.size, note: (old && old.note) || '' };
      db.prepare(`INSERT INTO answers(attempt_id,question_id,response) VALUES(?,?,?) ON CONFLICT(attempt_id,question_id) DO UPDATE SET response=excluded.response`)
        .run(a.id, q.id, JSON.stringify(resp));
      res.json({ ok: true, ...resp });
    } catch (e) { next(e); }
  });
});

r.post('/api/a/:token/submit', (req, res) => {
  const a = loadAttempt(req.params.token);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.status !== 'submitted') {
    if (!expired(a)) saveResponses(a, req.body.answers);
    submitAttempt(a);
  }
  res.json({ ok: true, redirect: '/r/' + a.token });
});

// ---------- Result page (student) ----------
r.get('/r/:token', (req, res) => {
  const a = loadAttempt(req.params.token);
  if (!a) return res.status(404).render('error', { title: 'ไม่พบผลสอบ', message: 'ลิงก์ไม่ถูกต้อง' });
  if (a.status !== 'submitted') return res.redirect('/a/' + a.token);
  const s = a.exam.settings;
  const closedNow = !a.exam.is_open || (s.close_at && now() > new Date(s.close_at));
  const showAnswers = s.show_answers === 'after_submit' || (s.show_answers === 'after_close' && closedNow);
  const isOwner = req.user && req.user.id === a.exam.owner_id;
  const byId = Object.fromEntries(getQuestions(a.exam_id).map(q => [q.id, q]));
  const ans = Object.fromEntries(db.prepare('SELECT * FROM answers WHERE attempt_id=?').all(a.id).map(x => [x.question_id, x]));
  const items = parseJSON(a.question_order, []).map(id => byId[id]).filter(Boolean).map(q => {
    const an = ans[q.id] || {};
    const resp = parseJSON(an.response, null);
    return {
      q, type: TYPES[q.type].label, status: an.status || 'auto',
      score: an.status === 'pending' ? null : finalScore(an),
      response: responseText(q, resp), resp,
      correct: showAnswers ? correctAnswerText(q) : null,
      explanation: showAnswers ? q.explanation : null,
      feedback: [an.comment, an.manual_score == null ? an.ai_feedback : null].filter(Boolean).join('\n'),
      aiGraded: an.status === 'ai',
    };
  });
  const aiRunning = db.prepare(`SELECT 1 FROM jobs WHERE type='grade_attempt' AND status IN ('queued','running') AND json_extract(input,'$.attempt_id')=?`).get(a.id);
  const pct = a.max_score ? a.score / a.max_score * 100 : 0;
  const passed = !a.pending_count && pct >= s.pass_percent;
  let leaderboard = null;
  if (s.leaderboard && (s.show_score || isOwner)) {
    leaderboard = db.prepare(`SELECT taker_name, MAX(score) score, MAX(max_score) max_score, MIN(submitted_at) at, MAX(token=?) me
      FROM attempts WHERE exam_id=? AND status='submitted' GROUP BY lower(taker_name), taker_ident ORDER BY score DESC, at ASC LIMIT 10`).all(a.token, a.exam_id);
  }
  res.render('result', { title: 'ผลสอบ: ' + a.exam.title, attempt: a, exam: a.exam, items, showScore: s.show_score || isOwner, showAnswers: showAnswers || isOwner,
    aiRunning: !!aiRunning, pct: Math.round(pct), passed, leaderboard, certificate: s.certificate && passed && (s.show_score || isOwner) });
});

// Printable certificate (exam passed)
r.get('/r/:token/certificate', (req, res) => {
  const a = loadAttempt(req.params.token);
  if (!a || a.status !== 'submitted') return res.status(404).render('error', { title: 'ไม่พบ', message: '' });
  const s = a.exam.settings; const pct = a.max_score ? a.score / a.max_score * 100 : 0;
  if (!s.certificate || a.pending_count || pct < s.pass_percent) return res.status(403).render('error', { title: 'ยังไม่ได้รับเกียรติบัตร', message: 'ต้องสอบผ่านเกณฑ์และตรวจครบทุกข้อก่อน' });
  const owner = db.prepare('SELECT name FROM users WHERE id=?').get(a.exam.owner_id);
  res.render('certificate', { title: 'เกียรติบัตร', name: a.taker_name, what: a.exam.title, kind: 'ผ่านการทดสอบ',
    detail: `ด้วยคะแนน ${a.score} / ${a.max_score} (${Math.round(pct)}%)`, date: a.submitted_at, issuer: owner && owner.name, code: 'EX-' + a.token.slice(0, 8).toUpperCase(),
    verifyUrl: '/r/' + a.token });
});

module.exports = r;

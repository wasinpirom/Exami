const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { token, parseJSON } = require('./util');
const { TYPES } = require('./grading');
const { UPLOAD_DIR, usage } = require('./storage');

const DEFAULT_SETTINGS = {
  time_limit_min: 0,          // 0 = no limit
  max_attempts: 1,            // 0 = unlimited
  require_login: false,
  collect_ident: true,        // ask for student ID
  ident_label: 'รหัสนักศึกษา / เลขที่',
  access_code: '',            // optional password to start
  shuffle_questions: false,
  shuffle_options: false,
  show_score: true,           // show score right after submit
  show_answers: 'after_submit', // never | after_submit | after_close
  ai_auto_grade: false,       // run AI grading on subjective answers right after submit
  pass_percent: 50,
  open_at: '',
  close_at: '',
  one_per_page: false,
  draw_count: 0,              // random N questions per student from the pool (0 = all)
  certificate: false,         // printable certificate when passed
  leaderboard: false,         // show top 10 on result page
};

const newShareToken = () => token(8);

function createExam(ownerId, { title, description = '' }) {
  const r = db.prepare('INSERT INTO exams(owner_id,title,description,settings,share_token) VALUES(?,?,?,?,?)')
    .run(ownerId, title || 'แบบทดสอบใหม่', description, JSON.stringify(DEFAULT_SETTINGS), newShareToken());
  return r.lastInsertRowid;
}

function getExam(id) {
  const e = db.prepare('SELECT * FROM exams WHERE id=?').get(id);
  if (!e) return null;
  e.settings = { ...DEFAULT_SETTINGS, ...parseJSON(e.settings, {}) };
  return e;
}
function getQuestions(examId) {
  return db.prepare('SELECT * FROM questions WHERE exam_id=? ORDER BY position, id').all(examId);
}

function sanitizeQuestion(q) {
  const type = TYPES[q.type] ? q.type : 'single';
  const d = q.data && typeof q.data === 'object' ? q.data : {};
  return {
    id: q.id ? Number(q.id) : null,
    type,
    prompt: String(q.prompt || '').slice(0, 20000),
    points: Math.max(0, Math.min(1000, Number(q.points) || 0)),
    image_file_id: q.image_file_id ? Number(q.image_file_id) : null,
    explanation: String(q.explanation || '').slice(0, 10000),
    data: JSON.stringify(d).slice(0, 200000),
  };
}

// Replace exam content with the builder's payload (upsert questions, delete removed)
const saveExam = db.transaction((examId, ownerId, payload) => {
  const cur = getExam(examId);
  const settings = { ...cur.settings, ...(payload.settings || {}) };
  settings.time_limit_min = Math.max(0, parseInt(settings.time_limit_min) || 0);
  settings.max_attempts = Math.max(0, parseInt(settings.max_attempts) || 0);
  settings.pass_percent = Math.max(0, Math.min(100, Number(settings.pass_percent) || 0));
  settings.draw_count = Math.max(0, parseInt(settings.draw_count) || 0);
  db.prepare(`UPDATE exams SET title=?, description=?, settings=?, is_open=?, in_library=?, category=?, updated_at=datetime('now') WHERE id=?`)
    .run(String(payload.title || 'ไม่มีชื่อ').slice(0, 300), String(payload.description || '').slice(0, 20000), JSON.stringify(settings),
      payload.is_open ? 1 : 0, payload.in_library ? 1 : 0, String(payload.category || '').slice(0, 100), examId);

  const keep = [];
  const ownImage = (fid) => fid && db.prepare(`SELECT 1 FROM files WHERE id=? AND owner_id=? AND kind='question_image'`).get(fid, ownerId) ? fid : null;
  (payload.questions || []).forEach((raw, i) => {
    const q = sanitizeQuestion(raw);
    q.image_file_id = ownImage(q.image_file_id);
    const existing = q.id && db.prepare('SELECT id FROM questions WHERE id=? AND exam_id=?').get(q.id, examId);
    if (existing) {
      db.prepare('UPDATE questions SET position=?, type=?, prompt=?, points=?, image_file_id=?, explanation=?, data=? WHERE id=?')
        .run(i, q.type, q.prompt, q.points, q.image_file_id, q.explanation, q.data, q.id);
      keep.push(q.id);
    } else {
      const r = db.prepare('INSERT INTO questions(exam_id,position,type,prompt,points,image_file_id,explanation,data) VALUES(?,?,?,?,?,?,?,?)')
        .run(examId, i, q.type, q.prompt, q.points, q.image_file_id, q.explanation, q.data);
      keep.push(r.lastInsertRowid);
    }
  });
  const ids = keep.length ? keep.join(',') : '0';
  db.prepare(`DELETE FROM questions WHERE exam_id=? AND id NOT IN (${ids})`).run(examId);
  // update max score of existing attempts
  const { attemptMax } = require('./grading');
  const upd = db.prepare('UPDATE attempts SET max_score=? WHERE id=?');
  for (const a of db.prepare('SELECT id FROM attempts WHERE exam_id=?').all(examId)) upd.run(attemptMax(a.id), a.id);
});

// Deep-copy an exam into another user's space (copies question images, charged to new owner)
function copyExam(examId, newOwnerId, { asLibraryCopy = true } = {}) {
  const src = getExam(examId);
  const owner = db.prepare('SELECT name FROM users WHERE id=?').get(src.owner_id);
  const qs = getQuestions(examId);
  // quota check for images
  const imgIds = qs.map(q => q.image_file_id).filter(Boolean);
  const imgs = imgIds.length ? db.prepare(`SELECT * FROM files WHERE id IN (${imgIds.join(',')})`).all() : [];
  const need = imgs.reduce((s, f) => s + f.size, 0);
  const u = usage(newOwnerId);
  if (need && u.used + need > u.quota) {
    const e = new Error('พื้นที่ไม่พอสำหรับคัดลอกรูปภาพในข้อสอบนี้'); e.status = 413; throw e;
  }
  return db.transaction(() => {
    const settings = { ...src.settings, access_code: '' };
    const r = db.prepare(`INSERT INTO exams(owner_id,title,description,settings,share_token,category,source_exam_id,source_owner_name,is_open)
      VALUES(?,?,?,?,?,?,?,?,0)`).run(newOwnerId, asLibraryCopy ? src.title : src.title + ' (สำเนา)', src.description, JSON.stringify(settings),
      newShareToken(), src.category, src.id, owner && src.owner_id !== newOwnerId ? owner.name : null);   // credit only when copied from someone else
    const newId = r.lastInsertRowid;
    const imgMap = {};
    for (const f of imgs) {
      const newName = Date.now() + '-' + token(12) + path.extname(f.stored_name);
      try { fs.copyFileSync(path.join(UPLOAD_DIR, f.stored_name), path.join(UPLOAD_DIR, newName)); } catch { continue; }
      const fr = db.prepare(`INSERT INTO files(owner_id,kind,orig_name,mime,size,stored_name) VALUES(?,?,?,?,?,?)`)
        .run(newOwnerId, 'question_image', f.orig_name, f.mime, f.size, newName);
      imgMap[f.id] = fr.lastInsertRowid;
    }
    const ins = db.prepare('INSERT INTO questions(exam_id,position,type,prompt,points,image_file_id,explanation,data) VALUES(?,?,?,?,?,?,?,?)');
    for (const q of qs) ins.run(newId, q.position, q.type, q.prompt, q.points, q.image_file_id ? (imgMap[q.image_file_id] || null) : null, q.explanation, q.data);
    if (asLibraryCopy) db.prepare('UPDATE exams SET copy_count=copy_count+1 WHERE id=?').run(src.id);
    return newId;
  })();
}

function deleteExam(examId) {
  // question images + answer files of this exam
  const fileIds = db.prepare(`SELECT id FROM files WHERE id IN (SELECT image_file_id FROM questions WHERE exam_id=?)
     OR attempt_id IN (SELECT id FROM attempts WHERE exam_id=?)`).all(examId, examId).map(r => r.id);
  const { deleteFile } = require('./storage');
  fileIds.forEach(deleteFile);
  db.prepare('DELETE FROM exams WHERE id=?').run(examId);
}

function examStats(examId) {
  return db.prepare(`SELECT COUNT(*) n, SUM(status='submitted') submitted, SUM(pending_count>0 AND status='submitted') pending,
    AVG(CASE WHEN status='submitted' THEN score END) avg FROM attempts WHERE exam_id=?`).get(examId);
}

module.exports = { DEFAULT_SETTINGS, createExam, getExam, getQuestions, saveExam, copyExam, deleteExam, examStats };

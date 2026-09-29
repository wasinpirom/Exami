// Question types, auto-grading, and student-safe views of questions
const { db } = require('./db');
const { parseJSON, round2 } = require('./util');

const TYPES = {
  single:    { label: 'ตัวเลือก (ตอบได้ข้อเดียว)', auto: true },
  multiple:  { label: 'ตัวเลือก (ตอบได้หลายข้อ)', auto: true },
  truefalse: { label: 'ถูก / ผิด', auto: true },
  matching:  { label: 'จับคู่', auto: true },
  ordering:  { label: 'เรียงลำดับ', auto: true },
  short:     { label: 'เติมคำตอบสั้น', auto: true },
  fillblank: { label: 'เติมคำในช่องว่าง', auto: true },
  essay:     { label: 'อธิบาย / เขียนตอบยาว', auto: false },
  link:      { label: 'แนบลิงก์คำตอบ (YouTube / URL)', auto: false },
  file:      { label: 'แนบไฟล์คำตอบ', auto: false },
};

const norm = (s, cs) => { s = String(s ?? '').trim().replace(/\s+/g, ' '); return cs ? s : s.toLowerCase(); };

// "เมืองหลวงของไทยคือ {{กรุงเทพ|กรุงเทพมหานคร}}" -> parts & blanks
function parseBlanks(text) {
  const parts = []; const blanks = [];
  const re = /\{\{(.*?)\}\}/g; let last = 0, m;
  while ((m = re.exec(text || ''))) {
    parts.push(text.slice(last, m.index));
    blanks.push(m[1].split('|').map(x => x.trim()).filter(Boolean));
    last = re.lastIndex;
  }
  parts.push((text || '').slice(last));
  return { parts, blanks };
}

const isEmpty = (type, r) => {
  if (r == null || r === '') return true;
  if (type === 'essay' || type === 'short') return !String(r).trim();
  if (type === 'link') return !(r && String(r.url || '').trim());
  if (type === 'file') return !(r && r.file_id);
  if (Array.isArray(r)) return r.length === 0 || r.every(x => x == null || x === '');
  if (typeof r === 'object') return Object.keys(r).length === 0;
  return false;
};

// returns { auto_score, status } — status 'auto' (final) or 'pending' (needs teacher/AI)
function autoGrade(q, response) {
  const d = parseJSON(q.data, {}); const P = Number(q.points) || 0;
  if (isEmpty(q.type, response)) return { auto_score: 0, status: 'auto' };
  switch (q.type) {
    case 'single': {
      const ok = (d.correct || []).map(String).includes(String(response));
      return { auto_score: ok ? P : 0, status: 'auto' };
    }
    case 'multiple': {
      const correct = new Set((d.correct || []).map(String));
      const chosen = new Set((Array.isArray(response) ? response : []).map(String));
      if (!correct.size) return { auto_score: 0, status: 'pending' };
      if (d.partial === false) {
        const exact = correct.size === chosen.size && [...correct].every(x => chosen.has(x));
        return { auto_score: exact ? P : 0, status: 'auto' };
      }
      let good = 0, bad = 0;
      chosen.forEach(x => correct.has(x) ? good++ : bad++);
      return { auto_score: round2(P * Math.max(0, (good - bad) / correct.size)), status: 'auto' };
    }
    case 'truefalse':
      return { auto_score: String(response) === String(!!d.correct) ? P : 0, status: 'auto' };
    case 'matching': {
      const pairs = d.pairs || []; if (!pairs.length) return { auto_score: 0, status: 'auto' };
      const r = response || {}; let good = 0;
      pairs.forEach(p => { if (norm(r[p.id]) === norm(p.right)) good++; });
      return { auto_score: round2(P * good / pairs.length), status: 'auto' };
    }
    case 'ordering': {
      const items = d.items || []; if (!items.length) return { auto_score: 0, status: 'auto' };
      const r = Array.isArray(response) ? response.map(String) : []; let good = 0;
      items.forEach((it, i) => { if (r[i] === String(it.id)) good++; });
      return { auto_score: round2(P * good / items.length), status: 'auto' };
    }
    case 'short': {
      const acc = (d.accepted || []).filter(x => String(x).trim());
      if (!acc.length) return { auto_score: null, status: 'pending' };
      const ok = acc.some(a => norm(a, d.case_sensitive) === norm(response, d.case_sensitive));
      return { auto_score: ok ? P : 0, status: 'auto' };
    }
    case 'fillblank': {
      const { blanks } = parseBlanks(d.text || '');
      if (!blanks.length) return { auto_score: 0, status: 'auto' };
      const r = Array.isArray(response) ? response : []; let good = 0;
      blanks.forEach((acc, i) => { if (acc.some(a => norm(a, d.case_sensitive) === norm(r[i], d.case_sensitive))) good++; });
      return { auto_score: round2(P * good / blanks.length), status: 'auto' };
    }
    default:
      return { auto_score: null, status: 'pending' }; // essay / link / file
  }
}

// full score of an attempt = sum of points of the questions it actually got (supports random draw)
function attemptMax(attemptId) {
  const att = db.prepare('SELECT exam_id, question_order FROM attempts WHERE id=?').get(attemptId);
  const ids = new Set(parseJSON(att.question_order, []).map(Number));
  return db.prepare('SELECT id, points FROM questions WHERE exam_id=?').all(att.exam_id).filter(q => ids.has(q.id)).reduce((s, q) => s + q.points, 0);
}

const finalScore = (a) => a.manual_score != null ? a.manual_score : a.ai_score != null ? a.ai_score : a.auto_score;

function recomputeAttempt(attemptId) {
  const rows = db.prepare(`SELECT a.*, q.points FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.attempt_id=?`).all(attemptId);
  let score = 0, pending = 0;
  for (const a of rows) {
    if (a.status === 'pending') pending++;
    else score += Number(finalScore(a)) || 0;
  }
  const max = attemptMax(attemptId);
  db.prepare('UPDATE attempts SET score=?, max_score=?, pending_count=? WHERE id=?').run(round2(score), max, pending, attemptId);
}

function shuffle(arr, seed) {
  // deterministic shuffle per attempt (so reloads keep order)
  const a = arr.slice(); let s = 0;
  for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// What the student is allowed to see while taking the exam (no answers!)
function studentView(q, { shuffleOptions, seed }) {
  const d = parseJSON(q.data, {});
  const v = { id: q.id, type: q.type, prompt: q.prompt, points: q.points, image: q.image_file_id ? `/files/${q.image_file_id}` : null };
  const sh = (arr) => shuffleOptions ? shuffle(arr, seed + ':' + q.id) : arr;
  switch (q.type) {
    case 'single': case 'multiple':
      v.options = sh((d.options || []).map(o => ({ id: o.id, text: o.text }))); break;
    case 'matching':
      v.lefts = (d.pairs || []).map(p => ({ id: p.id, text: p.left }));
      v.rights = shuffle([...new Set([...(d.pairs || []).map(p => p.right), ...(d.distractors || [])].filter(Boolean))], seed + ':r' + q.id);
      break;
    case 'ordering':
      v.items = shuffle((d.items || []).map(i => ({ id: i.id, text: i.text })), seed + ':o' + q.id); break;
    case 'fillblank': {
      const { parts, blanks } = parseBlanks(d.text || '');
      v.parts = parts; v.blankCount = blanks.length; break;
    }
    case 'essay': v.min_words = d.min_words || 0; break;
    case 'link': v.youtube_only = !!d.youtube_only; break;
    case 'file': v.accept = d.accept || ''; break;
  }
  return v;
}

// Human-readable correct answer (for results page when allowed)
function correctAnswerText(q) {
  const d = parseJSON(q.data, {});
  const opt = (id) => (d.options || []).find(o => String(o.id) === String(id))?.text ?? id;
  switch (q.type) {
    case 'single': case 'multiple': return (d.correct || []).map(opt).join(', ');
    case 'truefalse': return d.correct ? 'ถูก' : 'ผิด';
    case 'matching': return (d.pairs || []).map(p => `${p.left} → ${p.right}`).join(' | ');
    case 'ordering': return (d.items || []).map(i => i.text).join(' → ');
    case 'short': return (d.accepted || []).join(' / ');
    case 'fillblank': return parseBlanks(d.text || '').blanks.map((b, i) => `(${i + 1}) ${b.join(' / ')}`).join('  ');
    case 'essay': return d.sample_answer || '';
    default: return '';
  }
}

function responseText(q, r) {
  const d = parseJSON(q.data, {});
  if (r == null || r === '') return '';
  const opt = (id) => (d.options || []).find(o => String(o.id) === String(id))?.text ?? id;
  switch (q.type) {
    case 'single': return opt(r);
    case 'multiple': return (Array.isArray(r) ? r : []).map(opt).join(', ');
    case 'truefalse': return String(r) === 'true' ? 'ถูก' : 'ผิด';
    case 'matching': return (d.pairs || []).map(p => `${p.left} → ${(r || {})[p.id] || '-'}`).join(' | ');
    case 'ordering': return (Array.isArray(r) ? r : []).map(id => (d.items || []).find(i => String(i.id) === String(id))?.text ?? id).join(' → ');
    case 'fillblank': return (Array.isArray(r) ? r : []).map((x, i) => `(${i + 1}) ${x || '-'}`).join('  ');
    case 'link': return (r.url || '') + (r.note ? `\n${r.note}` : '');
    case 'file': return (r.name || '') + (r.note ? `\n${r.note}` : '');
    default: return String(r);
  }
}

module.exports = { attemptMax, TYPES, autoGrade, finalScore, recomputeAttempt, studentView, correctAnswerText, responseText, parseBlanks, shuffle };

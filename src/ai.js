// Open-source AI via any OpenAI-compatible endpoint (default: Ollama built into the same container — free, self-hosted)
const { db } = require('./db');
const { parseJSON, token, round2, getSettings } = require('./util');
const { recomputeAttempt, responseText, correctAnswerText } = require('./grading');

// Every AI option is editable in /admin/settings (stored in DB); env vars are only first-run defaults
const AI = {
  envModel: process.env.AI_MODEL || 'qwen3:4b',
  get baseUrl() { return String(getSettings().ai_base_url || 'http://127.0.0.1:11434/v1').trim().replace(/\/+$/, ''); },
  get apiKey() { return getSettings().ai_api_key || 'ollama'; },
  get model() { return getSettings().ai_model || this.envModel; },       // chosen in /admin/ai
  get enabled() { return getSettings().ai_enabled !== '0'; },
  get timeoutMs() { return Math.max(30, Number(getSettings().ai_timeout_sec) || 300) * 1000; },
};

async function chat(messages, { json = true, temperature = 0.4, model } = {}) {
  model = model || AI.model;
  // Qwen3-style "thinking" models: ask for a direct answer (faster, cleaner JSON)
  if (/qwen3/i.test(model) && messages.length) messages = messages.map((m, i) => i === messages.length - 1 ? { ...m, content: m.content + ' /no_think' } : m);
  if (!AI.enabled) throw new Error('AI ถูกปิดใช้งานบนเซิร์ฟเวอร์นี้');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), AI.timeoutMs);
  try {
    const body = { model, messages, temperature, stream: false };
    if (json) body.response_format = { type: 'json_object' };
    const r = await fetch(AI.baseUrl + '/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI.apiKey },
      body: JSON.stringify(body),
    });
    if (r.status === 404) throw new Error(`ยังไม่พบโมเดล ${model} บน AI server (ครั้งแรกระบบกำลังดาวน์โหลดโมเดล ลองใหม่อีกสักครู่)`);
    if (!r.ok) throw new Error(`AI server ตอบกลับ ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return String(j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI ใช้เวลานานเกินไป (timeout)');
    if (e.message === 'fetch failed' || (e.cause && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(String(e.cause.code)))) throw new Error('เชื่อมต่อ AI server ไม่ได้ — ตรวจสอบว่า Ollama ทำงานอยู่ (หลัง deploy ครั้งแรกอาจต้องรอสักครู่)');
    throw e;
  } finally { clearTimeout(t); }
}

function extractJSON(text) {
  const direct = parseJSON(text, null); if (direct) return direct;
  const m = String(text).match(/```(?:json)?\s*([\s\S]*?)```/); if (m) { const j = parseJSON(m[1], null); if (j) return j; }
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s >= 0 && e > s) { const j = parseJSON(text.slice(s, e + 1), null); if (j) return j; }
  throw new Error('AI ตอบกลับในรูปแบบที่อ่านไม่ได้ ลองใหม่อีกครั้ง');
}

async function status() {
  if (!AI.enabled) return { ok: false, model: AI.model, message: 'ปิดใช้งานอยู่ (เปิดได้ที่ ผู้ดูแล → ตั้งค่าเว็บไซต์)' };
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(AI.baseUrl + '/models', { headers: { Authorization: 'Bearer ' + AI.apiKey }, signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    const ids = (j.data || []).map(m => m.id);
    const has = ids.some(id => id === AI.model || id.split(':')[0] === AI.model.split(':')[0] && (id.endsWith(':latest') || !AI.model.includes(':')));
    return { ok: r.ok && (has || ids.includes(AI.model)), model: AI.model, models: ids, message: has ? 'พร้อมใช้งาน' : `ยังไม่พบโมเดล ${AI.model} (กำลังดาวน์โหลด?)` };
  } catch (e) { return { ok: false, model: AI.model, message: 'เชื่อมต่อไม่ได้: ' + e.message }; }
}

// ---------------- Question generation ----------------
const TYPE_SPEC = {
  single: '{"type":"single","prompt":"...","options":["A","B","C","D"],"correct_index":0}',
  multiple: '{"type":"multiple","prompt":"...","options":["A","B","C","D"],"correct_indices":[0,2]}',
  truefalse: '{"type":"truefalse","prompt":"statement...","correct":true}',
  matching: '{"type":"matching","prompt":"จับคู่ต่อไปนี้","pairs":[{"left":"...","right":"..."}]}',
  ordering: '{"type":"ordering","prompt":"เรียงลำดับ...","items":["first","second","third"]}',
  short: '{"type":"short","prompt":"...","accepted":["answer","alternative"]}',
  fillblank: '{"type":"fillblank","prompt":"เติมคำในช่องว่าง","text":"sentence with {{answer}} in double braces"}',
  essay: '{"type":"essay","prompt":"...","rubric":"criteria for full marks","sample_answer":"..."}',
};

async function generateQuestions(input, opts = {}) {
  const convert = input.mode === 'convert';
  const count = Math.min(Math.max(parseInt(input.count) || 5, 1), convert ? 100 : 30);
  const types = convert ? Object.keys(TYPE_SPEC) : (input.types || ['single']).filter(t => TYPE_SPEC[t]);
  if (!types.length) types.push('single');
  const lang = input.language === 'en' ? 'English' : 'Thai (ภาษาไทย)';
  const sys = `You are an expert teacher who writes high-quality exam questions. Always reply with ONE JSON object only: {"questions":[...]}. Each question must follow exactly one of these formats:\n${types.map(t => TYPE_SPEC[t]).join('\n')}\nEvery question may also include "explanation" (why the answer is correct). ${convert ? 'Keep the original language and wording.' : `Write all question text in ${lang}. Facts must be accurate.`}`;
  const user = convert ? [
    'Convert the following existing exam (copied from Word/PDF) into the JSON format. Do NOT invent new questions and keep the original wording.',
    'Detect the correct answers from answer keys, marks like * or (✓), or "ตอบ/เฉลย/Answer" lines. If a question has no answer key, pick the most correct answer yourself.',
    'Choose the best matching type for each question (multiple-choice → single or multiple, true/false → truefalse, blank lines → fillblank, open questions → essay).',
    `Exam text:\n"""\n${String(input.source_text).slice(0, 20000)}\n"""`,
  ].join('\n') : [
    `Create exactly ${count} questions. Use a mix of these types: ${types.join(', ')}.`,
    `Difficulty: ${input.difficulty || 'medium'}.`,
    input.topic ? `Topic: ${input.topic}` : '',
    input.source_text ? `Base the questions ONLY on this material:\n"""\n${String(input.source_text).slice(0, 12000)}\n"""` : '',
  ].filter(Boolean).join('\n');
  const out = extractJSON(await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: convert ? 0.1 : 0.6, model: opts.model }));
  const list = Array.isArray(out) ? out : (out.questions || []);
  const pts = Number(input.points) || 1;
  return list.map(q => normalizeGenerated(q, pts)).filter(Boolean).slice(0, count);
}

// Try a model with a small real task (admin "ทดสอบโมเดล")
async function testModel(model) {
  const t0 = Date.now();
  const questions = await generateQuestions({ topic: 'ระบบสุริยะ (Solar system) สำหรับนักเรียนมัธยม', count: 2, types: ['single', 'truefalse'], language: 'th' }, { model });
  return { model, ms: Date.now() - t0, questions };
}

function normalizeGenerated(q, pts) {
  if (!q || !q.type || !q.prompt && !q.text) return null;
  const base = { type: q.type, prompt: String(q.prompt || ''), points: pts, explanation: String(q.explanation || ''), data: {} };
  const opts = (arr) => (arr || []).map(x => ({ id: token(6), text: String(typeof x === 'object' ? (x.text ?? '') : x) }));
  switch (q.type) {
    case 'single': {
      const o = opts(q.options); if (o.length < 2) return null;
      const ci = Number.isInteger(q.correct_index) ? q.correct_index : 0;
      base.data = { options: o, correct: [o[Math.min(ci, o.length - 1)].id] }; break;
    }
    case 'multiple': {
      const o = opts(q.options); if (o.length < 2) return null;
      const ci = (q.correct_indices || []).filter(i => o[i]);
      base.data = { options: o, correct: ci.map(i => o[i].id), partial: true }; break;
    }
    case 'truefalse': base.data = { correct: q.correct === true || String(q.correct).toLowerCase() === 'true' }; break;
    case 'matching': base.data = { pairs: (q.pairs || []).map(p => ({ id: token(6), left: String(p.left || ''), right: String(p.right || '') })).filter(p => p.left && p.right), distractors: [] };
      if (!base.data.pairs.length) return null; break;
    case 'ordering': base.data = { items: (q.items || []).map(x => ({ id: token(6), text: String(x) })) }; if (base.data.items.length < 2) return null; break;
    case 'short': base.data = { accepted: (q.accepted || [q.answer]).filter(Boolean).map(String), case_sensitive: false }; break;
    case 'fillblank': if (!/\{\{.+?\}\}/.test(q.text || '')) return null; base.data = { text: String(q.text), case_sensitive: false };
      if (!base.prompt) base.prompt = 'เติมคำในช่องว่าง'; break;
    case 'essay': base.data = { rubric: String(q.rubric || ''), sample_answer: String(q.sample_answer || ''), min_words: 0 }; base.points = Math.max(pts, 5); break;
    default: return null;
  }
  return base;
}

// ---------------- AI grading ----------------
async function gradeAnswer(answerId) {
  const a = db.prepare(`SELECT a.*, q.type, q.prompt, q.points, q.data qdata FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.id=?`).get(answerId);
  if (!a) return;
  const q = { type: a.type, data: a.qdata, prompt: a.prompt };
  const d = parseJSON(a.qdata, {});
  const resp = responseText(q, parseJSON(a.response, null));
  if (!resp.trim()) {
    db.prepare(`UPDATE answers SET ai_score=0, ai_feedback=?, status=CASE WHEN status='graded' THEN status ELSE 'ai' END WHERE id=?`).run('ไม่มีคำตอบ', answerId);
    return;
  }
  const sys = `You are a fair, careful teacher grading a student's answer. Reply with ONE JSON object only: {"score": number, "feedback": "short constructive feedback in Thai"}. The score must be between 0 and ${a.points}. Partial credit is allowed.`;
  const user = [
    `Question: ${a.prompt}`,
    d.text ? `Fill-in text: ${d.text}` : '',
    `Maximum score: ${a.points}`,
    d.rubric ? `Rubric: ${d.rubric}` : '',
    correctAnswerText(q) ? `Reference answer: ${correctAnswerText(q)}` : '',
    a.type === 'link' ? 'Note: the student submitted a link; you cannot open it. Judge only from the URL and the student note, and say that the teacher should check the content.' : '',
    a.type === 'file' ? 'Note: the student uploaded a file; you cannot open it. Judge only from the file name and note, and say that the teacher should check the file.' : '',
    `Student answer:\n"""\n${resp.slice(0, 8000)}\n"""`,
  ].filter(Boolean).join('\n');
  const out = extractJSON(await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.1 }));
  let score = Number(out.score); if (!isFinite(score)) score = 0;
  score = round2(Math.min(Math.max(score, 0), a.points));
  db.prepare(`UPDATE answers SET ai_score=?, ai_feedback=?, status=CASE WHEN status='graded' THEN status ELSE 'ai' END WHERE id=?`)
    .run(score, String(out.feedback || '').slice(0, 2000), answerId);
}

// answers eligible for AI grading in an attempt: subjective or unresolved ones (not teacher-graded)
function gradableAnswerIds(attemptId, { includeAiGraded = false } = {}) {
  return db.prepare(`SELECT id FROM answers WHERE attempt_id=? AND (status='pending' ${includeAiGraded ? "OR status='ai'" : ''})`)
    .all(attemptId).map(r => r.id);
}

async function gradeAttempt(attemptId, opts) {
  const ids = gradableAnswerIds(attemptId, opts);
  let done = 0, errors = [];
  for (const id of ids) {
    try { await gradeAnswer(id); done++; } catch (e) { errors.push(e.message); if (/เชื่อมต่อ|ปิดใช้งาน/.test(e.message)) break; }
  }
  recomputeAttempt(attemptId);
  if (errors.length && !done) throw new Error(errors[0]);
  return { graded: done, errors: errors.length };
}

// ---------------- Simple in-process job queue (AI is slow) ----------------
const queue = []; let running = 0;
const CONC = Number(process.env.AI_CONCURRENCY || 1);
const handlers = {
  generate: (input) => generateQuestions(input),
  test_model: (input) => testModel(input.model),
  grade_attempt: (input) => gradeAttempt(input.attempt_id, { includeAiGraded: !!input.regrade }),
  grade_exam: async (input) => {
    const atts = db.prepare(`SELECT id FROM attempts WHERE exam_id=? AND status='submitted' ${input.only_pending ? 'AND pending_count>0' : ''}`).all(input.exam_id);
    let graded = 0;
    for (const at of atts) { const r = await gradeAttempt(at.id, { includeAiGraded: !!input.regrade }); graded += r.graded; }
    return { attempts: atts.length, graded };
  },
};

function enqueue(userId, type, input) {
  const r = db.prepare('INSERT INTO jobs(user_id,type,input) VALUES(?,?,?)').run(userId, type, JSON.stringify(input));
  queue.push(r.lastInsertRowid); pump();
  return r.lastInsertRowid;
}
function pump() {
  while (running < CONC && queue.length) {
    const id = queue.shift(); running++;
    (async () => {
      const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      db.prepare(`UPDATE jobs SET status='running', updated_at=datetime('now') WHERE id=?`).run(id);
      try {
        const result = await handlers[job.type](parseJSON(job.input, {}));
        db.prepare(`UPDATE jobs SET status='done', result=?, updated_at=datetime('now') WHERE id=?`).run(JSON.stringify(result ?? null), id);
      } catch (e) {
        console.error('[ai job]', job.type, e.message);
        db.prepare(`UPDATE jobs SET status='error', error=?, updated_at=datetime('now') WHERE id=?`).run(e.message, id);
      } finally { running--; pump(); }
    })();
  }
}
const queuePosition = (id) => queue.indexOf(Number(id)) + 1;

module.exports = { AI, chat, status, generateQuestions, gradeAttempt, enqueue, queuePosition };

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

// ---------- Is the AI server an Ollama? (then use its native API: real "think:false", streaming, limits) ----------
let ollamaCache = { root: null, ok: false, at: 0 };
async function isOllama() {
  const root = AI.baseUrl.replace(/\/v1$/, '');
  if (ollamaCache.root === root && Date.now() - ollamaCache.at < 300e3) return ollamaCache.ok;
  let ok = false;
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(root + '/api/version', { signal: c.signal }); clearTimeout(t);
    ok = r.ok && !!(await r.json()).version;
  } catch { ok = false; }
  ollamaCache = { root, ok, at: Date.now() };
  return ok;
}
const CONNECT_ERR = 'เชื่อมต่อ AI server ไม่ได้ — ตรวจสอบว่า Ollama ทำงานอยู่ (หลัง deploy ครั้งแรกอาจต้องรอสักครู่)';
const isConnErr = (e) => e.message === 'fetch failed' || (e.cause && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/.test(String(e.cause.code)));

/**
 * Ask the AI. Streams tokens so a slow CPU is fine: we only give up when the AI produces
 * nothing for `timeout` seconds (idle), or after a hard cap of 30 minutes.
 * opts: { json, temperature, model, maxTokens, onProgress(tokens, phase) }
 */
async function chat(messages, opts = {}) {
  if (!AI.enabled) throw new Error('AI ถูกปิดใช้งานบนเซิร์ฟเวอร์นี้');
  const o = { json: true, temperature: 0.4, maxTokens: 2048, ...opts, model: opts.model || AI.model };
  if (await isOllama()) return chatOllama(messages, o);
  return chatOpenAI(messages, o);
}

async function chatOllama(messages, o, allowThinkFlag = true) {
  const root = AI.baseUrl.replace(/\/v1$/, '');
  const ctrl = new AbortController();
  const idleMs = AI.timeoutMs, hardCap = setTimeout(() => ctrl.abort('cap'), 30 * 60e3);
  let idle = setTimeout(() => ctrl.abort('idle'), idleMs + 120e3);   // first token may wait for model loading
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort('idle'), idleMs); };
  const body = {
    model: o.model, messages, stream: true, keep_alive: '30m',
    options: { temperature: o.temperature, num_predict: o.maxTokens, num_ctx: 8192 },
  };
  if (allowThinkFlag) body.think = false;            // turn off "thinking" (qwen3, deepseek-r1, …) → much faster
  if (o.json) body.format = 'json';
  let content = '', tokens = 0, thinking = 0;
  try {
    const r = await fetch(root + '/api/chat', { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 300);
      if (allowThinkFlag && /think/i.test(txt)) { clearTimeout(idle); clearTimeout(hardCap); return chatOllama(messages, o, false); }  // model without thinking support
      if (r.status === 404 || /not found/i.test(txt)) throw new Error(`ยังไม่พบโมเดล ${o.model} บน AI server (อาจกำลังดาวน์โหลดอยู่ — ดูที่หน้า จัดการโมเดล AI)`);
      throw new Error(`AI server ตอบกลับ ${r.status}: ${txt}`);
    }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = parseJSON(line, {});
        if (ev.error) throw new Error(ev.error);
        const piece = (ev.message && ev.message.content) || '';
        if (ev.message && ev.message.thinking) { thinking++; bump(); o.onProgress && o.onProgress(tokens, 'thinking', thinking); }
        if (piece) {
          content += piece; tokens++; bump();
          if (o.onProgress && tokens % 5 === 0) o.onProgress(tokens, 'writing');
          // JSON finished but the model keeps emitting blank space → stop early
          if (o.json && !piece.trim() && /\s{8,}$/.test(content) && parseJSON(content.trim(), null)) { ctrl.abort('done'); return content.trim(); }
        }
        if (ev.done) return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }
    }
    const out = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!out) throw new Error(`AI ไม่ได้ส่งคำตอบกลับมา (โมเดล ${o.model}) — ลองใหม่ หรือดูบันทึก Ollama ที่หน้า จัดการโมเดล AI`);
    return out;
  } catch (e) {
    if (ctrl.signal.aborted && ctrl.signal.reason === 'done') return content.trim();
    if (e.name === 'AbortError' || ctrl.signal.aborted) {
      if (content.trim() && parseJSON(content.trim(), null)) return content.trim();
      throw new Error(ctrl.signal.reason === 'cap' ? 'AI ใช้เวลานานเกิน 30 นาที' :
        `AI ไม่ตอบสนองเกิน ${Math.round(idleMs / 1000)} วินาที (${tokens ? 'หยุดกลางคัน' : 'ยังไม่เริ่มตอบ'}) — เซิร์ฟเวอร์อาจ RAM/CPU ไม่พอสำหรับโมเดล ${o.model}`);
    }
    if (isConnErr(e)) throw new Error(CONNECT_ERR);
    throw e;
  } finally { clearTimeout(idle); clearTimeout(hardCap); }
}

// Any OpenAI-compatible server (Groq, OpenRouter, vLLM, LM Studio…)
async function chatOpenAI(messages, o) {
  if (/qwen3/i.test(o.model) && messages.length) messages = messages.map((m, i) => i === messages.length - 1 ? { ...m, content: m.content + ' /no_think' } : m);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(AI.timeoutMs, 120e3));
  try {
    const body = { model: o.model, messages, temperature: o.temperature, max_tokens: o.maxTokens, stream: false };
    if (o.json) body.response_format = { type: 'json_object' };
    const r = await fetch(AI.baseUrl + '/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI.apiKey },
      body: JSON.stringify(body),
    });
    if (r.status === 404) throw new Error(`ยังไม่พบโมเดล ${o.model} บน AI server`);
    if (!r.ok) throw new Error(`AI server ตอบกลับ ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return String(j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI ใช้เวลานานเกินไป (timeout)');
    if (isConnErr(e)) throw new Error(CONNECT_ERR);
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
  single: '{"type":"single","prompt":"<question>","options":["<full text of choice 1>","<full text of choice 2>","<full text of choice 3>","<full text of choice 4>"],"correct_index":<index of the correct choice, 0-3>,"explanation":"<why>"}',
  multiple: '{"type":"multiple","prompt":"<question>","options":["<full text of choice 1>","<full text of choice 2>","<full text of choice 3>","<full text of choice 4>"],"correct_indices":[<indexes of ALL correct choices>],"explanation":"<why>"}',
  truefalse: '{"type":"truefalse","prompt":"<a statement that is either true or false>","correct":<true or false>,"explanation":"<why>"}',
  matching: '{"type":"matching","prompt":"<instruction>","pairs":[{"left":"<term>","right":"<its matching definition>"}, ... 3-5 pairs]}',
  ordering: '{"type":"ordering","prompt":"<what to put in order>","items":["<step that comes 1st>","<step 2nd>","<step 3rd>","<step 4th>"]}',
  short: '{"type":"short","prompt":"<question with a short exact answer>","accepted":["<answer>","<acceptable alternative spelling>"]}',
  fillblank: '{"type":"fillblank","prompt":"เติมคำในช่องว่าง","text":"<a sentence where each missing word is written inside double braces like {{word}}>"}',
  essay: '{"type":"essay","prompt":"<open question>","rubric":"<criteria for full marks>","sample_answer":"<model answer>"}',
};
const EXAMPLE = '{"questions":[{"type":"single","prompt":"เมืองหลวงของประเทศญี่ปุ่นคือเมืองใด","options":["โอซาก้า","โตเกียว","เกียวโต","ซัปโปโร"],"correct_index":1,"explanation":"โตเกียวเป็นเมืองหลวงของญี่ปุ่น"}]}';

async function generateQuestions(input, opts = {}) {
  const convert = input.mode === 'convert';
  const count = Math.min(Math.max(parseInt(input.count) || 5, 1), convert ? 100 : 30);
  const types = convert ? Object.keys(TYPE_SPEC) : (input.types || ['single']).filter(t => TYPE_SPEC[t]);
  if (!types.length) types.push('single');
  const lang = input.language === 'en' ? 'English' : 'Thai (ภาษาไทย)';
  const sys = `You are an expert teacher who writes high-quality exam questions. Always reply with ONE JSON object only: {"questions":[...]}. Each question must follow exactly one of these formats:\n${types.map(t => TYPE_SPEC[t]).join('\n')}\nReplace every <...> with real content. Choices must be complete, meaningful answers — NEVER just letters like "A", "B", "C", "D" or "ก", "ข". Example of ONE correct question (format only, do not copy its content): ${EXAMPLE}. ${convert ? 'Keep the original language and wording.' : `Write all question text in ${lang}. Facts must be accurate.`}`;
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
  const maxTokens = convert ? 8192 : Math.min(8192, 450 * count + 500);
  const onProgress = opts.progress ? (n, phase) => opts.progress(phase === 'thinking' ? '🤔 AI กำลังคิด...' : `✍️ AI กำลังเขียนคำถาม... (${n} tokens)`) : null;
  const pts = Number(input.points) || 1;
  const ask = async (extra) => {
    const out = extractJSON(await chat([{ role: 'system', content: sys }, { role: 'user', content: user + (extra || '') }], { temperature: convert ? 0.1 : 0.6, model: opts.model, maxTokens, onProgress }));
    const list = Array.isArray(out) ? out : (out.questions || []);
    return list.map(q => normalizeGenerated(q, pts)).filter(Boolean);
  };
  let result = await ask();
  // small models sometimes return placeholder choices ("A","B"…) → those get dropped; ask once more for the missing ones
  if (!convert && result.length < count) {
    try {
      const more = await ask(`\nIMPORTANT: every answer choice must be real content, not letters. Create ${count - result.length} question(s).`);
      result = result.concat(more);
    } catch (e) { if (!result.length) throw e; }
  }
  if (!result.length) throw new Error('AI สร้างคำถามที่ใช้ได้ไม่สำเร็จ ลองใหม่อีกครั้ง หรือเปลี่ยนเป็นโมเดลที่ใหญ่ขึ้นในหน้า จัดการโมเดล AI');
  return result.slice(0, count);
}

// Try a model with a small real task (admin "ทดสอบโมเดล")
async function testModel(model, progress) {
  const t0 = Date.now();
  const questions = await generateQuestions({ topic: 'ระบบสุริยะ (Solar system) สำหรับนักเรียนมัธยม', count: 2, types: ['single', 'truefalse'], language: 'th' }, { model, progress });
  return { model, ms: Date.now() - t0, questions };
}

function normalizeGenerated(q, pts) {
  if (!q || !q.type || !q.prompt && !q.text) return null;
  const base = { type: q.type, prompt: String(q.prompt || ''), points: pts, explanation: String(q.explanation || ''), data: {} };
  // clean "A. Linux" → "Linux"; detect placeholder choices like "A","B","C","D" / "ก","ข" / "<...>"
  const clean = (x) => String(typeof x === 'object' && x ? (x.text ?? '') : x ?? '').trim().replace(/^(?:[A-Ha-h]|[ก-ฌ]|[1-8])\s*[.)]\s+(?=\S)/, '');
  const isPlaceholder = (t) => !t || /^(?:[A-Ha-h]|[ก-ฌ]|[1-8]|choice\s*\d|ตัวเลือก\s*\d?)$/i.test(t) || /^<.*>$/.test(t) || t === '...';
  const opts = (arr) => (arr || []).map(x => ({ id: token(6), text: clean(x) }));
  const badOpts = (o) => o.length < 2 || o.filter(x => isPlaceholder(x.text)).length >= Math.ceil(o.length / 2) || new Set(o.map(x => x.text)).size < o.length;
  if (/^<.*>$/.test(String(q.prompt || '').trim())) return null;
  switch (q.type) {
    case 'single': {
      const o = opts(q.options); if (badOpts(o)) return null;
      const ci = Number.isInteger(q.correct_index) ? q.correct_index : 0;
      base.data = { options: o, correct: [o[Math.min(ci, o.length - 1)].id] }; break;
    }
    case 'multiple': {
      const o = opts(q.options); if (badOpts(o)) return null;
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
  const out = extractJSON(await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.1, maxTokens: 700 }));
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

async function gradeAttempt(attemptId, opts = {}) {
  const ids = gradableAnswerIds(attemptId, opts);
  let done = 0, errors = [];
  for (const [k, id] of ids.entries()) {
    if (opts.progress) opts.progress(`🤖 AI กำลังตรวจข้อเขียน ${k + 1}/${ids.length}${opts.prefix || ''}`);
    try { await gradeAnswer(id); done++; } catch (e) { errors.push(e.message); if (/เชื่อมต่อ|ปิดใช้งาน/.test(e.message)) break; }
  }
  recomputeAttempt(attemptId);
  if (errors.length && !done) throw new Error(errors[0]);
  return { graded: done, errors: errors.length };
}

// ---------------- Simple in-process job queue (AI is slow) ----------------
const queue = []; let running = 0;
const CONC = Number(process.env.AI_CONCURRENCY || 1);
const progressOf = {};   // job id → latest progress text (shown live in the UI)
const handlers = {
  generate: (input, ctx) => generateQuestions(input, { progress: ctx.progress }),
  test_model: (input, ctx) => testModel(input.model, ctx.progress),
  grade_attempt: (input, ctx) => gradeAttempt(input.attempt_id, { includeAiGraded: !!input.regrade, progress: ctx.progress }),
  grade_exam: async (input, ctx) => {
    const atts = db.prepare(`SELECT id FROM attempts WHERE exam_id=? AND status='submitted' ${input.only_pending ? 'AND pending_count>0' : ''}`).all(input.exam_id);
    let graded = 0;
    for (const [k, at] of atts.entries()) { const r = await gradeAttempt(at.id, { includeAiGraded: !!input.regrade, progress: ctx.progress, prefix: ` (ผู้สอบคนที่ ${k + 1}/${atts.length})` }); graded += r.graded; }
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
        const result = await handlers[job.type](parseJSON(job.input, {}), { progress: (t) => { progressOf[id] = t; } });
        db.prepare(`UPDATE jobs SET status='done', result=?, updated_at=datetime('now') WHERE id=?`).run(JSON.stringify(result ?? null), id);
      } catch (e) {
        console.error('[ai job]', job.type, e.message);
        db.prepare(`UPDATE jobs SET status='error', error=?, updated_at=datetime('now') WHERE id=?`).run(e.message, id);
      } finally { running--; setTimeout(() => delete progressOf[id], 60e3); pump(); }
    })();
  }
}
const queuePosition = (id) => queue.indexOf(Number(id)) + 1;
const jobProgress = (id) => progressOf[id] || null;

module.exports = { AI, chat, isOllama, jobProgress, status, generateQuestions, gradeAttempt, enqueue, queuePosition };

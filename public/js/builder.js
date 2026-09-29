// Exam builder (Alpine.js component)
function defaultData(type) {
  switch (type) {
    case 'single': case 'multiple': {
      const o = [1, 2, 3, 4].map(() => ({ id: uid(), text: '' }));
      return { options: o, correct: [], partial: true };
    }
    case 'truefalse': return { correct: true };
    case 'matching': return { pairs: [{ id: uid(), left: '', right: '' }, { id: uid(), left: '', right: '' }], distractorsText: '' };
    case 'ordering': return { items: [{ id: uid(), text: '' }, { id: uid(), text: '' }, { id: uid(), text: '' }] };
    case 'short': return { acceptedText: '', case_sensitive: false };
    case 'fillblank': return { text: '', case_sensitive: false };
    case 'essay': return { rubric: '', sample_answer: '', min_words: 0 };
    case 'link': return { youtube_only: false, rubric: '' };
    case 'file': return { accept: '.pdf,.docx,.jpg,.png', rubric: '' };
  }
  return {};
}
// server -> editor
function toEditor(q) {
  const d = JSON.parse(JSON.stringify(q.data || {}));
  if (q.type === 'matching') { d.distractorsText = (d.distractors || []).join('\n'); d.pairs = d.pairs || []; }
  if (q.type === 'short') d.acceptedText = (d.accepted || []).join('\n');
  if ((q.type === 'single' || q.type === 'multiple')) { d.options = d.options || []; d.correct = (d.correct || []).map(String); }
  return { id: q.id || null, key: uid(), type: q.type, prompt: q.prompt || '', points: q.points ?? 1, image_file_id: q.image_file_id || null,
    explanation: q.explanation || '', data: d, open: false };
}
// editor -> server
function toServer(q) {
  const d = JSON.parse(JSON.stringify(q.data));
  if (q.type === 'matching') { d.distractors = String(d.distractorsText || '').split('\n').map(s => s.trim()).filter(Boolean); delete d.distractorsText; }
  if (q.type === 'short') { d.accepted = String(d.acceptedText || '').split('\n').map(s => s.trim()).filter(Boolean); delete d.acceptedText; }
  if (q.type === 'single' && d.correct.length > 1) d.correct = d.correct.slice(0, 1);
  return { id: q.id, type: q.type, prompt: q.prompt, points: Number(q.points) || 0, image_file_id: q.image_file_id, explanation: q.explanation, data: d };
}

// ---- Import from plain text (Aiken-like, Thai friendly) ----
function parseExamText(text) {
  const blocks = String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const OPT = /^\s*(\*\s*)?[\(\[]?([A-Ha-hก-ฌ]|[1-8])[\)\].:]\s*(.+)$/;
  const ANS = /^\s*(ANSWER|ANS|ตอบ|เฉลย|คำตอบ)\s*[:：=]?\s*(.+)$/i;
  const out = [];
  for (const b of blocks) {
    const lines = b.split('\n').map(l => l.trim()).filter(Boolean);
    let prompt = [], opts = [], answer = null, inOpts = false;
    for (const l of lines) {
      const a = l.match(ANS); if (a) { answer = a[2].trim(); continue; }
      const o = l.match(OPT);
      if (o && (inOpts || prompt.length)) {
        inOpts = true; let t = o[3].trim(); let ok = !!o[1];
        if (/^\*|\*$|✓|✔|\(ถูก\)$/.test(t)) { ok = true; t = t.replace(/^\*\s*|\s*\*$|\s*[✓✔]\s*|\s*\(ถูก\)$/g, '').trim(); }
        opts.push({ key: o[2].toLowerCase(), text: t, ok });
      } else if (!inOpts) prompt.push(l);
      else opts[opts.length - 1].text += ' ' + l;
    }
    let p = prompt.join('\n').replace(/^\s*(ข้อ(ที่)?\s*)?\d+\s*[.)]\s*/, '').trim();
    if (!p && !opts.length) continue;
    if (opts.length >= 2) {
      const o = opts.map(x => ({ id: uid(), text: x.text, key: x.key, ok: x.ok }));
      if (answer) {
        const keys = answer.toLowerCase().split(/[\s,/&และ]+/).filter(Boolean);
        o.forEach(x => { if (keys.includes(x.key) || x.text.toLowerCase() === answer.toLowerCase()) x.ok = true; });
      }
      const correct = o.filter(x => x.ok).map(x => x.id);
      out.push({ type: correct.length > 1 ? 'multiple' : 'single', prompt: p, points: 1, data: { options: o.map(({ id, text }) => ({ id, text })), correct, partial: true } });
    } else if (/\{\{.+?\}\}/.test(p)) {
      out.push({ type: 'fillblank', prompt: 'เติมคำในช่องว่าง', points: 1, data: { text: p } });
    } else if (answer && /^(true|false|ถูก|ผิด|t|f|จริง|เท็จ)$/i.test(answer)) {
      out.push({ type: 'truefalse', prompt: p, points: 1, data: { correct: /^(true|ถูก|t|จริง)$/i.test(answer) } });
    } else if (answer) {
      out.push({ type: 'short', prompt: p, points: 1, data: { accepted: answer.split(/\s*[|/]\s*/) } });
    } else {
      out.push({ type: 'essay', prompt: p, points: 5, data: { rubric: '', sample_answer: '' } });
    }
  }
  return out;
}

function builder() {
  const init = JSON.parse(document.getElementById('init').textContent);
  return {
    tab: 'questions',
    exam: init.exam,
    questions: init.questions.map(toEditor),
    types: init.types,
    shareUrl: init.shareUrl,
    usage: init.usage,
    saving: false, dirty: false, lastSaved: null,
    imp: { open: false, text: '', results: [], busy: false, status: '', error: '' },
    ai: { open: false, topic: '', source_text: '', count: 5, types: ['single'], difficulty: 'medium', language: 'th', points: 1, busy: false, status: '', results: [], error: '' },

    init() {
      this.$watch('exam', () => this.dirty = true, { deep: true });
      this.$watch('questions', () => this.dirty = true, { deep: true });
      window.addEventListener('beforeunload', (e) => { if (this.dirty) { e.preventDefault(); e.returnValue = ''; } });
      window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.save(); } });
      this.$nextTick(() => {
        this.dirty = false; this.drawQR();
        if (/^แบบทดสอบใหม่/.test(this.exam.title) && !this.questions.length) { const t = document.getElementById('examTitle'); if (t) { t.focus(); t.select(); } }
      });
    },
    get totalPoints() { return this.questions.reduce((s, q) => s + (Number(q.points) || 0), 0); },
    typeLabel(t) { return (this.types[t] || {}).label || t; },

    add(type) {
      const q = toEditor({ type, points: ['essay', 'link', 'file'].includes(type) ? 5 : 1, data: defaultData(type) });
      q.open = true; this.questions.push(q);
      this.$nextTick(() => { const els = document.querySelectorAll('.builder-q'); els[els.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    },
    changeType(q, t) {
      if (q.type === t) return;
      if ((q.type === 'single' || q.type === 'multiple') && (t === 'single' || t === 'multiple')) { q.type = t; if (t === 'single') q.data.correct = q.data.correct.slice(0, 1); return; }
      q.type = t; q.data = defaultData(t);
    },
    move(i, d) { const j = i + d; if (j < 0 || j >= this.questions.length) return; const a = this.questions; [a[i], a[j]] = [a[j], a[i]]; this.questions = [...a]; },
    dup(i) { const c = toEditor(toServer(this.questions[i])); c.id = null; c.open = true; this.questions.splice(i + 1, 0, c); },
    remove(i) { if (confirm('ลบคำถามนี้? (คำตอบของผู้เรียนในข้อนี้จะถูกลบด้วย)')) this.questions.splice(i, 1); },
    toggleCorrect(q, id) {
      id = String(id);
      if (q.type === 'single') q.data.correct = [id];
      else q.data.correct = q.data.correct.includes(id) ? q.data.correct.filter(x => x !== id) : [...q.data.correct, id];
    },
    blankCount(q) { return ((q.data.text || '').match(/\{\{.*?\}\}/g) || []).length; },
    problems(q) {
      const p = [];
      if (!q.prompt.trim() && q.type !== 'fillblank') p.push('ยังไม่มีโจทย์');
      if ((q.type === 'single' || q.type === 'multiple') && !q.data.correct.length) p.push('ยังไม่ได้เลือกคำตอบที่ถูก');
      if ((q.type === 'single' || q.type === 'multiple') && q.data.options.filter(o => o.text.trim()).length < 2) p.push('ต้องมีอย่างน้อย 2 ตัวเลือก');
      if (q.type === 'fillblank' && !this.blankCount(q)) p.push('ยังไม่มีช่องว่าง {{...}}');
      if (q.type === 'short' && !String(q.data.acceptedText || '').trim()) p.push('ไม่มีคำตอบที่ยอมรับ → ต้องตรวจเอง/ให้ AI ตรวจ');
      return p;
    },

    async uploadImage(q, ev) {
      const f = ev.target.files[0]; if (!f) return;
      const fd = new FormData(); fd.append('file', f);
      try {
        const r = await api(`/api/exams/${this.exam.id}/image`, { body: fd });
        q.image_file_id = r.id; this.usage = r.usage; toast('อัปโหลดรูปแล้ว');
      } catch (e) { alert(e.message); }
      ev.target.value = '';
    },

    async save() {
      if (this.saving) return;
      this.saving = true;
      try {
        const payload = { ...this.exam, questions: this.questions.map(toServer) };
        const r = await api(`/api/exams/${this.exam.id}`, { method: 'PUT', body: payload });
        // keep editor state but take server ids
        r.questions.forEach((sq, i) => { if (this.questions[i]) this.questions[i].id = sq.id; });
        this.$nextTick(() => { this.dirty = false; });
        this.lastSaved = new Date().toLocaleTimeString('th-TH');
        toast('บันทึกแล้ว ✓');
      } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message); }
      this.saving = false;
    },

    // ---- AI ----
    async aiGenerate() {
      const a = this.ai; a.error = ''; a.results = []; a.busy = true; a.status = 'ส่งงานให้ AI...';
      try {
        const { job_id } = await api('/api/ai/generate', { body: { topic: a.topic, source_text: a.source_text, count: a.count, types: a.types, difficulty: a.difficulty, language: a.language, points: a.points } });
        const res = await waitJob(job_id, (j) => {
          a.status = j.status === 'queued' ? `รอคิว AI${j.position ? ' (ลำดับที่ ' + j.position + ')' : ''}...` : (j.progress || '⏳ กำลังโหลดโมเดล AI เข้าหน่วยความจำ... (ครั้งแรกอาจใช้เวลาสักครู่)');
        });
        a.results = (res || []).map(q => ({ ...toEditor(q), pick: true }));
        a.status = a.results.length ? `ได้ ${a.results.length} ข้อ — ตรวจทานแล้วกดเพิ่ม` : 'AI ไม่ได้สร้างคำถาม ลองปรับหัวข้อแล้วลองใหม่';
      } catch (e) { a.error = e.message; a.status = ''; }
      a.busy = false;
    },
    aiAdd() {
      const picked = this.ai.results.filter(q => q.pick);
      picked.forEach(q => { delete q.pick; q.open = false; this.questions.push(q); });
      toast(`เพิ่ม ${picked.length} ข้อแล้ว — อย่าลืมกดบันทึก`);
      this.ai.results = []; this.ai.open = false; this.ai.status = '';
    },
    aiPreview(q) {
      if (q.type === 'single' || q.type === 'multiple') return q.data.options.map(o => (q.data.correct.includes(String(o.id)) ? '✅ ' : '▫️ ') + o.text).join('\n');
      if (q.type === 'truefalse') return 'คำตอบ: ' + (q.data.correct ? 'ถูก' : 'ผิด');
      if (q.type === 'matching') return q.data.pairs.map(p => p.left + ' → ' + p.right).join('\n');
      if (q.type === 'ordering') return q.data.items.map((x, i) => (i + 1) + '. ' + x.text).join('\n');
      if (q.type === 'short') return 'คำตอบ: ' + q.data.acceptedText.replace(/\n/g, ' / ');
      if (q.type === 'fillblank') return q.data.text;
      if (q.type === 'essay') return 'เกณฑ์: ' + (q.data.rubric || '-');
      return '';
    },

    // ---- import ----
    impParse() {
      this.imp.error = '';
      this.imp.results = parseExamText(this.imp.text).map(q => ({ ...toEditor(q), pick: true }));
      this.imp.status = this.imp.results.length ? `อ่านได้ ${this.imp.results.length} ข้อ — ตรวจทานแล้วกดเพิ่ม` : 'อ่านรูปแบบไม่ได้ ลองใช้ “ให้ AI แปลง” แทน';
    },
    async impAI() {
      const m = this.imp; m.error = ''; m.results = []; m.busy = true; m.status = 'ส่งให้ AI แปลง...';
      try {
        const { job_id } = await api('/api/ai/generate', { body: { mode: 'convert', source_text: m.text, count: 100 } });
        const res = await waitJob(job_id, j => m.status = j.status === 'queued' ? 'รอคิว AI...' : (j.progress || '🤖 AI กำลังอ่านข้อสอบและหาเฉลย...'));
        m.results = (res || []).map(q => ({ ...toEditor(q), pick: true }));
        m.status = m.results.length ? `AI แปลงได้ ${m.results.length} ข้อ — ตรวจทานเฉลยก่อนเพิ่ม` : 'AI แปลงไม่สำเร็จ';
      } catch (e) { m.error = e.message; m.status = ''; }
      m.busy = false;
    },
    impAdd() {
      const picked = this.imp.results.filter(q => q.pick);
      picked.forEach(q => { delete q.pick; this.questions.push(q); });
      toast(`นำเข้า ${picked.length} ข้อแล้ว — อย่าลืมกดบันทึก`);
      Object.assign(this.imp, { open: false, results: [], text: '', status: '' });
    },

    drawQR() {
      const el = document.getElementById('qr'); if (!el || !window.qrcode) return;
      const qr = qrcode(0, 'M'); qr.addData(this.shareUrl); qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    },
  };
}

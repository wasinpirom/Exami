// Exam-taking page (Alpine.js component)
function taker() {
  const init = JSON.parse(document.getElementById('init').textContent);
  const answers = {};
  for (const q of init.questions) {
    const s = init.saved[q.id];
    if (q.type === 'multiple') answers[q.id] = Array.isArray(s) ? s.map(String) : [];
    else if (q.type === 'matching') answers[q.id] = s && typeof s === 'object' ? s : {};
    else if (q.type === 'ordering') answers[q.id] = Array.isArray(s) && s.length ? s.map(String) : q.items.map(x => String(x.id));
    else if (q.type === 'fillblank') answers[q.id] = Array.isArray(s) ? s : Array(q.blankCount).fill('');
    else if (q.type === 'link') answers[q.id] = s && typeof s === 'object' ? s : { url: '', note: '' };
    else if (q.type === 'file') answers[q.id] = s && typeof s === 'object' ? s : { note: '' };
    else answers[q.id] = s ?? '';
  }
  return {
    token: init.token, questions: init.questions, answers, onePerPage: init.onePerPage,
    page: 0, remaining: init.remaining, saving: false, savedAt: null, submitting: false, uploading: {}, touched: {},
    init() {
      this.$watch('answers', () => this.queueSave(), { deep: true });
      if (this.remaining != null) {
        this.timer = setInterval(() => {
          this.remaining = Math.max(0, this.remaining - 1);
          if (this.remaining === 60) toast('⏰ เหลือเวลา 1 นาที!', 4000);
          if (this.remaining === 0) { clearInterval(this.timer); this.submit(true); }
        }, 1000);
      }
      document.addEventListener('visibilitychange', () => { if (document.hidden) navigator.sendBeacon?.(`/api/a/${this.token}/event`); });
      setInterval(() => { if (this.pendingSave) this.save(); }, 20000);
      window.addEventListener('beforeunload', (e) => { if (this.pendingSave && !this.submitting) { this.save(); e.preventDefault(); e.returnValue = ''; } });
    },
    get timeText() {
      if (this.remaining == null) return '';
      const h = Math.floor(this.remaining / 3600), m = Math.floor(this.remaining % 3600 / 60), s = this.remaining % 60;
      return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    },
    isAnswered(q) {
      const a = this.answers[q.id];
      switch (q.type) {
        case 'multiple': return a.length > 0;
        case 'matching': return Object.values(a).some(Boolean);
        case 'ordering': return !!this.touched[q.id];
        case 'fillblank': return a.some(x => String(x).trim());
        case 'link': return !!String(a.url || '').trim();
        case 'file': return !!a.file_id;
        default: return String(a ?? '').trim() !== '';
      }
    },
    get answeredCount() { return this.questions.filter(q => this.isAnswered(q)).length; },
    words(t) {
      t = String(t || '').trim(); if (!t) return 0;
      // Thai has no spaces between words → use the browser's word segmenter when available
      if (window.Intl && Intl.Segmenter) return [...new Intl.Segmenter('th', { granularity: 'word' }).segment(t)].filter(s => s.isWordLike).length;
      return t.split(/\s+/).length;
    },
    toggleMulti(q, id) { id = String(id); const a = this.answers[q.id]; this.answers[q.id] = a.includes(id) ? a.filter(x => x !== id) : [...a, id]; },
    moveItem(q, i, d) {
      const a = [...this.answers[q.id]]; const j = i + d; if (j < 0 || j >= a.length) return;
      [a[i], a[j]] = [a[j], a[i]]; this.answers[q.id] = a; this.touched[q.id] = true;
    },
    itemText(q, id) { return (q.items.find(x => String(x.id) === String(id)) || {}).text; },
    ytId(url) { const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/); return m && m[1]; },
    linkError(q) {
      const u = String(this.answers[q.id].url || '').trim(); if (!u) return '';
      if (!/^https?:\/\//i.test(u)) return 'ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://';
      if (q.youtube_only && !this.ytId(u)) return 'กรุณาใส่ลิงก์ YouTube';
      return '';
    },
    queueSave() { this.pendingSave = true; clearTimeout(this._t); this._t = setTimeout(() => this.save(), 1500); },
    payload() {
      const out = {};
      for (const q of this.questions) {
        const a = this.answers[q.id];
        if (q.type === 'ordering' && !this.touched[q.id] && !init.saved[q.id]) continue;
        out[q.id] = a;
      }
      return out;
    },
    async save() {
      if (this.saving || this.submitting) return;
      this.saving = true; this.pendingSave = false;
      try { await api(`/api/a/${this.token}/save`, { body: { answers: this.payload() } }); this.savedAt = new Date().toLocaleTimeString('th-TH'); }
      catch (e) { if (e.data && e.data.redirect) location.href = e.data.redirect; else this.pendingSave = true; }
      this.saving = false;
    },
    async upload(q, ev) {
      const f = ev.target.files[0]; if (!f) return;
      if (f.size > init.maxUploadMb * 1048576) { alert(`ไฟล์ใหญ่เกิน ${init.maxUploadMb}MB`); ev.target.value = ''; return; }
      this.uploading[q.id] = true;
      const fd = new FormData(); fd.append('file', f);
      try { const r = await api(`/api/a/${this.token}/upload/${q.id}`, { body: fd }); this.answers[q.id] = { file_id: r.file_id, name: r.name, size: r.size, note: this.answers[q.id].note || '' }; toast('อัปโหลดแล้ว ✓'); }
      catch (e) { alert(e.message); }
      this.uploading[q.id] = false; ev.target.value = '';
    },
    async submit(auto) {
      if (this.submitting) return;
      if (!auto) {
        const left = this.questions.length - this.answeredCount;
        if (!confirm(left ? `ยังไม่ได้ตอบ ${left} ข้อ ต้องการส่งคำตอบเลยหรือไม่?` : 'ยืนยันส่งคำตอบ? ส่งแล้วแก้ไขไม่ได้')) return;
      }
      this.submitting = true; clearTimeout(this._t);
      try { const r = await api(`/api/a/${this.token}/submit`, { body: { answers: this.payload() } }); location.href = r.redirect; }
      catch (e) { alert('ส่งไม่สำเร็จ: ' + e.message + ' — ลองกดส่งอีกครั้ง'); this.submitting = false; }
    },
    fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB'; },
    go(i) { if (this.onePerPage) this.page = i; else document.getElementById('q' + i)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  };
}

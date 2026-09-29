// Shared helpers
window.api = async function (url, opts = {}) {
  const o = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { Accept: 'application/json' } };
  if (opts.body instanceof FormData) o.body = opts.body;
  else if (opts.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
  const r = await fetch(url, o);
  let j = null; try { j = await r.json(); } catch { j = {}; }
  if (!r.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.data = j; e.status = r.status; throw e; }
  return j;
};
window.toast = function (msg, ms = 2500) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = msg;
  document.body.appendChild(d); setTimeout(() => d.remove(), ms);
};
window.copyText = function (text) {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('คัดลอกแล้ว ✓'))
    .catch(() => { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); toast('คัดลอกแล้ว ✓'); });
};
// Poll an AI job until done
window.waitJob = async function (id, onTick) {
  for (let i = 0; i < 600; i++) {
    const j = await api('/api/jobs/' + id);
    if (onTick) onTick(j);
    if (j.status === 'done') return j.result;
    if (j.status === 'error') throw new Error(j.error || 'AI error');
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('หมดเวลารอ AI');
};
window.uid = () => Math.random().toString(36).slice(2, 8);

// ---------- Theme ----------
window.toggleTheme = function () {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', cur);
  try { localStorage.setItem('exami-theme', cur); } catch (e) {}
  syncThemeIcon();
};
function syncThemeIcon() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.querySelectorAll('.theme-ico').forEach(e => e.textContent = dark ? '☀️' : '🌙');
}

// ---------- Scroll reveal + animated counters ----------
window.initUI = function () {
  syncThemeIcon();
  const els = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((ents) => ents.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .12 });
    els.forEach(el => io.observe(el));
  } else els.forEach(el => el.classList.add('in'));
  document.querySelectorAll('[data-count]').forEach(el => {
    const end = Number(el.dataset.count) || 0; const t0 = performance.now(); const dur = 1400;
    const step = (t) => { const p = Math.min(1, (t - t0) / dur); el.textContent = Math.round(end * (1 - Math.pow(1 - p, 3))).toLocaleString(); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
};

// ---------- Confetti (tiny, no library) ----------
window.confetti = function (n = 160) {
  const c = document.createElement('canvas'); c.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:200';
  document.body.appendChild(c); const x = c.getContext('2d');
  const W = c.width = innerWidth, H = c.height = innerHeight;
  const colors = ['#6d5dfc', '#a855f7', '#ec4899', '#06b6d4', '#10b981', '#f59e0b'];
  const ps = Array.from({ length: n }, () => ({ x: W / 2 + (Math.random() - .5) * 200, y: H * .35, vx: (Math.random() - .5) * 16, vy: -Math.random() * 16 - 4,
    r: Math.random() * 6 + 4, c: colors[Math.floor(Math.random() * colors.length)], a: Math.random() * 6, va: (Math.random() - .5) * .3 }));
  let f = 0;
  (function tick() {
    x.clearRect(0, 0, W, H); f++;
    ps.forEach(p => { p.vy += .35; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.a += p.va;
      x.save(); x.translate(p.x, p.y); x.rotate(p.a); x.fillStyle = p.c; x.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); x.restore(); });
    if (f < 220) requestAnimationFrame(tick); else c.remove();
  })();
};

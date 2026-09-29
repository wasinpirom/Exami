// AI model management for Ollama: list / pull (with progress) / delete / check updates / recommendations
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getSettings, setSetting, parseJSON } = require('./util');
const { AI } = require('./ai');

// Native Ollama API (not the /v1 OpenAI-compatible one)
const ollamaUrl = () => (process.env.OLLAMA_URL || AI.baseUrl.replace(/\/v1$/, '')).replace(/\/$/, '');
const REGISTRY = process.env.OLLAMA_REGISTRY || 'https://registry.ollama.ai';
const BUNDLED = path.join(__dirname, '..', 'ai-models.json');

async function ollama(pathname, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(ollamaUrl() + pathname, { ...opts, signal: ctrl.signal, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Ollama ไม่ตอบสนอง');
    if (e.message === 'fetch failed') throw new Error('เชื่อมต่อ Ollama ไม่ได้ (' + ollamaUrl() + ')');
    throw e;
  } finally { clearTimeout(t); }
}

async function listInstalled() {
  const j = await (await ollama('/api/tags')).json();
  return (j.models || []).map(m => ({
    name: m.name, size: m.size, digest: m.digest, modified_at: m.modified_at,
    family: m.details && m.details.family, params: m.details && m.details.parameter_size, quant: m.details && m.details.quantization_level,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Pull in background with progress ----------
const pulls = {}; // name -> { status, completed, total, percent, error, done, started }
function pull(name) {
  name = normalizeName(name);
  if (!/^[\w.\-/:]+$/.test(name)) throw Object.assign(new Error('ชื่อโมเดลไม่ถูกต้อง'), { status: 400 });
  if (pulls[name] && !pulls[name].done) return pulls[name];
  const st = pulls[name] = { name, status: 'เริ่มดาวน์โหลด...', completed: 0, total: 0, percent: 0, error: null, done: false, started: Date.now() };
  (async () => {
    try {
      const r = await ollama('/api/pull', { method: 'POST', body: JSON.stringify({ model: name, stream: true }) }, 6 * 3600e3);
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
          st.status = ev.status || st.status;
          if (ev.total) { st.total = ev.total; st.completed = ev.completed || 0; st.percent = Math.floor(st.completed / st.total * 100); }
        }
      }
      st.status = 'ติดตั้งเรียบร้อย'; st.percent = 100;
      clearNotice(name);
    } catch (e) { st.error = /file does not exist|not found/i.test(e.message) ? `ไม่พบโมเดล "${name}" ใน Ollama library` : e.message; }
    st.done = true;
  })();
  return st;
}
const pullStatus = () => Object.values(pulls).sort((a, b) => b.started - a.started);

async function remove(name) {
  if (normalizeName(name) === normalizeName(AI.model)) throw Object.assign(new Error('ลบโมเดลที่กำลังใช้งานอยู่ไม่ได้ — เปลี่ยนโมเดลก่อน'), { status: 400 });
  await ollama('/api/delete', { method: 'DELETE', body: JSON.stringify({ model: name }) });
}

const normalizeName = (n) => { n = String(n || '').trim(); return n && !n.includes(':') ? n + ':latest' : n; };

// ---------- Update check: compare local manifest digest with registry ----------
async function remoteDigest(name) {
  const [repo, tag] = normalizeName(name).split(':');
  const full = repo.includes('/') ? repo : 'library/' + repo;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`${REGISTRY}/v2/${full}/manifests/${tag}`, { signal: ctrl.signal, headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' } });
    if (!r.ok) return null;
    const body = Buffer.from(await r.arrayBuffer());
    return crypto.createHash('sha256').update(body).digest('hex');
  } catch { return null; } finally { clearTimeout(t); }
}

async function checkUpdates(installed) {
  installed = installed || await listInstalled();
  const out = [];
  for (const m of installed) {
    const remote = await remoteDigest(m.name);
    if (remote && m.digest && !m.digest.endsWith(remote) && !remote.endsWith(m.digest)) out.push(m.name);
  }
  return out;
}

// ---------- Recommendations (curated list, maintained in the GitHub repo) ----------
function recommendUrl() {
  const s = getSettings();
  if (s.ai_recommend_url) return s.ai_recommend_url;
  const m = String(s.github_url || '').match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2].replace(/\.git$/, '')}/main/ai-models.json` : null;
}
let recoCache = { at: 0, data: null, source: '' };
async function recommendations(force = false) {
  if (!force && recoCache.data && Date.now() - recoCache.at < 6 * 3600e3) return recoCache;
  const bundled = parseJSON(fs.readFileSync(BUNDLED, 'utf8'), { models: [] });
  let data = bundled, source = 'bundled';
  const url = recommendUrl();
  if (url) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { signal: ctrl.signal }); clearTimeout(t);
      if (r.ok) { const j = await r.json(); if (Array.isArray(j.models) && j.models.length) { data = j; source = url; } }
    } catch { /* offline → bundled list */ }
  }
  recoCache = { at: Date.now(), data, source };
  return recoCache;
}

function hardware() {
  return { totalRam: os.totalmem(), freeRam: os.freemem(), cpus: os.cpus().length };
}
// how well a model fits this server's RAM
function fit(model, hw) {
  const need = (model.ram_gb || 0) * 1024 ** 3;
  if (!need) return 'unknown';
  if (need <= hw.totalRam * 0.7) return 'good';
  if (need <= hw.totalRam) return 'tight';
  return 'too_big';
}

// ---------- Notices for admins (checked periodically) ----------
function notice() { return parseJSON(getSettings().ai_notice, {}); }
function clearNotice(name) {
  const n = notice(); if (!n.updates) return;
  n.updates = n.updates.filter(x => normalizeName(x) !== normalizeName(name));
  setSetting('ai_notice', JSON.stringify(n));
}
function noticeCount() {
  const n = notice(); const seen = new Set(parseJSON(getSettings().ai_reco_seen, []));
  return (n.updates || []).length + (n.recos || []).filter(x => !seen.has(x)).length;
}
async function runCheck() {
  if (!AI.enabled) return;
  try {
    const installed = await listInstalled();
    const updates = await checkUpdates(installed);
    const { data } = await recommendations(true);
    const have = new Set(installed.map(m => normalizeName(m.name)));
    const recos = (data.models || []).filter(m => !have.has(normalizeName(m.name))).map(m => m.name);
    // first check ever: treat the current list as the baseline, notify only about models added later
    if (!notice().checked_at) setSetting('ai_reco_seen', JSON.stringify(recos));
    setSetting('ai_notice', JSON.stringify({ updates, recos, checked_at: new Date().toISOString() }));
  } catch (e) { console.log('[ai check]', e.message); }
}
function markRecosSeen() {
  const n = notice(); const seen = new Set(parseJSON(getSettings().ai_reco_seen, []));
  (n.recos || []).forEach(x => seen.add(x));
  setSetting('ai_reco_seen', JSON.stringify([...seen]));
}
// Load the active model into RAM so the first teacher request doesn't wait for it
async function warmUp(model = AI.model) {
  try {
    await ollama('/api/generate', { method: 'POST', body: JSON.stringify({ model, prompt: '', keep_alive: '30m' }) }, 180e3);
    console.log('[ai] model loaded into memory:', model);
  } catch (e) { console.log('[ai] warm-up skipped:', e.message); }
}

// Last lines of the built-in Ollama log (for troubleshooting from the admin page)
function ollamaLog(lines = 80) {
  try { return fs.readFileSync('/tmp/ollama.log', 'utf8').split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

// First boot: download the active/default model automatically (no manual step needed)
async function ensureDefaultModel(tries = 60) {
  if (!AI.enabled) return;
  try {
    const installed = await listInstalled();
    const want = normalizeName(AI.model);
    if (!installed.some(m => normalizeName(m.name) === want)) {
      console.log('[ai] downloading default model', AI.model, '...');
      const st = pull(AI.model);
      const wait = setInterval(() => { if (st.done) { clearInterval(wait); if (!st.error) warmUp(); } }, 5000);
    } else warmUp();
  } catch (e) {
    // Ollama still starting (or an external non-Ollama API is used) → retry for ~15 minutes
    if (tries > 0) setTimeout(() => ensureDefaultModel(tries - 1), 15e3);
  }
}

function startScheduler() {
  setTimeout(ensureDefaultModel, 5e3);
  setTimeout(runCheck, 90e3);
  setInterval(runCheck, 12 * 3600e3);
}

module.exports = { ollamaUrl, ensureDefaultModel, warmUp, ollamaLog, listInstalled, pull, pullStatus, remove, checkUpdates, recommendations, recommendUrl, hardware, fit, notice, noticeCount, runCheck, markRecosSeen, startScheduler, normalizeName };

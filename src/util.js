const crypto = require('crypto');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const { db } = require('./db');

const token = (n = 10) => {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += abc[bytes[i] % abc.length];
  return s;
};

const parseJSON = (s, fallback) => {
  try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; }
};

// ---------- Site settings (editable in /admin/settings, fallback to env) ----------
const SETTING_DEFAULTS = {
  site_name: process.env.SITE_NAME || 'Exami',
  site_tagline: 'ระบบสอบออนไลน์ + คอร์สเรียน ฟรี โอเพนซอร์ส เพื่อสังคม',
  default_quota_mb: process.env.DEFAULT_QUOTA_MB || '100',
  max_upload_mb: process.env.MAX_UPLOAD_MB || '20',
  contact_line: process.env.CONTACT_LINE || '@wasin',
  donate_url: process.env.DONATE_URL || 'https://buymeacoffee.com/',
  donate_text: 'สนับสนุนค่าเซิร์ฟเวอร์ ☕',
  github_url: process.env.GITHUB_URL || 'https://github.com/',
  ad_top_html: '',
  ad_bottom_html: '',
  ad_head_html: '',          // e.g. Google AdSense <script> tag
  announcement: '',
  allow_register: '1',
  // AI model management (/admin/ai)
  ai_enabled: String(process.env.AI_ENABLED || 'true').toLowerCase() === 'false' ? '0' : '1',
  ai_base_url: process.env.AI_BASE_URL || 'http://127.0.0.1:11434/v1',   // built-in Ollama (same container)
  ai_api_key: process.env.AI_API_KEY || '',
  ai_timeout_sec: process.env.AI_TIMEOUT_SEC || '300',
  ai_model: '',               // active model ('' = default qwen3:4b / AI_MODEL env)
  ai_notice: '{}',            // {updates:[], recos:[], checked_at}
  ai_reco_seen: '[]',
  ai_recommend_url: '',       // '' = derive from github_url → raw .../main/ai-models.json
};

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...SETTING_DEFAULTS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}
function setSetting(key, value) {
  if (!(key in SETTING_DEFAULTS)) return;
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value ?? ''));
}

// ---------- Markdown (safe) ----------
function md(src) {
  const html = marked.parse(String(src || ''), { breaks: true });
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'u', 's']),
    allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width'], '*': ['class'] },
    transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
  });
}

// ---------- Video embed (no file hosting — only links) ----------
function videoEmbed(url) {
  url = String(url || '').trim();
  if (!url) return null;
  let m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
  if (m) return { kind: 'youtube', id: m[1], src: `https://www.youtube.com/embed/${m[1]}?enablejsapi=1&rel=0` };
  m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) return { kind: 'vimeo', src: `https://player.vimeo.com/video/${m[1]}` };
  m = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  if (m) return { kind: 'gdrive', src: `https://drive.google.com/file/d/${m[1]}/preview` };
  m = url.match(/facebook\.com\/.+\/videos\//);
  if (m) return { kind: 'facebook', src: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}` };
  if (/\.(mp4|webm|ogg)(\?|$)/i.test(url)) return { kind: 'file', src: url };
  if (/^https?:\/\//i.test(url)) return { kind: 'iframe', src: url };
  return null;
}
const youtubeId = (url) => { const e = videoEmbed(url); return e && e.kind === 'youtube' ? e.id : null; };

const safeUrl = (u) => /^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '';

function fmtBytes(b) {
  b = Number(b) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleString('th-TH', { timeZone: process.env.TZ || 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Custom share links (e.g. /c/OS2569, /t/OS-MIDTERM): letters, digits, - and _ ; 3–40 chars; unique ignoring case
function slugError(slug, table, selfId) {
  const { db } = require('./db');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(slug)) return 'ลิงก์ต้องยาว 3–40 ตัว ใช้ได้เฉพาะ a–z, 0–9, - และ _ (ห้ามเว้นวรรค/ภาษาไทย)';
  if (db.prepare(`SELECT id FROM ${table} WHERE share_token=? COLLATE NOCASE AND id<>?`).get(slug, selfId)) return `ลิงก์ “${slug}” มีคนใช้แล้ว ลองชื่ออื่น`;
  return null;
}
module.exports = { slugError, token, parseJSON, getSettings, setSetting, SETTING_DEFAULTS, md, videoEmbed, youtubeId, safeUrl, fmtBytes, fmtDate, round2 };

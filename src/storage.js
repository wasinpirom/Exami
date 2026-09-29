// File storage with per-user quota (default 100MB). Files are charged to the EXAM OWNER
// (question images + students' answer files for that owner's exams).
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db, DATA_DIR } = require('./db');
const { getSettings, token } = require('./util');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

function quotaBytes(userId) {
  const u = db.prepare('SELECT quota_mb FROM users WHERE id=?').get(userId);
  const mb = (u && u.quota_mb != null) ? u.quota_mb : Number(getSettings().default_quota_mb || 100);
  return mb * 1024 * 1024;
}
function usedBytes(userId) {
  return db.prepare('SELECT COALESCE(SUM(size),0) s FROM files WHERE owner_id=?').get(userId).s;
}
function usage(userId) {
  const used = usedBytes(userId), quota = quotaBytes(userId);
  return { used, quota, percent: Math.min(100, Math.round((used / quota) * 100)) };
}

const upload = () => multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, f, cb) => cb(null, Date.now() + '-' + token(12) + path.extname(f.originalname).toLowerCase().replace(/[^.\w]/g, '')),
  }),
  limits: { fileSize: Number(getSettings().max_upload_mb || 20) * 1024 * 1024, files: 1 },
});

// Save uploaded file record after checking quota; deletes file & throws if quota exceeded.
function registerFile({ file, ownerId, kind, attemptId = null }) {
  const { used, quota } = usage(ownerId);
  if (used + file.size > quota) {
    fs.unlink(file.path, () => {});
    const line = getSettings().contact_line;
    const e = new Error(`พื้นที่เก็บไฟล์เต็มแล้ว (สูงสุด ${Math.round(quota / 1048576)}MB) — ต้องการเพิ่มพื้นที่ ติดต่อ LINE OA: ${line}`);
    e.status = 413;
    throw e;
  }
  const origName = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const r = db.prepare(`INSERT INTO files(owner_id,attempt_id,kind,orig_name,mime,size,stored_name) VALUES(?,?,?,?,?,?,?)`)
    .run(ownerId, attemptId, kind, origName, file.mimetype || 'application/octet-stream', file.size, file.filename);
  return db.prepare('SELECT * FROM files WHERE id=?').get(r.lastInsertRowid);
}

function deleteFile(id) {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(id);
  if (!f) return;
  fs.unlink(path.join(UPLOAD_DIR, f.stored_name), () => {});
  db.prepare('DELETE FROM files WHERE id=?').run(id);
}

// Remove physical files whose DB rows are gone (after cascaded deletes)
function cleanupOrphans() {
  try {
    const known = new Set(db.prepare('SELECT stored_name FROM files').all().map(r => r.stored_name));
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      if (known.has(f)) continue;
      const p = path.join(UPLOAD_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.unlink(p, () => {});
    }
  } catch (e) { console.error('cleanup', e.message); }
}

module.exports = { UPLOAD_DIR, upload, registerFile, deleteFile, usage, cleanupOrphans };

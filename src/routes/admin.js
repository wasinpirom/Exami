const express = require('express');
const { db } = require('../db');
const { requireLogin, requireAdmin, hash } = require('../auth');
const { getSettings, setSetting, SETTING_DEFAULTS } = require('../util');
const { usage } = require('../storage');
const ai = require('../ai');
const models = require('../models');

const r = express.Router();
r.use('/admin', requireLogin, requireAdmin);
r.use('/api/admin', requireLogin, requireAdmin);

r.get('/admin', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const users = db.prepare(`SELECT u.*, (SELECT COALESCE(SUM(size),0) FROM files f WHERE f.owner_id=u.id) used,
      (SELECT COUNT(*) FROM exams e WHERE e.owner_id=u.id) exams, (SELECT COUNT(*) FROM courses c WHERE c.owner_id=u.id) courses
    FROM users u WHERE (?='' OR u.email LIKE ? OR u.name LIKE ?) ORDER BY used DESC, u.id DESC LIMIT 300`).all(q, `%${q}%`, `%${q}%`);
  const def = Number(getSettings().default_quota_mb);
  const totals = {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    exams: db.prepare('SELECT COUNT(*) c FROM exams').get().c,
    attempts: db.prepare('SELECT COUNT(*) c FROM attempts').get().c,
    courses: db.prepare('SELECT COUNT(*) c FROM courses').get().c,
    storage: db.prepare('SELECT COALESCE(SUM(size),0) s FROM files').get().s,
    jobs: db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status IN ('queued','running')`).get().c,
  };
  res.render('admin', { title: 'ผู้ดูแลระบบ', users, def, totals, q, aiStatus: await ai.status(), msg: req.query.msg || null });
});

r.post('/admin/users/:id', (req, res) => {
  const b = req.body; const id = Number(req.params.id);
  if (b.quota_mb !== undefined) db.prepare('UPDATE users SET quota_mb=? WHERE id=?').run(b.quota_mb === '' ? null : Math.max(0, parseInt(b.quota_mb) || 0), id);
  if (b.role && ['user', 'admin'].includes(b.role) && id !== req.user.id) db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, id);
  if (b.toggle_disabled && id !== req.user.id) db.prepare('UPDATE users SET disabled=1-disabled WHERE id=?').run(id);
  if (b.new_password && String(b.new_password).length >= 6) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash(String(b.new_password)), id);
  res.redirect('/admin?msg=' + encodeURIComponent('บันทึกแล้ว'));
});

r.post('/admin/users/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.redirect('/admin?msg=' + encodeURIComponent('ลบบัญชีตัวเองไม่ได้'));
  db.prepare('DELETE FROM users WHERE id=?').run(id);   // cascades exams, courses, files rows (physical files cleaned periodically)
  res.redirect('/admin?msg=' + encodeURIComponent('ลบผู้ใช้แล้ว'));
});

r.get('/admin/settings', (req, res) => res.render('admin_settings', { title: 'ตั้งค่าเว็บไซต์', s: getSettings(), keys: Object.keys(SETTING_DEFAULTS), saved: !!req.query.saved }));
r.post('/admin/settings', (req, res) => {
  for (const k of Object.keys(SETTING_DEFAULTS)) {
    if (['allow_register', 'ai_enabled'].includes(k)) setSetting(k, req.body[k] ? '1' : '0');
    else if (k === 'ai_api_key' && req.body[k] === '********') continue;          // unchanged secret
    else if (['ai_notice', 'ai_reco_seen', 'ai_model'].includes(k)) continue;     // managed elsewhere
    else if (req.body[k] !== undefined) setSetting(k, req.body[k]);
  }
  res.redirect('/admin/settings?saved=1');
});

// ---------- AI model management ----------
r.get('/admin/ai', async (req, res) => {
  models.markRecosSeen();
  res.render('admin_ai', { title: 'จัดการโมเดล AI', aiEnabled: ai.AI.enabled, ollama: models.ollamaUrl() });
});

async function aiState() {
  const hw = models.hardware();
  let installed = [], error = null;
  try { installed = await models.listInstalled(); } catch (e) { error = e.message; }
  const { data, source } = await models.recommendations();
  const have = new Set(installed.map(m => models.normalizeName(m.name)));
  const notice = models.notice();
  return {
    active: ai.AI.model, envModel: ai.AI.envModel, error, hardware: hw, source, updatedList: data.updated || '',
    installed: installed.map(m => ({ ...m, active: models.normalizeName(m.name) === models.normalizeName(ai.AI.model), hasUpdate: (notice.updates || []).includes(m.name) })),
    recos: (data.models || []).map(m => ({ ...m, installed: have.has(models.normalizeName(m.name)), fit: models.fit(m, hw), isNew: (notice.recos || []).includes(m.name) })),
    pulls: models.pullStatus(), checked_at: notice.checked_at || null,
  };
}
r.get('/api/admin/ai/state', async (req, res) => res.json(await aiState()));
r.post('/api/admin/ai/pull', (req, res) => res.json(models.pull(String((req.body || {}).name || ''))));
r.post('/api/admin/ai/use', async (req, res) => {
  const name = String((req.body || {}).name || '');
  const installed = await models.listInstalled();
  if (!installed.some(m => models.normalizeName(m.name) === models.normalizeName(name))) return res.status(400).json({ error: 'ต้องดาวน์โหลดโมเดลนี้ก่อน' });
  setSetting('ai_model', name.replace(/:latest$/, ''));
  models.warmUp(name);
  res.json(await aiState());
});
r.post('/api/admin/ai/delete', async (req, res) => { await models.remove(String((req.body || {}).name || '')); res.json(await aiState()); });
r.post('/api/admin/ai/test', (req, res) => res.json({ job_id: ai.enqueue(req.user.id, 'test_model', { model: String((req.body || {}).name || ai.AI.model) }) }));
r.post('/api/admin/ai/check', async (req, res) => { await models.runCheck(); res.json(await aiState()); });

r.get('/api/admin/ai/log', (req, res) => res.json({ log: models.ollamaLog(120) }));

module.exports = r;

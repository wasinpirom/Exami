const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { loadUser } = require('./auth');
const { getSettings, fmtBytes, fmtDate, md } = require('./util');
const { cleanupOrphans } = require('./storage');

const app = express();
app.set('trust proxy', 1);                 // behind Coolify / Traefik
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));
app.get('/vendor/alpine.js', (req, res) => res.sendFile(require.resolve('alpinejs/dist/cdn.min.js'), { maxAge: '7d' }));
app.get('/vendor/qrcode.js', (req, res) => res.sendFile(require.resolve('qrcode-generator'), { maxAge: '7d' }));
app.use(loadUser);

// Globals for all views
app.use((req, res, next) => {
  res.locals.site = getSettings();
  res.locals.fmtBytes = fmtBytes;
  res.locals.fmtDate = fmtDate;
  res.locals.md = md;
  res.locals.ver = require('../package.json').version;   // cache-busting for static files after updates
  res.locals.path = req.path;
  res.locals.baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.locals.aiNotices = req.user && req.user.role === 'admin' ? require('./models').noticeCount() : 0;
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(require('./routes/public'));
app.use(require('./routes/take'));
app.use(require('./routes/exams'));
app.use(require('./routes/courses'));
app.use(require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'ไม่พบหน้านี้', message: 'ลิงก์อาจไม่ถูกต้อง หรือถูกลบไปแล้ว' }));
app.use((err, req, res, next) => {
  Object.assign(res.locals, { site: res.locals.site || getSettings(), fmtBytes, fmtDate, md, ver: require('../package.json').version, path: req.path, user: req.user || null, baseUrl: '' });
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  const message = err.code === 'LIMIT_FILE_SIZE' ? `ไฟล์ใหญ่เกินไป (สูงสุด ${getSettings().max_upload_mb}MB ต่อไฟล์)` : (status === 500 ? 'เกิดข้อผิดพลาดในระบบ' : err.message);
  if (status === 500) console.error(err);
  if (req.originalUrl.startsWith('/api/') || req.xhr || (req.get('accept') || '').includes('json')) return res.status(status).json({ error: message });
  res.status(status).render('error', { title: 'เกิดข้อผิดพลาด', message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Exami running on http://localhost:${PORT}`));
setInterval(cleanupOrphans, 6 * 3600e3);
require('./models').startScheduler();
setTimeout(cleanupOrphans, 60e3);

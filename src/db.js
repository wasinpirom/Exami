// SQLite database (single file, zero-config) — stored in DATA_DIR/exami.db
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'exami.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',          -- user | admin
  quota_mb INTEGER,                            -- NULL = use site default
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',
  is_open INTEGER NOT NULL DEFAULT 1,          -- accepting attempts
  share_token TEXT UNIQUE NOT NULL,
  in_library INTEGER NOT NULL DEFAULT 0,       -- shared as a template in public library
  category TEXT NOT NULL DEFAULT '',
  source_exam_id INTEGER,                      -- copied from
  source_owner_name TEXT,
  copy_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  image_file_id INTEGER,
  points REAL NOT NULL DEFAULT 1,
  data TEXT NOT NULL DEFAULT '{}',
  explanation TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  taker_name TEXT NOT NULL,
  taker_ident TEXT NOT NULL DEFAULT '',
  token TEXT UNIQUE NOT NULL,
  question_order TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  deadline_at TEXT,
  submitted_at TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress | submitted
  score REAL NOT NULL DEFAULT 0,
  max_score REAL NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,    -- answers waiting for grading
  tab_switches INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  response TEXT NOT NULL DEFAULT 'null',
  auto_score REAL,
  ai_score REAL,
  ai_feedback TEXT,
  manual_score REAL,
  comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',      -- auto | pending | ai | graded
  UNIQUE(attempt_id, question_id)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- whose quota
  attempt_id INTEGER REFERENCES attempts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                          -- question_image | answer_file
  orig_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  stored_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',
  share_token TEXT UNIQUE NOT NULL,
  require_approval INTEGER NOT NULL DEFAULT 1,
  is_listed INTEGER NOT NULL DEFAULT 0,        -- show in public catalog
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  video_url TEXT NOT NULL DEFAULT '',
  content_md TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '[]',
  exam_id INTEGER REFERENCES exams(id) ON DELETE SET NULL,
  is_preview INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  invited_email TEXT,                          -- invited before registering
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(course_id, user_id)
);

CREATE TABLE IF NOT EXISTS lesson_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  first_viewed_at TEXT,
  last_viewed_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  watch_percent INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  PRIMARY KEY(user_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',       -- queued | running | done | error
  input TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_q_exam ON questions(exam_id, position);
CREATE INDEX IF NOT EXISTS idx_att_exam ON attempts(exam_id);
CREATE INDEX IF NOT EXISTS idx_att_user ON attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_ans_att ON answers(attempt_id);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);
CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id, position);
CREATE INDEX IF NOT EXISTS idx_enr_course ON enrollments(course_id);
CREATE INDEX IF NOT EXISTS idx_enr_email ON enrollments(invited_email);
`);

// ---- lightweight migrations (add columns to existing installs) ----
function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('attempts', 'last_activity', 'TEXT');

// Jobs left "running" from a previous crash → mark as error
db.prepare(`UPDATE jobs SET status='error', error='server restarted' WHERE status IN ('queued','running')`).run();

module.exports = { db, DATA_DIR };

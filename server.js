const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const BACKGROUNDS_DIR = path.join(UPLOADS_DIR, 'backgrounds');
const DATABASE_PATH = path.resolve(ROOT_DIR, process.env.DATABASE_PATH || './data/my-home.sqlite');
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const MAX_BACKGROUND_SIZE = 5 * 1024 * 1024;
const LOGIN_MAX_FAILED_ATTEMPTS = parseIntegerEnv(process.env.LOGIN_MAX_FAILED_ATTEMPTS, 5, 1);
const LOGIN_WINDOW_MS = parseIntegerEnv(process.env.LOGIN_WINDOW_MS, 15 * 60 * 1000, 1000);
const LOGIN_LOCKOUT_MS = parseIntegerEnv(process.env.LOGIN_LOCKOUT_MS, 15 * 60 * 1000, 1000);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const USER_ID = 1;
const loginAttempts = new Map();

if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error('Missing required environment variables: ADMIN_USERNAME, ADMIN_PASSWORD, SESSION_SECRET');
  console.error('Copy .env.example to .env and set secure values before starting the server.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });

const db = new DatabaseSync(DATABASE_PATH);
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY,
    layout_columns INTEGER NOT NULL DEFAULT 0 CHECK (layout_columns >= 0 AND layout_columns <= 6),
    edit_mode INTEGER NOT NULL DEFAULT 0 CHECK (edit_mode IN (0, 1)),
    background_url TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS nav_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_nav_links_user_sort ON nav_links(user_id, sort_order, id);

  CREATE TABLE IF NOT EXISTS search_engines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    url_template TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_search_engines_user_sort ON search_engines(user_id, sort_order, id);
`);

function ensureAdminUser() {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(USER_ID);
  const passwordMatches = existing ? bcrypt.compareSync(ADMIN_PASSWORD, existing.password_hash) : false;

  if (!existing) {
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(
      USER_ID,
      ADMIN_USERNAME,
      bcrypt.hashSync(ADMIN_PASSWORD, 12)
    );
  } else if (existing.username !== ADMIN_USERNAME || !passwordMatches) {
    db.prepare(
      'UPDATE users SET username = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(ADMIN_USERNAME, bcrypt.hashSync(ADMIN_PASSWORD, 12), USER_ID);
  }

  db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(USER_ID);
}

ensureAdminUser();

function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  return title.trim().slice(0, 80);
}

function parseIntegerEnv(value, fallback, minimum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum) return fallback;
  return parsed;
}

function normalizeUrl(url) {
  if (typeof url !== 'string') return '';
  return url.trim().slice(0, 1000);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isBackgroundUrl(value) {
  if (value === '') return true;
  if (value.startsWith('/uploads/backgrounds/')) return !value.includes('..');
  return isHttpUrl(value);
}

function serializeSettings(row) {
  return {
    layoutColumns: row.layout_columns,
    editMode: Boolean(row.edit_mode),
    backgroundUrl: row.background_url || ''
  };
}

function getSettings() {
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(USER_ID);
  return serializeSettings(row);
}

function getLinks() {
  return db.prepare(
    'SELECT id, title, url FROM nav_links WHERE user_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(USER_ID);
}

function getSearchEngines() {
  return db.prepare(
    'SELECT id, name, url_template AS urlTemplate FROM search_engines WHERE user_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(USER_ID);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId === USER_ID) {
    next();
    return;
  }
  res.status(401).json({ error: '未登录' });
}

function getLoginAttemptKey(req, username) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const normalizedUsername = (username || 'unknown').toLowerCase();
  return `${ip}:${normalizedUsername}`;
}

function pruneLoginAttempts(now = Date.now()) {
  if (loginAttempts.size < 1000) return;

  for (const [key, state] of loginAttempts.entries()) {
    const windowExpired = now - state.firstFailedAt > LOGIN_WINDOW_MS;
    const lockExpired = state.lockedUntil <= now;
    if (windowExpired && lockExpired) {
      loginAttempts.delete(key);
    }
  }
}

function getActiveLoginAttemptState(key) {
  const now = Date.now();
  const state = loginAttempts.get(key);
  if (!state) return null;

  if (state.lockedUntil > now) return state;

  if (now - state.firstFailedAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return null;
  }

  return state;
}

function recordFailedLogin(key) {
  const now = Date.now();
  pruneLoginAttempts(now);

  let state = loginAttempts.get(key);
  if (!state || now - state.firstFailedAt > LOGIN_WINDOW_MS) {
    state = {
      failedCount: 0,
      firstFailedAt: now,
      lockedUntil: 0
    };
  }

  state.failedCount += 1;
  if (state.failedCount >= LOGIN_MAX_FAILED_ATTEMPTS) {
    state.lockedUntil = now + LOGIN_LOCKOUT_MS;
  }

  loginAttempts.set(key, state);
  return state;
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key);
}

function getRetryAfterSeconds(state) {
  return Math.max(1, Math.ceil((state.lockedUntil - Date.now()) / 1000));
}

function sendLoginLockedResponse(res, state) {
  const retryAfterSeconds = getRetryAfterSeconds(state);
  const retryAfterText = retryAfterSeconds < 60
    ? `${retryAfterSeconds} 秒`
    : `${Math.ceil(retryAfterSeconds / 60)} 分钟`;
  res.set('Retry-After', String(retryAfterSeconds));
  res.status(429).json({
    error: `登录失败次数过多，请 ${retryAfterText}后再试`
  });
}

function validateLinkPayload(req, res) {
  const title = normalizeTitle(req.body.title);
  const url = normalizeUrl(req.body.url);

  if (!title) {
    res.status(400).json({ error: '请填写显示名称' });
    return null;
  }

  if (!url || !isHttpUrl(url)) {
    res.status(400).json({ error: '链接地址必须是 http 或 https URL' });
    return null;
  }

  return { title, url };
}

function normalizeSearchEngineName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().slice(0, 40);
}

function normalizeSearchUrlTemplate(urlTemplate) {
  if (typeof urlTemplate !== 'string') return '';
  return urlTemplate.trim().slice(0, 1000);
}

function isValidSearchUrlTemplate(urlTemplate) {
  if (!urlTemplate) return false;
  try {
    const sampleUrl = urlTemplate.replaceAll('{query}', 'test');
    const parsedUrl = new URL(sampleUrl);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateSearchEnginePayload(req, res) {
  const name = normalizeSearchEngineName(req.body.name);
  const urlTemplate = normalizeSearchUrlTemplate(req.body.urlTemplate);

  if (!name) {
    res.status(400).json({ error: '请填写搜索引擎名称' });
    return null;
  }

  if (!isValidSearchUrlTemplate(urlTemplate)) {
    res.status(400).json({ error: '搜索地址必须是 http 或 https URL' });
    return null;
  }

  return { name, urlTemplate };
}

function deleteLocalBackground(backgroundUrl) {
  if (!backgroundUrl || !backgroundUrl.startsWith('/uploads/backgrounds/')) return;

  const relativePath = backgroundUrl.replace(/^\/uploads\//, '');
  const fullPath = path.resolve(UPLOADS_DIR, relativePath);
  if (!fullPath.startsWith(BACKGROUNDS_DIR)) return;

  fs.promises.unlink(fullPath).catch((error) => {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to delete old background:', error.message);
    }
  });
}

const app = express();
app.set('trust proxy', TRUST_PROXY);

app.use(express.json({ limit: '64kb' }));
app.use(session({
  name: 'my_home_sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

app.use('/uploads', express.static(UPLOADS_DIR, {
  dotfiles: 'deny',
  fallthrough: false,
  maxAge: '7d'
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.get('/style.css', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'style.css'));
});

app.get('/script.js', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'script.js'));
});

app.post('/api/login', (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const attemptKey = getLoginAttemptKey(req, username);
  const activeAttemptState = getActiveLoginAttemptState(attemptKey);

  if (activeAttemptState?.lockedUntil > Date.now()) {
    sendLoginLockedResponse(res, activeAttemptState);
    return;
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ? AND username = ?').get(USER_ID, username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const failedState = recordFailedLogin(attemptKey);
    if (failedState.lockedUntil > Date.now()) {
      sendLoginLockedResponse(res, failedState);
      return;
    }

    res.status(401).json({ error: '账号或密码不正确' });
    return;
  }

  clearLoginAttempts(attemptKey);

  req.session.regenerate((error) => {
    if (error) {
      res.status(500).json({ error: '登录失败，请重试' });
      return;
    }

    req.session.userId = USER_ID;
    res.json({ user: { username: user.username } });
  });
});

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      res.status(500).json({ error: '退出失败，请重试' });
      return;
    }
    res.clearCookie('my_home_sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.userId === USER_ID) {
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(USER_ID);
    res.json({ authenticated: true, user });
    return;
  }
  res.json({ authenticated: false });
});

app.get('/api/settings', requireAuth, (req, res) => {
  res.json({ settings: getSettings() });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const current = getSettings();
  const next = {
    layoutColumns: current.layoutColumns,
    editMode: current.editMode,
    backgroundUrl: current.backgroundUrl
  };

  if (Object.prototype.hasOwnProperty.call(req.body, 'layoutColumns')) {
    const layoutColumns = Number.parseInt(req.body.layoutColumns, 10);
    if (!Number.isInteger(layoutColumns) || layoutColumns < 0 || layoutColumns > 6) {
      res.status(400).json({ error: '布局列数必须在 0 到 6 之间' });
      return;
    }
    next.layoutColumns = layoutColumns;
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'editMode')) {
    next.editMode = Boolean(req.body.editMode);
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'backgroundUrl')) {
    const backgroundUrl = normalizeUrl(req.body.backgroundUrl || '');
    if (!isBackgroundUrl(backgroundUrl)) {
      res.status(400).json({ error: '背景地址必须是 http/https URL 或上传文件路径' });
      return;
    }
    next.backgroundUrl = backgroundUrl;
  }

  db.prepare(`
    UPDATE user_settings
    SET layout_columns = ?, edit_mode = ?, background_url = ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(next.layoutColumns, next.editMode ? 1 : 0, next.backgroundUrl, USER_ID);

  if (current.backgroundUrl !== next.backgroundUrl) {
    deleteLocalBackground(current.backgroundUrl);
  }

  res.json({ settings: getSettings() });
});

app.get('/api/search-engines', requireAuth, (req, res) => {
  res.json({ engines: getSearchEngines() });
});

app.post('/api/search-engines', requireAuth, (req, res) => {
  const payload = validateSearchEnginePayload(req, res);
  if (!payload) return;

  const row = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM search_engines WHERE user_id = ?'
  ).get(USER_ID);

  db.prepare(
    'INSERT INTO search_engines (user_id, name, url_template, sort_order) VALUES (?, ?, ?, ?)'
  ).run(USER_ID, payload.name, payload.urlTemplate, row.next_order);

  res.status(201).json({ engines: getSearchEngines() });
});

app.put('/api/search-engines/:id', requireAuth, (req, res) => {
  const payload = validateSearchEnginePayload(req, res);
  if (!payload) return;

  const result = db.prepare(`
    UPDATE search_engines
    SET name = ?, url_template = ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND id = ?
  `).run(payload.name, payload.urlTemplate, USER_ID, req.params.id);

  if (Number(result.changes) === 0) {
    res.status(404).json({ error: '搜索引擎不存在' });
    return;
  }

  res.json({ engines: getSearchEngines() });
});

app.delete('/api/search-engines/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM search_engines WHERE user_id = ? AND id = ?').run(USER_ID, req.params.id);
  if (Number(result.changes) === 0) {
    res.status(404).json({ error: '搜索引擎不存在' });
    return;
  }

  res.json({ engines: getSearchEngines() });
});

app.get('/api/links', requireAuth, (req, res) => {
  res.json({ links: getLinks() });
});

app.post('/api/links', requireAuth, (req, res) => {
  const payload = validateLinkPayload(req, res);
  if (!payload) return;

  const row = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM nav_links WHERE user_id = ?').get(USER_ID);
  db.prepare(
    'INSERT INTO nav_links (user_id, title, url, sort_order) VALUES (?, ?, ?, ?)'
  ).run(USER_ID, payload.title, payload.url, row.next_order);

  res.status(201).json({ links: getLinks() });
});

app.put('/api/links/reorder', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => Number.parseInt(id, 10)) : [];
  const currentIds = getLinks().map((link) => link.id);
  const currentSet = new Set(currentIds);
  const uniqueIds = new Set(ids);

  if (ids.length !== currentIds.length || uniqueIds.size !== currentIds.length || ids.some((id) => !currentSet.has(id))) {
    res.status(400).json({ error: '排序数据无效' });
    return;
  }

  try {
    db.exec('BEGIN');
    const statement = db.prepare('UPDATE nav_links SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?');
    ids.forEach((id, index) => statement.run(index, USER_ID, id));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  res.json({ links: getLinks() });
});

app.put('/api/links/:id', requireAuth, (req, res) => {
  const payload = validateLinkPayload(req, res);
  if (!payload) return;

  const result = db.prepare(
    'UPDATE nav_links SET title = ?, url = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?'
  ).run(payload.title, payload.url, USER_ID, req.params.id);

  if (Number(result.changes) === 0) {
    res.status(404).json({ error: '链接不存在' });
    return;
  }

  res.json({ links: getLinks() });
});

app.delete('/api/links/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM nav_links WHERE user_id = ? AND id = ?').run(USER_ID, req.params.id);
  if (Number(result.changes) === 0) {
    res.status(404).json({ error: '链接不存在' });
    return;
  }
  res.json({ links: getLinks() });
});

const allowedImageTypes = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif']
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, callback) => callback(null, BACKGROUNDS_DIR),
    filename: (req, file, callback) => {
      const extension = allowedImageTypes.get(file.mimetype);
      callback(null, `${crypto.randomUUID()}${extension}`);
    }
  }),
  limits: {
    fileSize: MAX_BACKGROUND_SIZE,
    files: 1
  },
  fileFilter: (req, file, callback) => {
    if (!allowedImageTypes.has(file.mimetype)) {
      callback(new Error('只支持 JPG、PNG、WebP 或 GIF 图片'));
      return;
    }
    callback(null, true);
  }
});

app.post('/api/background', requireAuth, (req, res) => {
  upload.single('background')(req, res, (error) => {
    if (error) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? '图片文件不能超过 5MB' : error.message;
      res.status(400).json({ error: message });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: '请选择图片文件' });
      return;
    }

    const current = getSettings();
    const backgroundUrl = `/uploads/backgrounds/${req.file.filename}`;

    db.prepare(`
      UPDATE user_settings
      SET background_url = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(backgroundUrl, USER_ID);

    if (current.backgroundUrl !== backgroundUrl) {
      deleteLocalBackground(current.backgroundUrl);
    }

    res.status(201).json({ settings: getSettings() });
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.listen(PORT, HOST, () => {
  console.log(`Personal homepage server running at http://${HOST}:${PORT}`);
});

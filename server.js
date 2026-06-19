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
const ICON_CACHE_DIR = path.join(DATA_DIR, 'icon-cache');
const DATABASE_PATH = path.resolve(ROOT_DIR, process.env.DATABASE_PATH || './data/my-home.sqlite');
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_COOKIE_SECURE = parseBooleanEnv(
  process.env.SESSION_COOKIE_SECURE,
  process.env.NODE_ENV === 'production'
);
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_BACKGROUND_SIZE = 10 * 1024 * 1024;
const MAX_ICON_SIZE = 1024 * 1024;
const ICON_FETCH_TIMEOUT_MS = 5000;
const ICON_HTML_SAMPLE_SIZE = 128 * 1024;
const LOGIN_MAX_FAILED_ATTEMPTS = parseIntegerEnv(process.env.LOGIN_MAX_FAILED_ATTEMPTS, 5, 1);
const LOGIN_WINDOW_MS = parseIntegerEnv(process.env.LOGIN_WINDOW_MS, 15 * 60 * 1000, 1000);
const LOGIN_LOCKOUT_MS = parseIntegerEnv(process.env.LOGIN_LOCKOUT_MS, 15 * 60 * 1000, 1000);
const TRUST_PROXY = parseBooleanEnv(process.env.TRUST_PROXY, false);
const USER_ID = 1;
const loginAttempts = new Map();
const DEFAULT_SEARCH_ENGINES = [
  {
    engineKey: 'google',
    name: 'Google',
    urlTemplate: 'https://www.google.com/search?q={query}'
  },
  {
    engineKey: 'youtube',
    name: 'YouTube',
    urlTemplate: 'https://www.youtube.com/results?search_query={query}'
  },
  {
    engineKey: 'github',
    name: 'GitHub',
    urlTemplate: 'https://github.com/search?q={query}'
  },
  {
    engineKey: 'bilibili',
    name: '哔哩哔哩',
    urlTemplate: 'https://search.bilibili.com/all?keyword={query}'
  }
];
const REQUIRED_SEARCH_ENGINE_KEYS = new Set(['google']);
const DEFAULT_EMAIL_LINK = {
  linkKey: 'google-mail',
  title: 'Google',
  url: 'https://mail.google.com/'
};
const REQUIRED_LINK_KEYS = new Set([DEFAULT_EMAIL_LINK.linkKey]);

if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error('Missing required environment variables: ADMIN_USERNAME, ADMIN_PASSWORD, SESSION_SECRET');
  console.error('Copy .env.example to .env and set secure values before starting the server.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });
fs.mkdirSync(ICON_CACHE_DIR, { recursive: true });

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
    project_layout_columns INTEGER NOT NULL DEFAULT 0 CHECK (project_layout_columns >= 0 AND project_layout_columns <= 6),
    edit_mode INTEGER NOT NULL DEFAULT 0 CHECK (edit_mode IN (0, 1)),
    project_link_display_mode TEXT NOT NULL DEFAULT 'centered',
    bookmark_link_display_mode TEXT NOT NULL DEFAULT 'default',
    project_link_size TEXT NOT NULL DEFAULT 'medium',
    bookmark_link_size TEXT NOT NULL DEFAULT 'medium',
    background_url TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS nav_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    link_key TEXT,
    link_type TEXT NOT NULL DEFAULT 'website',
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
    engine_key TEXT,
    name TEXT NOT NULL,
    url_template TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_search_engines_user_sort ON search_engines(user_id, sort_order, id);

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
`);

function ensureNavLinkSchema() {
  const columns = db.prepare('PRAGMA table_info(nav_links)').all();
  const hasLinkType = columns.some((column) => column.name === 'link_type');
  if (!hasLinkType) {
    db.exec("ALTER TABLE nav_links ADD COLUMN link_type TEXT NOT NULL DEFAULT 'website'");
  }

  const hasLinkKey = columns.some((column) => column.name === 'link_key');
  if (!hasLinkKey) {
    db.exec('ALTER TABLE nav_links ADD COLUMN link_key TEXT');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_nav_links_user_type_sort
    ON nav_links(user_id, link_type, sort_order, id)
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nav_links_user_key
    ON nav_links(user_id, link_key)
    WHERE link_key IS NOT NULL
  `);
}

function ensureUserSettingsSchema() {
  const columns = db.prepare('PRAGMA table_info(user_settings)').all();
  const hasProjectLayoutColumns = columns.some((column) => column.name === 'project_layout_columns');
  const hasProjectLinkDisplayMode = columns.some((column) => column.name === 'project_link_display_mode');
  const hasBookmarkLinkDisplayMode = columns.some((column) => column.name === 'bookmark_link_display_mode');
  const hasProjectLinkSize = columns.some((column) => column.name === 'project_link_size');
  const hasBookmarkLinkSize = columns.some((column) => column.name === 'bookmark_link_size');

  if (!hasProjectLayoutColumns) {
    db.exec('ALTER TABLE user_settings ADD COLUMN project_layout_columns INTEGER NOT NULL DEFAULT 0');
  }

  if (!hasProjectLinkDisplayMode) {
    db.exec("ALTER TABLE user_settings ADD COLUMN project_link_display_mode TEXT NOT NULL DEFAULT 'centered'");
  }

  if (!hasBookmarkLinkDisplayMode) {
    db.exec("ALTER TABLE user_settings ADD COLUMN bookmark_link_display_mode TEXT NOT NULL DEFAULT 'default'");
  }

  if (!hasProjectLinkSize) {
    db.exec("ALTER TABLE user_settings ADD COLUMN project_link_size TEXT NOT NULL DEFAULT 'medium'");
  }

  if (!hasBookmarkLinkSize) {
    db.exec("ALTER TABLE user_settings ADD COLUMN bookmark_link_size TEXT NOT NULL DEFAULT 'medium'");
  }
}

function ensureSearchEngineSchema() {
  const columns = db.prepare('PRAGMA table_info(search_engines)').all();
  const hasEngineKey = columns.some((column) => column.name === 'engine_key');
  if (!hasEngineKey) {
    db.exec('ALTER TABLE search_engines ADD COLUMN engine_key TEXT');
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_search_engines_user_key
    ON search_engines(user_id, engine_key)
    WHERE engine_key IS NOT NULL
  `);
}

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

function ensureDefaultEmailLink() {
  const existingByKey = db.prepare('SELECT id FROM nav_links WHERE user_id = ? AND link_key = ?')
    .get(USER_ID, DEFAULT_EMAIL_LINK.linkKey);
  if (existingByKey) return;

  const existingEmailRow = db.prepare(`
    SELECT id
    FROM nav_links
    WHERE user_id = ? AND link_type = 'email' AND link_key IS NULL AND url = ?
    ORDER BY sort_order ASC, id ASC
    LIMIT 1
  `).get(USER_ID, DEFAULT_EMAIL_LINK.url);

  if (existingEmailRow) {
    db.prepare(`
      UPDATE nav_links
      SET link_key = ?, title = ?, link_type = 'email', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id = ?
    `).run(DEFAULT_EMAIL_LINK.linkKey, DEFAULT_EMAIL_LINK.title, USER_ID, existingEmailRow.id);
    return;
  }

  const row = db.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM nav_links WHERE user_id = ? AND link_type = 'email'"
  ).get(USER_ID);

  db.prepare(`
    INSERT INTO nav_links (user_id, link_key, link_type, title, url, sort_order)
    VALUES (?, ?, 'email', ?, ?, ?)
  `).run(USER_ID, DEFAULT_EMAIL_LINK.linkKey, DEFAULT_EMAIL_LINK.title, DEFAULT_EMAIL_LINK.url, row.next_order);
}

function ensureDefaultSearchEngines() {
  const existingCountRow = db.prepare('SELECT COUNT(*) AS count FROM search_engines WHERE user_id = ?').get(USER_ID);
  const shouldSeedAllDefaults = Number(existingCountRow.count) === 0;
  const existingByKey = db.prepare('SELECT id FROM search_engines WHERE user_id = ? AND engine_key = ?');
  const existingByName = db.prepare(`
    SELECT id
    FROM search_engines
    WHERE user_id = ? AND engine_key IS NULL AND lower(name) = lower(?)
    ORDER BY sort_order ASC, id ASC
    LIMIT 1
  `);
  const existingByTemplate = db.prepare(`
    SELECT id
    FROM search_engines
    WHERE user_id = ? AND engine_key IS NULL AND url_template = ?
    ORDER BY sort_order ASC, id ASC
    LIMIT 1
  `);
  const assignKey = db.prepare(`
    UPDATE search_engines
    SET engine_key = ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND id = ?
  `);
  const insertEngine = db.prepare(`
    INSERT INTO search_engines (user_id, engine_key, name, url_template, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateDefaultSort = db.prepare(`
    UPDATE search_engines
    SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND engine_key = ?
  `);
  const customRows = db.prepare(`
    SELECT id
    FROM search_engines
    WHERE user_id = ? AND engine_key IS NULL
    ORDER BY sort_order ASC, id ASC
  `);
  const updateCustomSort = db.prepare(`
    UPDATE search_engines
    SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND id = ?
  `);
  const maxSortRow = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order FROM search_engines WHERE user_id = ?'
  ).get(USER_ID);
  let nextSortOrder = Number(maxSortRow.max_sort_order) + 1;

  DEFAULT_SEARCH_ENGINES.forEach((engine) => {
    if (!shouldSeedAllDefaults && !REQUIRED_SEARCH_ENGINE_KEYS.has(engine.engineKey)) return;

    if (existingByKey.get(USER_ID, engine.engineKey)) return;

    const existingNameRow = existingByName.get(USER_ID, engine.name);
    if (existingNameRow) {
      assignKey.run(engine.engineKey, USER_ID, existingNameRow.id);
      return;
    }

    const existingTemplateRow = existingByTemplate.get(USER_ID, engine.urlTemplate);
    if (existingTemplateRow) {
      assignKey.run(engine.engineKey, USER_ID, existingTemplateRow.id);
      return;
    }

    insertEngine.run(USER_ID, engine.engineKey, engine.name, engine.urlTemplate, nextSortOrder);
    nextSortOrder += 1;
  });

  DEFAULT_SEARCH_ENGINES.forEach((engine, index) => {
    updateDefaultSort.run(index, USER_ID, engine.engineKey);
  });

  customRows.all(USER_ID).forEach((row, index) => {
    updateCustomSort.run(DEFAULT_SEARCH_ENGINES.length + index, USER_ID, row.id);
  });
}

ensureNavLinkSchema();
ensureUserSettingsSchema();
ensureSearchEngineSchema();
ensureAdminUser();
ensureDefaultEmailLink();
ensureDefaultSearchEngines();

function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  return title.trim().slice(0, 80);
}

function parseIntegerEnv(value, fallback, minimum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum) return fallback;
  return parsed;
}

function parseBooleanEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  return fallback;
}

function normalizeUrl(url) {
  if (typeof url !== 'string') return '';
  return url.trim().slice(0, 1000);
}

function normalizeLinkType(type) {
  if (type === 'email' || type === 'project') return type;
  return 'website';
}

function normalizeDisplayMode(mode, fallback = 'default') {
  if (mode === 'default' || mode === 'centered') return mode;
  return fallback;
}

function normalizeLinkSize(size, fallback = 'medium') {
  if (['small', 'medium', 'large', 'xlarge'].includes(size)) return size;
  return fallback;
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
    projectLayoutColumns: row.project_layout_columns,
    editMode: Boolean(row.edit_mode),
    projectLinkDisplayMode: normalizeDisplayMode(row.project_link_display_mode, 'centered'),
    bookmarkLinkDisplayMode: normalizeDisplayMode(row.bookmark_link_display_mode, 'default'),
    projectLinkSize: normalizeLinkSize(row.project_link_size, 'medium'),
    bookmarkLinkSize: normalizeLinkSize(row.bookmark_link_size, 'medium'),
    backgroundUrl: row.background_url || ''
  };
}

function getSettings() {
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(USER_ID);
  return serializeSettings(row);
}

function getLinks(linkType = 'website') {
  return db.prepare(
    'SELECT id, link_key AS linkKey, link_type AS linkType, title, url FROM nav_links WHERE user_id = ? AND link_type = ? ORDER BY sort_order ASC, id ASC'
  ).all(USER_ID, normalizeLinkType(linkType));
}

function getLinksResponse() {
  return {
    links: getLinks('website'),
    emailLinks: getLinks('email'),
    projectLinks: getLinks('project')
  };
}

function getSearchEngines() {
  return db.prepare(
    'SELECT id, engine_key AS engineKey, name, url_template AS urlTemplate FROM search_engines WHERE user_id = ? ORDER BY sort_order ASC, id ASC'
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
  const linkType = normalizeLinkType(req.body.type || req.body.linkType);
  const url = normalizeUrl(req.body.url);

  if (!title) {
    res.status(400).json({ error: '请填写显示名称' });
    return null;
  }

  if (!url || !isHttpUrl(url)) {
    res.status(400).json({
      error: linkType === 'email'
        ? '邮箱登录地址必须是 http 或 https URL'
        : '链接地址必须是 http 或 https URL'
    });
    return null;
  }

  return { title, url, linkType };
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

const iconContentTypeByExtension = new Map([
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif']
]);

const iconExtensionByContentType = new Map([
  ['image/x-icon', '.ico'],
  ['image/vnd.microsoft.icon', '.ico'],
  ['image/png', '.png'],
  ['image/svg+xml', '.svg'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif']
]);

function normalizeIconTargetUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;

  try {
    const parsedUrl = new URL(normalized.startsWith('http') ? normalized : `https://${normalized}`);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
    return parsedUrl.href;
  } catch {
    return null;
  }
}

function getIconCacheKey(targetUrl) {
  return crypto.createHash('sha256').update(targetUrl).digest('hex').slice(0, 48);
}

function getIconContentType(extension) {
  return iconContentTypeByExtension.get(extension) || 'image/x-icon';
}

function getIconExtensionFromUrl(candidateUrl) {
  try {
    const extension = path.extname(new URL(candidateUrl).pathname).toLowerCase();
    return iconContentTypeByExtension.has(extension) ? extension : '';
  } catch {
    return '';
  }
}

function getIconExtension(contentType, candidateUrl, buffer) {
  const normalizedContentType = (contentType || '').split(';')[0].trim().toLowerCase();
  const extensionFromType = iconExtensionByContentType.get(normalizedContentType);
  if (extensionFromType) return extensionFromType;

  const extensionFromUrl = getIconExtensionFromUrl(candidateUrl);
  if (extensionFromUrl) return extensionFromUrl;

  const sample = buffer.subarray(0, 128).toString('utf8').trimStart().toLowerCase();
  if (sample.startsWith('<svg')) return '.svg';

  return '.ico';
}

function isSupportedIconResponse(contentType, candidateUrl, buffer) {
  const normalizedContentType = (contentType || '').split(';')[0].trim().toLowerCase();
  if (normalizedContentType.startsWith('image/')) return true;

  const extensionFromUrl = getIconExtensionFromUrl(candidateUrl);
  if (extensionFromUrl && ['application/octet-stream', 'binary/octet-stream', ''].includes(normalizedContentType)) {
    return true;
  }

  const sample = buffer.subarray(0, 128).toString('utf8').trimStart().toLowerCase();
  return sample.startsWith('<svg');
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ICON_FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      redirect: 'follow',
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBuffer(response, maxBytes, allowTruncate = false) {
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (!allowTruncate && Number.isInteger(contentLength) && contentLength > maxBytes) {
    throw new Error('Icon response is too large');
  }

  if (!response.body?.getReader) {
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > maxBytes) {
      if (allowTruncate) return buffer.subarray(0, maxBytes);
      throw new Error('Icon response is too large');
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = Buffer.from(value);
    if (totalBytes + chunk.length > maxBytes) {
      if (allowTruncate) {
        chunks.push(chunk.subarray(0, maxBytes - totalBytes));
        await reader.cancel().catch(() => {});
        break;
      }
      throw new Error('Icon response is too large');
    }
    totalBytes += chunk.length;
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function getHtmlAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[2] || match[3] || match[4] || '').trim() : '';
}

function toHttpUrl(value, baseUrl) {
  try {
    const parsedUrl = new URL(value, baseUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
    return parsedUrl.href;
  } catch {
    return null;
  }
}

function extractIconLinksFromHtml(html, pageUrl) {
  const candidates = [];

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = getHtmlAttribute(tag, 'rel').toLowerCase();
    const href = getHtmlAttribute(tag, 'href');
    if (!rel || !href || !rel.includes('icon')) continue;

    const iconUrl = toHttpUrl(href, pageUrl);
    if (iconUrl) candidates.push(iconUrl);
  }

  return candidates;
}

function getConventionalIconCandidates(parsedUrl) {
  const rootIconPaths = [
    '/favicon.ico',
    '/favicon.png',
    '/favicon.svg',
    '/favicon-32x32.png',
    '/favicon-16x16.png',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
    '/images/favicon.ico',
    '/images/favicon.png',
    '/static/favicon.ico',
    '/assets/favicon.ico',
    '/front-static/favicon.ico'
  ];
  const nestedIconNames = ['favicon.ico', 'favicon.png', 'favicon.svg', 'apple-touch-icon.png'];
  const pathSegments = parsedUrl.pathname.split('/').filter(Boolean).slice(0, 3);
  const pathPrefixes = [];
  let currentPrefix = '';

  for (const segment of pathSegments) {
    currentPrefix += `/${segment}`;
    pathPrefixes.unshift(currentPrefix);
  }

  const candidates = [];

  rootIconPaths.forEach((iconPath) => {
    candidates.push(`${parsedUrl.origin}${iconPath}`);
  });
  pathPrefixes.forEach((prefix) => {
    nestedIconNames.forEach((iconName) => {
      candidates.push(`${parsedUrl.origin}${prefix}/${iconName}`);
    });
  });

  return candidates;
}

function uniqueHttpUrls(urls) {
  const seen = new Set();
  return urls.filter((url) => {
    const httpUrl = toHttpUrl(url);
    if (!httpUrl || seen.has(httpUrl)) return false;
    seen.add(httpUrl);
    return true;
  });
}

async function discoverIconCandidates(parsedUrl) {
  const candidates = [];

  try {
    const response = await fetchWithTimeout(parsedUrl.href, {
      headers: {
        Accept: 'text/html,application/xhtml+xml'
      }
    });

    const contentType = response.headers.get('content-type') || '';
    if (response.ok && (!contentType || contentType.includes('text/html') || contentType.includes('application/xhtml+xml'))) {
      const html = (await readResponseBuffer(response, ICON_HTML_SAMPLE_SIZE, true)).toString('utf8');
      candidates.push(...extractIconLinksFromHtml(html, parsedUrl.href));
    }
  } catch {
    // Conventional favicon paths below still cover most services.
  }

  candidates.push(...getConventionalIconCandidates(parsedUrl));
  return uniqueHttpUrls(candidates);
}

async function fetchIconCandidate(candidateUrl) {
  const response = await fetchWithTimeout(candidateUrl, {
    headers: {
      Accept: 'image/avif,image/webp,image/svg+xml,image/png,image/*,*/*;q=0.8'
    }
  });

  if (!response.ok) return null;

  const buffer = await readResponseBuffer(response, MAX_ICON_SIZE);
  if (!buffer.length) return null;

  const contentType = response.headers.get('content-type') || '';
  if (!isSupportedIconResponse(contentType, candidateUrl, buffer)) return null;

  const extension = getIconExtension(contentType, candidateUrl, buffer);
  return {
    buffer,
    extension,
    contentType: getIconContentType(extension)
  };
}

async function findCachedIcon(cacheKey) {
  const missFilePath = path.join(ICON_CACHE_DIR, `${cacheKey}.miss`);
  try {
    await fs.promises.access(missFilePath);
    return { miss: true };
  } catch {
    // Continue with image lookup.
  }

  const entries = await fs.promises.readdir(ICON_CACHE_DIR, { withFileTypes: true }).catch(() => []);
  const cachedEntry = entries.find((entry) => (
    entry.isFile() &&
    entry.name.startsWith(`${cacheKey}.`) &&
    iconContentTypeByExtension.has(path.extname(entry.name).toLowerCase())
  ));

  if (!cachedEntry) return null;

  const extension = path.extname(cachedEntry.name).toLowerCase();
  return {
    filePath: path.join(ICON_CACHE_DIR, cachedEntry.name),
    contentType: getIconContentType(extension)
  };
}

async function markIconCacheMiss(cacheKey) {
  await fs.promises.writeFile(path.join(ICON_CACHE_DIR, `${cacheKey}.miss`), new Date().toISOString());
}

async function cacheIconForUrl(targetUrl, cacheKey) {
  const parsedUrl = new URL(targetUrl);
  const candidates = await discoverIconCandidates(parsedUrl);

  for (const candidateUrl of candidates) {
    try {
      const icon = await fetchIconCandidate(candidateUrl);
      if (!icon) continue;

      const filePath = path.join(ICON_CACHE_DIR, `${cacheKey}${icon.extension}`);
      await fs.promises.writeFile(filePath, icon.buffer);
      return {
        filePath,
        contentType: icon.contentType
      };
    } catch {
      // Try the next candidate.
    }
  }

  await markIconCacheMiss(cacheKey);
  return null;
}

function sendCachedIcon(res, cachedIcon) {
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(cachedIcon.contentType);
  res.sendFile(cachedIcon.filePath);
}

function deferSessionCallback(callback, ...args) {
  if (!callback) return;
  if (typeof setImmediate === 'function') {
    setImmediate(callback, ...args);
    return;
  }
  process.nextTick(() => callback(...args));
}

function getSessionExpiresAt(sessionData) {
  const expires = sessionData?.cookie?.expires;
  if (expires) {
    const expiresAt = new Date(expires).getTime();
    if (Number.isFinite(expiresAt)) {
      return expiresAt;
    }
  }

  const maxAge = sessionData?.cookie?.maxAge;
  if (typeof maxAge === 'number' && Number.isFinite(maxAge)) {
    return Date.now() + maxAge;
  }

  return Date.now() + SESSION_MAX_AGE_MS;
}

class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();

    this.statements = {
      get: database.prepare('SELECT sess, expires FROM sessions WHERE sid = ?'),
      set: database.prepare(`
        INSERT INTO sessions (sid, sess, expires)
        VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET
          sess = excluded.sess,
          expires = excluded.expires
      `),
      all: database.prepare('SELECT sid, sess FROM sessions WHERE expires > ?'),
      count: database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires > ?'),
      destroy: database.prepare('DELETE FROM sessions WHERE sid = ?'),
      clear: database.prepare('DELETE FROM sessions'),
      deleteExpired: database.prepare('DELETE FROM sessions WHERE expires <= ?')
    };

    this.cleanupExpiredSessions();
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), SESSION_CLEANUP_INTERVAL_MS);
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  get(sessionId, callback) {
    try {
      const row = this.statements.get.get(sessionId);
      if (!row) {
        deferSessionCallback(callback, null);
        return;
      }

      if (Number(row.expires) <= Date.now()) {
        this.statements.destroy.run(sessionId);
        deferSessionCallback(callback, null);
        return;
      }

      deferSessionCallback(callback, null, JSON.parse(row.sess));
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  set(sessionId, sessionData, callback) {
    try {
      this.statements.set.run(sessionId, JSON.stringify(sessionData), getSessionExpiresAt(sessionData));
      deferSessionCallback(callback);
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  touch(sessionId, sessionData, callback) {
    try {
      const row = this.statements.get.get(sessionId);
      if (row) {
        const currentSession = JSON.parse(row.sess);
        currentSession.cookie = sessionData.cookie;
        this.statements.set.run(sessionId, JSON.stringify(currentSession), getSessionExpiresAt(currentSession));
      }
      deferSessionCallback(callback);
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  destroy(sessionId, callback) {
    try {
      this.statements.destroy.run(sessionId);
      deferSessionCallback(callback);
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  all(callback) {
    try {
      this.cleanupExpiredSessions();
      const sessions = Object.create(null);
      const rows = this.statements.all.all(Date.now());

      rows.forEach((row) => {
        sessions[row.sid] = JSON.parse(row.sess);
      });

      deferSessionCallback(callback, null, sessions);
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  clear(callback) {
    try {
      this.statements.clear.run();
      deferSessionCallback(callback);
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  length(callback) {
    try {
      this.cleanupExpiredSessions();
      const row = this.statements.count.get(Date.now());
      deferSessionCallback(callback, null, Number(row.count));
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  cleanupExpiredSessions() {
    this.statements.deleteExpired.run(Date.now());
  }
}

const app = express();
app.set('trust proxy', TRUST_PROXY);

app.use(express.json({ limit: '64kb' }));
app.use(session({
  store: new SQLiteSessionStore(db),
  name: 'my_home_sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: SESSION_COOKIE_SECURE,
    maxAge: SESSION_MAX_AGE_MS
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

app.get('/favicon.svg', (req, res) => {
  res.type('image/svg+xml');
  res.sendFile(path.join(ROOT_DIR, 'favicon.svg'));
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
    projectLayoutColumns: current.projectLayoutColumns,
    editMode: current.editMode,
    projectLinkDisplayMode: current.projectLinkDisplayMode,
    bookmarkLinkDisplayMode: current.bookmarkLinkDisplayMode,
    projectLinkSize: current.projectLinkSize,
    bookmarkLinkSize: current.bookmarkLinkSize,
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

  if (Object.prototype.hasOwnProperty.call(req.body, 'projectLayoutColumns')) {
    const projectLayoutColumns = Number.parseInt(req.body.projectLayoutColumns, 10);
    if (!Number.isInteger(projectLayoutColumns) || projectLayoutColumns < 0 || projectLayoutColumns > 6) {
      res.status(400).json({ error: '个人项目布局列数必须在 0 到 6 之间' });
      return;
    }
    next.projectLayoutColumns = projectLayoutColumns;
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'editMode')) {
    next.editMode = Boolean(req.body.editMode);
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'projectLinkDisplayMode')) {
    next.projectLinkDisplayMode = normalizeDisplayMode(req.body.projectLinkDisplayMode, 'default');
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'bookmarkLinkDisplayMode')) {
    next.bookmarkLinkDisplayMode = normalizeDisplayMode(req.body.bookmarkLinkDisplayMode, 'default');
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'projectLinkSize')) {
    next.projectLinkSize = normalizeLinkSize(req.body.projectLinkSize, 'medium');
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'bookmarkLinkSize')) {
    next.bookmarkLinkSize = normalizeLinkSize(req.body.bookmarkLinkSize, 'medium');
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
    SET layout_columns = ?,
        project_layout_columns = ?,
        edit_mode = ?,
        project_link_display_mode = ?,
        bookmark_link_display_mode = ?,
        project_link_size = ?,
        bookmark_link_size = ?,
        background_url = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(
    next.layoutColumns,
    next.projectLayoutColumns,
    next.editMode ? 1 : 0,
    next.projectLinkDisplayMode,
    next.bookmarkLinkDisplayMode,
    next.projectLinkSize,
    next.bookmarkLinkSize,
    next.backgroundUrl,
    USER_ID
  );

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
  const engine = db.prepare('SELECT engine_key FROM search_engines WHERE user_id = ? AND id = ?').get(USER_ID, req.params.id);
  if (!engine) {
    res.status(404).json({ error: '搜索引擎不存在' });
    return;
  }

  if (REQUIRED_SEARCH_ENGINE_KEYS.has(engine.engine_key)) {
    res.status(400).json({ error: 'Google 搜索需要保留，可以编辑名称和搜索地址' });
    return;
  }

  const result = db.prepare('DELETE FROM search_engines WHERE user_id = ? AND id = ?').run(USER_ID, req.params.id);
  if (Number(result.changes) === 0) {
    res.status(404).json({ error: '搜索引擎不存在' });
    return;
  }

  res.json({ engines: getSearchEngines() });
});

app.get('/api/links', requireAuth, (req, res) => {
  res.json(getLinksResponse());
});

app.post('/api/links', requireAuth, (req, res) => {
  const payload = validateLinkPayload(req, res);
  if (!payload) return;

  const row = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM nav_links WHERE user_id = ? AND link_type = ?'
  ).get(USER_ID, payload.linkType);
  db.prepare(
    'INSERT INTO nav_links (user_id, link_type, title, url, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(USER_ID, payload.linkType, payload.title, payload.url, row.next_order);

  res.status(201).json(getLinksResponse());
});

app.put('/api/links/reorder', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => Number.parseInt(id, 10)) : [];
  const linkType = normalizeLinkType(req.body.type || req.body.linkType);
  const currentIds = getLinks(linkType).map((link) => link.id);
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

  res.json(getLinksResponse());
});

app.put('/api/links/:id', requireAuth, (req, res) => {
  const payload = validateLinkPayload(req, res);
  if (!payload) return;

  const existing = db.prepare('SELECT link_key FROM nav_links WHERE user_id = ? AND id = ?').get(USER_ID, req.params.id);
  if (!existing) {
    res.status(404).json({ error: '链接不存在' });
    return;
  }

  const nextLinkType = REQUIRED_LINK_KEYS.has(existing.link_key) ? 'email' : payload.linkType;
  const result = db.prepare(
    'UPDATE nav_links SET link_type = ?, title = ?, url = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?'
  ).run(nextLinkType, payload.title, payload.url, USER_ID, req.params.id);

  if (Number(result.changes) === 0) {
    res.status(404).json({ error: '链接不存在' });
    return;
  }

  res.json(getLinksResponse());
});

app.delete('/api/links/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT link_key FROM nav_links WHERE user_id = ? AND id = ?').get(USER_ID, req.params.id);
  if (!existing) {
    res.status(404).json({ error: '链接不存在' });
    return;
  }

  if (REQUIRED_LINK_KEYS.has(existing.link_key)) {
    res.status(400).json({ error: 'Google 邮箱需要保留，可以编辑名称和登录地址' });
    return;
  }

  const result = db.prepare('DELETE FROM nav_links WHERE user_id = ? AND id = ?').run(USER_ID, req.params.id);
  if (Number(result.changes) === 0) {
    res.status(404).json({ error: '链接不存在' });
    return;
  }
  res.json(getLinksResponse());
});

app.get('/api/icon', requireAuth, async (req, res) => {
  const targetUrl = normalizeIconTargetUrl(req.query.url);
  if (!targetUrl) {
    res.status(400).end();
    return;
  }

  const cacheKey = getIconCacheKey(targetUrl);

  try {
    const cachedIcon = await findCachedIcon(cacheKey);
    if (cachedIcon?.miss) {
      res.status(404).end();
      return;
    }

    if (cachedIcon) {
      sendCachedIcon(res, cachedIcon);
      return;
    }

    const downloadedIcon = await cacheIconForUrl(targetUrl, cacheKey);
    if (!downloadedIcon) {
      res.status(404).end();
      return;
    }

    sendCachedIcon(res, downloadedIcon);
  } catch (error) {
    console.warn('Failed to load icon:', error.message);
    res.status(404).end();
  }
});

app.post('/api/icon-cache/refresh', requireAuth, async (req, res) => {
  try {
    await fs.promises.rm(ICON_CACHE_DIR, { recursive: true, force: true });
    await fs.promises.mkdir(ICON_CACHE_DIR, { recursive: true });
    res.json({ ok: true });
  } catch (error) {
    console.warn('Failed to refresh icon cache:', error.message);
    res.status(500).json({ error: '刷新图标缓存失败' });
  }
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
      const message = error.code === 'LIMIT_FILE_SIZE' ? '图片文件不能超过 10MB' : error.message;
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

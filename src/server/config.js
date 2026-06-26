const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

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

const DEFAULT_EMAIL_LINK = {
  linkKey: 'google-mail',
  title: 'Google',
  url: 'https://mail.google.com/'
};

const REQUIRED_SEARCH_ENGINE_KEYS = new Set(['google']);
const REQUIRED_LINK_KEYS = new Set([DEFAULT_EMAIL_LINK.linkKey]);
const USER_ID = 1;
const SCHEMA_VERSION = '2026-06-26.1';
const DEFAULT_ICON_FETCH_NO_PROXY = [
  'localhost',
  '127.0.0.1',
  '::1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '.local'
].join(',');

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

function firstNonEmptyEnv(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }

  return '';
}

function resolveFromRoot(rootDir, value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function generateSessionSecret() {
  return crypto.randomBytes(48).toString('hex');
}

function readGeneratedSessionSecret(secretPath) {
  try {
    const secret = fs.readFileSync(secretPath, 'utf8').trim();
    return secret || '';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

function createGeneratedSessionSecret(secretPath) {
  const secret = generateSessionSecret();
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });

  try {
    fs.writeFileSync(secretPath, `${secret}\n`, { mode: 0o600, flag: 'wx' });
    return secret;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existingSecret = readGeneratedSessionSecret(secretPath);
    if (existingSecret) return existingSecret;
    fs.writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
    return secret;
  }
}

function resolveSessionSecret(envSecret, secretPath) {
  const configuredSecret = firstNonEmptyEnv(envSecret);
  if (configuredSecret) return configuredSecret;

  return readGeneratedSessionSecret(secretPath) || createGeneratedSessionSecret(secretPath);
}

function loadConfig(env = process.env, options = {}) {
  const { requireSecrets = true, rootDir = path.resolve(__dirname, '../..') } = options;
  const dataDir = resolveFromRoot(rootDir, env.DATA_DIR || './data');
  const uploadsDirOverridden = env.UPLOADS_DIR !== undefined && String(env.UPLOADS_DIR).trim() !== '';
  const uploadsDir = resolveFromRoot(rootDir, uploadsDirOverridden ? env.UPLOADS_DIR : path.join(dataDir, 'uploads'));
  const legacyUploadsDir = resolveFromRoot(rootDir, './uploads');
  const publicDir = resolveFromRoot(rootDir, env.PUBLIC_DIR || './public');
  const databasePath = resolveFromRoot(rootDir, env.DATABASE_PATH || './data/my-home.sqlite');
  const sessionSecretPath = resolveFromRoot(rootDir, env.SESSION_SECRET_FILE || path.join(dataDir, 'session-secret'));
  const nodeEnv = env.NODE_ENV || 'development';
  const iconFetchProxy = firstNonEmptyEnv(env.ICON_FETCH_PROXY);
  const iconFetchHttpProxy = firstNonEmptyEnv(
    env.ICON_FETCH_HTTP_PROXY,
    iconFetchProxy,
    env.http_proxy,
    env.HTTP_PROXY,
    env.all_proxy,
    env.ALL_PROXY
  );
  const iconFetchHttpsProxy = firstNonEmptyEnv(
    env.ICON_FETCH_HTTPS_PROXY,
    iconFetchProxy,
    env.https_proxy,
    env.HTTPS_PROXY,
    env.all_proxy,
    env.ALL_PROXY,
    iconFetchHttpProxy
  );
  const iconFetchNoProxy = env.ICON_FETCH_NO_PROXY !== undefined
    ? String(env.ICON_FETCH_NO_PROXY).trim()
    : firstNonEmptyEnv(env.no_proxy, env.NO_PROXY, DEFAULT_ICON_FETCH_NO_PROXY);

  const config = {
    rootDir,
    publicDir,
    dataDir,
    uploadsDir,
    legacyUploadsDir,
    uploadsDirOverridden,
    backgroundsDir: path.join(uploadsDir, 'backgrounds'),
    iconCacheDir: path.join(dataDir, 'icon-cache-v2'),
    databasePath,
    host: env.HOST || '127.0.0.1',
    port: parseIntegerEnv(env.PORT, 3000, 1),
    nodeEnv,
    adminUsername: env.ADMIN_USERNAME,
    adminPassword: env.ADMIN_PASSWORD,
    sessionSecret: '',
    sessionSecretPath,
    sessionCookieName: 'my_home_sid',
    sessionCookieSecure: parseBooleanEnv(env.SESSION_COOKIE_SECURE, nodeEnv === 'production'),
    sessionMaxAgeMs: 1000 * 60 * 60 * 24 * 30,
    sessionCleanupIntervalMs: 60 * 60 * 1000,
    trustProxy: parseBooleanEnv(env.TRUST_PROXY, false),
    loginMaxFailedAttempts: parseIntegerEnv(env.LOGIN_MAX_FAILED_ATTEMPTS, 5, 1),
    loginWindowMs: parseIntegerEnv(env.LOGIN_WINDOW_MS, 15 * 60 * 1000, 1000),
    loginLockoutMs: parseIntegerEnv(env.LOGIN_LOCKOUT_MS, 15 * 60 * 1000, 1000),
    bcryptRounds: parseIntegerEnv(env.BCRYPT_ROUNDS, 12, 4),
    maxBackgroundSize: 10 * 1024 * 1024,
    maxIconSize: 1024 * 1024,
    iconFetchTimeoutMs: parseIntegerEnv(env.ICON_FETCH_TIMEOUT_MS, 5000, 100),
    iconFetchLogEnabled: parseBooleanEnv(env.ICON_FETCH_LOG, false),
    iconHtmlSampleSize: 128 * 1024,
    iconMaxRedirects: parseIntegerEnv(env.ICON_MAX_REDIRECTS, 3, 0),
    iconMaxCandidates: parseIntegerEnv(env.ICON_MAX_CANDIDATES, 12, 1),
    iconFetchProxy: {
      httpProxy: iconFetchHttpProxy,
      httpsProxy: iconFetchHttpsProxy,
      noProxy: iconFetchNoProxy
    },
    userId: USER_ID,
    schemaVersion: SCHEMA_VERSION,
    defaultSearchEngines: DEFAULT_SEARCH_ENGINES,
    defaultEmailLink: DEFAULT_EMAIL_LINK,
    requiredSearchEngineKeys: REQUIRED_SEARCH_ENGINE_KEYS,
    requiredLinkKeys: REQUIRED_LINK_KEYS
  };

  if (requireSecrets) {
    const missing = [];
    if (!config.adminUsername) missing.push('ADMIN_USERNAME');
    if (!config.adminPassword) missing.push('ADMIN_PASSWORD');
    if (missing.length) {
      const error = new Error(`Missing required environment variables: ${missing.join(', ')}`);
      error.code = 'CONFIG_MISSING_REQUIRED_ENV';
      error.missing = missing;
      throw error;
    }
  }

  config.sessionSecret = resolveSessionSecret(env.SESSION_SECRET, sessionSecretPath);
  return config;
}

module.exports = {
  DEFAULT_ICON_FETCH_NO_PROXY,
  DEFAULT_EMAIL_LINK,
  DEFAULT_SEARCH_ENGINES,
  REQUIRED_LINK_KEYS,
  REQUIRED_SEARCH_ENGINE_KEYS,
  SCHEMA_VERSION,
  USER_ID,
  firstNonEmptyEnv,
  generateSessionSecret,
  loadConfig,
  parseBooleanEnv,
  parseIntegerEnv,
  resolveSessionSecret
};

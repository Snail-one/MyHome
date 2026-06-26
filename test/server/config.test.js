const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadConfig, parseBooleanEnv, parseIntegerEnv } = require('../../src/server/config');
const { createDatabase, ensureRuntimeDirectories } = require('../../src/server/db');

test('parseBooleanEnv accepts common boolean values and falls back on invalid input', () => {
  assert.equal(parseBooleanEnv('true', false), true);
  assert.equal(parseBooleanEnv('1', false), true);
  assert.equal(parseBooleanEnv('off', true), false);
  assert.equal(parseBooleanEnv('wat', true), true);
});

test('parseIntegerEnv enforces minimum and fallback', () => {
  assert.equal(parseIntegerEnv('42', 1, 1), 42);
  assert.equal(parseIntegerEnv('0', 5, 1), 5);
  assert.equal(parseIntegerEnv('abc', 5, 1), 5);
});

test('loadConfig does not require administrator credentials from env', () => {
  const config = loadConfig({
    SESSION_SECRET: 'session-secret'
  }, { rootDir: process.cwd() });

  assert.equal(config.sessionSecret, 'session-secret');
});

test('loadConfig builds expected runtime paths', () => {
  const config = loadConfig({
    SESSION_SECRET: 'session-secret',
    DATABASE_PATH: './tmp/app.sqlite',
    PORT: '8080',
    TRUST_PROXY: 'true'
  }, { rootDir: '/repo' });

  assert.equal(config.databasePath, '/repo/tmp/app.sqlite');
  assert.equal(config.iconCacheDir, '/repo/data/icon-cache-v2');
  assert.equal(config.uploadsDir, '/repo/data/uploads');
  assert.equal(config.backgroundsDir, '/repo/data/uploads/backgrounds');
  assert.equal(config.legacyUploadsDir, '/repo/uploads');
  assert.equal(config.uploadsDirOverridden, false);
  assert.equal(config.port, 8080);
  assert.equal(config.trustProxy, true);
  assert.equal(config.sessionCookieName, 'my_home_sid');
  assert.equal(config.iconFetchLogEnabled, false);
});

test('loadConfig builds icon fetch proxy settings', () => {
  const config = loadConfig({
    SESSION_SECRET: 'session-secret',
    ICON_FETCH_PROXY: 'http://127.0.0.1:7890',
    ICON_FETCH_LOG: 'true',
    ICON_FETCH_NO_PROXY: 'localhost,.internal'
  }, { rootDir: '/repo' });

  assert.equal(config.iconFetchProxy.httpProxy, 'http://127.0.0.1:7890');
  assert.equal(config.iconFetchProxy.httpsProxy, 'http://127.0.0.1:7890');
  assert.equal(config.iconFetchProxy.noProxy, 'localhost,.internal');
  assert.equal(config.iconFetchLogEnabled, true);
});

test('loadConfig allows explicit uploads directory override', () => {
  const config = loadConfig({
    SESSION_SECRET: 'session-secret',
    DATA_DIR: './data',
    UPLOADS_DIR: './legacy-uploads'
  }, { rootDir: '/repo' });

  assert.equal(config.uploadsDir, '/repo/legacy-uploads');
  assert.equal(config.backgroundsDir, '/repo/legacy-uploads/backgrounds');
  assert.equal(config.uploadsDirOverridden, true);
});

test('createDatabase generates and reuses database session secret when not configured', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-config-'));
  const env = {
    DATA_DIR: './data',
    DATABASE_PATH: './data/app.sqlite'
  };

  const firstConfig = loadConfig(env, { rootDir });
  const firstDatabase = createDatabase(firstConfig, { skipSeed: true });
  const firstSecret = firstConfig.sessionSecret;
  const firstMeta = firstDatabase.db.prepare("SELECT value FROM schema_meta WHERE key = 'session_secret'").get();
  firstDatabase.close();

  const secondConfig = loadConfig(env, { rootDir });
  const secondDatabase = createDatabase(secondConfig, { skipSeed: true });
  secondDatabase.close();

  assert.equal(firstSecret.length, 96);
  assert.equal(firstMeta.value, firstSecret);
  assert.equal(secondConfig.sessionSecret, firstSecret);
});

test('createDatabase stores configured session secret in database', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-config-'));
  const config = loadConfig({
    SESSION_SECRET: 'configured-secret',
    DATA_DIR: './data',
    DATABASE_PATH: './data/app.sqlite'
  }, { rootDir });
  const database = createDatabase(config, { skipSeed: true });
  const meta = database.db.prepare("SELECT value FROM schema_meta WHERE key = 'session_secret'").get();
  database.close();

  assert.equal(config.sessionSecret, 'configured-secret');
  assert.equal(meta.value, 'configured-secret');
});

test('createDatabase imports legacy session secret file into database', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-config-'));
  const secretPath = path.join(rootDir, 'data/session-secret');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, 'legacy-secret\n');

  const config = loadConfig({
    DATA_DIR: './data',
    DATABASE_PATH: './data/app.sqlite'
  }, { rootDir });
  const database = createDatabase(config, { skipSeed: true });
  const meta = database.db.prepare("SELECT value FROM schema_meta WHERE key = 'session_secret'").get();
  database.close();

  assert.equal(config.sessionSecret, 'legacy-secret');
  assert.equal(meta.value, 'legacy-secret');
});

test('ensureRuntimeDirectories copies legacy background uploads into data uploads', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-config-'));
  const legacyBackgroundsDir = path.join(rootDir, 'uploads/backgrounds');
  fs.mkdirSync(legacyBackgroundsDir, { recursive: true });
  fs.writeFileSync(path.join(legacyBackgroundsDir, 'legacy.txt'), 'legacy');

  const config = loadConfig({
    SESSION_SECRET: 'session-secret',
    DATA_DIR: './data'
  }, { rootDir });

  ensureRuntimeDirectories(config);

  assert.equal(
    fs.readFileSync(path.join(rootDir, 'data/uploads/backgrounds/legacy.txt'), 'utf8'),
    'legacy'
  );
});

test('ensureRuntimeDirectories does not copy legacy uploads when uploads dir is overridden', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-config-'));
  const legacyBackgroundsDir = path.join(rootDir, 'uploads/backgrounds');
  fs.mkdirSync(legacyBackgroundsDir, { recursive: true });
  fs.writeFileSync(path.join(legacyBackgroundsDir, 'legacy.txt'), 'legacy');

  const config = loadConfig({
    SESSION_SECRET: 'session-secret',
    DATA_DIR: './data',
    UPLOADS_DIR: './custom-uploads'
  }, { rootDir });

  ensureRuntimeDirectories(config);

  assert.equal(fs.existsSync(path.join(rootDir, 'custom-uploads/backgrounds/legacy.txt')), false);
});

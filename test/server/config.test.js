const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadConfig, parseBooleanEnv, parseIntegerEnv } = require('../../src/server/config');
const { ensureRuntimeDirectories } = require('../../src/server/db');

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

test('loadConfig reports missing required secrets', () => {
  assert.throws(() => loadConfig({}, { rootDir: process.cwd() }), (error) => {
    assert.equal(error.code, 'CONFIG_MISSING_REQUIRED_ENV');
    assert.deepEqual(error.missing, ['ADMIN_USERNAME', 'ADMIN_PASSWORD']);
    return true;
  });
});

test('loadConfig builds expected runtime paths', () => {
  const config = loadConfig({
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'secret',
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
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'secret',
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
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'secret',
    SESSION_SECRET: 'session-secret',
    DATA_DIR: './data',
    UPLOADS_DIR: './legacy-uploads'
  }, { rootDir: '/repo' });

  assert.equal(config.uploadsDir, '/repo/legacy-uploads');
  assert.equal(config.backgroundsDir, '/repo/legacy-uploads/backgrounds');
  assert.equal(config.uploadsDirOverridden, true);
});

test('loadConfig generates and reuses session secret when not configured', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-config-'));
  const env = {
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'secret',
    DATA_DIR: './data'
  };

  const firstConfig = loadConfig(env, { rootDir });
  const secondConfig = loadConfig(env, { rootDir });

  assert.equal(firstConfig.sessionSecret.length, 96);
  assert.equal(secondConfig.sessionSecret, firstConfig.sessionSecret);
  assert.equal(
    fs.readFileSync(path.join(rootDir, 'data/session-secret'), 'utf8').trim(),
    firstConfig.sessionSecret
  );
});

test('loadConfig uses configured session secret before generated file', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-config-'));
  const generatedPath = path.join(rootDir, 'data/session-secret');
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.writeFileSync(generatedPath, 'generated-secret\n');

  const config = loadConfig({
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'secret',
    SESSION_SECRET: 'configured-secret',
    DATA_DIR: './data'
  }, { rootDir });

  assert.equal(config.sessionSecret, 'configured-secret');
});

test('loadConfig replaces an empty generated session secret file', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-config-'));
  const generatedPath = path.join(rootDir, 'data/session-secret');
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.writeFileSync(generatedPath, '\n');

  const config = loadConfig({
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'secret',
    DATA_DIR: './data'
  }, { rootDir });

  assert.equal(config.sessionSecret.length, 96);
  assert.equal(fs.readFileSync(generatedPath, 'utf8').trim(), config.sessionSecret);
});

test('ensureRuntimeDirectories copies legacy background uploads into data uploads', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-config-'));
  const legacyBackgroundsDir = path.join(rootDir, 'uploads/backgrounds');
  fs.mkdirSync(legacyBackgroundsDir, { recursive: true });
  fs.writeFileSync(path.join(legacyBackgroundsDir, 'legacy.txt'), 'legacy');

  const config = loadConfig({
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'secret',
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
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'secret',
    SESSION_SECRET: 'session-secret',
    DATA_DIR: './data',
    UPLOADS_DIR: './custom-uploads'
  }, { rootDir });

  ensureRuntimeDirectories(config);

  assert.equal(fs.existsSync(path.join(rootDir, 'custom-uploads/backgrounds/legacy.txt')), false);
});

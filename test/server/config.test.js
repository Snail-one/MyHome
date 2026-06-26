const assert = require('node:assert/strict');
const test = require('node:test');

const { loadConfig, parseBooleanEnv, parseIntegerEnv } = require('../../src/server/config');

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
  assert.throws(
    () => loadConfig({}, { rootDir: process.cwd() }),
    /Missing required environment variables/
  );
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
  assert.equal(config.port, 8080);
  assert.equal(config.trustProxy, true);
  assert.equal(config.sessionCookieName, 'my_home_sid');
});

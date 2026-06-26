const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const { loadConfig } = require('../../src/server/config');
const { createDatabase } = require('../../src/server/db');
const { SQLiteSessionStore } = require('../../src/server/services/sessionStore');

function createTestDatabase() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-session-'));
  const config = loadConfig({
    SESSION_SECRET: 'session-secret',
    DATA_DIR: path.join(tmpDir, 'data'),
    UPLOADS_DIR: path.join(tmpDir, 'uploads'),
    DATABASE_PATH: path.join(tmpDir, 'app.sqlite'),
    BCRYPT_ROUNDS: '4'
  }, { rootDir: process.cwd() });
  return { tmpDir, config, database: createDatabase(config, { skipSeed: true }) };
}

test('SQLiteSessionStore stores, expires, counts, and destroys sessions', async () => {
  const { database } = createTestDatabase();
  const store = new SQLiteSessionStore(database.db, {
    maxAgeMs: 1000,
    cleanupIntervalMs: 60 * 60 * 1000
  });
  const get = promisify(store.get.bind(store));
  const set = promisify(store.set.bind(store));
  const destroy = promisify(store.destroy.bind(store));
  const length = promisify(store.length.bind(store));

  await set('sid-1', { cookie: { maxAge: 1000 }, userId: 1 });
  assert.equal((await get('sid-1')).userId, 1);
  assert.equal(await length(), 1);

  await set('expired', { cookie: { expires: new Date(Date.now() - 1000) }, userId: 1 });
  assert.equal(await get('expired'), undefined);

  await destroy('sid-1');
  assert.equal(await get('sid-1'), undefined);

  store.close();
  database.close();
});

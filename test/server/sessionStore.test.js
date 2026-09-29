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

test('destroyUserSessions removes other sessions for that user only', async () => {
  const { database } = createTestDatabase();
  const store = new SQLiteSessionStore(database.db, {
    maxAgeMs: 60_000,
    cleanupIntervalMs: 60 * 60 * 1000
  });
  const get = promisify(store.get.bind(store));
  const set = promisify(store.set.bind(store));
  const destroyUserSessions = promisify(store.destroyUserSessions.bind(store));

  await set('keep', { cookie: { maxAge: 60_000 }, userId: 1 });
  await set('other', { cookie: { maxAge: 60_000 }, userId: 1 });
  await set('stranger', { cookie: { maxAge: 60_000 }, userId: 2 });

  const removed = await destroyUserSessions(1, 'keep');
  assert.deepEqual(removed.sort(), ['other']);
  assert.equal((await get('keep')).userId, 1);
  assert.equal(await get('other'), undefined);
  assert.equal((await get('stranger')).userId, 2);

  store.close();
  database.close();
});

test('session writes are rejected when the stamped version is no longer current', async () => {
  const { database } = createTestDatabase();
  database.db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('admin', 'hash');
  const store = new SQLiteSessionStore(database.db, {
    maxAgeMs: 60_000,
    cleanupIntervalMs: 60 * 60 * 1000
  });
  const get = promisify(store.get.bind(store));
  const set = promisify(store.set.bind(store));
  const touch = promisify(store.touch.bind(store));
  const session = { cookie: { maxAge: 60_000 }, userId: 1, sessionVersion: 0 };

  await set('sid', session);
  assert.equal((await get('sid')).sessionVersion, 0);

  database.db.prepare('UPDATE users SET session_version = 1 WHERE id = 1').run();
  assert.equal(await get('sid'), undefined);
  await set('sid', session);
  assert.equal(await get('sid'), undefined);

  await set('sid-new', { ...session, sessionVersion: 1 });
  assert.equal((await get('sid-new')).sessionVersion, 1);

  await set('touched', { ...session, sessionVersion: 1 });
  database.db.prepare('UPDATE users SET session_version = 2 WHERE id = 1').run();
  await touch('touched', { ...session, sessionVersion: 1 });
  assert.equal(await get('touched'), undefined);

  await set('guest', { cookie: { maxAge: 60_000 }, note: 'guest' });
  assert.equal((await get('guest')).note, 'guest');
  await set('stranger', { cookie: { maxAge: 60_000 }, userId: 2, sessionVersion: 0 });
  assert.equal((await get('stranger')).userId, 2);

  store.close();
  database.close();
});

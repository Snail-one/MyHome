const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { generateSessionSecret } = require('../config');
const { initializeSchema } = require('./schema');
const { seedDatabase } = require('./seed');
const { createStores } = require('./stores');

const SESSION_SECRET_META_KEY = 'session_secret';

function ensureRuntimeDirectories(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  fs.mkdirSync(config.backgroundsDir, { recursive: true });
  fs.mkdirSync(config.iconCacheDir, { recursive: true });
  copyLegacyBackgroundUploads(config);
}

function copyLegacyBackgroundUploads(config) {
  if (config.uploadsDirOverridden) return;

  const legacyBackgroundsDir = path.join(config.legacyUploadsDir, 'backgrounds');
  const currentBackgroundsDir = path.resolve(config.backgroundsDir);
  if (path.resolve(legacyBackgroundsDir) === currentBackgroundsDir) return;
  if (!fs.existsSync(legacyBackgroundsDir)) return;

  fs.cpSync(legacyBackgroundsDir, currentBackgroundsDir, {
    recursive: true,
    force: false,
    errorOnExist: false
  });
}

function getSchemaMetaValue(db, key) {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key);
  return typeof row?.value === 'string' ? row.value : '';
}

function setSchemaMetaValue(db, key, value) {
  db.prepare(`
    INSERT INTO schema_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function readLegacySessionSecret(config) {
  const legacyPath = path.join(config.dataDir, 'session-secret');
  try {
    return fs.readFileSync(legacyPath, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

function ensureSessionSecret(db, config) {
  const configuredSecret = typeof config.sessionSecret === 'string' ? config.sessionSecret.trim() : '';
  if (configuredSecret) {
    setSchemaMetaValue(db, SESSION_SECRET_META_KEY, configuredSecret);
    config.sessionSecret = configuredSecret;
    return configuredSecret;
  }

  const storedSecret = getSchemaMetaValue(db, SESSION_SECRET_META_KEY).trim();
  if (storedSecret) {
    config.sessionSecret = storedSecret;
    return storedSecret;
  }

  const legacySecret = readLegacySessionSecret(config);
  if (legacySecret) {
    setSchemaMetaValue(db, SESSION_SECRET_META_KEY, legacySecret);
    config.sessionSecret = legacySecret;
    return legacySecret;
  }

  const generatedSecret = generateSessionSecret();
  setSchemaMetaValue(db, SESSION_SECRET_META_KEY, generatedSecret);
  config.sessionSecret = generatedSecret;
  return generatedSecret;
}

function createDatabase(config, options = {}) {
  if (!options.skipEnsureDirectories) {
    ensureRuntimeDirectories(config);
  }

  const db = new DatabaseSync(config.databasePath);
  initializeSchema(db, config.schemaVersion);
  ensureSessionSecret(db, config);
  const stores = createStores(db, config);

  if (!options.skipSeed) {
    seedDatabase(stores);
  }

  return {
    db,
    stores,
    close() {
      db.close();
    }
  };
}

module.exports = {
  copyLegacyBackgroundUploads,
  createDatabase,
  ensureRuntimeDirectories,
  ensureSessionSecret
};

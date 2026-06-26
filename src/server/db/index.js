const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { initializeSchema } = require('./schema');
const { seedDatabase } = require('./seed');
const { createStores } = require('./stores');

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

function createDatabase(config, options = {}) {
  if (!options.skipEnsureDirectories) {
    ensureRuntimeDirectories(config);
  }

  const db = new DatabaseSync(config.databasePath);
  initializeSchema(db, config.schemaVersion);
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
  ensureRuntimeDirectories
};

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
}

function createDatabase(config, options = {}) {
  if (!options.skipEnsureDirectories) {
    ensureRuntimeDirectories(config);
  }

  const db = new DatabaseSync(config.databasePath);
  initializeSchema(db, config.schemaVersion);
  const stores = createStores(db, config);

  if (!options.skipSeed) {
    seedDatabase(stores, config);
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
  createDatabase,
  ensureRuntimeDirectories
};

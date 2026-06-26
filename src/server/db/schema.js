const TABLES = [
  'sessions',
  'search_engines',
  'nav_links',
  'user_settings',
  'users',
  'schema_meta'
];

function tableExists(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return Boolean(row);
}

function columnExists(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((column) => column.name === columnName);
}

function getSchemaVersion(db) {
  if (!tableExists(db, 'schema_meta')) return null;
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
  return row?.value || null;
}

function dropApplicationTables(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  TABLES.forEach((tableName) => {
    db.exec(`DROP TABLE IF EXISTS ${tableName}`);
  });
  db.exec('PRAGMA foreign_keys = ON');
}

function createSchema(db, schemaVersion) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

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
      bookmark_link_display_mode TEXT NOT NULL DEFAULT 'centered',
      project_link_size TEXT NOT NULL DEFAULT 'medium',
      bookmark_link_size TEXT NOT NULL DEFAULT 'medium',
      bookmark_glass INTEGER NOT NULL DEFAULT 1,
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
      icon_mode TEXT NOT NULL DEFAULT 'server',
      icon_version INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_nav_links_user_sort
    ON nav_links(user_id, sort_order, id);

    CREATE INDEX IF NOT EXISTS idx_nav_links_user_type_sort
    ON nav_links(user_id, link_type, sort_order, id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_nav_links_user_key
    ON nav_links(user_id, link_key)
    WHERE link_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS search_engines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      engine_key TEXT,
      name TEXT NOT NULL,
      url_template TEXT NOT NULL,
      icon_version INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_search_engines_user_sort
    ON search_engines(user_id, sort_order, id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_search_engines_user_key
    ON search_engines(user_id, engine_key)
    WHERE engine_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
  `);

  db.prepare(`
    INSERT INTO schema_meta (key, value)
    VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(schemaVersion);
}

function ensureIconColumns(db) {
  if (tableExists(db, 'nav_links') && !columnExists(db, 'nav_links', 'icon_mode')) {
    db.exec("ALTER TABLE nav_links ADD COLUMN icon_mode TEXT NOT NULL DEFAULT 'server'");
  }
  if (tableExists(db, 'nav_links') && !columnExists(db, 'nav_links', 'icon_version')) {
    db.exec('ALTER TABLE nav_links ADD COLUMN icon_version INTEGER NOT NULL DEFAULT 1');
  }
  if (tableExists(db, 'search_engines') && !columnExists(db, 'search_engines', 'icon_version')) {
    db.exec('ALTER TABLE search_engines ADD COLUMN icon_version INTEGER NOT NULL DEFAULT 1');
  }
}

function runOneTimeMigration(db, key, migrate) {
  const existing = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key);
  if (existing) return;
  migrate();
  db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(key, '1');
}

function migrateBookmarkDisplayDefault(db) {
  if (!tableExists(db, 'user_settings')) return;
  runOneTimeMigration(db, 'migration_bookmark_display_default_centered', () => {
    db.exec("UPDATE user_settings SET bookmark_link_display_mode = 'centered' WHERE bookmark_link_display_mode = 'default'");
  });
}

function migrateBookmarkGlass(db) {
  if (!tableExists(db, 'user_settings')) return;
  if (!columnExists(db, 'user_settings', 'bookmark_glass')) {
    db.exec('ALTER TABLE user_settings ADD COLUMN bookmark_glass INTEGER NOT NULL DEFAULT 1');
  }
}

function initializeSchema(db, schemaVersion) {
  db.exec('PRAGMA foreign_keys = ON');
  const existingVersion = getSchemaVersion(db);
  if (existingVersion !== schemaVersion) {
    dropApplicationTables(db);
  }
  createSchema(db, schemaVersion);
  ensureIconColumns(db);
  migrateBookmarkDisplayDefault(db);
  migrateBookmarkGlass(db);
}

module.exports = {
  columnExists,
  createSchema,
  dropApplicationTables,
  ensureIconColumns,
  getSchemaVersion,
  initializeSchema,
  migrateBookmarkDisplayDefault,
  migrateBookmarkGlass,
  tableExists
};

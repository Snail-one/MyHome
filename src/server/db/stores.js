const {
  normalizeDisplayMode,
  normalizeLinkSize,
  normalizeLinkType
} = require('../services/validation');

function createUserStore(db, config) {
  const statements = {
    findAdmin: db.prepare('SELECT * FROM users WHERE id = ?'),
    findByUsername: db.prepare('SELECT * FROM users WHERE id = ? AND username = ?'),
    insertAdmin: db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)'),
    updateAdmin: db.prepare(`
      UPDATE users
      SET username = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `),
    getMe: db.prepare('SELECT username FROM users WHERE id = ?')
  };

  return {
    findAdmin() {
      return statements.findAdmin.get(config.userId);
    },
    findByUsername(username) {
      return statements.findByUsername.get(config.userId, username);
    },
    getMe() {
      return statements.getMe.get(config.userId);
    },
    insertAdmin(username, passwordHash) {
      return statements.insertAdmin.run(config.userId, username, passwordHash);
    },
    updateAdmin(username, passwordHash) {
      return statements.updateAdmin.run(username, passwordHash, config.userId);
    }
  };
}

function serializeSettings(row) {
  return {
    layoutColumns: row.layout_columns,
    projectLayoutColumns: row.project_layout_columns,
    editMode: Boolean(row.edit_mode),
    projectLinkDisplayMode: normalizeDisplayMode(row.project_link_display_mode, 'centered'),
    bookmarkLinkDisplayMode: normalizeDisplayMode(row.bookmark_link_display_mode, 'centered'),
    projectLinkSize: normalizeLinkSize(row.project_link_size, 'medium'),
    bookmarkLinkSize: normalizeLinkSize(row.bookmark_link_size, 'medium'),
    bookmarkGlass: row.bookmark_glass !== undefined ? Boolean(row.bookmark_glass) : true,
    backgroundUrl: row.background_url || ''
  };
}

function createSettingsStore(db, config) {
  const statements = {
    ensure: db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)'),
    get: db.prepare('SELECT * FROM user_settings WHERE user_id = ?'),
    update: db.prepare(`
      UPDATE user_settings
      SET layout_columns = ?,
          project_layout_columns = ?,
          edit_mode = ?,
          project_link_display_mode = ?,
          bookmark_link_display_mode = ?,
          project_link_size = ?,
          bookmark_link_size = ?,
          bookmark_glass = ?,
          background_url = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `),
    updateBackground: db.prepare(`
      UPDATE user_settings
      SET background_url = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `)
  };

  return {
    ensure() {
      statements.ensure.run(config.userId);
    },
    get() {
      return serializeSettings(statements.get.get(config.userId));
    },
    update(next) {
      statements.update.run(
        next.layoutColumns,
        next.projectLayoutColumns,
        next.editMode ? 1 : 0,
        next.projectLinkDisplayMode,
        next.bookmarkLinkDisplayMode,
        next.projectLinkSize,
        next.bookmarkLinkSize,
        next.bookmarkGlass ? 1 : 0,
        next.backgroundUrl,
        config.userId
      );
      return this.get();
    },
    updateBackground(backgroundUrl) {
      statements.updateBackground.run(backgroundUrl, config.userId);
      return this.get();
    }
  };
}

function createLinksStore(db, config) {
  const statements = {
    get: db.prepare(`
      SELECT
        id,
        link_key AS linkKey,
        link_type AS linkType,
        title,
        url,
        icon_mode AS iconMode,
        icon_version AS iconVersion
      FROM nav_links
      WHERE user_id = ? AND link_type = ?
      ORDER BY sort_order ASC, id ASC
    `),
    nextSortOrder: db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
      FROM nav_links
      WHERE user_id = ? AND link_type = ?
    `),
    insert: db.prepare(`
      INSERT INTO nav_links (user_id, link_key, link_type, title, url, icon_mode, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    findByKey: db.prepare('SELECT id FROM nav_links WHERE user_id = ? AND link_key = ?'),
    normalizeRequiredEmailLink: db.prepare(`
      UPDATE nav_links
      SET link_type = 'email',
          icon_mode = 'none',
          icon_version = CASE
            WHEN icon_mode = 'none' THEN icon_version
            ELSE icon_version + 1
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND link_key = ? AND (link_type != 'email' OR icon_mode != 'none')
    `),
    findById: db.prepare(`
      SELECT
        id,
        link_key AS linkKey,
        link_type AS linkType,
        title,
        url,
        icon_mode AS iconMode,
        icon_version AS iconVersion
      FROM nav_links
      WHERE user_id = ? AND id = ?
    `),
    findRequiredEmailCandidate: db.prepare(`
      SELECT id
      FROM nav_links
      WHERE user_id = ? AND link_type = 'email' AND link_key IS NULL AND url = ?
      ORDER BY sort_order ASC, id ASC
      LIMIT 1
    `),
    updateExistingAsRequiredEmail: db.prepare(`
      UPDATE nav_links
      SET link_key = ?,
          title = ?,
          link_type = 'email',
          icon_mode = 'none',
          icon_version = icon_version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id = ?
    `),
    findForUpdate: db.prepare(`
      SELECT link_key, url, icon_mode, icon_version
      FROM nav_links
      WHERE user_id = ? AND id = ?
    `),
    update: db.prepare(`
      UPDATE nav_links
      SET link_type = ?,
          title = ?,
          url = ?,
          icon_mode = ?,
          icon_version = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id = ?
    `),
    delete: db.prepare('DELETE FROM nav_links WHERE user_id = ? AND id = ?'),
    bumpIconVersion: db.prepare(`
      UPDATE nav_links
      SET icon_version = icon_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id = ?
    `),
    bumpAllIconVersions: db.prepare(`
      UPDATE nav_links
      SET icon_version = icon_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND icon_mode != 'none'
    `),
    updateSort: db.prepare(`
      UPDATE nav_links
      SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id = ?
    `)
  };

  function get(linkType = 'website') {
    return statements.get.all(config.userId, normalizeLinkType(linkType));
  }

  return {
    get,
    getResponse() {
      return {
        links: get('website'),
        emailLinks: get('email'),
        projectLinks: get('project')
      };
    },
    create(payload) {
      const row = statements.nextSortOrder.get(config.userId, payload.linkType);
      const iconMode = payload.linkType === 'email' ? 'none' : payload.iconMode;
      statements.insert.run(
        config.userId,
        payload.linkKey || null,
        payload.linkType,
        payload.title,
        payload.url,
        iconMode,
        row.next_order
      );
      return this.getResponse();
    },
    ensureDefaultEmailLink() {
      const emailLink = config.defaultEmailLink;
      if (statements.findByKey.get(config.userId, emailLink.linkKey)) {
        statements.normalizeRequiredEmailLink.run(config.userId, emailLink.linkKey);
        return;
      }

      const existingEmailRow = statements.findRequiredEmailCandidate.get(config.userId, emailLink.url);
      if (existingEmailRow) {
        statements.updateExistingAsRequiredEmail.run(
          emailLink.linkKey,
          emailLink.title,
          config.userId,
          existingEmailRow.id
        );
        return;
      }

      const row = statements.nextSortOrder.get(config.userId, 'email');
      statements.insert.run(
        config.userId,
        emailLink.linkKey,
        'email',
        emailLink.title,
        emailLink.url,
        'none',
        row.next_order
      );
    },
    findById(id) {
      return statements.findById.get(config.userId, id);
    },
    update(id, payload) {
      const existing = statements.findForUpdate.get(config.userId, id);
      if (!existing) return { notFound: true };

      const nextLinkType = config.requiredLinkKeys.has(existing.link_key) ? 'email' : payload.linkType;
      const iconMode = nextLinkType === 'email' ? 'none' : payload.iconMode;
      const iconChanged = existing.url !== payload.url || existing.icon_mode !== iconMode;
      const iconVersion = iconChanged ? Number(existing.icon_version || 1) + 1 : Number(existing.icon_version || 1);
      const result = statements.update.run(
        nextLinkType,
        payload.title,
        payload.url,
        iconMode,
        iconVersion,
        config.userId,
        id
      );
      if (Number(result.changes) === 0) return { notFound: true };
      return {
        invalidatedIcon: iconChanged ? { entityType: 'links', id: Number(id) } : null,
        value: this.getResponse()
      };
    },
    delete(id) {
      const existing = statements.findForUpdate.get(config.userId, id);
      if (!existing) return { notFound: true };
      if (config.requiredLinkKeys.has(existing.link_key)) return { required: true };

      const result = statements.delete.run(config.userId, id);
      if (Number(result.changes) === 0) return { notFound: true };
      return {
        invalidatedIcon: { entityType: 'links', id: Number(id) },
        value: this.getResponse()
      };
    },
    bumpIconVersion(id) {
      const result = statements.bumpIconVersion.run(config.userId, id);
      if (Number(result.changes) === 0) return { notFound: true };
      return { value: this.findById(id) };
    },
    bumpAllIconVersions() {
      statements.bumpAllIconVersions.run(config.userId);
      return this.getResponse();
    },
    reorder(linkType, ids) {
      const currentIds = get(linkType).map((link) => link.id);
      const currentSet = new Set(currentIds);
      const uniqueIds = new Set(ids);

      if (
        ids.length !== currentIds.length ||
        uniqueIds.size !== currentIds.length ||
        ids.some((id) => !currentSet.has(id))
      ) {
        return { error: '排序数据无效' };
      }

      try {
        db.exec('BEGIN');
        ids.forEach((id, index) => statements.updateSort.run(index, config.userId, id));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }

      return { value: this.getResponse() };
    }
  };
}

function createSearchEnginesStore(db, config) {
  const statements = {
    get: db.prepare(`
      SELECT
        id,
        engine_key AS engineKey,
        name,
        url_template AS urlTemplate,
        icon_version AS iconVersion
      FROM search_engines
      WHERE user_id = ?
      ORDER BY sort_order ASC, id ASC
    `),
    count: db.prepare('SELECT COUNT(*) AS count FROM search_engines WHERE user_id = ?'),
    maxSort: db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order
      FROM search_engines
      WHERE user_id = ?
    `),
    findByKey: db.prepare('SELECT id FROM search_engines WHERE user_id = ? AND engine_key = ?'),
    findById: db.prepare(`
      SELECT
        id,
        engine_key AS engineKey,
        name,
        url_template AS urlTemplate,
        icon_version AS iconVersion
      FROM search_engines
      WHERE user_id = ? AND id = ?
    `),
    findByName: db.prepare(`
      SELECT id
      FROM search_engines
      WHERE user_id = ? AND engine_key IS NULL AND lower(name) = lower(?)
      ORDER BY sort_order ASC, id ASC
      LIMIT 1
    `),
    findByTemplate: db.prepare(`
      SELECT id
      FROM search_engines
      WHERE user_id = ? AND engine_key IS NULL AND url_template = ?
      ORDER BY sort_order ASC, id ASC
      LIMIT 1
    `),
    assignKey: db.prepare(`
      UPDATE search_engines
      SET engine_key = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id = ?
    `),
    insert: db.prepare(`
      INSERT INTO search_engines (user_id, engine_key, name, url_template, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `),
    updateDefaultSort: db.prepare(`
      UPDATE search_engines
      SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND engine_key = ?
    `),
    customRows: db.prepare(`
      SELECT id
      FROM search_engines
      WHERE user_id = ? AND engine_key IS NULL
      ORDER BY sort_order ASC, id ASC
    `),
    updateCustomSort: db.prepare(`
      UPDATE search_engines
      SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id = ?
    `),
    updateSort: db.prepare(`
      UPDATE search_engines
      SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id = ?
    `),
    update: db.prepare(`
      UPDATE search_engines
      SET name = ?, url_template = ?, icon_version = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id = ?
    `),
    findForUpdate: db.prepare(`
      SELECT engine_key, url_template, icon_version
      FROM search_engines
      WHERE user_id = ? AND id = ?
    `),
    findForDelete: db.prepare('SELECT engine_key FROM search_engines WHERE user_id = ? AND id = ?'),
    delete: db.prepare('DELETE FROM search_engines WHERE user_id = ? AND id = ?'),
    bumpAllIconVersions: db.prepare(`
      UPDATE search_engines
      SET icon_version = icon_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `),
    nextSortOrder: db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
      FROM search_engines
      WHERE user_id = ?
    `)
  };

  return {
    get() {
      return statements.get.all(config.userId);
    },
    findById(id) {
      return statements.findById.get(config.userId, id);
    },
    create(payload) {
      const row = statements.nextSortOrder.get(config.userId);
      statements.insert.run(config.userId, null, payload.name, payload.urlTemplate, row.next_order);
      return this.get();
    },
    ensureDefaults() {
      const existingCountRow = statements.count.get(config.userId);
      const shouldSeedAllDefaults = Number(existingCountRow.count) === 0;
      const maxSortRow = statements.maxSort.get(config.userId);
      let nextSortOrder = Number(maxSortRow.max_sort_order) + 1;

      config.defaultSearchEngines.forEach((engine) => {
        if (!shouldSeedAllDefaults && !config.requiredSearchEngineKeys.has(engine.engineKey)) return;
        if (statements.findByKey.get(config.userId, engine.engineKey)) return;

        const existingNameRow = statements.findByName.get(config.userId, engine.name);
        if (existingNameRow) {
          statements.assignKey.run(engine.engineKey, config.userId, existingNameRow.id);
          return;
        }

        const existingTemplateRow = statements.findByTemplate.get(config.userId, engine.urlTemplate);
        if (existingTemplateRow) {
          statements.assignKey.run(engine.engineKey, config.userId, existingTemplateRow.id);
          return;
        }

        statements.insert.run(
          config.userId,
          engine.engineKey,
          engine.name,
          engine.urlTemplate,
          nextSortOrder
        );
        nextSortOrder += 1;
      });

      config.defaultSearchEngines.forEach((engine, index) => {
        statements.updateDefaultSort.run(index, config.userId, engine.engineKey);
      });

      statements.customRows.all(config.userId).forEach((row, index) => {
        statements.updateCustomSort.run(config.defaultSearchEngines.length + index, config.userId, row.id);
      });
    },
    reorder(ids) {
      const currentIds = this.get().map((engine) => engine.id);
      const currentSet = new Set(currentIds);
      const uniqueIds = new Set(ids);

      if (
        ids.length !== currentIds.length ||
        uniqueIds.size !== currentIds.length ||
        ids.some((id) => !currentSet.has(id))
      ) {
        return { error: '排序数据无效' };
      }

      try {
        db.exec('BEGIN');
        ids.forEach((id, index) => statements.updateSort.run(index, config.userId, id));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }

      return { value: this.get() };
    },
    update(id, payload) {
      const existing = statements.findForUpdate.get(config.userId, id);
      if (!existing) return { notFound: true };

      const iconChanged = existing.url_template !== payload.urlTemplate;
      const iconVersion = iconChanged ? Number(existing.icon_version || 1) + 1 : Number(existing.icon_version || 1);
      const result = statements.update.run(payload.name, payload.urlTemplate, iconVersion, config.userId, id);
      if (Number(result.changes) === 0) return { notFound: true };
      return {
        invalidatedIcon: iconChanged ? { entityType: 'search-engines', id: Number(id) } : null,
        value: this.get()
      };
    },
    delete(id) {
      const engine = statements.findForDelete.get(config.userId, id);
      if (!engine) return { notFound: true };
      if (config.requiredSearchEngineKeys.has(engine.engine_key)) return { required: true };

      const result = statements.delete.run(config.userId, id);
      if (Number(result.changes) === 0) return { notFound: true };
      return {
        invalidatedIcon: { entityType: 'search-engines', id: Number(id) },
        value: this.get()
      };
    },
    bumpAllIconVersions() {
      statements.bumpAllIconVersions.run(config.userId);
      return this.get();
    }
  };
}

function createStores(db, config) {
  return {
    users: createUserStore(db, config),
    settings: createSettingsStore(db, config),
    links: createLinksStore(db, config),
    searchEngines: createSearchEnginesStore(db, config)
  };
}

module.exports = {
  createLinksStore,
  createSearchEnginesStore,
  createSettingsStore,
  createStores,
  createUserStore,
  serializeSettings
};

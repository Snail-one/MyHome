const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { createIconFetcher, normalizeIconTargetUrl } = require('./iconFetcher');
const {
  getIconContentType,
  iconContentTypeByExtension
} = require('./imageTypes');

function createIconService(config, deps = {}) {
  const iconFetcher = deps.iconFetcher || createIconFetcher(config);
  const iconResolutionCache = new Map();

  function normalizeFetcherTargetUrl(value) {
    return typeof iconFetcher.normalizeIconTargetUrl === 'function'
      ? iconFetcher.normalizeIconTargetUrl(value)
      : normalizeIconTargetUrl(value);
  }

  function getOriginTargetUrl(value) {
    const normalizedUrl = normalizeFetcherTargetUrl(value);
    if (!normalizedUrl) return null;

    try {
      const parsedUrl = new URL(normalizedUrl);
      return `${parsedUrl.origin}/`;
    } catch {
      return null;
    }
  }

  async function resolveIconForTarget(targetUrl) {
    const originTargetUrl = getOriginTargetUrl(targetUrl);
    if (!originTargetUrl) return { icon: null, sourceUrl: '', targetUrl: '' };
    if (iconResolutionCache.has(originTargetUrl)) return iconResolutionCache.get(originTargetUrl);

    const resolutionPromise = iconFetcher.resolveIconForUrl(originTargetUrl).catch((error) => {
      iconResolutionCache.delete(originTargetUrl);
      throw error;
    });
    iconResolutionCache.set(originTargetUrl, resolutionPromise);
    return resolutionPromise;
  }

  function getEntityCachePrefix(entityType, entityId) {
    return `${entityType}-${Number.parseInt(entityId, 10)}`;
  }

  function getEntityMetadataPath(entityType, entityId) {
    return path.join(config.iconCacheDir, `${getEntityCachePrefix(entityType, entityId)}.json`);
  }

  function getEntityFileUrl(entityType, entityId, version) {
    return `/api/icons/${entityType}/${Number.parseInt(entityId, 10)}/file?v=${encodeURIComponent(String(version || 1))}`;
  }

  async function readEntityIconMetadata(entityType, entityId) {
    try {
      const content = await fs.promises.readFile(getEntityMetadataPath(entityType, entityId), 'utf8');
      const metadata = JSON.parse(content);
      return metadata && typeof metadata === 'object' ? metadata : null;
    } catch {
      return null;
    }
  }

  async function writeEntityIconMetadata(entityType, entityId, metadata) {
    await fs.promises.mkdir(config.iconCacheDir, { recursive: true });
    await fs.promises.writeFile(
      getEntityMetadataPath(entityType, entityId),
      JSON.stringify(metadata, null, 2)
    );
  }

  async function deleteEntityIconFiles(entityType, entityId, keepFileName) {
    const prefix = getEntityCachePrefix(entityType, entityId);
    const entries = await fs.promises.readdir(config.iconCacheDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter((entry) => (
        entry.isFile() &&
        entry.name !== keepFileName &&
        entry.name.startsWith(`${prefix}.`) &&
        iconContentTypeByExtension.has(path.extname(entry.name).toLowerCase())
      ))
      .map((entry) => fs.promises.unlink(path.join(config.iconCacheDir, entry.name)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      })));
  }

  async function deleteEntityIcon(entityType, entityId) {
    const prefix = getEntityCachePrefix(entityType, entityId);
    const entries = await fs.promises.readdir(config.iconCacheDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.isFile() && (
        entry.name === `${prefix}.json` ||
        (entry.name.startsWith(`${prefix}.`) && (
          iconContentTypeByExtension.has(path.extname(entry.name).toLowerCase()) ||
          entry.name.endsWith('.tmp')
        ))
      ))
      .map((entry) => fs.promises.unlink(path.join(config.iconCacheDir, entry.name)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      })));
  }

  async function clearIconCache() {
    iconResolutionCache.clear();
    const entries = await fs.promises.readdir(config.iconCacheDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.isFile())
      .map((entry) => fs.promises.unlink(path.join(config.iconCacheDir, entry.name)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      })));
  }

  async function findCachedEntityIcon(entityType, entityId, version) {
    const metadata = await readEntityIconMetadata(entityType, entityId);
    if (!metadata || metadata.status !== 'ready' || Number(metadata.version) !== Number(version)) return null;

    const fileName = metadata.fileName;
    const extension = path.extname(fileName || '').toLowerCase();
    if (!fileName || !iconContentTypeByExtension.has(extension)) return null;

    const filePath = path.join(config.iconCacheDir, fileName);
    const stats = await fs.promises.stat(filePath).catch(() => null);
    if (!stats?.isFile()) return null;

    return {
      filePath,
      contentType: metadata.contentType || getIconContentType(extension),
      etag: `"${getEntityCachePrefix(entityType, entityId)}-v${Number(version)}"`,
      metadata
    };
  }

  async function getEntityIconStatus(entityType, entity, options = {}) {
    const metadata = await readEntityIconMetadata(entityType, entity.id);
    const version = Number(entity.iconVersion || 1);
    const iconMode = options.iconMode || entity.iconMode || 'server';
    const baseStatus = {
      entityType,
      id: entity.id,
      iconMode,
      iconVersion: version,
      fileUrl: getEntityFileUrl(entityType, entity.id, version)
    };

    if (iconMode === 'none') {
      return { ...baseStatus, status: 'none' };
    }

    if (!metadata || Number(metadata.version) !== version) {
      return { ...baseStatus, status: 'empty' };
    }

    return {
      ...baseStatus,
      status: metadata.status || 'empty',
      source: metadata.source || null,
      sourceUrl: metadata.sourceUrl || '',
      contentType: metadata.contentType || '',
      savedAt: metadata.savedAt || ''
    };
  }

  async function writeEntityIcon(entityType, entityId, version, icon, metadata = {}) {
    await fs.promises.mkdir(config.iconCacheDir, { recursive: true });
    const prefix = getEntityCachePrefix(entityType, entityId);
    const finalFileName = `${prefix}${icon.extension}`;
    const finalPath = path.join(config.iconCacheDir, finalFileName);
    const tempPath = path.join(config.iconCacheDir, `${prefix}.${crypto.randomBytes(8).toString('hex')}.tmp`);

    await fs.promises.writeFile(tempPath, icon.buffer);
    await fs.promises.rename(tempPath, finalPath);
    await deleteEntityIconFiles(entityType, entityId, finalFileName);
    await writeEntityIconMetadata(entityType, entityId, {
      entityType,
      entityId: Number.parseInt(entityId, 10),
      version: Number(version || 1),
      status: 'ready',
      source: metadata.source || 'server',
      sourceUrl: metadata.sourceUrl || '',
      targetUrl: metadata.targetUrl || '',
      fileName: finalFileName,
      contentType: icon.contentType,
      savedAt: new Date().toISOString()
    });

    return {
      filePath: finalPath,
      contentType: icon.contentType
    };
  }

  async function markEntityIconMiss(entityType, entityId, version, metadata = {}) {
    await deleteEntityIconFiles(entityType, entityId);
    await writeEntityIconMetadata(entityType, entityId, {
      entityType,
      entityId: Number.parseInt(entityId, 10),
      version: Number(version || 1),
      status: 'miss',
      source: metadata.source || 'server',
      targetUrl: metadata.targetUrl || '',
      error: metadata.error || '',
      savedAt: new Date().toISOString()
    });
  }

  async function resolveLinkIcon(link) {
    if (!link) return { notFound: true };
    if (link.linkType === 'email') return getEntityIconStatus('links', link, { iconMode: 'none' });
    if (link.iconMode === 'none') return getEntityIconStatus('links', link, { iconMode: 'none' });
    if (link.iconMode === 'upload') return getEntityIconStatus('links', link, { iconMode: 'upload' });
    if (link.iconMode === 'local') return getEntityIconStatus('links', link, { iconMode: 'local' });

    const resolved = await resolveIconForTarget(link.url);
    if (resolved?.icon) {
      await writeEntityIcon('links', link.id, link.iconVersion, resolved.icon, {
        source: 'server',
        sourceUrl: resolved.sourceUrl,
        targetUrl: resolved.targetUrl
      });
      return getEntityIconStatus('links', link);
    }

    await markEntityIconMiss('links', link.id, link.iconVersion, {
      source: 'server',
      targetUrl: resolved?.targetUrl || getOriginTargetUrl(link.url) || ''
    });
    return getEntityIconStatus('links', link);
  }

  function getSearchEngineTargetUrl(engine) {
    if (!engine?.urlTemplate) return null;
    const sampleUrl = engine.urlTemplate.replaceAll('{query}', 'test');
    return getOriginTargetUrl(sampleUrl);
  }

  async function resolveSearchEngineIcon(engine) {
    if (!engine) return { notFound: true };
    const targetUrl = getSearchEngineTargetUrl(engine);
    const resolved = await resolveIconForTarget(targetUrl);
    if (resolved?.icon) {
      await writeEntityIcon('search-engines', engine.id, engine.iconVersion, resolved.icon, {
        source: 'server',
        sourceUrl: resolved.sourceUrl,
        targetUrl: resolved.targetUrl
      });
      return getEntityIconStatus('search-engines', engine);
    }

    await markEntityIconMiss('search-engines', engine.id, engine.iconVersion, {
      source: 'server',
      targetUrl: resolved?.targetUrl || targetUrl || ''
    });
    return getEntityIconStatus('search-engines', engine);
  }

  return {
    clearIconCache,
    deleteEntityIcon,
    findCachedEntityIcon,
    getEntityFileUrl,
    getEntityIconStatus,
    getSearchEngineTargetUrl,
    normalizeIconTargetUrl: normalizeFetcherTargetUrl,
    resolveLinkIcon,
    resolveSearchEngineIcon
  };
}

module.exports = {
  createIconService
};

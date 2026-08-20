const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const { createIconFetcher, normalizeIconTargetUrl } = require('./iconFetcher');
const {
  getIconContentType,
  iconContentTypeByExtension
} = require('./imageTypes');

const COMMON_SECOND_LEVEL_PUBLIC_SUFFIXES = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'gov',
  'mil',
  'net',
  'ne',
  'or',
  'org'
]);

function getPublicIconFileUrl(fileName, version = 1) {
  if (!fileName) return '';
  return `/icon-cache/${encodeURIComponent(String(fileName))}?v=${encodeURIComponent(String(version || 1))}`;
}

function createIconService(config, deps = {}) {
  const iconFetcher = deps.iconFetcher || createIconFetcher(config);
  const stores = deps.stores;
  const iconResolutionCache = new Map();
  const inFlightResolves = new Map();
  const resolveWaiters = [];
  const ICON_CACHE_MAX_SIZE = 200;
  const ICON_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
  const MAX_PARALLEL_RESOLVES = 5;
  let activeResolves = 0;

  function evictExpiredCacheEntries(now) {
    for (const [key, entry] of iconResolutionCache) {
      if (now - entry.timestamp > ICON_CACHE_TTL_MS) {
        iconResolutionCache.delete(key);
      }
    }
  }

  function evictOldestCacheEntry() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of iconResolutionCache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) iconResolutionCache.delete(oldestKey);
  }

  function normalizeFetcherTargetUrl(value) {
    return typeof iconFetcher.normalizeIconTargetUrl === 'function'
      ? iconFetcher.normalizeIconTargetUrl(value)
      : normalizeIconTargetUrl(value);
  }

  function getRootHostname(hostname) {
    const normalizedHostname = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!normalizedHostname || net.isIP(normalizedHostname) || normalizedHostname === 'localhost') {
      return normalizedHostname;
    }

    const labels = normalizedHostname.split('.').filter(Boolean);
    if (labels.length <= 2) return normalizedHostname;

    const lastLabel = labels[labels.length - 1];
    const secondLastLabel = labels[labels.length - 2];
    const rootLabelCount = lastLabel.length === 2 && COMMON_SECOND_LEVEL_PUBLIC_SUFFIXES.has(secondLastLabel) ? 3 : 2;
    return labels.slice(-rootLabelCount).join('.');
  }

  function formatHostnameForUrl(hostname) {
    return net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  }

  function formatRootTargetUrl(protocol, hostname, port = '') {
    return `${protocol}//${formatHostnameForUrl(hostname)}${port ? `:${port}` : ''}/`;
  }

  function getTargetUrlCandidates(value) {
    const normalizedUrl = normalizeFetcherTargetUrl(value);
    if (!normalizedUrl) return [];

    try {
      const parsedUrl = new URL(normalizedUrl);
      const originalHostname = parsedUrl.hostname;
      const protocol = parsedUrl.protocol;
      const port = parsedUrl.port;
      if (!originalHostname) return [];

      const candidates = [];

      // First try with the original hostname (preserve subdomains like www.)
      // Only fall back to stripping to root domain after these fail.
      const originalTarget = formatRootTargetUrl(protocol, originalHostname, port);
      candidates.push(originalTarget);

      const rootHostname = getRootHostname(originalHostname);
      if (rootHostname && rootHostname !== originalHostname) {
        const rootTarget = formatRootTargetUrl(protocol, rootHostname, port);
        if (!candidates.includes(rootTarget)) candidates.push(rootTarget);

        if (!net.isIP(rootHostname) && rootHostname !== 'localhost' && rootHostname.includes('.')) {
          const wwwRootTarget = formatRootTargetUrl(protocol, `www.${rootHostname}`, port);
          if (!candidates.includes(wwwRootTarget)) candidates.push(wwwRootTarget);
        }
      }

      // 兜底：请求用户保存的完整地址（带路径）去获取图标
      // 有些站点只在具体页面里声明了 <link rel="icon">，或者根域名受限时作为最后后备
      if (normalizedUrl && !candidates.includes(normalizedUrl)) {
        candidates.push(normalizedUrl);
      }

      return candidates;
    } catch {
      return [];
    }
  }

  function getPrimaryTargetUrl(value) {
    return getTargetUrlCandidates(value)[0] || null;
  }

  async function resolveIconForSingleTarget(targetUrl) {
    const now = Date.now();
    const cached = iconResolutionCache.get(targetUrl);
    if (cached) {
      if (now - cached.timestamp > ICON_CACHE_TTL_MS) {
        iconResolutionCache.delete(targetUrl);
      } else {
        return cached.promise;
      }
    }

    const resolutionPromise = iconFetcher.resolveIconForUrl(targetUrl).catch((error) => {
      iconResolutionCache.delete(targetUrl);
      throw error;
    });

    // Evict expired entries periodically, then oldest if still over limit
    if (iconResolutionCache.size >= ICON_CACHE_MAX_SIZE) {
      evictExpiredCacheEntries(now);
      if (iconResolutionCache.size >= ICON_CACHE_MAX_SIZE) {
        evictOldestCacheEntry();
      }
    }

    iconResolutionCache.set(targetUrl, { promise: resolutionPromise, timestamp: now });
    return resolutionPromise;
  }

  async function resolveIconForTarget(targetUrl) {
    const targetUrlCandidates = getTargetUrlCandidates(targetUrl);
    if (!targetUrlCandidates.length) return { icon: null, sourceUrl: '', targetUrl: '' };

    let lastResolved = null;
    for (const candidateTargetUrl of targetUrlCandidates) {
      try {
        const resolved = await resolveIconForSingleTarget(candidateTargetUrl);
        lastResolved = resolved || { icon: null, sourceUrl: '', targetUrl: candidateTargetUrl };
        if (lastResolved.icon) return lastResolved;
      } catch (error) {
        lastResolved = { icon: null, sourceUrl: '', targetUrl: candidateTargetUrl, error: error.message };
      }
    }

    return lastResolved || { icon: null, sourceUrl: '', targetUrl: targetUrlCandidates[0] };
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

  function persistIconState(entityType, entityId, patch) {
    try {
      if (entityType === 'links') stores?.links?.updateIconState?.(entityId, patch);
      if (entityType === 'search-engines') stores?.searchEngines?.updateIconState?.(entityId, patch);
    } catch (error) {
      if (!/finalized|closed/i.test(error.message || '')) throw error;
    }
  }

  function broadcastIconState(entityType, entityId, version, status, fileName) {
    if (typeof deps.broadcastIcon !== 'function') return;
    deps.broadcastIcon({
      entityType,
      id: Number.parseInt(entityId, 10),
      iconVersion: Number(version || 1),
      status,
      fileUrl: status === 'ready' ? getPublicIconFileUrl(fileName, version) : ''
    });
  }

  function persistAndBroadcast(entityType, entityId, version, status, fileName) {
    persistIconState(entityType, entityId, {
      iconStatus: status,
      iconFileName: fileName || null
    });
    broadcastIconState(entityType, entityId, version, status, fileName);
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
    persistIconState(entityType, entityId, { iconStatus: 'empty', iconFileName: null });
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

  function getResolveKey(entityType, entity) {
    return `${entityType}:${Number.parseInt(entity?.id, 10) || 0}:${Number(entity?.iconVersion || 1)}`;
  }

  function isResolveInFlight(entityType, entity) {
    return inFlightResolves.has(getResolveKey(entityType, entity));
  }

  async function withResolveSlot(work) {
    if (activeResolves >= MAX_PARALLEL_RESOLVES) {
      await new Promise((resolve) => {
        resolveWaiters.push(resolve);
      });
    }

    activeResolves += 1;
    try {
      return await work();
    } finally {
      activeResolves -= 1;
      const next = resolveWaiters.shift();
      if (next) next();
    }
  }

  function startTrackedResolve(entityType, entity, work) {
    const key = getResolveKey(entityType, entity);
    const existing = inFlightResolves.get(key);
    if (existing) return existing;

    const promise = withResolveSlot(work).finally(() => {
      if (inFlightResolves.get(key) === promise) inFlightResolves.delete(key);
    });
    inFlightResolves.set(key, promise);
    return promise;
  }

  async function getEntityIconStatus(entityType, entity, options = {}) {
    const version = Number(entity.iconVersion || 1);
    const iconMode = options.iconMode || entity.iconMode || 'server';
    const dbFileName = entity.iconFileName || '';
    const dbStatus = entity.iconStatus;
    const baseStatus = {
      entityType,
      id: entity.id,
      iconMode,
      iconVersion: version,
      fileUrl: ''
    };

    if (iconMode === 'none') {
      return { ...baseStatus, status: 'none' };
    }

    if (dbStatus === 'ready' && dbFileName) {
      return {
        ...baseStatus,
        status: 'ready',
        fileUrl: getPublicIconFileUrl(dbFileName, version)
      };
    }

    if (dbStatus === 'miss') {
      return { ...baseStatus, status: 'miss' };
    }

    const metadata = await readEntityIconMetadata(entityType, entity.id);
    if (metadata && Number(metadata.version) === version) {
      const fileUrl = metadata.status === 'ready' && metadata.fileName
        ? getPublicIconFileUrl(metadata.fileName, version)
        : '';
      return {
        ...baseStatus,
        status: metadata.status || 'empty',
        source: metadata.source || null,
        sourceUrl: metadata.sourceUrl || '',
        contentType: metadata.contentType || '',
        savedAt: metadata.savedAt || '',
        fileUrl
      };
    }

    if (isResolveInFlight(entityType, entity)) {
      return { ...baseStatus, status: 'pending' };
    }

    return { ...baseStatus, status: dbStatus || 'empty' };
  }

  async function getReusableEntityIconStatus(entityType, entity, options = {}) {
    if (options.force) return null;

    const version = Number(entity.iconVersion || 1);
    const metadata = await readEntityIconMetadata(entityType, entity.id);
    if (!metadata || Number(metadata.version) !== version) return null;

    if (metadata.status === 'miss') {
      return getEntityIconStatus(entityType, entity);
    }

    if (metadata.status === 'ready') {
      const cachedIcon = await findCachedEntityIcon(entityType, entity.id, version);
      if (cachedIcon) return getEntityIconStatus(entityType, entity);
    }

    return null;
  }

  async function writeEntityIcon(entityType, entityId, version, icon, metadata = {}) {
    const existing = await readEntityIconMetadata(entityType, entityId);
    if (existing && Number(existing.version) > Number(version || 1)) {
      return { skipped: true };
    }

    await fs.promises.mkdir(config.iconCacheDir, { recursive: true });
    const prefix = getEntityCachePrefix(entityType, entityId);
    const finalFileName = `${prefix}${icon.extension}`;
    const finalPath = path.join(config.iconCacheDir, finalFileName);
    const tempPath = path.join(config.iconCacheDir, `${prefix}.${crypto.randomBytes(8).toString('hex')}.tmp`);

    await fs.promises.writeFile(tempPath, icon.buffer);
    try {
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
      persistAndBroadcast(entityType, entityId, version, 'ready', finalFileName);
    } catch (error) {
      // Clean up temp file on any failure after write
      await fs.promises.unlink(tempPath).catch(() => {});
      throw error;
    }

    return {
      filePath: finalPath,
      contentType: icon.contentType
    };
  }

  async function markEntityIconMiss(entityType, entityId, version, metadata = {}) {
    const existing = await readEntityIconMetadata(entityType, entityId);
    if (existing && Number(existing.version) > Number(version || 1)) {
      return { skipped: true };
    }

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
    persistAndBroadcast(entityType, entityId, version, 'miss', '');
  }

  async function getImmediateLinkIconStatus(link, options = {}) {
    if (!link) return { notFound: true };
    if (link.linkType === 'email') return getEntityIconStatus('links', link, { iconMode: 'none' });
    if (link.iconMode === 'none') return getEntityIconStatus('links', link, { iconMode: 'none' });
    if (link.iconMode === 'upload') return getEntityIconStatus('links', link, { iconMode: 'upload' });
    if (link.iconMode === 'local') return getEntityIconStatus('links', link, { iconMode: 'local' });
    if (options.force) return null;
    const status = await getEntityIconStatus('links', link, options);
    if (status.status === 'ready' || status.status === 'miss') return status;
    return getReusableEntityIconStatus('links', link, options);
  }

  async function fetchAndStoreLinkIcon(link) {
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
      targetUrl: resolved?.targetUrl || getPrimaryTargetUrl(link.url) || ''
    });
    return getEntityIconStatus('links', link);
  }

  async function resolveLinkIcon(link, options = {}) {
    const immediate = await getImmediateLinkIconStatus(link, options);
    if (immediate) return immediate;
    return startTrackedResolve('links', link, () => fetchAndStoreLinkIcon(link));
  }

  async function ensureLinkIcon(link, options = {}) {
    const immediate = await getImmediateLinkIconStatus(link, options);
    if (immediate?.notFound) return immediate;
    if (immediate) return { accepted: false, status: immediate };
    startTrackedResolve('links', link, () => fetchAndStoreLinkIcon(link));
    return { accepted: true, status: await getEntityIconStatus('links', link, options) };
  }

  function prefetchLinkIcon(link) {
    ensureLinkIcon(link).catch((error) => {
      console.warn('Failed to prefetch link icon:', error.message);
    });
  }

  function getSearchEngineTargetUrl(engine) {
    if (!engine?.urlTemplate) return null;
    const sampleUrl = engine.urlTemplate.replaceAll('{query}', 'test');
    return getPrimaryTargetUrl(sampleUrl);
  }

  async function getImmediateSearchEngineIconStatus(engine, options = {}) {
    if (!engine) return { notFound: true };
    if (options.force) return null;
    const status = await getEntityIconStatus('search-engines', engine, options);
    if (status.status === 'ready' || status.status === 'miss') return status;
    return getReusableEntityIconStatus('search-engines', engine, options);
  }

  async function fetchAndStoreSearchEngineIcon(engine) {
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

  async function resolveSearchEngineIcon(engine, options = {}) {
    const immediate = await getImmediateSearchEngineIconStatus(engine, options);
    if (immediate) return immediate;
    return startTrackedResolve('search-engines', engine, () => fetchAndStoreSearchEngineIcon(engine));
  }

  async function ensureSearchEngineIcon(engine, options = {}) {
    const immediate = await getImmediateSearchEngineIconStatus(engine, options);
    if (immediate?.notFound) return immediate;
    if (immediate) return { accepted: false, status: immediate };
    startTrackedResolve('search-engines', engine, () => fetchAndStoreSearchEngineIcon(engine));
    return { accepted: true, status: await getEntityIconStatus('search-engines', engine, options) };
  }

  function prefetchSearchEngineIcon(engine) {
    ensureSearchEngineIcon(engine).catch((error) => {
      console.warn('Failed to prefetch search engine icon:', error.message);
    });
  }

  async function decorateLink(link) {
    const status = await getEntityIconStatus('links', link);
    return { ...link, iconStatus: status.status, iconFileUrl: status.fileUrl || '' };
  }

  async function decorateLinksResponse(payload = {}) {
    const [links, emailLinks, projectLinks] = await Promise.all([
      Promise.all((payload.links || []).map(decorateLink)),
      Promise.all((payload.emailLinks || []).map(decorateLink)),
      Promise.all((payload.projectLinks || []).map(decorateLink))
    ]);
    return { ...payload, links, emailLinks, projectLinks };
  }

  async function decorateSearchEngines(engines = []) {
    return Promise.all(engines.map(async (engine) => {
      const status = await getEntityIconStatus('search-engines', engine);
      return { ...engine, iconStatus: status.status, iconFileUrl: status.fileUrl || '' };
    }));
  }

  function hydrateFromDisk() {
    if (!stores) return;

    (stores.links.get('email') || []).forEach((link) => {
      if (link.iconMode === 'none' && link.iconStatus !== 'none') {
        persistIconState('links', link.id, { iconStatus: 'none', iconFileName: null });
      }
    });

    let entries = [];
    try {
      entries = fs.readdirSync(config.iconCacheDir);
    } catch {
      return;
    }

    entries.forEach((name) => {
      if (!name.endsWith('.json')) return;
      let metadata;
      try {
        metadata = JSON.parse(fs.readFileSync(path.join(config.iconCacheDir, name), 'utf8'));
      } catch {
        return;
      }
      if (!metadata?.entityType || !metadata.entityId) return;

      const entity = metadata.entityType === 'links'
        ? stores.links.findById(metadata.entityId)
        : stores.searchEngines?.findById(metadata.entityId);
      if (!entity) return;
      if (Number(metadata.version) !== Number(entity.iconVersion || 1)) return;
      if (entity.iconStatus === 'ready' || entity.iconStatus === 'miss') return;

      if (metadata.status === 'ready' && metadata.fileName) {
        persistIconState(metadata.entityType, metadata.entityId, {
          iconStatus: 'ready',
          iconFileName: metadata.fileName
        });
      } else if (metadata.status === 'miss') {
        persistIconState(metadata.entityType, metadata.entityId, {
          iconStatus: 'miss',
          iconFileName: null
        });
      }
    });
  }

  function prefetchLinksResponse(payload = {}) {
    [...(payload.links || []), ...(payload.projectLinks || [])].forEach(prefetchLinkIcon);
  }

  function prefetchSearchEngines(engines = []) {
    engines.forEach(prefetchSearchEngineIcon);
  }

  return {
    clearIconCache,
    decorateLinksResponse,
    decorateSearchEngines,
    deleteEntityIcon,
    ensureLinkIcon,
    ensureSearchEngineIcon,
    findCachedEntityIcon,
    getEntityFileUrl,
    getPublicIconFileUrl,
    getEntityIconStatus,
    hydrateFromDisk,
    getSearchEngineTargetUrl,
    normalizeIconTargetUrl: normalizeFetcherTargetUrl,
    prefetchLinkIcon,
    prefetchLinksResponse,
    prefetchSearchEngineIcon,
    prefetchSearchEngines,
    resolveLinkIcon,
    resolveSearchEngineIcon
  };
}

module.exports = {
  createIconService,
  getPublicIconFileUrl
};

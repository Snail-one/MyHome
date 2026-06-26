const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { safeFetch } = require('./httpSafety');
const {
  getIconContentType,
  getIconExtension,
  getIconExtensionFromUrl,
  iconContentTypeByExtension,
  isSupportedIconBuffer,
  normalizeContentType
} = require('./imageTypes');
const { normalizeUrl } = require('./validation');

function normalizeIconTargetUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;

  try {
    if (/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^https?:\/\//i.test(normalized)) return null;
    const parsedUrl = new URL(/^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
    if (parsedUrl.username || parsedUrl.password) return null;
    parsedUrl.hash = '';
    return parsedUrl.href;
  } catch {
    return null;
  }
}

function toHttpUrl(value, baseUrl) {
  try {
    const parsedUrl = new URL(value, baseUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
    if (parsedUrl.username || parsedUrl.password) return null;
    parsedUrl.hash = '';
    return parsedUrl.href;
  } catch {
    return null;
  }
}

async function readResponseBuffer(response, maxBytes, allowTruncate = false) {
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (!allowTruncate && Number.isInteger(contentLength) && contentLength > maxBytes) {
    throw new Error('Icon response is too large');
  }

  if (!response.body?.getReader) {
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > maxBytes) {
      if (allowTruncate) return buffer.subarray(0, maxBytes);
      throw new Error('Icon response is too large');
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = Buffer.from(value);
    if (totalBytes + chunk.length > maxBytes) {
      if (allowTruncate) {
        chunks.push(chunk.subarray(0, maxBytes - totalBytes));
        await reader.cancel().catch(() => {});
        break;
      }
      throw new Error('Icon response is too large');
    }
    totalBytes += chunk.length;
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function getHtmlAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[2] || match[3] || match[4] || '').trim() : '';
}

function getConventionalManifestCandidates(parsedUrl) {
  return [
    '/manifest.webmanifest',
    '/site.webmanifest',
    '/manifest.json',
    '/webmanifest.json'
  ].map((manifestPath) => `${parsedUrl.origin}${manifestPath}`);
}

function extractIconLinksFromHtml(html, pageUrl) {
  const candidates = [];

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = getHtmlAttribute(tag, 'rel').toLowerCase();
    const href = getHtmlAttribute(tag, 'href');
    if (!rel || !href || !rel.includes('icon') || rel.includes('mask-icon')) continue;

    const iconUrl = toHttpUrl(href, pageUrl);
    if (iconUrl) {
      candidates.push({
        url: iconUrl,
        rel,
        sizes: getHtmlAttribute(tag, 'sizes'),
        type: getHtmlAttribute(tag, 'type')
      });
    }
  }

  return candidates;
}

function extractManifestLinksFromHtml(html, pageUrl) {
  const manifestUrls = [];

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = getHtmlAttribute(tag, 'rel').toLowerCase();
    const href = getHtmlAttribute(tag, 'href');
    if (!rel || !href || !rel.split(/\s+/).includes('manifest')) continue;

    const manifestUrl = toHttpUrl(href, pageUrl);
    if (manifestUrl) manifestUrls.push(manifestUrl);
  }

  return manifestUrls;
}

function getManifestIconCandidates(manifest, manifestUrl) {
  if (!manifest || !Array.isArray(manifest.icons)) return [];

  return manifest.icons
    .map((icon) => {
      if (!icon || typeof icon.src !== 'string') return null;
      const iconUrl = toHttpUrl(icon.src, manifestUrl);
      if (!iconUrl) return null;

      return {
        url: iconUrl,
        rel: 'manifest-icon',
        sizes: typeof icon.sizes === 'string' ? icon.sizes : '',
        type: typeof icon.type === 'string' ? icon.type : '',
        purpose: typeof icon.purpose === 'string' ? icon.purpose : ''
      };
    })
    .filter(Boolean);
}

async function fetchManifestIconCandidates(config, manifestUrl) {
  const response = await safeFetch(manifestUrl, {
    headers: {
      Accept: 'application/manifest+json,application/json,*/*;q=0.8'
    },
    timeoutMs: config.iconFetchTimeoutMs,
    maxRedirects: config.iconMaxRedirects,
    allowPrivateNetwork: true
  });

  if (!response.ok) return [];

  const buffer = await readResponseBuffer(response, config.iconHtmlSampleSize, true);
  if (!buffer.length) return [];

  try {
    return getManifestIconCandidates(JSON.parse(buffer.toString('utf8')), manifestUrl);
  } catch {
    return [];
  }
}

function getLargestIconSizeFromText(value, options = {}) {
  if (!value || typeof value !== 'string') return 0;
  const normalized = value.toLowerCase();
  if (options.allowAny && /\bany\b/.test(normalized)) return 512;

  let largestSize = 0;
  for (const match of normalized.matchAll(/(\d{2,4})\s*x\s*(\d{2,4})/g)) {
    const width = Number.parseInt(match[1], 10);
    const height = Number.parseInt(match[2], 10);
    if (Number.isInteger(width) && Number.isInteger(height)) {
      largestSize = Math.max(largestSize, Math.min(width, height));
    }
  }

  return largestSize;
}

function getIconSizeFromUrl(candidateUrl) {
  try {
    const pathname = decodeURIComponent(new URL(candidateUrl).pathname);
    return getLargestIconSizeFromText(pathname);
  } catch {
    return 0;
  }
}

function getIconCandidateScore(candidate) {
  const candidateUrl = typeof candidate === 'string' ? candidate : candidate.url;
  const rel = (candidate.rel || '').toLowerCase();
  const type = (candidate.type || '').toLowerCase();
  const purpose = (candidate.purpose || '').toLowerCase();
  const sizes = Math.max(
    getLargestIconSizeFromText(candidate.sizes, { allowAny: true }),
    getIconSizeFromUrl(candidateUrl)
  );
  let pathname = '';

  try {
    pathname = decodeURIComponent(new URL(candidateUrl).pathname).toLowerCase();
  } catch {
    pathname = String(candidateUrl || '').toLowerCase();
  }

  let score = Math.min(sizes, 512) * 10;

  if (pathname.endsWith('.svg') || type.includes('svg')) score += 10000;
  if (rel.includes('apple-touch-icon') || pathname.includes('apple-touch-icon')) score += 1800;
  if (rel.includes('manifest')) score += 200;
  if (pathname.includes('/favicon')) score += 1000;
  if (sizes >= 96) score += 1000;
  if (sizes >= 144) score += 700;
  if (sizes > 0 && sizes < 32) score -= 1000;
  if (type.includes('png') || pathname.endsWith('.png')) score += 80;
  if (type.includes('webp') || pathname.endsWith('.webp')) score += 70;
  if (pathname.endsWith('.ico')) score += 30;
  if (purpose.includes('maskable')) score -= 3500;
  if (purpose.includes('monochrome')) score -= 8000;

  return score;
}

function getKnownHighResolutionIconCandidates(parsedUrl) {
  void parsedUrl;
  return [];
}

function getConventionalIconCandidates(parsedUrl) {
  const rootIconPaths = [
    '/android-chrome-192x192.png',
    '/apple-touch-icon.png',
    '/favicon.svg',
    '/favicon-192x192.png',
    '/favicon-32x32.png',
    '/favicon.png',
    '/favicon.ico'
  ];
  const nestedIconNames = ['favicon.svg', 'favicon.png', 'favicon.ico'];
  const pathSegments = parsedUrl.pathname.split('/').filter(Boolean).slice(0, 1);
  const pathPrefixes = [];
  let currentPrefix = '';

  for (const segment of pathSegments) {
    currentPrefix += `/${segment}`;
    pathPrefixes.unshift(currentPrefix);
  }

  const candidates = [];
  pathPrefixes.forEach((prefix) => {
    nestedIconNames.forEach((iconName) => candidates.push(`${parsedUrl.origin}${prefix}/${iconName}`));
  });
  rootIconPaths.forEach((iconPath) => candidates.push(`${parsedUrl.origin}${iconPath}`));

  return candidates;
}

function uniqueIconCandidates(candidates, maxCandidates = 40) {
  const candidatesByUrl = new Map();

  candidates.forEach((candidate, index) => {
    const candidateUrl = typeof candidate === 'string' ? candidate : candidate.url;
    const httpUrl = toHttpUrl(candidateUrl);
    if (!httpUrl) return;
    const normalizedCandidate = {
      ...(typeof candidate === 'string' ? {} : candidate),
      url: httpUrl,
      sourceOrder: index
    };
    const scoredCandidate = {
      ...normalizedCandidate,
      score: getIconCandidateScore(normalizedCandidate)
    };
    const existingCandidate = candidatesByUrl.get(httpUrl);
    if (!existingCandidate || scoredCandidate.score > existingCandidate.score) {
      candidatesByUrl.set(httpUrl, scoredCandidate);
    }
  });

  return Array.from(candidatesByUrl.values())
    .sort((left, right) => (right.score - left.score) || (left.sourceOrder - right.sourceOrder))
    .slice(0, maxCandidates)
    .map((candidate) => candidate.url);
}

async function discoverIconCandidates(config, parsedUrl) {
  const candidates = getKnownHighResolutionIconCandidates(parsedUrl);
  const manifestUrls = [];

  try {
    const response = await safeFetch(parsedUrl.href, {
      headers: {
        Accept: 'text/html,application/xhtml+xml'
      },
      timeoutMs: config.iconFetchTimeoutMs,
      maxRedirects: config.iconMaxRedirects,
      allowPrivateNetwork: true
    });

    const contentType = normalizeContentType(response.headers.get('content-type') || '');
    if (response.ok && (!contentType || contentType.includes('text/html') || contentType.includes('application/xhtml+xml'))) {
      const html = (await readResponseBuffer(response, config.iconHtmlSampleSize, true)).toString('utf8');
      candidates.push(...extractIconLinksFromHtml(html, parsedUrl.href));
      manifestUrls.push(...extractManifestLinksFromHtml(html, parsedUrl.href));
    }
  } catch {
    // Conventional favicon paths below still cover most services.
  }

  manifestUrls.push(...getConventionalManifestCandidates(parsedUrl));

  for (const manifestUrl of [...new Set(manifestUrls)].slice(0, 3)) {
    try {
      const manifestIconCandidates = await fetchManifestIconCandidates(config, manifestUrl);
      candidates.push(...manifestIconCandidates);
    } catch {
      // Manifest icons are optional; conventional paths below are still valid.
    }
  }

  candidates.push(...getConventionalIconCandidates(parsedUrl).map((url) => ({ url })));
  return uniqueIconCandidates(candidates, config.iconMaxCandidates);
}

function createIconService(config) {
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

    if (!metadata || Number(metadata.version) !== version) {
      return { ...baseStatus, status: iconMode === 'none' ? 'none' : 'empty' };
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

  async function fetchIconCandidate(candidateUrl) {
    const response = await safeFetch(candidateUrl, {
      headers: {
        Accept: 'image/avif,image/webp,image/svg+xml,image/png,image/*,*/*;q=0.8'
      },
      timeoutMs: config.iconFetchTimeoutMs,
      maxRedirects: config.iconMaxRedirects,
      allowPrivateNetwork: true
    });

    if (!response.ok) return null;

    const buffer = await readResponseBuffer(response, config.maxIconSize);
    if (!buffer.length) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!isSupportedIconBuffer(contentType, candidateUrl, buffer)) return null;

    const extension = getIconExtension(contentType, candidateUrl, buffer);
    return {
      buffer,
      extension,
      contentType: getIconContentType(extension)
    };
  }

  function validateUploadedIcon(targetUrl, sourceUrl, file) {
    if (!file?.buffer?.length) return { error: '请选择图标文件' };
    const candidateUrl = toHttpUrl(sourceUrl || file.originalname || '', targetUrl) || targetUrl;
    if (!isSupportedIconBuffer(file.mimetype, candidateUrl, file.buffer)) {
      return { error: '图标文件格式不支持' };
    }

    const extension = getIconExtension(file.mimetype, candidateUrl, file.buffer);
    return {
      value: {
        buffer: file.buffer,
        extension,
        contentType: getIconContentType(extension)
      }
    };
  }

  async function resolveIconForUrl(targetUrl) {
    const normalizedTargetUrl = normalizeIconTargetUrl(targetUrl);
    if (!normalizedTargetUrl) return null;

    const parsedUrl = new URL(normalizedTargetUrl);
    const candidates = await discoverIconCandidates(config, parsedUrl);

    for (const candidateUrl of candidates) {
      try {
        const icon = await fetchIconCandidate(candidateUrl);
        if (!icon) continue;

        return { icon, sourceUrl: candidateUrl, targetUrl: normalizedTargetUrl };
      } catch {
        // Try the next candidate.
      }
    }

    return { icon: null, sourceUrl: '', targetUrl: normalizedTargetUrl };
  }

  async function resolveLinkIcon(link) {
    if (!link) return { notFound: true };
    if (link.iconMode === 'none') return getEntityIconStatus('links', link, { iconMode: 'none' });
    if (link.iconMode === 'upload') return getEntityIconStatus('links', link, { iconMode: 'upload' });
    if (link.iconMode === 'local') return getEntityIconStatus('links', link, { iconMode: 'local' });

    const resolved = await resolveIconForUrl(link.url);
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
      targetUrl: resolved?.targetUrl || normalizeIconTargetUrl(link.url) || ''
    });
    return getEntityIconStatus('links', link);
  }

  function getSearchEngineTargetUrl(engine) {
    if (!engine?.urlTemplate) return null;
    const sampleUrl = engine.urlTemplate.replaceAll('{query}', 'test');
    return normalizeIconTargetUrl(sampleUrl);
  }

  async function resolveSearchEngineIcon(engine) {
    if (!engine) return { notFound: true };
    const targetUrl = getSearchEngineTargetUrl(engine);
    const resolved = await resolveIconForUrl(targetUrl);
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

  async function writeUploadedLinkIcon(link, file, options = {}) {
    const targetUrl = normalizeIconTargetUrl(link?.url);
    if (!link || !targetUrl) return { error: '图标目标地址无效' };

    const result = validateUploadedIcon(targetUrl, options.sourceUrl, file);
    if (result.error) return result;

    await writeEntityIcon('links', link.id, link.iconVersion, result.value, {
      source: options.source === 'local' ? 'local' : 'upload',
      sourceUrl: options.sourceUrl || file?.originalname || '',
      targetUrl
    });

    return { value: await getEntityIconStatus('links', link, { iconMode: link.iconMode }) };
  }

  return {
    clearIconCache,
    deleteEntityIcon,
    discoverIconCandidates: (parsedUrl) => discoverIconCandidates(config, parsedUrl),
    fetchIconCandidate,
    findCachedEntityIcon,
    getEntityFileUrl,
    getEntityIconStatus,
    getSearchEngineTargetUrl,
    normalizeIconTargetUrl,
    resolveLinkIcon,
    resolveSearchEngineIcon,
    toHttpUrl,
    validateUploadedIcon,
    writeUploadedLinkIcon
  };
}

module.exports = {
  createIconService,
  discoverIconCandidates,
  extractIconLinksFromHtml,
  extractManifestLinksFromHtml,
  getConventionalIconCandidates,
  getIconCandidateScore,
  getLargestIconSizeFromText,
  normalizeIconTargetUrl,
  readResponseBuffer,
  toHttpUrl,
  uniqueIconCandidates
};

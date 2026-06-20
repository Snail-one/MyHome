const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { safeFetch, assertPublicHttpUrl } = require('./httpSafety');
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
    parsedUrl.username = '';
    parsedUrl.password = '';
    return parsedUrl.href;
  } catch {
    return null;
  }
}

function toHttpUrl(value, baseUrl) {
  try {
    const parsedUrl = new URL(value, baseUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
    parsedUrl.username = '';
    parsedUrl.password = '';
    return parsedUrl.href;
  } catch {
    return null;
  }
}

function getIconCacheKey(targetUrl) {
  return crypto.createHash('sha256').update(targetUrl).digest('hex').slice(0, 48);
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
    maxRedirects: config.iconMaxRedirects
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
  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname === 'google.com' || hostname.endsWith('.google.com')) {
    return [
      {
        url: 'https://www.gstatic.com/images/branding/product/2x/googleg_48dp.png',
        rel: 'known-icon',
        sizes: '96x96',
        type: 'image/png'
      },
      {
        url: 'https://www.gstatic.com/images/branding/product/1x/googleg_48dp.png',
        rel: 'known-icon',
        sizes: '48x48',
        type: 'image/png'
      }
    ];
  }

  if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be') {
    return [
      {
        url: 'https://www.gstatic.com/youtube/img/branding/favicon/favicon_192x192_v2.png',
        rel: 'known-icon',
        sizes: '192x192',
        type: 'image/png'
      },
      {
        url: 'https://www.gstatic.com/youtube/img/branding/favicon/favicon_144x144_v2.png',
        rel: 'known-icon',
        sizes: '144x144',
        type: 'image/png'
      }
    ];
  }

  return [];
}

function getConventionalIconCandidates(parsedUrl) {
  const rootIconPaths = [
    '/android-chrome-512x512.png',
    '/android-chrome-384x384.png',
    '/android-chrome-256x256.png',
    '/android-chrome-192x192.png',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
    '/apple-touch-icon-180x180.png',
    '/apple-touch-icon-167x167.png',
    '/apple-touch-icon-152x152.png',
    '/apple-touch-icon-144x144.png',
    '/apple-touch-icon-120x120.png',
    '/mstile-310x310.png',
    '/mstile-150x150.png',
    '/favicon.svg',
    '/favicon-512x512.png',
    '/favicon-384x384.png',
    '/favicon-256x256.png',
    '/favicon-196x196.png',
    '/favicon-192x192.png',
    '/favicon-128x128.png',
    '/favicon-96x96.png',
    '/favicon-64x64.png',
    '/favicon-48x48.png',
    '/favicon-32x32.png',
    '/favicon.png',
    '/favicon.ico',
    '/favicon-16x16.png',
    '/images/favicon.ico',
    '/images/favicon.png',
    '/static/favicon.ico',
    '/assets/favicon.ico',
    '/front-static/favicon.ico'
  ];
  const nestedIconNames = ['favicon.ico', 'favicon.png', 'favicon.svg', 'apple-touch-icon.png'];
  const pathSegments = parsedUrl.pathname.split('/').filter(Boolean).slice(0, 3);
  const pathPrefixes = [];
  let currentPrefix = '';

  for (const segment of pathSegments) {
    currentPrefix += `/${segment}`;
    pathPrefixes.unshift(currentPrefix);
  }

  const candidates = [];
  rootIconPaths.forEach((iconPath) => candidates.push(`${parsedUrl.origin}${iconPath}`));
  pathPrefixes.forEach((prefix) => {
    nestedIconNames.forEach((iconName) => candidates.push(`${parsedUrl.origin}${prefix}/${iconName}`));
  });

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
  await assertPublicHttpUrl(parsedUrl.href);
  const candidates = getKnownHighResolutionIconCandidates(parsedUrl);
  const manifestUrls = [];

  try {
    const response = await safeFetch(parsedUrl.href, {
      headers: {
        Accept: 'text/html,application/xhtml+xml'
      },
      timeoutMs: config.iconFetchTimeoutMs,
      maxRedirects: config.iconMaxRedirects
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

  for (const manifestUrl of [...new Set(manifestUrls)].slice(0, 8)) {
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
  async function fetchIconCandidate(candidateUrl) {
    await assertPublicHttpUrl(candidateUrl);
    const response = await safeFetch(candidateUrl, {
      headers: {
        Accept: 'image/avif,image/webp,image/svg+xml,image/png,image/*,*/*;q=0.8'
      },
      timeoutMs: config.iconFetchTimeoutMs,
      maxRedirects: config.iconMaxRedirects
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

  async function findCachedIcon(cacheKey) {
    const entries = await fs.promises.readdir(config.iconCacheDir, { withFileTypes: true }).catch(() => []);
    const cachedEntries = entries.filter((entry) => (
      entry.isFile() &&
      entry.name.startsWith(`${cacheKey}.`) &&
      iconContentTypeByExtension.has(path.extname(entry.name).toLowerCase())
    ));

    if (!cachedEntries.length) {
      const missFilePath = path.join(config.iconCacheDir, `${cacheKey}.miss`);
      try {
        const missContent = await fs.promises.readFile(missFilePath, 'utf8');
        const miss = JSON.parse(missContent);
        return miss?.version === config.iconDiscoveryVersion ? { miss: true } : null;
      } catch {
        return null;
      }
    }

    const cachedFiles = await Promise.all(cachedEntries.map(async (entry) => {
      const filePath = path.join(config.iconCacheDir, entry.name);
      const stats = await fs.promises.stat(filePath).catch(() => null);
      return {
        name: entry.name,
        filePath,
        mtimeMs: stats?.mtimeMs || 0
      };
    }));
    const cachedFile = cachedFiles.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
    const extension = path.extname(cachedFile.name).toLowerCase();
    return {
      filePath: cachedFile.filePath,
      contentType: getIconContentType(extension)
    };
  }

  async function markIconCacheMiss(cacheKey) {
    await fs.promises.writeFile(path.join(config.iconCacheDir, `${cacheKey}.miss`), JSON.stringify({
      version: config.iconDiscoveryVersion,
      savedAt: new Date().toISOString()
    }));
  }

  async function removeIconCacheMiss(cacheKey) {
    await fs.promises.unlink(path.join(config.iconCacheDir, `${cacheKey}.miss`)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async function clearIconCacheMisses() {
    const entries = await fs.promises.readdir(config.iconCacheDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.miss'))
      .map((entry) => fs.promises.unlink(path.join(config.iconCacheDir, entry.name)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      })));
  }

  async function deleteCachedIconFiles(cacheKey, keepFileName) {
    const entries = await fs.promises.readdir(config.iconCacheDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter((entry) => (
        entry.isFile() &&
        entry.name !== keepFileName &&
        entry.name.startsWith(`${cacheKey}.`) &&
        iconContentTypeByExtension.has(path.extname(entry.name).toLowerCase())
      ))
      .map((entry) => fs.promises.unlink(path.join(config.iconCacheDir, entry.name)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      })));
  }

  async function writeCachedIcon(cacheKey, icon) {
    await fs.promises.mkdir(config.iconCacheDir, { recursive: true });
    const finalFileName = `${cacheKey}${icon.extension}`;
    const finalPath = path.join(config.iconCacheDir, finalFileName);
    const tempPath = path.join(config.iconCacheDir, `${cacheKey}.${crypto.randomBytes(8).toString('hex')}.tmp`);

    await fs.promises.writeFile(tempPath, icon.buffer);
    await fs.promises.rename(tempPath, finalPath);
    await removeIconCacheMiss(cacheKey);
    await deleteCachedIconFiles(cacheKey, finalFileName);

    return {
      filePath: finalPath,
      contentType: icon.contentType
    };
  }

  async function cacheIconForUrl(targetUrl, cacheKey, options = {}) {
    const { markMiss = true } = options;
    const parsedUrl = new URL(targetUrl);
    const candidates = await discoverIconCandidates(config, parsedUrl);

    for (const candidateUrl of candidates) {
      try {
        const icon = await fetchIconCandidate(candidateUrl);
        if (!icon) continue;

        return await writeCachedIcon(cacheKey, icon);
      } catch {
        // Try the next candidate.
      }
    }

    if (markMiss) await markIconCacheMiss(cacheKey);
    return null;
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

  return {
    cacheIconForUrl,
    clearIconCacheMisses,
    discoverIconCandidates: (parsedUrl) => discoverIconCandidates(config, parsedUrl),
    fetchIconCandidate,
    findCachedIcon,
    getIconCacheKey,
    normalizeIconTargetUrl,
    toHttpUrl,
    validateUploadedIcon,
    writeCachedIcon
  };
}

module.exports = {
  createIconService,
  discoverIconCandidates,
  extractIconLinksFromHtml,
  extractManifestLinksFromHtml,
  getIconCacheKey,
  getIconCandidateScore,
  getLargestIconSizeFromText,
  normalizeIconTargetUrl,
  readResponseBuffer,
  toHttpUrl,
  uniqueIconCandidates
};

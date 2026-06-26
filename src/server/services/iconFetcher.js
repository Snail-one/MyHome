const { safeFetch } = require('./httpSafety');
const {
  getIconContentType,
  getIconExtension,
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

function hasIconFetchProxy(config) {
  return Boolean(config?.iconFetchProxy?.httpProxy || config?.iconFetchProxy?.httpsProxy);
}

function getIconFetchOptions(config, requestOptions = {}, useProxy = false) {
  const { proxy, ...fetchOptions } = requestOptions;
  return {
    ...fetchOptions,
    timeoutMs: config.iconFetchTimeoutMs,
    maxRedirects: config.iconMaxRedirects,
    allowPrivateNetwork: true,
    ...(useProxy && hasIconFetchProxy(config) ? { proxy: config.iconFetchProxy } : {})
  };
}

async function safeFetchIconResource(config, resourceUrl, requestOptions, useProxy = false, deps = {}) {
  const fetchImpl = deps.safeFetch || safeFetch;
  return fetchImpl(resourceUrl, getIconFetchOptions(config, requestOptions, useProxy));
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

async function readManifestIconCandidates(config, manifestUrl, useProxy = false, deps = {}) {
  const response = await safeFetchIconResource(config, manifestUrl, {
    headers: {
      Accept: 'application/manifest+json,application/json,*/*;q=0.8'
    }
  }, useProxy, deps);

  if (!response.ok) return null;

  const buffer = await readResponseBuffer(response, config.iconHtmlSampleSize, true);
  if (!buffer.length) return null;

  try {
    return getManifestIconCandidates(JSON.parse(buffer.toString('utf8')), manifestUrl);
  } catch {
    return null;
  }
}

async function fetchManifestIconCandidates(config, manifestUrl, deps = {}) {
  let directCandidates = null;

  try {
    directCandidates = await readManifestIconCandidates(config, manifestUrl, false, deps);
    if (directCandidates?.length) return directCandidates;
  } catch {
    directCandidates = null;
  }

  if (hasIconFetchProxy(config)) {
    try {
      const proxyCandidates = await readManifestIconCandidates(config, manifestUrl, true, deps);
      if (proxyCandidates?.length) return proxyCandidates;
    } catch {
      // Ignore proxy manifest failures and fall back to direct/conventional candidates.
    }
  }

  if (directCandidates) return directCandidates;
  return [];
}

async function fetchDocumentIconHints(config, parsedUrl, useProxy = false, deps = {}) {
  const response = await safeFetchIconResource(config, parsedUrl.href, {
    headers: {
      Accept: 'text/html,application/xhtml+xml'
    }
  }, useProxy, deps);

  const contentType = normalizeContentType(response.headers.get('content-type') || '');
  if (!response.ok || (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml'))) {
    return null;
  }

  const html = (await readResponseBuffer(response, config.iconHtmlSampleSize, true)).toString('utf8');
  return {
    iconCandidates: extractIconLinksFromHtml(html, parsedUrl.href),
    manifestUrls: extractManifestLinksFromHtml(html, parsedUrl.href)
  };
}

async function discoverDocumentIconHints(config, parsedUrl, deps = {}) {
  let directHints = null;

  try {
    directHints = await fetchDocumentIconHints(config, parsedUrl, false, deps);
    if (directHints?.iconCandidates?.length || directHints?.manifestUrls?.length) return directHints;
  } catch {
    directHints = null;
  }

  if (hasIconFetchProxy(config)) {
    try {
      const proxyHints = await fetchDocumentIconHints(config, parsedUrl, true, deps);
      if (proxyHints?.iconCandidates?.length || proxyHints?.manifestUrls?.length) return proxyHints;
    } catch {
      // Conventional favicon paths below still cover most services.
    }
  }

  return directHints;
}

async function readIconCandidate(config, candidateUrl, useProxy = false, deps = {}) {
  const response = await safeFetchIconResource(config, candidateUrl, {
    headers: {
      Accept: 'image/avif,image/webp,image/svg+xml,image/png,image/*,*/*;q=0.8'
    }
  }, useProxy, deps);

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

async function fetchIconCandidate(config, candidateUrl, deps = {}) {
  let directError = null;

  try {
    const directIcon = await readIconCandidate(config, candidateUrl, false, deps);
    if (directIcon) return directIcon;
  } catch (error) {
    directError = error;
  }

  if (hasIconFetchProxy(config)) {
    try {
      return await readIconCandidate(config, candidateUrl, true, deps);
    } catch (error) {
      throw error;
    }
  }

  if (directError) throw directError;
  return null;
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
  if (rel.includes('known-icon')) score += 20000;
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
        url: 'https://www.gstatic.com/images/branding/product/1x/googleg_32dp.png',
        rel: 'known-icon',
        sizes: '512x512',
        type: 'image/png'
      }
    ];
  }

  if (hostname === 'x.com' || hostname.endsWith('.x.com') || hostname === 'twitter.com' || hostname.endsWith('.twitter.com')) {
    return [
      {
        url: 'https://abs.twimg.com/favicons/twitter.3.ico',
        rel: 'known-icon',
        sizes: '128x128',
        type: 'image/x-icon'
      },
      {
        url: 'https://abs.twimg.com/responsive-web/client-web/icon-ios.b1fc727a.png',
        rel: 'known-icon',
        sizes: '192x192',
        type: 'image/png'
      }
    ];
  }

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

async function discoverIconCandidates(config, parsedUrl, deps = {}) {
  const candidates = getKnownHighResolutionIconCandidates(parsedUrl);
  if (candidates.length) {
    candidates.push(...getConventionalIconCandidates(parsedUrl).map((url) => ({ url })));
    return uniqueIconCandidates(candidates, config.iconMaxCandidates);
  }

  const manifestUrls = [];
  const documentHints = await discoverDocumentIconHints(config, parsedUrl, deps);
  if (documentHints) {
    candidates.push(...documentHints.iconCandidates);
    manifestUrls.push(...documentHints.manifestUrls);
  }

  manifestUrls.push(...getConventionalManifestCandidates(parsedUrl));

  for (const manifestUrl of [...new Set(manifestUrls)].slice(0, 3)) {
    try {
      const manifestIconCandidates = await fetchManifestIconCandidates(config, manifestUrl, deps);
      candidates.push(...manifestIconCandidates);
    } catch {
      // Manifest icons are optional; conventional paths below are still valid.
    }
  }

  candidates.push(...getConventionalIconCandidates(parsedUrl).map((url) => ({ url })));
  return uniqueIconCandidates(candidates, config.iconMaxCandidates);
}

async function resolveIconForUrl(config, targetUrl, deps = {}) {
  const normalizedTargetUrl = normalizeIconTargetUrl(targetUrl);
  if (!normalizedTargetUrl) return null;

  const parsedUrl = new URL(normalizedTargetUrl);
  const candidates = await discoverIconCandidates(config, parsedUrl, deps);

  for (const candidateUrl of candidates) {
    try {
      const icon = await fetchIconCandidate(config, candidateUrl, deps);
      if (!icon) continue;

      return { icon, sourceUrl: candidateUrl, targetUrl: normalizedTargetUrl };
    } catch {
      // Try the next candidate.
    }
  }

  return { icon: null, sourceUrl: '', targetUrl: normalizedTargetUrl };
}

function createIconFetcher(config, deps = {}) {
  return {
    discoverIconCandidates: (parsedUrl) => discoverIconCandidates(config, parsedUrl, deps),
    fetchIconCandidate: (candidateUrl) => fetchIconCandidate(config, candidateUrl, deps),
    normalizeIconTargetUrl,
    resolveIconForUrl: (targetUrl) => resolveIconForUrl(config, targetUrl, deps),
    toHttpUrl
  };
}

module.exports = {
  createIconFetcher,
  discoverIconCandidates,
  extractIconLinksFromHtml,
  extractManifestLinksFromHtml,
  fetchIconCandidate,
  getConventionalIconCandidates,
  getIconCandidateScore,
  getKnownHighResolutionIconCandidates,
  getLargestIconSizeFromText,
  getManifestIconCandidates,
  normalizeIconTargetUrl,
  readResponseBuffer,
  resolveIconForUrl,
  toHttpUrl,
  uniqueIconCandidates
};

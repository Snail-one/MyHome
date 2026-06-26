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

function getIconFetchMode(useProxy) {
  return useProxy ? 'proxy' : 'direct';
}

const LOG_FIELD_ORDER = [
  'target',
  'host',
  'phase',
  'mode',
  'status',
  'ok',
  'icons',
  'count',
  'candidates',
  'contentType',
  'extension',
  'bytes',
  'source',
  'url',
  'error'
];

function formatLogValue(value) {
  const normalized = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 500);

  return /[\s=|"]/.test(normalized) ? JSON.stringify(normalized) : normalized;
}

function getOrderedLogEntries(details) {
  const seenFields = new Set();
  const orderedEntries = [];

  for (const key of LOG_FIELD_ORDER) {
    if (Object.prototype.hasOwnProperty.call(details, key)) {
      orderedEntries.push([key, details[key]]);
      seenFields.add(key);
    }
  }

  for (const entry of Object.entries(details)) {
    if (!seenFields.has(entry[0])) orderedEntries.push(entry);
  }

  return orderedEntries;
}

function logIconFetch(config, event, details = {}, deps = {}) {
  if (!config?.iconFetchLogEnabled) return;

  const logger = deps.logger || console;
  const fields = getOrderedLogEntries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(' ');
  const line = `[icon-fetch] ${event}${fields ? ` | ${fields}` : ''}`;

  if (typeof logger.log === 'function') {
    logger.log(line);
  }
}

function getIconFetchOptions(config, requestOptions = {}, useProxy = false) {
  const { proxy, phase, ...fetchOptions } = requestOptions;
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
  const mode = getIconFetchMode(useProxy);
  const phase = requestOptions.phase || 'request';
  const fetchOptions = getIconFetchOptions(config, requestOptions, useProxy);

  logIconFetch(config, 'request:start', { phase, mode, url: resourceUrl }, deps);

  try {
    const response = await fetchImpl(resourceUrl, fetchOptions);
    logIconFetch(config, 'request:response', {
      phase,
      mode,
      status: response.status,
      ok: response.ok,
      url: resourceUrl
    }, deps);
    return response;
  } catch (error) {
    logIconFetch(config, 'request:error', {
      phase,
      mode,
      url: resourceUrl,
      error: error.message
    }, deps);
    throw error;
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

async function fetchDocumentIconHints(config, parsedUrl, useProxy = false, deps = {}) {
  const mode = getIconFetchMode(useProxy);
  const response = await safeFetchIconResource(config, parsedUrl.href, {
    phase: 'html',
    headers: {
      Accept: 'text/html,application/xhtml+xml'
    }
  }, useProxy, deps);

  const contentType = normalizeContentType(response.headers.get('content-type') || '');
  if (!response.ok || (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml'))) {
    logIconFetch(config, 'html:skip', {
      mode,
      status: response.status,
      contentType,
      url: parsedUrl.href
    }, deps);
    return null;
  }

  const html = (await readResponseBuffer(response, config.iconHtmlSampleSize, true)).toString('utf8');
  const iconCandidates = extractIconLinksFromHtml(html, parsedUrl.href);
  logIconFetch(config, 'html:candidates', {
    mode,
    icons: iconCandidates.length,
    url: parsedUrl.href
  }, deps);
  return {
    iconCandidates
  };
}

async function discoverDocumentIconHints(config, parsedUrl, deps = {}) {
  let directHints = null;

  try {
    directHints = await fetchDocumentIconHints(config, parsedUrl, false, deps);
    if (directHints?.iconCandidates?.length) return directHints;
  } catch {
    directHints = null;
  }

  if (hasIconFetchProxy(config)) {
    logIconFetch(config, 'html:proxy-fallback', { url: parsedUrl.href }, deps);
    try {
      const proxyHints = await fetchDocumentIconHints(config, parsedUrl, true, deps);
      if (proxyHints?.iconCandidates?.length) return proxyHints;
    } catch {
      // HTML icon hints are optional; callers can handle an empty candidate list.
    }
  }

  return directHints;
}

async function readIconCandidate(config, candidateUrl, useProxy = false, deps = {}) {
  const mode = getIconFetchMode(useProxy);
  const response = await safeFetchIconResource(config, candidateUrl, {
    phase: 'icon',
    headers: {
      Accept: 'image/avif,image/webp,image/svg+xml,image/png,image/*,*/*;q=0.8'
    }
  }, useProxy, deps);

  if (!response.ok) {
    logIconFetch(config, 'icon:skip', { mode, status: response.status, url: candidateUrl }, deps);
    return null;
  }

  const buffer = await readResponseBuffer(response, config.maxIconSize);
  if (!buffer.length) {
    logIconFetch(config, 'icon:empty', { mode, url: candidateUrl }, deps);
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  if (!isSupportedIconBuffer(contentType, candidateUrl, buffer)) {
    logIconFetch(config, 'icon:unsupported', {
      mode,
      contentType,
      bytes: buffer.length,
      url: candidateUrl
    }, deps);
    return null;
  }

  const extension = getIconExtension(contentType, candidateUrl, buffer);
  logIconFetch(config, 'icon:accepted', {
    mode,
    contentType: getIconContentType(extension),
    extension,
    bytes: buffer.length,
    url: candidateUrl
  }, deps);
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
    logIconFetch(config, 'icon:proxy-fallback', { url: candidateUrl }, deps);
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
  if (pathname.includes('/favicon')) score += 1000;
  if (sizes >= 96) score += 1000;
  if (sizes >= 144) score += 700;
  if (sizes > 0 && sizes < 32) score -= 1000;
  if (type.includes('png') || pathname.endsWith('.png')) score += 80;
  if (type.includes('webp') || pathname.endsWith('.webp')) score += 70;
  if (pathname.endsWith('.ico')) score += 30;

  return score;
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
  const documentHints = await discoverDocumentIconHints(config, parsedUrl, deps);
  const candidateUrls = uniqueIconCandidates(documentHints?.iconCandidates || [], config.iconMaxCandidates);
  logIconFetch(config, 'candidates:ready', {
    host: parsedUrl.hostname,
    count: candidateUrls.length,
    url: parsedUrl.href
  }, deps);
  return candidateUrls;
}

async function resolveIconForUrl(config, targetUrl, deps = {}) {
  const normalizedTargetUrl = normalizeIconTargetUrl(targetUrl);
  if (!normalizedTargetUrl) {
    logIconFetch(config, 'resolve:invalid-url', { url: targetUrl }, deps);
    return null;
  }

  const parsedUrl = new URL(normalizedTargetUrl);
  logIconFetch(config, 'resolve:start', { url: normalizedTargetUrl }, deps);
  const candidates = await discoverIconCandidates(config, parsedUrl, deps);

  for (const candidateUrl of candidates) {
    try {
      const icon = await fetchIconCandidate(config, candidateUrl, deps);
      if (!icon) continue;

      logIconFetch(config, 'resolve:hit', {
        target: normalizedTargetUrl,
        source: candidateUrl,
        contentType: icon.contentType
      }, deps);
      return { icon, sourceUrl: candidateUrl, targetUrl: normalizedTargetUrl };
    } catch (error) {
      logIconFetch(config, 'resolve:candidate-error', {
        target: normalizedTargetUrl,
        source: candidateUrl,
        error: error.message
      }, deps);
      // Try the next candidate.
    }
  }

  logIconFetch(config, 'resolve:miss', {
    target: normalizedTargetUrl,
    candidates: candidates.length
  }, deps);
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
  fetchIconCandidate,
  getIconCandidateScore,
  getLargestIconSizeFromText,
  normalizeIconTargetUrl,
  readResponseBuffer,
  resolveIconForUrl,
  toHttpUrl,
  uniqueIconCandidates
};

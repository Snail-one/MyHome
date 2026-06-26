const { safeFetch } = require('./httpSafety');
const {
  getIconContentType,
  getIconExtension,
  isSupportedIconBuffer,
  normalizeContentType
} = require('./imageTypes');
const { normalizeUrl } = require('./validation');

async function consumeResponseBody(response) {
  try {
    if (response.body?.cancel) {
      await response.body.cancel();
    } else if (response.body?.getReader) {
      const reader = response.body.getReader();
      await reader.cancel().catch(() => {});
    } else if (typeof response.arrayBuffer === 'function') {
      await response.arrayBuffer().catch(() => {});
    }
  } catch (_) { /* ignore cleanup errors */ }
}

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

function getIconFetchProxyUrl(config, resourceUrl, useProxy = false) {
  if (!useProxy || !hasIconFetchProxy(config)) return '';

  try {
    const parsedUrl = new URL(resourceUrl);
    return parsedUrl.protocol === 'https:'
      ? (config.iconFetchProxy.httpsProxy || config.iconFetchProxy.httpProxy || '')
      : (config.iconFetchProxy.httpProxy || '');
  } catch {
    return config.iconFetchProxy.httpsProxy || config.iconFetchProxy.httpProxy || '';
  }
}

function getIconFetchTimeoutMs(config, useProxy = false) {
  const timeoutMs = Number.parseInt(config?.iconFetchTimeoutMs, 10) || 0;
  return useProxy ? Math.max(timeoutMs, 10000) : timeoutMs;
}

function formatProxyLogValue(proxyUrl) {
  if (!proxyUrl) return '';

  try {
    const parsedUrl = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`);
    if (parsedUrl.username || parsedUrl.password) {
      parsedUrl.username = parsedUrl.username ? '***' : '';
      parsedUrl.password = parsedUrl.password ? '***' : '';
    }
    return parsedUrl.href;
  } catch {
    return proxyUrl;
  }
}

const LOG_FIELD_ORDER = [
  'host',
  'phase',
  'proxy',
  'status',
  'ok',
  'reason',
  'durationMs',
  'timeoutMs',
  'icons',
  'count',
  'candidates',
  'contentType',
  'extension',
  'bytes',
  'source',
  'errorCode',
  'errorCause',
  'error'
];

const LOG_COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
};

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

function getLogSubject(details) {
  return details.target || details.url || details.source || '';
}

function shouldColorIconFetchLog(logger, deps = {}) {
  if (typeof deps.colorLogs === 'boolean') return deps.colorLogs;
  return logger === console && Boolean(process.stdout?.isTTY) && !process.env.NO_COLOR;
}

function colorLogValue(value, color, enabled) {
  if (!enabled || !color) return value;
  return `${color}${value}${LOG_COLORS.reset}`;
}

function getErrorLogDetails(error) {
  const cause = error?.cause;
  return {
    errorCode: error?.code || cause?.code || cause?.name || '',
    errorCause: cause?.message || '',
    timeoutMs: error?.timeoutMs || '',
    error: error?.message || String(error || '')
  };
}

function getRequestFailureReason(error) {
  return error?.code === 'FETCH_TIMEOUT' ? 'timeout' : 'connection-failed';
}

function getRequestFailureEvent(error) {
  return error?.code === 'FETCH_TIMEOUT' ? 'request:timeout' : 'request:connect:fail';
}

function getLogEventColor(event) {
  if (event.includes('error') || event.includes('invalid') || event.includes('fail') || event.includes('timeout')) return LOG_COLORS.red;
  if (event.includes('hit') || event.includes('accepted') || event.includes('success')) return LOG_COLORS.green;
  if (event.includes('miss') || event.includes('skip') || event.includes('empty') || event.includes('unsupported') || event.includes('fallback')) {
    return LOG_COLORS.yellow;
  }
  if (event.startsWith('request:')) return LOG_COLORS.blue;
  return LOG_COLORS.gray;
}

function logIconFetch(config, event, details = {}, deps = {}) {
  if (!config?.iconFetchLogEnabled) return;

  const logger = deps.logger || console;
  const subject = getLogSubject(details);
  const mode = details.mode || '-';
  const colorEnabled = shouldColorIconFetchLog(logger, deps);
  const fields = getOrderedLogEntries(details)
    .filter(([key, value]) => (
      key !== 'target' &&
      key !== 'url' &&
      key !== 'mode' &&
      value !== undefined &&
      value !== null &&
      value !== ''
    ))
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(' ');
  const label = colorLogValue('[icon-fetch]', LOG_COLORS.gray, colorEnabled);
  const subjectPrefix = subject ? `${colorLogValue(formatLogValue(subject), LOG_COLORS.cyan, colorEnabled)} | ` : '';
  const modePart = colorLogValue(formatLogValue(mode), mode === 'proxy' ? LOG_COLORS.yellow : LOG_COLORS.blue, colorEnabled);
  const eventName = colorLogValue(event, getLogEventColor(event), colorEnabled);
  const line = `${label} ${subjectPrefix}${modePart} | ${eventName}${fields ? ` ${fields}` : ''}`;

  if (typeof logger.log === 'function') {
    logger.log(line);
  }
}

function getIconFetchOptions(config, requestOptions = {}, useProxy = false) {
  const { proxy, phase, ...fetchOptions } = requestOptions;
  return {
    ...fetchOptions,
    timeoutMs: getIconFetchTimeoutMs(config, useProxy),
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
  const proxy = formatProxyLogValue(getIconFetchProxyUrl(config, resourceUrl, useProxy));
  const startedAt = Date.now();

  logIconFetch(config, 'request:start', {
    phase,
    mode,
    proxy,
    timeoutMs: fetchOptions.timeoutMs,
    url: resourceUrl
  }, deps);

  try {
    const response = await fetchImpl(resourceUrl, fetchOptions);
    logIconFetch(config, response.ok ? 'request:response' : 'request:access:fail', {
      phase,
      mode,
      proxy,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
      ...(response.ok ? {} : { reason: 'access-failed' }),
      url: resourceUrl
    }, deps);
    return response;
  } catch (error) {
    logIconFetch(config, getRequestFailureEvent(error), {
      phase,
      mode,
      proxy,
      reason: getRequestFailureReason(error),
      durationMs: Date.now() - startedAt,
      url: resourceUrl,
      ...getErrorLogDetails(error)
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
      await reader.cancel().catch(() => {});
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

function getDefaultFaviconCandidate(parsedUrl, fetchMode) {
  return {
    url: `${parsedUrl.origin}/favicon.ico`,
    rel: 'default icon',
    sizes: '',
    type: 'image/x-icon',
    fetchMode
  };
}

async function fetchDocumentIconHints(config, parsedUrl, useProxy = false, deps = {}) {
  const mode = getIconFetchMode(useProxy);
  let response;

  try {
    response = await safeFetchIconResource(config, parsedUrl.href, {
      phase: 'html',
      headers: {
        Accept: 'text/html,application/xhtml+xml'
      }
    }, useProxy, deps);
  } catch (error) {
    logIconFetch(config, 'html:fetch:fail', {
      mode,
      reason: getRequestFailureReason(error),
      url: parsedUrl.href,
      ...getErrorLogDetails(error)
    }, deps);
    throw error;
  }

  const contentType = normalizeContentType(response.headers.get('content-type') || '');
  if (!response.ok) {
    logIconFetch(config, 'html:fetch:fail', {
      mode,
      status: response.status,
      contentType,
      reason: 'access-failed',
      url: parsedUrl.href
    }, deps);
    await consumeResponseBody(response);
    return null;
  }

  if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    logIconFetch(config, 'html:fetch:fail', {
      mode,
      status: response.status,
      contentType,
      reason: 'not-html',
      url: parsedUrl.href
    }, deps);
    await consumeResponseBody(response);
    return null;
  }

  logIconFetch(config, 'html:fetch:success', {
    mode,
    status: response.status,
    contentType,
    url: parsedUrl.href
  }, deps);

  let buffer;
  try {
    buffer = await readResponseBuffer(response, config.iconHtmlSampleSize, true);
  } catch (error) {
    logIconFetch(config, 'html:parse:fail', {
      mode,
      reason: 'read-error',
      url: parsedUrl.href,
      ...getErrorLogDetails(error)
    }, deps);
    throw error;
  }

  const html = buffer.toString('utf8');
  const htmlIconCandidates = extractIconLinksFromHtml(html, parsedUrl.href)
    .map((candidate) => ({ ...candidate, fetchMode: mode }));
  logIconFetch(config, htmlIconCandidates.length ? 'html:parse:success' : 'html:parse:fail', {
    mode,
    icons: htmlIconCandidates.length,
    ...(htmlIconCandidates.length ? {} : { reason: 'no-icon-link' }),
    url: parsedUrl.href
  }, deps);

  const iconCandidates = htmlIconCandidates.length
    ? htmlIconCandidates
    : [getDefaultFaviconCandidate(parsedUrl, mode)];

  if (!htmlIconCandidates.length) {
    logIconFetch(config, 'default:favicon', {
      mode,
      source: iconCandidates[0].url,
      url: parsedUrl.href
    }, deps);
  }

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
    logIconFetch(config, 'icon:skip', { mode, status: response.status, reason: 'access-failed', url: candidateUrl }, deps);
    await consumeResponseBody(response);
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

function getCandidateUrl(candidate) {
  return typeof candidate === 'string' ? candidate : candidate?.url;
}

async function fetchIconCandidate(config, candidate, deps = {}) {
  const candidateUrl = getCandidateUrl(candidate);
  const preferredFetchMode = typeof candidate === 'string' ? '' : candidate?.fetchMode;
  if (!candidateUrl) return null;

  const hasP = hasIconFetchProxy(config);
  // Use preferred only to decide attempt *order*. Always allow fallback to the other
  // mode when proxy is configured. This ensures icon resources (often cross-origin
  // CDNs) are fetched independently of how the HTML page was discovered.
  const tryProxyFirst = (preferredFetchMode === 'proxy' && hasP);
  const attempts = tryProxyFirst ? [true, false] : [false, true];

  let lastErr = null;
  for (const useProxy of attempts) {
    if (useProxy && !hasP) continue;
    try {
      const icon = await readIconCandidate(config, candidateUrl, useProxy, deps);
      if (icon) return icon;
    } catch (error) {
      lastErr = error;
      // Log proxy fallback only on the transition in the normal (direct-first) case
      if (!useProxy && hasP && !tryProxyFirst) {
        logIconFetch(config, 'icon:proxy-fallback', { url: candidateUrl }, deps);
      }
    }
  }

  if (lastErr) throw lastErr;
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

function uniqueIconCandidateDetails(candidates, maxCandidates = 40) {
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
    .slice(0, maxCandidates);
}

function uniqueIconCandidates(candidates, maxCandidates = 40) {
  return uniqueIconCandidateDetails(candidates, maxCandidates)
    .map((candidate) => candidate.url);
}

async function discoverIconCandidateDetails(config, parsedUrl, deps = {}) {
  const documentHints = await discoverDocumentIconHints(config, parsedUrl, deps);
  const candidates = uniqueIconCandidateDetails(documentHints?.iconCandidates || [], config.iconMaxCandidates);
  logIconFetch(config, 'candidates:ready', {
    host: parsedUrl.hostname,
    count: candidates.length,
    url: parsedUrl.href
  }, deps);
  return candidates;
}

async function discoverIconCandidates(config, parsedUrl, deps = {}) {
  return (await discoverIconCandidateDetails(config, parsedUrl, deps))
    .map((candidate) => candidate.url);
}

async function resolveIconForUrl(config, targetUrl, deps = {}) {
  const normalizedTargetUrl = normalizeIconTargetUrl(targetUrl);
  if (!normalizedTargetUrl) {
    logIconFetch(config, 'resolve:invalid-url', { url: targetUrl }, deps);
    return null;
  }

  const parsedUrl = new URL(normalizedTargetUrl);
  logIconFetch(config, 'resolve:start', { url: normalizedTargetUrl }, deps);
  const candidates = await discoverIconCandidateDetails(config, parsedUrl, deps);

  for (const candidate of candidates) {
    const candidateUrl = candidate.url;
    try {
      const icon = await fetchIconCandidate(config, candidate, deps);
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
        ...getErrorLogDetails(error)
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

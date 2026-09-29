const dns = require('node:dns').promises;
const net = require('node:net');

const { Agent, fetch: undiciFetch, ProxyAgent } = require('undici');

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_PORTS = {
  'http:': 80,
  'https:': 443
};
const proxyAgents = new Map();

function parseIPv4(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet < 0 || octet > 255) return null;
    value = (value << 8) + octet;
  }

  return value >>> 0;
}

function ipv4InRange(addressValue, prefixValue, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (addressValue & mask) === (prefixValue & mask);
}

function isPrivateIPv4(address) {
  const value = parseIPv4(address);
  if (value === null) return true;

  const ranges = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
  ];

  return ranges.some(([prefix, bits]) => ipv4InRange(value, parseIPv4(prefix), bits));
}

function parseIPv6Hextets(address) {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (normalized.includes('.')) {
    const ipv4 = normalized.slice(normalized.lastIndexOf(':') + 1);
    if (isPrivateIPv4(ipv4)) return { mappedPrivateIPv4: true };
  }

  const pieces = normalized.split('::');
  if (pieces.length > 2) return null;

  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
  const missingCount = pieces.length === 2 ? 8 - left.length - right.length : 0;
  if (missingCount < 0) return null;

  const hextets = [
    ...left,
    ...Array.from({ length: missingCount }, () => '0'),
    ...right
  ].map((part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return Number.NaN;
    return Number.parseInt(part, 16);
  });

  return hextets.length === 8 && hextets.every(Number.isInteger) ? hextets : null;
}

function isPrivateIPv6(address) {
  const hextets = parseIPv6Hextets(address);
  if (!hextets || hextets.mappedPrivateIPv4) return true;

  const [first, second] = hextets;
  const allZero = hextets.every((value) => value === 0);
  const loopback = hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1;

  return (
    allZero ||
    loopback ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && second === 0x0db8) ||
    (first === 0x2001 && second === 0x0002) ||
    (first === 0x2001 && (second & 0xfff0) === 0x0010)
  );
}

function isBlockedHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return (
    !normalized ||
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'localhost.localdomain'
  );
}

function isBlockedAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  return true;
}

function normalizeHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function parseProxyUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  const parsedUrl = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Proxy protocol is not allowed');
  }
  if (!parsedUrl.hostname) {
    throw new Error('Proxy host is not allowed');
  }

  return parsedUrl.href;
}

function getProxyAgent(proxyUrl) {
  const normalizedProxyUrl = parseProxyUrl(proxyUrl);
  if (!normalizedProxyUrl) return null;

  if (!proxyAgents.has(normalizedProxyUrl)) {
    proxyAgents.set(normalizedProxyUrl, new ProxyAgent(normalizedProxyUrl));
  }

  return proxyAgents.get(normalizedProxyUrl);
}

function splitNoProxyEntry(entry) {
  const normalized = normalizeHostname(entry);
  if (!normalized) return null;
  if (normalized === '*') return { wildcard: true };

  const cidrMatch = normalized.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (cidrMatch) {
    const prefix = parseIPv4(cidrMatch[1]);
    const bits = Number.parseInt(cidrMatch[2], 10);
    if (prefix !== null && bits >= 0 && bits <= 32) {
      return { cidr: true, prefix, bits };
    }
  }

  const portMatch = normalized.match(/^(.+):(\d+)$/);
  const hostname = portMatch && !portMatch[1].includes(':') ? portMatch[1] : normalized;
  const port = portMatch && !portMatch[1].includes(':') ? Number.parseInt(portMatch[2], 10) : 0;
  return { hostname, port };
}

function hostnameMatchesNoProxy(hostname, noProxyHostname) {
  if (!hostname || !noProxyHostname) return false;
  if (hostname === noProxyHostname) return true;
  if (noProxyHostname.startsWith('*.')) return hostname.endsWith(noProxyHostname.slice(1));
  if (noProxyHostname.startsWith('.')) return hostname.endsWith(noProxyHostname);
  if (noProxyHostname.startsWith('*')) return hostname.endsWith(noProxyHostname.slice(1));
  return false;
}

function shouldBypassProxy(parsedUrl, noProxy) {
  const noProxyValue = String(noProxy || '').trim();
  if (!noProxyValue) return false;

  const hostname = normalizeHostname(parsedUrl.hostname);
  const port = Number.parseInt(parsedUrl.port, 10) || DEFAULT_PORTS[parsedUrl.protocol] || 0;
  const hostnameIPv4 = parseIPv4(hostname);

  return noProxyValue
    .split(/[,\s]+/)
    .map(splitNoProxyEntry)
    .filter(Boolean)
    .some((entry) => {
      if (entry.wildcard) return true;
      if (entry.port && entry.port !== port) return false;
      if (entry.cidr) {
        return hostnameIPv4 !== null && ipv4InRange(hostnameIPv4, entry.prefix, entry.bits);
      }
      return hostnameMatchesNoProxy(hostname, entry.hostname);
    });
}

function getProxyDispatcherForUrl(parsedUrl, proxy) {
  if (!proxy || shouldBypassProxy(parsedUrl, proxy.noProxy)) return null;

  const proxyUrl = parsedUrl.protocol === 'https:'
    ? (proxy.httpsProxy || proxy.httpProxy)
    : proxy.httpProxy;

  return getProxyAgent(proxyUrl);
}

function parsePublicHttpUrl(value, baseUrl, options = {}) {
  const parsedUrl = new URL(value, baseUrl);
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('URL protocol is not allowed');
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('URL credentials are not allowed');
  }
  if (!hostname) {
    throw new Error('URL host is not allowed');
  }
  const permitPrivateNetwork = permitsPrivateNetwork(hostname, options);
  if (!permitPrivateNetwork && isBlockedHostname(hostname)) {
    throw new Error('URL host is not allowed');
  }
  if (!permitPrivateNetwork && net.isIP(hostname) && isBlockedAddress(hostname)) {
    throw new Error('URL address is not allowed');
  }
  return parsedUrl;
}

function permitsPrivateNetwork(hostname, options = {}) {
  if (options.allowPrivateNetwork) return true;
  const normalized = normalizeHostname(hostname);
  const allowlist = options.privateNetworkHosts;
  if (!normalized || !allowlist) return false;
  const hosts = Array.isArray(allowlist) ? allowlist : [allowlist];
  return hosts.some((host) => normalizeHostname(host) === normalized);
}

function normalizeResolvedAddresses(addresses) {
  if (!Array.isArray(addresses)) return [];

  return addresses.flatMap((entry) => {
    const address = entry?.address;
    if (!address || !net.isIP(address)) return [];
    const family = entry.family === 6 || net.isIP(address) === 6 ? 6 : 4;
    return [{ address, family }];
  });
}

async function resolvePinnedAddresses(hostname, options = {}) {
  if (net.isIP(hostname)) {
    const family = net.isIP(hostname) === 6 ? 6 : 4;
    return [{ address: hostname, family }];
  }

  const lookup = options.lookup || dns.lookup;
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('URL host could not be resolved');
  }

  const pinnedAddresses = normalizeResolvedAddresses(addresses);
  if (!pinnedAddresses.length) {
    throw new Error('URL host could not be resolved');
  }
  if (!permitsPrivateNetwork(hostname, options) && pinnedAddresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new Error('URL resolved to a blocked address');
  }
  return pinnedAddresses;
}

function createPinnedAgent(addresses) {
  return new Agent({
    connect: {
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions.all) {
          callback(null, addresses);
          return;
        }
        callback(null, addresses[0].address, addresses[0].family);
      }
    }
  });
}

function proxyUrlForRequest(parsedUrl, proxy) {
  if (!proxy || shouldBypassProxy(parsedUrl, proxy.noProxy)) return '';
  const proxyUrl = parsedUrl.protocol === 'https:'
    ? (proxy.httpsProxy || proxy.httpProxy)
    : proxy.httpProxy;
  return proxyUrl || '';
}

function withPinnedHostHeader(headers, host) {
  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length; index += 2) {
      if (String(headers[index]).toLowerCase() === 'host') return headers;
    }
    return [...headers, 'host', host];
  }

  if (headers && typeof headers === 'object') {
    if (Object.keys(headers).some((key) => key.toLowerCase() === 'host')) return headers;
    return { ...headers, host };
  }

  return { host };
}

function createPinnedProxyDispatcher(proxyUrl, parsedUrl, addresses) {
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  const proxyAgent = new ProxyAgent({
    uri: parseProxyUrl(proxyUrl),
    requestTls: { servername: hostname }
  });
  const target = new URL(parsedUrl.href);
  target.hostname = addresses[0].address;
  const origin = target.origin;
  const host = parsedUrl.host;

  return {
    dispatch(opts, handler) {
      return proxyAgent.dispatch({
        ...opts,
        origin,
        headers: withPinnedHostHeader(opts.headers, host)
      }, handler);
    },
    close() {
      return proxyAgent.close();
    },
    destroy(error) {
      return proxyAgent.destroy(error);
    }
  };
}

async function assertPublicHttpUrl(value, options = {}) {
  const parsedUrl = parsePublicHttpUrl(value, options.baseUrl, options);
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  parsedUrl.validatedAddresses = await resolvePinnedAddresses(hostname, options);
  return parsedUrl;
}

function createTimeoutError(timeoutMs) {
  const timeoutError = new Error('Request timed out');
  timeoutError.code = 'FETCH_TIMEOUT';
  timeoutError.timeoutMs = timeoutMs;
  return timeoutError;
}

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number.parseInt(options.timeoutMs, 10) || 0;
  let didTimeout = false;
  let finished = false;
  let reader = null;
  let streamController = null;
  const timeout = timeoutMs > 0
    ? setTimeout(() => {
      didTimeout = true;
      controller.abort();
      reader?.cancel().catch(() => {});
      if (streamController) {
        try {
          streamController.error(createTimeoutError(timeoutMs));
        } catch {
          // The stream already settled.
        }
      }
      finish();
    }, timeoutMs)
    : null;
  if (typeof timeout?.unref === 'function') timeout.unref();

  const fetchImpl = options.fetch || undiciFetch;
  const pinnedAddresses = normalizeResolvedAddresses(options.addresses);
  let pinnedAgent = null;

  function finish() {
    if (finished) return;
    finished = true;
    if (timeout) clearTimeout(timeout);
    pinnedAgent?.close().catch(() => {});
  }

  let fetchPromise;

  try {
    const parsedUrl = new URL(url);
    const fetchOptions = {
      ...options,
      signal: controller.signal
    };
    const explicitDispatcher = fetchOptions.dispatcher;
    const proxyUrl = explicitDispatcher ? '' : proxyUrlForRequest(parsedUrl, fetchOptions.proxy);
    if (fetchImpl === undiciFetch && pinnedAddresses.length && !explicitDispatcher) {
      // Connect to the addresses already checked. A later DNS answer is ignored.
      pinnedAgent = proxyUrl
        ? createPinnedProxyDispatcher(proxyUrl, parsedUrl, pinnedAddresses)
        : createPinnedAgent(pinnedAddresses);
      fetchOptions.dispatcher = pinnedAgent;
    } else if (explicitDispatcher || proxyUrl) {
      fetchOptions.dispatcher = explicitDispatcher || getProxyDispatcherForUrl(parsedUrl, fetchOptions.proxy);
    }

    delete fetchOptions.timeoutMs;
    delete fetchOptions.maxRedirects;
    delete fetchOptions.lookup;
    delete fetchOptions.allowPrivateNetwork;
    delete fetchOptions.privateNetworkHosts;
    delete fetchOptions.addresses;
    delete fetchOptions.proxy;
    delete fetchOptions.fetch;
    fetchPromise = fetchImpl(url, fetchOptions);
  } catch (error) {
    finish();
    throw error;
  }

  return fetchPromise
    .then((response) => {
      if (didTimeout) throw createTimeoutError(timeoutMs);
      if (!response.body) {
        finish();
        return response;
      }

      reader = response.body.getReader();
      const stream = new ReadableStream({
        async pull(controller) {
          streamController = controller;
          if (didTimeout) {
            controller.error(createTimeoutError(timeoutMs));
            return;
          }

          try {
            const { done, value } = await reader.read();
            if (didTimeout) {
              controller.error(createTimeoutError(timeoutMs));
              return;
            }
            if (done) {
              finish();
              controller.close();
              return;
            }
            controller.enqueue(value);
          } catch (error) {
            if (didTimeout) {
              try {
                controller.error(createTimeoutError(timeoutMs));
              } catch {
                // The stream already settled.
              }
              return;
            }
            finish();
            controller.error(error);
          }
        },
        cancel(reason) {
          finish();
          return reader.cancel(reason);
        }
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    })
    .catch((error) => {
      finish();
      if (didTimeout || error?.code === 'FETCH_TIMEOUT') {
        const timeoutError = error?.code === 'FETCH_TIMEOUT' ? error : createTimeoutError(timeoutMs);
        if (error && error.code !== 'FETCH_TIMEOUT') timeoutError.cause = error;
        throw timeoutError;
      }
      throw error;
    });
}

async function safeFetch(url, options = {}) {
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : 3;
  const lookup = options.lookup;
  const allowPrivateNetwork = Boolean(options.allowPrivateNetwork);
  const privateNetworkHosts = options.privateNetworkHosts;
  let currentTarget = await assertPublicHttpUrl(url, {
    lookup,
    allowPrivateNetwork,
    privateNetworkHosts
  });

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetchWithTimeout(currentTarget.href, {
      ...options,
      addresses: currentTarget.validatedAddresses,
      redirect: 'manual'
    });

    if (!REDIRECT_STATUS_CODES.has(response.status)) {
      return response;
    }

    await response.body?.cancel?.().catch(() => {});
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirectCount === maxRedirects) {
      throw new Error('Too many redirects');
    }

    currentTarget = await assertPublicHttpUrl(location, {
      baseUrl: currentTarget.href,
      lookup,
      allowPrivateNetwork,
      privateNetworkHosts
    });
  }

  throw new Error('Too many redirects');
}

function clearProxyAgents() {
  proxyAgents.clear();
}

module.exports = {
  assertPublicHttpUrl,
  clearProxyAgents,
  isBlockedAddress,
  isBlockedHostname,
  isPrivateIPv4,
  isPrivateIPv6,
  parsePublicHttpUrl,
  parseProxyUrl,
  safeFetch
};

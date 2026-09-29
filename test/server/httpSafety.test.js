const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { once } = require('node:events');

const {
  assertPublicHttpUrl,
  isBlockedAddress,
  isPrivateIPv4,
  isPrivateIPv6,
  safeFetch
} = require('../../src/server/services/httpSafety');

test('private and reserved addresses are blocked', () => {
  assert.equal(isPrivateIPv4('127.0.0.1'), true);
  assert.equal(isPrivateIPv4('10.1.2.3'), true);
  assert.equal(isPrivateIPv4('169.254.169.254'), true);
  assert.equal(isPrivateIPv4('93.184.216.34'), false);
  assert.equal(isPrivateIPv6('::1'), true);
  assert.equal(isPrivateIPv6('fc00::1'), true);
  assert.equal(isPrivateIPv6('fe80::1'), true);
  assert.equal(isBlockedAddress('8.8.8.8'), false);
});

test('assertPublicHttpUrl rejects localhost, private literals, and private DNS answers', async () => {
  await assert.rejects(() => assertPublicHttpUrl('http://localhost/'));
  await assert.rejects(() => assertPublicHttpUrl('http://192.168.1.10/'));
  await assert.rejects(() => assertPublicHttpUrl('https://service.test/', {
    lookup: async () => [{ address: '10.0.0.5', family: 4 }]
  }));

  const parsedUrl = await assertPublicHttpUrl('https://service.test/path', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  assert.equal(parsedUrl.href, 'https://service.test/path');
});

test('safeFetch validates every redirect target before following it', async () => {
  const fetch = async () => new Response(null, {
    status: 302,
    headers: {
      location: 'http://127.0.0.1/private'
    }
  });

  await assert.rejects(() => safeFetch('https://service.test/icon.png', {
    fetch,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    timeoutMs: 1000
  }));
});

test('allowed networks permit a listed address or CIDR range', async () => {
  await assert.rejects(() => assertPublicHttpUrl('http://192.168.31.111/'));
  await assert.rejects(() => assertPublicHttpUrl('http://192.168.31.111/', {
    allowedNetworks: '192.168.31.112'
  }));
  await assert.rejects(() => assertPublicHttpUrl('http://127.0.0.1/', {
    allowedNetworks: '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'
  }));
  await assert.rejects(() => assertPublicHttpUrl('http://localhost/', {
    allowedNetworks: '127.0.0.1'
  }));

  const literal = await assertPublicHttpUrl('http://192.168.31.111/icon', {
    allowedNetworks: '192.168.31.0/24'
  });
  assert.equal(literal.hostname, '192.168.31.111');

  const named = await assertPublicHttpUrl('http://router.home/icon', {
    allowedNetworks: '192.168.31.111',
    lookup: async () => [{ address: '192.168.31.111', family: 4 }]
  });
  assert.equal(named.validatedAddresses[0].address, '192.168.31.111');

  await assert.rejects(() => assertPublicHttpUrl('http://router.home/icon', {
    allowedNetworks: '192.168.31.0/24',
    lookup: async () => [{ address: '10.1.1.1', family: 4 }]
  }));

  const response = await safeFetch('http://192.168.31.111/icon.svg', {
    allowedNetworks: '192.168.31.111',
    fetch: async () => new Response('ok', { status: 200 }),
    timeoutMs: 1000
  });
  assert.equal(response.status, 200);
});

test('safeFetch allows private network only when explicitly requested', async () => {
  const fetch = async () => new Response('ok', { status: 200 });

  await assert.rejects(() => safeFetch('http://127.0.0.1/icon.svg', {
    fetch,
    timeoutMs: 1000
  }));

  const response = await safeFetch('http://127.0.0.1/icon.svg', {
    allowPrivateNetwork: true,
    fetch,
    timeoutMs: 1000
  });
  assert.equal(response.status, 200);
});

test('safeFetch applies proxy dispatcher when proxy is configured', async () => {
  let fetchOptions;
  const fetch = async (url, options) => {
    fetchOptions = options;
    return new Response('ok', { status: 200 });
  };

  const response = await safeFetch('https://service.test/icon.svg', {
    fetch,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    proxy: {
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: ''
    },
    timeoutMs: 1000
  });

  assert.equal(response.status, 200);
  assert.ok(fetchOptions.dispatcher);
});

test('safeFetch honors no_proxy entries before applying proxy dispatcher', async () => {
  let fetchOptions;
  const fetch = async (url, options) => {
    fetchOptions = options;
    return new Response('ok', { status: 200 });
  };

  const response = await safeFetch('http://10.1.2.3/icon.svg', {
    allowPrivateNetwork: true,
    fetch,
    proxy: {
      httpProxy: 'http://127.0.0.1:7890',
      noProxy: '127.0.0.1,10.0.0.0/8'
    },
    timeoutMs: 1000
  });

  assert.equal(response.status, 200);
  assert.equal(fetchOptions.dispatcher, undefined);
});

test('safeFetch allowlist permits only the named private host', async () => {
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(String(url));
    return new Response('ok', { status: 200 });
  };

  const allowed = await safeFetch('http://192.168.1.10/icon.svg', {
    fetch,
    privateNetworkHosts: ['192.168.1.10'],
    timeoutMs: 1000
  });
  assert.equal(allowed.status, 200);

  await assert.rejects(() => safeFetch('http://192.168.1.1/secret', {
    fetch,
    privateNetworkHosts: ['192.168.1.10'],
    timeoutMs: 1000
  }));
  assert.deepEqual(fetched, ['http://192.168.1.10/icon.svg']);
});

test('safeFetch allowlist does not follow a redirect to a different private host', async () => {
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(String(url));
    return new Response(null, {
      status: 302,
      headers: { location: 'http://192.168.1.1/secret' }
    });
  };

  await assert.rejects(() => safeFetch('http://192.168.1.10/', {
    fetch,
    privateNetworkHosts: ['192.168.1.10'],
    timeoutMs: 1000
  }));
  assert.deepEqual(fetched, ['http://192.168.1.10/']);
});

test('safeFetch timeout stays active until the response body is read', async () => {
  let timer;
  let finishPull;
  const fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      return new Promise((resolve) => {
        finishPull = resolve;
        timer = setTimeout(() => {
          try {
            controller.enqueue(new TextEncoder().encode('slow'));
            controller.close();
          } catch {
            // The timeout already cancelled this body.
          }
          resolve();
        }, 400);
      });
    },
    cancel() {
      clearTimeout(timer);
      finishPull?.();
    }
  }), { status: 200 });

  const startedAt = Date.now();
  await assert.rejects(async () => {
    const response = await safeFetch('https://service.test/icon.svg', {
      fetch,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      timeoutMs: 100
    });
    await response.arrayBuffer();
  }, (error) => {
    assert.equal(error.code, 'FETCH_TIMEOUT');
    assert.equal(error.timeoutMs, 100);
    return true;
  });
  assert.ok(Date.now() - startedAt < 300, `body download exceeded the timeout window (${Date.now() - startedAt}ms)`);
});

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('safeFetch keeps the checked address for the connection', async (t) => {
  const hits = [];
  const origin = http.createServer((req, res) => {
    hits.push({ url: req.url, host: req.headers.host });
    res.end('secret');
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  t.after(() => closeServer(origin));
  const port = origin.address().port;

  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    return [{ address: '127.0.0.1', family: 4 }];
  };

  await assert.rejects(() => safeFetch(`http://rebind.example:${port}/secret`, {
    lookup,
    timeoutMs: 1000
  }));
  assert.equal(lookups, 1);
  assert.deepEqual(hits, []);

  lookups = 0;
  const response = await safeFetch(`http://rebind.example:${port}/pinned`, {
    allowPrivateNetwork: true,
    lookup,
    timeoutMs: 1000
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'secret');
  assert.equal(lookups, 1);
  assert.deepEqual(hits, [{ url: '/pinned', host: `rebind.example:${port}` }]);
});

test('safeFetch lets the proxy resolve a domain name', async (t) => {
  const hits = [];
  const origin = http.createServer((req, res) => {
    hits.push({ url: req.url, host: req.headers.host });
    res.end('secret');
  });
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url);
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const upstreamHost = target.hostname === 'rebind.example' ? '127.0.0.1' : target.hostname;
    const upstream = http.request({
      host: upstreamHost.replace(/^\[|\]$/g, ''),
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: req.headers
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502);
      upstreamResponse.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  origin.listen(0, '127.0.0.1');
  proxy.listen(0, '127.0.0.1');
  await Promise.all([once(origin, 'listening'), once(proxy, 'listening')]);
  t.after(() => Promise.all([closeServer(origin), closeServer(proxy)]));
  const port = origin.address().port;
  const proxyOptions = {
    httpProxy: `http://127.0.0.1:${proxy.address().port}`,
    noProxy: ''
  };

  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    return [{ address: '127.0.0.1', family: 4 }];
  };

  await assert.rejects(() => safeFetch(`http://127.0.0.1:${port}/secret`, {
    lookup,
    proxy: proxyOptions,
    timeoutMs: 1000
  }));
  assert.equal(lookups, 0);
  assert.deepEqual(seen, []);

  const response = await safeFetch(`http://rebind.example:${port}/via-proxy`, {
    lookup,
    proxy: proxyOptions,
    timeoutMs: 1000
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'secret');
  assert.equal(lookups, 0);
  assert.equal(seen[0], `http://rebind.example:${port}/via-proxy`);
  assert.deepEqual(hits, [{ url: '/via-proxy', host: `rebind.example:${port}` }]);
});

test('safeFetch sends a proxy the checked IPv6 address', async (t) => {
  const hits = [];
  const origin = http.createServer((req, res) => {
    hits.push({ url: req.url, host: req.headers.host });
    res.end('secret');
  });
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url);
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const upstream = http.request({
      host: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port,
      family: 6,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: req.headers
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502);
      upstreamResponse.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  origin.listen(0, '::1');
  proxy.listen(0, '127.0.0.1');
  await Promise.all([once(origin, 'listening'), once(proxy, 'listening')]);
  t.after(() => Promise.all([closeServer(origin), closeServer(proxy)]));
  const port = origin.address().port;

  let lookups = 0;
  const response = await safeFetch(`http://[::1]:${port}/via-proxy`, {
    allowPrivateNetwork: true,
    lookup: async () => {
      lookups += 1;
      throw new Error('proxy address literals are not resolved locally');
    },
    proxy: {
      httpProxy: `http://127.0.0.1:${proxy.address().port}`,
      noProxy: ''
    },
    timeoutMs: 1000
  });
  assert.equal(lookups, 0);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'secret');
  assert.equal(seen[0], `http://[::1]:${port}/via-proxy`);
  assert.deepEqual(hits, [{ url: '/via-proxy', host: `[::1]:${port}` }]);
});

test('safeFetch reports request timeouts explicitly', async () => {
  const fetch = async (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(new DOMException('This operation was aborted', 'AbortError'));
    });
  });

  await assert.rejects(() => safeFetch('https://service.test/icon.svg', {
    fetch,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    timeoutMs: 1
  }), (error) => {
    assert.equal(error.code, 'FETCH_TIMEOUT');
    assert.equal(error.timeoutMs, 1);
    assert.equal(error.message, 'Request timed out');
    return true;
  });
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const { loadConfig } = require('../../src/server/config');
const {
  createIconFetcher,
  discoverIconCandidates,
  extractIconLinksFromHtml,
  fetchIconCandidate,
  normalizeIconTargetUrl,
  toHttpUrl
} = require('../../src/server/services/iconFetcher');

function makeIconConfig(overrides = {}) {
  const rootDir = path.resolve(__dirname, '../..');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-icon-fetcher-'));
  return {
    ...loadConfig({
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'password',
      SESSION_SECRET: 'session-secret-for-tests',
      DATA_DIR: path.join(tmpDir, 'data'),
      UPLOADS_DIR: path.join(tmpDir, 'uploads'),
      PUBLIC_DIR: path.join(rootDir, 'public'),
      DATABASE_PATH: path.join(tmpDir, 'app.sqlite')
    }, { rootDir }),
    ...overrides
  };
}

async function startServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

test('normalizeIconTargetUrl and toHttpUrl accept HTTP targets only', () => {
  assert.equal(normalizeIconTargetUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeIconTargetUrl('https://example.com/#/app'), 'https://example.com/');
  assert.equal(normalizeIconTargetUrl('ftp://example.com'), null);
  assert.equal(normalizeIconTargetUrl('https://user:pass@example.com'), null);
  assert.equal(toHttpUrl('/favicon.svg', 'https://example.com/ui/'), 'https://example.com/favicon.svg');
  assert.equal(toHttpUrl('javascript:alert(1)', 'https://example.com/'), null);
});

test('HTML relative favicon links resolve to absolute URLs', () => {
  const icons = extractIconLinksFromHtml(
    '<link rel="icon" href="favicon.svg"><link rel="apple-touch-icon" href="/touch.png">',
    'https://example.com/ui/'
  );

  assert.deepEqual(icons.map((icon) => icon.url), [
    'https://example.com/ui/favicon.svg',
    'https://example.com/touch.png'
  ]);
});

test('discoverIconCandidates returns only icons declared in HTML', async (t) => {
  const requestedUrls = [];
  const app = await startServer((req, res) => {
    requestedUrls.push(req.url);
    if (req.url === '/app/page') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<link rel="icon" href="favicon.svg"><link rel="manifest" href="/manifest.json">');
      return;
    }
    if (req.url === '/manifest.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        icons: [{ src: '/icons/manifest-192.png', sizes: '192x192', type: 'image/png' }]
      }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  t.after(app.close);

  const candidates = await discoverIconCandidates(makeIconConfig(), new URL(`${app.baseUrl}/app/page`));
  assert.deepEqual(candidates, [`${app.baseUrl}/app/favicon.svg`]);
  assert.deepEqual(requestedUrls, ['/app/page']);
});

test('discoverIconCandidates ranks only HTML-declared icons', async () => {
  const logs = [];
  const html = [
    '<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">',
    '<link rel="apple-touch-icon" href="/apple-192.png" sizes="192x192" type="image/png">',
    '<link rel="manifest" href="/manifest.json">'
  ].join('');
  const candidates = await discoverIconCandidates(
    makeIconConfig({ iconFetchLogEnabled: true, iconMaxCandidates: 8 }),
    new URL('https://x.com/'),
    {
      logger: {
        log(line) {
          logs.push(line);
        }
      },
      safeFetch: async (url) => {
        if (url === 'https://x.com/') {
          return new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' }
          });
        }

        if (url === 'https://x.com/manifest.json') {
          return new Response(JSON.stringify({
            icons: [{ src: '/manifest-512.png', sizes: '512x512', type: 'image/png' }]
          }), {
            status: 200,
            headers: { 'content-type': 'application/manifest+json' }
          });
        }

        return new Response('', {
          status: 404,
          headers: { 'content-type': 'text/plain' }
        });
      }
    }
  );

  assert.deepEqual(candidates, [
    'https://x.com/apple-192.png',
    'https://x.com/favicon-32.png'
  ]);
  assert.ok(logs.some((line) => {
    const log = JSON.parse(line);
    return log.event === 'html:fetch:success' && log.mode === 'direct' && /x\.com/.test(log.url || '');
  }));
  assert.ok(logs.some((line) => {
    const log = JSON.parse(line);
    return log.event === 'html:parse:success' && log.mode === 'direct' && /x\.com/.test(log.url || '');
  }));
});

test('discoverIconCandidates falls back to default favicon when no icon links are found', async () => {
  const logs = [];
  const candidates = await discoverIconCandidates(
    makeIconConfig({ iconFetchLogEnabled: true }),
    new URL('https://example.com/'),
    {
      logger: {
        log(line) {
          logs.push(line);
        }
      },
      safeFetch: async () => new Response('<html><head><title>No icons</title></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    }
  );

  assert.deepEqual(candidates, ['https://example.com/favicon.ico']);
  assert.ok(logs.some((line) => {
    const log = JSON.parse(line);
    return log.event === 'html:fetch:success' && log.mode === 'direct' && /example\.com/.test(log.url || '');
  }));
  assert.ok(logs.some((line) => {
    const log = JSON.parse(line);
    return log.event === 'html:parse:fail' && log.mode === 'direct' && log.reason === 'no-icon-link';
  }));
  assert.ok(logs.some((line) => {
    const log = JSON.parse(line);
    return log.event === 'default:favicon' && log.mode === 'direct' && log.source === 'https://example.com/favicon.ico';
  }));
});

test('discoverIconCandidates logs HTML fetch failure on request errors', async () => {
  const logs = [];
  const candidates = await discoverIconCandidates(
    makeIconConfig({ iconFetchLogEnabled: true }),
    new URL('https://example.com/'),
    {
      logger: {
        log(line) {
          logs.push(line);
        }
      },
      safeFetch: async () => {
        throw new Error('fetch failed', {
          cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8080' }
        });
      }
    }
  );

  assert.deepEqual(candidates, []);
  assert.ok(logs.some((line) => {
    const log = JSON.parse(line);
    return log.event === 'request:connect:fail' &&
           log.mode === 'direct' &&
           log.reason === 'connection-failed' &&
           log.errorCode === 'ECONNREFUSED' &&
           /ECONNREFUSED/.test(log.errorCause || '') &&
           /fetch failed/.test(log.error || '');
  }));
  assert.ok(logs.some((line) => {
    const log = JSON.parse(line);
    return log.event === 'html:fetch:fail' &&
           log.mode === 'direct' &&
           log.reason === 'connection-failed' &&
           log.errorCode === 'ECONNREFUSED';
  }));
});

test('discoverIconCandidates logs request timeouts explicitly', async () => {
  const logs = [];
  const candidates = await discoverIconCandidates(
    makeIconConfig({ iconFetchLogEnabled: true }),
    new URL('https://example.com/'),
    {
      logger: {
        log(line) {
          logs.push(line);
        }
      },
      safeFetch: async () => {
        const error = new Error('Request timed out', {
          cause: new DOMException('This operation was aborted', 'AbortError')
        });
        error.code = 'FETCH_TIMEOUT';
        error.timeoutMs = 5000;
        throw error;
      }
    }
  );

  assert.deepEqual(candidates, []);
  assert.ok(logs.some((line) => {
    const log = JSON.parse(line);
    return log.event === 'request:timeout' &&
           log.mode === 'direct' &&
           log.reason === 'timeout' &&
           log.timeoutMs === 5000 &&
           log.errorCode === 'FETCH_TIMEOUT';
  }));
  assert.ok(logs.some((line) => {
    const log = JSON.parse(line);
    return log.event === 'html:fetch:fail' &&
           log.mode === 'direct' &&
           log.reason === 'timeout' &&
           log.timeoutMs === 5000;
  }));
});

test('discoverIconCandidates logs proxy address and access failures', async () => {
  const logs = [];
  const candidates = await discoverIconCandidates(
    makeIconConfig({
      iconFetchLogEnabled: true,
      iconFetchProxy: {
        httpProxy: 'http://proxy.example:8080',
        httpsProxy: 'http://proxy.example:8080',
        noProxy: ''
      }
    }),
    new URL('https://example.com/'),
    {
      logger: {
        log(line) {
          logs.push(line);
        }
      },
      safeFetch: async (url, options) => {
        if (!options.proxy) throw new Error('direct down');
        return new Response('forbidden', {
          status: 403,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        });
      }
    }
  );

  assert.deepEqual(candidates, []);
  assert.ok(logs.some((line) => {
    const log = JSON.parse(line);
    return log.event === 'request:start' &&
           log.mode === 'proxy' &&
           /proxy\.example:8080/.test(log.proxy || '');
  }));
  assert.ok(logs.some((line) => {
    const log = JSON.parse(line);
    return log.event === 'request:access:fail' &&
           log.mode === 'proxy' &&
           /proxy\.example:8080/.test(log.proxy || '') &&
           log.status === 403 &&
           log.reason === 'access-failed';
  }));
});

test('fetchIconCandidate accepts valid image magic and rejects forged image data', async (t) => {
  const app = await startServer((req, res) => {
    if (req.url === '/icon.svg') {
      res.setHeader('content-type', 'text/plain');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>');
      return;
    }
    if (req.url === '/fake.png') {
      res.setHeader('content-type', 'image/png');
      res.end('not an image');
      return;
    }
    if (req.url === '/large.svg') {
      res.setHeader('content-type', 'image/svg+xml');
      res.setHeader('content-length', '2048');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  t.after(app.close);

  const config = makeIconConfig();
  const icon = await fetchIconCandidate(config, `${app.baseUrl}/icon.svg`);
  assert.equal(icon.contentType, 'image/svg+xml');
  assert.equal(icon.extension, '.svg');

  assert.equal(await fetchIconCandidate(config, `${app.baseUrl}/fake.png`), null);
  await assert.rejects(
    () => fetchIconCandidate(makeIconConfig({ maxIconSize: 8 }), `${app.baseUrl}/large.svg`),
    /too large/
  );
});

test('icon fetcher tries direct requests before proxy fallback', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
  const config = makeIconConfig({
    iconFetchProxy: {
      httpProxy: 'http://proxy.example:8080',
      httpsProxy: 'http://proxy.example:8080',
      noProxy: ''
    }
  });

  let calls = [];
  let fetcher = createIconFetcher(config, {
    safeFetch: async (url, options) => {
      calls.push({ url, hasProxy: Boolean(options.proxy) });
      if (calls.length === 1) {
        return new Response('not an image', {
          status: 200,
          headers: { 'content-type': 'image/png' }
        });
      }
      return new Response(svg, {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' }
      });
    }
  });

  let icon = await fetcher.fetchIconCandidate('https://example.com/icon.svg');
  assert.equal(icon.contentType, 'image/svg+xml');
  assert.deepEqual(calls.map((call) => call.hasProxy), [false, true]);

  calls = [];
  fetcher = createIconFetcher(config, {
    safeFetch: async (url, options) => {
      calls.push({ url, hasProxy: Boolean(options.proxy) });
      if (calls.length === 1) throw new Error('direct failed');
      return new Response(svg, {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' }
      });
    }
  });

  icon = await fetcher.fetchIconCandidate('https://example.com/icon.svg');
  assert.equal(icon.contentType, 'image/svg+xml');
  assert.deepEqual(calls.map((call) => call.hasProxy), [false, true]);

  calls = [];
  fetcher = createIconFetcher(config, {
    safeFetch: async (url, options) => {
      calls.push({ url, hasProxy: Boolean(options.proxy) });
      return new Response(svg, {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' }
      });
    }
  });

  icon = await fetcher.fetchIconCandidate('https://example.com/icon.svg');
  assert.equal(icon.contentType, 'image/svg+xml');
  assert.deepEqual(calls.map((call) => call.hasProxy), [false]);
});

test('resolved icons use the same fetch mode as the HTML discovery', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
  const html = '<link rel="icon" href="https://cdn.example.com/icon.svg" type="image/svg+xml">';
  const config = makeIconConfig({
    iconFetchProxy: {
      httpProxy: 'http://proxy.example:8080',
      httpsProxy: 'http://proxy.example:8080',
      noProxy: ''
    }
  });

  let calls = [];
  let fetcher = createIconFetcher(config, {
    safeFetch: async (url, options) => {
      calls.push({ url, hasProxy: Boolean(options.proxy) });
      if (url === 'https://example.com/') {
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        });
      }

      return new Response(svg, {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' }
      });
    }
  });

  let resolved = await fetcher.resolveIconForUrl('https://example.com/');
  assert.equal(resolved.icon.contentType, 'image/svg+xml');
  assert.deepEqual(calls, [
    { url: 'https://example.com/', hasProxy: false },
    { url: 'https://cdn.example.com/icon.svg', hasProxy: false }
  ]);

  calls = [];
  fetcher = createIconFetcher(config, {
    safeFetch: async (url, options) => {
      calls.push({ url, hasProxy: Boolean(options.proxy) });
      if (url === 'https://example.com/' && !options.proxy) throw new Error('direct html failed');
      if (url === 'https://example.com/') {
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        });
      }

      return new Response(svg, {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' }
      });
    }
  });

  resolved = await fetcher.resolveIconForUrl('https://example.com/');
  assert.equal(resolved.icon.contentType, 'image/svg+xml');
  assert.deepEqual(calls, [
    { url: 'https://example.com/', hasProxy: false },
    { url: 'https://example.com/', hasProxy: true },
    { url: 'https://cdn.example.com/icon.svg', hasProxy: true }
  ]);
});

test('icon candidates discovered via direct HTML still fall back to proxy when the icon asset itself requires it', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
  const html = '<link rel="icon" href="https://cdn.example.com/icon.svg" type="image/svg+xml">';
  const config = makeIconConfig({
    iconFetchProxy: {
      httpProxy: 'http://proxy.example:8080',
      httpsProxy: 'http://proxy.example:8080',
      noProxy: ''
    }
  });

  let calls = [];
  const fetcher = createIconFetcher(config, {
    safeFetch: async (url, options) => {
      calls.push({ url, hasProxy: Boolean(options.proxy) });
      if (url === 'https://example.com/') {
        // HTML succeeds directly
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        });
      }
      if (url === 'https://cdn.example.com/icon.svg' && !options.proxy) {
        // Icon asset direct fails (e.g. CDN blocked), but proxy works
        throw new Error('direct icon failed');
      }
      return new Response(svg, {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' }
      });
    }
  });

  const resolved = await fetcher.resolveIconForUrl('https://example.com/');
  assert.equal(resolved.icon.contentType, 'image/svg+xml');
  // HTML direct, then icon: direct attempt (fails) + proxy fallback (succeeds)
  assert.deepEqual(calls, [
    { url: 'https://example.com/', hasProxy: false },
    { url: 'https://cdn.example.com/icon.svg', hasProxy: false },
    { url: 'https://cdn.example.com/icon.svg', hasProxy: true }
  ]);
});

test('default favicon uses the same fetch mode as the HTML discovery', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
  const html = '<html><head><title>No icons</title></head></html>';
  const config = makeIconConfig({
    iconFetchProxy: {
      httpProxy: 'http://proxy.example:8080',
      httpsProxy: 'http://proxy.example:8080',
      noProxy: ''
    }
  });

  let calls = [];
  let fetcher = createIconFetcher(config, {
    safeFetch: async (url, options) => {
      calls.push({ url, hasProxy: Boolean(options.proxy) });
      if (url === 'https://example.com/') {
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        });
      }

      return new Response(svg, {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' }
      });
    }
  });

  let resolved = await fetcher.resolveIconForUrl('https://example.com/');
  assert.equal(resolved.icon.contentType, 'image/svg+xml');
  assert.deepEqual(calls, [
    { url: 'https://example.com/', hasProxy: false },
    { url: 'https://example.com/favicon.ico', hasProxy: false }
  ]);

  calls = [];
  fetcher = createIconFetcher(config, {
    safeFetch: async (url, options) => {
      calls.push({ url, hasProxy: Boolean(options.proxy) });
      if (url === 'https://example.com/' && !options.proxy) throw new Error('direct html failed');
      if (url === 'https://example.com/') {
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        });
      }

      return new Response(svg, {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' }
      });
    }
  });

  resolved = await fetcher.resolveIconForUrl('https://example.com/');
  assert.equal(resolved.icon.contentType, 'image/svg+xml');
  assert.deepEqual(calls, [
    { url: 'https://example.com/', hasProxy: false },
    { url: 'https://example.com/', hasProxy: true },
    { url: 'https://example.com/favicon.ico', hasProxy: true }
  ]);
});

test('icon fetcher logs only when enabled', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
  const logs = [];
  const logger = {
    log(line) {
      logs.push(line);
    }
  };
  const safeFetch = async () => new Response(svg, {
    status: 200,
    headers: { 'content-type': 'image/svg+xml' }
  });

  let fetcher = createIconFetcher(makeIconConfig({ iconFetchLogEnabled: true }), {
    logger,
    safeFetch
  });
  const icon = await fetcher.fetchIconCandidate('https://example.com/icon.svg');
  assert.equal(icon.contentType, 'image/svg+xml');
  assert.ok(logs.some((line) => {
    const log = JSON.parse(line);
    return log.event === 'request:start' &&
           log.mode === 'direct' &&
           log.phase === 'icon' &&
           /example\.com\/icon\.svg/.test(log.url || '');
  }));
  assert.ok(logs.some((line) => {
    const log = JSON.parse(line);
    return log.event === 'icon:accepted' && log.mode === 'direct';
  }));

  logs.length = 0;
  fetcher = createIconFetcher(makeIconConfig({ iconFetchLogEnabled: false }), {
    logger,
    safeFetch
  });
  await fetcher.fetchIconCandidate('https://example.com/icon.svg');
  assert.deepEqual(logs, []);
});

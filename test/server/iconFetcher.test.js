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
  getConventionalIconCandidates,
  getKnownHighResolutionIconCandidates,
  getManifestIconCandidates,
  normalizeIconTargetUrl,
  toHttpUrl,
  uniqueIconCandidates
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

test('manifest icon candidates resolve relative src values and reject unsafe URLs', () => {
  const icons = getManifestIconCandidates({
    icons: [
      { src: '/icons/192.png', sizes: '192x192', type: 'image/png' },
      { src: 'https://user:pass@example.com/icon.png', sizes: '512x512' },
      { src: 'data:image/png;base64,abc', sizes: '32x32' }
    ]
  }, 'https://example.com/app/manifest.json');

  assert.deepEqual(icons.map((icon) => icon.url), [
    'https://example.com/icons/192.png'
  ]);
});

test('SPA URL conventional candidates prioritize subpath favicon', () => {
  const candidates = getConventionalIconCandidates(new URL('https://joker.dantapi.top/ui/'));

  assert.equal(candidates[0], 'https://joker.dantapi.top/ui/favicon.svg');
});

test('known Google and X icon candidates are prioritized over conventional HTTPS favicons', () => {
  let candidates = uniqueIconCandidates([
    ...getKnownHighResolutionIconCandidates(new URL('https://www.google.com/search?q=test')),
    ...getConventionalIconCandidates(new URL('https://www.google.com/search?q=test')).map((url) => ({ url }))
  ]);
  assert.equal(candidates[0], 'https://www.gstatic.com/images/branding/product/1x/googleg_32dp.png');

  candidates = uniqueIconCandidates([
    ...getKnownHighResolutionIconCandidates(new URL('https://x.com/')),
    ...getConventionalIconCandidates(new URL('https://x.com/')).map((url) => ({ url }))
  ]);
  assert.equal(candidates[0], 'https://abs.twimg.com/favicons/twitter.3.ico');
});

test('discoverIconCandidates includes HTML and manifest candidates', async (t) => {
  const app = await startServer((req, res) => {
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
  assert.ok(candidates.includes(`${app.baseUrl}/app/favicon.svg`));
  assert.ok(candidates.includes(`${app.baseUrl}/icons/manifest-192.png`));
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
  assert.ok(logs.some((line) => line.includes('[icon-fetch] event=request:start') && line.includes('mode=direct')));
  assert.ok(logs.some((line) => line.includes('event=icon:accepted')));

  logs.length = 0;
  fetcher = createIconFetcher(makeIconConfig({ iconFetchLogEnabled: false }), {
    logger,
    safeFetch
  });
  await fetcher.fetchIconCandidate('https://example.com/icon.svg');
  assert.deepEqual(logs, []);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const { once } = require('node:events');

const bcrypt = require('bcryptjs');

const { createApp } = require('../../src/server/app');
const { loadConfig } = require('../../src/server/config');
const { createDatabase } = require('../../src/server/db');
const { seedDatabase } = require('../../src/server/db/seed');

function makeConfig(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-home-'));
  const repoRoot = path.resolve(__dirname, '../..');
  return loadConfig({
    SESSION_SECRET: 'session-secret-for-tests',
    DATA_DIR: path.join(tmpDir, 'data'),
    UPLOADS_DIR: path.join(tmpDir, 'uploads'),
    PUBLIC_DIR: path.join(repoRoot, 'public'),
    DATABASE_PATH: path.join(tmpDir, 'app.sqlite'),
    ICON_PREFETCH_ON_READ: 'false',
    BCRYPT_ROUNDS: '4',
    ...overrides
  }, { rootDir: repoRoot });
}

async function startApp() {
  const config = makeConfig();
  const database = createDatabase(config, { skipSeed: true });
  database.stores.users.insertAdmin('admin', bcrypt.hashSync('correct-password', config.bcryptRounds));
  seedDatabase(database.stores);
  const app = createApp({ config, db: database.db, stores: database.stores });
  const sessionReads = [];
  const sessionStore = app.locals.sessionStore;
  const originalGet = sessionStore.get.bind(sessionStore);
  sessionStore.get = (sessionId, callback) => {
    sessionReads.push(sessionId);
    return originalGet(sessionId, callback);
  };
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrfToken = '';

  async function request(route, options = {}) {
    const headers = { ...(options.headers || {}) };
    let body = options.body;
    if (body && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const method = String(options.method || 'GET').toUpperCase();
    if (options.csrf !== false && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (!csrfToken) {
        const tokenResponse = await fetch(`${baseUrl}/api/csrf`, { headers: cookie ? { cookie } : {} });
        const tokenData = await tokenResponse.json();
        csrfToken = tokenData.csrfToken;
        const setCookie = tokenResponse.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
      }
      headers['x-csrf-token'] = csrfToken;
    }
    if (cookie) headers.cookie = cookie;
    const response = await fetch(`${baseUrl}${route}`, { ...options, headers, body });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      cookie = setCookie.split(';')[0];
      csrfToken = '';
    }
    return response;
  }

  return {
    baseUrl,
    cookie: () => cookie,
    sessionReads,
    async login() {
      const response = await request('/api/login', {
        method: 'POST',
        body: { username: 'admin', password: 'correct-password' }
      });
      assert.equal(response.status, 200);
      return response;
    },
    stores: database.stores,
    request,
    async close() {
      app.locals.iconEventHub?.close?.();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      sessionStore.close();
      database.close();
    }
  };
}

function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.on('error', reject);
  });
}

test('homepage is rendered with stored data before client fetches', async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.login();

  const trickyTitle = "Cost $& late $' end $$";
  const created = await app.request('/api/links', {
    method: 'POST',
    body: { title: trickyTitle, url: 'https://example.com/docs' }
  });
  assert.equal(created.status, 201);

  const response = await app.request('/');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /private/);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.match(html, /<body class="logged-in"/);
  assert.doesNotMatch(html, /<body[^>]*app-loading/);
  assert.match(html, /https:\/\/mail\.google\.com\//);
  assert.match(html, /data-engine="google"/);
  assert.ok(html.includes(trickyTitle));
  assert.match(html, /https:\/\/example\.com\/docs/);
  assert.match(html, /loading="eager"/);
  assert.match(html, /id="app-bootstrap"/);
  assert.match(html, /style\.css\?v=[a-f0-9]{12}/);
  assert.match(html, /\/js\/main\.js\?v=[a-f0-9]{12}/);
  assert.match(html, /data-admin="\/js\/admin\.js\?v=[a-f0-9]{12}"/);
  assert.doesNotMatch(html, /__ASSET_|__BOOTSTRAP_|__BODY_/);

  const bootstrap = JSON.parse(html.match(/<script type="application\/json" id="app-bootstrap">([\s\S]*?)<\/script>/)[1]);
  assert.equal(bootstrap.user.username, 'admin');
  assert.equal(bootstrap.links[0].title, trickyTitle);
  assert.equal(bootstrap.emailLinks[0].iconStatus, 'none');
  assert.ok(bootstrap.engines.some((engine) => engine.engineKey === 'google'));

  const pending = await app.request('/api/icons/pending');
  const pendingData = await pending.json();
  assert.equal(pending.status, 200);
  assert.match(pending.headers.get('cache-control') || '', /private, no-store/);
  assert.ok(pendingData.icons.some((icon) => icon.entityType === 'links' && icon.status !== 'none'));
  assert.equal(pendingData.icons.some((icon) => icon.entityType === 'links' && icon.id === bootstrap.emailLinks[0].id), false);
});

test('pending icon lookup returns the latest status for browser ids', async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.login();

  const created = await app.request('/api/links', {
    method: 'POST',
    body: { title: 'Ready Later', url: 'https://example.com/ready' }
  });
  const createdData = await created.json();
  const link = createdData.links.find((item) => item.title === 'Ready Later');
  const engine = app.stores.searchEngines.get()[0];
  app.stores.links.updateIconState(link.id, {
    iconStatus: 'ready',
    iconFileName: `links-${link.id}.svg`
  });
  app.stores.searchEngines.updateIconState(engine.id, {
    iconStatus: 'ready',
    iconFileName: `search-engines-${engine.id}.svg`
  });

  const unscoped = await app.request('/api/icons/pending');
  const unscopedData = await unscoped.json();
  assert.equal(unscopedData.icons.some((icon) => icon.entityType === 'links' && icon.id === link.id), false);
  assert.equal(unscopedData.icons.some((icon) => icon.entityType === 'search-engines' && icon.id === engine.id), false);

  const targeted = await app.request(`/api/icons/pending?links=${link.id}&searchEngines=${engine.id}`);
  const targetedData = await targeted.json();
  const linkIcon = targetedData.icons.find((icon) => icon.entityType === 'links' && icon.id === link.id);
  const engineIcon = targetedData.icons.find((icon) => icon.entityType === 'search-engines' && icon.id === engine.id);
  assert.equal(linkIcon.status, 'ready');
  assert.match(linkIcon.fileUrl, new RegExp(`/icon-cache/links-${link.id}\\.svg`));
  assert.equal(engineIcon.status, 'ready');
  assert.match(engineIcon.fileUrl, new RegExp(`/icon-cache/search-engines-${engine.id}\\.svg`));
});

test('public assets skip the session store and use content hashes', async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.login();
  const readsAfterLogin = app.sessionReads.length;

  const page = await app.request('/');
  const html = await page.text();
  const styleUrl = html.match(/href="(\/style\.css\?v=[a-f0-9]{12})"/)[1];
  const scriptUrl = html.match(/src="(\/js\/main\.js\?v=[a-f0-9]{12})"/)[1];
  const adminUrl = html.match(/data-admin="(\/js\/admin\.js\?v=[a-f0-9]{12})"/)[1];
  const readsAfterPage = app.sessionReads.length;
  assert.ok(readsAfterPage > readsAfterLogin);

  const style = await app.request(styleUrl);
  const script = await app.request(scriptUrl);
  const admin = await app.request(adminUrl);
  const favicon = await app.request('/favicon.svg');
  const blockedIcon = await app.request('/icon-cache/not-an-icon.json');
  assert.equal(app.sessionReads.length, readsAfterPage);
  assert.equal(style.status, 200);
  assert.match(style.headers.get('cache-control') || '', /immutable/);
  assert.match(script.headers.get('content-type') || '', /javascript/);
  const mainHash = scriptUrl.match(/v=([a-f0-9]{12})/)[1];
  assert.match(await script.text(), /from '\.\/search\.js\?v=[a-f0-9]{12}'/);
  assert.match(await admin.text(), new RegExp(`from '\\./main\\.js\\?v=${mainHash}'`));
  assert.equal(favicon.status, 200);
  assert.equal(blockedIcon.status, 404);

  const stale = await app.request('/style.css?v=not-the-hash');
  assert.match(stale.headers.get('cache-control') || '', /no-cache/);

  const login = await fetch(`${app.baseUrl}/login`);
  assert.equal(login.status, 200);
  assert.match(login.headers.get('cache-control') || '', /private, no-store/);
  const loginHtml = await login.text();
  assert.match(loginHtml, /\/login\.js\?v=[a-f0-9]{12}/);
  assert.doesNotMatch(loginHtml, /__ASSET_/);

  const loginWhenAuthenticated = await rawGet(`${app.baseUrl}/login`, { cookie: app.cookie() });
  assert.equal(loginWhenAuthenticated.status, 302);
  assert.equal(loginWhenAuthenticated.headers.location, '/');

  const raw = await rawGet(`${app.baseUrl}${styleUrl}`, {
    'accept-encoding': 'gzip',
    cookie: app.cookie()
  });
  assert.equal(raw.headers['content-encoding'], 'gzip');
  const css = zlib.gunzipSync(raw.body).toString('utf8');
  assert.match(css, /search-container/);
});

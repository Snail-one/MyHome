const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const { createApp } = require('../../src/server/app');
const { loadConfig } = require('../../src/server/config');
const { createDatabase } = require('../../src/server/db');

function makeConfig(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-api-'));
  const repoRoot = path.resolve(__dirname, '../..');
  return {
    tmpDir,
    config: loadConfig({
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'correct-password',
      SESSION_SECRET: 'session-secret-for-tests',
      DATA_DIR: path.join(tmpDir, 'data'),
      UPLOADS_DIR: path.join(tmpDir, 'uploads'),
      PUBLIC_DIR: path.join(repoRoot, 'public'),
      DATABASE_PATH: path.join(tmpDir, 'app.sqlite'),
      BCRYPT_ROUNDS: '4',
      LOGIN_MAX_FAILED_ATTEMPTS: '2',
      LOGIN_WINDOW_MS: '60000',
      LOGIN_LOCKOUT_MS: '60000',
      ...overrides
    }, { rootDir: repoRoot })
  };
}

async function startApp(overrides) {
  const { config } = makeConfig(overrides);
  const database = createDatabase(config);
  const app = createApp({
    config,
    db: database.db,
    stores: database.stores
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function request(route, options = {}) {
    const headers = {
      ...(options.headers || {})
    };
    if (cookie) headers.cookie = cookie;
    let body = options.body;
    if (
      body &&
      !(body instanceof FormData) &&
      typeof body !== 'string' &&
      !Buffer.isBuffer(body)
    ) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }

    const response = await fetch(`${baseUrl}${route}`, {
      ...options,
      headers,
      body
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  }

  async function requestJson(route, options = {}) {
    const response = await request(route, options);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : null;
    return { response, data };
  }

  async function login(password = 'correct-password') {
    return requestJson('/api/login', {
      method: 'POST',
      body: { username: 'admin', password }
    });
  }

  async function close() {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    app.locals.sessionStore.close();
    database.close();
  }

  return { baseUrl, close, login, request, requestJson };
}

test('protected APIs require login and authenticated user can manage settings, links, and engines', async (t) => {
  const app = await startApp();
  t.after(app.close);

  let page = await app.request('/login');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /个人导航登录/);

  let result = await app.requestJson('/api/settings');
  assert.equal(result.response.status, 401);

  result = await app.login();
  assert.equal(result.response.status, 200);
  assert.equal(result.data.user.username, 'admin');

  page = await app.request('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /search-engine-switcher/);

  result = await app.requestJson('/api/settings');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.settings.bookmarkLinkDisplayMode, 'centered');

  result = await app.requestJson('/api/links');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.emailLinks[0].iconMode, 'none');
  const defaultEmailLink = result.data.emailLinks[0];
  result = await app.requestJson(`/api/icons/links/${defaultEmailLink.id}/resolve`, { method: 'POST' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.status, 'none');

  result = await app.requestJson('/api/settings', {
    method: 'PUT',
    body: { layoutColumns: 2, editMode: true }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.settings.layoutColumns, 2);
  assert.equal(result.data.settings.editMode, true);

  result = await app.requestJson('/api/links', {
    method: 'POST',
    body: { title: 'Project', url: 'https://example.com', type: 'project' }
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.projectLinks[0].title, 'Project');
  assert.equal(result.data.projectLinks[0].iconMode, 'server');
  assert.equal(result.data.projectLinks[0].iconVersion, 1);

  result = await app.requestJson('/api/links', {
    method: 'POST',
    body: {
      title: 'Bilibili',
      url: 'https://www.bilibili.com',
      iconMode: 'none'
    }
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.links[0].iconMode, 'none');

  result = await app.requestJson('/api/links', {
    method: 'POST',
    body: {
      title: 'Legacy Upload',
      url: 'https://upload-mode.example.com',
      iconMode: 'upload'
    }
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.links.find((link) => link.title === 'Legacy Upload').iconMode, 'server');

  result = await app.requestJson('/api/links', {
    method: 'POST',
    body: {
      title: 'Mail',
      url: 'https://mail.example.com',
      type: 'email',
      iconMode: 'server'
    }
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.emailLinks.find((link) => link.title === 'Mail').iconMode, 'none');

  result = await app.requestJson('/api/search-engines', {
    method: 'POST',
    body: { name: 'Docs', urlTemplate: 'https://example.com/search?q={query}' }
  });
  assert.equal(result.response.status, 201);
  const docsEngine = result.data.engines.find((engine) => engine.name === 'Docs');
  assert.ok(docsEngine);
  assert.equal(docsEngine.iconVersion, 1);
});

test('failed login lockout returns 429 and Retry-After', async (t) => {
  const app = await startApp();
  t.after(app.close);

  let result = await app.login('wrong');
  assert.equal(result.response.status, 401);

  result = await app.login('wrong');
  assert.equal(result.response.status, 429);
  assert.ok(result.response.headers.get('retry-after'));
});

test('background upload rejects forged image data', async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.login();

  const formData = new FormData();
  formData.append('background', new Blob([Buffer.from('not an image')], { type: 'image/png' }), 'fake.png');

  const response = await app.request('/api/background', {
    method: 'POST',
    body: formData
  });
  assert.equal(response.status, 400);
});

test('server icon resolve allows private targets for configured links', async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.login();

  let result = await app.requestJson('/api/links', {
    method: 'POST',
    body: {
      title: 'Local App',
      url: app.baseUrl,
      iconMode: 'server'
    }
  });
  assert.equal(result.response.status, 201);

  const link = result.data.links.find((item) => item.title === 'Local App');
  result = await app.requestJson(`/api/icons/links/${link.id}/resolve`, { method: 'POST' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.status, 'ready');

  const response = await app.request(`/api/icons/links/${link.id}/file?v=${link.iconVersion}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /image\/svg\+xml/);
});

test('link icon upload route is not exposed', async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.login();

  let result = await app.requestJson('/api/links', {
    method: 'POST',
    body: { title: 'Private', url: 'https://example.com' }
  });
  assert.equal(result.response.status, 201);
  const link = result.data.links.find((item) => item.title === 'Private');

  const response = await app.request(`/api/icons/links/${link.id}/upload`, { method: 'POST' });
  assert.equal(response.status, 404);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const bcrypt = require('bcryptjs');

const { createApp, createForwardedHeaderSanitizer } = require('../../src/server/app');
const { loadConfig } = require('../../src/server/config');
const { createDatabase } = require('../../src/server/db');
const { seedDatabase } = require('../../src/server/db/seed');

function makeConfig(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-api-'));
  const repoRoot = path.resolve(__dirname, '../..');
  return {
    tmpDir,
    config: loadConfig({
      SESSION_SECRET: 'session-secret-for-tests',
      DATA_DIR: path.join(tmpDir, 'data'),
      UPLOADS_DIR: path.join(tmpDir, 'uploads'),
      PUBLIC_DIR: path.join(repoRoot, 'public'),
      DATABASE_PATH: path.join(tmpDir, 'app.sqlite'),
      ICON_PREFETCH_ON_READ: 'false',
      BCRYPT_ROUNDS: '4',
      LOGIN_MAX_FAILED_ATTEMPTS: '2',
      LOGIN_WINDOW_MS: '60000',
      LOGIN_LOCKOUT_MS: '60000',
      ...overrides
    }, { rootDir: repoRoot })
  };
}

async function startApp(overrides, options = {}) {
  const { seedAdmin = true } = options;
  const { config } = makeConfig(overrides);
  const database = createDatabase(config, { skipSeed: true });
  if (seedAdmin) {
    database.stores.users.insertAdmin(
      'admin',
      bcrypt.hashSync('correct-password', config.bcryptRounds)
    );
    seedDatabase(database.stores);
  }
  const app = createApp({
    config,
    db: database.db,
    iconEventHub: options.iconEventHub,
    iconService: options.iconService,
    stores: database.stores
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrfToken = '';

  function updateCookie(response) {
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      cookie = setCookie.split(';')[0];
      csrfToken = '';
    }
  }

  async function getCsrfToken() {
    if (csrfToken) return csrfToken;

    const headers = {};
    if (cookie) headers.cookie = cookie;
    const response = await fetch(`${baseUrl}/api/csrf`, { headers });
    updateCookie(response);
    const data = await response.json();
    csrfToken = data.csrfToken;
    return csrfToken;
  }

  async function request(route, options = {}) {
    const { csrf = true, ...requestOptions } = options;
    const headers = {
      ...(requestOptions.headers || {})
    };
    let body = requestOptions.body;
    if (
      body &&
      !(body instanceof FormData) &&
      typeof body !== 'string' &&
      !Buffer.isBuffer(body)
    ) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }

    const method = String(requestOptions.method || 'GET').toUpperCase();
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers['x-csrf-token'] = await getCsrfToken();
    }
    if (cookie) headers.cookie = cookie;

    const response = await fetch(`${baseUrl}${route}`, {
      ...requestOptions,
      headers,
      body
    });
    updateCookie(response);
    return response;
  }

  async function requestJson(route, options = {}) {
    const response = await request(route, options);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : null;
    return { response, data };
  }

  async function login(password = 'correct-password', username = 'admin') {
    return requestJson('/api/login', {
      method: 'POST',
      body: { username, password }
    });
  }

  async function close() {
    app.locals.iconEventHub?.close?.();
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    app.locals.sessionStore.close();
    database.close();
  }

  return {
    baseUrl,
    close,
    database,
    iconEventHub: app.locals.iconEventHub,
    login,
    request,
    requestJson,
    sessionStore: app.locals.sessionStore
  };
}

function createApiClient(baseUrl) {
  let cookie = '';
  let csrfToken = '';

  function updateCookie(response) {
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    const sessionCookie = cookies.find((value) => value.startsWith('my_home_sid='));
    if (!sessionCookie) return;
    cookie = sessionCookie.split(';')[0];
    csrfToken = '';
  }

  async function getCsrfToken() {
    if (csrfToken) return csrfToken;
    const headers = {};
    if (cookie) headers.cookie = cookie;
    const response = await fetch(`${baseUrl}/api/csrf`, { headers });
    updateCookie(response);
    csrfToken = (await response.json()).csrfToken;
    return csrfToken;
  }

  async function request(route, options = {}) {
    const { csrf = true, ...requestOptions } = options;
    const headers = { ...(requestOptions.headers || {}) };
    let body = requestOptions.body;
    if (
      body &&
      typeof body !== 'string' &&
      !(body instanceof FormData) &&
      !Buffer.isBuffer(body)
    ) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }

    const method = String(requestOptions.method || 'GET').toUpperCase();
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers['x-csrf-token'] = await getCsrfToken();
    }
    if (cookie) headers.cookie = cookie;

    const response = await fetch(`${baseUrl}${route}`, {
      ...requestOptions,
      headers,
      body
    });
    updateCookie(response);
    return response;
  }

  async function requestJson(route, options = {}) {
    const response = await request(route, options);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : null;
    return { response, data };
  }

  return {
    cookie: () => cookie,
    login(password = 'correct-password', username = 'admin') {
      return requestJson('/api/login', {
        method: 'POST',
        body: { username, password }
      });
    },
    requestJson
  };
}

async function readSettings(baseUrl, cookie) {
  const response = await fetch(`${baseUrl}/api/settings`, {
    headers: { cookie }
  });
  return response.status;
}

async function changeSettings(baseUrl, cookie) {
  const csrfResponse = await fetch(`${baseUrl}/api/csrf`, {
    headers: { cookie }
  });
  const token = (await csrfResponse.json()).csrfToken;
  const cookies = typeof csrfResponse.headers.getSetCookie === 'function'
    ? csrfResponse.headers.getSetCookie()
    : [];
  const sessionCookie = cookies.find((value) => value.startsWith('my_home_sid='));
  const nextCookie = sessionCookie ? sessionCookie.split(';')[0] : cookie;
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: {
      cookie: nextCookie,
      'content-type': 'application/json',
      'x-csrf-token': token
    },
    body: JSON.stringify({ editMode: true })
  });
  return response.status;
}

test('first deployment registration creates hashed admin and authenticated defaults', async (t) => {
  const app = await startApp(undefined, { seedAdmin: false });
  t.after(app.close);

  let result = await app.requestJson('/api/me');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.authenticated, false);
  assert.equal(result.data.setupRequired, true);

  result = await app.requestJson('/api/settings');
  assert.equal(result.response.status, 401);

  result = await app.requestJson('/api/setup/register', {
    method: 'POST',
    body: { username: 'owner', password: 'setup-password' }
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.user.username, 'owner');

  const user = app.database.stores.users.findAdmin();
  assert.equal(user.username, 'owner');
  assert.notEqual(user.password_hash, 'setup-password');
  assert.match(user.password_hash, /^\$2[aby]\$/);
  assert.equal(bcrypt.compareSync('setup-password', user.password_hash), true);

  result = await app.requestJson('/api/me');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.authenticated, true);
  assert.equal(result.data.user.username, 'owner');

  result = await app.requestJson('/api/settings');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.settings.bookmarkLinkDisplayMode, 'centered');

  result = await app.requestJson('/api/setup/register', {
    method: 'POST',
    body: { username: 'other', password: 'another-password' }
  });
  assert.equal(result.response.status, 409);
});

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
  assert.equal(result.data.emailLinks[0].iconStatus, 'none');
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

test('csrf protection requires tokens and rejects cross-origin unsafe requests', async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.login();

  let result = await app.requestJson('/api/links', {
    method: 'POST',
    body: { title: 'Delete Me', url: 'https://delete.example.com' }
  });
  assert.equal(result.response.status, 201);
  const link = result.data.links.find((item) => item.title === 'Delete Me');
  assert.ok(link);

  result = await app.requestJson('/api/logout', { method: 'POST', csrf: false });
  assert.equal(result.response.status, 403);

  result = await app.requestJson('/api/icons/refresh', { method: 'POST', csrf: false });
  assert.equal(result.response.status, 403);

  result = await app.requestJson(`/api/links/${link.id}`, { method: 'DELETE', csrf: false });
  assert.equal(result.response.status, 403);

  const formData = new FormData();
  formData.append('background', new Blob([Buffer.from('not an image')], { type: 'image/png' }), 'fake.png');
  const backgroundResponse = await app.request('/api/background', {
    method: 'POST',
    body: formData,
    csrf: false
  });
  assert.equal(backgroundResponse.status, 403);

  result = await app.requestJson('/api/icons/refresh', {
    method: 'POST',
    headers: { Origin: 'https://evil.example.com' }
  });
  assert.equal(result.response.status, 403);
});

test('SSE requires authentication, enforces origin and connection limits, and closes on logout', async (t) => {
  const app = await startApp({
    ICON_SSE_MAX_CONNECTIONS: '2',
    ICON_SSE_MAX_CONNECTIONS_PER_SESSION: '1'
  });
  t.after(app.close);

  let response = await app.request('/api/icons/events');
  assert.equal(response.status, 401);

  await app.login();
  response = await app.request('/api/icons/events', {
    headers: {
      Origin: 'https://evil.example.com',
      'Sec-Fetch-Site': 'cross-site'
    }
  });
  assert.equal(response.status, 403);

  const stream = await app.request('/api/icons/events', {
    headers: {
      Origin: app.baseUrl,
      'Sec-Fetch-Site': 'same-origin'
    }
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') || '', /^text\/event-stream/);
  assert.match(stream.headers.get('cache-control') || '', /no-store/);
  assert.equal(app.iconEventHub.getConnectionCount(), 1);

  const limited = await app.request('/api/icons/events', {
    headers: {
      Origin: app.baseUrl,
      'Sec-Fetch-Site': 'same-origin'
    }
  });
  assert.equal(limited.status, 429);

  const logout = await app.requestJson('/api/logout', { method: 'POST' });
  assert.equal(logout.response.status, 200);
  assert.equal(app.iconEventHub.getConnectionCount(), 0);
  await stream.body.cancel().catch(() => {});
});

test('authenticated user can update username and password hash', async (t) => {
  const app = await startApp();
  t.after(app.close);

  await app.login();

  let result = await app.requestJson('/api/account', {
    method: 'PUT',
    body: {
      username: 'owner',
      currentPassword: 'wrong-password',
      newPassword: 'new-correct-password'
    }
  });
  assert.equal(result.response.status, 401);

  result = await app.requestJson('/api/account', {
    method: 'PUT',
    body: {
      username: 'owner',
      currentPassword: 'correct-password',
      newPassword: 'new-correct-password'
    }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.user.username, 'owner');

  const user = app.database.stores.users.findAdmin();
  assert.equal(user.username, 'owner');
  assert.notEqual(user.password_hash, 'new-correct-password');
  assert.equal(bcrypt.compareSync('new-correct-password', user.password_hash), true);

  result = await app.requestJson('/api/logout', { method: 'POST' });
  assert.equal(result.response.status, 200);

  result = await app.login('correct-password');
  assert.equal(result.response.status, 401);

  result = await app.login('new-correct-password', 'owner');
  assert.equal(result.response.status, 200);
});

test('password change revokes other sessions and rotates the current session', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const current = createApiClient(app.baseUrl);
  const other = createApiClient(app.baseUrl);

  assert.equal((await current.login()).response.status, 200);
  assert.equal((await other.login()).response.status, 200);
  const previousCookie = current.cookie();

  const updated = await current.requestJson('/api/account', {
    method: 'PUT',
    body: {
      username: 'admin',
      currentPassword: 'correct-password',
      newPassword: 'rotated-password'
    }
  });
  assert.equal(updated.response.status, 200);
  assert.notEqual(current.cookie(), previousCookie);

  assert.equal(await readSettings(app.baseUrl, previousCookie), 401);
  assert.equal(await changeSettings(app.baseUrl, previousCookie), 401);
  assert.equal(await readSettings(app.baseUrl, other.cookie()), 401);
  assert.equal(await changeSettings(app.baseUrl, other.cookie()), 401);
  assert.equal(await readSettings(app.baseUrl, current.cookie()), 200);
  assert.equal(await changeSettings(app.baseUrl, current.cookie()), 200);
});

test('a request that already loaded a session cannot restore it after a password change', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const current = createApiClient(app.baseUrl);
  const other = createApiClient(app.baseUrl);
  assert.equal((await current.login()).response.status, 200);
  assert.equal((await other.login()).response.status, 200);
  const previousCookie = current.cookie();

  const store = app.sessionStore;
  const originalGet = store.get.bind(store);
  let releaseGet = null;
  let captured = null;
  store.get = function pauseFirstAuthenticatedGet(sessionId, callback) {
    originalGet(sessionId, (error, session) => {
      if (!releaseGet && session?.userId) {
        captured = { sessionId, session: { ...session } };
        releaseGet = () => callback(error, session);
        return;
      }
      callback(error, session);
    });
  };
  t.after(() => {
    store.get = originalGet;
  });

  const inflight = fetch(`${app.baseUrl}/api/csrf`, {
    headers: { cookie: previousCookie }
  });
  const startedAt = Date.now();
  while (!releaseGet) {
    if (Date.now() - startedAt > 1000) throw new Error('session load was not observed');
    await new Promise((resolve) => setImmediate(resolve));
  }

  const updated = await other.requestJson('/api/account', {
    method: 'PUT',
    body: {
      username: 'admin',
      currentPassword: 'correct-password',
      newPassword: 'rotated-password'
    }
  });
  assert.equal(updated.response.status, 200);

  releaseGet();
  store.get = originalGet;
  const inflightResponse = await inflight;
  await inflightResponse.json();

  await new Promise((resolve, reject) => {
    store.set(captured.sessionId, captured.session, (error) => (error ? reject(error) : resolve()));
  });
  await new Promise((resolve, reject) => {
    store.get(captured.sessionId, (error, session) => (error ? reject(error) : resolve(session)));
  }).then((session) => {
    assert.equal(session, undefined);
  });

  assert.equal(await readSettings(app.baseUrl, previousCookie), 401);
  assert.equal(await readSettings(app.baseUrl, other.cookie()), 200);
});

test('username change keeps the current session', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const current = createApiClient(app.baseUrl);
  assert.equal((await current.login()).response.status, 200);
  const cookie = current.cookie();

  const updated = await current.requestJson('/api/account', {
    method: 'PUT',
    body: {
      username: 'owner',
      currentPassword: 'correct-password'
    }
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.data.user.username, 'owner');
  assert.equal(await readSettings(app.baseUrl, cookie), 200);
  assert.equal(await changeSettings(app.baseUrl, cookie), 200);
});

test('account password attempts lock independently of login attempts', async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.login();

  let result = await app.requestJson('/api/account', {
    method: 'PUT',
    body: {
      username: 'admin',
      currentPassword: 'wrong-password'
    }
  });
  assert.equal(result.response.status, 401);

  result = await app.requestJson('/api/account', {
    method: 'PUT',
    body: {
      username: 'admin',
      currentPassword: 'wrong-password'
    }
  });
  assert.equal(result.response.status, 429);
  assert.ok(result.response.headers.get('retry-after'));
  assert.match(result.data.error, /当前密码尝试次数过多/);

  result = await app.requestJson('/api/account', {
    method: 'PUT',
    body: {
      username: 'admin',
      currentPassword: 'correct-password',
      newPassword: 'another-password'
    }
  });
  assert.equal(result.response.status, 429);

  result = await app.login();
  assert.equal(result.response.status, 200);
});

test('account and registration reject passwords beyond the bcrypt byte limit', async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.login();

  const overlong = `${'a'.repeat(70)}密码`;
  assert.ok(Buffer.byteLength(overlong) > 72);
  let result = await app.requestJson('/api/account', {
    method: 'PUT',
    body: {
      username: 'admin',
      currentPassword: 'correct-password',
      newPassword: overlong
    }
  });
  assert.equal(result.response.status, 400);
  assert.match(result.data.error, /72/);
  assert.equal(bcrypt.compareSync('correct-password', app.database.stores.users.findAdmin().password_hash), true);

  const limit = 'b'.repeat(72);
  result = await app.requestJson('/api/account', {
    method: 'PUT',
    body: {
      username: 'admin',
      currentPassword: 'correct-password',
      newPassword: limit
    }
  });
  assert.equal(result.response.status, 200);
  assert.equal(bcrypt.compareSync(limit, app.database.stores.users.findAdmin().password_hash), true);
});

test('login still matches a legacy hash that bcrypt truncated', async (t) => {
  const app = await startApp(undefined, { seedAdmin: false });
  t.after(app.close);
  const prefix = 'c'.repeat(72);
  app.database.stores.users.insertAdmin('admin', bcrypt.hashSync(`${prefix}legacy`, 4));

  const result = await app.login(`${prefix}other`);
  assert.equal(result.response.status, 200);
});

test('registration rejects a password beyond the bcrypt byte limit', async (t) => {
  const app = await startApp(undefined, { seedAdmin: false });
  t.after(app.close);

  const result = await app.requestJson('/api/setup/register', {
    method: 'POST',
    body: { username: 'owner', password: 'a'.repeat(73) }
  });
  assert.equal(result.response.status, 400);
  assert.match(result.data.error, /72/);
  assert.equal(app.database.stores.users.findAdmin(), undefined);
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

test('login limiter ignores a client-supplied X-Forwarded-For prefix', async (t) => {
  const direct = await startApp();
  t.after(direct.close);
  let result = await direct.requestJson('/api/login', {
    method: 'POST',
    headers: { 'x-forwarded-for': '1.1.1.1' },
    body: { username: 'admin', password: 'wrong' }
  });
  assert.equal(result.response.status, 401);
  result = await direct.requestJson('/api/login', {
    method: 'POST',
    headers: { 'x-forwarded-for': '8.8.8.8' },
    body: { username: 'admin', password: 'wrong' }
  });
  assert.equal(result.response.status, 429);

  const proxied = await startApp({ TRUST_PROXY: 'true' });
  t.after(proxied.close);
  result = await proxied.requestJson('/api/login', {
    method: 'POST',
    headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.10' },
    body: { username: 'admin', password: 'wrong' }
  });
  assert.equal(result.response.status, 401);
  result = await proxied.requestJson('/api/login', {
    method: 'POST',
    headers: { 'x-forwarded-for': '8.8.8.8, 203.0.113.10' },
    body: { username: 'admin', password: 'wrong' }
  });
  assert.equal(result.response.status, 429);
  assert.ok(result.response.headers.get('retry-after'));
});

test('forwarded header sanitizer keeps only the trusted proxy hops', () => {
  const blocked = {
    headers: {
      forwarded: 'for=1.1.1.1',
      'x-forwarded-for': '1.1.1.1',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-port': '443',
      'x-forwarded-proto': 'https'
    }
  };
  createForwardedHeaderSanitizer(false)(blocked, {}, () => {});
  assert.equal(blocked.headers.forwarded, undefined);
  assert.equal(blocked.headers['x-forwarded-for'], undefined);
  assert.equal(blocked.headers['x-forwarded-host'], undefined);
  assert.equal(blocked.headers['x-forwarded-proto'], undefined);

  const trusted = {
    headers: {
      'x-forwarded-for': '8.8.8.8, 203.0.113.10',
      'x-forwarded-proto': 'https'
    }
  };
  createForwardedHeaderSanitizer(1)(trusted, {}, () => {});
  assert.equal(trusted.headers['x-forwarded-for'], '203.0.113.10');
  assert.equal(trusted.headers['x-forwarded-proto'], 'https');
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

test('icon refresh returns 202 and reuses a running background task', async (t) => {
  let releaseTasks;
  const taskGate = new Promise((resolve) => {
    releaseTasks = resolve;
  });
  let clearCount = 0;
  let taskRuns = 0;
  const iconService = {
    clearIconCache: async () => {
      clearCount += 1;
    },
    resolveLinkIcon: async () => {
      taskRuns += 1;
      await taskGate;
      return { status: 'ready' };
    },
    resolveSearchEngineIcon: async () => {
      taskRuns += 1;
      await taskGate;
      return { status: 'ready' };
    }
  };

  const app = await startApp(undefined, { iconService });
  t.after(app.close);
  await app.login();

  let result = await app.requestJson('/api/icons/refresh', { method: 'POST' });
  assert.equal(result.response.status, 202);
  assert.equal(result.data.refreshStatus.state, 'running');
  assert.ok(result.data.refreshStatus.total > 0);
  assert.equal(clearCount, 1);

  result = await app.requestJson('/api/icons/refresh', { method: 'POST' });
  assert.equal(result.response.status, 202);
  assert.equal(result.data.refreshStatus.state, 'running');
  assert.equal(clearCount, 1);

  result = await app.requestJson('/api/icons/refresh/status');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.state, 'running');

  releaseTasks();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    result = await app.requestJson('/api/icons/refresh/status');
    if (result.data.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(result.data.state, 'completed');
  assert.equal(result.data.completed, result.data.total);
  assert.equal(result.data.failed, 0);
  assert.equal(taskRuns, result.data.total);
});

test('icon refresh status reports failed background tasks', async (t) => {
  const iconService = {
    clearIconCache: async () => {},
    resolveLinkIcon: async () => {
      throw new Error('link failed');
    },
    resolveSearchEngineIcon: async () => {
      throw new Error('engine failed');
    }
  };

  const app = await startApp(undefined, { iconService });
  t.after(app.close);
  await app.login();

  let result = await app.requestJson('/api/icons/refresh', { method: 'POST' });
  assert.equal(result.response.status, 202);
  assert.equal(result.data.refreshStatus.state, 'running');

  for (let attempt = 0; attempt < 50; attempt += 1) {
    result = await app.requestJson('/api/icons/refresh/status');
    if (result.data.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(result.data.state, 'failed');
  assert.ok(result.data.failed > 0);
  assert.equal(result.data.completed + result.data.failed, result.data.total);
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
  assert.ok([200, 202].includes(result.response.status));

  let status = result.data;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (status?.status === 'ready' || status?.status === 'miss') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = await app.requestJson(`/api/icons/links/${link.id}/status`);
    status = result.data;
  }

  assert.equal(status.status, 'ready');
  assert.match(status.fileUrl || '', /\/icon-cache\/links-\d+\.svg/);

  const response = await app.request(`/api/icons/links/${link.id}/file?v=${link.iconVersion}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /image\/svg\+xml/);

  const publicResponse = await fetch(`${app.baseUrl}${status.fileUrl}`);
  assert.equal(publicResponse.status, 200);
  assert.match(publicResponse.headers.get('content-type') || '', /image\/svg\+xml/);

  const blockedJson = await fetch(`${app.baseUrl}/icon-cache/links-${link.id}.json`);
  assert.equal(blockedJson.status, 404);
});

test('icon resolve returns 202 while a background fetch is running', async (t) => {
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const iconService = {
    decorateLinksResponse: async (payload) => ({
      ...payload,
      links: (payload.links || []).map((link) => ({ ...link, iconStatus: 'empty' })),
      emailLinks: (payload.emailLinks || []).map((link) => ({ ...link, iconStatus: 'none' })),
      projectLinks: (payload.projectLinks || []).map((link) => ({ ...link, iconStatus: 'empty' }))
    }),
    decorateSearchEngines: async (engines) => (engines || []).map((engine) => ({
      ...engine,
      iconStatus: 'empty'
    })),
    prefetchLinksResponse() {},
    prefetchSearchEngines() {},
    deleteEntityIcon: async () => {},
    clearIconCache: async () => {},
    findCachedEntityIcon: async () => null,
    getEntityIconStatus: async (_type, entity) => ({
      status: 'pending',
      id: entity.id,
      iconVersion: entity.iconVersion || 1
    }),
    ensureLinkIcon: async (link) => {
      if (link.linkType === 'email' || link.iconMode === 'none') {
        return { accepted: false, status: { status: 'none', id: link.id } };
      }
      return { accepted: true, status: { status: 'pending', id: link.id } };
    },
    resolveLinkIcon: async () => {
      await fetchGate;
      return { status: 'ready' };
    },
    resolveSearchEngineIcon: async () => ({ status: 'ready' })
  };

  const app = await startApp(undefined, { iconService });
  t.after(() => {
    releaseFetch();
    return app.close();
  });
  await app.login();

  let result = await app.requestJson('/api/links', {
    method: 'POST',
    body: { title: 'Slow Icon', url: 'https://slow-icon.example.com' }
  });
  assert.equal(result.response.status, 201);
  const link = result.data.links.find((item) => item.title === 'Slow Icon');
  assert.ok(link);

  result = await app.requestJson(`/api/icons/links/${link.id}/resolve`, { method: 'POST' });
  assert.equal(result.response.status, 202);
  assert.equal(result.data.status, 'pending');
  releaseFetch();
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

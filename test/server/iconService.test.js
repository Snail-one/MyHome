const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../../src/server/config');
const {
  createIconService,
  extractIconLinksFromHtml,
  getConventionalIconCandidates
} = require('../../src/server/services/iconService');

function makeIconConfig() {
  const rootDir = path.resolve(__dirname, '../..');
  return loadConfig({
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'password',
    SESSION_SECRET: 'session-secret-for-tests',
    DATA_DIR: path.join(os.tmpdir(), 'my-home-icon-service-test-data'),
    UPLOADS_DIR: path.join(os.tmpdir(), 'my-home-icon-service-test-uploads'),
    PUBLIC_DIR: path.join(rootDir, 'public'),
    DATABASE_PATH: path.join(os.tmpdir(), 'my-home-icon-service-test.sqlite')
  }, { rootDir });
}

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

test('SPA URL conventional candidates prioritize subpath favicon', () => {
  const candidates = getConventionalIconCandidates(new URL('https://joker.dantapi.top/ui/'));

  assert.equal(candidates[0], 'https://joker.dantapi.top/ui/favicon.svg');
});

test('search engine target URLs strip hash and reject credentials', () => {
  const service = createIconService(makeIconConfig());

  assert.equal(
    service.getSearchEngineTargetUrl({
      urlTemplate: 'https://example.com/search?q={query}#/result'
    }),
    'https://example.com/search?q=test'
  );
  assert.equal(
    service.getSearchEngineTargetUrl({
      urlTemplate: 'https://user:pass@example.com/search?q={query}'
    }),
    null
  );
});

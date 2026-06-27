const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadConfig } = require('../../src/server/config');
const { createIconService } = require('../../src/server/services/iconService');

function makeIconConfig() {
  const rootDir = path.resolve(__dirname, '../..');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-icon-service-'));
  return loadConfig({
    SESSION_SECRET: 'session-secret-for-tests',
    DATA_DIR: path.join(tmpDir, 'data'),
    UPLOADS_DIR: path.join(tmpDir, 'uploads'),
    PUBLIC_DIR: path.join(rootDir, 'public'),
    DATABASE_PATH: path.join(tmpDir, 'app.sqlite')
  }, { rootDir });
}

function makeSvgIcon() {
  return {
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'),
    extension: '.svg',
    contentType: 'image/svg+xml'
  };
}

test('resolveLinkIcon writes ready metadata from icon fetcher result', async () => {
  const service = createIconService(makeIconConfig(), {
    iconFetcher: {
      normalizeIconTargetUrl: () => 'https://example.com/',
      resolveIconForUrl: async () => ({
        icon: makeSvgIcon(),
        sourceUrl: 'https://example.com/favicon.svg',
        targetUrl: 'https://example.com/'
      })
    }
  });
  const link = {
    id: 12,
    linkType: 'website',
    url: 'https://example.com/#/app',
    iconMode: 'server',
    iconVersion: 2
  };

  const status = await service.resolveLinkIcon(link);
  assert.equal(status.status, 'ready');
  assert.equal(status.source, 'server');
  assert.equal(status.sourceUrl, 'https://example.com/favicon.svg');
  assert.equal(status.iconVersion, 2);

  const cached = await service.findCachedEntityIcon('links', link.id, link.iconVersion);
  assert.equal(cached.contentType, 'image/svg+xml');
  assert.match(await fs.promises.readFile(cached.filePath, 'utf8'), /<svg/);
});

test('resolveLinkIcon records miss metadata when fetcher finds no icon', async () => {
  const service = createIconService(makeIconConfig(), {
    iconFetcher: {
      normalizeIconTargetUrl: () => 'https://example.com/',
      resolveIconForUrl: async () => ({
        icon: null,
        sourceUrl: '',
        targetUrl: 'https://example.com/'
      })
    }
  });
  const link = {
    id: 13,
    linkType: 'website',
    url: 'https://example.com',
    iconMode: 'server',
    iconVersion: 1
  };

  const status = await service.resolveLinkIcon(link);
  assert.equal(status.status, 'miss');
  assert.equal(status.source, 'server');
  assert.equal(await service.findCachedEntityIcon('links', link.id, link.iconVersion), null);
});

test('resolveLinkIcon reuses ready metadata without fetching remotely', async () => {
  const config = makeIconConfig();
  let fetchCalls = 0;
  const service = createIconService(config, {
    iconFetcher: {
      normalizeIconTargetUrl: () => 'https://example.com/',
      resolveIconForUrl: async () => {
        fetchCalls += 1;
        return {
          icon: makeSvgIcon(),
          sourceUrl: 'https://example.com/favicon.svg',
          targetUrl: 'https://example.com/'
        };
      }
    }
  });
  const link = {
    id: 30,
    linkType: 'website',
    url: 'https://example.com',
    iconMode: 'server',
    iconVersion: 4
  };

  await fs.promises.mkdir(config.iconCacheDir, { recursive: true });
  await fs.promises.writeFile(path.join(config.iconCacheDir, 'links-30.svg'), makeSvgIcon().buffer);
  await fs.promises.writeFile(path.join(config.iconCacheDir, 'links-30.json'), JSON.stringify({
    entityType: 'links',
    entityId: 30,
    version: 4,
    status: 'ready',
    source: 'server',
    sourceUrl: 'https://cached.example.com/favicon.svg',
    targetUrl: 'https://example.com/',
    fileName: 'links-30.svg',
    contentType: 'image/svg+xml'
  }));

  const status = await service.resolveLinkIcon(link);
  assert.equal(status.status, 'ready');
  assert.equal(status.sourceUrl, 'https://cached.example.com/favicon.svg');
  assert.equal(fetchCalls, 0);
});

test('resolveLinkIcon reuses miss metadata without fetching remotely', async () => {
  const config = makeIconConfig();
  let fetchCalls = 0;
  const service = createIconService(config, {
    iconFetcher: {
      normalizeIconTargetUrl: () => 'https://example.com/',
      resolveIconForUrl: async () => {
        fetchCalls += 1;
        return {
          icon: makeSvgIcon(),
          sourceUrl: 'https://example.com/favicon.svg',
          targetUrl: 'https://example.com/'
        };
      }
    }
  });
  const link = {
    id: 31,
    linkType: 'website',
    url: 'https://example.com',
    iconMode: 'server',
    iconVersion: 2
  };

  await fs.promises.mkdir(config.iconCacheDir, { recursive: true });
  await fs.promises.writeFile(path.join(config.iconCacheDir, 'links-31.json'), JSON.stringify({
    entityType: 'links',
    entityId: 31,
    version: 2,
    status: 'miss',
    source: 'server',
    targetUrl: 'https://example.com/'
  }));

  const status = await service.resolveLinkIcon(link);
  assert.equal(status.status, 'miss');
  assert.equal(fetchCalls, 0);
});

test('resolveSearchEngineIcon reuses cached metadata without fetching remotely', async () => {
  const config = makeIconConfig();
  let fetchCalls = 0;
  const service = createIconService(config, {
    iconFetcher: {
      resolveIconForUrl: async () => {
        fetchCalls += 1;
        return {
          icon: makeSvgIcon(),
          sourceUrl: 'https://example.com/favicon.svg',
          targetUrl: 'https://example.com/'
        };
      }
    }
  });
  const engine = {
    id: 32,
    urlTemplate: 'https://example.com/search?q={query}',
    iconVersion: 1
  };

  await fs.promises.mkdir(config.iconCacheDir, { recursive: true });
  await fs.promises.writeFile(path.join(config.iconCacheDir, 'search-engines-32.json'), JSON.stringify({
    entityType: 'search-engines',
    entityId: 32,
    version: 1,
    status: 'miss',
    source: 'server',
    targetUrl: 'https://example.com/'
  }));

  const status = await service.resolveSearchEngineIcon(engine);
  assert.equal(status.status, 'miss');
  assert.equal(fetchCalls, 0);
});

test('subdomain targets are preferred before falling back to root domain stripping', async () => {
  const resolvedTargets = [];
  const service = createIconService(makeIconConfig(), {
    iconFetcher: {
      resolveIconForUrl: async (targetUrl) => {
        resolvedTargets.push(targetUrl);
        return {
          icon: makeSvgIcon(),
          sourceUrl: `${targetUrl}favicon.svg`,
          targetUrl
        };
      }
    }
  });

  const firstLink = {
    id: 20,
    linkType: 'website',
    url: 'https://docs.example.com/docs',
    iconMode: 'server',
    iconVersion: 1
  };
  const secondLink = {
    id: 21,
    linkType: 'website',
    url: 'https://search.example.com/search?q=abc',
    iconMode: 'server',
    iconVersion: 1
  };
  const engine = {
    id: 22,
    urlTemplate: 'https://www.example.com/search?q={query}',
    iconVersion: 1
  };

  const statuses = await Promise.all([
    service.resolveLinkIcon(firstLink),
    service.resolveLinkIcon(secondLink),
    service.resolveSearchEngineIcon(engine)
  ]);

  assert.deepEqual(statuses.map((status) => status.status), ['ready', 'ready', 'ready']);
  assert.deepEqual(resolvedTargets, [
    'https://docs.example.com/',
    'https://search.example.com/',
    'https://www.example.com/'
  ]);

  const thirdStatus = await service.resolveLinkIcon({
    id: 23,
    linkType: 'website',
    url: 'https://cdn.example.com/another',
    iconMode: 'server',
    iconVersion: 1
  });
  assert.equal(thirdStatus.status, 'ready');
  assert.deepEqual(resolvedTargets, [
    'https://docs.example.com/',
    'https://search.example.com/',
    'https://www.example.com/',
    'https://cdn.example.com/'
  ]);
});

test('root domain miss falls back to www target', async () => {
  const resolvedTargets = [];
  const service = createIconService(makeIconConfig(), {
    iconFetcher: {
      resolveIconForUrl: async (targetUrl) => {
        resolvedTargets.push(targetUrl);
        if (targetUrl === 'https://example.com/' || targetUrl === 'https://app.example.com/' || targetUrl === 'https://www.example.com/') {
          return {
            icon: null,
            sourceUrl: '',
            targetUrl
          };
        }

        return {
          icon: makeSvgIcon(),
          sourceUrl: `${targetUrl}favicon.svg`,
          targetUrl
        };
      }
    }
  });

  const link = {
    id: 24,
    linkType: 'website',
    url: 'https://app.example.com/dashboard',
    iconMode: 'server',
    iconVersion: 1
  };

  const status = await service.resolveLinkIcon(link);
  assert.equal(status.status, 'ready');
  // 现在会继续尝试完整地址兜底
  assert.equal(status.sourceUrl, 'https://app.example.com/dashboardfavicon.svg');
  assert.deepEqual(resolvedTargets, [
    'https://app.example.com/',
    'https://example.com/',
    'https://www.example.com/',
    'https://app.example.com/dashboard'
  ]);

  const cached = await service.findCachedEntityIcon('links', link.id, link.iconVersion);
  assert.equal(cached.metadata.targetUrl, 'https://app.example.com/dashboard');
});

test('legacy upload and local icon modes read cache state without resolving', async () => {
  let resolved = false;
  const config = makeIconConfig();
  const service = createIconService(config, {
    iconFetcher: {
      normalizeIconTargetUrl: () => 'https://example.com/',
      resolveIconForUrl: async () => {
        resolved = true;
        return null;
      }
    }
  });
  await fs.promises.mkdir(config.iconCacheDir, { recursive: true });
  await fs.promises.writeFile(path.join(config.iconCacheDir, 'links-14.svg'), makeSvgIcon().buffer);
  await fs.promises.writeFile(path.join(config.iconCacheDir, 'links-14.json'), JSON.stringify({
    entityType: 'links',
    entityId: 14,
    version: 1,
    status: 'ready',
    source: 'upload',
    sourceUrl: 'legacy.svg',
    fileName: 'links-14.svg',
    contentType: 'image/svg+xml'
  }));

  const uploadStatus = await service.resolveLinkIcon({
    id: 14,
    linkType: 'website',
    url: 'https://example.com',
    iconMode: 'upload',
    iconVersion: 1
  });
  assert.equal(uploadStatus.status, 'ready');
  assert.equal(uploadStatus.source, 'upload');
  assert.equal((await service.resolveLinkIcon({
    id: 15,
    linkType: 'website',
    url: 'https://example.com',
    iconMode: 'local',
    iconVersion: 1
  })).status, 'empty');
  assert.equal(resolved, false);
});

test('search engine target URLs prefer original hostname and fall back to root domain stripping', () => {
  const service = createIconService(makeIconConfig());

  assert.equal(
    service.getSearchEngineTargetUrl({
      urlTemplate: 'https://www.google.com/search?q={query}#/result'
    }),
    'https://www.google.com/'
  );
  assert.equal(
    service.getSearchEngineTargetUrl({
      urlTemplate: 'https://search.bilibili.com/all?keyword={query}'
    }),
    'https://search.bilibili.com/'
  );
  assert.equal(
    service.getSearchEngineTargetUrl({
      urlTemplate: 'https://news.example.co.uk/search?q={query}'
    }),
    'https://news.example.co.uk/'
  );
  assert.equal(
    service.getSearchEngineTargetUrl({
      urlTemplate: 'http://127.0.0.1:3456/search?q={query}'
    }),
    'http://127.0.0.1:3456/'
  );
  assert.equal(
    service.getSearchEngineTargetUrl({
      urlTemplate: 'https://user:pass@example.com/search?q={query}'
    }),
    null
  );
});

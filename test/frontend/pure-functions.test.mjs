import assert from 'node:assert/strict';
import test from 'node:test';

import { getCachedFaviconUrl, getDomainFromUrl, getParsedHttpUrl } from '../../public/js/icons.js';
import { buildSearchUrl } from '../../public/js/search.js';
import { calculateMaxAvailableLayoutColumns, getLayoutColumnOptions, isValidBackgroundUrl } from '../../public/js/settings.js';

test('buildSearchUrl fills query placeholders or appends q parameter', () => {
  assert.equal(
    buildSearchUrl({ urlTemplate: 'https://example.com/search?q={query}' }, 'hello world'),
    'https://example.com/search?q=hello%20world'
  );
  assert.equal(
    buildSearchUrl({ urlTemplate: 'https://example.com/search' }, 'hello'),
    'https://example.com/search?q=hello'
  );
  assert.equal(
    buildSearchUrl({ urlTemplate: 'https://example.com/search?tab=all' }, 'hello'),
    'https://example.com/search?tab=all&q=hello'
  );
});

test('icon URL helpers normalize http URLs', () => {
  assert.equal(getParsedHttpUrl('example.com').href, 'https://example.com/');
  assert.equal(getParsedHttpUrl('ftp://example.com'), null);
  assert.equal(getDomainFromUrl('https://sub.example.com/path'), 'sub.example.com');
  assert.equal(
    getCachedFaviconUrl('example.com', { version: 123 }),
    '/api/icon?url=https%3A%2F%2Fexample.com%2F&v=123'
  );
});

test('layout helpers calculate available options', () => {
  assert.equal(calculateMaxAvailableLayoutColumns({
    availableWidth: 500,
    cardWidth: 120,
    gap: 16,
    linkCount: 10,
    configuredMax: 6
  }), 3);
  assert.equal(calculateMaxAvailableLayoutColumns({ isMobile: true, linkCount: 10 }), 1);
  assert.deepEqual(getLayoutColumnOptions(3), [0, 1, 2, 3]);
});

test('background URL validation matches browser-only loading policy', () => {
  assert.equal(isValidBackgroundUrl('https://example.com/bg.jpg'), true);
  assert.equal(isValidBackgroundUrl('/uploads/backgrounds/bg.jpg'), true);
  assert.equal(isValidBackgroundUrl('/uploads/backgrounds/../secret'), false);
  assert.equal(isValidBackgroundUrl('javascript:alert(1)'), false);
});

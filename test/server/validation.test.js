const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isBackgroundUrl,
  isValidSearchUrlTemplate,
  validateLinkPayload,
  validateSearchEnginePayload
} = require('../../src/server/services/validation');

test('validateLinkPayload normalizes link type and requires http URLs', () => {
  assert.deepEqual(validateLinkPayload({
    title: '  Example  ',
    url: 'https://example.com',
    type: 'project'
  }).value, {
    title: 'Example',
    url: 'https://example.com',
    linkType: 'project',
    iconMode: 'server'
  });

  assert.deepEqual(validateLinkPayload({
    title: 'Bilibili',
    url: 'https://www.bilibili.com',
    iconMode: 'none'
  }).value, {
    title: 'Bilibili',
    url: 'https://www.bilibili.com',
    linkType: 'website',
    iconMode: 'none'
  });

  assert.equal(validateLinkPayload({
    title: 'GitHub',
    url: 'https://github.com',
    iconMode: 'upload'
  }).value.iconMode, 'server');

  assert.equal(validateLinkPayload({
    title: 'Docs',
    url: 'https://example.com',
    iconMode: 'local'
  }).value.iconMode, 'server');

  assert.equal(validateLinkPayload({
    title: 'Mail',
    url: 'https://mail.example.com',
    type: 'email',
    iconMode: 'server'
  }).value.iconMode, 'server');

  assert.deepEqual(validateLinkPayload({
    title: 'Bad mode',
    url: 'https://example.com',
    iconMode: 'unknown'
  }).value, {
    title: 'Bad mode',
    url: 'https://example.com',
    linkType: 'website',
    iconMode: 'server'
  });

  assert.equal(validateLinkPayload({
    title: 'Bad',
    url: 'javascript:alert(1)'
  }).error, '链接地址必须是 http 或 https URL');
});

test('validateSearchEnginePayload accepts templates and rejects non-http protocols', () => {
  assert.equal(isValidSearchUrlTemplate('https://example.com/search?q={query}'), true);
  assert.equal(isValidSearchUrlTemplate('file:///tmp?q={query}'), false);
  assert.deepEqual(validateSearchEnginePayload({
    name: 'Docs',
    urlTemplate: 'https://example.com?q={query}'
  }).value, {
    name: 'Docs',
    urlTemplate: 'https://example.com?q={query}'
  });
});

test('isBackgroundUrl allows uploaded paths and browser-loaded http URLs only', () => {
  assert.equal(isBackgroundUrl(''), true);
  assert.equal(isBackgroundUrl('/uploads/backgrounds/a.png'), true);
  assert.equal(isBackgroundUrl('/uploads/backgrounds/../a.png'), false);
  assert.equal(isBackgroundUrl('https://example.com/bg.jpg'), true);
  assert.equal(isBackgroundUrl('ftp://example.com/bg.jpg'), false);
});

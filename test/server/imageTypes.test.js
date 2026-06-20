const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getBackgroundImageType,
  getIconExtension,
  getImageExtensionFromMagic,
  isSupportedIconBuffer
} = require('../../src/server/services/imageTypes');

test('detects image types from file headers', () => {
  assert.equal(getImageExtensionFromMagic(Buffer.from([0xff, 0xd8, 0xff, 0x00])), '.jpg');
  assert.equal(getImageExtensionFromMagic(Buffer.from('89504e470d0a1a0a', 'hex')), '.png');
  assert.equal(getImageExtensionFromMagic(Buffer.from('GIF89a')), '.gif');
  assert.equal(getImageExtensionFromMagic(Buffer.from('<svg viewBox="0 0 1 1"></svg>')), '.svg');
});

test('background uploads only allow browser image types by magic header', () => {
  assert.equal(getBackgroundImageType(Buffer.from([0xff, 0xd8, 0xff, 0x00])).extension, '.jpg');
  assert.equal(getBackgroundImageType(Buffer.from('<svg></svg>')), null);
  assert.equal(getBackgroundImageType(Buffer.from('not an image')), null);
});

test('icon uploads are not accepted solely because mimetype says image', () => {
  const fake = Buffer.from('not an image');
  assert.equal(isSupportedIconBuffer('image/png', 'https://example.com/icon.png', fake), false);
  assert.equal(getIconExtension('image/png', 'https://example.com/icon.png', fake), '.png');
});

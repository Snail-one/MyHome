const path = require('path');

const iconContentTypeByExtension = new Map([
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif']
]);

const iconExtensionByContentType = new Map([
  ['image/x-icon', '.ico'],
  ['image/vnd.microsoft.icon', '.ico'],
  ['image/png', '.png'],
  ['image/svg+xml', '.svg'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif']
]);

const backgroundContentTypeByExtension = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif']
]);

function normalizeContentType(contentType) {
  return (contentType || '').split(';')[0].trim().toLowerCase();
}

function startsWithBytes(buffer, bytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function getImageExtensionFromMagic(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return '';

  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) return '.jpg';
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return '.png';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return '.webp';
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
    return '.gif';
  }
  if (startsWithBytes(buffer, [0x00, 0x00, 0x01, 0x00])) return '.ico';

  const sample = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (sample.startsWith('<svg') || sample.startsWith('<?xml')) return '.svg';

  return '';
}

function getIconContentType(extension) {
  return iconContentTypeByExtension.get(extension) || 'image/x-icon';
}

function getIconExtensionFromUrl(candidateUrl) {
  try {
    const extension = path.extname(new URL(candidateUrl).pathname).toLowerCase();
    return iconContentTypeByExtension.has(extension) ? extension : '';
  } catch {
    return '';
  }
}

function getIconExtension(contentType, candidateUrl, buffer) {
  const extensionFromMagic = getImageExtensionFromMagic(buffer);
  if (extensionFromMagic && iconContentTypeByExtension.has(extensionFromMagic)) return extensionFromMagic;

  const extensionFromType = iconExtensionByContentType.get(normalizeContentType(contentType));
  if (extensionFromType) return extensionFromType;

  const extensionFromUrl = getIconExtensionFromUrl(candidateUrl);
  if (extensionFromUrl) return extensionFromUrl;

  return '.ico';
}

function isSupportedIconBuffer(contentType, candidateUrl, buffer) {
  const extensionFromMagic = getImageExtensionFromMagic(buffer);
  if (extensionFromMagic && iconContentTypeByExtension.has(extensionFromMagic)) return true;

  return false;
}

function getBackgroundImageType(buffer) {
  const extension = getImageExtensionFromMagic(buffer);
  if (!backgroundContentTypeByExtension.has(extension)) return null;
  return {
    extension: extension === '.jpeg' ? '.jpg' : extension,
    contentType: backgroundContentTypeByExtension.get(extension)
  };
}

module.exports = {
  backgroundContentTypeByExtension,
  getBackgroundImageType,
  getIconContentType,
  getIconExtension,
  getIconExtensionFromUrl,
  getImageExtensionFromMagic,
  iconContentTypeByExtension,
  iconExtensionByContentType,
  isSupportedIconBuffer,
  normalizeContentType
};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getBackgroundImageType } = require('./imageTypes');

function deleteLocalBackground(config, backgroundUrl) {
  if (!backgroundUrl || !backgroundUrl.startsWith('/uploads/backgrounds/')) return;

  const relativePath = backgroundUrl.replace(/^\/uploads\//, '');
  const fullPath = path.resolve(config.uploadsDir, relativePath);
  const backgroundsDir = path.resolve(config.backgroundsDir);
  if (!fullPath.startsWith(`${backgroundsDir}${path.sep}`)) return;

  fs.promises.unlink(fullPath).catch((error) => {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to delete old background:', error.message);
    }
  });
}

async function saveBackgroundUpload(config, file) {
  if (!file?.buffer?.length) {
    return { error: '请选择图片文件' };
  }

  const imageType = getBackgroundImageType(file.buffer);
  if (!imageType) {
    return { error: '只支持 JPG、PNG、WebP 或 GIF 图片' };
  }

  await fs.promises.mkdir(config.backgroundsDir, { recursive: true });
  const filename = `${crypto.randomUUID()}${imageType.extension}`;
  const fullPath = path.join(config.backgroundsDir, filename);
  await fs.promises.writeFile(fullPath, file.buffer, { flag: 'wx' });

  return {
    value: `/uploads/backgrounds/${filename}`
  };
}

module.exports = {
  deleteLocalBackground,
  saveBackgroundUpload
};

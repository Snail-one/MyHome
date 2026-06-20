const express = require('express');
const multer = require('multer');

const { assertPublicHttpUrl } = require('../services/httpSafety');

function sendCachedIcon(res, cachedIcon) {
  res.set('Cache-Control', 'private, no-cache');
  res.type(cachedIcon.contentType);
  res.sendFile(cachedIcon.filePath);
}

function createIconsRouter(deps) {
  const { auth, config, iconService } = deps;
  const router = express.Router();
  const iconUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxIconSize,
      files: 1
    }
  });

  router.get('/icon', auth.requireAuth, async (req, res) => {
    const targetUrl = iconService.normalizeIconTargetUrl(req.query.url);
    if (!targetUrl) {
      res.status(400).end();
      return;
    }

    const cacheKey = iconService.getIconCacheKey(targetUrl);

    try {
      const cachedIcon = await iconService.findCachedIcon(cacheKey);
      if (!cachedIcon || cachedIcon.miss) {
        res.status(404).end();
        return;
      }

      sendCachedIcon(res, cachedIcon);
    } catch (error) {
      console.warn('Failed to load icon:', error.message);
      res.status(404).end();
    }
  });

  router.post('/icon-cache/upload', auth.requireAuth, (req, res) => {
    iconUpload.single('icon')(req, res, async (error) => {
      if (error) {
        const message = error.code === 'LIMIT_FILE_SIZE' ? '图标文件不能超过 1MB' : error.message;
        res.status(400).json({ error: message });
        return;
      }

      const targetUrl = iconService.normalizeIconTargetUrl(req.body.url);
      if (!targetUrl) {
        res.status(400).json({ error: '图标目标地址无效' });
        return;
      }

      try {
        await assertPublicHttpUrl(targetUrl);
      } catch {
        res.status(400).json({ error: '图标目标地址无效' });
        return;
      }

      const result = iconService.validateUploadedIcon(targetUrl, req.body.sourceUrl, req.file);
      if (result.error) {
        res.status(400).json({ error: result.error });
        return;
      }

      try {
        await iconService.writeCachedIcon(iconService.getIconCacheKey(targetUrl), result.value);
        res.status(201).json({ ok: true });
      } catch (uploadError) {
        console.warn('Failed to upload icon cache:', uploadError.message);
        res.status(500).json({ error: '上传图标缓存失败' });
      }
    });
  });

  router.post('/icon-cache/import', auth.requireAuth, async (req, res) => {
    const targetUrl = iconService.normalizeIconTargetUrl(req.body.url);
    const iconUrl = iconService.toHttpUrl(req.body.iconUrl, targetUrl || undefined);
    if (!targetUrl || !iconUrl) {
      res.status(400).json({ error: '图标地址无效' });
      return;
    }

    try {
      await assertPublicHttpUrl(targetUrl);
      await assertPublicHttpUrl(iconUrl);
    } catch {
      res.status(400).json({ error: '图标地址无效' });
      return;
    }

    try {
      const icon = await iconService.fetchIconCandidate(iconUrl);
      if (!icon) {
        res.json({ ok: false });
        return;
      }

      await iconService.writeCachedIcon(iconService.getIconCacheKey(targetUrl), icon);
      res.status(201).json({ ok: true });
    } catch {
      res.json({ ok: false });
    }
  });

  router.post('/icon-cache/refresh', auth.requireAuth, async (req, res) => {
    try {
      await iconService.clearIconCacheMisses();
      res.json({ ok: true });
    } catch (error) {
      console.warn('Failed to refresh icon cache:', error.message);
      res.status(500).json({ error: '刷新图标缓存失败' });
    }
  });

  return router;
}

module.exports = {
  createIconsRouter,
  sendCachedIcon
};

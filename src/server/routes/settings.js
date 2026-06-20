const express = require('express');

const { deleteLocalBackground } = require('../services/backgroundFiles');
const {
  isBackgroundUrl,
  normalizeDisplayMode,
  normalizeLinkSize,
  normalizeUrl,
  validateLayoutColumns
} = require('../services/validation');

function createSettingsRouter(deps) {
  const { auth, config, stores } = deps;
  const router = express.Router();

  router.get('/settings', auth.requireAuth, (req, res) => {
    res.json({ settings: stores.settings.get() });
  });

  router.put('/settings', auth.requireAuth, (req, res) => {
    const current = stores.settings.get();
    const next = { ...current };

    if (Object.prototype.hasOwnProperty.call(req.body, 'layoutColumns')) {
      const result = validateLayoutColumns(req.body.layoutColumns, '布局列数');
      if (result.error) {
        res.status(400).json({ error: result.error });
        return;
      }
      next.layoutColumns = result.value;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'projectLayoutColumns')) {
      const result = validateLayoutColumns(req.body.projectLayoutColumns, '个人项目布局列数');
      if (result.error) {
        res.status(400).json({ error: result.error });
        return;
      }
      next.projectLayoutColumns = result.value;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'editMode')) {
      next.editMode = Boolean(req.body.editMode);
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'projectLinkDisplayMode')) {
      next.projectLinkDisplayMode = normalizeDisplayMode(req.body.projectLinkDisplayMode, 'default');
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'bookmarkLinkDisplayMode')) {
      next.bookmarkLinkDisplayMode = normalizeDisplayMode(req.body.bookmarkLinkDisplayMode, 'default');
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'projectLinkSize')) {
      next.projectLinkSize = normalizeLinkSize(req.body.projectLinkSize, 'medium');
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'bookmarkLinkSize')) {
      next.bookmarkLinkSize = normalizeLinkSize(req.body.bookmarkLinkSize, 'medium');
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'backgroundUrl')) {
      const backgroundUrl = normalizeUrl(req.body.backgroundUrl || '');
      if (!isBackgroundUrl(backgroundUrl)) {
        res.status(400).json({ error: '背景地址必须是 http/https URL 或上传文件路径' });
        return;
      }
      next.backgroundUrl = backgroundUrl;
    }

    const settings = stores.settings.update(next);
    if (current.backgroundUrl !== settings.backgroundUrl) {
      deleteLocalBackground(config, current.backgroundUrl);
    }

    res.json({ settings });
  });

  return router;
}

module.exports = {
  createSettingsRouter
};

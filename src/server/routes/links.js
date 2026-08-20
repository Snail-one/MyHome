const express = require('express');

const { normalizeLinkType, validateLinkPayload } = require('../services/validation');

function parseIdList(value) {
  return Array.isArray(value)
    ? value.map((id) => Number.parseInt(id, 10)).filter(Number.isInteger)
    : [];
}

async function sendLinksResponse(res, iconService, payload, options = {}) {
  if (options.prefetch && typeof iconService.prefetchLinksResponse === 'function') {
    iconService.prefetchLinksResponse(payload);
  }

  if (typeof iconService.decorateLinksResponse === 'function') {
    res.status(options.status || 200).json(await iconService.decorateLinksResponse(payload));
    return;
  }

  res.status(options.status || 200).json(payload);
}

function createLinksRouter(deps) {
  const { auth, iconService, stores, config } = deps;
  const router = express.Router();

  router.get('/links', auth.requireAuth, async (req, res) => {
    await sendLinksResponse(res, iconService, stores.links.getResponse(), {
      prefetch: config?.iconPrefetchOnRead !== false
    });
  });

  router.post('/links', auth.requireAuth, async (req, res) => {
    const result = validateLinkPayload(req.body);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    await sendLinksResponse(res, iconService, stores.links.create(result.value), {
      status: 201,
      prefetch: config?.iconPrefetchOnRead !== false
    });
  });

  router.put('/links/reorder', auth.requireAuth, async (req, res) => {
    const ids = parseIdList(req.body.ids);
    const linkType = normalizeLinkType(req.body.type || req.body.linkType);
    const result = stores.links.reorder(linkType, ids);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    await sendLinksResponse(res, iconService, result.value);
  });

  router.put('/links/:id', auth.requireAuth, async (req, res) => {
    const payload = validateLinkPayload(req.body);
    if (payload.error) {
      res.status(400).json({ error: payload.error });
      return;
    }

    const result = stores.links.update(req.params.id, payload.value);
    if (result.notFound) {
      res.status(404).json({ error: '链接不存在' });
      return;
    }

    if (result.invalidatedIcon) {
      await iconService.deleteEntityIcon(result.invalidatedIcon.entityType, result.invalidatedIcon.id)
        .catch((error) => console.warn('Failed to delete stale link icon:', error.message));
    }

    await sendLinksResponse(res, iconService, result.value, {
      prefetch: config?.iconPrefetchOnRead !== false
    });
  });

  router.delete('/links/:id', auth.requireAuth, async (req, res) => {
    const result = stores.links.delete(req.params.id);
    if (result.notFound) {
      res.status(404).json({ error: '链接不存在' });
      return;
    }
    if (result.required) {
      res.status(400).json({ error: 'Google 邮箱需要保留，可以编辑名称和登录地址' });
      return;
    }

    if (result.invalidatedIcon) {
      await iconService.deleteEntityIcon(result.invalidatedIcon.entityType, result.invalidatedIcon.id)
        .catch((error) => console.warn('Failed to delete link icon:', error.message));
    }

    await sendLinksResponse(res, iconService, result.value);
  });

  return router;
}

module.exports = {
  createLinksRouter,
  parseIdList
};

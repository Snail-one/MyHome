const express = require('express');

const { normalizeLinkType, validateLinkPayload } = require('../services/validation');

function parseIdList(value) {
  return Array.isArray(value)
    ? value.map((id) => Number.parseInt(id, 10)).filter(Number.isInteger)
    : [];
}

function createLinksRouter(deps) {
  const { auth, stores } = deps;
  const router = express.Router();

  router.get('/links', auth.requireAuth, (req, res) => {
    res.json(stores.links.getResponse());
  });

  router.post('/links', auth.requireAuth, (req, res) => {
    const result = validateLinkPayload(req.body);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.status(201).json(stores.links.create(result.value));
  });

  router.put('/links/reorder', auth.requireAuth, (req, res) => {
    const ids = parseIdList(req.body.ids);
    const linkType = normalizeLinkType(req.body.type || req.body.linkType);
    const result = stores.links.reorder(linkType, ids);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json(result.value);
  });

  router.put('/links/:id', auth.requireAuth, (req, res) => {
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

    res.json(result.value);
  });

  router.delete('/links/:id', auth.requireAuth, (req, res) => {
    const result = stores.links.delete(req.params.id);
    if (result.notFound) {
      res.status(404).json({ error: '链接不存在' });
      return;
    }
    if (result.required) {
      res.status(400).json({ error: 'Google 邮箱需要保留，可以编辑名称和登录地址' });
      return;
    }

    res.json(result.value);
  });

  return router;
}

module.exports = {
  createLinksRouter,
  parseIdList
};

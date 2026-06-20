const express = require('express');

const { validateSearchEnginePayload } = require('../services/validation');
const { parseIdList } = require('./links');

function createSearchEnginesRouter(deps) {
  const { auth, stores } = deps;
  const router = express.Router();

  router.get('/search-engines', auth.requireAuth, (req, res) => {
    res.json({ engines: stores.searchEngines.get() });
  });

  router.post('/search-engines', auth.requireAuth, (req, res) => {
    const result = validateSearchEnginePayload(req.body);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.status(201).json({ engines: stores.searchEngines.create(result.value) });
  });

  router.put('/search-engines/reorder', auth.requireAuth, (req, res) => {
    const result = stores.searchEngines.reorder(parseIdList(req.body.ids));
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ engines: result.value });
  });

  router.put('/search-engines/:id', auth.requireAuth, (req, res) => {
    const payload = validateSearchEnginePayload(req.body);
    if (payload.error) {
      res.status(400).json({ error: payload.error });
      return;
    }

    const result = stores.searchEngines.update(req.params.id, payload.value);
    if (result.notFound) {
      res.status(404).json({ error: '搜索引擎不存在' });
      return;
    }

    res.json({ engines: result.value });
  });

  router.delete('/search-engines/:id', auth.requireAuth, (req, res) => {
    const result = stores.searchEngines.delete(req.params.id);
    if (result.notFound) {
      res.status(404).json({ error: '搜索引擎不存在' });
      return;
    }
    if (result.required) {
      res.status(400).json({ error: 'Google 搜索需要保留，可以编辑名称和搜索地址' });
      return;
    }

    res.json({ engines: result.value });
  });

  return router;
}

module.exports = {
  createSearchEnginesRouter
};

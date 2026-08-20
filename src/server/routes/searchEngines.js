const express = require('express');

const { validateSearchEnginePayload } = require('../services/validation');
const { parseIdList } = require('./links');

async function sendSearchEnginesResponse(res, iconService, engines, options = {}) {
  if (options.prefetch && typeof iconService.prefetchSearchEngines === 'function') {
    iconService.prefetchSearchEngines(engines);
  }

  const payload = typeof iconService.decorateSearchEngines === 'function'
    ? { engines: await iconService.decorateSearchEngines(engines) }
    : { engines };

  res.status(options.status || 200).json(payload);
}

function createSearchEnginesRouter(deps) {
  const { auth, iconService, stores } = deps;
  const router = express.Router();

  router.get('/search-engines', auth.requireAuth, async (req, res) => {
    await sendSearchEnginesResponse(res, iconService, stores.searchEngines.get());
  });

  router.post('/search-engines', auth.requireAuth, async (req, res) => {
    const result = validateSearchEnginePayload(req.body);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    await sendSearchEnginesResponse(res, iconService, stores.searchEngines.create(result.value), {
      status: 201,
      prefetch: true
    });
  });

  router.put('/search-engines/reorder', auth.requireAuth, async (req, res) => {
    const result = stores.searchEngines.reorder(parseIdList(req.body.ids));
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    await sendSearchEnginesResponse(res, iconService, result.value);
  });

  router.put('/search-engines/:id', auth.requireAuth, async (req, res) => {
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

    if (result.invalidatedIcon) {
      await iconService.deleteEntityIcon(result.invalidatedIcon.entityType, result.invalidatedIcon.id)
        .catch((error) => console.warn('Failed to delete stale search engine icon:', error.message));
    }

    await sendSearchEnginesResponse(res, iconService, result.value, { prefetch: true });
  });

  router.delete('/search-engines/:id', auth.requireAuth, async (req, res) => {
    const result = stores.searchEngines.delete(req.params.id);
    if (result.notFound) {
      res.status(404).json({ error: '搜索引擎不存在' });
      return;
    }
    if (result.required) {
      res.status(400).json({ error: 'Google 搜索需要保留，可以编辑名称和搜索地址' });
      return;
    }

    if (result.invalidatedIcon) {
      await iconService.deleteEntityIcon(result.invalidatedIcon.entityType, result.invalidatedIcon.id)
        .catch((error) => console.warn('Failed to delete search engine icon:', error.message));
    }

    await sendSearchEnginesResponse(res, iconService, result.value);
  });

  return router;
}

module.exports = {
  createSearchEnginesRouter
};

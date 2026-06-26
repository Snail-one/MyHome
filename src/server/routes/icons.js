const express = require('express');
const multer = require('multer');

function sendCachedIcon(req, res, cachedIcon) {
  if (req.headers['if-none-match'] && req.headers['if-none-match'] === cachedIcon.etag) {
    res.status(304).end();
    return;
  }

  res.set('Cache-Control', 'private, max-age=604800');
  if (cachedIcon.etag) res.set('ETag', cachedIcon.etag);
  res.type(cachedIcon.contentType);
  res.sendFile(cachedIcon.filePath);
}

function parseEntityId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function getEntityVersion(entity) {
  return Number.parseInt(entity?.iconVersion, 10) || 1;
}

function createIconsRouter(deps) {
  const { auth, config, iconService, stores } = deps;
  const router = express.Router();
  const iconUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxIconSize,
      files: 1
    }
  });

  function getLink(req, res) {
    const id = parseEntityId(req.params.id);
    if (!id) {
      res.status(404).json({ error: '链接不存在' });
      return null;
    }

    const link = stores.links.findById(id);
    if (!link) {
      res.status(404).json({ error: '链接不存在' });
      return null;
    }
    return link;
  }

  function getSearchEngine(req, res) {
    const id = parseEntityId(req.params.id);
    if (!id) {
      res.status(404).json({ error: '搜索引擎不存在' });
      return null;
    }

    const engine = stores.searchEngines.findById(id);
    if (!engine) {
      res.status(404).json({ error: '搜索引擎不存在' });
      return null;
    }
    return engine;
  }

  async function sendEntityIconFile(req, res, entityType, entity) {
    const requestedVersion = Number.parseInt(req.query.v, 10) || getEntityVersion(entity);
    if (requestedVersion !== getEntityVersion(entity)) {
      res.status(404).end();
      return;
    }

    const cachedIcon = await iconService.findCachedEntityIcon(entityType, entity.id, requestedVersion);
    if (!cachedIcon) {
      res.status(404).end();
      return;
    }

    sendCachedIcon(req, res, cachedIcon);
  }

  router.get('/icons/links/:id/file', auth.requireAuth, async (req, res) => {
    const link = getLink(req, res);
    if (!link) return;

    try {
      await sendEntityIconFile(req, res, 'links', link);
    } catch (error) {
      console.warn('Failed to load link icon:', error.message);
      res.status(404).end();
    }
  });

  router.get('/icons/links/:id/status', auth.requireAuth, async (req, res) => {
    const link = getLink(req, res);
    if (!link) return;

    res.json(await iconService.getEntityIconStatus('links', link));
  });

  router.post('/icons/links/:id/resolve', auth.requireAuth, async (req, res) => {
    const link = getLink(req, res);
    if (!link) return;

    try {
      res.json(await iconService.resolveLinkIcon(link));
    } catch (error) {
      console.warn('Failed to resolve link icon:', error.message);
      res.json(await iconService.getEntityIconStatus('links', link));
    }
  });

  router.post('/icons/links/:id/upload', auth.requireAuth, (req, res) => {
    iconUpload.single('icon')(req, res, async (error) => {
      if (error) {
        const message = error.code === 'LIMIT_FILE_SIZE' ? '图标文件不能超过 1MB' : error.message;
        res.status(400).json({ error: message });
        return;
      }

      const id = parseEntityId(req.params.id);
      const existingLink = id ? stores.links.findById(id) : null;
      if (!existingLink) {
        res.status(404).json({ error: '链接不存在' });
        return;
      }

      const targetUrl = iconService.normalizeIconTargetUrl(existingLink.url);
      const validation = targetUrl
        ? iconService.validateUploadedIcon(targetUrl, req.body.sourceUrl, req.file)
        : { error: '图标目标地址无效' };
      if (validation.error) {
        res.status(400).json({ error: validation.error });
        return;
      }

      const bumpResult = stores.links.bumpIconVersion(id);
      if (bumpResult.notFound) {
        res.status(404).json({ error: '链接不存在' });
        return;
      }
      const link = bumpResult.value;
      try {
        await iconService.deleteEntityIcon('links', link.id);
        const result = await iconService.writeUploadedLinkIcon(link, req.file, {
          source: req.body.source === 'local' ? 'local' : 'upload',
          sourceUrl: req.body.sourceUrl
        });
        if (result.error) {
          res.status(400).json({ error: result.error });
          return;
        }

        res.status(201).json(result.value);
      } catch (uploadError) {
        console.warn('Failed to upload link icon:', uploadError.message);
        res.status(500).json({ error: '上传图标失败' });
      }
    });
  });

  router.delete('/icons/links/:id', auth.requireAuth, async (req, res) => {
    const link = getLink(req, res);
    if (!link) return;

    try {
      await iconService.deleteEntityIcon('links', link.id);
      res.json(await iconService.getEntityIconStatus('links', link));
    } catch (error) {
      console.warn('Failed to delete link icon:', error.message);
      res.status(500).json({ error: '删除图标缓存失败' });
    }
  });

  router.get('/icons/search-engines/:id/file', auth.requireAuth, async (req, res) => {
    const engine = getSearchEngine(req, res);
    if (!engine) return;

    try {
      await sendEntityIconFile(req, res, 'search-engines', engine);
    } catch (error) {
      console.warn('Failed to load search engine icon:', error.message);
      res.status(404).end();
    }
  });

  router.get('/icons/search-engines/:id/status', auth.requireAuth, async (req, res) => {
    const engine = getSearchEngine(req, res);
    if (!engine) return;

    res.json(await iconService.getEntityIconStatus('search-engines', engine));
  });

  router.post('/icons/search-engines/:id/resolve', auth.requireAuth, async (req, res) => {
    const engine = getSearchEngine(req, res);
    if (!engine) return;

    try {
      res.json(await iconService.resolveSearchEngineIcon(engine));
    } catch (error) {
      console.warn('Failed to resolve search engine icon:', error.message);
      res.json(await iconService.getEntityIconStatus('search-engines', engine));
    }
  });

  router.delete('/icons/search-engines/:id', auth.requireAuth, async (req, res) => {
    const engine = getSearchEngine(req, res);
    if (!engine) return;

    try {
      await iconService.deleteEntityIcon('search-engines', engine.id);
      res.json(await iconService.getEntityIconStatus('search-engines', engine));
    } catch (error) {
      console.warn('Failed to delete search engine icon:', error.message);
      res.status(500).json({ error: '删除图标缓存失败' });
    }
  });

  router.post('/icons/refresh', auth.requireAuth, async (req, res) => {
    try {
      await iconService.clearIconCache();
      const links = stores.links.bumpAllIconVersions();
      const engines = stores.searchEngines.bumpAllIconVersions();

      const visibleLinks = [
        ...links.links,
        ...links.emailLinks,
        ...links.projectLinks
      ].filter((link) => link.iconMode === 'server');

      await Promise.allSettled([
        ...visibleLinks.map((link) => iconService.resolveLinkIcon(link)),
        ...engines.map((engine) => iconService.resolveSearchEngineIcon(engine))
      ]);

      res.json({ ok: true, ...links, engines });
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

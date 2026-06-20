const express = require('express');
const multer = require('multer');

const { deleteLocalBackground, saveBackgroundUpload } = require('../services/backgroundFiles');

function createBackgroundsRouter(deps) {
  const { auth, config, stores } = deps;
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxBackgroundSize,
      files: 1
    }
  });

  router.post('/background', auth.requireAuth, (req, res) => {
    upload.single('background')(req, res, async (error) => {
      if (error) {
        const message = error.code === 'LIMIT_FILE_SIZE' ? '图片文件不能超过 10MB' : error.message;
        res.status(400).json({ error: message });
        return;
      }

      try {
        const result = await saveBackgroundUpload(config, req.file);
        if (result.error) {
          res.status(400).json({ error: result.error });
          return;
        }

        const current = stores.settings.get();
        const settings = stores.settings.updateBackground(result.value);
        if (current.backgroundUrl !== settings.backgroundUrl) {
          deleteLocalBackground(config, current.backgroundUrl);
        }

        res.status(201).json({ settings });
      } catch (uploadError) {
        console.warn('Failed to upload background:', uploadError.message);
        res.status(500).json({ error: '上传背景失败' });
      }
    });
  });

  return router;
}

module.exports = {
  createBackgroundsRouter
};

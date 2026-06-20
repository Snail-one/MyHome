const bcrypt = require('bcryptjs');
const express = require('express');

const { sendLoginLockedResponse } = require('../services/loginLimiter');

function createAuthRouter(deps) {
  const { auth, config, limiter, stores } = deps;
  const router = express.Router();

  router.post('/login', (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const attemptKey = limiter.getKey(req, username);
    const activeAttemptState = limiter.getActiveState(attemptKey);

    if (activeAttemptState?.lockedUntil > Date.now()) {
      sendLoginLockedResponse(res, limiter, activeAttemptState);
      return;
    }

    const user = stores.users.findByUsername(username);

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      const failedState = limiter.recordFailure(attemptKey);
      if (failedState.lockedUntil > Date.now()) {
        sendLoginLockedResponse(res, limiter, failedState);
        return;
      }

      res.status(401).json({ error: '账号或密码不正确' });
      return;
    }

    limiter.clear(attemptKey);

    req.session.regenerate((error) => {
      if (error) {
        res.status(500).json({ error: '登录失败，请重试' });
        return;
      }

      req.session.userId = config.userId;
      res.json({ user: { username: user.username } });
    });
  });

  router.post('/logout', auth.requireAuth, (req, res) => {
    req.session.destroy((error) => {
      if (error) {
        res.status(500).json({ error: '退出失败，请重试' });
        return;
      }
      res.clearCookie(config.sessionCookieName);
      res.json({ ok: true });
    });
  });

  router.get('/me', (req, res) => {
    if (auth.isAuthenticated(req)) {
      res.json({ authenticated: true, user: stores.users.getMe() });
      return;
    }
    res.json({ authenticated: false });
  });

  return router;
}

module.exports = {
  createAuthRouter
};

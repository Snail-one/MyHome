const bcrypt = require('bcryptjs');
const express = require('express');

const { ensureUserDefaults } = require('../db/seed');
const { sendLoginLockedResponse } = require('../services/loginLimiter');

// Dummy hash to prevent timing side-channel user enumeration.
// Always compared when user does not exist, so bcrypt runs in all cases.
const DUMMY_HASH = '$2a$12$0A3hvgiidTsNjYRnlBrXMutNAw5tzOXVcpPOlu.FiY3Ee1kwthq/G';
const USERNAME_MAX_LENGTH = 40;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 200;

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!username) return { error: '请填写账号' };
  if (username.length > USERNAME_MAX_LENGTH) return { error: `账号不能超过 ${USERNAME_MAX_LENGTH} 个字符` };
  return { value: username };
}

function validatePassword(value, options = {}) {
  const password = typeof value === 'string' ? value : '';
  const label = options.label || '密码';
  if (!password) return { error: `请填写${label}` };
  if (password.length < PASSWORD_MIN_LENGTH) return { error: `${label}至少需要 ${PASSWORD_MIN_LENGTH} 位` };
  if (password.length > PASSWORD_MAX_LENGTH) return { error: `${label}不能超过 ${PASSWORD_MAX_LENGTH} 位` };
  return { value: password };
}

function establishSession(req, res, config, user, statusCode = 200) {
  req.session.regenerate((error) => {
    if (error) {
      res.status(500).json({ error: '登录失败，请重试' });
      return;
    }

    req.session.userId = config.userId;
    res.status(statusCode).json({ user: { username: user.username } });
  });
}

function createAuthRouter(deps) {
  const { auth, config, limiter, stores } = deps;
  const router = express.Router();

  router.get('/setup', (req, res) => {
    res.json({ setupRequired: !stores.users.findAdmin() });
  });

  router.post('/setup/register', (req, res) => {
    if (stores.users.findAdmin()) {
      res.status(409).json({ error: '管理员账号已存在' });
      return;
    }

    const usernameResult = validateUsername(req.body?.username);
    if (usernameResult.error) {
      res.status(400).json({ error: usernameResult.error });
      return;
    }

    const passwordResult = validatePassword(req.body?.password);
    if (passwordResult.error) {
      res.status(400).json({ error: passwordResult.error });
      return;
    }

    const passwordHash = bcrypt.hashSync(passwordResult.value, config.bcryptRounds);
    try {
      stores.users.insertAdmin(usernameResult.value, passwordHash);
      ensureUserDefaults(stores);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({ error: '管理员账号已存在' });
        return;
      }
      throw error;
    }

    establishSession(req, res, config, { username: usernameResult.value }, 201);
  });

  router.post('/login', (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const attemptKey = limiter.getKey(req);
    const activeAttemptState = limiter.getActiveState(attemptKey);

    if (activeAttemptState?.lockedUntil > Date.now()) {
      sendLoginLockedResponse(res, limiter, activeAttemptState);
      return;
    }

    if (!stores.users.findAdmin()) {
      res.status(409).json({ error: '请先创建管理员账号', setupRequired: true });
      return;
    }

    const user = stores.users.findByUsername(username);
    const hashToCompare = user?.password_hash || DUMMY_HASH;
    // Always run bcrypt.compareSync to prevent timing side-channel user enumeration.
    // When user is null, DUMMY_HASH is used (will never match any real password).
    const bcryptResult = bcrypt.compareSync(password, hashToCompare);
    const passwordValid = user && bcryptResult;

    if (!passwordValid) {
      const failedState = limiter.recordFailure(attemptKey);
      if (failedState.lockedUntil > Date.now()) {
        sendLoginLockedResponse(res, limiter, failedState);
        return;
      }

      res.status(401).json({ error: '账号或密码不正确' });
      return;
    }

    limiter.clear(attemptKey);
    establishSession(req, res, config, user);
  });

  router.put('/account', auth.requireAuth, (req, res) => {
    const existing = stores.users.findAdmin();
    if (!existing) {
      res.status(404).json({ error: '管理员账号不存在' });
      return;
    }

    const usernameResult = validateUsername(req.body?.username);
    if (usernameResult.error) {
      res.status(400).json({ error: usernameResult.error });
      return;
    }

    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    if (!bcrypt.compareSync(currentPassword, existing.password_hash || DUMMY_HASH)) {
      res.status(401).json({ error: '当前密码不正确' });
      return;
    }

    const nextPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (nextPassword) {
      const nextPasswordResult = validatePassword(nextPassword, { label: '新密码' });
      if (nextPasswordResult.error) {
        res.status(400).json({ error: nextPasswordResult.error });
        return;
      }

      stores.users.updateAdminCredentials(
        usernameResult.value,
        bcrypt.hashSync(nextPasswordResult.value, config.bcryptRounds)
      );
    } else {
      stores.users.updateAdminUsername(usernameResult.value);
    }

    res.json({ user: { username: usernameResult.value } });
  });

  router.post('/logout', auth.requireAuth, (req, res) => {
    req.session.destroy((error) => {
      if (error) {
        res.status(500).json({ error: '退出失败，请重试' });
        return;
      }
      res.clearCookie(config.sessionCookieName, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.sessionCookieSecure,
        path: '/'
      });
      res.json({ ok: true });
    });
  });

  router.get('/me', (req, res) => {
    if (auth.isAuthenticated(req)) {
      res.json({ authenticated: true, user: stores.users.getMe() });
      return;
    }
    res.json({ authenticated: false, setupRequired: !stores.users.findAdmin() });
  });

  return router;
}

module.exports = {
  createAuthRouter
};

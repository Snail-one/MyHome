function sessionVersionOf(session) {
  return Number.isInteger(session?.sessionVersion) ? session.sessionVersion : 0;
}

function isAuthenticated(req, userId, sessionVersion) {
  return Boolean(
    req.session &&
    req.session.userId === userId &&
    sessionVersion != null &&
    sessionVersionOf(req.session) === sessionVersion
  );
}

function createAuthMiddleware(config, stores) {
  function currentSessionVersion() {
    return stores.users.getSessionVersion();
  }

  function requireAuth(req, res, next) {
    if (isAuthenticated(req, config.userId, currentSessionVersion())) {
      next();
      return;
    }
    res.status(401).json({ error: '未登录' });
  }

  return {
    isAuthenticated: (req) => isAuthenticated(req, config.userId, currentSessionVersion()),
    requireAuth
  };
}

module.exports = {
  createAuthMiddleware,
  isAuthenticated
};

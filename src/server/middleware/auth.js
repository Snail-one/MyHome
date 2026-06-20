function isAuthenticated(req, userId) {
  return req.session && req.session.userId === userId;
}

function createAuthMiddleware(config) {
  function requireAuth(req, res, next) {
    if (isAuthenticated(req, config.userId)) {
      next();
      return;
    }
    res.status(401).json({ error: '未登录' });
  }

  return {
    isAuthenticated: (req) => isAuthenticated(req, config.userId),
    requireAuth
  };
}

module.exports = {
  createAuthMiddleware,
  isAuthenticated
};

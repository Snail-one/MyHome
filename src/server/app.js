const path = require('path');

const express = require('express');
const session = require('express-session');

const { createAuthMiddleware } = require('./middleware/auth');
const { errorHandler, notFoundApi } = require('./middleware/errors');
const { createAuthRouter } = require('./routes/auth');
const { createBackgroundsRouter } = require('./routes/backgrounds');
const { createIconsRouter } = require('./routes/icons');
const { createLinksRouter } = require('./routes/links');
const { createSearchEnginesRouter } = require('./routes/searchEngines');
const { createSettingsRouter } = require('./routes/settings');
const { createHtmlRenderer } = require('./services/htmlRenderer');
const { createIconService } = require('./services/iconService');
const { createLoginLimiter } = require('./services/loginLimiter');
const { SQLiteSessionStore } = require('./services/sessionStore');

function createSecurityHeadersMiddleware() {
  const contentSecurityPolicy = [
    "default-src 'self'",
    "img-src 'self' http: https: data: blob:",
    // Runtime background previews and the initial background style still use inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "font-src 'self' data:",
    "connect-src 'self' http: https:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');

  return (req, res, next) => {
    res.set('Content-Security-Policy', contentSecurityPolicy);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  };
}

function sendPublicFile(res, config, fileName, options = {}) {
  if (options.noStore) res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(config.publicDir, fileName));
}

function createApp(deps) {
  const { config, db, stores } = deps;
  const app = express();
  const sessionStore = deps.sessionStore || new SQLiteSessionStore(db, {
    maxAgeMs: config.sessionMaxAgeMs,
    cleanupIntervalMs: config.sessionCleanupIntervalMs
  });
  const auth = createAuthMiddleware(config);
  const limiter = deps.loginLimiter || createLoginLimiter({
    maxFailedAttempts: config.loginMaxFailedAttempts,
    windowMs: config.loginWindowMs,
    lockoutMs: config.loginLockoutMs
  });
  const iconService = deps.iconService || createIconService(config);
  const htmlRenderer = deps.htmlRenderer || createHtmlRenderer(config, stores.settings);

  app.locals.sessionStore = sessionStore;
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(createSecurityHeadersMiddleware());
  app.use(express.json({ limit: '64kb' }));
  app.use(session({
    store: sessionStore,
    name: config.sessionCookieName,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.sessionCookieSecure,
      maxAge: config.sessionMaxAgeMs
    }
  }));

  app.use('/uploads', express.static(config.uploadsDir, {
    dotfiles: 'deny',
    fallthrough: false,
    maxAge: '7d'
  }));

  app.use('/js', express.static(path.join(config.publicDir, 'js'), {
    dotfiles: 'deny',
    fallthrough: false,
    maxAge: config.nodeEnv === 'production' ? '1h' : 0
  }));

  app.get('/', async (req, res, next) => {
    if (!auth.isAuthenticated(req)) {
      res.redirect(302, '/login');
      return;
    }

    try {
      res.set('Cache-Control', 'no-store');
      res.type('html').send(await htmlRenderer.renderIndex());
    } catch (error) {
      next(error);
    }
  });

  app.get('/login', (req, res) => {
    if (auth.isAuthenticated(req)) {
      res.redirect(302, '/');
      return;
    }

    sendPublicFile(res, config, 'login.html', { noStore: true });
  });

  app.get('/style.css', (req, res) => {
    res.set('Cache-Control', config.nodeEnv === 'production' ? 'public, max-age=3600' : 'no-cache');
    sendPublicFile(res, config, 'style.css');
  });

  app.get('/login.js', (req, res) => {
    res.set('Cache-Control', config.nodeEnv === 'production' ? 'public, max-age=3600' : 'no-cache');
    sendPublicFile(res, config, 'login.js');
  });

  app.get('/favicon.svg', (req, res) => {
    res.type('image/svg+xml');
    res.set('Cache-Control', 'public, max-age=86400');
    sendPublicFile(res, config, 'favicon.svg');
  });

  const apiDeps = {
    auth,
    config,
    iconService,
    limiter,
    stores
  };

  app.use('/api', createAuthRouter(apiDeps));
  app.use('/api', createSettingsRouter(apiDeps));
  app.use('/api', createSearchEnginesRouter(apiDeps));
  app.use('/api', createLinksRouter(apiDeps));
  app.use('/api', createIconsRouter(apiDeps));
  app.use('/api', createBackgroundsRouter(apiDeps));
  app.use('/api', notFoundApi);
  app.use(errorHandler);

  return app;
}

module.exports = {
  createApp,
  createSecurityHeadersMiddleware
};

const { createApp } = require('./src/server/app');
const { loadConfig } = require('./src/server/config');
const { createDatabase } = require('./src/server/db');
const { clearProxyAgents } = require('./src/server/services/httpSafety');

function main() {
  const config = loadConfig();

  if (config.iconFetchLogEnabled) {
    console.log('[icon-fetch] detailed logging enabled (set ICON_FETCH_LOG=false to disable)');
  }

  const database = createDatabase(config);
  const app = createApp({
    config,
    db: database.db,
    stores: database.stores
  });

  const server = app.listen(config.port, config.host, () => {
    console.log(`Personal homepage server running at http://${config.host}:${config.port}`);
  });

  function gracefulShutdown(signal) {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);

    server.close(() => {
      console.log('HTTP server closed');
      try {
        const sessionStore = app.locals.sessionStore;
        if (sessionStore && typeof sessionStore.close === 'function') {
          sessionStore.close();
        }
      } catch (_) { /* ignore */ }

      try {
        database.close();
      } catch (_) { /* ignore */ }

      try {
        clearProxyAgents();
      } catch (_) { /* ignore */ }

      console.log('Shutdown complete');
      process.exit(0);
    });

    // Force exit after 5 seconds if graceful shutdown hangs
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  main
};

const { createApp } = require('./src/server/app');
const { loadConfig } = require('./src/server/config');
const { createDatabase } = require('./src/server/db');

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error.code === 'CONFIG_MISSING_REQUIRED_ENV') {
      console.error(error.message);
      console.error('Copy .env.example to .env and set ADMIN_USERNAME and ADMIN_PASSWORD before starting the server.');
      process.exit(1);
    }
    throw error;
  }

  const database = createDatabase(config);
  const app = createApp({
    config,
    db: database.db,
    stores: database.stores
  });

  app.listen(config.port, config.host, () => {
    console.log(`Personal homepage server running at http://${config.host}:${config.port}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  main
};

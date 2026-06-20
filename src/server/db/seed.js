const bcrypt = require('bcryptjs');

function seedDatabase(stores, config) {
  const existing = stores.users.findAdmin();
  const passwordMatches = existing
    ? bcrypt.compareSync(config.adminPassword, existing.password_hash)
    : false;

  if (!existing) {
    stores.users.insertAdmin(
      config.adminUsername,
      bcrypt.hashSync(config.adminPassword, config.bcryptRounds)
    );
  } else if (existing.username !== config.adminUsername || !passwordMatches) {
    stores.users.updateAdmin(
      config.adminUsername,
      bcrypt.hashSync(config.adminPassword, config.bcryptRounds)
    );
  }

  stores.settings.ensure();
  stores.links.ensureDefaultEmailLink();
  stores.searchEngines.ensureDefaults();
}

module.exports = {
  seedDatabase
};

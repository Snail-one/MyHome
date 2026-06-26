function ensureUserDefaults(stores) {
  stores.settings.ensure();
  stores.links.ensureDefaultEmailLink();
  stores.searchEngines.ensureDefaults();
}

function seedDatabase(stores) {
  const existing = stores.users.findAdmin();
  if (!existing) return;
  ensureUserDefaults(stores);
}

module.exports = {
  ensureUserDefaults,
  seedDatabase
};

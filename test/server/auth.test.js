const assert = require('node:assert/strict');
const test = require('node:test');

const { isAuthenticated } = require('../../src/server/middleware/auth');

test('isAuthenticated requires the current user session version', () => {
  const req = { session: { userId: 1, sessionVersion: 0 } };

  assert.equal(isAuthenticated(req, 1, 0), true);
  assert.equal(isAuthenticated({ session: { userId: 1 } }, 1, 0), true);
  assert.equal(isAuthenticated(req, 1, 1), false);
  assert.equal(isAuthenticated(req, 1, null), false);
  assert.equal(isAuthenticated({ session: { userId: 2, sessionVersion: 0 } }, 1, 0), false);
  assert.equal(isAuthenticated({}, 1, 0), false);
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { isSameOriginEventRequest } = require('../../src/server/routes/icons');
const { createIconEventHub } = require('../../src/server/services/iconEventHub');

function createFakeResponse(options = {}) {
  return {
    destroyed: false,
    writableEnded: false,
    frames: [],
    write(frame) {
      this.frames.push(frame);
      return options.backpressure !== true;
    },
    end() {
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
    }
  };
}

function createFakeRequest(headers = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    protocol: 'https',
    get(name) {
      if (name.toLowerCase() === 'host') return normalizedHeaders.host || 'home.example.com';
      return normalizedHeaders[name.toLowerCase()];
    }
  };
}

test('icon event hub enforces connection limits and isolates broadcasts by user', () => {
  const hub = createIconEventHub({
    heartbeatMs: 60000,
    maxConnections: 2,
    maxConnectionsPerSession: 1
  });
  const first = createFakeResponse();
  const sameSession = createFakeResponse();
  const second = createFakeResponse();
  const overGlobalLimit = createFakeResponse();

  assert.equal(hub.subscribe({ res: first, sessionId: 'session-1', userId: 1 }).accepted, true);
  assert.equal(hub.subscribe({ res: sameSession, sessionId: 'session-1', userId: 1 }).reason, 'session-limit');
  assert.equal(hub.subscribe({ res: second, sessionId: 'session-2', userId: 2 }).accepted, true);
  assert.equal(hub.subscribe({ res: overGlobalLimit, sessionId: 'session-3', userId: 3 }).reason, 'global-limit');

  hub.broadcast({ status: 'ready' }, 1);
  assert.equal(first.frames.length, 1);
  assert.equal(second.frames.length, 0);

  hub.disconnectSession('session-1');
  assert.equal(first.writableEnded, true);
  assert.equal(hub.getConnectionCount(), 1);
  hub.close();
  assert.equal(second.writableEnded, true);
});

test('icon event hub disconnects slow clients instead of buffering events', () => {
  const hub = createIconEventHub({ heartbeatMs: 60000 });
  const response = createFakeResponse({ backpressure: true });
  hub.subscribe({ res: response, sessionId: 'session-1', userId: 1 });

  hub.broadcast({ status: 'ready' }, 1);

  assert.equal(response.destroyed, true);
  assert.equal(hub.getConnectionCount(), 0);
  hub.close();
});

test('icon event hub revalidates sessions and closes revoked connections', async () => {
  const sessions = new Map([['session-1', { userId: 1 }]]);
  const sessionStore = {
    get(sessionId, callback) {
      setImmediate(callback, null, sessions.get(sessionId));
    }
  };
  const hub = createIconEventHub({ sessionStore, heartbeatMs: 60000 });
  const response = createFakeResponse();
  hub.subscribe({ res: response, sessionId: 'session-1', userId: 1 });

  await hub.validateConnections();
  assert.deepEqual(response.frames, [': ping\n\n']);

  sessions.delete('session-1');
  await hub.validateConnections();
  assert.equal(response.writableEnded, true);
  assert.equal(hub.getConnectionCount(), 0);
  hub.close();
});

test('SSE origin guard rejects cross-origin and same-site requests', () => {
  assert.equal(isSameOriginEventRequest(createFakeRequest({
    host: 'home.example.com',
    origin: 'https://home.example.com',
    'sec-fetch-site': 'same-origin'
  })), true);
  assert.equal(isSameOriginEventRequest(createFakeRequest({
    host: 'home.example.com',
    origin: 'https://evil.example.com',
    'sec-fetch-site': 'same-site'
  })), false);
  assert.equal(isSameOriginEventRequest(createFakeRequest({
    host: 'home.example.com',
    origin: 'not-a-url'
  })), false);
});

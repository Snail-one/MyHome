function createIconEventHub(options = {}) {
  const clients = new Map();
  const clientsBySession = new Map();
  const sessionStore = options.sessionStore;
  const heartbeatMs = Number.parseInt(options.heartbeatMs, 10) || 15000;
  const maxConnections = Number.parseInt(options.maxConnections, 10) || 32;
  const maxConnectionsPerSession = Number.parseInt(options.maxConnectionsPerSession, 10) || 4;
  let heartbeatRunning = false;
  let closed = false;

  function removeClient(res) {
    const client = clients.get(res);
    if (!client) return;
    clients.delete(res);
    const sessionClients = clientsBySession.get(client.sessionId);
    sessionClients?.delete(res);
    if (!sessionClients?.size) clientsBySession.delete(client.sessionId);
  }

  function disconnectClient(res, options = {}) {
    removeClient(res);
    try {
      if (options.destroy && typeof res.destroy === 'function') {
        res.destroy();
      } else if (!res.writableEnded && typeof res.end === 'function') {
        res.end();
      }
    } catch {
      // The socket may already have been closed by the client.
    }
  }

  function writeFrame(client, frame) {
    const { res } = client;
    if (res.destroyed || res.writableEnded) {
      removeClient(res);
      return false;
    }

    try {
      if (res.write(frame) === false) {
        // Icon events are state notifications. A slow client can reconnect and
        // resynchronize instead of retaining an unbounded response buffer.
        disconnectClient(res, { destroy: true });
        return false;
      }
      return true;
    } catch {
      disconnectClient(res, { destroy: true });
      return false;
    }
  }

  function readSession(sessionId) {
    if (!sessionStore || typeof sessionStore.get !== 'function') return Promise.resolve(null);
    return new Promise((resolve) => {
      sessionStore.get(sessionId, (error, sessionData) => {
        resolve(error ? null : sessionData || null);
      });
    });
  }

  async function heartbeatClients() {
    if (heartbeatRunning || closed) return;
    heartbeatRunning = true;
    try {
      for (const [sessionId, sessionClients] of [...clientsBySession]) {
        let sessionData = null;
        if (sessionStore && typeof sessionStore.get === 'function') {
          sessionData = await readSession(sessionId);
        }

        for (const res of [...sessionClients]) {
          const client = clients.get(res);
          if (!client) continue;
          if (sessionStore && (!sessionData || sessionData.userId !== client.userId)) {
            disconnectClient(res);
            continue;
          }
          writeFrame(client, ': ping\n\n');
        }
      }
    } finally {
      heartbeatRunning = false;
    }
  }

  const heartbeat = setInterval(() => {
    heartbeatClients().catch(() => {});
  }, heartbeatMs);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  return {
    subscribe({ res, sessionId, userId }) {
      if (closed || !res || !sessionId || userId === undefined || userId === null) {
        return { accepted: false, reason: 'invalid' };
      }
      if (clients.size >= maxConnections) {
        return { accepted: false, reason: 'global-limit' };
      }

      const sessionClients = clientsBySession.get(sessionId) || new Set();
      if (sessionClients.size >= maxConnectionsPerSession) {
        return { accepted: false, reason: 'session-limit' };
      }

      const client = { res, sessionId, userId };
      clients.set(res, client);
      sessionClients.add(res);
      clientsBySession.set(sessionId, sessionClients);
      return { accepted: true };
    },
    unsubscribe(res) {
      removeClient(res);
    },
    disconnectSession(sessionId) {
      const sessionClients = clientsBySession.get(sessionId);
      if (!sessionClients) return;
      for (const res of [...sessionClients]) disconnectClient(res);
    },
    broadcast(payload, userId) {
      if (userId === undefined || userId === null) return;
      const frame = `event: icon\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const client of [...clients.values()]) {
        if (client.userId !== userId) continue;
        writeFrame(client, frame);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const res of [...clients.keys()]) disconnectClient(res);
    },
    getConnectionCount() {
      return clients.size;
    },
    validateConnections() {
      return heartbeatClients();
    }
  };
}

module.exports = {
  createIconEventHub
};

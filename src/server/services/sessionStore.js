const session = require('express-session');

function deferSessionCallback(callback, ...args) {
  if (!callback) return;
  if (typeof setImmediate === 'function') {
    setImmediate(callback, ...args);
    return;
  }
  process.nextTick(() => callback(...args));
}

function getSessionExpiresAt(sessionData, fallbackMaxAgeMs) {
  const expires = sessionData?.cookie?.expires;
  if (expires) {
    const expiresAt = new Date(expires).getTime();
    if (Number.isFinite(expiresAt)) return expiresAt;
  }

  const maxAge = sessionData?.cookie?.maxAge;
  if (typeof maxAge === 'number' && Number.isFinite(maxAge)) {
    return Date.now() + maxAge;
  }

  return Date.now() + fallbackMaxAgeMs;
}

class SQLiteSessionStore extends session.Store {
  constructor(database, options = {}) {
    super();

    this.maxAgeMs = options.maxAgeMs || 1000 * 60 * 60 * 24 * 30;
    this.cleanupIntervalMs = options.cleanupIntervalMs || 60 * 60 * 1000;
    this.statements = {
      get: database.prepare('SELECT sess, expires FROM sessions WHERE sid = ?'),
      set: database.prepare(`
        INSERT INTO sessions (sid, sess, expires)
        VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET
          sess = excluded.sess,
          expires = excluded.expires
      `),
      all: database.prepare('SELECT sid, sess FROM sessions WHERE expires > ?'),
      count: database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires > ?'),
      destroy: database.prepare('DELETE FROM sessions WHERE sid = ?'),
      clear: database.prepare('DELETE FROM sessions'),
      deleteExpired: database.prepare('DELETE FROM sessions WHERE expires <= ?')
    };

    this.cleanupExpiredSessions();
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), this.cleanupIntervalMs);
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  get(sessionId, callback) {
    try {
      const row = this.statements.get.get(sessionId);
      if (!row) {
        deferSessionCallback(callback, null);
        return;
      }

      if (Number(row.expires) <= Date.now()) {
        this.statements.destroy.run(sessionId);
        deferSessionCallback(callback, null);
        return;
      }

      deferSessionCallback(callback, null, JSON.parse(row.sess));
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  set(sessionId, sessionData, callback) {
    try {
      this.statements.set.run(
        sessionId,
        JSON.stringify(sessionData),
        getSessionExpiresAt(sessionData, this.maxAgeMs)
      );
      deferSessionCallback(callback);
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  touch(sessionId, sessionData, callback) {
    try {
      const row = this.statements.get.get(sessionId);
      if (row) {
        const currentSession = JSON.parse(row.sess);
        currentSession.cookie = sessionData.cookie;
        this.statements.set.run(
          sessionId,
          JSON.stringify(currentSession),
          getSessionExpiresAt(currentSession, this.maxAgeMs)
        );
      }
      deferSessionCallback(callback);
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  destroy(sessionId, callback) {
    try {
      this.statements.destroy.run(sessionId);
      deferSessionCallback(callback);
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  all(callback) {
    try {
      this.cleanupExpiredSessions();
      const sessions = Object.create(null);
      const rows = this.statements.all.all(Date.now());

      rows.forEach((row) => {
        sessions[row.sid] = JSON.parse(row.sess);
      });

      deferSessionCallback(callback, null, sessions);
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  clear(callback) {
    try {
      this.statements.clear.run();
      deferSessionCallback(callback);
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  length(callback) {
    try {
      this.cleanupExpiredSessions();
      const row = this.statements.count.get(Date.now());
      deferSessionCallback(callback, null, Number(row.count));
    } catch (error) {
      deferSessionCallback(callback, error);
    }
  }

  cleanupExpiredSessions() {
    this.statements.deleteExpired.run(Date.now());
  }

  close() {
    clearInterval(this.cleanupTimer);
  }
}

module.exports = {
  SQLiteSessionStore,
  deferSessionCallback,
  getSessionExpiresAt
};

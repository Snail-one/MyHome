function createLoginLimiter(options) {
  const {
    maxFailedAttempts,
    windowMs,
    lockoutMs,
    now = () => Date.now()
  } = options;
  const attempts = new Map();

  function getKey(req, username) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const normalizedUsername = (username || 'unknown').toLowerCase();
    return `${ip}:${normalizedUsername}`;
  }

  function prune(currentTime = now()) {
    if (attempts.size < 1000) return;

    for (const [key, state] of attempts.entries()) {
      const windowExpired = currentTime - state.firstFailedAt > windowMs;
      const lockExpired = state.lockedUntil <= currentTime;
      if (windowExpired && lockExpired) attempts.delete(key);
    }
  }

  function getActiveState(key) {
    const currentTime = now();
    const state = attempts.get(key);
    if (!state) return null;

    if (state.lockedUntil > currentTime) return state;

    if (currentTime - state.firstFailedAt > windowMs) {
      attempts.delete(key);
      return null;
    }

    return state;
  }

  function recordFailure(key) {
    const currentTime = now();
    prune(currentTime);

    let state = attempts.get(key);
    if (!state || currentTime - state.firstFailedAt > windowMs) {
      state = {
        failedCount: 0,
        firstFailedAt: currentTime,
        lockedUntil: 0
      };
    }

    state.failedCount += 1;
    if (state.failedCount >= maxFailedAttempts) {
      state.lockedUntil = currentTime + lockoutMs;
    }

    attempts.set(key, state);
    return state;
  }

  function clear(key) {
    attempts.delete(key);
  }

  function getRetryAfterSeconds(state) {
    return Math.max(1, Math.ceil((state.lockedUntil - now()) / 1000));
  }

  return {
    attempts,
    clear,
    getActiveState,
    getKey,
    getRetryAfterSeconds,
    recordFailure
  };
}

function sendLoginLockedResponse(res, limiter, state) {
  const retryAfterSeconds = limiter.getRetryAfterSeconds(state);
  const retryAfterText = retryAfterSeconds < 60
    ? `${retryAfterSeconds} 秒`
    : `${Math.ceil(retryAfterSeconds / 60)} 分钟`;
  res.set('Retry-After', String(retryAfterSeconds));
  res.status(429).json({
    error: `登录失败次数过多，请 ${retryAfterText}后再试`
  });
}

module.exports = {
  createLoginLimiter,
  sendLoginLockedResponse
};

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertPublicHttpUrl,
  isBlockedAddress,
  isPrivateIPv4,
  isPrivateIPv6,
  safeFetch
} = require('../../src/server/services/httpSafety');

test('private and reserved addresses are blocked', () => {
  assert.equal(isPrivateIPv4('127.0.0.1'), true);
  assert.equal(isPrivateIPv4('10.1.2.3'), true);
  assert.equal(isPrivateIPv4('169.254.169.254'), true);
  assert.equal(isPrivateIPv4('93.184.216.34'), false);
  assert.equal(isPrivateIPv6('::1'), true);
  assert.equal(isPrivateIPv6('fc00::1'), true);
  assert.equal(isPrivateIPv6('fe80::1'), true);
  assert.equal(isBlockedAddress('8.8.8.8'), false);
});

test('assertPublicHttpUrl rejects localhost, private literals, and private DNS answers', async () => {
  await assert.rejects(() => assertPublicHttpUrl('http://localhost/'));
  await assert.rejects(() => assertPublicHttpUrl('http://192.168.1.10/'));
  await assert.rejects(() => assertPublicHttpUrl('https://service.test/', {
    lookup: async () => [{ address: '10.0.0.5', family: 4 }]
  }));

  const parsedUrl = await assertPublicHttpUrl('https://service.test/path', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  assert.equal(parsedUrl.href, 'https://service.test/path');
});

test('safeFetch validates every redirect target before following it', async () => {
  const fetch = async () => new Response(null, {
    status: 302,
    headers: {
      location: 'http://127.0.0.1/private'
    }
  });

  await assert.rejects(() => safeFetch('https://service.test/icon.png', {
    fetch,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    timeoutMs: 1000
  }));
});

test('safeFetch allows private network only when explicitly requested', async () => {
  const fetch = async () => new Response('ok', { status: 200 });

  await assert.rejects(() => safeFetch('http://127.0.0.1/icon.svg', {
    fetch,
    timeoutMs: 1000
  }));

  const response = await safeFetch('http://127.0.0.1/icon.svg', {
    allowPrivateNetwork: true,
    fetch,
    timeoutMs: 1000
  });
  assert.equal(response.status, 200);
});

test('safeFetch applies proxy dispatcher when proxy is configured', async () => {
  let fetchOptions;
  const fetch = async (url, options) => {
    fetchOptions = options;
    return new Response('ok', { status: 200 });
  };

  const response = await safeFetch('https://service.test/icon.svg', {
    fetch,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    proxy: {
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: ''
    },
    timeoutMs: 1000
  });

  assert.equal(response.status, 200);
  assert.ok(fetchOptions.dispatcher);
});

test('safeFetch honors no_proxy entries before applying proxy dispatcher', async () => {
  let fetchOptions;
  const fetch = async (url, options) => {
    fetchOptions = options;
    return new Response('ok', { status: 200 });
  };

  const response = await safeFetch('http://10.1.2.3/icon.svg', {
    allowPrivateNetwork: true,
    fetch,
    proxy: {
      httpProxy: 'http://127.0.0.1:7890',
      noProxy: '127.0.0.1,10.0.0.0/8'
    },
    timeoutMs: 1000
  });

  assert.equal(response.status, 200);
  assert.equal(fetchOptions.dispatcher, undefined);
});

test('safeFetch allowlist permits only the named private host', async () => {
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(String(url));
    return new Response('ok', { status: 200 });
  };

  const allowed = await safeFetch('http://192.168.1.10/icon.svg', {
    fetch,
    privateNetworkHosts: ['192.168.1.10'],
    timeoutMs: 1000
  });
  assert.equal(allowed.status, 200);

  await assert.rejects(() => safeFetch('http://192.168.1.1/secret', {
    fetch,
    privateNetworkHosts: ['192.168.1.10'],
    timeoutMs: 1000
  }));
  assert.deepEqual(fetched, ['http://192.168.1.10/icon.svg']);
});

test('safeFetch allowlist does not follow a redirect to a different private host', async () => {
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(String(url));
    return new Response(null, {
      status: 302,
      headers: { location: 'http://192.168.1.1/secret' }
    });
  };

  await assert.rejects(() => safeFetch('http://192.168.1.10/', {
    fetch,
    privateNetworkHosts: ['192.168.1.10'],
    timeoutMs: 1000
  }));
  assert.deepEqual(fetched, ['http://192.168.1.10/']);
});

test('safeFetch timeout stays active until the response body is read', async () => {
  let timer;
  let finishPull;
  const fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      return new Promise((resolve) => {
        finishPull = resolve;
        timer = setTimeout(() => {
          try {
            controller.enqueue(new TextEncoder().encode('slow'));
            controller.close();
          } catch {
            // The timeout already cancelled this body.
          }
          resolve();
        }, 400);
      });
    },
    cancel() {
      clearTimeout(timer);
      finishPull?.();
    }
  }), { status: 200 });

  const startedAt = Date.now();
  await assert.rejects(async () => {
    const response = await safeFetch('https://service.test/icon.svg', {
      fetch,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      timeoutMs: 100
    });
    await response.arrayBuffer();
  }, (error) => {
    assert.equal(error.code, 'FETCH_TIMEOUT');
    assert.equal(error.timeoutMs, 100);
    return true;
  });
  assert.ok(Date.now() - startedAt < 300, `body download exceeded the timeout window (${Date.now() - startedAt}ms)`);
});

test('safeFetch reports request timeouts explicitly', async () => {
  const fetch = async (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(new DOMException('This operation was aborted', 'AbortError'));
    });
  });

  await assert.rejects(() => safeFetch('https://service.test/icon.svg', {
    fetch,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    timeoutMs: 1
  }), (error) => {
    assert.equal(error.code, 'FETCH_TIMEOUT');
    assert.equal(error.timeoutMs, 1);
    assert.equal(error.message, 'Request timed out');
    return true;
  });
});

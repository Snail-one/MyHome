export function createApiClient({ onUnauthorized } = {}) {
    const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
    let csrfToken = '';
    let csrfTokenPromise = null;

    async function getCsrfToken() {
        if (csrfToken) return csrfToken;
        if (!csrfTokenPromise) {
            csrfTokenPromise = fetch('/api/csrf', {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' }
            })
                .then(async response => {
                    const contentType = response.headers.get('content-type') || '';
                    const data = contentType.includes('application/json') ? await response.json() : null;
                    if (!response.ok || !data?.csrfToken) {
                        throw new Error(data?.error || '无法获取安全令牌');
                    }
                    csrfToken = data.csrfToken;
                    return csrfToken;
                })
                .finally(() => {
                    csrfTokenPromise = null;
                });
        }
        return csrfTokenPromise;
    }

    return async function apiRequest(path, options = {}) {
        const method = String(options.method || 'GET').toUpperCase();
        const fetchOptions = {
            credentials: 'same-origin',
            ...options,
            headers: {
                ...(options.headers || {})
            }
        };

        if (!safeMethods.has(method)) {
            fetchOptions.headers['X-CSRF-Token'] = await getCsrfToken();
        }

        if (
            fetchOptions.body &&
            !(fetchOptions.body instanceof FormData) &&
            typeof fetchOptions.body !== 'string'
        ) {
            fetchOptions.headers['Content-Type'] = 'application/json';
            fetchOptions.body = JSON.stringify(fetchOptions.body);
        }

        let response;
        try {
            response = await fetch(path, fetchOptions);
        } catch {
            throw new Error('无法连接到服务器，请确认 Node 服务已启动');
        }

        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json') ? await response.json() : null;

        if (response.status === 401 && path !== '/api/login') {
            csrfToken = '';
            if (onUnauthorized) onUnauthorized(data?.error || '登录已过期，请重新登录');
            throw new Error(data?.error || '未登录');
        }

        if (!response.ok) {
            throw new Error(data?.error || '请求失败');
        }

        return data;
    };
}

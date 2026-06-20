export function getParsedHttpUrl(url) {
    if (!url || typeof url !== 'string' || !url.trim()) return null;

    try {
        const trimmed = url.trim();
        if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null;
        const normalizedUrl = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
        const parsedUrl = new URL(normalizedUrl);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
        return parsedUrl;
    } catch {
        return null;
    }
}

export function getDomainFromUrl(url) {
    const parsedUrl = getParsedHttpUrl(url);
    return parsedUrl ? parsedUrl.hostname : null;
}

export function getCachedFaviconUrl(url, options = {}) {
    const parsedUrl = getParsedHttpUrl(url);
    if (!parsedUrl) return null;

    const params = new URLSearchParams({
        url: parsedUrl.href,
        v: String(options.version || 0)
    });
    if (options.refresh) params.set('refresh', '1');
    if (options.cacheOnly) params.set('cacheOnly', '1');
    return `/api/icon?${params.toString()}`;
}

export function getLocalIconCacheKey(url) {
    const parsedUrl = getParsedHttpUrl(url);
    return parsedUrl ? parsedUrl.href : null;
}

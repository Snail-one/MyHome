export function getParsedHttpUrl(url) {
    if (!url || typeof url !== 'string' || !url.trim()) return null;

    try {
        const trimmed = url.trim();
        if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null;
        const normalizedUrl = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
        const parsedUrl = new URL(normalizedUrl);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
        if (parsedUrl.username || parsedUrl.password) return null;
        parsedUrl.hash = '';
        return parsedUrl;
    } catch {
        return null;
    }
}

export function getDomainFromUrl(url) {
    const parsedUrl = getParsedHttpUrl(url);
    return parsedUrl ? parsedUrl.hostname : null;
}

export function getIconFileUrl(entityType, entityId, version = 1) {
    if (!entityType || !entityId) return '';
    return `/api/icons/${entityType}/${encodeURIComponent(String(entityId))}/file?v=${encodeURIComponent(String(version || 1))}`;
}

export function getIconStatusUrl(entityType, entityId) {
    if (!entityType || !entityId) return '';
    return `/api/icons/${entityType}/${encodeURIComponent(String(entityId))}/status`;
}

export function getIconResolveUrl(entityType, entityId) {
    if (!entityType || !entityId) return '';
    return `/api/icons/${entityType}/${encodeURIComponent(String(entityId))}/resolve`;
}

export function buildFaviconCandidates(url, options = {}) {
    const parsedUrl = getParsedHttpUrl(url);
    if (!parsedUrl) return [];

    const rootIconPaths = [
        '/android-chrome-192x192.png',
        '/apple-touch-icon.png',
        '/favicon.svg',
        '/favicon-192x192.png',
        '/favicon-32x32.png',
        '/favicon.png',
        '/favicon.ico'
    ];
    const extendedRootIconPaths = [
        '/android-chrome-512x512.png',
        '/android-chrome-384x384.png',
        '/android-chrome-256x256.png',
        '/apple-touch-icon-precomposed.png',
        '/apple-touch-icon-180x180.png',
        '/apple-touch-icon-167x167.png',
        '/apple-touch-icon-152x152.png',
        '/apple-touch-icon-144x144.png',
        '/apple-touch-icon-120x120.png',
        '/mstile-310x310.png',
        '/mstile-150x150.png',
        '/favicon-512x512.png',
        '/favicon-384x384.png',
        '/favicon-256x256.png',
        '/favicon-196x196.png',
        '/favicon-128x128.png',
        '/favicon-96x96.png',
        '/favicon-64x64.png',
        '/favicon-48x48.png',
        '/favicon-16x16.png',
        '/images/favicon.ico',
        '/images/favicon.png',
        '/static/favicon.ico',
        '/static/favicon.png',
        '/assets/favicon.ico',
        '/assets/favicon.png',
        '/front-static/favicon.ico'
    ];
    const nestedIconNames = ['favicon.svg', 'favicon.png', 'favicon.ico'];
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean).slice(0, options.extended ? 3 : 1);
    const pathPrefixes = [];
    let currentPrefix = '';

    for (const segment of pathSegments) {
        currentPrefix += `/${segment}`;
        pathPrefixes.unshift(currentPrefix);
    }

    const candidates = [];
    pathPrefixes.forEach(prefix => {
        nestedIconNames.forEach(iconName => {
            candidates.push(`${parsedUrl.origin}${prefix}/${iconName}`);
        });
    });
    [...rootIconPaths, ...(options.extended ? extendedRootIconPaths : [])].forEach(iconPath => {
        candidates.push(`${parsedUrl.origin}${iconPath}`);
    });

    return [...new Set(candidates)];
}

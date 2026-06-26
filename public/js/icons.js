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

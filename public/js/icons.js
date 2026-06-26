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

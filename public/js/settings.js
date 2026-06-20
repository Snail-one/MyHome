export function normalizeLinkSize(size, fallback = 'medium') {
    return ['small', 'medium', 'large', 'xlarge'].includes(size) ? size : fallback;
}

export function calculateMaxAvailableLayoutColumns(options) {
    const {
        isMobile = false,
        configuredMax = 6,
        cardWidth = 120,
        gap = 16,
        availableWidth = 0,
        linkCount = 1
    } = options || {};

    if (isMobile) return 1;

    const safeCardWidth = Number.isFinite(cardWidth) && cardWidth > 0 ? cardWidth : 120;
    const safeGap = Number.isFinite(gap) && gap >= 0 ? gap : 16;
    const safeWidth = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 0;
    const columns = Math.floor((safeWidth + safeGap) / (safeCardWidth + safeGap));
    return Math.max(1, Math.min(configuredMax, columns || 1, Math.max(1, linkCount)));
}

export function getLayoutColumnOptions(maxColumns) {
    const max = Math.max(1, Number.parseInt(maxColumns, 10) || 1);
    return [0, ...Array.from({ length: max }, (_, index) => index + 1)];
}

export function isValidBackgroundUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('/uploads/backgrounds/')) return !trimmed.includes('..');

    try {
        const parsedUrl = new URL(trimmed);
        return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    } catch {
        return false;
    }
}

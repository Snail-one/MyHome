export function getEffectiveUrl(link) {
    const url = link?.url && link.url.trim();
    try {
        if (!url) return '#';
        if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) return '#';
        const parsedUrl = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return '#';
        return parsedUrl.href;
    } catch {
        return '#';
    }
}

export function setLinkCollection(state, linkType, links) {
    if (linkType === 'email') {
        state.emailLinks = links;
        return;
    }

    if (linkType === 'project') {
        state.projectLinks = links;
        return;
    }

    state.links = links;
}

export function getLinkCollection(state, linkType) {
    if (linkType === 'email') return state.emailLinks;
    if (linkType === 'project') return state.projectLinks;
    return state.links;
}

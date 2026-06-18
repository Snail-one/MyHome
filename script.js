// ==================== 搜索引擎配置 ====================
const defaultSearchEngines = {
    google: {
        name: 'Google',
        urlTemplate: 'https://www.google.com/search?q={query}',
        placeholder: '搜索 Google...'
    },
    youtube: {
        name: 'YouTube',
        urlTemplate: 'https://www.youtube.com/results?search_query={query}',
        placeholder: '在 YouTube 搜索...'
    },
    github: {
        name: 'GitHub',
        urlTemplate: 'https://github.com/search?q={query}',
        placeholder: '搜索 GitHub...'
    },
    bilibili: {
        name: '哔哩哔哩',
        urlTemplate: 'https://search.bilibili.com/all?keyword={query}',
        placeholder: '在 B 站搜索...'
    }
};

let searchEngines = { ...defaultSearchEngines };

const DEFAULT_SETTINGS = {
    layoutColumns: 0,
    projectLayoutColumns: 0,
    editMode: false,
    projectLinkDisplayMode: 'centered',
    bookmarkLinkDisplayMode: 'default',
    projectLinkSize: 'medium',
    bookmarkLinkSize: 'medium',
    backgroundUrl: ''
};
const REQUIRED_EMAIL_LINK_KEYS = new Set(['google-mail']);
const LOCAL_ICON_CACHE_STORAGE_KEY = 'my-home-local-icon-cache-v1';
const LINK_SIZE_OPTIONS = [
    { size: 'small', label: '小' },
    { size: 'medium', label: '默认' },
    { size: 'large', label: '大' },
    { size: 'xlarge', label: '超大' }
];
const LINK_SIZE_CONFIG = {
    small: {
        cardWidth: '96px',
        minHeight: '78px',
        addCardMinHeight: '78px',
        iconSize: '30px',
        titleSize: '13px',
        cardGap: '6px',
        cardPadding: '10px',
        gridGap: '12px',
        addIconSize: '34px',
        addIconSvgSize: '20px'
    },
    medium: {
        cardWidth: '120px',
        minHeight: 'auto',
        addCardMinHeight: '92px',
        iconSize: 'clamp(30px, 3.5vmin, 40px)',
        titleSize: 'clamp(14px, 1.6vw, 18px)',
        cardGap: 'clamp(6px, 0.8vw, 10px)',
        cardPadding: 'clamp(10px, 1.2vw, 16px)',
        gridGap: 'var(--nav-gap)',
        addIconSize: '42px',
        addIconSvgSize: '24px'
    },
    large: {
        cardWidth: '144px',
        minHeight: '112px',
        addCardMinHeight: '112px',
        iconSize: '48px',
        titleSize: '17px',
        cardGap: '12px',
        cardPadding: '16px',
        gridGap: '18px',
        addIconSize: '50px',
        addIconSvgSize: '28px'
    },
    xlarge: {
        cardWidth: '168px',
        minHeight: '132px',
        addCardMinHeight: '132px',
        iconSize: '56px',
        titleSize: '18px',
        cardGap: '14px',
        cardPadding: '18px',
        gridGap: '20px',
        addIconSize: '58px',
        addIconSvgSize: '32px'
    }
};

const appState = {
    user: null,
    links: [],
    emailLinks: [],
    projectLinks: [],
    searchEngineRecords: [],
    settings: { ...DEFAULT_SETTINGS }
};

let currentEngine = 'google';
let layoutColumns = 0;
let projectLayoutColumns = 0;
let projectLinkDisplayMode = 'centered';
let bookmarkLinkDisplayMode = 'default';
let projectLinkSize = 'medium';
let bookmarkLinkSize = 'medium';
let editMode = false;
let draggedCard = null;
let draggedIndex = null;
let draggedLinkType = 'website';
let isDragging = false;
let selectedBackgroundFile = null;
let previewObjectUrl = null;
let layoutResizeTimer = null;
let iconCacheVersion = Date.now();
let localIconCache = loadLocalIconCache();

// ==================== DOM 元素 ====================
const searchInput = document.querySelector('.search-input');
const searchBox = document.querySelector('.search-box');
const searchEngineSwitcher = document.querySelector('.search-engine-switcher');
const engineIndicator = document.querySelector('.current-engine');
const searchEngineIndicator = document.querySelector('.search-engine-indicator');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

// ==================== API ====================
async function apiRequest(path, options = {}) {
    const fetchOptions = {
        credentials: 'same-origin',
        ...options,
        headers: {
            ...(options.headers || {})
        }
    };

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
        showLoggedOut('登录已过期，请重新登录');
        throw new Error(data?.error || '未登录');
    }

    if (!response.ok) {
        throw new Error(data?.error || '请求失败');
    }

    return data;
}

async function loadAppData() {
    const [linksData, settingsData, searchEnginesData] = await Promise.all([
        apiRequest('/api/links'),
        apiRequest('/api/settings'),
        apiRequest('/api/search-engines')
    ]);

    appState.links = Array.isArray(linksData.links) ? linksData.links : [];
    appState.emailLinks = Array.isArray(linksData.emailLinks) ? linksData.emailLinks : [];
    appState.projectLinks = Array.isArray(linksData.projectLinks) ? linksData.projectLinks : [];
    appState.searchEngineRecords = Array.isArray(searchEnginesData.engines) ? searchEnginesData.engines : [];
    rebuildSearchEngines();
    renderSearchEngineButtons();
    renderSearchEngineList();
    applySettings(settingsData.settings || DEFAULT_SETTINGS);
    renderEmailLinks();
    renderProjectCards();
    renderNavCards();
}

async function saveSettingsPatch(patch) {
    const data = await apiRequest('/api/settings', {
        method: 'PUT',
        body: patch
    });
    applySettings(data.settings || DEFAULT_SETTINGS);
}

function applyLinksResponse(data) {
    appState.links = Array.isArray(data.links) ? data.links : [];
    appState.emailLinks = Array.isArray(data.emailLinks) ? data.emailLinks : [];
    appState.projectLinks = Array.isArray(data.projectLinks) ? data.projectLinks : [];
    renderEmailLinks();
    renderProjectCards();
    renderNavCards();
}

// ==================== 登录状态 ====================
function showLoggedOut(message = '') {
    const authScreen = document.getElementById('auth-screen');
    appState.user = null;
    appState.links = [];
    appState.emailLinks = [];
    appState.projectLinks = [];
    appState.searchEngineRecords = [];
    appState.settings = { ...DEFAULT_SETTINGS };
    currentEngine = 'google';
    rebuildSearchEngines();
    renderSearchEngineButtons();
    renderEmailLinks();
    renderProjectCards();
    document.body.classList.remove('auth-pending', 'logged-in');
    document.body.classList.add('logged-out');
    authScreen?.setAttribute('aria-hidden', 'false');
    closeModal('link-modal');
    closeModal('manage-modal');
    closeModal('background-modal');
    renderNavCards();
    applySettings(DEFAULT_SETTINGS);

    if (loginError) loginError.textContent = message;
    setTimeout(() => document.getElementById('login-username')?.focus(), 0);
}

function showLoggedIn(user) {
    const authScreen = document.getElementById('auth-screen');
    appState.user = user;
    document.body.classList.remove('auth-pending', 'logged-out');
    document.body.classList.add('logged-in');
    authScreen?.setAttribute('aria-hidden', 'true');
    if (loginError) loginError.textContent = '';
    setTimeout(() => searchInput?.focus(), 0);
}

function bindAuth() {
    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submitBtn = loginForm.querySelector('button[type="submit"]');
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;

        loginError.textContent = '';
        submitBtn.disabled = true;

        try {
            const data = await apiRequest('/api/login', {
                method: 'POST',
                body: { username, password }
            });
            await loadAppData();
            showLoggedIn(data.user);
            loginForm.reset();
        } catch (error) {
            loginError.textContent = error.message;
        } finally {
            submitBtn.disabled = false;
        }
    });

    logoutBtn.addEventListener('click', async () => {
        try {
            await apiRequest('/api/logout', { method: 'POST' });
        } catch (error) {
            console.warn(error.message);
        } finally {
            showLoggedOut('');
        }
    });
}

async function restoreSession() {
    try {
        const data = await apiRequest('/api/me');
        if (!data.authenticated) {
            showLoggedOut('');
            return;
        }

        await loadAppData();
        showLoggedIn(data.user);
    } catch (error) {
        showLoggedOut(error.message);
    }
}

// ==================== 搜索 ====================
function bindSearchEvents() {
    searchEngineSwitcher.addEventListener('click', (event) => {
        const btn = event.target.closest('.engine-btn');
        if (!btn) return;
        switchSearchEngine(btn.dataset.engine);
    });

    searchEngineIndicator.addEventListener('click', performSearch);

    searchInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') performSearch();
    });

    searchInput.addEventListener('focus', () => {
        searchBox.classList.add('focused');
    });

    searchInput.addEventListener('blur', () => {
        searchBox.classList.remove('focused');
    });
}

function getEngineButtons() {
    return document.querySelectorAll('.engine-btn');
}

function getEngineKey(engine) {
    return engine.engineKey || `custom-${engine.id}`;
}

function getFallbackSearchEngineRecords() {
    return Object.entries(defaultSearchEngines).map(([engineKey, config]) => ({
        id: engineKey,
        engineKey,
        name: config.name,
        urlTemplate: config.urlTemplate
    }));
}

function getRenderableSearchEngines() {
    return appState.searchEngineRecords.length ? appState.searchEngineRecords : getFallbackSearchEngineRecords();
}

function rebuildSearchEngines() {
    searchEngines = {};
    getRenderableSearchEngines().forEach(engine => {
        searchEngines[getEngineKey(engine)] = {
            name: engine.name,
            urlTemplate: engine.urlTemplate,
            placeholder: `搜索 ${engine.name}...`
        };
    });

    if (!Object.keys(searchEngines).length) {
        searchEngines = { ...defaultSearchEngines };
    }
}

function getSearchTemplateDomain(urlTemplate) {
    if (!urlTemplate) return null;
    return getDomainFromUrl(urlTemplate.replaceAll('{query}', 'test'));
}

function renderSearchEngineButtons() {
    searchEngineSwitcher.innerHTML = '';

    getRenderableSearchEngines().forEach(engine => {
        const key = getEngineKey(engine);
        const domain = getSearchTemplateDomain(engine.urlTemplate);
        const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32` : '';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'engine-btn';
        btn.dataset.engine = key;
        btn.innerHTML = `
            ${faviconUrl
                ? `<img src="${faviconUrl}" alt="" class="engine-favicon">`
                : '<span class="engine-favicon" aria-hidden="true"></span>'
            }
            <span>${escapeHtml(engine.name)}</span>
        `;
        searchEngineSwitcher.appendChild(btn);
    });

    if (!searchEngines[currentEngine]) {
        currentEngine = searchEngines.google ? 'google' : Object.keys(searchEngines)[0];
    }
    updateSearchEngine(currentEngine);
}

function buildSearchUrl(engineConfig, query) {
    const encodedQuery = encodeURIComponent(query);
    if (engineConfig.urlTemplate) {
        if (engineConfig.urlTemplate.includes('{query}')) {
            return engineConfig.urlTemplate.replaceAll('{query}', encodedQuery);
        }

        const separator = engineConfig.urlTemplate.includes('?') ? '&' : '?';
        return `${engineConfig.urlTemplate}${separator}q=${encodedQuery}`;
    }

    return engineConfig.url ? engineConfig.url + encodedQuery : '#';
}

function switchSearchEngine(engine) {
    if (!searchEngines[engine]) {
        console.error('未知的搜索引擎:', engine);
        return;
    }

    currentEngine = engine;
    updateSearchEngine(engine);

    searchBox.style.animation = 'none';
    setTimeout(() => {
        searchBox.style.animation = '';
    }, 10);
}

function updateSearchEngine(engine) {
    const engineConfig = searchEngines[engine];
    searchInput.placeholder = engineConfig.placeholder;
    engineIndicator.textContent = engineConfig.name;

    getEngineButtons().forEach(btn => {
        if (btn.dataset.engine === engine) {
            btn.classList.add('active');
            btn.style.animation = 'pulse 0.3s ease';
            setTimeout(() => {
                btn.style.animation = '';
            }, 300);
        } else {
            btn.classList.remove('active');
        }
    });
}

function performSearch() {
    const query = searchInput.value.trim();
    if (!query) {
        searchBox.style.animation = 'shake 0.5s ease';
        setTimeout(() => {
            searchBox.style.animation = '';
        }, 500);
        return;
    }

    const engineConfig = searchEngines[currentEngine];
    window.open(buildSearchUrl(engineConfig, query), '_blank');
}

// ==================== 快捷键支持 ====================
document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        searchInput.focus();
        searchInput.select();
    }

    if (event.key === 'Escape') {
        searchInput.value = '';
        searchInput.blur();
    }

    if ((event.ctrlKey || event.metaKey) && event.key === '1') {
        event.preventDefault();
        switchSearchEngine('google');
    }

    if ((event.ctrlKey || event.metaKey) && event.key === '2') {
        event.preventDefault();
        switchSearchEngine('github');
    }

    if ((event.ctrlKey || event.metaKey) && event.key === '3') {
        event.preventDefault();
        switchSearchEngine('bilibili');
    }

    if ((event.ctrlKey || event.metaKey) && event.key === '4') {
        event.preventDefault();
        switchSearchEngine('youtube');
    }
});

// ==================== 导航链接 ====================
function getLinks() {
    return appState.links;
}

function getEmailLinks() {
    return appState.emailLinks;
}

function getProjectLinks() {
    return appState.projectLinks;
}

function setLinkCollection(linkType, links) {
    if (linkType === 'project') {
        appState.projectLinks = links;
        return;
    }

    appState.links = links;
}

function getLinkContainer(linkType) {
    return document.getElementById(linkType === 'project' ? 'project-links-container' : 'nav-links-container');
}

function getLinkEmptyState(linkType) {
    return document.getElementById(linkType === 'project' ? 'project-empty-state' : 'nav-empty-state');
}

function getDomainFromUrl(url) {
    if (!url || typeof url !== 'string' || !url.trim()) return null;
    try {
        const normalizedUrl = url.startsWith('http') ? url : 'https://' + url;
        const parsedUrl = new URL(normalizedUrl);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
        return parsedUrl.hostname;
    } catch {
        return null;
    }
}

function getParsedHttpUrl(url) {
    if (!url || typeof url !== 'string' || !url.trim()) return null;

    try {
        const normalizedUrl = url.trim().startsWith('http') ? url.trim() : 'https://' + url.trim();
        const parsedUrl = new URL(normalizedUrl);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
        return parsedUrl;
    } catch {
        return null;
    }
}

function getCachedFaviconUrl(url) {
    const parsedUrl = getParsedHttpUrl(url);
    if (!parsedUrl) return null;
    return `/api/icon?url=${encodeURIComponent(parsedUrl.href)}&v=${iconCacheVersion}`;
}

function loadLocalIconCache() {
    try {
        const cached = JSON.parse(localStorage.getItem(LOCAL_ICON_CACHE_STORAGE_KEY) || '{}');
        return cached && typeof cached === 'object' ? cached : {};
    } catch {
        return {};
    }
}

function saveLocalIconCache() {
    try {
        const entries = Object.entries(localIconCache)
            .sort(([, left], [, right]) => (right.savedAt || 0) - (left.savedAt || 0))
            .slice(0, 200);
        localIconCache = Object.fromEntries(entries);
        localStorage.setItem(LOCAL_ICON_CACHE_STORAGE_KEY, JSON.stringify(localIconCache));
    } catch {
        // localStorage can be unavailable or full; icons still work without this cache.
    }
}

function clearLocalIconCache() {
    localIconCache = {};
    try {
        localStorage.removeItem(LOCAL_ICON_CACHE_STORAGE_KEY);
    } catch {
        // Ignore localStorage failures.
    }
}

function getLocalIconCacheKey(url) {
    const parsedUrl = getParsedHttpUrl(url);
    return parsedUrl ? parsedUrl.href : null;
}

function getLocalCachedFaviconUrl(url) {
    const cacheKey = getLocalIconCacheKey(url);
    return cacheKey ? localIconCache[cacheKey]?.iconUrl || null : null;
}

function setLocalCachedFaviconUrl(targetUrl, iconUrl) {
    if (!targetUrl || !iconUrl) return;
    localIconCache[targetUrl] = {
        iconUrl,
        savedAt: Date.now()
    };
    saveLocalIconCache();
}

function removeLocalCachedFaviconUrl(targetUrl) {
    if (!targetUrl || !localIconCache[targetUrl]) return;
    delete localIconCache[targetUrl];
    saveLocalIconCache();
}

function getLocalFaviconCandidates(url) {
    const parsedUrl = getParsedHttpUrl(url);
    if (!parsedUrl) return [];

    const rootIconPaths = [
        '/favicon.ico',
        '/favicon.png',
        '/favicon.svg',
        '/favicon-32x32.png',
        '/favicon-16x16.png',
        '/apple-touch-icon.png',
        '/apple-touch-icon-precomposed.png',
        '/images/favicon.ico',
        '/images/favicon.png',
        '/static/favicon.ico',
        '/assets/favicon.ico',
        '/front-static/favicon.ico'
    ];
    const nestedIconNames = ['favicon.ico', 'favicon.png', 'favicon.svg', 'apple-touch-icon.png'];
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean).slice(0, 3);
    const pathPrefixes = [];
    let currentPrefix = '';

    for (const segment of pathSegments) {
        currentPrefix += `/${segment}`;
        pathPrefixes.unshift(currentPrefix);
    }

    const candidates = [];
    rootIconPaths.forEach(iconPath => {
        candidates.push(`${parsedUrl.origin}${iconPath}`);
    });
    pathPrefixes.forEach(prefix => {
        nestedIconNames.forEach(iconName => {
            candidates.push(`${parsedUrl.origin}${prefix}/${iconName}`);
        });
    });

    const cachedIconUrl = getLocalCachedFaviconUrl(parsedUrl.href);
    if (cachedIconUrl) candidates.unshift(cachedIconUrl);

    return [...new Set(candidates)];
}

function handleFaviconLoad(event) {
    const img = event.currentTarget;
    if (img.iconSource === 'local') {
        setLocalCachedFaviconUrl(img.iconTargetUrl, img.iconCurrentUrl || img.getAttribute('src'));
    }
}

function handleFaviconError(event) {
    const img = event.currentTarget;
    const candidates = img.localFaviconCandidates || [];
    let nextIndex = (img.localFaviconIndex ?? -1) + 1;

    while (nextIndex < candidates.length) {
        const nextUrl = candidates[nextIndex];
        nextIndex += 1;
        if (!nextUrl || nextUrl === img.iconCurrentUrl) continue;

        img.localFaviconIndex = nextIndex - 1;
        img.iconSource = 'local';
        img.iconCurrentUrl = nextUrl;
        img.src = nextUrl;
        return;
    }

    removeLocalCachedFaviconUrl(img.iconTargetUrl);
    img.style.display = 'none';
    if (img.nextElementSibling) img.nextElementSibling.style.display = 'block';
}

function getEffectiveUrl(link) {
    const url = link.url && link.url.trim();
    try {
        if (!url) return '#';
        const parsedUrl = new URL(url.startsWith('http') ? url : 'https://' + url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return '#';
        return parsedUrl.href;
    } catch {
        return '#';
    }
}

function getEffectiveEmailUrl(link) {
    return getEffectiveUrl(link);
}

function getMailIconSvg(className = 'email-link-icon') {
    return `
        <svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="5" width="18" height="14" rx="2"></rect>
            <path d="m3 7 9 6 9-6"></path>
        </svg>
    `;
}

function createEmailLinkElement(link, index) {
    const wrapper = document.createElement('div');
    const isRequired = REQUIRED_EMAIL_LINK_KEYS.has(link.linkKey);
    wrapper.className = 'email-link-wrapper';
    wrapper.dataset.index = index;
    wrapper.innerHTML = `
        <a href="${escapeAttribute(getEffectiveEmailUrl(link))}" target="_blank" rel="noopener noreferrer" class="email-link" data-index="${index}" title="${escapeAttribute(link.title || '邮箱登录')}">
            ${getMailIconSvg()}
            <span class="email-link-label">${escapeHtml(link.title || '邮箱登录')}</span>
        </a>
        ${isRequired ? '' : `
            <div class="email-link-actions">
                <button type="button" class="email-link-delete" data-index="${index}" title="删除邮箱链接">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2v2"/></svg>
                </button>
            </div>
        `}
    `;
    return wrapper;
}

function createAddEmailLinkElement() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'email-link email-add-link';
    button.title = '添加邮箱登录';
    button.setAttribute('aria-label', '添加邮箱登录');
    button.innerHTML = `
        ${getMailIconSvg()}
        <span class="email-link-label">添加邮箱</span>
    `;
    return button;
}

function renderEmailLinks() {
    const container = document.getElementById('email-links-container');
    if (!container) return;

    container.innerHTML = '';
    getEmailLinks().forEach((link, index) => {
        container.appendChild(createEmailLinkElement(link, index));
    });

    if (editMode) {
        container.appendChild(createAddEmailLinkElement());
    }

    container.hidden = !getEmailLinks().length && !editMode;
}

function createNavCardElement(link, index, options = {}) {
    const { noAnimation = false, linkType = 'website' } = options;
    const href = getEffectiveUrl(link);
    const localCachedFaviconUrl = getLocalCachedFaviconUrl(link.url);
    const serverFaviconUrl = getCachedFaviconUrl(link.url);
    const faviconUrl = localCachedFaviconUrl || serverFaviconUrl;
    const localFaviconCandidates = getLocalFaviconCandidates(link.url);
    const iconTargetUrl = getLocalIconCacheKey(link.url);
    const fallbackFavicon = '<svg class="nav-favicon-fallback" style="display:none" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';

    const card = document.createElement('div');
    card.className = 'nav-card-wrapper' + (noAnimation ? ' no-animation' : '');
    card.dataset.index = index;
    card.dataset.linkType = linkType;

    if (!noAnimation) {
        card.style.animationDelay = `${0.3 + (index * 0.05)}s`;
    }

    card.innerHTML = `
        <a href="${href}" target="_blank" rel="noopener noreferrer" class="nav-card" data-index="${index}" data-link-type="${linkType}" draggable="true">
            <div class="nav-icon">
                ${faviconUrl
                    ? `<img src="${escapeAttribute(faviconUrl)}" alt="" class="nav-favicon">${fallbackFavicon}`
                    : fallbackFavicon.replace('style="display:none"', '')
                }
            </div>
            <div class="nav-info">
                <div class="nav-title">${escapeHtml(link.title || '未命名')}</div>
            </div>
        </a>
        <div class="nav-card-actions">
            <button type="button" class="nav-card-delete" data-index="${index}" title="删除">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2v2"/></svg>
            </button>
        </div>
    `;

    const faviconImg = card.querySelector('.nav-favicon');
    if (faviconImg) {
        faviconImg.iconTargetUrl = iconTargetUrl;
        faviconImg.iconSource = localCachedFaviconUrl ? 'local' : 'server';
        faviconImg.iconCurrentUrl = faviconUrl;
        faviconImg.localFaviconCandidates = localFaviconCandidates;
        faviconImg.localFaviconIndex = localCachedFaviconUrl
            ? localFaviconCandidates.indexOf(localCachedFaviconUrl)
            : -1;
        faviconImg.addEventListener('load', handleFaviconLoad);
        faviconImg.addEventListener('error', handleFaviconError);
    }

    const navCard = card.querySelector('.nav-card');
    navCard.addEventListener('dragstart', handleDragStart);
    navCard.addEventListener('dragend', handleDragEnd);
    navCard.addEventListener('dragover', handleDragOver);
    navCard.addEventListener('drop', handleDrop);
    navCard.addEventListener('dragenter', handleDragEnter);
    navCard.addEventListener('dragleave', handleDragLeave);

    navCard.addEventListener('mouseenter', function() {
        this.classList.remove('hover-ripple');
        void this.offsetWidth;
        this.classList.add('hover-ripple');
    });

    navCard.addEventListener('mouseleave', function() {
        this.classList.remove('hover-ripple');
    });

    return card;
}

function createAddLinkCardElement(linkType = 'website') {
    const isProject = linkType === 'project';
    const card = document.createElement('div');
    card.className = 'nav-card-wrapper nav-add-wrapper';
    card.dataset.linkType = linkType;
    card.innerHTML = `
        <button type="button" class="nav-card nav-add-card" data-link-type="${linkType}" title="${isProject ? '添加个人项目' : '添加网址'}" aria-label="${isProject ? '添加个人项目' : '添加网址'}">
            <span class="nav-add-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
            </span>
        </button>
    `;
    return card;
}

function updateLinkEmptyState(linkType = 'website') {
    const emptyState = getLinkEmptyState(linkType);
    const links = getLinkCollection(linkType);
    if (!emptyState) return;
    emptyState.style.display = links.length || editMode ? 'none' : 'block';
}

function syncAddLinkCard(linkType = 'website') {
    const container = getLinkContainer(linkType);
    const emptyState = getLinkEmptyState(linkType);
    if (!container || !emptyState) return;

    const existingAddCard = container.querySelector('.nav-add-wrapper');
    if (!editMode) {
        existingAddCard?.remove();
        updateLinkEmptyState(linkType);
        return;
    }

    if (!existingAddCard) {
        container.insertBefore(createAddLinkCardElement(linkType), emptyState);
    }

    updateLinkEmptyState(linkType);
}

function renderLinkCards(linkType = 'website') {
    const container = getLinkContainer(linkType);
    const emptyState = getLinkEmptyState(linkType);
    const links = getLinkCollection(linkType);
    if (!container || !emptyState) return;

    container.querySelectorAll('.nav-card-wrapper').forEach(el => el.remove());
    updateLinkEmptyState(linkType);

    links.forEach((link, index) => {
        const card = createNavCardElement(link, index, { linkType });
        container.insertBefore(card, emptyState);
    });

    updateEditModeUI();
}

function renderNavCards() {
    renderLinkCards('website');
}

function renderProjectCards() {
    const section = document.getElementById('project-links-section');
    if (section) {
        section.hidden = !getProjectLinks().length && !editMode;
    }
    renderLinkCards('project');
}

function handleDragStart(event) {
    draggedCard = this;
    draggedIndex = parseInt(this.dataset.index, 10);
    draggedLinkType = this.dataset.linkType || 'website';
    isDragging = true;
    this.style.transform = 'scale(0.98)';
    this.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.3)';
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedIndex);

    const dragImage = document.createElement('div');
    dragImage.style.width = '0px';
    dragImage.style.height = '0px';
    document.body.appendChild(dragImage);
    event.dataTransfer.setDragImage(dragImage, 0, 0);
    setTimeout(() => document.body.removeChild(dragImage), 0);
}

function handleDragEnd() {
    this.style.transform = '';
    this.style.boxShadow = '';
    document.querySelectorAll('.nav-card').forEach(card => {
        card.classList.remove('drag-over');
    });
    draggedCard = null;
    draggedIndex = null;
    draggedLinkType = 'website';
    setTimeout(() => { isDragging = false; }, 100);
}

function handleDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
}

function handleDragEnter(event) {
    event.preventDefault();
    if (this !== draggedCard) this.classList.add('drag-over');
}

function handleDragLeave() {
    this.classList.remove('drag-over');
}

async function handleDrop(event) {
    event.preventDefault();
    if (this === draggedCard) return;

    const linkType = this.dataset.linkType || 'website';
    if (linkType !== draggedLinkType) return;

    const dropIndex = parseInt(this.dataset.index, 10);
    if (draggedIndex === null || dropIndex === draggedIndex) return;

    const previousLinks = [...getLinkCollection(linkType)];
    const links = [...getLinkCollection(linkType)];
    const [draggedItem] = links.splice(draggedIndex, 1);
    links.splice(dropIndex, 0, draggedItem);
    setLinkCollection(linkType, links);

    const container = getLinkContainer(linkType);
    container.style.transition = 'none';
    renderLinkCards(linkType);
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            container.style.transition = '';
        });
    });

    try {
        const data = await apiRequest('/api/links/reorder', {
            method: 'PUT',
            body: { ids: links.map(link => link.id), type: linkType }
        });
        if (
            Array.isArray(data.links) &&
            Array.isArray(data.emailLinks) &&
            Array.isArray(data.projectLinks)
        ) {
            appState.links = data.links;
            appState.emailLinks = data.emailLinks;
            appState.projectLinks = data.projectLinks;
        } else {
            setLinkCollection(linkType, links);
        }
        renderEmailLinks();
        renderProjectCards();
        renderNavCards();
    } catch (error) {
        setLinkCollection(linkType, previousLinks);
        renderLinkCards(linkType);
        alert(error.message);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttribute(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
}

// ==================== 菜单管理 ====================
function openManageModal() {
    openModal('manage-modal');
    renderLayoutButtons();
    renderSearchEngineList();
}

function getLinkCollection(linkType) {
    if (linkType === 'email') return getEmailLinks();
    if (linkType === 'project') return getProjectLinks();
    return getLinks();
}

function openLinkModal(editIndex, linkType = 'website') {
    const form = document.getElementById('link-form');
    const modalTitle = document.getElementById('link-modal-title');
    const submitBtn = document.getElementById('link-form-submit');
    const urlInput = document.getElementById('link-url');
    const urlLabel = document.getElementById('link-url-label');
    const hint = document.getElementById('link-form-hint');
    const links = getLinkCollection(linkType);
    openModal('link-modal');
    form.reset();
    form.dataset.linkType = linkType;

    if (linkType === 'email') {
        urlInput.type = 'url';
        urlLabel.textContent = '邮箱登录地址';
        urlInput.placeholder = 'https://mail.google.com/';
        hint.textContent = '点击后会在新页面打开邮箱登录或访问页面。';
    } else if (linkType === 'project') {
        urlInput.type = 'url';
        urlLabel.textContent = '项目地址';
        urlInput.placeholder = 'https://example.com';
        hint.textContent = '用于展示你自己部署的服务，图标将根据项目地址自动获取。';
    } else {
        urlInput.type = 'url';
        urlLabel.textContent = '链接地址';
        urlInput.placeholder = 'https://example.com';
        hint.textContent = '图标将根据网址自动获取网页 favicon。';
    }

    if (typeof editIndex === 'number' && links[editIndex]) {
        const link = links[editIndex];
        document.getElementById('link-title').value = link.title || '';
        document.getElementById('link-url').value = link.url || '';
        form.dataset.editIndex = editIndex;
        modalTitle.textContent = linkType === 'email'
            ? '编辑邮箱'
            : linkType === 'project' ? '编辑个人项目' : '编辑网址';
        submitBtn.textContent = linkType === 'email'
            ? '更新邮箱'
            : linkType === 'project' ? '更新项目' : '更新链接';
    } else {
        delete form.dataset.editIndex;
        modalTitle.textContent = linkType === 'email'
            ? '添加邮箱'
            : linkType === 'project' ? '添加个人项目' : '添加网址';
        submitBtn.textContent = linkType === 'email'
            ? '添加邮箱'
            : linkType === 'project' ? '添加项目' : '添加链接';
    }

    setTimeout(() => document.getElementById('link-title')?.focus(), 0);
}

function closeLinkModal() {
    const form = document.getElementById('link-form');
    closeModal('link-modal');
    form?.reset();
    if (form) {
        delete form.dataset.editIndex;
        delete form.dataset.linkType;
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.setAttribute('aria-hidden', 'true');
    modal.classList.remove('modal-open');
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.setAttribute('aria-hidden', 'false');
    modal.classList.add('modal-open');
}

function resetSearchEngineForm() {
    const form = document.getElementById('search-engine-form');
    const submitBtn = document.getElementById('search-engine-submit');
    const cancelBtn = document.getElementById('search-engine-form-cancel');
    if (!form) return;

    form.reset();
    delete form.dataset.editId;
    if (submitBtn) submitBtn.textContent = '添加搜索引擎';
    if (cancelBtn) cancelBtn.hidden = true;
}

function editSearchEngine(engine) {
    const form = document.getElementById('search-engine-form');
    const submitBtn = document.getElementById('search-engine-submit');
    const cancelBtn = document.getElementById('search-engine-form-cancel');
    if (!form) return;

    document.getElementById('engine-name').value = engine.name || '';
    document.getElementById('engine-url-template').value = engine.urlTemplate || '';
    form.dataset.editId = engine.id;
    if (submitBtn) submitBtn.textContent = '更新搜索引擎';
    if (cancelBtn) cancelBtn.hidden = false;
    document.getElementById('engine-name')?.focus();
}

function renderSearchEngineList() {
    const list = document.getElementById('search-engine-list');
    if (!list) return;

    if (!appState.searchEngineRecords.length) {
        list.innerHTML = '<div class="engine-list-empty">暂无搜索引擎</div>';
        return;
    }

    list.innerHTML = appState.searchEngineRecords.map(engine => {
        const domain = getSearchTemplateDomain(engine.urlTemplate);
        const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32` : '';
        const isRequired = engine.engineKey === 'google';
        return `
            <div class="engine-list-item">
                ${faviconUrl
                    ? `<img src="${faviconUrl}" alt="" class="engine-list-icon">`
                    : '<span class="engine-list-icon" aria-hidden="true"></span>'
                }
                <div class="engine-list-info">
                    <div class="engine-list-name">${escapeHtml(engine.name)}</div>
                    <div class="engine-list-url">${escapeHtml(engine.urlTemplate)}</div>
                </div>
                <div class="engine-list-actions">
                    <button type="button" class="engine-list-edit" data-id="${engine.id}" title="编辑搜索引擎">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    ${isRequired ? '' : `
                        <button type="button" class="engine-list-delete" data-id="${engine.id}" title="删除搜索引擎">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2v2"/></svg>
                        </button>
                    `}
                </div>
            </div>
        `;
    }).join('');
}

async function toggleEditMode() {
    const previous = editMode;
    editMode = !editMode;
    appState.settings.editMode = editMode;
    updateEditModeUI();

    try {
        await saveSettingsPatch({ editMode });
    } catch (error) {
        editMode = previous;
        appState.settings.editMode = previous;
        updateEditModeUI();
        alert(error.message);
    }
}

function updateEditModeUI() {
    const editModeBtn = document.getElementById('edit-mode-btn');
    document.body.classList.toggle('edit-mode-active', editMode);
    if (editModeBtn) editModeBtn.classList.toggle('active', editMode);
    renderEmailLinks();
    syncAddLinkCard();
    const projectSection = document.getElementById('project-links-section');
    if (projectSection) projectSection.hidden = !getProjectLinks().length && !editMode;
    syncAddLinkCard('project');
}

async function deleteLink(index, linkType = 'website') {
    const links = getLinkCollection(linkType);
    if (index < 0 || index >= links.length) return;
    if (!confirm(`确定要删除链接「${links[index].title}」吗？`)) return;

    try {
        const data = await apiRequest(`/api/links/${links[index].id}`, { method: 'DELETE' });
        applyLinksResponse(data);
    } catch (error) {
        alert(error.message);
    }
}

function editLink(index, linkType = 'website') {
    openLinkModal(index, linkType);
}

function parseCssPixelValue(value, fallback = 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getMaxAvailableLayoutColumns(linkType = 'website') {
    if (window.matchMedia('(max-width: 768px)').matches) return 1;

    const container = getLinkContainer(linkType);
    const rootStyles = getComputedStyle(document.documentElement);
    const containerStyles = container ? getComputedStyle(container) : null;
    const configuredMax = Number.parseInt(rootStyles.getPropertyValue('--layout-max-cols'), 10) || 6;
    const cardWidth = parseCssPixelValue(
        containerStyles?.getPropertyValue('--link-card-width') || rootStyles.getPropertyValue('--nav-card-width'),
        120
    );
    const gap = parseCssPixelValue(containerStyles?.columnGap || rootStyles.getPropertyValue('--nav-gap'), 16);
    const measuredWidth = container?.getBoundingClientRect().width || 0;
    const fallbackWidth = Math.min(window.innerWidth * 0.94, 1400);
    const availableWidth = measuredWidth || fallbackWidth;
    const columns = Math.floor((availableWidth + gap) / (cardWidth + gap));
    const linkCount = Math.max(1, getLinkCollection(linkType).length);

    return Math.max(1, Math.min(configuredMax, columns, linkCount));
}

function getLayoutColumnsForLinkType(linkType = 'website') {
    return linkType === 'project' ? projectLayoutColumns : layoutColumns;
}

function updateLayoutButtonState() {
    document.querySelectorAll('.layout-btn').forEach(btn => {
        if (!btn.dataset.columns) return;
        const btnCols = parseInt(btn.dataset.columns, 10);
        const linkType = btn.dataset.linkType || 'website';
        btn.classList.toggle('active', btnCols === getLayoutColumnsForLinkType(linkType));
    });
}

function getDisplayModeForLinkType(linkType) {
    return linkType === 'project' ? projectLinkDisplayMode : bookmarkLinkDisplayMode;
}

function normalizeLinkSize(size) {
    return LINK_SIZE_CONFIG[size] ? size : 'medium';
}

function getLinkSizeForLinkType(linkType) {
    return linkType === 'project' ? projectLinkSize : bookmarkLinkSize;
}

function applyLinkDisplayMode(linkType, mode) {
    const normalizedMode = mode === 'centered' ? 'centered' : 'default';
    const container = getLinkContainer(linkType);
    if (!container) return;
    container.classList.toggle('layout-centered', normalizedMode === 'centered');
}

function applyLinkDisplayModes() {
    applyLinkDisplayMode('project', projectLinkDisplayMode);
    applyLinkDisplayMode('website', bookmarkLinkDisplayMode);
}

function applyLinkSize(linkType, size) {
    const normalizedSize = normalizeLinkSize(size);
    const container = getLinkContainer(linkType);
    if (!container) return;

    const config = LINK_SIZE_CONFIG[normalizedSize];
    container.style.setProperty('--link-card-width', config.cardWidth);
    container.style.setProperty('--link-card-min-height', config.minHeight);
    container.style.setProperty('--link-add-card-min-height', config.addCardMinHeight);
    container.style.setProperty('--link-card-icon-size', config.iconSize);
    container.style.setProperty('--link-card-title-size', config.titleSize);
    container.style.setProperty('--link-card-gap', config.cardGap);
    container.style.setProperty('--link-card-padding', config.cardPadding);
    container.style.setProperty('--link-card-grid-gap', config.gridGap);
    container.style.setProperty('--link-add-icon-size', config.addIconSize);
    container.style.setProperty('--link-add-icon-svg-size', config.addIconSvgSize);
}

function applyLinkSizeState(linkType, size) {
    const normalizedSize = normalizeLinkSize(size);
    if (linkType === 'project') {
        projectLinkSize = normalizedSize;
        appState.settings.projectLinkSize = normalizedSize;
    } else {
        bookmarkLinkSize = normalizedSize;
        appState.settings.bookmarkLinkSize = normalizedSize;
    }
    applyLinkSize(linkType, normalizedSize);
    updateLinkSizeButtonState();
    renderLayoutButtons();
}

function applyLinkSizes() {
    applyLinkSize('project', projectLinkSize);
    applyLinkSize('website', bookmarkLinkSize);
}

function updateDisplayModeButtonState() {
    document.querySelectorAll('.display-mode-btn').forEach(btn => {
        const linkType = btn.dataset.linkType || 'website';
        btn.classList.toggle('active', btn.dataset.mode === getDisplayModeForLinkType(linkType));
    });
}

function updateLinkSizeButtonState() {
    document.querySelectorAll('.link-size-btn').forEach(btn => {
        const linkType = btn.dataset.linkType || 'website';
        btn.classList.toggle('active', btn.dataset.size === getLinkSizeForLinkType(linkType));
    });
}

function renderDisplayModeButtons() {
    const groups = [
        { id: 'project-display-mode-buttons', linkType: 'project' },
        { id: 'bookmark-display-mode-buttons', linkType: 'website' }
    ];
    const buttons = [
        { mode: 'default', label: '默认' },
        { mode: 'centered', label: '居中' }
    ];

    groups.forEach(group => {
        const container = document.getElementById(group.id);
        if (!container) return;
        container.innerHTML = buttons.map(button => `
            <button type="button" class="layout-btn display-mode-btn" data-link-type="${group.linkType}" data-mode="${button.mode}">
                ${button.label}
            </button>
        `).join('');
    });

    updateDisplayModeButtonState();
}

function renderLinkSizeButtons() {
    const groups = [
        { id: 'project-link-size-buttons', linkType: 'project' },
        { id: 'bookmark-link-size-buttons', linkType: 'website' }
    ];

    groups.forEach(group => {
        const container = document.getElementById(group.id);
        if (!container) return;
        container.innerHTML = LINK_SIZE_OPTIONS.map(option => `
            <button type="button" class="layout-btn link-size-btn" data-link-type="${group.linkType}" data-size="${option.size}">
                ${option.label}
            </button>
        `).join('');
    });

    updateLinkSizeButtonState();
}

function renderLayoutButtons() {
    renderLayoutButtonGroup('project-layout-buttons', 'project-layout-options-hint', 'project');
    renderLayoutButtonGroup('layout-buttons', 'layout-options-hint', 'website');
    updateLayoutButtonState();
    renderDisplayModeButtons();
    renderLinkSizeButtons();
}

function renderLayoutButtonGroup(containerId, hintId, linkType = 'website') {
    const layoutButtons = document.getElementById(containerId);
    const hint = document.getElementById(hintId);
    if (!layoutButtons) return;

    const savedColumns = getLayoutColumnsForLinkType(linkType);
    const maxColumns = getMaxAvailableLayoutColumns(linkType);
    const buttons = [
        `<button type="button" class="layout-btn" data-link-type="${linkType}" data-columns="0" title="自动">自动</button>`
    ];

    for (let columns = 1; columns <= maxColumns; columns += 1) {
        buttons.push(`<button type="button" class="layout-btn" data-link-type="${linkType}" data-columns="${columns}" title="${columns}列">${columns}</button>`);
    }

    layoutButtons.innerHTML = buttons.join('');
    if (hint) {
        hint.textContent = savedColumns > maxColumns
            ? `当前窗口最多 ${maxColumns} 列，已保存 ${savedColumns} 列会在窗口足够宽时生效`
            : `当前窗口最多 ${maxColumns} 列`;
    }
}

function applyLayoutColumns(columns, linkType = 'website') {
    if (linkType === 'project') {
        projectLayoutColumns = columns;
        appState.settings.projectLayoutColumns = columns;
    } else {
        layoutColumns = columns;
        appState.settings.layoutColumns = columns;
    }

    const container = getLinkContainer(linkType);
    if (!container) return;

    if (columns === 0) {
        container.style.gridTemplateColumns = '';
        container.classList.remove('layout-fixed');
        container.style.removeProperty('--layout-cols');
    } else {
        container.style.setProperty('--layout-cols', columns.toString());
        container.classList.add('layout-fixed');
    }

    updateLayoutButtonState();
}

function applyDisplayModeState(linkType, mode) {
    const normalizedMode = mode === 'centered' ? 'centered' : 'default';
    if (linkType === 'project') {
        projectLinkDisplayMode = normalizedMode;
        appState.settings.projectLinkDisplayMode = normalizedMode;
    } else {
        bookmarkLinkDisplayMode = normalizedMode;
        appState.settings.bookmarkLinkDisplayMode = normalizedMode;
    }
    applyLinkDisplayMode(linkType, normalizedMode);
    updateDisplayModeButtonState();
}

async function setDisplayMode(linkType, mode) {
    const previous = getDisplayModeForLinkType(linkType);
    applyDisplayModeState(linkType, mode);

    try {
        await saveSettingsPatch(linkType === 'project'
            ? { projectLinkDisplayMode: mode }
            : { bookmarkLinkDisplayMode: mode });
    } catch (error) {
        applyDisplayModeState(linkType, previous);
        alert(error.message);
    }
}

async function setLinkSize(linkType, size) {
    const previous = getLinkSizeForLinkType(linkType);
    applyLinkSizeState(linkType, size);

    try {
        await saveSettingsPatch(linkType === 'project'
            ? { projectLinkSize: size }
            : { bookmarkLinkSize: size });
    } catch (error) {
        applyLinkSizeState(linkType, previous);
        alert(error.message);
    }
}

async function setLayoutColumns(columns) {
    return setLinkLayoutColumns('website', columns);
}

async function setLinkLayoutColumns(linkType, columns) {
    const previous = getLayoutColumnsForLinkType(linkType);
    applyLayoutColumns(columns, linkType);

    try {
        await saveSettingsPatch(linkType === 'project'
            ? { projectLayoutColumns: columns }
            : { layoutColumns: columns });
    } catch (error) {
        applyLayoutColumns(previous, linkType);
        alert(error.message);
    }
}

async function refreshIconCache() {
    const refreshBtn = document.getElementById('icon-refresh-btn');
    const previousText = refreshBtn?.textContent || '刷新图标';
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '刷新中...';
    }

    try {
        await apiRequest('/api/icon-cache/refresh', { method: 'POST' });
        clearLocalIconCache();
        iconCacheVersion = Date.now();
        renderProjectCards();
        renderNavCards();
    } catch (error) {
        alert(error.message);
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = previousText;
        }
    }
}

function bindMenuManagement() {
    const manageBtn = document.querySelector('.manage-menu-btn');
    const editModeBtn = document.getElementById('edit-mode-btn');
    const form = document.getElementById('link-form');
    const emailLinksContainer = document.getElementById('email-links-container');
    const projectLinksContainer = document.getElementById('project-links-container');
    const searchEngineForm = document.getElementById('search-engine-form');
    const searchEngineList = document.getElementById('search-engine-list');
    const layoutButtons = document.getElementById('layout-buttons');
    const layoutSettingsSection = document.querySelector('.layout-settings-section');
    const iconRefreshBtn = document.getElementById('icon-refresh-btn');
    const cancelBtn = document.getElementById('link-form-cancel');
    const searchEngineCancelBtn = document.getElementById('search-engine-form-cancel');

    manageBtn.addEventListener('click', () => openManageModal());
    if (editModeBtn) editModeBtn.addEventListener('click', toggleEditMode);
    if (iconRefreshBtn) iconRefreshBtn.addEventListener('click', refreshIconCache);
    cancelBtn.addEventListener('click', closeLinkModal);
    if (searchEngineCancelBtn) searchEngineCancelBtn.addEventListener('click', resetSearchEngineForm);

    if (emailLinksContainer) {
        emailLinksContainer.addEventListener('click', (event) => {
            const addBtn = event.target.closest('.email-add-link');
            const deleteBtn = event.target.closest('.email-link-delete');
            const emailLink = event.target.closest('.email-link:not(.email-add-link)');

            if (addBtn) {
                event.preventDefault();
                openLinkModal(undefined, 'email');
            } else if (deleteBtn) {
                event.preventDefault();
                event.stopPropagation();
                deleteLink(parseInt(deleteBtn.dataset.index, 10), 'email');
            } else if (emailLink && editMode) {
                event.preventDefault();
                editLink(parseInt(emailLink.dataset.index, 10), 'email');
            }
        });
    }

    if (projectLinksContainer) {
        projectLinksContainer.addEventListener('click', (event) => {
            const addBtn = event.target.closest('.nav-add-card');
            const deleteBtn = event.target.closest('.nav-card-delete');
            const navCard = event.target.closest('.nav-card:not(.nav-add-card)');

            if (addBtn) {
                event.preventDefault();
                event.stopPropagation();
                openLinkModal(undefined, 'project');
            } else if (deleteBtn) {
                event.preventDefault();
                event.stopPropagation();
                deleteLink(parseInt(deleteBtn.dataset.index, 10), 'project');
            } else if (navCard && editMode && !isDragging) {
                event.preventDefault();
                event.stopPropagation();
                editLink(parseInt(navCard.dataset.index, 10), 'project');
            }
        });
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submitBtn = form.querySelector('.btn-primary');
        const title = document.getElementById('link-title').value.trim();
        const url = document.getElementById('link-url').value.trim();
        const editIndex = form.dataset.editIndex !== undefined ? parseInt(form.dataset.editIndex, 10) : null;
        const linkType = form.dataset.linkType === 'email'
            ? 'email'
            : form.dataset.linkType === 'project' ? 'project' : 'website';

        if (!title) return;
        if (!url) {
            alert(linkType === 'email'
                ? '请填写邮箱登录地址'
                : linkType === 'project' ? '请填写项目地址' : '请填写链接地址');
            return;
        }

        const links = getLinkCollection(linkType);
        const editingLink = editIndex !== null && links[editIndex] ? links[editIndex] : null;
        submitBtn.disabled = true;

        try {
            const data = await apiRequest(editingLink ? `/api/links/${editingLink.id}` : '/api/links', {
                method: editingLink ? 'PUT' : 'POST',
                body: { title, url, type: linkType }
            });
            applyLinksResponse(data);
            closeLinkModal();
        } catch (error) {
            alert(error.message);
        } finally {
            submitBtn.disabled = false;
        }
    });

    if (layoutSettingsSection) {
        layoutSettingsSection.addEventListener('click', (event) => {
            const linkSizeBtn = event.target.closest('.link-size-btn');
            if (linkSizeBtn) {
                setLinkSize(linkSizeBtn.dataset.linkType || 'website', linkSizeBtn.dataset.size || 'medium');
                return;
            }

            const displayModeBtn = event.target.closest('.display-mode-btn');
            if (displayModeBtn) {
                setDisplayMode(displayModeBtn.dataset.linkType || 'website', displayModeBtn.dataset.mode || 'default');
                return;
            }

            const layoutBtn = event.target.closest('.layout-btn[data-columns]');
            if (!layoutBtn) return;
            const columns = parseInt(layoutBtn.dataset.columns, 10);
            setLinkLayoutColumns(layoutBtn.dataset.linkType || 'website', columns);
        });
    }

    searchEngineForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submitBtn = searchEngineForm.querySelector('.btn-primary');
        const name = document.getElementById('engine-name').value.trim();
        const urlTemplate = document.getElementById('engine-url-template').value.trim();
        const editId = searchEngineForm.dataset.editId;

        if (!name || !urlTemplate) return;
        submitBtn.disabled = true;

        try {
            const data = await apiRequest(editId ? `/api/search-engines/${editId}` : '/api/search-engines', {
                method: editId ? 'PUT' : 'POST',
                body: { name, urlTemplate }
            });
            appState.searchEngineRecords = data.engines || [];
            rebuildSearchEngines();
            renderSearchEngineButtons();
            renderSearchEngineList();
            resetSearchEngineForm();
        } catch (error) {
            alert(error.message);
        } finally {
            submitBtn.disabled = false;
        }
    });

    searchEngineList.addEventListener('click', async (event) => {
        const editBtn = event.target.closest('.engine-list-edit');
        const deleteBtn = event.target.closest('.engine-list-delete');
        if (!editBtn && !deleteBtn) return;

        const actionBtn = editBtn || deleteBtn;
        const engine = appState.searchEngineRecords.find(item => String(item.id) === actionBtn.dataset.id);
        if (!engine) return;

        if (editBtn) {
            editSearchEngine(engine);
            return;
        }

        if (!confirm(`确定要删除搜索引擎「${engine.name}」吗？`)) return;

        deleteBtn.disabled = true;

        try {
            const data = await apiRequest(`/api/search-engines/${engine.id}`, { method: 'DELETE' });
            const deletedEngineKey = getEngineKey(engine);
            appState.searchEngineRecords = data.engines || [];
            if (currentEngine === deletedEngineKey) {
                currentEngine = appState.searchEngineRecords.some(item => item.engineKey === 'google')
                    ? 'google'
                    : getEngineKey(appState.searchEngineRecords[0] || getFallbackSearchEngineRecords()[0]);
            }
            rebuildSearchEngines();
            renderSearchEngineButtons();
            renderSearchEngineList();
            resetSearchEngineForm();
        } catch (error) {
            alert(error.message);
        } finally {
            deleteBtn.disabled = false;
        }
    });

    document.getElementById('nav-links-container').addEventListener('click', (event) => {
        const addBtn = event.target.closest('.nav-add-card');
        const deleteBtn = event.target.closest('.nav-card-delete');
        const navCard = event.target.closest('.nav-card:not(.nav-add-card)');

        if (addBtn) {
            event.preventDefault();
            event.stopPropagation();
            openLinkModal();
        } else if (deleteBtn) {
            event.preventDefault();
            event.stopPropagation();
            deleteLink(parseInt(deleteBtn.dataset.index, 10));
        } else if (navCard && editMode && !isDragging) {
            event.preventDefault();
            event.stopPropagation();
            editLink(parseInt(navCard.dataset.index, 10));
        }
    });

    document.querySelectorAll('.modal-close[data-close]').forEach(btn => {
        btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
    });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeModal(overlay.id);
        });
    });
}

// ==================== 自定义背景 ====================
function isValidBackgroundUrl(url) {
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

function cssUrl(value) {
    return value.replace(/"/g, '\\"');
}

function applyCustomBackground(url) {
    if (!url || !url.trim()) {
        document.body.style.backgroundImage = '';
        document.body.style.backgroundSize = '';
        document.body.style.backgroundPosition = '';
        document.body.style.backgroundRepeat = '';
        document.body.style.backgroundAttachment = '';
        return;
    }

    const trimmed = url.trim();
    if (!isValidBackgroundUrl(trimmed)) {
        console.warn('Invalid background URL rejected');
        return;
    }

    const safeUrl = trimmed.startsWith('/') ? trimmed : new URL(trimmed).href;
    document.body.style.backgroundImage = `url("${cssUrl(safeUrl)}")`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundRepeat = 'no-repeat';
    document.body.style.backgroundAttachment = 'fixed';
}

function applySettings(settings) {
    appState.settings = {
        ...DEFAULT_SETTINGS,
        ...(settings || {})
    };
    layoutColumns = Number.parseInt(appState.settings.layoutColumns, 10) || 0;
    projectLayoutColumns = Number.parseInt(appState.settings.projectLayoutColumns, 10) || 0;
    projectLinkDisplayMode = appState.settings.projectLinkDisplayMode === 'default' ? 'default' : 'centered';
    bookmarkLinkDisplayMode = appState.settings.bookmarkLinkDisplayMode === 'centered' ? 'centered' : 'default';
    projectLinkSize = normalizeLinkSize(appState.settings.projectLinkSize);
    bookmarkLinkSize = normalizeLinkSize(appState.settings.bookmarkLinkSize);
    editMode = Boolean(appState.settings.editMode);
    applyLinkSizes();
    applyLayoutColumns(layoutColumns);
    applyLayoutColumns(projectLayoutColumns, 'project');
    applyLinkDisplayModes();
    updateDisplayModeButtonState();
    updateLinkSizeButtonState();
    updateEditModeUI();
    applyCustomBackground(appState.settings.backgroundUrl || '');
}

function revokePreviewObjectUrl() {
    if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
        previewObjectUrl = null;
    }
}

function setBackgroundBusy(isBusy) {
    document.getElementById('background-apply').disabled = isBusy;
    document.getElementById('background-reset').disabled = isBusy;
}

function bindBackgroundModal() {
    const btn = document.querySelector('.background-btn');
    const fileInput = document.getElementById('background-upload');
    const urlInput = document.getElementById('background-url');
    const preview = document.getElementById('background-preview');
    const previewImg = document.getElementById('background-preview-img');
    const previewRemove = document.getElementById('background-preview-remove');
    const applyBtn = document.getElementById('background-apply');
    const resetBtn = document.getElementById('background-reset');
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

    btn.addEventListener('click', () => {
        const saved = appState.settings.backgroundUrl || '';
        selectedBackgroundFile = null;
        revokePreviewObjectUrl();
        fileInput.value = '';
        urlInput.value = saved;

        if (saved) {
            previewImg.src = saved;
            preview.style.display = 'block';
        } else {
            previewImg.removeAttribute('src');
            preview.style.display = 'none';
        }

        openModal('background-modal');
    });

    fileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;

        const maxFileSize = 10 * 1024 * 1024;
        if (file.size > maxFileSize) {
            alert('图片文件不能超过 10MB');
            fileInput.value = '';
            return;
        }

        if (!allowedTypes.includes(file.type)) {
            alert('请选择 JPG、PNG、WebP 或 GIF 图片');
            fileInput.value = '';
            return;
        }

        selectedBackgroundFile = file;
        revokePreviewObjectUrl();
        previewObjectUrl = URL.createObjectURL(file);
        previewImg.src = previewObjectUrl;
        preview.style.display = 'block';
        urlInput.value = '';
    });

    previewRemove.addEventListener('click', () => {
        selectedBackgroundFile = null;
        revokePreviewObjectUrl();
        preview.style.display = 'none';
        previewImg.removeAttribute('src');
        fileInput.value = '';
        urlInput.value = '';
    });

    applyBtn.addEventListener('click', async () => {
        const urlValue = urlInput.value.trim();
        setBackgroundBusy(true);

        try {
            if (selectedBackgroundFile) {
                const formData = new FormData();
                formData.append('background', selectedBackgroundFile);
                const data = await apiRequest('/api/background', {
                    method: 'POST',
                    body: formData
                });
                applySettings(data.settings);
            } else if (urlValue) {
                if (!isValidBackgroundUrl(urlValue)) {
                    alert('请输入有效的图片 URL 或服务器图片路径');
                    return;
                }
                await saveSettingsPatch({ backgroundUrl: urlValue });
            } else {
                await saveSettingsPatch({ backgroundUrl: '' });
            }

            selectedBackgroundFile = null;
            revokePreviewObjectUrl();
            closeModal('background-modal');
        } catch (error) {
            alert(error.message);
        } finally {
            setBackgroundBusy(false);
        }
    });

    resetBtn.addEventListener('click', async () => {
        setBackgroundBusy(true);
        try {
            await saveSettingsPatch({ backgroundUrl: '' });
            selectedBackgroundFile = null;
            revokePreviewObjectUrl();
            urlInput.value = '';
            preview.style.display = 'none';
            previewImg.removeAttribute('src');
            fileInput.value = '';
            closeModal('background-modal');
        } catch (error) {
            alert(error.message);
        } finally {
            setBackgroundBusy(false);
        }
    });
}

// ==================== 初始化 ====================
function injectAnimationStyles() {
    const style = document.createElement('style');
    style.textContent = `
        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
            20%, 40%, 60%, 80% { transform: translateX(5px); }
        }

        @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.05); }
            100% { transform: scale(1); }
        }
    `;
    document.head.appendChild(style);
}

function bindLayoutResize() {
    window.addEventListener('resize', () => {
        clearTimeout(layoutResizeTimer);
        layoutResizeTimer = setTimeout(() => {
            renderLayoutButtons();
        }, 120);
    });
}

function init() {
    injectAnimationStyles();
    updateSearchEngine(currentEngine);
    bindAuth();
    bindSearchEvents();
    bindMenuManagement();
    bindLayoutResize();
    bindBackgroundModal();
    restoreSession();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

console.log('%c个人导航首页', 'font-size: 24px; font-weight: bold; color: #667eea;');
console.log('快捷键: Ctrl/Cmd + K 聚焦搜索框, Ctrl/Cmd + 1/2/3/4 切换搜索引擎');

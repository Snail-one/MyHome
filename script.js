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
    editMode: false,
    backgroundUrl: ''
};
const LOCAL_ICON_CACHE_STORAGE_KEY = 'my-home-local-icon-cache-v1';

const appState = {
    user: null,
    links: [],
    searchEngineRecords: [],
    settings: { ...DEFAULT_SETTINGS }
};

let currentEngine = 'google';
let layoutColumns = 0;
let editMode = false;
let draggedCard = null;
let draggedIndex = null;
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
    appState.searchEngineRecords = Array.isArray(searchEnginesData.engines) ? searchEnginesData.engines : [];
    rebuildSearchEngines();
    renderSearchEngineButtons();
    renderSearchEngineList();
    applySettings(settingsData.settings || DEFAULT_SETTINGS);
    renderNavCards();
}

async function saveSettingsPatch(patch) {
    const data = await apiRequest('/api/settings', {
        method: 'PUT',
        body: patch
    });
    applySettings(data.settings || DEFAULT_SETTINGS);
}

// ==================== 登录状态 ====================
function showLoggedOut(message = '') {
    const authScreen = document.getElementById('auth-screen');
    appState.user = null;
    appState.links = [];
    appState.searchEngineRecords = [];
    appState.settings = { ...DEFAULT_SETTINGS };
    currentEngine = 'google';
    rebuildSearchEngines();
    renderSearchEngineButtons();
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

function createNavCardElement(link, index, options = {}) {
    const { noAnimation = false } = options;
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

    if (!noAnimation) {
        card.style.animationDelay = `${0.3 + (index * 0.05)}s`;
    }

    card.innerHTML = `
        <a href="${href}" target="_blank" rel="noopener noreferrer" class="nav-card" data-index="${index}" draggable="true">
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

function createAddLinkCardElement() {
    const card = document.createElement('div');
    card.className = 'nav-card-wrapper nav-add-wrapper';
    card.innerHTML = `
        <button type="button" class="nav-card nav-add-card" title="添加网址" aria-label="添加网址">
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

function updateNavEmptyState() {
    const emptyState = document.getElementById('nav-empty-state');
    if (!emptyState) return;
    emptyState.style.display = appState.links.length || editMode ? 'none' : 'block';
}

function syncAddLinkCard() {
    const container = document.getElementById('nav-links-container');
    const emptyState = document.getElementById('nav-empty-state');
    if (!container || !emptyState) return;

    const existingAddCard = container.querySelector('.nav-add-wrapper');
    if (!editMode) {
        existingAddCard?.remove();
        updateNavEmptyState();
        return;
    }

    if (!existingAddCard) {
        container.insertBefore(createAddLinkCardElement(), emptyState);
    }

    updateNavEmptyState();
}

function renderNavCards() {
    const container = document.getElementById('nav-links-container');
    const emptyState = document.getElementById('nav-empty-state');
    const links = getLinks();

    container.querySelectorAll('.nav-card-wrapper').forEach(el => el.remove());
    updateNavEmptyState();

    links.forEach((link, index) => {
        const card = createNavCardElement(link, index);
        container.insertBefore(card, emptyState);
    });

    updateEditModeUI();
}

function handleDragStart(event) {
    draggedCard = this;
    draggedIndex = parseInt(this.dataset.index, 10);
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

    const dropIndex = parseInt(this.dataset.index, 10);
    if (draggedIndex === null || dropIndex === draggedIndex) return;

    const previousLinks = [...appState.links];
    const links = [...appState.links];
    const [draggedItem] = links.splice(draggedIndex, 1);
    links.splice(dropIndex, 0, draggedItem);
    appState.links = links;

    const container = document.getElementById('nav-links-container');
    container.style.transition = 'none';
    renderNavCards();
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            container.style.transition = '';
        });
    });

    try {
        const data = await apiRequest('/api/links/reorder', {
            method: 'PUT',
            body: { ids: links.map(link => link.id) }
        });
        appState.links = data.links || links;
        renderNavCards();
    } catch (error) {
        appState.links = previousLinks;
        renderNavCards();
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

function openLinkModal(editIndex) {
    const form = document.getElementById('link-form');
    const modalTitle = document.getElementById('link-modal-title');
    const submitBtn = document.getElementById('link-form-submit');
    const links = getLinks();
    openModal('link-modal');
    form.reset();

    if (typeof editIndex === 'number' && links[editIndex]) {
        const link = links[editIndex];
        document.getElementById('link-title').value = link.title || '';
        document.getElementById('link-url').value = link.url || '';
        form.dataset.editIndex = editIndex;
        modalTitle.textContent = '编辑网址';
        submitBtn.textContent = '更新链接';
    } else {
        delete form.dataset.editIndex;
        modalTitle.textContent = '添加网址';
        submitBtn.textContent = '添加链接';
    }

    setTimeout(() => document.getElementById('link-title')?.focus(), 0);
}

function closeLinkModal() {
    const form = document.getElementById('link-form');
    closeModal('link-modal');
    form?.reset();
    if (form) delete form.dataset.editIndex;
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
        const isDefault = Boolean(engine.engineKey);
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
                    ${isDefault ? '' : `
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
    syncAddLinkCard();
}

async function deleteLink(index) {
    const links = getLinks();
    if (index < 0 || index >= links.length) return;
    if (!confirm(`确定要删除链接「${links[index].title}」吗？`)) return;

    try {
        const data = await apiRequest(`/api/links/${links[index].id}`, { method: 'DELETE' });
        appState.links = data.links || [];
        renderNavCards();
    } catch (error) {
        alert(error.message);
    }
}

function editLink(index) {
    openLinkModal(index);
}

function parseCssPixelValue(value, fallback = 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getMaxAvailableLayoutColumns() {
    if (window.matchMedia('(max-width: 768px)').matches) return 1;

    const container = document.getElementById('nav-links-container');
    const rootStyles = getComputedStyle(document.documentElement);
    const containerStyles = container ? getComputedStyle(container) : null;
    const configuredMax = Number.parseInt(rootStyles.getPropertyValue('--layout-max-cols'), 10) || 6;
    const cardWidth = parseCssPixelValue(rootStyles.getPropertyValue('--nav-card-width'), 120);
    const gap = parseCssPixelValue(containerStyles?.columnGap || rootStyles.getPropertyValue('--nav-gap'), 16);
    const measuredWidth = container?.getBoundingClientRect().width || 0;
    const fallbackWidth = Math.min(window.innerWidth * 0.94, 1400);
    const availableWidth = measuredWidth || fallbackWidth;
    const columns = Math.floor((availableWidth + gap) / (cardWidth + gap));
    const linkCount = Math.max(1, appState.links.length);

    return Math.max(1, Math.min(configuredMax, columns, linkCount));
}

function updateLayoutButtonState() {
    document.querySelectorAll('.layout-btn').forEach(btn => {
        const btnCols = parseInt(btn.dataset.columns, 10);
        btn.classList.toggle('active', btnCols === layoutColumns);
    });
}

function renderLayoutButtons() {
    const layoutButtons = document.getElementById('layout-buttons');
    const hint = document.getElementById('layout-options-hint');
    if (!layoutButtons) return;

    const maxColumns = getMaxAvailableLayoutColumns();
    const buttons = ['<button type="button" class="layout-btn" data-columns="0" title="自动">自动</button>'];

    for (let columns = 1; columns <= maxColumns; columns += 1) {
        buttons.push(`<button type="button" class="layout-btn" data-columns="${columns}" title="${columns}列">${columns}</button>`);
    }

    layoutButtons.innerHTML = buttons.join('');
    if (hint) {
        hint.textContent = layoutColumns > maxColumns
            ? `当前窗口最多 ${maxColumns} 列，已保存 ${layoutColumns} 列会在窗口足够宽时生效`
            : `当前窗口最多 ${maxColumns} 列`;
    }
    updateLayoutButtonState();
}

function applyLayoutColumns(columns) {
    layoutColumns = columns;
    appState.settings.layoutColumns = columns;
    const container = document.getElementById('nav-links-container');
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

async function setLayoutColumns(columns) {
    const previous = layoutColumns;
    applyLayoutColumns(columns);

    try {
        await saveSettingsPatch({ layoutColumns: columns });
    } catch (error) {
        applyLayoutColumns(previous);
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
    const searchEngineForm = document.getElementById('search-engine-form');
    const searchEngineList = document.getElementById('search-engine-list');
    const layoutButtons = document.getElementById('layout-buttons');
    const iconRefreshBtn = document.getElementById('icon-refresh-btn');
    const cancelBtn = document.getElementById('link-form-cancel');
    const searchEngineCancelBtn = document.getElementById('search-engine-form-cancel');

    manageBtn.addEventListener('click', () => openManageModal());
    if (editModeBtn) editModeBtn.addEventListener('click', toggleEditMode);
    if (iconRefreshBtn) iconRefreshBtn.addEventListener('click', refreshIconCache);
    cancelBtn.addEventListener('click', closeLinkModal);
    if (searchEngineCancelBtn) searchEngineCancelBtn.addEventListener('click', resetSearchEngineForm);

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submitBtn = form.querySelector('.btn-primary');
        const title = document.getElementById('link-title').value.trim();
        const url = document.getElementById('link-url').value.trim();
        const editIndex = form.dataset.editIndex !== undefined ? parseInt(form.dataset.editIndex, 10) : null;

        if (!title) return;
        if (!url) {
            alert('请填写链接地址');
            return;
        }

        const editingLink = editIndex !== null && getLinks()[editIndex] ? getLinks()[editIndex] : null;
        submitBtn.disabled = true;

        try {
            const data = await apiRequest(editingLink ? `/api/links/${editingLink.id}` : '/api/links', {
                method: editingLink ? 'PUT' : 'POST',
                body: { title, url }
            });
            appState.links = data.links || [];
            renderNavCards();
            closeLinkModal();
        } catch (error) {
            alert(error.message);
        } finally {
            submitBtn.disabled = false;
        }
    });

    layoutButtons.addEventListener('click', (event) => {
        const btn = event.target.closest('.layout-btn');
        if (!btn) return;

        const columns = parseInt(btn.dataset.columns, 10);
        setLayoutColumns(columns);
    });

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
    editMode = Boolean(appState.settings.editMode);
    applyLayoutColumns(layoutColumns);
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

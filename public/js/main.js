import { buildSearchUrl as buildSearchUrlFromTemplate } from './search.js';
import {
    getIconFileUrl
} from './icons.js';
import {
    DEFAULT_SETTINGS,
    LINK_SIZE_CONFIG,
    LINK_SIZE_OPTIONS,
    REQUIRED_EMAIL_LINK_KEYS,
    createAppState,
    defaultSearchEngines
} from './state.js';

// ==================== 搜索引擎配置 ====================
let searchEngines = { ...defaultSearchEngines };

const appState = createAppState();

let currentEngine = 'google';
let layoutColumns = 0;
let projectLayoutColumns = 0;
let projectLinkDisplayMode = 'centered';
let bookmarkLinkDisplayMode = 'centered';
let projectLinkSize = 'medium';
let bookmarkLinkSize = 'medium';
let bookmarkGlass = true;
let editMode = false;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
let csrfToken = '';
let csrfTokenPromise = null;
let iconEventSource = null;

export const page = {
    handleEscape: null,
    dismissNotice: null,
    renderSearchEngineList: null
};

function setModalOpen(modal, open) {
    if (!modal) return;
    modal.setAttribute('aria-hidden', open ? 'false' : 'true');
    modal.classList.toggle('modal-open', open);
    document.body.classList.toggle(
        'has-modal-open',
        Boolean(document.querySelector('.modal-overlay.modal-open'))
    );
}

let noticeChain = Promise.resolve();

function presentNotice(message, title) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('notice-modal');
        const titleEl = document.getElementById('notice-title');
        const messageEl = document.getElementById('notice-message');
        const okBtn = document.getElementById('notice-ok');
        if (!overlay || !titleEl || !messageEl || !okBtn) {
            resolve();
            return;
        }

        titleEl.textContent = title;
        messageEl.textContent = message || '';

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            page.dismissNotice = null;
            okBtn.removeEventListener('click', finish);
            overlay.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onKeydown);
            setModalOpen(overlay, false);
            resolve();
        };
        const onBackdrop = (event) => {
            if (event.target === overlay) finish();
        };
        const onKeydown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                finish();
            }
        };

        page.dismissNotice = finish;
        okBtn.addEventListener('click', finish);
        overlay.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKeydown);
        setModalOpen(overlay, true);
        setTimeout(() => okBtn.focus(), 0);
    });
}

export function showNotice(message, title = '提示') {
    const task = noticeChain.then(() => presentNotice(message, title));
    noticeChain = task.then(() => {}, () => {});
    return task;
}

// ==================== DOM 元素 ====================
const searchInput = document.querySelector('.search-input');
const searchBox = document.querySelector('.search-box');
const searchEngineSwitcher = document.querySelector('.search-engine-switcher');
const engineIndicator = document.querySelector('.current-engine');
const searchEngineIndicator = document.querySelector('.search-engine-indicator');
const accountLogoutBtn = document.getElementById('account-logout-btn');

// ==================== API ====================
function getRequestMethod(options = {}) {
    return String(options.method || 'GET').toUpperCase();
}

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

async function apiRequest(path, options = {}) {
    const method = getRequestMethod(options);
    const fetchOptions = {
        credentials: 'same-origin',
        ...options,
        headers: {
            ...(options.headers || {})
        }
    };

    if (!SAFE_METHODS.has(method)) {
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

    applySearchEnginesResponse(searchEnginesData.engines);
    applySettings(settingsData.settings || DEFAULT_SETTINGS);
    // Rendering is already handled inside applySettings → updateEditModeUI()
    // (which calls render* + syncAddLinkCard for add buttons).
}

async function saveSettingsPatch(patch) {
    const data = await apiRequest('/api/settings', {
        method: 'PUT',
        body: patch
    });
    applySettings(data.settings || DEFAULT_SETTINGS);
}

function applyLinksResponse(data) {
    const nextLinks = Array.isArray(data.links) ? data.links : [];
    const nextEmailLinks = Array.isArray(data.emailLinks) ? data.emailLinks : [];
    const nextProjectLinks = Array.isArray(data.projectLinks) ? data.projectLinks : [];
    appState.links = nextLinks;
    appState.emailLinks = nextEmailLinks;
    appState.projectLinks = nextProjectLinks;
    renderEmailLinks();
    renderProjectCards();
    renderNavCards();
}

function applySearchEnginesResponse(engines) {
    const nextEngines = Array.isArray(engines) ? engines : [];
    appState.searchEngineRecords = nextEngines;
    rebuildSearchEngines();
    renderSearchEngineButtons();
    page.renderSearchEngineList?.();
}

function clearAuthenticatedDom() {
    searchEngineSwitcher.innerHTML = '';
    if (engineIndicator) engineIndicator.textContent = 'Google';

    document.getElementById('email-links-container')?.replaceChildren();
    document.getElementById('search-engine-list')?.replaceChildren();
    document.getElementById('layout-buttons')?.replaceChildren();
    document.getElementById('project-layout-buttons')?.replaceChildren();
    document.getElementById('project-display-mode-buttons')?.replaceChildren();
    document.getElementById('bookmark-display-mode-buttons')?.replaceChildren();
    document.getElementById('project-link-size-buttons')?.replaceChildren();
    document.getElementById('bookmark-link-size-buttons')?.replaceChildren();

    document.querySelectorAll('.nav-card-wrapper, .nav-add-wrapper').forEach(element => element.remove());
    updateLinkEmptyState('website');
    updateLinkEmptyState('project');

    document.getElementById('link-form')?.reset();
    document.getElementById('search-engine-form')?.reset();
    const backgroundUpload = document.getElementById('background-upload');
    const backgroundUrl = document.getElementById('background-url');
    if (backgroundUpload) backgroundUpload.value = '';
    if (backgroundUrl) backgroundUrl.value = '';
}

// ==================== 登录状态 ====================
function showLoggedOut(message = '') {
    appState.user = null;
    appState.links = [];
    appState.emailLinks = [];
    appState.projectLinks = [];
    appState.searchEngineRecords = [];
    appState.settings = { ...DEFAULT_SETTINGS };
    currentEngine = 'google';
    searchEngines = {};
    clearAuthenticatedDom();
    applySettings(DEFAULT_SETTINGS);
    document.body.classList.remove('app-loading', 'logged-in');
    document.body.classList.add('logged-out');
    disconnectIconEvents();
    const loginUrl = message ? `/login?reason=${encodeURIComponent(message)}` : '/login';
    window.location.replace(loginUrl);
}

function showLoggedIn(user) {
    appState.user = user;
    document.body.classList.remove('app-loading', 'logged-out');
    document.body.classList.add('logged-in');
    if (window.matchMedia('(pointer: fine)').matches) {
        setTimeout(() => searchInput?.focus(), 0);
    }
}

function bindAuth() {
    accountLogoutBtn?.addEventListener('click', async () => {
        try {
            await apiRequest('/api/logout', { method: 'POST' });
        } catch (error) {
            console.warn(error.message);
        } finally {
            showLoggedOut('');
        }
    });
}

function readBootstrap() {
    const node = document.getElementById('app-bootstrap');
    if (!node?.textContent) return null;
    try {
        return JSON.parse(node.textContent);
    } catch {
        return null;
    }
}

function hydrateFromBootstrap(data) {
    appState.user = data.user || null;
    appState.links = Array.isArray(data.links) ? data.links : [];
    appState.emailLinks = Array.isArray(data.emailLinks) ? data.emailLinks : [];
    appState.projectLinks = Array.isArray(data.projectLinks) ? data.projectLinks : [];
    appState.searchEngineRecords = Array.isArray(data.engines) ? data.engines : [];
    appState.settings = {
        ...DEFAULT_SETTINGS,
        ...(data.settings || {})
    };
    layoutColumns = Number.parseInt(appState.settings.layoutColumns, 10) || 0;
    projectLayoutColumns = Number.parseInt(appState.settings.projectLayoutColumns, 10) || 0;
    projectLinkDisplayMode = appState.settings.projectLinkDisplayMode === 'default' ? 'default' : 'centered';
    bookmarkLinkDisplayMode = appState.settings.bookmarkLinkDisplayMode === 'default' ? 'default' : 'centered';
    projectLinkSize = normalizeLinkSize(appState.settings.projectLinkSize);
    bookmarkLinkSize = normalizeLinkSize(appState.settings.bookmarkLinkSize);
    bookmarkGlass = appState.settings.bookmarkGlass !== false;
    editMode = Boolean(appState.settings.editMode);
    rebuildSearchEngines();
    const preferred = data.currentEngine;
    currentEngine = preferred && searchEngines[preferred]
        ? preferred
        : (searchEngines.google ? 'google' : Object.keys(searchEngines)[0]);
    updateSearchEngine(currentEngine);
    showLoggedIn(appState.user);
}

async function restoreSession() {
    const bootstrap = readBootstrap();
    if (bootstrap) {
        hydrateFromBootstrap(bootstrap);
        scheduleIconEvents();
        if (editMode) ensureAdmin();
        return;
    }

    try {
        const data = await apiRequest('/api/me');
        if (!data.authenticated) {
            showLoggedOut('');
            return;
        }

        await loadAppData();
        showLoggedIn(data.user);
        scheduleIconEvents();
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

function renderSearchEngineButtons() {
    searchEngineSwitcher.innerHTML = '';

    getRenderableSearchEngines().forEach(engine => {
        const key = getEngineKey(engine);
        const iconDescriptor = getSearchEngineIconDescriptor(engine);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'engine-btn';
        btn.dataset.engine = key;
        btn.innerHTML = `
            ${iconDescriptor
                ? `<img alt="" class="engine-favicon" loading="eager" decoding="async" data-icon-entity="search-engines" data-icon-id="${escapeAttribute(String(engine.id))}">`
                : '<span class="engine-favicon" aria-hidden="true"></span>'
            }
            <span>${escapeHtml(engine.name)}</span>
        `;
        const faviconImg = btn.querySelector('.engine-favicon');
        if (faviconImg && iconDescriptor) hydrateIconElement(faviconImg, iconDescriptor);
        searchEngineSwitcher.appendChild(btn);
    });

    if (!searchEngines[currentEngine]) {
        currentEngine = searchEngines.google ? 'google' : Object.keys(searchEngines)[0];
    }
    updateSearchEngine(currentEngine);
}

function buildSearchUrl(engineConfig, query) {
    return buildSearchUrlFromTemplate(engineConfig, query);
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

    if (event.key === 'Escape' && page.handleEscape?.()) {
        event.preventDefault();
        return;
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
    if (linkType === 'email') {
        appState.emailLinks = links;
        return;
    }

    if (linkType === 'project') {
        appState.projectLinks = links;
        return;
    }

    appState.links = links;
}

function getLinkContainer(linkType) {
    if (linkType === 'email') return document.getElementById('email-links-container');
    return document.getElementById(linkType === 'project' ? 'project-links-container' : 'nav-links-container');
}

function getLinkEmptyState(linkType) {
    return document.getElementById(linkType === 'project' ? 'project-empty-state' : 'nav-empty-state');
}

function normalizeLinkIconMode(iconMode) {
    if (['server', 'upload', 'local', 'none'].includes(iconMode)) return iconMode;
    return 'server';
}

function getEntityIconVersion(entity) {
    return Number.parseInt(entity?.iconVersion, 10) || 1;
}

function patchEntityIconState(list, entityId, patch) {
    const index = list.findIndex((item) => String(item.id) === String(entityId));
    if (index < 0) return list;
    const next = list.slice();
    next[index] = { ...next[index], ...patch };
    return next;
}

function applyIconEvent(event) {
    if (!event?.entityType || !event.id) return;

    const patch = {
        iconStatus: event.status,
        iconFileUrl: event.fileUrl || '',
        iconVersion: event.iconVersion || 1
    };

    if (event.entityType === 'links') {
        appState.links = patchEntityIconState(appState.links, event.id, patch);
        appState.projectLinks = patchEntityIconState(appState.projectLinks, event.id, patch);
    } else if (event.entityType === 'search-engines') {
        appState.searchEngineRecords = patchEntityIconState(appState.searchEngineRecords, event.id, patch);
    }

    const selector = `img[data-icon-entity="${event.entityType}"][data-icon-id="${event.id}"]`;
    document.querySelectorAll(selector).forEach((img) => {
        const descriptor = {
            ...(img.iconDescriptor || {}),
            entityType: event.entityType,
            id: event.id,
            mode: 'server',
            version: patch.iconVersion,
            status: patch.iconStatus,
            fileUrl: patch.iconFileUrl
        };
        hydrateIconElement(img, descriptor);
    });
}

function disconnectIconEvents() {
    if (!iconEventSource) return;
    iconEventSource.close();
    iconEventSource = null;
}

function isUnresolvedIconEntity(entity) {
    if (!entity || entity.iconMode === 'none' || entity.linkType === 'email') return false;
    const status = entity.iconStatus || 'empty';
    return status !== 'ready' && status !== 'miss' && status !== 'none';
}

function listUnresolvedIconTargets() {
    const links = [];
    const searchEngines = [];
    for (const link of [...appState.links, ...appState.projectLinks]) {
        if (isUnresolvedIconEntity(link)) links.push(link.id);
    }
    for (const engine of appState.searchEngineRecords) {
        if (isUnresolvedIconEntity(engine)) searchEngines.push(engine.id);
    }
    return { links, searchEngines };
}

function connectIconEvents() {
    if (iconEventSource) return;
    if (typeof EventSource === 'undefined') return;

    let connectedOnce = false;
    iconEventSource = new EventSource('/api/icons/events');
    iconEventSource.addEventListener('icon', (message) => {
        try {
            applyIconEvent(JSON.parse(message.data));
        } catch (error) {
            console.warn('Failed to apply icon event:', error.message);
        }
    });
    iconEventSource.addEventListener('open', () => {
        if (!connectedOnce) {
            connectedOnce = true;
            syncPendingIcons();
            return;
        }
        syncVisibleIconStatuses();
    });
    iconEventSource.onerror = () => {
        // Browser will reconnect EventSource automatically.
    };
}

function scheduleIconEvents() {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => connectIconEvents());
    });
}

async function syncPendingIcons() {
    const targets = listUnresolvedIconTargets();
    if (!targets.links.length && !targets.searchEngines.length) return;

    const params = new URLSearchParams();
    if (targets.links.length) params.set('links', targets.links.join(','));
    if (targets.searchEngines.length) params.set('searchEngines', targets.searchEngines.join(','));

    try {
        const data = await apiRequest(`/api/icons/pending?${params}`);
        (data.icons || []).forEach((icon) => applyIconEvent(icon));
    } catch (error) {
        console.warn('Failed to sync pending icons:', error.message);
    }
}

async function syncVisibleIconStatuses() {
    try {
        const [linksData, searchEnginesData] = await Promise.all([
            apiRequest('/api/links'),
            apiRequest('/api/search-engines')
        ]);
        const entities = [
            ...(linksData.links || []).map((link) => ({ ...link, entityType: 'links' })),
            ...(linksData.projectLinks || []).map((link) => ({ ...link, entityType: 'links' })),
            ...(searchEnginesData.engines || []).map((engine) => ({ ...engine, entityType: 'search-engines' }))
        ];
        entities.forEach((entity) => {
            applyIconEvent({
                entityType: entity.entityType,
                id: entity.id,
                status: entity.iconStatus,
                fileUrl: entity.iconFileUrl || '',
                iconVersion: entity.iconVersion
            });
        });
    } catch (error) {
        console.warn('Failed to sync icon statuses:', error.message);
    }
}

function getIconFallbackElement(img) {
    const fallback = img?.nextElementSibling;
    if (!fallback) return null;
    return fallback.matches('.nav-favicon-fallback, .email-link-icon') ? fallback : null;
}

function showIconFallback(img) {
    if (!img) return;
    img.removeAttribute('src');
    img.style.display = 'none';
    const fallback = getIconFallbackElement(img);
    if (fallback) fallback.style.display = 'block';
}

function setIconImageUrl(img, url) {
    if (!img || !url) return;
    img.style.display = '';
    const fallback = getIconFallbackElement(img);
    if (fallback) fallback.style.display = 'none';
    img.src = url;
}

function getLinkIconDescriptor(link, linkType = 'website') {
    if (!link?.id) return null;
    if (linkType === 'email') return null;

    const mode = normalizeLinkIconMode(link.iconMode);
    const version = getEntityIconVersion(link);

    return {
        entityType: 'links',
        id: link.id,
        mode,
        version,
        status: link.iconStatus || '',
        fileUrl: link.iconFileUrl || getIconFileUrl('links', link.id, version)
    };
}

function getSearchEngineIconDescriptor(engine) {
    if (!engine?.id || !Number.isInteger(Number.parseInt(engine.id, 10))) return null;
    const version = getEntityIconVersion(engine);

    return {
        entityType: 'search-engines',
        id: engine.id,
        mode: 'server',
        version,
        status: engine.iconStatus || '',
        fileUrl: engine.iconFileUrl || getIconFileUrl('search-engines', engine.id, version)
    };
}

function hydrateIconElement(img, descriptor) {
    if (!img || !descriptor || descriptor.mode === 'none' || descriptor.status === 'none' || descriptor.status === 'miss') {
        showIconFallback(img);
        return;
    }

    img.iconDescriptor = descriptor;
    img.dataset.iconEntity = descriptor.entityType || '';
    img.dataset.iconId = String(descriptor.id || '');
    if (!img.hasAttribute('loading')) img.loading = 'lazy';
    img.decoding = 'async';

    if (descriptor.status === 'ready' && descriptor.fileUrl) {
        img.onerror = () => {
            img.onerror = null;
            showIconFallback(img);
        };
        setIconImageUrl(img, descriptor.fileUrl);
        return;
    }

    showIconFallback(img);
}

function getEffectiveUrl(link) {
    const url = link.url && link.url.trim();
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

function createEmailLinkElement(link, index, total) {
    const wrapper = document.createElement('div');
    const isRequired = REQUIRED_EMAIL_LINK_KEYS.has(link.linkKey);
    wrapper.className = 'email-link-wrapper';
    wrapper.dataset.index = index;
    wrapper.dataset.linkType = 'email';
    wrapper.dataset.id = link.id;
    wrapper.innerHTML = `
        <a href="${escapeAttribute(getEffectiveEmailUrl(link))}" target="_blank" rel="noopener noreferrer" class="email-link" data-index="${index}" data-link-type="email" draggable="${editMode ? 'true' : 'false'}" title="${escapeAttribute(link.title || '邮箱登录')}">
            ${getMailIconSvg()}
            <span class="email-link-label">${escapeHtml(link.title || '邮箱登录')}</span>
        </a>
        <div class="email-link-actions">
            ${isRequired ? '' : `
                <button type="button" class="email-link-delete" data-index="${index}" title="删除邮箱链接">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2v2"/></svg>
                </button>
            `}
        </div>
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
        <span class="nav-add-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
        </span>
        <span class="email-add-label">添加邮箱</span>
    `;
    return button;
}

function renderEmailLinks() {
    const container = document.getElementById('email-links-container');
    if (!container) return;

    container.innerHTML = '';
    const links = getEmailLinks();
    links.forEach((link, index) => {
        container.appendChild(createEmailLinkElement(link, index, links.length));
    });

    if (editMode) {
        container.appendChild(createAddEmailLinkElement());
    }

    container.hidden = !getEmailLinks().length && !editMode;
}

function createNavCardElement(link, index, options = {}) {
    const { noAnimation = false, linkType = 'website' } = options;
    const href = getEffectiveUrl(link);
    const iconDescriptor = getLinkIconDescriptor(link, linkType);
    const fallbackFavicon = '<svg class="nav-favicon-fallback" style="display:none" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';

    const card = document.createElement('div');
    card.className = 'nav-card-wrapper' + (noAnimation ? ' no-animation' : '');
    card.dataset.index = index;
    card.dataset.linkType = linkType;
    card.dataset.id = link.id;

    card.innerHTML = `
        <a href="${href}" target="_blank" rel="noopener noreferrer" class="nav-card" data-index="${index}" data-link-type="${linkType}" draggable="${editMode ? 'true' : 'false'}">
            <div class="nav-icon${iconDescriptor?.mode === 'none' ? ' nav-icon-empty' : ''}">
                ${iconDescriptor?.mode === 'none'
                    ? ''
                    : `<img alt="" class="nav-favicon" loading="${options.eager ? 'eager' : 'lazy'}"${options.priority ? ' fetchpriority="high"' : ''} decoding="async" data-icon-entity="links" data-icon-id="${escapeAttribute(String(link.id))}">${fallbackFavicon}`
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
    if (faviconImg && iconDescriptor) {
        hydrateIconElement(faviconImg, iconDescriptor);
    }

    const navCard = card.querySelector('.nav-card');

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

function renderLinkCards(linkType = 'website', options = {}) {
    const { refreshIcon = false } = options;
    const container = getLinkContainer(linkType);
    const emptyState = getLinkEmptyState(linkType);
    const links = getLinkCollection(linkType);
    if (!container || !emptyState) return;

    container.querySelectorAll('.nav-card-wrapper').forEach(el => el.remove());
    updateLinkEmptyState(linkType);

    const eagerCount = getEagerIconCount(linkType);
    links.forEach((link, index) => {
        const card = createNavCardElement(link, index, {
            linkType,
            refreshIcon,
            eager: index < eagerCount,
            priority: index === 0
        });
        container.insertBefore(card, emptyState);
    });

    // Re-insert the "+" add button if in edit mode.
    // renderLinkCards does a blanket remove of all .nav-card-wrapper (including .nav-add-wrapper),
    // so we must restore the add card here. This fixes the add button disappearing after adding/deleting links.
    syncAddLinkCard(linkType);
}

function renderNavCards(options = {}) {
    renderLinkCards('website', options);
}

function renderProjectCards(options = {}) {
    const section = document.getElementById('project-links-section');
    if (section) {
        section.hidden = !getProjectLinks().length && !editMode;
    }
    renderLinkCards('project', options);
}

function renderLinkCollection(linkType = 'website') {
    if (linkType === 'email') {
        renderEmailLinks();
        return;
    }

    renderLinkCards(linkType);
}


function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttribute(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
}

function getLinkCollection(linkType) {
    if (linkType === 'email') return getEmailLinks();
    if (linkType === 'project') return getProjectLinks();
    return getLinks();
}

function updateEditModeUI() {
    const editModeBtn = document.getElementById('edit-mode-btn');
    document.body.classList.toggle('edit-mode-active', editMode);
    if (editModeBtn) {
        editModeBtn.classList.toggle('active', editMode);
        editModeBtn.setAttribute('aria-pressed', String(editMode));
        editModeBtn.title = editMode ? '完成编辑' : '进入编辑模式';
        const label = editModeBtn.querySelector('.corner-btn-label');
        if (label) label.textContent = editMode ? '完成' : '编辑';
    }
    renderEmailLinks();
    renderNavCards();
    const projectSection = document.getElementById('project-links-section');
    if (projectSection) projectSection.hidden = !getProjectLinks().length && !editMode;
    renderProjectCards();
}


function parseCssPixelValue(value, fallback = 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getMaxAvailableLayoutColumns(linkType = 'website') {
    const container = getLinkContainer(linkType);
    if (window.matchMedia('(max-width: 768px) and (pointer: coarse)').matches) {
        const linkCount = Math.max(1, getLinkCollection(linkType).length);
        return Math.min(2, linkCount);
    }

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

function getEagerIconCount(linkType = 'website') {
    const columns = getLayoutColumnsForLinkType(linkType);
    return columns > 0 ? columns : 6;
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
    page.renderLayoutButtons?.();
}

function applyLinkSizes() {
    applyLinkSize('project', projectLinkSize);
    applyLinkSize('website', bookmarkLinkSize);
}

function applyBookmarkGlass() {
    [
        document.getElementById('project-links-container'),
        document.getElementById('nav-links-container')
    ].forEach(container => {
        container?.classList.toggle('glass-off', !bookmarkGlass);
    });
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


function updateGlassToggleState() {
    document.querySelectorAll('.glass-btn').forEach(btn => {
        const enabled = btn.dataset.enabled === 'true';
        btn.classList.toggle('active', enabled === bookmarkGlass);
    });
}

async function setBookmarkGlass(enabled) {
    const previous = bookmarkGlass;
    bookmarkGlass = enabled;
    appState.settings.bookmarkGlass = enabled;
    applyBookmarkGlass();
    updateGlassToggleState();

    try {
        await saveSettingsPatch({ bookmarkGlass: enabled });
    } catch (error) {
        bookmarkGlass = previous;
        appState.settings.bookmarkGlass = previous;
        applyBookmarkGlass();
        updateGlassToggleState();
        showNotice(error.message);
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
        showNotice(error.message);
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
        showNotice(error.message);
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
        showNotice(error.message);
    }
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
    bookmarkLinkDisplayMode = appState.settings.bookmarkLinkDisplayMode === 'default' ? 'default' : 'centered';
    projectLinkSize = normalizeLinkSize(appState.settings.projectLinkSize);
    bookmarkLinkSize = normalizeLinkSize(appState.settings.bookmarkLinkSize);
    bookmarkGlass = appState.settings.bookmarkGlass !== false;
    editMode = Boolean(appState.settings.editMode);
    applyLinkSizes();
    applyLayoutColumns(layoutColumns);
    applyLayoutColumns(projectLayoutColumns, 'project');
    applyLinkDisplayModes();
    updateDisplayModeButtonState();
    updateLinkSizeButtonState();
    applyBookmarkGlass();
    updateGlassToggleState();
    updateEditModeUI();
    applyCustomBackground(appState.settings.backgroundUrl || '');
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


const ADMIN_TRIGGERS = ['#edit-mode-btn', '.manage-menu-btn', '.background-btn', '#account-btn'];
let adminPromise = null;

function ensureAdmin() {
    if (document.documentElement.dataset.adminReady === '1') return Promise.resolve();
    if (!adminPromise) {
        const adminUrl = document.querySelector('script[type="module"][data-admin]')?.dataset.admin || './admin.js';
        adminPromise = import(adminUrl)
            .then((mod) => {
                mod.install();
            })
            .catch((error) => {
                adminPromise = null;
                throw error;
            });
    }
    return adminPromise;
}

function bindLazyAdmin() {
    ADMIN_TRIGGERS.forEach((selector) => {
        const element = document.querySelector(selector);
        if (!element) return;
        element.addEventListener('click', (event) => {
            if (document.documentElement.dataset.adminReady === '1') return;
            event.preventDefault();
            event.stopImmediatePropagation();
            ensureAdmin()
                .then(() => element.click())
                .catch((error) => showNotice(error.message));
        }, true);
    });
}

function init() {
    injectAnimationStyles();
    bindAuth();
    bindSearchEvents();
    bindLazyAdmin();
    restoreSession();
}

Object.assign(page, {
    appState,
    apiRequest,
    applyLinksResponse,
    applySearchEnginesResponse,
    applySettings,
    saveSettingsPatch,
    updateEditModeUI,
    getLinkCollection,
    getLinkContainer,
    getLinkEmptyState,
    setLinkCollection,
    getLinks,
    getEmailLinks,
    getProjectLinks,
    renderEmailLinks,
    renderNavCards,
    renderProjectCards,
    renderLinkCollection,
    escapeHtml,
    escapeAttribute,
    applyLayoutColumns,
    applyLinkSizeState,
    applyDisplayModeState,
    applyBookmarkGlass,
    updateLayoutButtonState,
    updateDisplayModeButtonState,
    updateLinkSizeButtonState,
    updateGlassToggleState,
    getLayoutColumnsForLinkType,
    getMaxAvailableLayoutColumns,
    getDisplayModeForLinkType,
    getLinkSizeForLinkType,
    setBookmarkGlass,
    setDisplayMode,
    setLinkSize,
    setLayoutColumns,
    setLinkLayoutColumns,
    rebuildSearchEngines,
    renderSearchEngineButtons,
    hydrateIconElement,
    getSearchEngineIconDescriptor,
    getEngineKey,
    getFallbackSearchEngineRecords,
    isValidBackgroundUrl,
    showLoggedOut
});

Object.defineProperty(page, 'currentEngine', {
    get() {
        return currentEngine;
    },
    set(value) {
        currentEngine = value;
    }
});

Object.defineProperty(page, 'editMode', {
    get() {
        return editMode;
    },
    set(value) {
        editMode = value;
    }
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

console.log('%c个人导航首页', 'font-size: 24px; font-weight: bold; color: #667eea;');
console.log('快捷键: Ctrl/Cmd + K 聚焦搜索框, Ctrl/Cmd + 1/2/3/4 切换搜索引擎');

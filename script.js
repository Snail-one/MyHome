// ==================== 搜索引擎配置 ====================
const searchEngines = {
    google: {
        name: 'Google',
        url: 'https://www.google.com/search?q=',
        placeholder: '搜索 Google...'
    },
    youtube: {
        name: 'YouTube',
        url: 'https://www.youtube.com/results?search_query=',
        placeholder: '在 YouTube 搜索...'
    },
    github: {
        name: 'GitHub',
        url: 'https://github.com/search?q=',
        placeholder: '搜索 GitHub...'
    },
    bilibili: {
        name: '哔哩哔哩',
        url: 'https://search.bilibili.com/all?keyword=',
        placeholder: '在 B 站搜索...'
    }
};

const DEFAULT_SETTINGS = {
    layoutColumns: 0,
    editMode: false,
    backgroundUrl: ''
};

const appState = {
    user: null,
    links: [],
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

// ==================== DOM 元素 ====================
const searchInput = document.querySelector('.search-input');
const searchBox = document.querySelector('.search-box');
const engineButtons = document.querySelectorAll('.engine-btn');
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
    const [linksData, settingsData] = await Promise.all([
        apiRequest('/api/links'),
        apiRequest('/api/settings')
    ]);

    appState.links = Array.isArray(linksData.links) ? linksData.links : [];
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
    appState.settings = { ...DEFAULT_SETTINGS };
    document.body.classList.remove('auth-pending', 'logged-in');
    document.body.classList.add('logged-out');
    authScreen?.setAttribute('aria-hidden', 'false');
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
    engineButtons.forEach(btn => {
        btn.addEventListener('click', () => switchSearchEngine(btn.dataset.engine));
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

    engineButtons.forEach(btn => {
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
    window.open(engineConfig.url + encodeURIComponent(query), '_blank');
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

function getFaviconUrl(url, size = 64) {
    const domain = getDomainFromUrl(url);
    if (!domain) return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}

function getFallbackFaviconUrl(url) {
    const domain = getDomainFromUrl(url);
    if (!domain) return null;
    return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
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
    const faviconUrl = getFaviconUrl(link.url);
    const fallbackUrl = getFallbackFaviconUrl(link.url);

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
                    ? `<img src="${faviconUrl}" alt="" class="nav-favicon"
                         onerror="if(this.src!==decodeURIComponent('${encodeURIComponent(fallbackUrl || '')}')){this.src='${fallbackUrl || ''}';}else{this.style.display='none';this.nextElementSibling.style.display='block';}">
                         <svg class="nav-favicon-fallback" style="display:none" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>`
                    : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>`
                }
            </div>
            <div class="nav-info">
                <div class="nav-title">${escapeHtml(link.title || '未命名')}</div>
            </div>
        </a>
        <div class="nav-card-actions">
            <button type="button" class="nav-card-edit" data-index="${index}" title="编辑">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button type="button" class="nav-card-delete" data-index="${index}" title="删除">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2v2"/></svg>
            </button>
        </div>
    `;

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

function renderNavCards() {
    const container = document.getElementById('nav-links-container');
    const emptyState = document.getElementById('nav-empty-state');
    const links = getLinks();

    container.querySelectorAll('.nav-card-wrapper').forEach(el => el.remove());
    emptyState.style.display = links.length ? 'none' : 'block';

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

// ==================== 菜单管理 ====================
function openManageModal(editIndex) {
    const form = document.getElementById('link-form');
    const links = getLinks();
    openModal('manage-modal');
    form.reset();

    if (typeof editIndex === 'number' && links[editIndex]) {
        const link = links[editIndex];
        document.getElementById('link-title').value = link.title || '';
        document.getElementById('link-url').value = link.url || '';
        form.dataset.editIndex = editIndex;
        document.querySelector('.link-form .btn-primary').textContent = '更新链接';
    } else {
        delete form.dataset.editIndex;
        document.querySelector('.link-form .btn-primary').textContent = '添加链接';
    }

    document.querySelectorAll('.layout-btn').forEach(btn => {
        const btnCols = parseInt(btn.dataset.columns, 10);
        btn.classList.toggle('active', btnCols === layoutColumns);
    });
}

function closeManageModal() {
    closeModal('manage-modal');
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
    openManageModal(index);
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

    document.querySelectorAll('.layout-btn').forEach(btn => {
        const btnCols = parseInt(btn.dataset.columns, 10);
        btn.classList.toggle('active', btnCols === columns);
    });
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

function bindMenuManagement() {
    const manageBtn = document.querySelector('.manage-menu-btn');
    const editModeBtn = document.getElementById('edit-mode-btn');
    const form = document.getElementById('link-form');
    const cancelBtn = document.getElementById('link-form-cancel');

    manageBtn.addEventListener('click', () => openManageModal());
    if (editModeBtn) editModeBtn.addEventListener('click', toggleEditMode);
    cancelBtn.addEventListener('click', closeManageModal);

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
            closeManageModal();
        } catch (error) {
            alert(error.message);
        } finally {
            submitBtn.disabled = false;
        }
    });

    document.querySelectorAll('.layout-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const columns = parseInt(btn.dataset.columns, 10);
            setLayoutColumns(columns);
        });
    });

    document.getElementById('nav-links-container').addEventListener('click', (event) => {
        const editBtn = event.target.closest('.nav-card-edit');
        const deleteBtn = event.target.closest('.nav-card-delete');

        if (editBtn) {
            event.preventDefault();
            event.stopPropagation();
            editLink(parseInt(editBtn.dataset.index, 10));
        } else if (deleteBtn) {
            event.preventDefault();
            event.stopPropagation();
            deleteLink(parseInt(deleteBtn.dataset.index, 10));
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

        const maxFileSize = 5 * 1024 * 1024;
        if (file.size > maxFileSize) {
            alert('图片文件不能超过 5MB');
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

function init() {
    injectAnimationStyles();
    updateSearchEngine(currentEngine);
    bindAuth();
    bindSearchEvents();
    bindMenuManagement();
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

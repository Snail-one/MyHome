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

// 当前选中的搜索引擎
let currentEngine = 'google';

// ==================== DOM 元素 ====================
const searchInput = document.querySelector('.search-input');
const searchBox = document.querySelector('.search-box');
const engineButtons = document.querySelectorAll('.engine-btn');
const engineIndicator = document.querySelector('.current-engine');
const searchEngineIndicator = document.querySelector('.search-engine-indicator');


// ==================== 事件绑定 ====================
function bindEvents() {
    // 搜索引擎切换按钮
    engineButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const engine = btn.dataset.engine;
            switchSearchEngine(engine);
        });
    });

    // 搜索引擎指示器点击（执行搜索）
    searchEngineIndicator.addEventListener('click', () => {
        performSearch();
    });

    // 搜索输入框 - Enter 键搜索
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            performSearch();
        }
    });

    // 搜索框焦点效果
    searchInput.addEventListener('focus', () => {
        searchBox.classList.add('focused');
    });

    searchInput.addEventListener('blur', () => {
        searchBox.classList.remove('focused');
    });
}

// ==================== 切换搜索引擎 ====================
function switchSearchEngine(engine) {
    if (!searchEngines[engine]) {
        console.error('未知的搜索引擎:', engine);
        return;
    }

    currentEngine = engine;
    updateSearchEngine(engine);

    // 添加切换动画效果
    searchBox.style.animation = 'none';
    setTimeout(() => {
        searchBox.style.animation = '';
    }, 10);
}

// ==================== 更新搜索引擎 UI ====================
function updateSearchEngine(engine) {
    const engineConfig = searchEngines[engine];

    // 更新搜索框占位符
    searchInput.placeholder = engineConfig.placeholder;

    // 更新引擎指示器
    engineIndicator.textContent = engineConfig.name;

    // 更新按钮激活状态
    engineButtons.forEach(btn => {
        if (btn.dataset.engine === engine) {
            btn.classList.add('active');
            // 添加脉冲动画
            btn.style.animation = 'pulse 0.3s ease';
            setTimeout(() => {
                btn.style.animation = '';
            }, 300);
        } else {
            btn.classList.remove('active');
        }
    });
}

// ==================== 执行搜索 ====================
function performSearch() {
    const query = searchInput.value.trim();

    if (!query) {
        // 如果搜索内容为空，添加抖动效果提示
        searchBox.style.animation = 'shake 0.5s ease';
        setTimeout(() => {
            searchBox.style.animation = '';
        }, 500);
        return;
    }

    const engineConfig = searchEngines[currentEngine];
    const searchUrl = engineConfig.url + encodeURIComponent(query);

    // 在新窗口打开搜索结果
    window.open(searchUrl, '_blank');
}

// ==================== CSS 动画（通过 JS 动态添加）====================
// 添加抖动动画样式
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

// ==================== 快捷键支持 ====================
document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + K 聚焦搜索框
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
    }

    // Esc 键清空搜索框
    if (e.key === 'Escape') {
        searchInput.value = '';
        searchInput.blur();
    }

    // Ctrl/Cmd + 1 切换到 Google
    if ((e.ctrlKey || e.metaKey) && e.key === '1') {
        e.preventDefault();
        switchSearchEngine('google');
    }

    // Ctrl/Cmd + 2 切换到 GitHub
    if ((e.ctrlKey || e.metaKey) && e.key === '2') {
        e.preventDefault();
        switchSearchEngine('github');
    }

    // Ctrl/Cmd + 3 切换到哔哩哔哩
    if ((e.ctrlKey || e.metaKey) && e.key === '3') {
        e.preventDefault();
        switchSearchEngine('bilibili');
    }

    // Ctrl/Cmd + 4 切换到 YouTube
    if ((e.ctrlKey || e.metaKey) && e.key === '4') {
        e.preventDefault();
        switchSearchEngine('youtube');
    }
});

// ==================== 菜单管理：链接存储 ====================
const LINKS_STORAGE_KEY = 'nav-menu-links';
const CUSTOM_BACKGROUND_KEY = 'nav-custom-background';
const LAYOUT_COLUMNS_KEY = 'nav-layout-columns';
const EDIT_MODE_KEY = 'nav-edit-mode';

let layoutColumns = parseInt(localStorage.getItem(LAYOUT_COLUMNS_KEY) || '0', 10) || 0; // 0 = auto, 1-6 = fixed
let editMode = localStorage.getItem(EDIT_MODE_KEY) === 'true'; // 编辑模式状态

// 数据迁移：从旧格式转换为新格式
function migrateLinksData() {
    const raw = localStorage.getItem(LINKS_STORAGE_KEY);
    if (!raw) return;

    try {
        const links = JSON.parse(raw);
        if (!Array.isArray(links)) return;

        // 检查是否需要迁移
        const needsMigration = links.some(link =>
            link && typeof link === 'object' &&
            ('urlExternal' in link || 'urlInternal' in link)
        );

        if (needsMigration) {
            const migratedLinks = links.map(link => {
                if (!link || typeof link !== 'object') return null;
                return {
                    title: link.title || '未命名',
                    url: link.url || link.urlExternal || link.urlInternal || ''
                };
            }).filter(link => link && link.url);

            saveLinks(migratedLinks);
            console.log('链接数据已迁移到新格式');
        }
    } catch (e) {
        console.warn('数据迁移失败:', e);
    }
}

function getLinks() {
    try {
        const raw = localStorage.getItem(LINKS_STORAGE_KEY);
        if (!raw) return [];
        const links = JSON.parse(raw);

        // 验证数据结构
        if (!Array.isArray(links)) return [];

        return links.filter(link => {
            if (typeof link !== 'object' || !link) return false;
            if (typeof link.title !== 'string') return false;
            if (typeof link.url !== 'string') return false;
            return true;
        });
    } catch {
        console.warn('Invalid links data in localStorage');
        return [];
    }
}

function saveLinks(links) {
    localStorage.setItem(LINKS_STORAGE_KEY, JSON.stringify(links));
}

function getDomainFromUrl(url) {
    if (!url || typeof url !== 'string' || !url.trim()) return null;
    try {
        const normalizedUrl = url.startsWith('http') ? url : 'https://' + url;
        const u = new URL(normalizedUrl);
        // 只允许 http/https 协议
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.hostname;
    } catch {
        return null;
    }
}

function getFaviconUrl(url, size = 64) {
    const domain = getDomainFromUrl(url);
    if (!domain) return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}

function getFallbackFaviconUrl(url, size = 64) {
    const domain = getDomainFromUrl(url);
    if (!domain) return null;
    return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

function getEffectiveUrl(link) {
    const url = link.url && link.url.trim();

    // 验证 URL 协议
    try {
        if (!url) return 'javascript:void(0)'; // 安全的无-op 链接
        const urlObj = new URL(url.startsWith('http') ? url : 'https://' + url);
        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
            return 'javascript:void(0)'; // 禁止非 http/https
        }
        return urlObj.href;
    } catch {
        return 'javascript:void(0)'; // 无效 URL 则禁用链接
    }
}

let draggedCard = null;
let draggedIndex = null;
let isDragging = false;
let dragStartTime = 0;

/**
 * 创建导航卡片元素的辅助函数（消除重复代码）
 */
function createNavCardElement(link, index, options = {}) {
    const { noAnimation = false } = options;
    const href = getEffectiveUrl(link);
    const faviconUrl = getFaviconUrl(link.url);
    const fallbackUrl = getFallbackFaviconUrl(link.url);

    const card = document.createElement('div');
    card.className = 'nav-card-wrapper' + (noAnimation ? ' no-animation' : '');
    card.dataset.index = index;

    // 用 JS 设置交错动画延迟，避免 nth-child 选择器问题
    if (!noAnimation) {
        const delay = 0.3 + (index * 0.05);
        card.style.animationDelay = `${delay}s`;
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

    // 绑定拖拽事件
    const navCard = card.querySelector('.nav-card');
    navCard.addEventListener('dragstart', handleDragStart);
    navCard.addEventListener('dragend', handleDragEnd);
    navCard.addEventListener('dragover', handleDragOver);
    navCard.addEventListener('drop', handleDrop);
    navCard.addEventListener('dragenter', handleDragEnter);
    navCard.addEventListener('dragleave', handleDragLeave);

    // 绑定涟漪动画重触发事件（确保每次悬停都播放动画）
    navCard.addEventListener('mouseenter', function() {
        // 通过暂时移除 hover-ripple 类来重置动画
        this.classList.remove('hover-ripple');
        // 触发重排
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

    // 移除所有 wrapper 元素，而不只是 nav-card
    container.querySelectorAll('.nav-card-wrapper').forEach(el => el.remove());
    emptyState.style.display = links.length ? 'none' : 'block';

    links.forEach((link, index) => {
        const card = createNavCardElement(link, index);
        container.insertBefore(card, emptyState);
    });

    updateEditModeUI();
}

function handleDragStart(e) {
    draggedCard = this;
    draggedIndex = parseInt(this.dataset.index);
    isDragging = true;
    dragStartTime = Date.now();
    // 不改变 opacity，保持毛玻璃效果不变
    this.style.transform = 'scale(0.98)';
    this.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.3)';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedIndex);
    // 创建一个透明的拖拽图像，避免默认拖拽反馈
    const dragImage = document.createElement('div');
    dragImage.style.width = '0px';
    dragImage.style.height = '0px';
    document.body.appendChild(dragImage);
    e.dataTransfer.setDragImage(dragImage, 0, 0);
    setTimeout(() => document.body.removeChild(dragImage), 0);
}

function handleDragEnd(e) {
    this.style.transform = '';
    this.style.boxShadow = '';
    document.querySelectorAll('.nav-card').forEach(card => {
        card.classList.remove('drag-over');
    });
    draggedCard = null;
    draggedIndex = null;
    setTimeout(() => { isDragging = false; }, 100);
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function handleDragEnter(e) {
    e.preventDefault();
    if (this !== draggedCard) {
        this.classList.add('drag-over');
    }
}

function handleDragLeave(e) {
    this.classList.remove('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    if (this === draggedCard) return;

    const dropIndex = parseInt(this.dataset.index);
    if (draggedIndex === null || dropIndex === draggedIndex) return;

    const links = getLinks();
    const [draggedItem] = links.splice(draggedIndex, 1);
    links.splice(dropIndex, 0, draggedItem);
    saveLinks(links);

    const container = document.getElementById('nav-links-container');

    // 临时禁用动画，防止拖拽后闪烁
    container.style.transition = 'none';

    // 直接重新渲染所有卡片
    renderNavCards();

    // 触发重排后恢复
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            container.style.transition = '';
        });
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function openManageModal(editIndex) {
    const modal = document.getElementById('manage-modal');
    const form = document.getElementById('link-form');
    const links = getLinks();
    openModal('manage-modal');
    form.reset();

    // 如果是编辑模式，填充表单
    if (typeof editIndex === 'number' && links[editIndex]) {
        const link = links[editIndex];
        document.getElementById('link-title').value = link.title || '';
        document.getElementById('link-url').value = link.url || '';
        // 保存编辑索引到表单，用于提交时判断
        form.dataset.editIndex = editIndex;
        document.querySelector('.link-form .btn-primary').textContent = '更新链接';
    } else {
        delete form.dataset.editIndex;
        document.querySelector('.link-form .btn-primary').textContent = '添加链接';
    }

    // 更新布局按钮状态
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

function toggleEditMode() {
    editMode = !editMode;
    localStorage.setItem(EDIT_MODE_KEY, editMode.toString());
    updateEditModeUI();
}

function updateEditModeUI() {
    const editModeBtn = document.getElementById('edit-mode-btn');
    const body = document.body;

    if (editMode) {
        body.classList.add('edit-mode-active');
        if (editModeBtn) {
            editModeBtn.classList.add('active');
        }
    } else {
        body.classList.remove('edit-mode-active');
        if (editModeBtn) {
            editModeBtn.classList.remove('active');
        }
    }
}

function deleteLink(index) {
    const links = getLinks();
    if (index >= 0 && index < links.length) {
        if (confirm(`确定要删除链接「${links[index].title}」吗？`)) {
            links.splice(index, 1);
            saveLinks(links);
            renderNavCards();
        }
    }
}

function editLink(index) {
    openManageModal(index);
}

function applyLayoutColumns(columns) {
    layoutColumns = columns;
    localStorage.setItem(LAYOUT_COLUMNS_KEY, columns.toString());
    const container = document.getElementById('nav-links-container');
    if (!container) return;

    if (columns === 0) {
        container.style.gridTemplateColumns = '';
        container.classList.remove('layout-fixed');
        container.style.removeProperty('--layout-cols');
    } else {
        container.style.setProperty('--layout-cols', columns.toString());
        container.classList.add('layout-fixed');
        // 列数由 CSS 媒体查询根据视口动态限制，此处只设置目标列数
    }

    document.querySelectorAll('.layout-btn').forEach(btn => {
        const btnCols = parseInt(btn.dataset.columns, 10);
        btn.classList.toggle('active', btnCols === columns);
    });
}

function bindMenuManagement() {
    const manageBtn = document.querySelector('.manage-menu-btn');
    const editModeBtn = document.getElementById('edit-mode-btn');
    const form = document.getElementById('link-form');
    const cancelBtn = document.getElementById('link-form-cancel');

    manageBtn.addEventListener('click', () => openManageModal());
    if (editModeBtn) {
        editModeBtn.addEventListener('click', toggleEditMode);
    }
    cancelBtn.addEventListener('click', closeManageModal);

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const links = getLinks();
        const title = document.getElementById('link-title').value.trim();
        const url = document.getElementById('link-url').value.trim();
        const editIndex = form.dataset.editIndex !== undefined ? parseInt(form.dataset.editIndex, 10) : null;

        if (!title) return;
        if (!url) {
            alert('请填写链接地址');
            return;
        }

        const item = { title, url };

        if (editIndex !== null && Number.isInteger(editIndex) && editIndex >= 0 && editIndex < links.length) {
            links[editIndex] = item;
        } else {
            links.push(item);
        }

        saveLinks(links);
        renderNavCards();
        closeManageModal();
    });

    // 布局设置按钮
    document.querySelectorAll('.layout-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const columns = parseInt(btn.dataset.columns, 10);
            applyLayoutColumns(columns);
        });
    });

    // 导航卡片上的编辑和删除按钮事件委托
    document.getElementById('nav-links-container').addEventListener('click', (e) => {
        const editBtn = e.target.closest('.nav-card-edit');
        const deleteBtn = e.target.closest('.nav-card-delete');

        if (editBtn) {
            e.preventDefault();
            e.stopPropagation();
            const index = parseInt(editBtn.dataset.index, 10);
            editLink(index);
        } else if (deleteBtn) {
            e.preventDefault();
            e.stopPropagation();
            const index = parseInt(deleteBtn.dataset.index, 10);
            deleteLink(index);
        }
    });

    // 通用关闭：按 data-close 关闭对应弹窗
    document.querySelectorAll('.modal-close[data-close]').forEach(btn => {
        btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
    });
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal(overlay.id);
        });
    });
}

// ==================== 自定义背景 ====================
function isValidBackgroundUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed) return false;

    try {
        // 只允许 http/https/data:image URL
        if (trimmed.startsWith('data:image/')) {
            return true; // 允许本地上传的 base64 图片
        }
        const urlObj = new URL(trimmed);
        return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch {
        return false;
    }
}

function applyCustomBackground(url) {
    if (!url || !url.trim()) {
        document.body.style.backgroundImage = '';
        document.body.style.backgroundSize = '';
        document.body.style.backgroundPosition = '';
        document.body.style.backgroundRepeat = '';
        localStorage.removeItem(CUSTOM_BACKGROUND_KEY);
        return;
    }

    // 验证 URL
    if (!isValidBackgroundUrl(url)) {
        console.warn('Invalid background URL rejected');
        return;
    }

    const u = url.trim();
    // 使用 URL 构造函数确保字符串正确转义
    const safeUrl = u.startsWith('data:') ? u : new URL(u).href;
    document.body.style.backgroundImage = `url("${safeUrl.replace(/"/g, '\\"')}")`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundRepeat = 'no-repeat';
    document.body.style.backgroundAttachment = 'fixed';
    localStorage.setItem(CUSTOM_BACKGROUND_KEY, u);
}

function applySavedBackground() {
    const saved = localStorage.getItem(CUSTOM_BACKGROUND_KEY);
    if (saved && saved.trim()) applyCustomBackground(saved);
}

function bindBackgroundModal() {
    const btn = document.querySelector('.background-btn');
    const modal = document.getElementById('background-modal');
    const fileInput = document.getElementById('background-upload');
    const urlInput = document.getElementById('background-url');
    const preview = document.getElementById('background-preview');
    const previewImg = document.getElementById('background-preview-img');
    const previewRemove = document.getElementById('background-preview-remove');
    const applyBtn = document.getElementById('background-apply');
    const resetBtn = document.getElementById('background-reset');

    let uploadedFileData = null;

    // 打开弹窗时恢复保存的背景
    btn.addEventListener('click', () => {
        const saved = localStorage.getItem(CUSTOM_BACKGROUND_KEY) || '';
        if (saved && saved.startsWith('data:image')) {
            // 如果是 base64，显示预览
            previewImg.src = saved;
            preview.style.display = 'block';
            uploadedFileData = saved;
            urlInput.value = '';
        } else {
            urlInput.value = saved;
            preview.style.display = 'none';
            uploadedFileData = null;
        }
        fileInput.value = '';
        openModal('background-modal');
    });

    // 文件选择
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // 添加文件大小限制（5MB）
        const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
        if (file.size > MAX_FILE_SIZE) {
            alert('图片文件不能超过 5MB');
            fileInput.value = '';
            return;
        }

        if (!file.type.startsWith('image/')) {
            alert('请选择图片文件');
            fileInput.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            uploadedFileData = event.target.result; // base64 数据
            previewImg.src = uploadedFileData;
            preview.style.display = 'block';
            urlInput.value = ''; // 清空URL输入
        };
        reader.onerror = () => {
            alert('图片读取失败，请重试');
            fileInput.value = '';
        };
        reader.readAsDataURL(file);
    });

    // 移除预览
    previewRemove.addEventListener('click', () => {
        preview.style.display = 'none';
        fileInput.value = '';
        uploadedFileData = null;
    });

    // 应用背景
    applyBtn.addEventListener('click', () => {
        const urlValue = urlInput.value.trim();
        if (uploadedFileData) {
            // 优先使用上传的文件
            applyCustomBackground(uploadedFileData);
        } else if (urlValue) {
            // 验证 URL 后再应用
            if (!isValidBackgroundUrl(urlValue)) {
                alert('请输入有效的图片 URL（http/https 开头）');
                return;
            }
            applyCustomBackground(urlValue);
        } else {
            // 清空背景
            applyCustomBackground('');
        }
        closeModal('background-modal');
    });

    // 恢复默认
    resetBtn.addEventListener('click', () => {
        applyCustomBackground('');
        urlInput.value = '';
        preview.style.display = 'none';
        fileInput.value = '';
        uploadedFileData = null;
        closeModal('background-modal');
    });
}

// ==================== 初始化 ====================
function init() {
    // 设置默认搜索引擎
    updateSearchEngine(currentEngine);
    bindEvents();
    searchInput.focus();

    // 迁移旧数据
    migrateLinksData();

    // 编辑模式
    editMode = localStorage.getItem(EDIT_MODE_KEY) === 'true';

    renderNavCards();
    bindMenuManagement();
    bindBackgroundModal();
    applySavedBackground();
    applyLayoutColumns(layoutColumns); // 应用保存的布局设置
    updateEditModeUI(); // 应用编辑模式状态
}

// ==================== 页面加载完成后初始化 ====================
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// ==================== 控制台欢迎信息 ====================
console.log('%c🌟 个人导航首页', 'font-size: 24px; font-weight: bold; color: #667eea;');
console.log('%c欢迎使用！', 'font-size: 14px; color: #764ba2;');
console.log('%c快捷键提示:', 'font-size: 12px; font-weight: bold; margin-top: 10px;');
console.log('  • Ctrl/Cmd + K - 聚焦搜索框');
console.log('  • Ctrl/Cmd + 1 - 切换到 Google');
console.log('  • Ctrl/Cmd + 2 - 切换到 GitHub');
console.log('  • Ctrl/Cmd + 3 - 切换到哔哩哔哩');
console.log('  • Ctrl/Cmd + 4 - 切换到 YouTube');
console.log('  • Esc - 清空搜索框');

import { LINK_SIZE_OPTIONS } from './state.js';
import { page } from './main.js';

let draggedCard = null;
let draggedLinkType = 'website';
let isDragging = false;
let draggedWrapper = null;
let draggedPreviousLinks = null;
let dragReorderFrame = null;
let dragPointerX = 0;
let dragPointerY = 0;
let selectedBackgroundFile = null;
let previewObjectUrl = null;
let iconCacheRefreshRunning = false;
let layoutResizeTimer = null;

function bindDragDelegation() {
    document.addEventListener('dragstart', (event) => {
        const handle = event.target.closest?.('.nav-card[draggable="true"], .email-link[draggable="true"]');
        if (!handle || handle.classList.contains('nav-add-card') || handle.classList.contains('email-add-link')) return;
        handleDragStart.call(handle, event);
    });

    document.addEventListener('dragend', (event) => {
        if (!draggedCard) return;
        handleDragEnd(event);
    });

    bindLinkDragContainer(document.getElementById('email-links-container'), 'email');
    bindLinkDragContainer(document.getElementById('project-links-container'), 'project');
    bindLinkDragContainer(document.getElementById('nav-links-container'), 'website');
}

export function install() {
    if (document.documentElement.dataset.adminReady === '1') return;
    document.documentElement.dataset.adminReady = '1';
    page.renderSearchEngineList = renderSearchEngineList;
    page.renderLayoutButtons = renderLayoutButtons;
    page.handleEscape = () => {
        if (closeActiveModal()) return true;
        if (page.editMode) {
            toggleEditMode();
            return true;
        }
        return false;
    };
    bindMenuManagement();
    bindBackgroundModal();
    bindLayoutResize();
    bindDragDelegation();
    document.getElementById('account-btn')?.addEventListener('click', openAccountModal);
}

function areLinkOrdersEqual(leftLinks, rightLinks) {
    if (!Array.isArray(leftLinks) || !Array.isArray(rightLinks)) return false;
    if (leftLinks.length !== rightLinks.length) return false;
    return leftLinks.every((link, index) => link.id === rightLinks[index]?.id);
}

function getSortableWrapperSelector(linkType = 'website') {
    return linkType === 'email'
        ? '.email-link-wrapper[data-id]'
        : '.nav-card-wrapper[data-id]';
}

function getSortableWrappers(linkType = 'website') {
    const container = page.getLinkContainer(linkType);
    if (!container) return [];
    return Array.from(container.querySelectorAll(getSortableWrapperSelector(linkType)));
}

function getDragAppendReference(linkType = 'website') {
    const container = page.getLinkContainer(linkType);
    if (!container) return null;
    if (linkType === 'email') return container.querySelector('.email-add-link');
    return container.querySelector('.nav-add-wrapper') || page.getLinkEmptyState(linkType);
}

function getDomOrderedLinks(linkType = 'website') {
    const links = page.getLinkCollection(linkType);
    if (!links.length) return null;

    const wrappers = getSortableWrappers(linkType);
    if (wrappers.length !== links.length) return null;

    const linkMap = new Map(links.map(link => [link.id, link]));
    const nextLinks = [];
    const seenIds = new Set();

    for (const wrapper of wrappers) {
        const id = parseInt(wrapper.dataset.id, 10);
        if (!linkMap.has(id) || seenIds.has(id)) return null;
        seenIds.add(id);
        nextLinks.push(linkMap.get(id));
    }

    return nextLinks;
}

function updateSortableIndices(linkType = 'website') {
    getSortableWrappers(linkType).forEach((wrapper, index) => {
        wrapper.dataset.index = index;
        wrapper.querySelectorAll('[data-index]').forEach(element => {
            element.dataset.index = index;
        });
    });
}

function setLinksStateFromResponse(data) {
    if (
        Array.isArray(data.links) &&
        Array.isArray(data.emailLinks) &&
        Array.isArray(data.projectLinks)
    ) {
        page.appState.links = data.links;
        page.appState.emailLinks = data.emailLinks;
        page.appState.projectLinks = data.projectLinks;
        return true;
    }

    return false;
}

async function persistLinkOrder(linkType, links, previousLinks, options = {}) {
    const { renderOnSuccess = true } = options;

    try {
        const data = await page.apiRequest('/api/links/reorder', {
            method: 'PUT',
            body: { ids: links.map(link => link.id), type: linkType }
        });

        if (setLinksStateFromResponse(data)) {
            if (renderOnSuccess) page.applyLinksResponse(data);
        } else {
            page.setLinkCollection(linkType, links);
            if (renderOnSuccess) page.renderLinkCollection(linkType);
        }
        return true;
    } catch (error) {
        page.setLinkCollection(linkType, previousLinks);
        page.renderLinkCollection(linkType);
        alert(error.message);
        return false;
    }
}

async function commitDraggedOrder(linkType, previousLinks) {
    const nextLinks = getDomOrderedLinks(linkType);
    if (!nextLinks || !previousLinks || areLinkOrdersEqual(nextLinks, previousLinks)) {
        return false;
    }

    page.setLinkCollection(linkType, nextLinks);
    updateSortableIndices(linkType);

    return persistLinkOrder(linkType, nextLinks, previousLinks, { renderOnSuccess: false });
}

function getDragInsertionReference(linkType, pointerX, pointerY) {
    const wrappers = getSortableWrappers(linkType)
        .filter(wrapper => wrapper !== draggedWrapper);

    if (!wrappers.length) return getDragAppendReference(linkType);

    const items = wrappers.map(wrapper => ({
        wrapper,
        rect: wrapper.getBoundingClientRect()
    })).filter(item => item.rect.width > 0 && item.rect.height > 0);

    if (!items.length) return getDragAppendReference(linkType);

    const rowThreshold = Math.max(8, Math.min(...items.map(item => item.rect.height)) / 2);
    const topEdge = Math.min(...items.map(item => item.rect.top));
    const bottomEdge = Math.max(...items.map(item => item.rect.bottom));

    if (pointerY < topEdge) return items[0].wrapper;
    if (pointerY > bottomEdge) return getDragAppendReference(linkType);

    const rows = [];

    items.forEach((item) => {
        const centerY = item.rect.top + item.rect.height / 2;
        let row = rows.find(candidate => Math.abs(candidate.centerY - centerY) <= rowThreshold);
        if (!row) {
            row = { centerY, items: [] };
            rows.push(row);
        }
        row.items.push(item);
        row.centerY = row.items.reduce((sum, rowItem) => (
            sum + rowItem.rect.top + rowItem.rect.height / 2
        ), 0) / row.items.length;
    });

    rows.sort((left, right) => left.centerY - right.centerY);
    rows.forEach(row => {
        row.items.sort((left, right) => left.rect.left - right.rect.left);
    });

    const targetRow = rows.reduce((closest, row) => {
        if (!closest) return row;
        return Math.abs(row.centerY - pointerY) < Math.abs(closest.centerY - pointerY)
            ? row
            : closest;
    }, null);

    if (!targetRow) return getDragAppendReference(linkType);

    const beforeItem = targetRow.items.find(item => {
        const centerX = item.rect.left + item.rect.width / 2;
        return pointerX < centerX;
    });

    if (beforeItem) return beforeItem.wrapper;

    const lastInRow = targetRow.items[targetRow.items.length - 1]?.wrapper;
    const lastIndex = wrappers.indexOf(lastInRow);
    return wrappers[lastIndex + 1] || getDragAppendReference(linkType);
}

function reorderDraggedWrapperAtPointer() {
    dragReorderFrame = null;

    if (!draggedWrapper || !draggedCard) return;
    const container = page.getLinkContainer(draggedLinkType);
    if (!container) return;

    const reference = getDragInsertionReference(draggedLinkType, dragPointerX, dragPointerY);
    if (reference === draggedWrapper) return;
    if (reference && reference.previousElementSibling === draggedWrapper) return;

    container.insertBefore(draggedWrapper, reference || getDragAppendReference(draggedLinkType));
    updateSortableIndices(draggedLinkType);
}

function scheduleDraggedWrapperReorder(event) {
    dragPointerX = event.clientX;
    dragPointerY = event.clientY;

    if (dragReorderFrame) return;
    dragReorderFrame = requestAnimationFrame(reorderDraggedWrapperAtPointer);
}

function flushDraggedWrapperReorder() {
    if (dragReorderFrame) {
        cancelAnimationFrame(dragReorderFrame);
        dragReorderFrame = null;
        reorderDraggedWrapperAtPointer();
    }
}

function clearDragUi() {
    flushDraggedWrapperReorder();

    draggedCard?.classList.remove('dragging');
    draggedWrapper?.classList.remove('dragging');
    document.body.classList.remove('link-dragging');
    document.querySelectorAll('.drag-sorting').forEach(element => {
        element.classList.remove('drag-sorting');
    });
}

function handleDragStart(event) {
    if (!page.editMode) {
        event.preventDefault();
        return;
    }

    draggedCard = this;
    draggedWrapper = this.closest ? this.closest('.nav-card-wrapper') : null;
    if (!draggedWrapper && this.closest) {
        draggedWrapper = this.closest('.email-link-wrapper');
    }
    if (!draggedWrapper) {
        event.preventDefault();
        return;
    }

    draggedLinkType = this.dataset.linkType || 'website';
    draggedPreviousLinks = [...page.getLinkCollection(draggedLinkType)];
    isDragging = true;
    document.body.classList.add('link-dragging');
    draggedCard?.classList.add('dragging');
    draggedWrapper?.classList.add('dragging');
    page.getLinkContainer(draggedLinkType)?.classList.add('drag-sorting');

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(this.dataset.index || ''));

    try {
        const dragImage = this.cloneNode(true);
        dragImage.style.width = this.offsetWidth + 'px';
        dragImage.style.height = this.offsetHeight + 'px';
        dragImage.style.opacity = '0.85';
        dragImage.style.pointerEvents = 'none';
        dragImage.style.position = 'absolute';
        dragImage.style.top = '-9999px';
        document.body.appendChild(dragImage);
        event.dataTransfer.setDragImage(dragImage, event.offsetX || 20, event.offsetY || 20);
        setTimeout(() => {
            if (dragImage.parentNode) dragImage.parentNode.removeChild(dragImage);
        }, 0);
    } catch (_) {
        // fallback to invisible if clone fails
    }
}

async function handleDragEnd() {
    const linkType = draggedLinkType;
    const previousLinks = draggedPreviousLinks;

    clearDragUi();
    draggedCard = null;
    draggedLinkType = 'website';
    draggedWrapper = null;
    draggedPreviousLinks = null;
    setTimeout(() => { isDragging = false; }, 100);

    await commitDraggedOrder(linkType, previousLinks);
}

function handleLinkContainerDragOver(event, linkType) {
    if (!draggedWrapper || linkType !== draggedLinkType) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    scheduleDraggedWrapperReorder(event);
}

function handleLinkContainerDrop(event, linkType) {
    if (!draggedWrapper || linkType !== draggedLinkType) return;

    event.preventDefault();
    dragPointerX = event.clientX;
    dragPointerY = event.clientY;
    if (dragReorderFrame) {
        flushDraggedWrapperReorder();
    } else {
        reorderDraggedWrapperAtPointer();
    }
}

function bindLinkDragContainer(container, linkType = 'website') {
    if (!container) return;
    container.addEventListener('dragover', event => handleLinkContainerDragOver(event, linkType));
    container.addEventListener('drop', event => handleLinkContainerDrop(event, linkType));
}

function setAccountFormMessage(message, type = '') {
    const messageEl = document.getElementById('account-form-message');
    if (!messageEl) return;
    messageEl.textContent = message || '';
    messageEl.classList.toggle('is-error', type === 'error');
    messageEl.classList.toggle('is-success', type === 'success');
}

function resetAccountForm() {
    const form = document.getElementById('account-form');
    const usernameInput = document.getElementById('account-username');
    const currentUsername = document.getElementById('account-current-username');
    const username = page.appState.user?.username || '';
    if (currentUsername) currentUsername.textContent = username || '-';
    if (!form || !usernameInput) return;
    form.reset();
    usernameInput.value = username;
    setAccountFormMessage('');
}

async function submitAccountForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submitBtn = document.getElementById('account-form-submit');
    const username = document.getElementById('account-username')?.value.trim() || '';
    const currentPassword = document.getElementById('account-current-password')?.value || '';
    const newPassword = document.getElementById('account-new-password')?.value || '';
    const newPasswordConfirm = document.getElementById('account-new-password-confirm')?.value || '';

    setAccountFormMessage('');
    if (newPassword !== newPasswordConfirm) {
        setAccountFormMessage('两次输入的新密码不一致', 'error');
        return;
    }

    if (submitBtn) submitBtn.disabled = true;
    try {
        const data = await page.apiRequest('/api/account', {
            method: 'PUT',
            body: { username, currentPassword, newPassword }
        });
        page.appState.user = data.user || page.appState.user;
        form.reset();
        const usernameInput = document.getElementById('account-username');
        if (usernameInput) usernameInput.value = page.appState.user?.username || username;
        const currentUsername = document.getElementById('account-current-username');
        if (currentUsername) currentUsername.textContent = page.appState.user?.username || username || '-';
        setAccountFormMessage('账号已保存', 'success');
    } catch (error) {
        setAccountFormMessage(error.message, 'error');
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

function openAccountModal() {
    resetAccountForm();
    openModal('account-modal');
}

function activateSettingsPanel(panelId, shouldFocus = false) {
    const modal = document.getElementById('manage-modal');
    if (!modal) return;

    const tabs = Array.from(modal.querySelectorAll('.settings-tab'));
    const panels = Array.from(modal.querySelectorAll('.settings-panel'));
    const activeTab = tabs.find(tab => tab.dataset.settingsPanel === panelId) || tabs[0];
    if (!activeTab) return;

    tabs.forEach(tab => {
        const isActive = tab === activeTab;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
        tab.tabIndex = isActive ? 0 : -1;
    });

    panels.forEach(panel => {
        panel.hidden = panel.id !== activeTab.dataset.settingsPanel;
    });

    const modalBody = modal.querySelector('.modal-body');
    if (modalBody) modalBody.scrollTop = 0;
    if (shouldFocus) activeTab.focus();
}

function openManageModal() {
    openModal('manage-modal');
    renderLayoutButtons();
    renderSearchEngineList();
}

function openLinkModal(editIndex, linkType = 'website') {
    const form = document.getElementById('link-form');
    const modalTitle = document.getElementById('link-modal-title');
    const submitBtn = document.getElementById('link-form-submit');
    const urlInput = document.getElementById('link-url');
    const urlLabel = document.getElementById('link-url-label');
    const hint = document.getElementById('link-form-hint');
    const links = page.getLinkCollection(linkType);
    const editingLink = typeof editIndex === 'number' && links[editIndex] ? links[editIndex] : null;
    openModal('link-modal');
    form.reset();
    form.dataset.linkType = linkType;

    if (linkType === 'email') {
        urlInput.type = 'url';
        urlLabel.textContent = '邮箱登录地址';
        urlInput.placeholder = 'https://mail.google.com/';
        hint.textContent = '邮箱入口使用默认图标。';
    } else if (linkType === 'project') {
        urlInput.type = 'url';
        urlLabel.textContent = '项目地址';
        urlInput.placeholder = 'https://example.com';
        hint.textContent = '个人项目图标默认由服务器获取。';
    } else {
        urlInput.type = 'url';
        urlLabel.textContent = '链接地址';
        urlInput.placeholder = 'https://example.com';
        hint.textContent = '默认由服务器获取网页图标。';
    }

    if (editingLink) {
        document.getElementById('link-title').value = editingLink.title || '';
        document.getElementById('link-url').value = editingLink.url || '';
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
    document.body.classList.toggle(
        'has-modal-open',
        Boolean(document.querySelector('.modal-overlay.modal-open'))
    );
}

function closeActiveModal() {
    const activeModals = Array.from(document.querySelectorAll('.modal-overlay.modal-open'));
    const activeModal = activeModals.at(-1);
    if (!activeModal) return false;

    if (activeModal.id === 'link-modal') {
        closeLinkModal();
    } else if (activeModal.id === 'confirm-modal') {
        const overlay = activeModal;
        const cancelBtn = document.getElementById('confirm-cancel');
        const okBtn = document.getElementById('confirm-ok');

        if (typeof currentConfirmResolver === 'function') {
            currentConfirmResolver(false);
            currentConfirmResolver = null;
        }

        closeModal('confirm-modal');
    } else {
        closeModal(activeModal.id);
    }

    return true;
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.setAttribute('aria-hidden', 'false');
    modal.classList.add('modal-open');
    document.body.classList.add('has-modal-open');
}

function showConfirm(message, title = '确认删除') {
    return new Promise((resolve) => {
        const overlay = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-title');
        const messageEl = document.getElementById('confirm-message');
        const cancelBtn = document.getElementById('confirm-cancel');
        const okBtn = document.getElementById('confirm-ok');

        if (!overlay || !titleEl || !messageEl || !cancelBtn || !okBtn) {
            // 兜底：如果 modal 没准备好，使用原生（理论上不应发生）
            resolve(window.confirm(message));
            return;
        }

        titleEl.textContent = title;
        messageEl.textContent = message;
        currentConfirmResolver = resolve;

        let finished = false;
        const finish = (result) => {
            if (finished) return;
            finished = true;
            currentConfirmResolver = null;
            cancelBtn.removeEventListener('click', onCancel);
            okBtn.removeEventListener('click', onOk);
            overlay.removeEventListener('click', onBackdrop);
            closeModal('confirm-modal');
            resolve(result);
        };

        const onCancel = () => finish(false);
        const onOk = () => finish(true);
        const onBackdrop = (e) => {
            if (e.target === overlay) {
                finish(false);
            }
        };

        cancelBtn.addEventListener('click', onCancel, { once: true });
        okBtn.addEventListener('click', onOk, { once: true });
        overlay.addEventListener('click', onBackdrop);

        openModal('confirm-modal');
        // 默认聚焦“取消”，防止误操作
        setTimeout(() => cancelBtn.focus(), 0);
    });
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

    if (!page.appState.searchEngineRecords.length) {
        list.innerHTML = '<div class="engine-list-empty">暂无搜索引擎</div>';
        return;
    }

    list.innerHTML = page.appState.searchEngineRecords.map((engine, index, records) => {
        const iconDescriptor = page.getSearchEngineIconDescriptor(engine);
        const isRequired = engine.engineKey === 'google';
        return `
            <div class="engine-list-item">
                ${iconDescriptor
                    ? `<img alt="" class="engine-list-icon" data-engine-icon-id="${page.escapeAttribute(String(engine.id))}" data-icon-entity="search-engines" data-icon-id="${page.escapeAttribute(String(engine.id))}">`
                    : '<span class="engine-list-icon" aria-hidden="true"></span>'
                }
                <div class="engine-list-info">
                    <div class="engine-list-name">${page.escapeHtml(engine.name)}</div>
                    <div class="engine-list-url">${page.escapeHtml(engine.urlTemplate)}</div>
                </div>
                <div class="engine-list-actions">
                    <button type="button" class="engine-list-move" data-id="${engine.id}" data-direction="up" title="上移" aria-label="上移" ${index === 0 ? 'disabled' : ''}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m18 15-6-6-6 6"/></svg>
                    </button>
                    <button type="button" class="engine-list-move" data-id="${engine.id}" data-direction="down" title="下移" aria-label="下移" ${index >= records.length - 1 ? 'disabled' : ''}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
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

    list.querySelectorAll('.engine-list-icon[data-engine-icon-id]').forEach(img => {
        const engine = page.appState.searchEngineRecords.find(item => String(item.id) === img.dataset.engineIconId);
        const iconDescriptor = page.getSearchEngineIconDescriptor(engine);
        if (iconDescriptor) page.hydrateIconElement(img, iconDescriptor);
    });
}

async function moveSearchEngine(engineId, direction) {
    const currentIndex = page.appState.searchEngineRecords.findIndex(engine => String(engine.id) === String(engineId));
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= page.appState.searchEngineRecords.length) return;

    const previousEngines = [...page.appState.searchEngineRecords];
    const nextEngines = [...page.appState.searchEngineRecords];
    [nextEngines[currentIndex], nextEngines[targetIndex]] = [nextEngines[targetIndex], nextEngines[currentIndex]];
    page.appState.searchEngineRecords = nextEngines;
    page.rebuildSearchEngines();
    page.renderSearchEngineButtons();
    renderSearchEngineList();

    try {
        const data = await page.apiRequest('/api/search-engines/reorder', {
            method: 'PUT',
            body: { ids: nextEngines.map(engine => engine.id) }
        });
        page.applySearchEnginesResponse(data.engines || nextEngines);
    } catch (error) {
        page.appState.searchEngineRecords = previousEngines;
        page.rebuildSearchEngines();
        page.renderSearchEngineButtons();
        renderSearchEngineList();
        alert(error.message);
    }
}

async function toggleEditMode() {
    const previous = page.editMode;
    page.editMode = !page.editMode;
    page.appState.settings.editMode = page.editMode;
    page.updateEditModeUI();

    try {
        await page.saveSettingsPatch({ editMode: page.editMode });
    } catch (error) {
        page.editMode = previous;
        page.appState.settings.editMode = previous;
        page.updateEditModeUI();
        alert(error.message);
    }
}

async function deleteLink(index, linkType = 'website') {
    const links = page.getLinkCollection(linkType);
    if (index < 0 || index >= links.length) return;

    const title = links[index].title || '该链接';
    const confirmed = await showConfirm(`确定要删除链接「${title}」吗？`);
    if (!confirmed) return;

    try {
        const data = await page.apiRequest(`/api/links/${links[index].id}`, { method: 'DELETE' });
        page.applyLinksResponse(data);
    } catch (error) {
        alert(error.message);
    }
}

function editLink(index, linkType = 'website') {
    openLinkModal(index, linkType);
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

    page.updateDisplayModeButtonState();
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

    page.updateLinkSizeButtonState();
}

function renderBookmarkGlassToggle() {
    const container = document.getElementById('bookmark-glass-toggle');
    if (!container) return;
    container.innerHTML = `
        <button type="button" class="layout-btn glass-btn" data-enabled="true">开启</button>
        <button type="button" class="layout-btn glass-btn" data-enabled="false">关闭</button>
    `;
    page.updateGlassToggleState();
}

function renderLayoutButtons() {
    renderLayoutButtonGroup('project-layout-buttons', 'project-layout-options-hint', 'project');
    renderLayoutButtonGroup('layout-buttons', 'layout-options-hint', 'website');
    page.updateLayoutButtonState();
    renderDisplayModeButtons();
    renderLinkSizeButtons();
    renderBookmarkGlassToggle();
}

function renderLayoutButtonGroup(containerId, hintId, linkType = 'website') {
    const layoutButtons = document.getElementById(containerId);
    const hint = document.getElementById(hintId);
    if (!layoutButtons) return;

    const savedColumns = page.getLayoutColumnsForLinkType(linkType);
    const maxColumns = page.getMaxAvailableLayoutColumns(linkType);
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

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForIconRefreshCompletion(initialStatus) {
    let status = initialStatus || null;

    while (!status || status.state === 'running') {
        await wait(1000);
        status = await page.apiRequest('/api/icons/refresh/status');
    }

    if (status.state === 'failed') {
        throw new Error('刷新图标缓存失败');
    }

    return status;
}

async function refreshIconCache() {
    const refreshBtn = document.getElementById('icon-refresh-btn');
    const refreshBtnLabel = refreshBtn?.querySelector('.icon-refresh-label');
    const previousText = refreshBtnLabel?.textContent || refreshBtn?.textContent || '刷新图标';
    if (refreshBtn) {
        refreshBtn.disabled = true;
        if (refreshBtnLabel) {
            refreshBtnLabel.textContent = '刷新中...';
        } else {
            refreshBtn.textContent = '刷新中...';
        }
    }

    try {
        iconCacheRefreshRunning = true;
        const data = await page.apiRequest('/api/icons/refresh', { method: 'POST' });
        page.applyLinksResponse(data);
        page.applySearchEnginesResponse(data.engines || []);
        const status = await waitForIconRefreshCompletion(data.refreshStatus);
        const [linksData, searchEnginesData] = await Promise.all([
            page.apiRequest('/api/links'),
            page.apiRequest('/api/search-engines')
        ]);
        page.applyLinksResponse(linksData);
        page.applySearchEnginesResponse(searchEnginesData.engines || []);
        if (status.failed > 0) {
            console.warn(`Icon refresh completed with ${status.failed} failed task(s)`);
        }
    } catch (error) {
        alert(error.message);
    } finally {
        iconCacheRefreshRunning = false;
        if (refreshBtn) {
            refreshBtn.disabled = false;
            if (refreshBtnLabel) {
                refreshBtnLabel.textContent = previousText;
            } else {
                refreshBtn.textContent = previousText;
            }
        }
    }
}

function bindMenuManagement() {
    const manageBtn = document.querySelector('.manage-menu-btn');
    const editModeBtn = document.getElementById('edit-mode-btn');
    const form = document.getElementById('link-form');
    const accountForm = document.getElementById('account-form');
    const emailLinksContainer = document.getElementById('email-links-container');
    const projectLinksContainer = document.getElementById('project-links-container');
    const navLinksContainer = document.getElementById('nav-links-container');
    const searchEngineForm = document.getElementById('search-engine-form');
    const searchEngineList = document.getElementById('search-engine-list');
    const layoutButtons = document.getElementById('layout-buttons');
    const layoutSettingsSection = document.querySelector('.layout-settings-section');
    const settingsTabs = document.querySelector('.settings-tabs');
    const iconRefreshBtn = document.getElementById('icon-refresh-btn');
    const cancelBtn = document.getElementById('link-form-cancel');
    const searchEngineCancelBtn = document.getElementById('search-engine-form-cancel');

    manageBtn.addEventListener('click', () => openManageModal());

    settingsTabs?.addEventListener('click', event => {
        const tab = event.target.closest('.settings-tab');
        if (!tab) return;
        activateSettingsPanel(tab.dataset.settingsPanel);
    });

    settingsTabs?.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = Array.from(settingsTabs.querySelectorAll('.settings-tab'));
        const currentIndex = tabs.indexOf(event.target.closest('.settings-tab'));
        if (currentIndex < 0) return;

        event.preventDefault();
        let nextIndex = currentIndex;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
        activateSettingsPanel(tabs[nextIndex].dataset.settingsPanel, true);
    });
    if (editModeBtn) editModeBtn.addEventListener('click', toggleEditMode);
    if (iconRefreshBtn) iconRefreshBtn.addEventListener('click', refreshIconCache);
    cancelBtn.addEventListener('click', closeLinkModal);
    if (searchEngineCancelBtn) searchEngineCancelBtn.addEventListener('click', resetSearchEngineForm);
    if (accountForm) accountForm.addEventListener('submit', submitAccountForm);
    bindLinkDragContainer(emailLinksContainer, 'email');
    bindLinkDragContainer(projectLinksContainer, 'project');
    bindLinkDragContainer(navLinksContainer, 'website');

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
            } else if (emailLink && page.editMode) {
                event.preventDefault();
                if (!isDragging) {
                    editLink(parseInt(emailLink.dataset.index, 10), 'email');
                }
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
            } else if (navCard && page.editMode && !isDragging) {
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

        const links = page.getLinkCollection(linkType);
        const editingLink = editIndex !== null && links[editIndex] ? links[editIndex] : null;
        submitBtn.disabled = true;

        try {
            const data = await page.apiRequest(editingLink ? `/api/links/${editingLink.id}` : '/api/links', {
                method: editingLink ? 'PUT' : 'POST',
                body: { title, url, type: linkType }
            });
            page.applyLinksResponse(data);
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
                page.setLinkSize(linkSizeBtn.dataset.linkType || 'website', linkSizeBtn.dataset.size || 'medium');
                return;
            }

            const displayModeBtn = event.target.closest('.display-mode-btn');
            if (displayModeBtn) {
                page.setDisplayMode(displayModeBtn.dataset.linkType || 'website', displayModeBtn.dataset.mode || 'default');
                return;
            }

            const layoutBtn = event.target.closest('.layout-btn[data-columns]');
            if (layoutBtn) {
                const columns = parseInt(layoutBtn.dataset.columns, 10);
                page.setLinkLayoutColumns(layoutBtn.dataset.linkType || 'website', columns);
                return;
            }

            const glassBtn = event.target.closest('.glass-btn');
            if (glassBtn) {
                const enabled = glassBtn.dataset.enabled === 'true';
                page.setBookmarkGlass(enabled);
                return;
            }
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
            const data = await page.apiRequest(editId ? `/api/search-engines/${editId}` : '/api/search-engines', {
                method: editId ? 'PUT' : 'POST',
                body: { name, urlTemplate }
            });
            page.applySearchEnginesResponse(data.engines || []);
            resetSearchEngineForm();
        } catch (error) {
            alert(error.message);
        } finally {
            submitBtn.disabled = false;
        }
    });

    searchEngineList.addEventListener('click', async (event) => {
        const moveBtn = event.target.closest('.engine-list-move');
        const editBtn = event.target.closest('.engine-list-edit');
        const deleteBtn = event.target.closest('.engine-list-delete');
        if (!moveBtn && !editBtn && !deleteBtn) return;

        const actionBtn = moveBtn || editBtn || deleteBtn;
        const engine = page.appState.searchEngineRecords.find(item => String(item.id) === actionBtn.dataset.id);
        if (!engine) return;

        if (moveBtn) {
            if (!moveBtn.disabled) {
                await moveSearchEngine(engine.id, moveBtn.dataset.direction);
            }
            return;
        }

        if (editBtn) {
            editSearchEngine(engine);
            return;
        }

        const confirmed = await showConfirm(`确定要删除搜索引擎「${engine.name}」吗？`);
        if (!confirmed) return;

        deleteBtn.disabled = true;

        try {
            const data = await page.apiRequest(`/api/search-engines/${engine.id}`, { method: 'DELETE' });
            const deletedEngineKey = page.getEngineKey(engine);
            const nextEngines = data.engines || [];
            if (page.currentEngine === deletedEngineKey) {
                page.currentEngine = nextEngines.some(item => item.engineKey === 'google')
                    ? 'google'
                    : page.getEngineKey(nextEngines[0] || page.getFallbackSearchEngineRecords()[0]);
            }
            page.applySearchEnginesResponse(nextEngines);
            resetSearchEngineForm();
        } catch (error) {
            alert(error.message);
        } finally {
            deleteBtn.disabled = false;
        }
    });

    navLinksContainer?.addEventListener('click', (event) => {
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
        } else if (navCard && page.editMode && !isDragging) {
            event.preventDefault();
            event.stopPropagation();
            editLink(parseInt(navCard.dataset.index, 10));
        }
    });

    document.querySelectorAll('.modal-close[data-close]').forEach(btn => {
        btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
    });

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
        const saved = page.appState.settings.backgroundUrl || '';
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
                const data = await page.apiRequest('/api/background', {
                    method: 'POST',
                    body: formData
                });
                page.applySettings(data.settings);
            } else if (urlValue) {
                if (!page.isValidBackgroundUrl(urlValue)) {
                    alert('请输入有效的图片 URL 或服务器图片路径');
                    return;
                }
                await page.saveSettingsPatch({ backgroundUrl: urlValue });
            } else {
                await page.saveSettingsPatch({ backgroundUrl: '' });
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
            await page.saveSettingsPatch({ backgroundUrl: '' });
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

function bindLayoutResize() {
    window.addEventListener('resize', () => {
        clearTimeout(layoutResizeTimer);
        layoutResizeTimer = setTimeout(() => {
            renderLayoutButtons();
        }, 120);
    });
}

import { LINK_SIZE_OPTIONS } from './state.js';
import { page, showNotice } from './main.js';

let draggedCard = null;
let draggedLinkType = 'website';
let isDragging = false;
let draggedWrapper = null;
let draggedPreviousLinks = null;
let dragReorderFrame = null;
let dragPointerX = 0;
let dragPointerY = 0;
let dragTargetType = null;
let dragListSnapshots = null;
let selectedBackgroundFile = null;
let previewObjectUrl = null;
let iconCacheRefreshRunning = false;
let layoutResizeTimer = null;
let linkMovePending = false;
let searchEngineMovePending = false;
let reorderAnnounceTimer = null;

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
    bindDialogLightDismiss();
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
    const wrappers = getSortableWrappers(linkType);
    wrappers.forEach((wrapper, index) => {
        wrapper.dataset.index = index;
        wrapper.querySelectorAll('[data-index]').forEach(element => {
            element.dataset.index = index;
        });
        wrapper.dataset.linkType = linkType;
        wrapper.querySelectorAll('.link-move').forEach(button => {
            const direction = button.dataset.direction === 'up' ? 'up' : 'down';
            const move = page.describeLinkMove(linkType, direction, index, wrappers.length);
            button.disabled = move.disabled;
            button.title = move.title;
            button.dataset.linkType = linkType;
            button.dataset.index = index;
            const label = button.dataset.label || '';
            button.setAttribute('aria-label', label ? `${move.action} ${label}` : move.action);
        });
    });
}

function moveElementBefore(parent, node, reference) {
    if (typeof parent.moveBefore === 'function') {
        parent.moveBefore(node, reference);
        return;
    }
    if (reference) reference.before(node);
    else parent.append(node);
}

function announceReorder(message) {
    const status = document.getElementById('reorder-status');
    if (!status) return;
    status.textContent = '';
    clearTimeout(reorderAnnounceTimer);
    reorderAnnounceTimer = setTimeout(() => {
        status.textContent = message;
    }, 500);
}

function focusMovedControl(wrapper, direction, selector) {
    if (!wrapper) return;
    const button = wrapper.querySelector(`${selector}[data-direction="${direction}"]`);
    const alternate = direction === 'up' ? 'down' : 'up';
    const target = button && !button.disabled
        ? button
        : wrapper.querySelector(`${selector}[data-direction="${alternate}"]`) || button;
    wrapper.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    target?.focus({ preventScroll: true });
}

function sectionLabel(linkType) {
    return linkType === 'project' ? '个人项目' : '个人书签';
}

function crossListTarget(linkType, direction) {
    if (linkType === 'project' && direction === 'down') {
        return { type: 'website', index: 0 };
    }
    if (linkType === 'website' && direction === 'up') {
        return { type: 'project', index: page.getLinkCollection('project').length };
    }
    return null;
}

function assignWrapperLinkType(wrapper, linkType) {
    wrapper.dataset.linkType = linkType;
    wrapper.querySelectorAll('[data-link-type]').forEach((element) => {
        element.dataset.linkType = linkType;
    });
}

function domLinkIds(linkType) {
    const ids = [];
    for (const wrapper of getSortableWrappers(linkType)) {
        const id = Number.parseInt(wrapper.dataset.id, 10);
        if (!Number.isInteger(id) || ids.includes(id)) return null;
        ids.push(id);
    }
    return ids;
}

function sameLinkIds(links, ids) {
    return Array.isArray(links)
        && Array.isArray(ids)
        && links.length === ids.length
        && links.every((link, index) => link.id === ids[index]);
}

function linkTypeOfContainer(container) {
    if (!container) return null;
    if (container.id === 'project-links-container') return 'project';
    if (container.id === 'nav-links-container') return 'website';
    if (container.id === 'email-links-container') return 'email';
    return null;
}

function canDropOnLinkList(targetType) {
    if (!draggedWrapper) return false;
    if (targetType === draggedLinkType) return true;
    const movable = draggedLinkType === 'project' || draggedLinkType === 'website';
    return movable && (targetType === 'project' || targetType === 'website');
}

async function moveLink(linkType, index, direction) {
    if (linkMovePending) return;
    const links = page.getLinkCollection(linkType);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= links.length) {
        await transferLink(linkType, index, direction);
        return;
    }

    const container = page.getLinkContainer(linkType);
    const wrappers = getSortableWrappers(linkType);
    const moving = wrappers[index];
    const target = wrappers[targetIndex];
    if (!container || !moving || !target) return;

    linkMovePending = true;
    const previousLinks = [...links];
    const nextLinks = [...links];
    [nextLinks[index], nextLinks[targetIndex]] = [nextLinks[targetIndex], nextLinks[index]];
    const reference = direction === 'up' ? target : target.nextElementSibling;
    moveElementBefore(container, moving, reference);
    page.setLinkCollection(linkType, nextLinks);
    updateSortableIndices(linkType);
    focusMovedControl(moving, direction, '.link-move');
    const label = nextLinks[targetIndex]?.title || '链接';
    announceReorder(`已将「${label}」移到第 ${targetIndex + 1} 位，共 ${nextLinks.length} 项`);

    try {
        await persistLinkOrder(linkType, nextLinks, previousLinks, {
            renderOnSuccess: false,
            onRollback: () => {
                focusMovedControl(getSortableWrappers(linkType)[index], direction, '.link-move');
            }
        });
    } finally {
        linkMovePending = false;
    }
}

function handleLinkMoveClick(event) {
    const moveBtn = event.target.closest('.link-move');
    if (!moveBtn || moveBtn.disabled) return false;
    event.preventDefault();
    event.stopPropagation();
    moveLink(moveBtn.dataset.linkType || 'website', parseInt(moveBtn.dataset.index, 10), moveBtn.dataset.direction);
    return true;
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
        options.onRollback?.();
        showNotice(error.message);
        return false;
    }
}

async function persistLinkTransfer(sourceType, targetType, movedId, targetIndex, previousSource, previousTarget, options = {}) {
    try {
        const data = await page.apiRequest('/api/links/transfer', {
            method: 'PUT',
            body: { id: movedId, type: targetType, index: targetIndex }
        });

        if (!setLinksStateFromResponse(data)) {
            throw new Error('移动结果无效');
        }

        const sourceMatches = sameLinkIds(page.getLinkCollection(sourceType), domLinkIds(sourceType));
        const targetMatches = sameLinkIds(page.getLinkCollection(targetType), domLinkIds(targetType));
        if (!sourceMatches || !targetMatches) {
            page.renderLinkCollection(sourceType);
            page.renderLinkCollection(targetType);
            if (options.direction) {
                const wrapper = getSortableWrappers(targetType).find((item) => Number(item.dataset.id) === movedId);
                focusMovedControl(wrapper, options.direction, '.link-move');
            }
        }
        return true;
    } catch (error) {
        page.setLinkCollection(sourceType, previousSource);
        page.setLinkCollection(targetType, previousTarget);
        page.renderLinkCollection(sourceType);
        page.renderLinkCollection(targetType);
        options.onRollback?.();
        showNotice(error.message);
        return false;
    }
}

async function transferLink(linkType, index, direction) {
    const destination = crossListTarget(linkType, direction);
    if (!destination || linkMovePending) return;

    const sourceLinks = page.getLinkCollection(linkType);
    const targetLinks = page.getLinkCollection(destination.type);
    const movingLink = sourceLinks[index];
    const sourceContainer = page.getLinkContainer(linkType);
    const targetContainer = page.getLinkContainer(destination.type);
    const moving = getSortableWrappers(linkType)[index];
    if (!movingLink || !sourceContainer || !targetContainer || !moving) return;

    linkMovePending = true;
    const previousSource = sourceLinks.slice();
    const previousTarget = targetLinks.slice();
    const nextSource = sourceLinks.filter((_, itemIndex) => itemIndex !== index);
    const nextTarget = targetLinks.slice();
    nextTarget.splice(destination.index, 0, { ...movingLink, linkType: destination.type });

    assignWrapperLinkType(moving, destination.type);
    const reference = destination.index === 0
        ? (getSortableWrappers(destination.type)[0] || getDragAppendReference(destination.type))
        : getDragAppendReference(destination.type);
    moveElementBefore(targetContainer, moving, reference);
    page.setLinkCollection(linkType, nextSource);
    page.setLinkCollection(destination.type, nextTarget);
    updateSortableIndices(linkType);
    updateSortableIndices(destination.type);
    focusMovedControl(moving, direction, '.link-move');
    const label = movingLink.title || '链接';
    announceReorder(`已将「${label}」移到${sectionLabel(destination.type)}，第 ${destination.index + 1} 位，共 ${nextTarget.length} 项`);

    try {
        await persistLinkTransfer(
            linkType,
            destination.type,
            movingLink.id,
            destination.index,
            previousSource,
            previousTarget,
            {
                direction,
                onRollback: () => {
                    focusMovedControl(getSortableWrappers(linkType)[index], direction, '.link-move');
                }
            }
        );
    } finally {
        linkMovePending = false;
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
    const linkType = dragTargetType || draggedLinkType;
    const container = page.getLinkContainer(linkType);
    if (!container || !canDropOnLinkList(linkType)) return;

    const previousType = linkTypeOfContainer(draggedWrapper.parentElement);
    if (previousType !== linkType) assignWrapperLinkType(draggedWrapper, linkType);

    const reference = getDragInsertionReference(linkType, dragPointerX, dragPointerY);
    if (reference === draggedWrapper) return;
    if (reference && reference.previousElementSibling === draggedWrapper) return;

    moveElementBefore(container, draggedWrapper, reference || getDragAppendReference(linkType));
    updateSortableIndices(linkType);
    if (previousType && previousType !== linkType) updateSortableIndices(previousType);
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
    dragTargetType = draggedLinkType;
    dragListSnapshots = draggedLinkType === 'project' || draggedLinkType === 'website'
        ? {
            project: [...page.getLinkCollection('project')],
            website: [...page.getLinkCollection('website')]
        }
        : null;
    isDragging = true;
    document.body.classList.add('link-dragging');
    draggedCard?.classList.add('dragging');
    draggedWrapper?.classList.add('dragging');
    page.getLinkContainer(draggedLinkType)?.classList.add('drag-sorting');
    if (dragListSnapshots) {
        page.getLinkContainer('project')?.classList.add('drag-sorting');
        page.getLinkContainer('website')?.classList.add('drag-sorting');
    }

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

function collectionFromIds(ids, pools) {
    const linksById = new Map();
    pools.forEach((link) => linksById.set(link.id, link));
    const next = [];
    for (const id of ids) {
        const link = linksById.get(id);
        if (!link) return null;
        next.push(link);
    }
    return next;
}

function restoreLinkSnapshots(snapshots) {
    if (!snapshots) return;
    page.setLinkCollection('project', snapshots.project);
    page.setLinkCollection('website', snapshots.website);
    page.renderLinkCollection('project');
    page.renderLinkCollection('website');
}

async function commitDraggedTransfer(originType, destType, movedId, snapshots) {
    const originIds = domLinkIds(originType);
    const destIds = domLinkIds(destType);
    const targetIndex = destIds ? destIds.indexOf(movedId) : -1;
    const pool = [...snapshots.project, ...snapshots.website];
    if (!originIds || !destIds || targetIndex < 0 || originIds.includes(movedId)) {
        restoreLinkSnapshots(snapshots);
        return false;
    }

    const nextOrigin = collectionFromIds(originIds, pool);
    const nextDest = collectionFromIds(destIds, pool)?.map((link, index) => (
        index === targetIndex ? { ...link, linkType: destType } : link
    ));
    if (!nextOrigin || !nextDest) {
        restoreLinkSnapshots(snapshots);
        return false;
    }

    page.setLinkCollection(originType, nextOrigin);
    page.setLinkCollection(destType, nextDest);
    updateSortableIndices(originType);
    updateSortableIndices(destType);
    const label = nextDest[targetIndex]?.title || '链接';
    announceReorder(`已将「${label}」移到${sectionLabel(destType)}，第 ${targetIndex + 1} 位，共 ${nextDest.length} 项`);
    return persistLinkTransfer(
        originType,
        destType,
        movedId,
        targetIndex,
        snapshots[originType],
        snapshots[destType]
    );
}

async function handleDragEnd() {
    const linkType = draggedLinkType;
    const previousLinks = draggedPreviousLinks;
    const snapshots = dragListSnapshots;
    const wrapper = draggedWrapper;
    const movedId = Number.parseInt(wrapper?.dataset.id || '', 10);

    clearDragUi();
    const destType = linkTypeOfContainer(wrapper?.parentElement);
    draggedCard = null;
    draggedLinkType = 'website';
    draggedWrapper = null;
    draggedPreviousLinks = null;
    dragListSnapshots = null;
    dragTargetType = null;
    setTimeout(() => { isDragging = false; }, 100);

    if (destType && destType !== linkType && Number.isInteger(movedId) && snapshots) {
        await commitDraggedTransfer(linkType, destType, movedId, snapshots);
        return;
    }

    await commitDraggedOrder(linkType, previousLinks);
}

function handleLinkContainerDragOver(event, linkType) {
    if (!canDropOnLinkList(linkType)) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    dragTargetType = linkType;
    scheduleDraggedWrapperReorder(event);
}

function handleLinkContainerDrop(event, linkType) {
    if (!canDropOnLinkList(linkType)) return;

    event.preventDefault();
    dragTargetType = linkType;
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

    openModal('link-modal');
}

function closeLinkModal() {
    closeModal('link-modal');
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal?.open) return;
    modal.close();
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal || typeof modal.showModal !== 'function' || modal.open) return;
    modal.showModal();
}

function bindDialogLightDismiss() {
    if ('closedBy' in HTMLDialogElement.prototype) return;

    document.querySelectorAll('dialog[closedby="any"]').forEach((dialog) => {
        let pressedOutside = false;
        const outside = (event) => {
            const rect = dialog.getBoundingClientRect();
            return event.clientX < rect.left || event.clientX > rect.right
                || event.clientY < rect.top || event.clientY > rect.bottom;
        };
        dialog.addEventListener('pointerdown', (event) => {
            pressedOutside = outside(event);
        });
        dialog.addEventListener('pointerup', (event) => {
            if (pressedOutside && outside(event) && dialog.open) dialog.close();
        });
    });
}

function showConfirm(message, title = '确认删除') {
    return new Promise((resolve) => {
        const dialog = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-title');
        const messageEl = document.getElementById('confirm-message');

        if (!dialog || typeof dialog.showModal !== 'function' || !titleEl || !messageEl || dialog.open) {
            resolve(window.confirm(message));
            return;
        }

        titleEl.textContent = title;
        messageEl.textContent = message;
        dialog.returnValue = '';
        dialog.addEventListener('close', () => {
            const confirmed = dialog.returnValue === 'confirm';
            dialog.returnValue = '';
            resolve(confirmed);
        }, { once: true });
        dialog.showModal();
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
            <div class="engine-list-item" data-id="${page.escapeAttribute(String(engine.id))}">
                ${iconDescriptor
                    ? `<img alt="" class="engine-list-icon" data-engine-icon-id="${page.escapeAttribute(String(engine.id))}" data-icon-entity="search-engines" data-icon-id="${page.escapeAttribute(String(engine.id))}">`
                    : '<span class="engine-list-icon" aria-hidden="true"></span>'
                }
                <div class="engine-list-info">
                    <div class="engine-list-name">${page.escapeHtml(engine.name)}</div>
                    <div class="engine-list-url">${page.escapeHtml(engine.urlTemplate)}</div>
                </div>
                <div class="engine-list-actions">
                    <button type="button" class="engine-list-move" data-id="${engine.id}" data-direction="up" title="上移" aria-label="上移 ${page.escapeAttribute(engine.name)}" ${index === 0 ? 'disabled' : ''}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>
                    </button>
                    <button type="button" class="engine-list-move" data-id="${engine.id}" data-direction="down" title="下移" aria-label="下移 ${page.escapeAttribute(engine.name)}" ${index >= records.length - 1 ? 'disabled' : ''}>
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

function searchEngineListMatches(engines) {
    if (!Array.isArray(engines)) return false;
    const ids = [...document.querySelectorAll('#search-engine-list > .engine-list-item')].map(item => item.dataset.id || '');
    return engines.length === ids.length && engines.every((engine, index) => String(engine.id) === ids[index]);
}

function syncSearchEngineMoveButtons() {
    const items = [...document.querySelectorAll('#search-engine-list > .engine-list-item')];
    items.forEach((item, index) => {
        const up = item.querySelector('.engine-list-move[data-direction="up"]');
        const down = item.querySelector('.engine-list-move[data-direction="down"]');
        if (up) up.disabled = index === 0;
        if (down) down.disabled = index === items.length - 1;
    });
}

function focusSearchEngineMoveButton(engineId, direction) {
    const button = document.querySelector(
        `#search-engine-list .engine-list-move[data-id="${CSS.escape(String(engineId))}"][data-direction="${direction}"]`
    );
    focusMovedControl(button?.closest('.engine-list-item'), direction, '.engine-list-move');
}

function reorderSearchEngineDom(currentIndex, targetIndex) {
    const list = document.getElementById('search-engine-list');
    if (!list) return false;
    const items = [...list.querySelectorAll(':scope > .engine-list-item')];
    const moving = items[currentIndex];
    const target = items[targetIndex];
    if (!moving || !target) return false;
    const reference = targetIndex < currentIndex ? target : target.nextElementSibling;
    moveElementBefore(list, moving, reference);
    return true;
}

async function moveSearchEngine(engineId, direction) {
    if (searchEngineMovePending) return;
    const records = page.appState.searchEngineRecords;
    const currentIndex = records.findIndex(engine => String(engine.id) === String(engineId));
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= records.length) return;

    searchEngineMovePending = true;
    const previousEngines = [...records];
    const nextEngines = [...records];
    [nextEngines[currentIndex], nextEngines[targetIndex]] = [nextEngines[targetIndex], nextEngines[currentIndex]];
    if (!reorderSearchEngineDom(currentIndex, targetIndex)) renderSearchEngineList();
    page.appState.searchEngineRecords = nextEngines;
    page.rebuildSearchEngines();
    page.renderSearchEngineButtons();
    syncSearchEngineMoveButtons();
    focusSearchEngineMoveButton(engineId, direction);
    const label = nextEngines[targetIndex]?.name || '搜索引擎';
    announceReorder(`已将「${label}」移到第 ${targetIndex + 1} 位，共 ${nextEngines.length} 个`);

    try {
        const data = await page.apiRequest('/api/search-engines/reorder', {
            method: 'PUT',
            body: { ids: nextEngines.map(engine => engine.id) }
        });
        const engines = data.engines || nextEngines;
        page.appState.searchEngineRecords = engines;
        page.rebuildSearchEngines();
        page.renderSearchEngineButtons();
        if (!searchEngineListMatches(engines)) {
            renderSearchEngineList();
            focusSearchEngineMoveButton(engineId, direction);
        } else {
            syncSearchEngineMoveButtons();
        }
    } catch (error) {
        page.appState.searchEngineRecords = previousEngines;
        page.rebuildSearchEngines();
        page.renderSearchEngineButtons();
        renderSearchEngineList();
        focusSearchEngineMoveButton(engineId, direction);
        showNotice(error.message);
    } finally {
        searchEngineMovePending = false;
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
        showNotice(error.message);
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
        showNotice(error.message);
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
            <label class="layout-btn">
                <input type="radio" class="layout-choice display-mode-btn" name="${group.linkType}-display-mode" value="${button.mode}" data-link-type="${group.linkType}">
                <span>${button.label}</span>
            </label>
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
            <label class="layout-btn">
                <input type="radio" class="layout-choice link-size-btn" name="${group.linkType}-link-size" value="${option.size}" data-link-type="${group.linkType}">
                <span>${option.label}</span>
            </label>
        `).join('');
    });

    page.updateLinkSizeButtonState();
}

function renderBookmarkGlassToggle() {
    const container = document.getElementById('bookmark-glass-toggle');
    if (!container) return;
    container.innerHTML = `
        <label class="layout-btn">
            <input type="radio" class="layout-choice glass-btn" name="bookmark-glass" value="true">
            <span>开启</span>
        </label>
        <label class="layout-btn">
            <input type="radio" class="layout-choice glass-btn" name="bookmark-glass" value="false">
            <span>关闭</span>
        </label>
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
        showNotice(error.message);
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
            if (handleLinkMoveClick(event)) return;
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
            if (handleLinkMoveClick(event)) return;
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
            showNotice(linkType === 'email'
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
            showNotice(error.message);
        } finally {
            submitBtn.disabled = false;
        }
    });

    if (layoutSettingsSection) {
        layoutSettingsSection.addEventListener('change', (event) => {
            const input = event.target;
            if (!(input instanceof HTMLInputElement)) return;

            if (input.classList.contains('link-size-btn')) {
                page.setLinkSize(input.dataset.linkType || 'website', input.value || 'medium');
                return;
            }

            if (input.classList.contains('display-mode-btn')) {
                page.setDisplayMode(input.dataset.linkType || 'website', input.value || 'default');
                return;
            }

            if (input.classList.contains('glass-btn')) {
                page.setBookmarkGlass(input.value === 'true');
            }
        });

        layoutSettingsSection.addEventListener('click', (event) => {
            const layoutBtn = event.target.closest('button.layout-btn[data-columns]');
            if (!layoutBtn) return;
            const columns = parseInt(layoutBtn.dataset.columns, 10);
            page.setLinkLayoutColumns(layoutBtn.dataset.linkType || 'website', columns);
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
            showNotice(error.message);
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
            showNotice(error.message);
        } finally {
            deleteBtn.disabled = false;
        }
    });

    navLinksContainer?.addEventListener('click', (event) => {
        if (handleLinkMoveClick(event)) return;
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

    document.getElementById('link-modal')?.addEventListener('close', () => {
        const linkForm = document.getElementById('link-form');
        linkForm?.reset();
        if (linkForm) {
            delete linkForm.dataset.editIndex;
            delete linkForm.dataset.linkType;
        }
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
            showNotice('图片文件不能超过 10MB');
            fileInput.value = '';
            return;
        }

        if (!allowedTypes.includes(file.type)) {
            showNotice('请选择 JPG、PNG、WebP 或 GIF 图片');
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
                    showNotice('请输入有效的图片 URL 或服务器图片路径');
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
            showNotice(error.message);
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
            showNotice(error.message);
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

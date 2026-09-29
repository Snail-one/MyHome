const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { getPublicIconFileUrl } = require('./iconService');
const { isBackgroundUrl } = require('./validation');

const MAIL_ICON = `<svg class="email-link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3 7 9 6 9-6"></path></svg>`;
const DELETE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2v2"/></svg>`;
const FALLBACK_FAVICON = `<svg class="nav-favicon-fallback" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>`;
const ADD_ICON = `<span class="nav-add-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></span>`;

let layoutModulePromise = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;'
  }[char]));
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function escapeCssUrl(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, '');
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function fillTemplate(template, tokens) {
  let html = template;
  for (const [token, value] of Object.entries(tokens)) {
    html = html.replaceAll(token, () => value);
  }
  return html;
}

function getEffectiveUrl(link) {
  const url = link?.url && String(link.url).trim();
  try {
    if (!url) return '#';
    if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) return '#';
    const parsedUrl = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return '#';
    return parsedUrl.href;
  } catch {
    return '#';
  }
}

function getInitialBackgroundStyle(backgroundUrl) {
  if (!backgroundUrl || !isBackgroundUrl(backgroundUrl)) return '';

  const safeUrl = backgroundUrl.startsWith('/') ? backgroundUrl : new URL(backgroundUrl).href;
  const cssUrl = escapeHtmlAttribute(escapeCssUrl(safeUrl));
  return [
    `background-image: url(&quot;${cssUrl}&quot;)`,
    'background-size: cover',
    'background-position: center',
    'background-repeat: no-repeat',
    'background-attachment: fixed'
  ].join('; ');
}

function loadLayoutModule(publicDir) {
  if (!layoutModulePromise) {
    const href = pathToFileURL(path.join(publicDir, 'js/state.js')).href;
    layoutModulePromise = import(href);
  }
  return layoutModulePromise;
}

function normalizeLinkSize(size) {
  return ['small', 'medium', 'large', 'xlarge'].includes(size) ? size : 'medium';
}

function getEngineKey(engine) {
  return engine.engineKey || `custom-${engine.id}`;
}

function decorateStoredIcon(entity, entityType) {
  const version = Number.parseInt(entity?.iconVersion, 10) || 1;
  const iconMode = entity?.iconMode || (entityType === 'search-engines' ? 'server' : 'server');
  if (iconMode === 'none' || entity?.iconStatus === 'none') {
    return { ...entity, iconMode: 'none', iconStatus: 'none', iconFileUrl: '' };
  }
  if (entity?.iconStatus === 'ready' && entity.iconFileName) {
    return {
      ...entity,
      iconStatus: 'ready',
      iconFileUrl: getPublicIconFileUrl(entity.iconFileName, version)
    };
  }
  if (entity?.iconStatus === 'miss') {
    return { ...entity, iconStatus: 'miss', iconFileUrl: '' };
  }
  return {
    ...entity,
    iconStatus: entity?.iconStatus || 'empty',
    iconFileUrl: ''
  };
}

function isUnresolvedIcon(entity) {
  if (!entity || entity.iconMode === 'none') return false;
  const status = entity.iconStatus || 'empty';
  return status !== 'ready' && status !== 'miss' && status !== 'none';
}

function iconMarkup(entity, entityType, options = {}) {
  const iconMode = entity.iconMode || 'server';
  if (iconMode === 'none' || entity.iconStatus === 'none') return '';

  const ready = entity.iconStatus === 'ready' && entity.iconFileUrl;
  const loading = options.eager ? 'eager' : 'lazy';
  const priority = options.priority && ready ? ' fetchpriority="high"' : '';
  const src = ready ? ` src="${escapeHtmlAttribute(entity.iconFileUrl)}"` : '';
  const hidden = ready ? '' : ' style="display:none"';
  const className = options.className || 'nav-favicon';
  return `<img alt="" class="${className}" loading="${loading}" decoding="async"${priority}${hidden}${src} data-icon-entity="${escapeHtmlAttribute(entityType)}" data-icon-id="${escapeHtmlAttribute(entity.id)}">`;
}

function renderSearchEngineButton(engine, currentKey) {
  const key = getEngineKey(engine);
  const active = key === currentKey ? ' active' : '';
  const icon = Number.isInteger(Number.parseInt(engine.id, 10))
    ? iconMarkup(engine, 'search-engines', { eager: true, className: 'engine-favicon' })
    : '';
  return `<button type="button" class="engine-btn${active}" data-engine="${escapeHtmlAttribute(key)}">${icon || '<span class="engine-favicon" aria-hidden="true"></span>'}<span>${escapeHtml(engine.name)}</span></button>`;
}

function renderEmailLink(link, index, requiredKeys, editMode) {
  const required = requiredKeys.has(link.linkKey);
  const title = link.title || '邮箱登录';
  return `<div class="email-link-wrapper" data-index="${index}" data-link-type="email" data-id="${escapeHtmlAttribute(link.id)}"><a href="${escapeHtmlAttribute(getEffectiveUrl(link))}" target="_blank" rel="noopener noreferrer" class="email-link" data-index="${index}" data-link-type="email" draggable="${editMode ? 'true' : 'false'}" title="${escapeHtmlAttribute(title)}">${MAIL_ICON}<span class="email-link-label">${escapeHtml(title)}</span></a><div class="email-link-actions">${required ? '' : `<button type="button" class="email-link-delete" data-index="${index}" title="删除邮箱链接">${DELETE_ICON}</button>`}</div></div>`;
}

function renderAddEmailLink() {
  return `<button type="button" class="email-link email-add-link" title="添加邮箱登录" aria-label="添加邮箱登录">${ADD_ICON}<span class="email-add-label">添加邮箱</span></button>`;
}

function renderNavCard(link, index, linkType, editMode, eagerCount, prioritySlot) {
  const href = getEffectiveUrl(link);
  const iconMode = link.iconMode || 'server';
  const eager = index < eagerCount;
  const icon = iconMode === 'none'
    ? ''
    : `${iconMarkup(link, 'links', {
      eager,
      priority: eager && prioritySlot.used === false && link.iconStatus === 'ready' && link.iconFileUrl
        ? (prioritySlot.used = true)
        : false
    })}${FALLBACK_FAVICON.replace('class="nav-favicon-fallback"', `class="nav-favicon-fallback" style="display:${link.iconStatus === 'ready' && link.iconFileUrl ? 'none' : 'block'}"`)}`;
  return `<div class="nav-card-wrapper" data-index="${index}" data-link-type="${escapeHtmlAttribute(linkType)}" data-id="${escapeHtmlAttribute(link.id)}"><a href="${escapeHtmlAttribute(href)}" target="_blank" rel="noopener noreferrer" class="nav-card" data-index="${index}" data-link-type="${escapeHtmlAttribute(linkType)}" draggable="${editMode ? 'true' : 'false'}"><div class="nav-icon${iconMode === 'none' ? ' nav-icon-empty' : ''}">${icon}</div><div class="nav-info"><div class="nav-title">${escapeHtml(link.title || '未命名')}</div></div></a><div class="nav-card-actions"><button type="button" class="nav-card-delete" data-index="${index}" title="删除">${DELETE_ICON}</button></div></div>`;
}

function renderAddLinkCard(linkType) {
  const isProject = linkType === 'project';
  const label = isProject ? '添加个人项目' : '添加网址';
  return `<div class="nav-card-wrapper nav-add-wrapper" data-link-type="${linkType}"><button type="button" class="nav-card nav-add-card" data-link-type="${linkType}" title="${label}" aria-label="${label}">${ADD_ICON}</button></div>`;
}

function containerPresentation(settings, linkType, layoutConfig) {
  const columns = Number.parseInt(linkType === 'project' ? settings.projectLayoutColumns : settings.layoutColumns, 10) || 0;
  const mode = linkType === 'project' ? settings.projectLinkDisplayMode : settings.bookmarkLinkDisplayMode;
  const size = normalizeLinkSize(linkType === 'project' ? settings.projectLinkSize : settings.bookmarkLinkSize);
  const classes = ['navigation-links'];
  if (linkType === 'project') classes.push('project-links');
  if (mode !== 'default') classes.push('layout-centered');
  if (columns > 0) classes.push('layout-fixed');
  if (settings.bookmarkGlass === false) classes.push('glass-off');

  const config = layoutConfig[size];
  const style = [
    `--link-card-width: ${config.cardWidth}`,
    `--link-card-min-height: ${config.minHeight}`,
    `--link-add-card-min-height: ${config.addCardMinHeight}`,
    `--link-card-icon-size: ${config.iconSize}`,
    `--link-card-title-size: ${config.titleSize}`,
    `--link-card-gap: ${config.cardGap}`,
    `--link-card-padding: ${config.cardPadding}`,
    `--link-card-grid-gap: ${config.gridGap}`,
    `--link-add-icon-size: ${config.addIconSize}`,
    `--link-add-icon-svg-size: ${config.addIconSvgSize}`
  ];
  if (columns > 0) style.push(`--layout-cols: ${columns}`);

  return {
    className: classes.join(' '),
    style: style.join('; '),
    columns
  };
}

function firstRowCount(columns) {
  return columns > 0 ? columns : 6;
}

function createHtmlRenderer(config, deps) {
  const settingsStore = deps.settings;
  const linksStore = deps.links;
  const searchEnginesStore = deps.searchEngines;
  const usersStore = deps.users;
  const assetManifest = deps.assetManifest;
  const iconService = deps.iconService;
  const requiredLinkKeys = deps.requiredLinkKeys || config.requiredLinkKeys || new Set();
  const indexPath = path.join(config.publicDir, 'index.html');
  const loginPath = path.join(config.publicDir, 'login.html');

  function assetUrl(relativePath) {
    return assetManifest ? assetManifest.url(relativePath) : `/${relativePath}`;
  }

  async function renderLogin() {
    const html = await fs.promises.readFile(loginPath, 'utf8');
    return fillTemplate(html, {
      __ASSET_FAVICON__: escapeHtmlAttribute(assetUrl('favicon.svg')),
      __ASSET_STYLE__: escapeHtmlAttribute(assetUrl('style.css')),
      __ASSET_LOGIN_JS__: escapeHtmlAttribute(assetUrl('login.js'))
    });
  }

  async function renderIndex() {
    const [{ LINK_SIZE_CONFIG }, template] = await Promise.all([
      loadLayoutModule(config.publicDir),
      fs.promises.readFile(indexPath, 'utf8')
    ]);
    const settings = settingsStore.get();
    const linkResponse = linksStore.getResponse();
    const links = (linkResponse.links || []).map((link) => decorateStoredIcon(link, 'links'));
    const emailLinks = (linkResponse.emailLinks || []).map((link) => decorateStoredIcon(link, 'links'));
    const projectLinks = (linkResponse.projectLinks || []).map((link) => decorateStoredIcon(link, 'links'));
    const engines = (searchEnginesStore.get() || []).map((engine) => decorateStoredIcon(engine, 'search-engines'));
    const userRow = usersStore.getMe();
    const user = userRow?.username ? { username: userRow.username } : null;
    const editMode = Boolean(settings.editMode);
    const currentEngine = engines.some((engine) => getEngineKey(engine) === 'google')
      ? 'google'
      : (engines[0] ? getEngineKey(engines[0]) : 'google');
    const currentRecord = engines.find((engine) => getEngineKey(engine) === currentEngine) || engines[0];
    const currentName = currentRecord?.name || 'Google';
    const projectPresentation = containerPresentation(settings, 'project', LINK_SIZE_CONFIG);
    const websitePresentation = containerPresentation(settings, 'website', LINK_SIZE_CONFIG);
    const prioritySlot = { used: false };
    const projectEager = firstRowCount(projectPresentation.columns);
    const websiteEager = firstRowCount(websitePresentation.columns);
    const backgroundStyle = getInitialBackgroundStyle(settings.backgroundUrl);
    const bodyClass = editMode ? 'logged-in edit-mode-active' : 'logged-in';

    if (deps.prefetchIcons !== false && iconService) {
      iconService.prefetchLinksResponse?.({ links, emailLinks, projectLinks });
      iconService.prefetchSearchEngines?.(engines);
    }

    const bootstrap = {
      user,
      links,
      emailLinks,
      projectLinks,
      engines,
      settings,
      currentEngine
    };

    return fillTemplate(template, {
      __ASSET_FAVICON__: escapeHtmlAttribute(assetUrl('favicon.svg')),
      __ASSET_STYLE__: escapeHtmlAttribute(assetUrl('style.css')),
      __ASSET_MAIN__: escapeHtmlAttribute(assetUrl('js/main.js')),
      __ASSET_ADMIN__: escapeHtmlAttribute(assetUrl('js/admin.js')),
      __BODY_CLASS__: bodyClass,
      __BODY_EXTRA__: backgroundStyle ? ` style="${backgroundStyle}"` : '',
      __EMAIL_HIDDEN__: emailLinks.length || editMode ? '' : ' hidden',
      __EMAIL_LINKS__: `${emailLinks.map((link, index) => renderEmailLink(link, index, requiredLinkKeys, editMode)).join('')}${editMode ? renderAddEmailLink() : ''}`,
      __EDIT_TITLE__: editMode ? '完成编辑' : '进入编辑模式',
      __EDIT_PRESSED__: editMode ? 'true' : 'false',
      __EDIT_ACTIVE__: editMode ? ' active' : '',
      __EDIT_LABEL__: editMode ? '完成' : '编辑',
      __USERNAME__: escapeHtml(user?.username || '-'),
      __SEARCH_ENGINES__: engines.map((engine) => renderSearchEngineButton(engine, currentEngine)).join(''),
      __SEARCH_PLACEHOLDER__: escapeHtmlAttribute(`搜索 ${currentName}...`),
      __CURRENT_ENGINE__: escapeHtml(currentName),
      __PROJECT_SECTION_HIDDEN__: projectLinks.length || editMode ? '' : ' hidden',
      __PROJECT_CONTAINER_ATTRS__: `class="${projectPresentation.className}" style="${escapeHtmlAttribute(projectPresentation.style)}"`,
      __PROJECT_LINKS__: `${projectLinks.map((link, index) => renderNavCard(link, index, 'project', editMode, projectEager, prioritySlot)).join('')}${editMode ? renderAddLinkCard('project') : ''}`,
      __PROJECT_EMPTY_STYLE__: projectLinks.length || editMode ? ' style="display:none"' : '',
      __WEBSITE_CONTAINER_ATTRS__: `class="${websitePresentation.className}" style="${escapeHtmlAttribute(websitePresentation.style)}"`,
      __WEBSITE_LINKS__: `${links.map((link, index) => renderNavCard(link, index, 'website', editMode, websiteEager, prioritySlot)).join('')}${editMode ? renderAddLinkCard('website') : ''}`,
      __WEBSITE_EMPTY_STYLE__: links.length || editMode ? ' style="display:none"' : '',
      __BOOTSTRAP_JSON__: safeJson(bootstrap)
    });
  }

  return {
    renderIndex,
    renderLogin
  };
}

module.exports = {
  createHtmlRenderer,
  decorateStoredIcon,
  escapeCssUrl,
  escapeHtml,
  escapeHtmlAttribute,
  getEffectiveUrl,
  getInitialBackgroundStyle,
  isUnresolvedIcon,
  safeJson
};

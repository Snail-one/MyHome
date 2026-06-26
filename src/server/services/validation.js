function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  return title.trim().slice(0, 80);
}

function normalizeUrl(url) {
  if (typeof url !== 'string') return '';
  return url.trim().slice(0, 1000);
}

function normalizeLinkType(type) {
  if (type === 'email' || type === 'project') return type;
  return 'website';
}

function getDefaultIconMode() {
  return 'server';
}

function normalizeIconMode(iconMode) {
  if (iconMode === undefined || iconMode === null || iconMode === '') {
    return getDefaultIconMode();
  }

  if (iconMode === 'server' || iconMode === 'none') return iconMode;
  return getDefaultIconMode();
}

function normalizeDisplayMode(mode, fallback = 'default') {
  if (mode === 'default' || mode === 'centered') return mode;
  return fallback;
}

function normalizeLinkSize(size, fallback = 'medium') {
  if (['small', 'medium', 'large', 'xlarge'].includes(size)) return size;
  return fallback;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isBackgroundUrl(value) {
  if (value === '') return true;
  if (value.startsWith('/uploads/backgrounds/')) return !value.includes('..');
  return isHttpUrl(value);
}

function validateLinkPayload(body) {
  const title = normalizeTitle(body?.title);
  const linkType = normalizeLinkType(body?.type || body?.linkType);
  const url = normalizeUrl(body?.url);
  const iconMode = normalizeIconMode(body?.iconMode);

  if (!title) {
    return { error: '请填写显示名称' };
  }

  if (!url || !isHttpUrl(url)) {
    return {
      error: linkType === 'email'
        ? '邮箱登录地址必须是 http 或 https URL'
        : '链接地址必须是 http 或 https URL'
    };
  }

  return { value: { title, url, linkType, iconMode } };
}

function normalizeSearchEngineName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().slice(0, 40);
}

function normalizeSearchUrlTemplate(urlTemplate) {
  if (typeof urlTemplate !== 'string') return '';
  return urlTemplate.trim().slice(0, 1000);
}

function isValidSearchUrlTemplate(urlTemplate) {
  if (!urlTemplate) return false;
  try {
    const sampleUrl = urlTemplate.replaceAll('{query}', 'test');
    const parsedUrl = new URL(sampleUrl);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateSearchEnginePayload(body) {
  const name = normalizeSearchEngineName(body?.name);
  const urlTemplate = normalizeSearchUrlTemplate(body?.urlTemplate);

  if (!name) {
    return { error: '请填写搜索引擎名称' };
  }

  if (!isValidSearchUrlTemplate(urlTemplate)) {
    return { error: '搜索地址必须是 http 或 https URL' };
  }

  return { value: { name, urlTemplate } };
}

function validateLayoutColumns(value, label) {
  const columns = Number.parseInt(value, 10);
  if (!Number.isInteger(columns) || columns < 0 || columns > 6) {
    return { error: `${label}必须在 0 到 6 之间` };
  }
  return { value: columns };
}

module.exports = {
  isBackgroundUrl,
  isHttpUrl,
  isValidSearchUrlTemplate,
  getDefaultIconMode,
  normalizeIconMode,
  normalizeDisplayMode,
  normalizeLinkSize,
  normalizeLinkType,
  normalizeSearchEngineName,
  normalizeSearchUrlTemplate,
  normalizeTitle,
  normalizeUrl,
  validateLayoutColumns,
  validateLinkPayload,
  validateSearchEnginePayload
};

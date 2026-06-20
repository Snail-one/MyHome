const fs = require('fs');
const path = require('path');

const { isBackgroundUrl } = require('./validation');

function escapeHtmlAttribute(value) {
  return String(value).replace(/[&"<>]/g, (char) => ({
    '&': '&amp;',
    '"': '&quot;',
    '<': '&lt;',
    '>': '&gt;'
  }[char]));
}

function escapeCssUrl(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, '');
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

function createHtmlRenderer(config, settingsStore) {
  const indexPath = path.join(config.publicDir, 'index.html');
  let templatePromise = null;

  function readTemplate() {
    if (!templatePromise || config.nodeEnv !== 'production') {
      templatePromise = fs.promises.readFile(indexPath, 'utf8');
    }
    return templatePromise;
  }

  return {
    async renderIndex() {
      const html = await readTemplate();
      const settings = settingsStore.get();
      const backgroundStyle = getInitialBackgroundStyle(settings.backgroundUrl);
      if (!backgroundStyle) return html;

      return html.replace(
        '<body class="app-loading">',
        `<body class="app-loading" style="${backgroundStyle}">`
      );
    }
  };
}

module.exports = {
  createHtmlRenderer,
  escapeCssUrl,
  escapeHtmlAttribute,
  getInitialBackgroundStyle
};

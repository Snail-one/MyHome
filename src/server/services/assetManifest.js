const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IMPORT_PATTERN = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.[^'"]+)\2/g;
const STATIC_FILES = ['style.css', 'login.js', 'favicon.svg'];

function listJsFiles(directory, prefix = '') {
  if (!fs.existsSync(directory)) return [];

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsFiles(fullPath, relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(relativePath);
    }
  }
  return files;
}

function resolveSpec(fromRelativePath, specifier) {
  const base = path.posix.dirname(fromRelativePath);
  return path.posix.normalize(path.posix.join(base, specifier.split('?')[0]));
}

function stampFiles(publicDir, relativePaths) {
  return relativePaths.map((relativePath) => {
    const fullPath = path.join(publicDir, relativePath);
    try {
      const stat = fs.statSync(fullPath);
      return `${relativePath}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${relativePath}:missing`;
    }
  }).join('|');
}

function buildAssetManifest(publicDir) {
  const jsFiles = listJsFiles(path.join(publicDir, 'js')).map((relativePath) => `js/${relativePath}`);
  const relativePaths = [...STATIC_FILES, ...jsFiles];
  const raw = new Map();

  relativePaths.forEach((relativePath) => {
    const fullPath = path.join(publicDir, relativePath);
    if (!fs.existsSync(fullPath)) return;
    raw.set(relativePath, fs.readFileSync(fullPath));
  });

  const hash = new Map();
  const body = new Map();
  const visiting = new Set();

  function hashJavaScript(relativePath) {
    if (hash.has(relativePath)) return hash.get(relativePath);
    if (visiting.has(relativePath)) {
      const fallback = crypto.createHash('sha256').update(raw.get(relativePath)).digest('hex').slice(0, 12);
      hash.set(relativePath, fallback);
      body.set(relativePath, raw.get(relativePath).toString('utf8'));
      return fallback;
    }

    visiting.add(relativePath);
    const source = raw.get(relativePath).toString('utf8');
    const rewritten = source.replace(IMPORT_PATTERN, (match, prefix, quote, specifier) => {
      const target = resolveSpec(relativePath, specifier);
      if (!raw.has(target)) return match;
      const targetHash = hashJavaScript(target);
      const cleanSpecifier = specifier.split('?')[0];
      return `${prefix}${quote}${cleanSpecifier}?v=${targetHash}${quote}`;
    });
    visiting.delete(relativePath);

    const digest = crypto.createHash('sha256').update(rewritten).digest('hex').slice(0, 12);
    hash.set(relativePath, digest);
    body.set(relativePath, rewritten);
    return digest;
  }

  jsFiles.forEach((relativePath) => {
    if (raw.has(relativePath)) hashJavaScript(relativePath);
  });

  STATIC_FILES.forEach((relativePath) => {
    if (!raw.has(relativePath)) return;
    const digest = crypto.createHash('sha256').update(raw.get(relativePath)).digest('hex').slice(0, 12);
    hash.set(relativePath, digest);
    body.set(relativePath, raw.get(relativePath));
  });

  return {
    url(relativePath) {
      const digest = hash.get(relativePath);
      return digest ? `/${relativePath}?v=${digest}` : `/${relativePath}`;
    },
    hashOf(relativePath) {
      return hash.get(relativePath) || '';
    },
    bodyOf(relativePath) {
      return body.get(relativePath);
    },
    has(relativePath) {
      return hash.has(relativePath);
    }
  };
}

function createAssetManifest(publicDir) {
  let cached = null;
  let stamp = '';

  function current() {
    const jsFiles = listJsFiles(path.join(publicDir, 'js')).map((relativePath) => `js/${relativePath}`);
    const nextStamp = stampFiles(publicDir, [...STATIC_FILES, ...jsFiles]);
    if (!cached || nextStamp !== stamp) {
      cached = buildAssetManifest(publicDir);
      stamp = nextStamp;
    }
    return cached;
  }

  return {
    url(relativePath) {
      return current().url(relativePath);
    },
    hashOf(relativePath) {
      return current().hashOf(relativePath);
    },
    bodyOf(relativePath) {
      return current().bodyOf(relativePath);
    },
    has(relativePath) {
      return current().has(relativePath);
    }
  };
}

module.exports = {
  createAssetManifest
};

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAssetManifest } = require('../../src/server/services/assetManifest');

function writePublicDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-home-assets-'));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'style.css'), 'body{color:#111}\n');
  fs.writeFileSync(path.join(dir, 'login.js'), 'console.log("login")\n');
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  fs.writeFileSync(path.join(dir, 'js', 'state.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(dir, 'js', 'main.js'), "import { value } from './state.js';\nconsole.log(value);\n");
  return dir;
}

test('production asset manifest serves cached files without rescanning', async (t) => {
  const dir = writePublicDir();
  const manifest = createAssetManifest(dir, { production: true });
  t.after(() => manifest.close());

  const hash = manifest.hashOf('style.css');
  assert.match(hash, /^[a-f0-9]{12}$/);
  assert.match(manifest.bodyOf('js/main.js').toString(), /state\.js\?v=[a-f0-9]{12}/);

  const statSync = fs.statSync;
  const readdirSync = fs.readdirSync;
  let statCalls = 0;
  let readCalls = 0;
  fs.statSync = (...args) => {
    statCalls += 1;
    return statSync.apply(fs, args);
  };
  fs.readdirSync = (...args) => {
    readCalls += 1;
    return readdirSync.apply(fs, args);
  };

  try {
    assert.equal(manifest.hashOf('style.css'), hash);
    assert.equal(manifest.has('style.css'), true);
    manifest.url('js/main.js');
    manifest.bodyOf('style.css');
    assert.equal(statCalls, 0);
    assert.equal(readCalls, 0);
  } finally {
    fs.statSync = statSync;
    fs.readdirSync = readdirSync;
  }
});

test('production asset manifest rebuilds after a public file changes', async (t) => {
  const dir = writePublicDir();
  const manifest = createAssetManifest(dir, { production: true });
  t.after(() => manifest.close());

  const before = manifest.hashOf('style.css');
  fs.appendFileSync(path.join(dir, 'style.css'), '\nbody{margin:0}\n');

  const deadline = Date.now() + 1000;
  let after = before;
  while (after === before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    after = manifest.hashOf('style.css');
  }

  assert.notEqual(after, before);
  assert.match(manifest.bodyOf('style.css').toString(), /margin:0/);
});

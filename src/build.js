// Builds the editor from source (this src/ folder) into the repo root:
//   ../editor.js    engine + symbols + editor (CSS inside), loaded on demand
//   ../loader.js    the small loader added to the 2all product-page template
// and, for local testing, dist/snippet.html and mock/product.html.
//
//   node build.js
// Override the served location or version with env vars, e.g.
//   DH_BASE=https://danharita.github.io/harita-editor/ DH_VER=20260101 node build.js
const fs = require('fs');
const path = require('path');
const R = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const ROOT = path.join(__dirname, '..');

const VER = process.env.DH_VER || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const BASE = process.env.DH_BASE || 'https://danharita.github.io/harita-editor/';

const css = R('editor.css').replace(/\s*\n\s*/g, ' ').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const app = R('editor-app.js').replace("'/*__CSS__*/'", () => `'${css}'`).replace("'/*__VER__*/'", `'${VER}'`);
const editor = `/* Dan Harita design editor ${VER} */\n` + R('engine.js') + '\n' + R('symbols.js') + '\n' + app;
fs.writeFileSync(path.join(ROOT, 'editor.js'), editor);

const loaderFor = base => R('loader.js').replace('__BASE__', base).replace('__VER__', VER);
fs.writeFileSync(path.join(ROOT, 'loader.js'), loaderFor(BASE));

// helpers for local testing
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist/snippet.html'), `<script src="${BASE}loader.js" async></script>\n`);
const mock = R('mock/template.html').replace('/*__LOADER__*/', () => loaderFor('/'));
fs.writeFileSync(path.join(__dirname, 'mock/product.html'), mock);

console.log('version', VER, '| editor.js', (editor.length / 1024).toFixed(0) + ' KB', '| loader.js', (loaderFor(BASE).length / 1024).toFixed(1) + ' KB', '| base', BASE);

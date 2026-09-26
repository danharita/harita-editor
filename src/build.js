// Builds the embed:
//   dist/editor.js    engine + symbols + editor (CSS inside), loaded on demand
//   dist/loader.js    the small loader for "תוכן שמאל לדף מוצר"
//   dist/snippet.html the loader wrapped in <script> for pasting into 2all
//   mock/product.html a copy of the product page structure for local tests
const fs = require('fs');
const path = require('path');
const R = p => fs.readFileSync(path.join(__dirname, p), 'utf8');

const VER = process.env.DH_VER || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const BASE = process.env.DH_BASE || 'https://danharita.github.io/custom-fonts/editor/';

const css = R('editor.css').replace(/\s*\n\s*/g, ' ').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const app = R('editor-app.js').replace("'/*__CSS__*/'", () => `'${css}'`).replace("'/*__VER__*/'", `'${VER}'`);
const editor = `/* Dan Harita design editor ${VER} */\n` + R('../engine.js') + '\n' + R('../symbols.js') + '\n' + app;
fs.writeFileSync(path.join(__dirname, 'dist/editor.js'), editor);

const loaderFor = base => R('loader.js').replace('__BASE__', base).replace('__VER__', VER);
fs.writeFileSync(path.join(__dirname, 'dist/loader.js'), loaderFor(BASE));
fs.writeFileSync(path.join(__dirname, 'dist/snippet.html'), `<script src="${BASE}loader.js" async></script>\n`);

// mock page: same structure as the live page, loader pointing at /embed/dist/
const mock = R('mock/template.html').replace('/*__LOADER__*/', () => loaderFor('/embed/dist/'));
fs.writeFileSync(path.join(__dirname, 'mock/product.html'), mock);

console.log('version', VER, '| editor.js', (editor.length / 1024).toFixed(0) + ' KB', '| loader.js', (loaderFor(BASE).length / 1024).toFixed(1) + ' KB');

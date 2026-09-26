/*
 * DHEditor — the customer design editor, embedded in a 2all product page.
 * Loaded on demand by loader.js when the customer taps "רוצה לעצב לבד".
 * Bundled after engine.js and symbols.js (see build.js).
 */
(function () {
  'use strict';
  if (window.DHEditor) return;

  const EE = window.EngraveEngine;
  const SYMBOLS = window.DEMO_SYMBOLS;
  const CSS_TEXT = '/*__CSS__*/';
  const VERSION = '/*__VER__*/';

  // ------------------------------------------------------------------ config

  const CDN = 'https://cdn.jsdelivr.net/npm/';
  const LIBS = [
    { has: () => window.fabric, src: CDN + 'fabric@5.3.0/dist/fabric.min.js', sri: 'sha384-8E2vEX6CrzCvnhTD2fZ1qYM8/814HwUQP5F3fGZ7HQhjPdrBpUFY2F8ixbfIg8Xr' },
    { has: () => window.opentype, src: CDN + 'opentype.js@1.3.4/dist/opentype.min.js', sri: 'sha384-3TaxGqyHrMuRIWY5Z5WHNIzgNRqGIUJE+mk6tm+g1wkm9Ux2kUyOLfy9AsNWXA6u' },
    { has: () => window.bidi_js, src: CDN + 'bidi-js@1.0.3/dist/bidi.min.js', sri: 'sha384-wQtTdqzwTFhzi4xIX4wrLGvJHshKoK61RCcjZ4lwr/sZBggODJHSpl5bHBcUfeV2' },
    { has: () => window.ClipperLib, src: CDN + 'clipper-lib@6.4.2/clipper.js', sri: 'sha384-oV9/r5hoq7qHFHfbghYwt50E2fe8J20vXRW0eIGQl20k40zMEAhSXMCh9ANASVB9' },
  ];
  const JSZIP = { has: () => window.JSZip, src: CDN + 'jszip@3.10.1/dist/jszip.min.js', sri: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG' };

  // The same font files the current preview uses. `label` is the exact text
  // of the matching option in "סוג כתב".
  const FONT_BASE = 'https://danharita.github.io/custom-fonts/';
  const FONTS = [
    { id: 'david', label: 'דפוס דוד', file: 'DAVID.TTF' },
    { id: 'stam', label: 'גוטמן סתם', file: 'STAM.TTF' },
    { id: 'ktavyad', label: 'כתב יד', file: 'KTAVYADCLM-BOLDITALIC.OTF' },
    { id: 'anka', label: 'כתב יד אנקה', file: 'ANKACLM-BOLD.OTF' },
    { id: 'gyad', label: 'גוטמן ברש', file: 'GYADBR.TTF' },
    { id: 'en1', label: 'English 1', file: 'Times New Roman Bold.ttf' },
    { id: 'en2', label: 'English 2', file: 'Lucida Calligraphy Font.ttf' },
    { id: 'en3', label: 'English 3', file: 'Goldie Boxing.ttf' },
    { id: 'en4', label: 'English 4 (כתב מחובר)', file: 'Madina.ttf' },
    { id: 'en5', label: 'English 5 Segoe', file: 'segoepr.ttf' },
  ];
  const DEFAULT_FONT = 'david';

  // Symbol id -> exact option name in "סמלים לבחירה".
  const SYMBOL_OPTION = { heart: 'לב', crown: 'כתר' };

  // One entry per engraving surface, keyed by the gallery image name
  // engrave-bg-<key>. `extends` copies another entry and overrides fields.
  const SURFACE_DEFS = {
    'butcher-shita-38x30': {
      slot: 'board', label: 'קרש', fileLabel: 'board',
      area: { xPct: 50 / 380 * 100, yPct: 50 / 300 * 100, wPct: 280 / 380 * 100, hPct: 200 / 300 * 100, shape: 'rect' },
      areaMm: { w: 280, h: 200 },
      engrave: { color: '#3a2211', opacity: 0.82, blend: 'multiply' },
      minLetterMm: 3, defaultTextMm: 16,
      limits: { textBoxes: 4, symbols: 3, linesPerBox: 3, charsPerLine: 30 },
      textFields: ['טקסט לחריטה קרש, שורה 1', 'טקסט לחריטה קרש, שורה 2', 'טקסט לחריטה קרש, שורה 3', 'טקסט לחריטה קרש'],
      danWrap: 'danWrap_2', placeholder: 'board',
    },
    'santoku-18': {
      slot: 'knife', label: 'סכין', fileLabel: 'knife',
      area: { xPct: 34 / 190 * 100, yPct: 28 / 80 * 100, wPct: 110 / 190 * 100, hPct: 24 / 80 * 100, shape: 'rect' },
      areaMm: { w: 110, h: 24 },
      engrave: { color: '#161616', opacity: 0.8, blend: 'multiply' },
      minLetterMm: 2, defaultTextMm: 8,
      limits: { textBoxes: 2, symbols: 2, linesPerBox: 2, charsPerLine: 24 },
      textFields: ['טקסט לחריטה סכין, שורה 1', 'טקסט לחריטה סכין, שורה 2', 'טקסט לחריטה סכין, שורה 3', 'טקסט לחריטה סכין'],
      danWrap: 'danWrap_1', placeholder: 'knife',
    },
    // test image on product 2851248: the board settings on an 80% centred area
    'test': {
      extends: 'butcher-shita-38x30',
      area: { xPct: 10, yPct: 10, wPct: 80, hPct: 80, shape: 'rect' },
      engrave: { color: '#141414', opacity: 0.85, blend: 'multiply' },
    },
  };
  const DESIGN_FIELD_NAMES = ['קישור לעיצוב'];
  const FONT_ROW = 'סוג כתב';
  const SYMBOL_ROW = 'סמלים לבחירה';

  const FORBIDDEN_RE = /[֑-ׇ]|[\u{1F000}-\u{1FAFF}]|[☀-➿]|[️‍]/gu;
  const COARSE = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const MIN_TOUCH = COARSE ? 52 : 26;

  let uidN = 0;
  const uid = () => 'o' + Date.now().toString(36) + (uidN++).toString(36);
  const fmt = v => (Math.round(v * 10) / 10).toLocaleString('he-IL', { maximumFractionDigits: 1 });
  const round2 = v => Math.round(v * 100) / 100;
  const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cssEsc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');

  function resolveDef(key) {
    const d = SURFACE_DEFS[key];
    if (!d) return null;
    if (!d.extends) return Object.assign({}, d);
    return Object.assign({}, resolveDef(d.extends), d, { extends: undefined });
  }

  // ----------------------------------------------------------------- loading

  function loadScript(lib) {
    if (lib.has()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = lib.src;
      if (lib.sri) { s.integrity = lib.sri; s.crossOrigin = 'anonymous'; }
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('load failed: ' + lib.src));
      document.head.appendChild(s);
    });
  }

  let libsReady = null;
  function ensureLibs() {
    if (!libsReady) {
      libsReady = Promise.all(LIBS.map(loadScript)).then(() => {
        EE.init({ opentype: window.opentype, bidiFactory: window.bidi_js, ClipperLib: window.ClipperLib });
      });
      libsReady.catch(() => { libsReady = null; });
    }
    return libsReady;
  }

  const fontJobs = {};
  function ensureFont(id) {
    if (!fontJobs[id]) {
      const f = FONTS.find(x => x.id === id);
      fontJobs[id] = (async () => {
        const res = await fetch(FONT_BASE + f.file.split('/').map(encodeURIComponent).join('/'));
        if (!res.ok) throw new Error('font ' + f.file + ' ' + res.status);
        const buf = await res.arrayBuffer();
        EE.loadFont(id, buf.slice(0));
        try {
          const face = new FontFace('dh-' + id, buf.slice(0));
          await face.load();
          document.fonts.add(face);
        } catch (e) { /* the chip falls back to the page font */ }
        return id;
      })();
      fontJobs[id].catch(() => { delete fontJobs[id]; });
    }
    return fontJobs[id];
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('image ' + url));
      im.src = url;
    });
  }

  // ------------------------------------------------------------ page bridge
  // Everything that touches the 2all product page lives here.

  function makeBridge() {
    const form = document.querySelector('.cssFrmCatalog_ProductPage.clsSB_Product_Form') || document.getElementById('FrmCatalog') || document.body;
    const q = sel => form.querySelector(sel);
    const rowOf = el => (el ? el.closest('.clsCatalogElmExtraRow') : null);
    const textInput = name => q(`input.clsTextChooseProduct[property_name="${cssEsc(name)}"]`);
    const selectRow = name => rowOf(q(`select.clsSelectChooseProduct[property_name="${cssEsc(name)}"]`)) ||
      rowOf(q(`ul.clsUlChooseProduct[property_name="${cssEsc(name)}"]`));
    const fontRow = selectRow(FONT_ROW);
    const symRow = selectRow(SYMBOL_ROW);
    const productId = ((q('input[name="PicID"]') || {}).value || 'unknown').trim();
    const fire = el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const fontLis = () => (fontRow ? [...fontRow.querySelectorAll('li.clsLIChooseProduct')] : []);
    const symBoxes = () => (symRow ? [...symRow.querySelectorAll('input.elm_extra_product_checkList')] : []);
    const symLabel = cb => {
      const l = symRow.querySelector(`label[for="${cssEsc(cb.id)}"]`);
      return l ? l.textContent.replace(/\s+/g, ' ').trim() : '';
    };
    const maxProps = symRow ? parseInt(symRow.getAttribute('maxproperties'), 10) : 0;

    const hidden = [];
    function hide(el) {
      if (!el || hidden.some(h => h.el === el)) return;
      hidden.push({ el, display: el.style.display });
      el.style.display = 'none';
    }

    return {
      form, productId,
      symbolCap: maxProps > 0 ? maxProps : Infinity,
      hasField: name => !!textInput(name),
      fieldsPresent: names => names.filter(n => textInput(n)),
      isRequired: name => { const i = textInput(name); return !!(i && i.getAttribute('ismust') === '1'); },
      readFields: names => names.map(n => textInput(n)).filter(Boolean).map(i => i.value.trim()).filter(Boolean),

      // Lines go into the fields top to bottom; extra lines join the last
      // field; fields without a line are cleared.
      writeFields(names, lines) {
        const inputs = names.map(textInput).filter(Boolean);
        if (!inputs.length) return;
        const vals = inputs.map((_, i) => lines[i] || '');
        if (lines.length > inputs.length) vals[inputs.length - 1] = lines.slice(inputs.length - 1).join(' / ');
        inputs.forEach((inp, i) => {
          const max = parseInt(inp.getAttribute('maxlength'), 10) || 0;
          const v = max ? vals[i].slice(0, max) : vals[i];
          if (inp.value !== v) { inp.value = v; fire(inp); }
        });
      },

      selectedFontLabel() {
        const li = fontLis().find(x => x.classList.contains('clsSelected'));
        return li ? li.getAttribute('textselectedproperty') : null;
      },
      // Same as the customer tapping the font button.
      selectFont(label) {
        const li = fontLis().find(x => x.getAttribute('textselectedproperty') === label);
        if (li && !li.classList.contains('clsSelected')) li.click();
      },

      checkedSymbols: () => symBoxes().filter(cb => cb.checked).map(symLabel),
      // Same as the customer ticking the boxes. Unticks first so the row's
      // maximum is never exceeded on the way.
      setSymbols(labels) {
        const want = new Set(labels);
        const boxes = symBoxes();
        for (const cb of boxes) if (cb.checked && !want.has(symLabel(cb))) cb.click();
        for (const cb of boxes) if (!cb.checked && want.has(symLabel(cb))) cb.click();
      },

      hasDesignField: () => DESIGN_FIELD_NAMES.some(n => textInput(n)),
      setDesignField(text) {
        const inp = DESIGN_FIELD_NAMES.map(textInput).find(Boolean);
        if (!inp) return false;
        const max = parseInt(inp.getAttribute('maxlength'), 10) || 0;
        const v = max ? text.slice(0, max) : text;
        if (inp.value !== v) { inp.value = v; fire(inp); }
        return true;
      },

      // Hides the fields the editor replaces. The font and symbol rows are
      // hidden only when the editor covers every engraving surface on the page.
      enter(surfaces) {
        for (const s of surfaces) {
          for (const n of s.textFields) hide(rowOf(textInput(n)));
          if (s.danWrap) hide(document.getElementById(s.danWrap));
        }
        const handled = new Set(surfaces.map(s => s.slot));
        const uncovered = Object.keys(SURFACE_DEFS).map(resolveDef)
          .filter(d => !d.extends && !handled.has(d.slot) && d.textFields.some(n => textInput(n)));
        if (!uncovered.length) { hide(fontRow); hide(symRow); }
      },
      exit() {
        while (hidden.length) { const h = hidden.pop(); h.el.style.display = h.display; }
      },

      // Shows the editor's text in the existing preview boxes.
      updateDanWrap(id, lines) {
        const wrap = id && document.getElementById(id);
        const ed = wrap && wrap.querySelector('.dan-editable');
        if (!ed) return;
        ed.innerHTML = lines.map(l => '<div>' + escHtml(l) + '</div>').join('');
        const cnt = wrap.querySelector('[id^="danCount"]');
        if (cnt) cnt.textContent = String(lines.length ? [...lines[lines.length - 1]].length : 0);
      },

      guardCart(shouldBlock, onBlocked) {
        document.addEventListener('click', e => {
          const a = e.target && e.target.closest && e.target.closest('#BtnAddToBasket_Anchor, .CSS_BtnAddToBasket_Anchor');
          if (!a || !form.contains(a) || !shouldBlock()) return;
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          onBlocked();
        }, true);
      },
    };
  }

  // ---------------------------------------------------------- placeholders
  // Drawn stand-ins for a surface whose gallery image isn't uploaded yet
  // (test mode only).

  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function drawBoard() {
    const PX = 3, W = 380 * PX, H = 300 * PX;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#e7e3dc'; g.fillRect(0, 0, W, H);
    const bx = 3 * PX, by = 2 * PX, bw = W - 6 * PX, bh = H - 7 * PX, br = 16 * PX;
    g.save(); roundRect(g, bx, by, bw, bh, br); g.clip();
    const base = g.createLinearGradient(0, 0, W, H);
    base.addColorStop(0, '#bd8a57'); base.addColorStop(0.5, '#a9763f'); base.addColorStop(1, '#b37e49');
    g.fillStyle = base; g.fillRect(0, 0, W, H);
    const rand = rng(11);
    for (let i = 0; i < 220; i++) {
      const y0 = rand() * H, amp = 3 + rand() * 12, fq = 0.002 + rand() * 0.005, ph = rand() * 6.28;
      g.beginPath();
      for (let x = 0; x <= W; x += 12) { const y = y0 + Math.sin(x * fq + ph) * amp; if (x === 0) g.moveTo(x, y); else g.lineTo(x, y); }
      const dark = rand() < 0.62;
      g.strokeStyle = dark ? `rgba(92,52,20,${0.05 + rand() * 0.15})` : `rgba(236,196,146,${0.04 + rand() * 0.1})`;
      g.lineWidth = 1 + rand() * (dark ? 4 : 2); g.stroke();
    }
    g.restore();
    return c;
  }
  function drawKnife() {
    const PX = 6, W = 190 * PX, H = 80 * PX, m = v => v * PX;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#e4e1db'; g.fillRect(0, 0, W, H);
    const blade = () => { g.beginPath(); g.moveTo(m(152), m(14)); g.lineTo(m(48), m(14)); g.bezierCurveTo(m(26), m(15), m(12), m(40), m(7), m(64)); g.lineTo(m(152), m(67)); g.closePath(); };
    g.save(); blade(); g.clip();
    const st = g.createLinearGradient(0, m(14), 0, m(67));
    st.addColorStop(0, '#9aa1a8'); st.addColorStop(0.12, '#dfe3e6'); st.addColorStop(0.68, '#c8cdd2'); st.addColorStop(0.8, '#f0f2f4'); st.addColorStop(1, '#a7adb3');
    g.fillStyle = st; g.fillRect(0, 0, W, H); g.restore();
    roundRect(g, m(149), m(12), m(9), m(58), m(2)); g.fillStyle = '#9aa0a6'; g.fill();
    roundRect(g, m(157), m(17), m(40), m(47), m(8)); g.fillStyle = '#23170f'; g.fill();
    return c;
  }

  // ------------------------------------------------------------------- DOM

  const ARROW = {
    right: 'M5 12h14M13 6l6 6-6 6', up: 'M12 19V5M6 11l6-6 6 6', down: 'M12 5v14M6 13l6 6 6-6', left: 'M19 12H5M11 6l-6 6 6 6',
  };
  const NAMES = { right: 'ימינה', up: 'למעלה', down: 'למטה', left: 'שמאלה' };
  const nudgeRow = () => '<div class="dhe-nudge" role="group" aria-label="הזזה"><span class="dhe-nudge-label">הזזה</span>' +
    ['right', 'up', 'down', 'left'].map(d => `<button type="button" data-nudge="${d}" aria-label="הזזה ${NAMES[d]}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${ARROW[d]}"/></svg></button>`).join('') +
    '<button type="button" data-nudge="center" class="wide">למרכז</button></div>';
  const stepper = () => '<div class="dhe-stepper" aria-label="גודל"><button type="button" data-size="down" aria-label="הקטנה">−</button><output></output><button type="button" data-size="up" aria-label="הגדלה">+</button></div>';

  function editorHtml(test) {
    return `
  <div class="dhe-bar">
    <button class="dhe-btn" data-el="btnForMe" type="button">עצבו בשבילי</button>
    <span class="grow"></span>
    ${test ? '<span class="dhe-test">מצב בדיקה</span>' : ''}
    <button class="dhe-btn primary" data-el="btnSave" type="button">שמור עיצוב</button>
  </div>
  <div class="dhe-status" data-el="status" aria-live="polite" hidden></div>
  <div class="dhe-tabs" role="tablist" data-el="tabs" aria-label="פריט"></div>
  <div class="dhe-stage-wrap" data-el="stageWrap">
    <div class="dhe-stage" data-el="stage">
      <img class="dhe-bg" data-el="bg" alt="">
      <canvas data-el="cv"></canvas>
      <div class="dhe-edit" data-el="editBox" hidden>
        <textarea data-el="editTa" rows="1" dir="auto" spellcheck="false" autocapitalize="off" autocomplete="off"
          aria-label="הטקסט לחריטה" placeholder="כתבו כאן את הטקסט…"></textarea>
        <button type="button" data-el="editDone" aria-label="סיום עריכת הטקסט">✓</button>
      </div>
      <div class="dhe-loading" data-el="loading">טוען את העורך…</div>
    </div>
    <div class="dhe-readout"><span data-el="areaInfo"></span><span data-el="selInfo"></span></div>
    <div class="dhe-quick" data-el="quick" hidden>
      <span class="dhe-quick-label">גודל</span>${stepper()}
      <span class="dhe-fine" data-el="pinchHint" hidden>אפשר גם לצבוט בשתי אצבעות על התמונה</span>
    </div>
  </div>
  <div class="dhe-toolbar">
    <button class="dhe-btn" data-el="btnAddText" type="button">+ טקסט</button>
    <button class="dhe-btn" data-el="btnAddSym" type="button" aria-expanded="false">+ סמל</button>
    <span class="grow"></span>
    <button class="dhe-btn icon" data-el="btnUndo" type="button" aria-label="ביטול" title="ביטול"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7l5 5-5 5"/><path d="M20 12H9a5 5 0 0 0 0 10h2"/></svg></button>
    <button class="dhe-btn icon" data-el="btnRedo" type="button" aria-label="חזרה" title="חזרה"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7l-5 5 5 5"/><path d="M4 12h11a5 5 0 0 1 0 10h-2"/></svg></button>
  </div>
  <section class="dhe-panel" data-el="symPanel" hidden><h2>בחרו סמל</h2><div class="dhe-symbols" data-el="symGrid"></div></section>
  <section class="dhe-panel" data-el="panelEmpty"><p class="dhe-hint">הקישו על הטקסט שעל המוצר כדי לכתוב ולערוך אותו. גררו בכל מקום על התמונה כדי להזיז, וצבטו בשתי אצבעות כדי לשנות גודל.</p></section>
  <section class="dhe-panel" data-el="panelText" hidden>
    <h2>טקסט</h2>
    <div class="dhe-row">
      <button class="dhe-btn" data-el="btnEditTxt" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg> עריכת הטקסט</button>
      <button class="dhe-btn danger" data-el="tDelete" type="button">מחיקה</button>
    </div>
    <div class="dhe-fonts" data-el="fontChips" role="group" aria-label="גופן"></div>
    <div class="dhe-row">${stepper()}
      <div class="dhe-seg" data-el="alignSeg" role="group" aria-label="יישור"><button type="button" data-align="right">ימין</button><button type="button" data-align="center">מרכז</button><button type="button" data-align="left">שמאל</button></div>
    </div>
    ${nudgeRow()}
  </section>
  <section class="dhe-panel" data-el="panelSym" hidden>
    <h2 data-el="symTitle">סמל</h2>
    <div class="dhe-row">${stepper()}<button class="dhe-btn danger" data-el="sDelete" type="button">מחיקה</button></div>
    ${nudgeRow()}
  </section>
  <div class="dhe-issues" data-el="issues" hidden aria-live="polite"></div>
  ${test ? `<details class="dhe-settings">
    <summary>הגדרות בדיקה</summary>
    <div class="body">
      <label><input type="radio" name="dhe-origin" data-el="orCenter" value="center" checked> נקודת האפס של ה-DXF במרכז אזור החריטה</label>
      <label><input type="radio" name="dhe-origin" data-el="orCorner" value="corner"> נקודת האפס בפינה השמאלית התחתונה</label>
      <label><input type="checkbox" data-el="guide" checked> קו מתאר של האזור בשכבה נפרדת (GUIDE)</label>
      <p class="dhe-fine">מצב בדיקה: לקוחות לא רואים את הכפתור. בשמירה יורד קובץ ZIP עם קובצי החריטה, והשדות בהזמנה מתמלאים.</p>
      <button class="dhe-btn" data-el="btnReset" type="button">התחלה מחדש</button>
    </div>
  </details>` : ''}
  <div class="dhe-toast" data-el="toast" role="status" aria-live="polite"></div>`;
  }

  // ----------------------------------------------------------------- editor

  function createEditor(ctx) {
    const { SURFACES, bridge, test, root } = ctx;
    const E = {};
    root.querySelectorAll('[data-el]').forEach(n => { E[n.dataset.el] = n; });
    const all = sel => [...root.querySelectorAll(sel)];

    const DRAFT_KEY = 'dh-editor-v1:' + bridge.productId;
    const state = { surfaces: null, current: SURFACES[0].key };
    let canvas = null, k = 1, lastWidth = 0, quiet = 0, editId = null, lastFont = DEFAULT_FONT;
    let savedSnap = null, savedId = null;
    const foMap = new Map();
    const layCache = new Map();
    const guides = { v: false, h: false };
    let badIds = new Set();

    const surf = () => SURFACES.find(s => s.key === state.current);
    const cur = () => state.surfaces[state.current];
    const findObj = id => cur().objects.find(o => o.id === id);
    const activeModel = () => { const fo = canvas && canvas.getActiveObject(); return fo ? findObj(fo.dhId) : null; };
    const fontLabel = id => (FONTS.find(f => f.id === id) || {}).label || id;
    const symLabel = id => (SYMBOLS.find(s => s.id === id) || {}).label || id;
    const allObjects = () => SURFACES.flatMap(s => state.surfaces[s.key].objects);
    const textObjs = s => state.surfaces[s.key].objects.filter(o => o.type === 'text' && o.text.trim())
      .sort((a, b) => a.cy - b.cy || b.cx - a.cx);

    function layoutFor(o) {
      const key = o.type === 'text' ? `t|${o.text}|${o.font}|${o.sizeMm}|${o.align}|${o.lineSpacing}` : `s|${o.symbol}|${o.widthMm}`;
      let lay = layCache.get(key);
      if (!lay) {
        lay = o.type === 'text'
          ? EE.layoutText({ text: o.text, fontId: o.font, sizeMm: o.sizeMm, align: o.align, lineSpacing: o.lineSpacing })
          : EE.layoutSymbol(SYMBOLS.find(s => s.id === o.symbol), o.widthMm);
        if (layCache.size > 400) layCache.clear();
        layCache.set(key, lay);
      }
      return lay;
    }

    // ---------------------------------------------------------- canvas

    const CTRL = {
      originX: 'center', originY: 'center', strokeWidth: 0, objectCaching: false,
      lockRotation: true, lockScalingFlip: true, lockSkewingX: true, lockSkewingY: true,
      borderColor: '#c8a96e', cornerColor: '#ffffff', cornerStrokeColor: '#8f6f33', cornerStyle: 'circle',
      transparentCorners: false, cornerSize: 16, touchCornerSize: 40, borderScaleFactor: 2,
    };

    function buildFabric(o) {
      const s = surf(), lay = layoutFor(o);
      let fo;
      if (lay.polys.length) {
        fo = new fabric.Path(EE.polysToPathD(lay.polys, 3), Object.assign({}, CTRL, {
          fill: s.engrave.color, opacity: s.engrave.opacity, fillRule: 'evenodd',
          left: o.cx + lay.ink.cx, top: o.cy + lay.ink.cy,
        }));
        fo.dhIc = { x: lay.ink.cx, y: lay.ink.cy };
      } else {
        const h = Math.max(4, o.sizeMm || 10), w = h * 3;
        fo = new fabric.Rect(Object.assign({}, CTRL, { width: w, height: h, fill: 'rgba(200,169,110,0.35)', left: o.cx, top: o.cy }));
        fo.dhIc = { x: 0, y: 0 };
        fo.dhEmpty = true;
      }
      fo.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false, mtr: false });
      if (COARSE) { fo.hasControls = false; fo.borderScaleFactor = 2.5; }
      fo.dhId = o.id;
      return fo;
    }

    function clampFo(fo) {
      const A = surf().areaMm;
      const hw = fo.width * fo.scaleX / 2, hh = fo.height * fo.scaleY / 2;
      fo.left = hw * 2 >= A.w ? A.w / 2 : Math.min(Math.max(fo.left, hw), A.w - hw);
      fo.top = hh * 2 >= A.h ? A.h / 2 : Math.min(Math.max(fo.top, hh), A.h - hh);
      fo.setCoords();
    }
    function applyHitPadding(fo) {
      const wPx = fo.width * fo.scaleX * k, hPx = fo.height * fo.scaleY * k;
      fo.padding = Math.max(COARSE ? 6 : 2, (MIN_TOUCH - Math.min(wPx, hPx)) / 2);
      fo.setCoords();
    }
    function snapClamp(fo) {
      const A = surf().areaMm, snap = 8 / k;
      guides.v = Math.abs(fo.left - A.w / 2) < snap; if (guides.v) fo.left = A.w / 2;
      guides.h = Math.abs(fo.top - A.h / 2) < snap; if (guides.h) fo.top = A.h / 2;
      clampFo(fo);
    }
    function limitScale(fo, sc) {
      const A = surf().areaMm, o = findObj(fo.dhId);
      const sMax = Math.min(2 * Math.min(fo.left, A.w - fo.left) / fo.width, 2 * Math.min(fo.top, A.h - fo.top) / fo.height);
      let sMin = 0.05;
      if (o && o.type === 'text') sMin = 2 / o.sizeMm;
      if (o && o.type === 'symbol') sMin = 3 / o.widthMm;
      return Math.max(sMin, Math.min(sMax, sc));
    }
    function commitScale(fo) {
      const o = findObj(fo.dhId);
      if (!o) return;
      const sc = fo.scaleX || 1;
      if (Math.abs(sc - 1) > 1e-6) {
        if (o.type === 'text') { o.sizeMm = round2(o.sizeMm * sc); o.prefSizeMm = o.sizeMm; } else o.widthMm = round2(o.widthMm * sc);
      }
      o.cx = fo.left - fo.dhIc.x * sc;
      o.cy = fo.top - fo.dhIc.y * sc;
      placeObject(o, { select: true });
      guides.v = guides.h = false;
      syncPanel(false);
      afterChange(true);
    }
    function commitMove(fo) {
      const o = findObj(fo.dhId);
      if (!o) return;
      o.cx = fo.left - fo.dhIc.x;
      o.cy = fo.top - fo.dhIc.y;
      guides.v = guides.h = false;
      updateReadout();
      afterChange(true);
    }
    function nearestObject(p, maxMm) {
      let best = null, bestD = Infinity;
      for (const fo of foMap.values()) {
        const hw = fo.width * fo.scaleX / 2, hh = fo.height * fo.scaleY / 2;
        const d = Math.hypot(Math.max(Math.abs(p.x - fo.left) - hw, 0), Math.max(Math.abs(p.y - fo.top) - hh, 0));
        if (d < bestD) { bestD = d; best = fo; }
      }
      return bestD <= maxMm ? best : null;
    }

    function placeObject(o, opts) {
      const options = opts || {};
      const A = surf().areaMm;
      const key = o.type === 'text' ? 'sizeMm' : 'widthMm';
      const before = o[key];
      if (o.type === 'text' && o.prefSizeMm && o.sizeMm < o.prefSizeMm) o.sizeMm = o.prefSizeMm;
      let fo = buildFabric(o);
      if (!fo.dhEmpty && (fo.width > A.w || fo.height > A.h)) {
        o[key] = round2(o[key] * Math.min(A.w / fo.width, A.h / fo.height) * 0.97);
        fo = buildFabric(o);
      }
      const shrunk = o[key] < before - 0.005;
      clampFo(fo);
      applyHitPadding(fo);
      o.cx = fo.left - fo.dhIc.x;
      o.cy = fo.top - fo.dhIc.y;
      const old = foMap.get(o.id);
      quiet++;
      if (old) {
        const idx = canvas.getObjects().indexOf(old);
        canvas.remove(old);
        canvas.insertAt(fo, Math.max(0, idx));
      } else canvas.add(fo);
      foMap.set(o.id, fo);
      if (options.select) canvas.setActiveObject(fo);
      quiet--;
      canvas.requestRenderAll();
      return { fo, shrunk };
    }

    function renderSurface() {
      const s = surf();
      endEdit(false);
      quiet++; canvas.discardActiveObject(); canvas.clear(); quiet--;
      foMap.clear();
      E.bg.src = s.img.url;
      E.bg.alt = s.label;
      lastWidth = 0;
      fitStage();
      for (const o of cur().objects) placeObject(o);
      E.areaInfo.innerHTML = `אזור החריטה: רוחב <strong>${s.areaMm.w}</strong> · גובה <strong>${s.areaMm.h}</strong> מ״מ`;
      renderTabs();
      syncPanel(true);
    }

    // The image fills the width, up to ~55% of the screen height.
    function fitStage() {
      const s = surf();
      const avail = E.stageWrap.clientWidth;
      if (!avail || avail === lastWidth) return;
      lastWidth = avail;
      const maxH = Math.max(220, (window.innerHeight || 700) * 0.55);
      const W = Math.round(Math.min(avail, maxH * s.img.w / s.img.h));
      const H = Math.round(W * s.img.h / s.img.w);
      E.stage.style.width = W + 'px';
      E.stage.style.height = H + 'px';
      canvas.setDimensions({ width: W, height: H });
      k = (s.area.wPct / 100 * W) / s.areaMm.w;
      canvas.setViewportTransform([k, 0, 0, k, s.area.xPct / 100 * W, s.area.yPct / 100 * H]);
      for (const fo of foMap.values()) applyHitPadding(fo);
      canvas.requestRenderAll();
    }

    function setupCanvas() {
      canvas = new fabric.Canvas(E.cv, {
        selection: false, preserveObjectStacking: true, centeredScaling: true, uniformScaling: true,
        enableRetinaScaling: true, targetFindTolerance: 6,
      });
      canvas.on('selection:created', () => { if (!quiet) syncPanel(true); });
      canvas.on('selection:updated', () => { if (!quiet) syncPanel(true); });
      canvas.on('selection:cleared', () => { if (!quiet) syncPanel(true); });
      canvas.on('object:moving', e => { snapClamp(e.target); updateReadout(); });
      canvas.on('object:scaling', e => {
        const fo = e.target;
        fo.scaleX = fo.scaleY = limitScale(fo, fo.scaleX);
        updateReadout(fo.scaleX);
      });
      canvas.on('object:modified', e => {
        const fo = e.target;
        if (foMap.get(fo.dhId) !== fo) return;
        if (Math.abs((fo.scaleX || 1) - 1) > 1e-6) { commitScale(fo); return; }
        const o = findObj(fo.dhId);
        if (!o) return;
        o.cx = fo.left - fo.dhIc.x;
        o.cy = fo.top - fo.dhIc.y;
        applyHitPadding(fo);
        guides.v = guides.h = false;
        syncPanel(false);
        afterChange(true);
      });

      // Touch: a finger near an object picks it; with something selected a
      // drag anywhere on the image moves it; a tap (no drag) on a text opens
      // the writing bar; a tap on empty space deselects.
      let drag = null, tapT = null;
      if (COARSE) canvas._shouldClearSelection = () => false;
      canvas.on('mouse:down', opt => {
        if (!COARSE) return;
        drag = null;
        tapT = null;
        if (opt.target) {
          // Fabric moves it itself; remember where it started so a tap
          // (no movement) can open the text for writing
          tapT = { fo: opt.target, ox: opt.target.left, oy: opt.target.top };
          return;
        }
        const p = canvas.getPointer(opt.e);
        const near = nearestObject(p, 24 / k);
        const active = canvas.getActiveObject();
        const fo = near || active;
        if (!fo) return;
        if (fo !== active) canvas.setActiveObject(fo);
        drag = { fo, picked: !!near, sx: p.x, sy: p.y, ox: fo.left, oy: fo.top, moved: false };
      });
      canvas.on('mouse:move', opt => {
        if (!drag) return;
        const p = canvas.getPointer(opt.e);
        const dx = p.x - drag.sx, dy = p.y - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) * k < 5) return;
        drag.moved = true;
        drag.fo.left = drag.ox + dx;
        drag.fo.top = drag.oy + dy;
        snapClamp(drag.fo);
        updateReadout();
        canvas.requestRenderAll();
      });
      const tapToEdit = fo => {
        const o = findObj(fo.dhId);
        if (o && o.type === 'text') startEdit(o);
      };
      canvas.on('mouse:up', () => {
        const d = drag, t = tapT;
        drag = null;
        tapT = null;
        if (d && d.moved) commitMove(d.fo);
        else if (d && d.picked) tapToEdit(d.fo);
        else if (d && !d.picked) canvas.discardActiveObject();
        else if (t && Math.hypot(t.fo.left - t.ox, t.fo.top - t.oy) * k < 3) tapToEdit(t.fo);
        if (guides.v || guides.h) guides.v = guides.h = false;
        canvas.requestRenderAll();
      });

      // desktop: double-click a text to edit it
      canvas.on('mouse:dblclick', opt => {
        if (opt.target) tapToEdit(opt.target);
      });

      // Two-finger pinch resizes the selected (or nearest) object.
      const wrap = canvas.wrapperEl;
      let pinch = null, swallow = false;
      const fingerDist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      const toMm = (cx, cy) => {
        const r = canvas.upperCanvasEl.getBoundingClientRect(), v = canvas.viewportTransform;
        return { x: (cx - r.left - v[4]) / v[0], y: (cy - r.top - v[5]) / v[3] };
      };
      wrap.addEventListener('touchstart', e => {
        if (e.touches.length < 2) return;
        e.preventDefault(); e.stopPropagation();
        swallow = true;
        if (pinch) return;
        // the object between the fingers wins; otherwise the selected one
        const t = e.touches;
        let fo = nearestObject(toMm((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2), 30 / k) || canvas.getActiveObject();
        if (!fo) return;
        if (fo !== canvas.getActiveObject()) canvas.setActiveObject(fo);
        drag = null;
        tapT = null;
        fo.lockMovementX = fo.lockMovementY = true;
        pinch = { fo, d0: fingerDist(e.touches), s0: fo.scaleX || 1 };
      }, { capture: true, passive: false });
      wrap.addEventListener('touchmove', e => {
        if (!swallow) return;
        e.preventDefault(); e.stopPropagation();
        if (!pinch || e.touches.length < 2) return;
        const fo = pinch.fo;
        fo.scaleX = fo.scaleY = limitScale(fo, pinch.s0 * fingerDist(e.touches) / pinch.d0);
        fo.setCoords();
        updateReadout(fo.scaleX);
        canvas.requestRenderAll();
      }, { capture: true, passive: false });
      const pinchEnd = e => {
        if (!swallow) return;
        if (e.touches.length > 0) { e.stopPropagation(); return; }
        swallow = false;
        if (pinch) {
          const fo = pinch.fo;
          pinch = null;
          fo.lockMovementX = fo.lockMovementY = false;
          commitScale(fo);
        }
      };
      wrap.addEventListener('touchend', pinchEnd, { capture: true });
      wrap.addEventListener('touchcancel', pinchEnd, { capture: true });

      canvas.on('after:render', opt => {
        const c = (opt && opt.ctx) || canvas.contextContainer;
        const r = canvas.getRetinaScaling(), v = canvas.viewportTransform, A = surf().areaMm, px = 1 / k;
        c.save();
        c.setTransform(v[0] * r, 0, 0, v[3] * r, v[4] * r, v[5] * r);
        const outline = () => {
          if (surf().area.shape === 'ellipse') { c.beginPath(); c.ellipse(A.w / 2, A.h / 2, A.w / 2, A.h / 2, 0, 0, Math.PI * 2); c.stroke(); } else c.strokeRect(0, 0, A.w, A.h);
        };
        c.lineWidth = 2.4 * px; c.strokeStyle = 'rgba(0,0,0,0.35)'; c.setLineDash([]); outline();
        c.lineWidth = 1.3 * px; c.strokeStyle = 'rgba(255,255,255,0.92)'; c.setLineDash([6 * px, 4 * px]); outline();
        c.setLineDash([]);
        c.strokeStyle = '#e8b04a'; c.lineWidth = 1.5 * px;
        if (guides.v) { c.beginPath(); c.moveTo(A.w / 2, 0); c.lineTo(A.w / 2, A.h); c.stroke(); }
        if (guides.h) { c.beginPath(); c.moveTo(0, A.h / 2); c.lineTo(A.w, A.h / 2); c.stroke(); }
        for (const id of badIds) {
          const fo = foMap.get(id);
          if (!fo) continue;
          const w = fo.width * fo.scaleX, h = fo.height * fo.scaleY;
          c.strokeStyle = '#d93025'; c.lineWidth = 2 * px; c.setLineDash([4 * px, 3 * px]);
          c.strokeRect(fo.left - w / 2 - 3 * px, fo.top - h / 2 - 3 * px, w + 6 * px, h + 6 * px);
        }
        c.restore();
      });
    }

    // ---------------------------------------------------------- panels

    function renderTabs() {
      E.tabs.hidden = SURFACES.length < 2;
      E.tabs.innerHTML = '';
      for (const s of SURFACES) {
        const n = state.surfaces[s.key].objects.filter(o => o.type !== 'text' || o.text.trim()).length;
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(s.key === state.current));
        b.innerHTML = `${escHtml(s.label)} <span class="count">· ${n}</span>`;
        b.addEventListener('click', () => {
          if (s.key === state.current) return;
          state.current = s.key;
          E.symPanel.hidden = true;
          E.btnAddSym.setAttribute('aria-expanded', 'false');
          renderSurface();
          afterChange(false);
        });
        E.tabs.appendChild(b);
      }
    }

    function buildFontChips(o) {
      E.fontChips.innerHTML = '';
      for (const f of FONTS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dhe-chip';
        b.dataset.font = f.id;
        b.innerHTML = '<span class="sample"></span><span class="name"></span>';
        b.querySelector('.sample').style.fontFamily = `"dh-${f.id}", system-ui, sans-serif`;
        b.addEventListener('click', async () => {
          const m = activeModel();
          if (!m || m.type !== 'text') return;
          if (!EE.hasFont(f.id)) {
            b.classList.add('loading');
            try { await ensureFont(f.id); } catch (e) { toast('לא הצלחתי לטעון את הגופן. נסו שוב.'); return; } finally { b.classList.remove('loading'); }
            if (activeModel() !== m) return;
          }
          m.font = f.id;
          lastFont = f.id;
          if (editingId === m.id) E.editTa.style.fontFamily = `"dh-${f.id}", system-ui, sans-serif`;
          const { shrunk } = placeObject(m, { select: true });
          if (shrunk) toast('הטקסט הוקטן כדי להיכנס לאזור החריטה');
          syncPanel(false);
          afterChange(true);
        });
        E.fontChips.appendChild(b);
      }
      updateFontChips(o);
      const on = E.fontChips.querySelector(`[data-font="${o.font}"]`);
      if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function updateFontChips(o) {
      if (!o || o.type !== 'text') return;
      const line = (o.text.split('\n').find(l => l.trim()) || '').trim();
      const sample = [...(line || 'אבג abc')].slice(0, 14).join('');
      const clean = EE.cleanText(o.text);
      for (const b of E.fontChips.children) {
        const f = FONTS.find(x => x.id === b.dataset.font);
        const loaded = EE.hasFont(f.id);
        const miss = loaded && EE.checkChars(clean, EE.getFont(f.id)).missing.length > 0;
        b.classList.toggle('warn', miss);
        b.classList.toggle('loading', !loaded);
        b.setAttribute('aria-pressed', String(o.font === f.id));
        b.querySelector('.sample').textContent = sample;
        b.querySelector('.name').textContent = miss ? f.label + ' · חסרות אותיות' : f.label;
        b.title = miss ? 'בגופן הזה חסרות חלק מהאותיות שכתבתם' : f.label;
      }
    }

    function syncPanel(reset) {
      const o = activeModel();
      if (editingId && (!o || o.id !== editingId)) endEdit();
      E.quick.hidden = !o;
      E.panelEmpty.hidden = !!o;
      E.panelText.hidden = !(o && o.type === 'text');
      E.panelSym.hidden = !(o && o.type === 'symbol');
      if (!o) { editId = null; updateReadout(); return; }
      let sizeText;
      if (o.type === 'text') {
        if (reset || editId !== o.id) buildFontChips(o); else updateFontChips(o);
        const lay = layoutFor(o);
        sizeText = lay.polys.length ? `גובה אות ${fmt(lay.letterHeightMm)} מ״מ` : `גופן ${fmt(o.sizeMm)} מ״מ`;
        for (const b of E.alignSeg.children) b.setAttribute('aria-pressed', String(b.dataset.align === o.align));
      } else {
        E.symTitle.textContent = 'סמל: ' + symLabel(o.symbol);
        sizeText = `רוחב ${fmt(o.widthMm)} מ״מ`;
      }
      for (const out of all('.dhe-stepper output')) out.textContent = sizeText;
      editId = o.id;
      updateReadout();
    }

    function updateReadout(liveScale) {
      const fo = canvas && canvas.getActiveObject();
      const o = fo ? findObj(fo.dhId) : null;
      if (!o) { E.selInfo.textContent = ''; return; }
      const sc = liveScale || 1;
      const w = fo.width * (liveScale || fo.scaleX), h = fo.height * (liveScale || fo.scaleY);
      if (o.type === 'text') {
        if (fo.dhEmpty) { E.selInfo.textContent = 'תיבת טקסט ריקה'; return; }
        E.selInfo.innerHTML = `גובה אות <strong>${fmt(layoutFor(o).letterHeightMm * sc)} מ״מ</strong> · רוחב ${fmt(w)} · גובה ${fmt(h)} מ״מ`;
      } else {
        E.selInfo.innerHTML = `${escHtml(symLabel(o.symbol))} · רוחב <strong>${fmt(w)}</strong> · גובה <strong>${fmt(h)}</strong> מ״מ`;
      }
    }

    function buildSymGrid() {
      for (const sym of SYMBOLS) {
        const lay = EE.layoutSymbol(sym, 100), b = lay.ink;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dhe-sym';
        btn.innerHTML = `<svg viewBox="${b.x0.toFixed(1)} ${b.y0.toFixed(1)} ${b.w.toFixed(1)} ${b.h.toFixed(1)}" aria-hidden="true"><path d="${EE.polysToPathD(lay.polys, 1)}" fill="currentColor" fill-rule="evenodd"/></svg><span></span>`;
        btn.querySelector('span').textContent = sym.label;
        btn.addEventListener('click', () => addSymbol(sym));
        E.symGrid.appendChild(btn);
      }
    }

    // ---------------------------------------------------------- actions

    function freeSpot(A) {
      const taken = cur().objects.map(o => o.cy);
      for (const dy of [0, 0.25, -0.25, 0.4, -0.4]) {
        const y = A.h / 2 + dy * A.h;
        if (!taken.some(t => Math.abs(t - y) < A.h * 0.12)) return { cx: A.w / 2, cy: y };
      }
      return { cx: A.w / 2, cy: A.h / 2 };
    }

    function newText(s, text, font, spot) {
      return { id: uid(), type: 'text', text, font, sizeMm: s.defaultTextMm, prefSizeMm: s.defaultTextMm, align: 'center', lineSpacing: 1.15, cx: spot.cx, cy: spot.cy };
    }

    function addText() {
      const s = surf();
      if (cur().objects.filter(o => o.type === 'text').length >= s.limits.textBoxes) { toast(`אפשר עד ${s.limits.textBoxes} תיבות טקסט על ה${s.label}`); return; }
      const o = newText(s, '', lastFont, freeSpot(s.areaMm));
      cur().objects.push(o);
      placeObject(o, { select: true });
      syncPanel(true);
      afterChange(true);
      startEdit(o);
    }

    function addSymbol(sym) {
      const s = surf(), A = s.areaMm;
      if (cur().objects.filter(o => o.type === 'symbol').length >= s.limits.symbols) { toast(`אפשר עד ${s.limits.symbols} סמלים על ה${s.label}`); return; }
      if (allObjects().filter(o => o.type === 'symbol').length >= bridge.symbolCap) { toast(`אפשר עד ${bridge.symbolCap} סמלים בהזמנה הזו`); return; }
      const o = { id: uid(), type: 'symbol', symbol: sym.id, widthMm: round2(Math.min(sym.defaultWidthMm, A.h * 0.7)), ...freeSpot(A) };
      cur().objects.push(o);
      placeObject(o, { select: true });
      E.symPanel.hidden = true;
      E.btnAddSym.setAttribute('aria-expanded', 'false');
      syncPanel(true);
      afterChange(true);
    }

    function deleteActive() {
      const o = activeModel();
      if (!o) return;
      if (editingId === o.id) { editingId = null; E.editBox.hidden = true; }
      const fo = foMap.get(o.id);
      cur().objects = cur().objects.filter(x => x.id !== o.id);
      quiet++; canvas.discardActiveObject(); if (fo) canvas.remove(fo); quiet--;
      foMap.delete(o.id);
      canvas.requestRenderAll();
      syncPanel(true);
      afterChange(true);
    }

    function resizeStep(f) {
      const o = activeModel();
      if (!o) return false;
      const key = o.type === 'text' ? 'sizeMm' : 'widthMm';
      const next = round2(o[key] * f);
      if (next < (o.type === 'text' ? 2 : 3)) { toast('זה הגודל הקטן ביותר'); return false; }
      const prev = o[key];
      o[key] = next;
      if (o.type === 'text') o.prefSizeMm = next;
      const { shrunk } = placeObject(o, { select: true });
      if (o.type === 'text') o.prefSizeMm = o.sizeMm;
      if (shrunk && f > 1) toast('זה הגודל הגדול ביותר שנכנס לאזור החריטה');
      syncPanel(false);
      renderIssues(validate());
      canvas.requestRenderAll();
      return Math.abs(o[key] - prev) > 0.005;
    }

    function holdRepeat(btn, step, done) {
      let delay = null, repeat = null, changed = false;
      const stop = () => {
        clearTimeout(delay); clearInterval(repeat); delay = repeat = null;
        if (changed) { changed = false; done(); }
      };
      btn.addEventListener('pointerdown', e => {
        e.preventDefault();
        changed = step() || changed;
        delay = setTimeout(() => { repeat = setInterval(() => { changed = step() || changed; }, 140); }, 400);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, stop);
      btn.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (step()) done();
      });
    }

    let typingTimer = null;
    function applyLimits(v) {
      const lim = surf().limits;
      let note = '';
      if (FORBIDDEN_RE.test(v)) { v = v.replace(FORBIDDEN_RE, ''); note = 'ניקוד ואימוג\'י לא נתמכים בחריטה'; }
      FORBIDDEN_RE.lastIndex = 0;
      let lines = v.split('\n');
      if (lines.length > lim.linesPerBox) { lines = lines.slice(0, lim.linesPerBox); note = `אפשר עד ${lim.linesPerBox} שורות בתיבה`; }
      lines = lines.map(l => {
        const chars = [...l];
        if (chars.length > lim.charsPerLine) { note = `אפשר עד ${lim.charsPerLine} תווים בשורה`; return chars.slice(0, lim.charsPerLine).join(''); }
        return l;
      });
      return { v: lines.join('\n'), note };
    }

    // ----------------------------------------------------- inline editing
    // Tapping a text on the product opens a floating writing bar pinned to
    // the top of the image, so the design stays in view and the page does
    // not jump when the keyboard opens. The text updates live as you type.

    let editingId = null;

    function fitEditBox() {
      const t = E.editTa;
      t.style.height = 'auto';
      t.style.height = Math.min(t.scrollHeight, Math.max(88, E.stage.clientHeight * 0.55)) + 'px';
    }

    function startEdit(o) {
      if (!o || o.type !== 'text') return;
      const fo = foMap.get(o.id);
      if (fo && canvas.getActiveObject() !== fo) { canvas.setActiveObject(fo); canvas.requestRenderAll(); }
      editingId = o.id;
      E.editBox.hidden = false;
      E.editTa.value = o.text;
      E.editTa.style.fontFamily = `"dh-${o.font}", system-ui, sans-serif`;
      E.editTa.style.textAlign = o.align === 'left' ? 'left' : o.align === 'right' ? 'right' : 'center';
      fitEditBox();
      E.editTa.focus({ preventScroll: true });
      const len = E.editTa.value.length;
      try { E.editTa.setSelectionRange(len, len); } catch (e) { /* ok */ }
      const r = E.stage.getBoundingClientRect();
      const vh = window.innerHeight || 700;
      if (r.top < 0 || r.top > vh * 0.4) E.stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function endEdit(commit) {
      if (!editingId) return;
      editingId = null;
      E.editBox.hidden = true;
      clearTimeout(typingTimer);
      if (commit !== false) pushHistory();
    }

    function onEditInput() {
      const o = editingId && findObj(editingId);
      if (!o) { endEdit(false); return; }
      const t = E.editTa;
      const { v, note } = applyLimits(t.value);
      if (v !== t.value) { const pos = Math.min(t.selectionStart, v.length); t.value = v; t.setSelectionRange(pos, pos); }
      if (note) toast(note);
      o.text = v;
      const { shrunk } = placeObject(o, { select: true });
      if (shrunk) toast('הטקסט הוקטן כדי להיכנס לאזור החריטה');
      fitEditBox();
      syncPanel(false);
      afterChange(false);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(pushHistory, 700);
    }

    // ------------------------------------------------------- validation

    function validate() {
      const issues = [];
      let total = 0;
      for (const s of SURFACES) {
        let texts = 0;
        for (const o of state.surfaces[s.key].objects) {
          if (o.type === 'symbol') { total++; continue; }
          if (!o.text.trim()) continue;
          total++; texts++;
          const lay = layoutFor(o);
          const short = [...o.text.replace(/\n/g, ' ')].slice(0, 18).join('');
          if (lay.missing.length) issues.push({ id: o.id, surf: s.key, msg: `${s.label}: בגופן "${fontLabel(o.font)}" אין את התווים ${lay.missing.join(' ')}. בחרו גופן אחר או מחקו אותם.` });
          if (lay.letterHeightMm < s.minLetterMm) issues.push({ id: o.id, surf: s.key, msg: `${s.label}: "${short}" קטן מדי לחריטה. גובה האות ${fmt(lay.letterHeightMm)} מ״מ, והמינימום הוא ${s.minLetterMm} מ״מ.` });
        }
        if (!texts && s.requiresText) issues.push({ surf: s.key, need: true, msg: `${s.label}: חסר טקסט לחריטה.` });
      }
      if (!total) issues.push({ msg: 'הוסיפו טקסט או סמל לפני השמירה.' });
      return issues;
    }

    function renderIssues(issues, showAll) {
      const shown = issues.filter(i => i.id || (showAll && i.need));
      E.issues.innerHTML = shown.map(i => '<div>' + escHtml(i.msg) + '</div>').join('');
      E.issues.hidden = shown.length === 0;
      badIds = new Set(shown.filter(i => i.id && i.surf === state.current).map(i => i.id));
    }

    // ----------------------------------------------------- page syncing

    const linesOf = s => textObjs(s).flatMap(o => o.text.split('\n').map(l => l.trim()).filter(Boolean));

    function syncToPage() {
      for (const s of SURFACES) bridge.writeFields(s.textFields, linesOf(s));
      const first = SURFACES.map(s => textObjs(s)[0]).find(Boolean);
      if (first) bridge.selectFont(fontLabel(first.font));
      const syms = [];
      for (const o of allObjects()) {
        const opt = o.type === 'symbol' && SYMBOL_OPTION[o.symbol];
        if (opt && !syms.includes(opt)) syms.push(opt);
      }
      bridge.setSymbols(syms.slice(0, bridge.symbolCap));
    }
    let syncTimer = null;
    const scheduleSync = () => { clearTimeout(syncTimer); syncTimer = setTimeout(syncToPage, 400); };

    const snapshot = () => JSON.stringify({ surfaces: state.surfaces, current: state.current });
    const designSnap = () => JSON.stringify(SURFACES.map(s => state.surfaces[s.key].objects));
    const isSaved = () => savedSnap !== null && savedSnap === designSnap();

    function updateStatus() {
      E.status.classList.remove('ok', 'dirty');
      E.status.hidden = savedSnap === null;
      if (savedSnap === null) { E.status.textContent = ''; return; }
      if (isSaved()) { E.status.textContent = `העיצוב נשמר · קוד ${savedId}`; E.status.classList.add('ok'); } else { E.status.textContent = 'יש שינויים שלא נשמרו'; E.status.classList.add('dirty'); }
    }

    function afterChange(commit) {
      renderIssues(validate());
      renderTabs();
      updateUndo();
      updateStatus();
      canvas.requestRenderAll();
      scheduleSync();
      if (commit) pushHistory();
    }

    // ---------------------------------------------------------- history

    const hist = { stack: [], idx: -1 };
    function pushHistory() {
      clearTimeout(typingTimer);
      const snap = snapshot();
      if (hist.stack[hist.idx] === snap) return;
      hist.stack = hist.stack.slice(0, hist.idx + 1);
      hist.stack.push(snap);
      if (hist.stack.length > 40) hist.stack.shift();
      hist.idx = hist.stack.length - 1;
      saveDraft();
      updateUndo();
    }
    function restore(snap) {
      endEdit(false);
      const d = JSON.parse(snap);
      state.surfaces = d.surfaces;
      state.current = d.current;
      renderSurface();
      renderIssues(validate());
      updateUndo();
      updateStatus();
      scheduleSync();
      saveDraft();
    }
    function updateUndo() {
      E.btnUndo.disabled = hist.idx <= 0;
      E.btnRedo.disabled = hist.idx >= hist.stack.length - 1;
    }
    function saveDraft() {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, surfaces: state.surfaces, current: state.current, savedSnap, savedId })); } catch (e) { /* storage unavailable */ }
    }
    function loadDraft() {
      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return null;
        const d = JSON.parse(raw);
        for (const s of SURFACES) {
          const objs = d.surfaces && d.surfaces[s.key] && d.surfaces[s.key].objects;
          if (!Array.isArray(objs)) return null;
          for (const o of objs) {
            if (o.type === 'text' && (typeof o.text !== 'string' || !FONTS.some(f => f.id === o.font))) return null;
            if (o.type === 'symbol' && !SYMBOLS.some(x => x.id === o.symbol)) return null;
          }
        }
        if (!SURFACES.some(s => s.key === d.current)) d.current = SURFACES[0].key;
        return d;
      } catch (e) { return null; }
    }

    // What the customer already typed in the regular fields becomes the
    // starting text, in the font chosen there. Ticked symbols come along too.
    function initialDesign() {
      const pageFont = FONTS.find(f => f.label === bridge.selectedFontLabel());
      const font = pageFont ? pageFont.id : DEFAULT_FONT;
      lastFont = font;
      const out = {};
      const checked = bridge.checkedSymbols();
      for (const s of SURFACES) {
        const A = s.areaMm;
        let lines = bridge.readFields(s.textFields);
        if (lines.length > s.limits.linesPerBox) lines = lines.slice(0, s.limits.linesPerBox - 1).concat(lines.slice(s.limits.linesPerBox - 1).join(' '));
        lines = lines.map(l => [...l].slice(0, s.limits.charsPerLine).join(''));
        const objects = [newText(s, lines.join('\n'), font, { cx: A.w / 2, cy: A.h / 2 })];
        out[s.key] = { objects };
      }
      // symbols ticked on the page go on the first surface, above the text
      const s0 = SURFACES[0];
      let n = 0;
      for (const label of checked) {
        const sym = SYMBOLS.find(x => SYMBOL_OPTION[x.id] === label);
        if (!sym || n >= Math.min(s0.limits.symbols, bridge.symbolCap)) continue;
        const A = s0.areaMm;
        out[s0.key].objects.push({ id: uid(), type: 'symbol', symbol: sym.id, widthMm: round2(Math.min(sym.defaultWidthMm, A.h * 0.3)), cx: A.w / 2 + (n - (checked.length - 1) / 2) * A.w * 0.2, cy: A.h * 0.2 });
        n++;
      }
      return out;
    }

    // ----------------------------------------------------------- saving

    function makeId() {
      const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const r = new Uint32Array(8);
      crypto.getRandomValues(r);
      return [...r].map(n => abc[n % abc.length]).join('');
    }

    function previewBlob(s, polys) {
      const img = s.img.el;
      const c = document.createElement('canvas');
      c.width = s.img.w; c.height = s.img.h;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, c.width, c.height);
      const kk = (s.area.wPct / 100 * c.width) / s.areaMm.w;
      g.setTransform(kk, 0, 0, kk, s.area.xPct / 100 * c.width, s.area.yPct / 100 * c.height);
      g.globalCompositeOperation = s.engrave.blend || 'source-over';
      g.globalAlpha = s.engrave.opacity;
      g.fillStyle = s.engrave.color;
      if (polys.length) g.fill(new Path2D(EE.polysToPathD(polys, 3)), 'evenodd');
      return new Promise(res => c.toBlob(res, 'image/jpeg', 0.88));
    }

    function surfacePolys(s) {
      const objs = state.surfaces[s.key].objects.filter(o => o.type !== 'text' || o.text.trim());
      const all = [];
      for (const o of objs) all.push(...EE.translate(layoutFor(o).polys, o.cx, o.cy));
      return { objs, polys: EE.union(all, 'nonzero') };
    }

    async function buildFiles(id) {
      const origin = E.orCorner && E.orCorner.checked ? 'corner' : 'center';
      const guide = E.guide ? E.guide.checked : true;
      const files = [];
      const design = { schema: 1, designId: id, productId: bridge.productId, page: location.href.split('#')[0], createdAt: new Date().toISOString(), editor: VERSION, dxfOrigin: origin, surfaces: [] };
      for (const s of SURFACES) {
        const { objs, polys } = surfacePolys(s);
        if (!objs.length) continue;
        const area = { w: s.areaMm.w, h: s.areaMm.h, shape: s.area.shape };
        files.push({ name: `${id}_${s.fileLabel}.dxf`, data: EE.toDXF(polys, area, { origin, guide }) });
        files.push({ name: `${id}_${s.fileLabel}.svg`, data: EE.toSVG(polys, area, { guide }) });
        files.push({ name: `${id}_${s.fileLabel}_preview.jpg`, data: await previewBlob(s, polys) });
        design.surfaces.push({
          key: s.key, fileLabel: s.fileLabel, areaMm: s.areaMm,
          objects: objs.map(o => o.type === 'text'
            ? { type: 'text', text: o.text, font: o.font, fontLabel: fontLabel(o.font), sizeMm: o.sizeMm, align: o.align, lineSpacing: o.lineSpacing, cxMm: round2(o.cx), cyMm: round2(o.cy) }
            : { type: 'symbol', symbol: o.symbol, symbolLabel: symLabel(o.symbol), widthMm: o.widthMm, cxMm: round2(o.cx), cyMm: round2(o.cy) }),
        });
      }
      files.push({ name: `${id}_design.json`, data: JSON.stringify(design, null, 2) });
      return files;
    }

    async function downloadZip(id, files) {
      await loadScript(JSZIP);
      const zip = new window.JSZip();
      for (const f of files) zip.file(f.name, f.data);
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `harita-design-${id}.zip`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }

    const designFieldText = id => `עוצב ע״י הלקוח - אין צורך בסקיצה · קוד ${id}` + (test ? ' · בדיקה' : '');

    let saving = false;
    async function save() {
      if (saving) return;
      endEdit();
      const issues = validate();
      renderIssues(issues, true);
      canvas.requestRenderAll();
      if (issues.length) {
        const other = issues.find(i => i.surf && i.surf !== state.current);
        if (other && !issues.some(i => i.surf === state.current)) { state.current = other.surf; renderSurface(); renderIssues(issues, true); }
        toast(issues.length === 1 ? issues[0].msg : 'יש מה לתקן לפני השמירה');
        if (!E.issues.hidden) E.issues.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      saving = true;
      E.btnSave.disabled = true;
      E.btnSave.textContent = 'שומר…';
      try {
        clearTimeout(syncTimer);
        syncToPage();
        const id = makeId();
        const files = await buildFiles(id);
        window.__dhLastFiles = files;
        if (test) await downloadZip(id, files);
        savedSnap = designSnap();
        savedId = id;
        bridge.setDesignField(designFieldText(id));
        saveDraft();
        updateStatus();
        toast(`העיצוב נשמר. קוד העיצוב: ${id}`);
      } catch (e) {
        console.error('[DHEditor] save failed', e);
        toast('השמירה לא הצליחה. נסו שוב.');
      } finally {
        saving = false;
        E.btnSave.disabled = false;
        E.btnSave.textContent = 'שמור עיצוב';
      }
    }

    // ------------------------------------------------------------ toast

    let toastTimer = null;
    function toast(msg) {
      E.toast.textContent = msg;
      E.toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => E.toast.classList.remove('show'), 3200);
    }

    // ----------------------------------------------------------- wiring

    const nudgeStep = () => Math.max(0.5, Math.round(surf().areaMm.w / 140 * 2) / 2);
    function nudge(dir) {
      const fo = canvas.getActiveObject();
      if (!fo) return false;
      const A = surf().areaMm, s = nudgeStep();
      if (dir === 'center') fo.left = A.w / 2;
      else if (dir === 'left') fo.left -= s;
      else if (dir === 'right') fo.left += s;
      else if (dir === 'up') fo.top -= s;
      else if (dir === 'down') fo.top += s;
      clampFo(fo);
      updateReadout();
      canvas.requestRenderAll();
      return true;
    }

    function wire() {
      for (const b of all('[data-nudge]')) holdRepeat(b, () => nudge(b.dataset.nudge), () => { const fo = canvas.getActiveObject(); if (fo) commitMove(fo); });
      for (const b of all('[data-size]')) holdRepeat(b, () => resizeStep(b.dataset.size === 'up' ? 1.1 : 1 / 1.1), () => afterChange(true));
      E.pinchHint.hidden = !COARSE;
      E.btnAddText.addEventListener('click', addText);
      E.btnAddSym.addEventListener('click', () => {
        E.symPanel.hidden = !E.symPanel.hidden;
        E.btnAddSym.setAttribute('aria-expanded', String(!E.symPanel.hidden));
      });
      E.btnUndo.addEventListener('click', () => { if (hist.idx > 0) { hist.idx--; restore(hist.stack[hist.idx]); } });
      E.btnRedo.addEventListener('click', () => { if (hist.idx < hist.stack.length - 1) { hist.idx++; restore(hist.stack[hist.idx]); } });
      E.editTa.addEventListener('input', onEditInput);
      E.editTa.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); endEdit(); } });
      E.editDone.addEventListener('click', () => endEdit());
      E.btnEditTxt.addEventListener('click', () => startEdit(activeModel()));
      E.tDelete.addEventListener('click', deleteActive);
      E.sDelete.addEventListener('click', deleteActive);
      for (const b of E.alignSeg.children) {
        b.addEventListener('click', () => {
          const o = activeModel();
          if (!o || o.type !== 'text') return;
          o.align = b.dataset.align;
          placeObject(o, { select: true });
          syncPanel(false);
          afterChange(true);
        });
      }
      E.btnSave.addEventListener('click', save);
      E.btnForMe.addEventListener('click', () => ctx.onClose());
      if (E.btnReset) E.btnReset.addEventListener('click', () => {
        state.surfaces = initialDesign();
        state.current = SURFACES[0].key;
        savedSnap = null;
        renderSurface();
        afterChange(true);
      });
      root.addEventListener('keydown', e => {
        const tag = (e.target && e.target.tagName) || '';
        if ((e.key === 'Delete' || e.key === 'Backspace') && !/INPUT|TEXTAREA/.test(tag) && activeModel()) { e.preventDefault(); deleteActive(); }
      });
      new ResizeObserver(() => fitStage()).observe(E.stageWrap);
    }

    async function start() {
      setupCanvas();
      const draft = loadDraft();
      if (draft) {
        state.surfaces = draft.surfaces;
        state.current = draft.current;
        savedSnap = draft.savedSnap || null;
        savedId = draft.savedId || null;
      } else {
        state.surfaces = initialDesign();
      }
      const used = new Set([DEFAULT_FONT, lastFont]);
      for (const o of allObjects()) if (o.type === 'text') used.add(o.font);
      E.loading.textContent = 'טוען גופנים…';
      await Promise.all([...used].map(ensureFont));
      E.bg.src = surf().img.url;
      buildSymGrid();
      wire();
      E.loading.hidden = true;
      renderSurface();
      renderIssues(validate());
      pushHistory();
      updateStatus();
      // the page fields follow the design from the start (a draft may differ
      // from what is in them), and a design saved earlier keeps its code
      syncToPage();
      if (isSaved()) bridge.setDesignField(designFieldText(savedId));
      // the other fonts load in the background
      for (const f of FONTS) ensureFont(f.id).then(() => { const o = activeModel(); if (o && o.type === 'text') updateFontChips(o); }).catch(() => {});
    }

    const api = {
      start,
      isSaved,
      hasContent: () => allObjects().some(o => o.type !== 'text' || o.text.trim()),
      // "עצבו בשבילי": the text, font and symbols stay in the regular fields.
      leave() {
        endEdit(false);
        clearTimeout(syncTimer);
        syncToPage();
        bridge.setDesignField('');
        for (const s of SURFACES) bridge.updateDanWrap(s.danWrap, linesOf(s));
        pushHistory();
      },
      afterShow() {
        lastWidth = 0;
        fitStage();
        syncToPage();
        if (isSaved()) bridge.setDesignField(designFieldText(savedId));
      },
      nagSave() {
        toast('כדי להוסיף לסל, שמרו קודם את העיצוב');
        E.btnSave.scrollIntoView({ behavior: 'smooth', block: 'center' });
        E.btnSave.animate && E.btnSave.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 450, iterations: 2 });
      },
      debug: () => ({ state, validate, foMap, canvas, syncToPage, save, surfacePolys, SURFACES, bridge }),
    };
    return api;
  }

  // ------------------------------------------------------------------- open

  let session = null;   // { root, editor, bar, bridge }

  async function resolveSurfaces(ctx, bridge) {
    const out = [];
    const slots = new Set();
    for (const bg of ctx.bgs || []) {
      const d = resolveDef(bg.key);
      if (!d) { console.warn('[DHEditor] no settings for engrave-bg-' + bg.key); continue; }
      if (slots.has(d.slot)) continue;
      const im = await loadImage(bg.url);
      const ratioImg = (d.area.wPct * im.naturalWidth) / (d.area.hPct * im.naturalHeight);
      const ratioMm = d.areaMm.w / d.areaMm.h;
      if (Math.abs(ratioImg / ratioMm - 1) > 0.02) console.warn(`[DHEditor] engrave-bg-${bg.key}: area ratio ${ratioImg.toFixed(3)} vs ${ratioMm.toFixed(3)} mm`);
      out.push(Object.assign(d, { key: bg.key, img: { el: im, url: bg.url, w: im.naturalWidth, h: im.naturalHeight } }));
      slots.add(d.slot);
    }
    // test mode: surfaces whose fields are on the page but have no image yet
    // get a drawn stand-in
    if (ctx.test) {
      for (const key of Object.keys(SURFACE_DEFS)) {
        const d = resolveDef(key);
        if (d.extends || slots.has(d.slot) || !d.placeholder || !d.textFields.some(bridge.hasField)) continue;
        const c = d.placeholder === 'knife' ? drawKnife() : drawBoard();
        out.push(Object.assign(d, { key, img: { el: c, url: c.toDataURL('image/jpeg', 0.9), w: c.width, h: c.height } }));
        slots.add(d.slot);
      }
    }
    for (const s of out) {
      s.textFields = bridge.fieldsPresent(s.textFields);
      s.requiresText = s.textFields.some(bridge.isRequired);
    }
    const order = Object.keys(SURFACE_DEFS);
    const rank = s => ['board', 'knife'].indexOf(s.slot) >= 0 ? ['board', 'knife'].indexOf(s.slot) : order.length;
    return out.sort((a, b) => rank(a) - rank(b));
  }

  function injectCss() {
    if (document.getElementById('dhe-style')) return;
    const st = document.createElement('style');
    st.id = 'dhe-style';
    st.textContent = CSS_TEXT;
    document.head.appendChild(st);
  }

  function close() {
    if (!session) return;
    session.editor && session.editor.leave();
    session.bridge.exit();
    session.root.hidden = true;
    session.root.style.display = 'none';
    session.open = false;
    if (session.ctx && session.ctx.onExit) session.ctx.onExit();
    else if (session.ctx && session.ctx.bar) {
      session.ctx.bar.style.display = '';
      session.ctx.bar.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  async function open(ctx) {
    injectCss();
    if (session) {
      session.ctx = ctx;
      session.root.hidden = false;
      session.root.style.display = '';
      if (session.surfaces) session.bridge.enter(session.surfaces);
      session.open = true;
      if (session.editor) session.editor.afterShow();
      session.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const bridge = makeBridge();
    const root = document.createElement('div');
    root.className = 'dhe';
    root.setAttribute('dir', 'rtl');
    root.setAttribute('data-dh-editor', VERSION);
    root.innerHTML = editorHtml(!!ctx.test);
    const anchor = ctx.anchor || ctx.bar;
    anchor.parentNode.insertBefore(root, anchor.nextSibling);
    session = { root, ctx, bridge, editor: null, open: true };
    bridge.guardCart(() => session.open && session.editor && !session.editor.isSaved(), () => session.editor.nagSave());
    root.querySelector('[data-el="btnForMe"]').addEventListener('click', () => { if (!session.editor) close(); });
    root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const loading = root.querySelector('[data-el="loading"]');
    try {
      await ensureLibs();
      const SURFACES = await resolveSurfaces(ctx, bridge);
      if (!SURFACES.length) throw new Error('no surfaces');
      session.surfaces = SURFACES;
      bridge.enter(SURFACES);
      const editor = createEditor({ SURFACES, bridge, test: !!ctx.test, root, onClose: close });
      session.editor = editor;
      await editor.start();
      window.__dhe = editor.debug;
    } catch (e) {
      console.error('[DHEditor]', e);
      loading.textContent = 'העורך לא נטען. רעננו את הדף, או לחצו "עצבו בשבילי" ונעצב עבורכם.';
    }
  }

  window.DHEditor = { open, close, version: VERSION };
}());

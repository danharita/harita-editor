/* דן חריטה: עורך העיצוב. טוען קטן לתבנית "תוכן שמאל לדף מוצר".
 * 1. מסתיר מהגלריה תמונות ששמן מתחיל ב-engrave-bg- (תמונות רקע לעורך),
 *    ומסתיר תמיד את השדה הפנימי "קישור לעיצוב".
 * 2. כשיש תמונה כזאת, מסתיר את התצוגה הרגילה ומציג שני כפתורים:
 *    "רוצה לעצב לבד" (פותח את העורך) ו"עצבו בשבילי" (מחזיר את התצוגה של היום).
 *    בזמן הפיילוט זה קורה רק במצב בדיקה: פותחים את דף המוצר עם #dhtest
 *    בסוף הכתובת (ו-#dhtest-off מבטל).
 * 3. קוד העורך עצמו נטען רק בלחיצה על "רוצה לעצב לבד".
 */
(function () {
  'use strict';
  var BASE = 'https://danharita.github.io/custom-fonts/editor/';
  var VER = '202609261639';           // גרסת הטוען (לבדיקה בקונסול: DHEditorLoader)
  var LIVE = false;              // true = מוצג לכל הלקוחות
  var PREFIX = 'engrave-bg-';
  var TEST_KEY = 'dh-editor-test';
  var DESIGN_FIELD = 'קישור לעיצוב';

  function testMode() {
    var h = location.hash || '';
    try {
      if (/dhtest-off/.test(h)) localStorage.removeItem(TEST_KEY);
      else if (/dhtest/.test(h)) localStorage.setItem(TEST_KEY, '1');
      return localStorage.getItem(TEST_KEY) === '1';
    } catch (e) { return /dhtest(?!-off)/.test(h); }
  }

  var css = document.createElement('style');
  css.textContent =
    '.fotorama__nav__frame:has(img[alt^="' + PREFIX + '"]){display:none!important}' +
    '.clsCatalogElmExtraRow:has(input.clsTextChooseProduct[property_name="' + DESIGN_FIELD + '"]){display:none!important}' +
    'body.dh-hide-default .clsCatalogElmExtraRow:has(input.clsTextChooseProduct[property_name^="טקסט לחריטה"]),' +
    'body.dh-hide-default .clsCatalogElmExtraRow:has(.clsSelectChooseProduct[property_name="סוג כתב"]),' +
    'body.dh-hide-default .clsCatalogElmExtraRow:has(.clsSelectChooseProduct[property_name="סמלים לבחירה"]),' +
    'body.dh-hide-default .dan-wrap{display:none!important}' +
    '.dh-choose{direction:rtl;display:grid;gap:12px;margin:14px 0;padding:16px;border:1px solid #c8a96e;border-radius:12px;background:#fffdf7;box-sizing:border-box;width:100%;text-align:right}' +
    '.dh-choose-title{font-size:17px;font-weight:700;color:#1d1a16;margin:0;line-height:1.3}' +
    '.dh-choose-btns{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}' +
    '.dh-choose-btn{min-height:64px;padding:12px 14px;border-radius:10px;border:1px solid #c8a96e;background:#fff;color:#1d1a16;font:inherit;font-size:16px;font-weight:700;cursor:pointer;display:grid;gap:3px;line-height:1.3;text-align:center;text-transform:none}' +
    '.dh-choose-btn small{font-weight:400;font-size:13px;color:#6b645a;line-height:1.35}' +
    '.dh-choose-btn.primary{background:#8f6f33;border-color:#8f6f33;color:#fff}' +
    '.dh-choose-btn.primary small{color:rgba(255,255,255,.85)}' +
    '.dh-choose-btn:disabled{opacity:.6;cursor:default}' +
    '.dh-choose-note{font-size:14px;font-weight:700;color:#b3261e;margin:0}' +
    '.dh-start{direction:rtl;display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin:14px 0;padding:12px 16px;' +
    'border:1px solid #c8a96e;border-radius:12px;background:#fffdf7;box-sizing:border-box;width:100%}' +
    '.dh-start-text{flex:1 1 200px;display:grid;gap:2px;font-size:14px;line-height:1.35;color:#5d4a26}' +
    '.dh-start-text strong{font-size:16px;color:#1d1a16}' +
    '.dh-start-btn{min-height:44px;padding:0 18px;border:0;border-radius:10px;background:#8f6f33;color:#fff;font:inherit;' +
    'font-size:16px;font-weight:700;cursor:pointer;line-height:1.2;text-transform:none}' +
    '.dh-start-btn:disabled{opacity:.6;cursor:default}';
  document.head.appendChild(css);

  // Reads the gallery (Fotorama) once it is ready and takes the engrave-bg
  // images out of it. Falls back to plain <img> tags.
  function findBgs(done) {
    var tries = 0;
    (function poll() {
      var $ = window.jQuery;
      var el = document.querySelector('.fotorama');
      var api = $ && el && $(el).data('fotorama');
      if (api && api.data) {
        var out = [];
        for (var i = api.data.length - 1; i >= 0; i--) {
          var d = api.data[i];
          var name = String(d.alt || d.caption || d.title || '').trim();
          if (name.indexOf(PREFIX) !== 0) continue;
          out.unshift({ key: name.slice(PREFIX.length).trim(), url: new URL(d.full || d.img, location.href).href });
          try { if (api.data.length > 1) api.splice(i, 1); } catch (e) { /* the CSS rule still hides the thumbnail */ }
        }
        return done(out);
      }
      if (++tries < 60) return setTimeout(poll, 250);
      var seen = {}, res = [];
      var imgs = document.querySelectorAll('img[alt^="' + PREFIX + '"],img[title^="' + PREFIX + '"]');
      for (var j = 0; j < imgs.length; j++) {
        var n = (imgs[j].getAttribute('alt') || imgs[j].getAttribute('title') || '').trim();
        var key = n.slice(PREFIX.length).trim();
        if (!seen[key]) { seen[key] = 1; res.push({ key: key, url: new URL(imgs[j].getAttribute('src'), location.href).href }); }
      }
      done(res);
    })();
  }

  // Where the chooser goes: the existing preview box if visible, else the
  // first engraving text field, else the font row.
  function findAnchor() {
    var form = document.querySelector('.cssFrmCatalog_ProductPage.clsSB_Product_Form') || document.getElementById('FrmCatalog');
    if (!form) return null;
    var wraps = form.querySelectorAll('.dan-wrap');
    for (var i = 0; i < wraps.length; i++) if (wraps[i].style.display !== 'none' && wraps[i].offsetParent !== null) return wraps[i];
    var inputs = form.querySelectorAll('input.clsTextChooseProduct');
    for (var j = 0; j < inputs.length; j++) {
      if ((inputs[j].getAttribute('property_name') || '').indexOf('טקסט לחריטה') === 0) return inputs[j].closest('.clsCatalogElmExtraRow');
    }
    var sel = form.querySelector('select.clsSelectChooseProduct[property_name="סוג כתב"]');
    return sel ? sel.closest('.clsCatalogElmExtraRow') : null;
  }

  function start(bgs) {
    if (!bgs.length) return;
    var test = testMode();
    if (!LIVE && !test) return;
    var anchor = findAnchor();
    if (!anchor || document.querySelector('.dh-choose')) return;
    var mode = '';

    var chooser = document.createElement('div');
    chooser.className = 'dh-choose';
    chooser.innerHTML = '<p class="dh-choose-title">איך תרצו לעצב את החריטה?</p>' +
      '<div class="dh-choose-btns">' +
      '<button type="button" class="dh-choose-btn primary" data-dh="self">עיצוב לבד' +
      '<small>רואים את החריטה על המוצר ומסדרים הכול, ישר מהנייד</small></button>' +
      '<button type="button" class="dh-choose-btn" data-dh="us">עצבו בשבילי' +
      '<small>כותבים את הטקסט, ואנחנו נכין סקיצה לאישור</small></button>' +
      '</div><p class="dh-choose-note" hidden>כדי להמשיך, בחרו קודם איך לעצב את החריטה</p>';
    anchor.parentNode.insertBefore(chooser, anchor);
    var note = chooser.querySelector('.dh-choose-note');

    var bar = document.createElement('div');
    bar.className = 'dh-start';
    bar.innerHTML = '<div class="dh-start-text"><strong>רוצה לעצב לבד?</strong>' +
      '<span>רואים את החריטה על המוצר ומסדרים הכול בעצמכם.</span></div>' +
      '<button type="button" class="dh-start-btn">רוצה לעצב לבד</button>';
    chooser.parentNode.insertBefore(bar, chooser.nextSibling);

    function setMode(m) {
      mode = m;
      document.body.classList.toggle('dh-hide-default', m !== 'default');
      chooser.style.display = m === 'choose' ? '' : 'none';
      bar.style.display = m === 'default' ? '' : 'none';
      if (m !== 'choose') note.hidden = true;
    }
    setMode('choose');

    var ctx = {
      bgs: bgs, test: test, anchor: bar,
      onExit: function () {
        setMode('default');
        bar.scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
    };

    function openEditor(btn, labelEl) {
      if (window.DHEditor) { setMode('editor'); return window.DHEditor.open(ctx); }
      btn.disabled = true;
      var old = labelEl ? labelEl.textContent : '';
      if (labelEl) labelEl.textContent = 'טוען את העורך…';
      var s = document.createElement('script');
      s.src = BASE + 'editor.js';
      s.onload = function () {
        btn.disabled = false;
        if (labelEl) labelEl.textContent = old;
        setMode('editor');
        window.DHEditor.open(ctx);
      };
      s.onerror = function () {
        btn.disabled = false;
        if (labelEl) labelEl.textContent = 'העורך לא נטען. בדקו את החיבור ונסו שוב, או בחרו "עצבו בשבילי".';
        s.remove();
      };
      document.head.appendChild(s);
    }

    var btnSelf = chooser.querySelector('[data-dh="self"]');
    btnSelf.addEventListener('click', function () { openEditor(btnSelf, btnSelf.querySelector('small')); });
    chooser.querySelector('[data-dh="us"]').addEventListener('click', function () { setMode('default'); });
    var startBtn = bar.querySelector('.dh-start-btn');
    startBtn.addEventListener('click', function () { openEditor(startBtn, bar.querySelector('.dh-start-text span')); });

    // Before a choice is made, add-to-cart asks the customer to choose.
    document.addEventListener('click', function (e) {
      if (mode !== 'choose') return;
      var a = e.target && e.target.closest && e.target.closest('#BtnAddToBasket_Anchor, .CSS_BtnAddToBasket_Anchor');
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      note.hidden = false;
      chooser.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, true);
  }

  window.DHEditorLoader = VER;
  function go() { findBgs(start); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
}());

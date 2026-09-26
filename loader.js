/* דן חריטה: עורך העיצוב. טוען קטן לתבנית "תוכן שמאל לדף מוצר".
 * 1. מסתיר מהגלריה תמונות ששמן מתחיל ב-engrave-bg- (תמונות רקע לעורך).
 * 2. כשיש תמונה כזאת, מוסיף מעל שדות הטקסט את הכפתור "רוצה לעצב לבד".
 *    בזמן הפיילוט הכפתור מופיע רק במצב בדיקה: פותחים את דף המוצר עם #dhtest
 *    בסוף הכתובת (ו-#dhtest-off מבטל).
 * 3. קוד העורך עצמו נטען רק בלחיצה על הכפתור.
 */
(function () {
  'use strict';
  var BASE = 'https://danharita.github.io/custom-fonts/editor/';
  var VER = '202609261515';           // גרסת הטוען (לבדיקה בקונסול: DHEditorLoader)
  var LIVE = false;              // true = הכפתור מופיע לכל הלקוחות
  var PREFIX = 'engrave-bg-';
  var TEST_KEY = 'dh-editor-test';

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
    '.dh-start{direction:rtl;display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin:14px 0;padding:14px 16px;' +
    'border:1px solid #c8a96e;border-radius:12px;background:#fffdf7;box-sizing:border-box;width:100%}' +
    '.dh-start-text{flex:1 1 220px;display:grid;gap:2px;font-size:15px;line-height:1.35;color:#5d4a26}' +
    '.dh-start-text strong{font-size:17px;color:#1d1a16}' +
    '.dh-start-btn{min-height:46px;padding:0 20px;border:0;border-radius:10px;background:#8f6f33;color:#fff;font:inherit;' +
    'font-size:17px;font-weight:700;cursor:pointer;line-height:1.2}' +
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

  // Above the engraving text: the existing preview box, else the first
  // engraving text field, else the font row.
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
    if (!anchor || document.querySelector('.dh-start')) return;
    var bar = document.createElement('div');
    bar.className = 'dh-start';
    bar.innerHTML = '<div class="dh-start-text"><strong>רוצה לעצב לבד?</strong>' +
      '<span>כותבים, בוחרים גופן וסמל, ורואים את החריטה על המוצר.</span></div>' +
      '<button type="button" class="dh-start-btn">רוצה לעצב לבד</button>';
    anchor.parentNode.insertBefore(bar, anchor);
    var btn = bar.querySelector('button');
    btn.addEventListener('click', function () {
      var ctx = { bgs: bgs, bar: bar, test: test };
      if (window.DHEditor) return window.DHEditor.open(ctx);
      btn.disabled = true;
      btn.textContent = 'טוען…';
      var s = document.createElement('script');
      s.src = BASE + 'editor.js';
      s.onload = function () { btn.disabled = false; btn.textContent = 'רוצה לעצב לבד'; window.DHEditor.open(ctx); };
      s.onerror = function () {
        btn.disabled = false;
        btn.textContent = 'רוצה לעצב לבד';
        bar.querySelector('span').textContent = 'העורך לא נטען. בדקו את החיבור ונסו שוב.';
        s.remove();
      };
      document.head.appendChild(s);
    });
  }

  window.DHEditorLoader = VER;
  function go() { findBgs(start); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
}());

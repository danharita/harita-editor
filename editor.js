/* Dan Harita design editor 202609301647 */
/*
 * EngraveEngine — turns text and symbols into engraving outlines (mm),
 * and writes DXF (R12) and SVG. The same outlines drive the on-screen
 * preview, so what the customer sees is exactly what gets engraved.
 *
 * Coordinates: millimetres, Y pointing down, origin = top-left of the
 * engraving area. The DXF writer flips Y and moves the origin.
 *
 * Dependencies (passed to init): opentype.js, bidi-js factory, clipper-lib.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EngraveEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let opentype = null, bidi = null, ClipperLib = null;
  const fonts = {};
  const TOL = 0.02;       // max deviation when flattening curves (mm)
  const SCALE = 10000;    // Clipper works in integers: 1 unit = 0.0001 mm

  // Niqqud / cantillation, emoji, variation selectors and joiners are not engraved.
  const FORBIDDEN_RE = /[֑-ׇ]|[\u{1F000}-\u{1FAFF}]|[☀-➿]|[️‍]/u;
  // Invisible direction marks that come in with copy/paste — removed silently.
  const BIDI_CTRL_RE = /[‎‏‪-‮⁦-⁩]/g;
  const RTL_RE = /[֐-׿יִ-ﭏ؀-ۿ]/;
  const LTR_RE = /[A-Za-zÀ-ɏ]/;

  function init(deps) {
    opentype = deps.opentype;
    bidi = deps.bidiFactory();
    ClipperLib = deps.ClipperLib;
  }

  // Some fonts ship a GDEF table opentype.js can't read ("ClassDef format
  // must be 1 or 2"). GDEF only holds glyph classes for GPOS/GSUB, so on a
  // parse error the table is renamed in the font directory and parsing is
  // retried without it.
  function hideTable(buf, tag) {
    const copy = buf.slice(0);
    const v = new DataView(copy);
    const n = v.getUint16(4);
    for (let i = 0; i < n; i++) {
      const at = 12 + i * 16;
      const t = String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
      if (t === tag) { for (let j = 0; j < 4; j++) v.setUint8(at + j, 'xxxx'.charCodeAt(j)); return copy; }
    }
    return null;
  }

  function loadFont(id, arrayBuffer) {
    try {
      fonts[id] = opentype.parse(arrayBuffer);
    } catch (e) {
      const patched = hideTable(arrayBuffer, 'GDEF');
      if (!patched) throw e;
      fonts[id] = opentype.parse(patched);
    }
    return fonts[id];
  }

  function hasFont(id) { return !!fonts[id]; }

  function getFont(id) {
    const f = fonts[id];
    if (!f) throw new Error('Font not loaded: ' + id);
    return f;
  }

  // ---------------------------------------------------------------- text checks

  function checkChars(text, font) {
    const missing = new Set(), forbidden = new Set();
    for (const ch of text) {
      if (ch === '\n') continue;
      if (FORBIDDEN_RE.test(ch)) { forbidden.add(ch); continue; }
      if (ch === ' ') continue;
      if (font.charToGlyphIndex(ch) === 0) missing.add(ch);
    }
    return { missing: [...missing], forbidden: [...forbidden] };
  }

  function cleanText(text) {
    return String(text || '')
      .normalize('NFC')
      .replace(/\r/g, '')
      .replace(BIDI_CTRL_RE, '');
  }

  function stripForbidden(text) {
    return [...text].filter(ch => !FORBIDDEN_RE.test(ch)).join('');
  }

  // First strong character decides the line direction (same rule as
  // CSS `unicode-bidi: plaintext`, which the text box uses). Lines with no
  // letters at all (only digits) fall back to right-to-left.
  function baseDir(line) {
    for (const ch of line) {
      if (RTL_RE.test(ch)) return 'rtl';
      if (LTR_RE.test(ch)) return 'ltr';
    }
    return 'rtl';
  }

  // Returns the line as visual runs (left to right on screen), each run
  // tagged with its direction. Mirrored characters such as ( ) are swapped.
  function visualRuns(line) {
    const dir = baseDir(line);
    const emb = bidi.getEmbeddingLevels(line, dir);
    const levels = emb.levels;
    const chars = line.split('');
    bidi.getMirroredCharactersMap(line, levels).forEach((c, i) => { chars[i] = c; });
    const order = chars.map((_, i) => i);
    bidi.getReorderSegments(line, emb).forEach(([s, e]) => {
      const part = order.slice(s, e + 1).reverse();
      order.splice(s, e - s + 1, ...part);
    });
    const runs = [];
    for (const idx of order) {
      const rtl = (levels[idx] & 1) === 1;
      const last = runs[runs.length - 1];
      if (last && last.rtl === rtl) last.text += chars[idx];
      else runs.push({ rtl, text: chars[idx] });
    }
    return runs;
  }

  // ------------------------------------------------------------- curve flattening

  // Wang's formula: number of equal parameter steps that keeps a Bezier
  // within `tol` of its chords.
  function wangSteps(pts, deg, tol) {
    let m = 0;
    for (let i = 0; i + 2 < pts.length; i++) {
      const ddx = pts[i + 2][0] - 2 * pts[i + 1][0] + pts[i][0];
      const ddy = pts[i + 2][1] - 2 * pts[i + 1][1] + pts[i][1];
      m = Math.max(m, Math.hypot(ddx, ddy));
    }
    return Math.max(1, Math.min(256, Math.ceil(Math.sqrt(deg * (deg - 1) * m / (8 * tol)))));
  }

  function flattenCommands(cmds, tol) {
    const polys = [];
    let cur = null, sx = 0, sy = 0, px = 0, py = 0;
    const close = () => { if (cur && cur.length > 2) polys.push(cur); cur = null; };
    for (const c of cmds) {
      switch (c.type) {
        case 'M':
          close();
          cur = [[c.x, c.y]]; sx = px = c.x; sy = py = c.y;
          break;
        case 'L':
          if (!cur) cur = [[px, py]];
          cur.push([c.x, c.y]); px = c.x; py = c.y;
          break;
        case 'Q': {
          if (!cur) cur = [[px, py]];
          const n = wangSteps([[px, py], [c.x1, c.y1], [c.x, c.y]], 2, tol);
          for (let i = 1; i <= n; i++) {
            const t = i / n, u = 1 - t;
            cur.push([u * u * px + 2 * u * t * c.x1 + t * t * c.x,
                      u * u * py + 2 * u * t * c.y1 + t * t * c.y]);
          }
          px = c.x; py = c.y;
          break;
        }
        case 'C': {
          if (!cur) cur = [[px, py]];
          const n = wangSteps([[px, py], [c.x1, c.y1], [c.x2, c.y2], [c.x, c.y]], 3, tol);
          for (let i = 1; i <= n; i++) {
            const t = i / n, u = 1 - t;
            cur.push([u * u * u * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
                      u * u * u * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y]);
          }
          px = c.x; py = c.y;
          break;
        }
        case 'Z':
          close(); px = sx; py = sy;
          break;
      }
    }
    close();
    // drop a repeated closing point
    for (const p of polys) {
      const a = p[0], b = p[p.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) p.pop();
    }
    return polys;
  }

  // ------------------------------------------------------------------ geometry

  function toClipper(polys) {
    return polys.map(p => p.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
  }

  function fromClipper(paths) {
    return paths.map(p => p.map(pt => [pt.X / SCALE, pt.Y / SCALE]));
  }

  // Merges overlapping shapes into clean outlines (outer contours + holes,
  // no overlaps), so the laser's fill never leaves gaps where shapes cross.
  function union(polys, fillRule) {
    if (!polys.length) return [];
    const c = new ClipperLib.Clipper();
    c.AddPaths(toClipper(polys), ClipperLib.PolyType.ptSubject, true);
    const sol = new ClipperLib.Paths();
    const ft = fillRule === 'evenodd' ? ClipperLib.PolyFillType.pftEvenOdd : ClipperLib.PolyFillType.pftNonZero;
    c.Execute(ClipperLib.ClipType.ctUnion, sol, ft, ft);
    const cleaned = ClipperLib.Clipper.CleanPolygons(sol, 0.001 * SCALE);
    return fromClipper(cleaned).filter(p => p.length > 2);
  }

  function translate(polys, dx, dy) {
    return polys.map(p => p.map(([x, y]) => [x + dx, y + dy]));
  }

  function scalePolys(polys, s) {
    return polys.map(p => p.map(([x, y]) => [x * s, y * s]));
  }

  function bbox(polys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of polys) for (const [x, y] of p) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x0 === Infinity) return null;
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }

  function polysToPathD(polys, digits) {
    const d = digits == null ? 3 : digits;
    return polys.map(p => 'M' + p.map(([x, y]) => x.toFixed(d) + ' ' + y.toFixed(d)).join('L') + 'Z').join('');
  }

  // ---------------------------------------------------------------------- text

  function letterHeight(font, sizeMm) {
    for (const ch of ['ה', 'H', 'ם', 'E']) {
      const gi = font.charToGlyphIndex(ch);
      if (gi) {
        const b = font.glyphs.get(gi).getBoundingBox();
        if (b && b.y2 > b.y1) return (b.y2 - Math.max(0, b.y1)) / font.unitsPerEm * sizeMm;
      }
    }
    return 0.7 * sizeMm;
  }

  /**
   * Lays out a text box. Returns outlines centred on (0,0) — the layout
   * centre, which stays put while the customer types.
   * opts: { text, fontId, sizeMm, align: 'right'|'center'|'left', lineSpacing }
   */
  function layoutText(opts) {
    const font = getFont(opts.fontId);
    const size = opts.sizeMm;
    const ls = opts.lineSpacing || 1.15;
    const align = opts.align || 'center';
    const raw = cleanText(opts.text);
    const chk = checkChars(raw, font);
    const text = stripForbidden(raw);
    const lines = text.split('\n');
    const lh = size * ls;
    const asc = font.ascender / font.unitsPerEm * size;
    const desc = font.descender / font.unitsPerEm * size; // negative

    const laid = lines.map(line => {
      let x = 0;
      const parts = [];
      if (line.length) {
        for (const r of visualRuns(line)) {
          const o = { kerning: !r.rtl, features: { liga: !r.rtl, rlig: !r.rtl } };
          parts.push({ path: font.getPath(r.text, x, 0, size, o) });
          x += font.getAdvanceWidth(r.text, size, o);
        }
      }
      return { parts, width: x };
    });

    const maxW = laid.reduce((m, l) => Math.max(m, l.width), 0);
    const top = -asc;
    const bottom = (lines.length - 1) * lh - desc;
    const yShift = -(top + bottom) / 2;

    let polys = [];
    laid.forEach((l, i) => {
      const dx = align === 'center' ? -l.width / 2 : align === 'right' ? maxW / 2 - l.width : -maxW / 2;
      const dy = i * lh + yShift;
      for (const part of l.parts) {
        const fl = flattenCommands(part.path.commands, TOL);
        for (const poly of fl) polys.push(poly.map(([x, y]) => [x + dx, y + dy]));
      }
    });
    polys = union(polys, 'nonzero');

    return {
      polys,
      ink: bbox(polys),
      layoutW: maxW,
      layoutH: bottom - top,
      lines: lines.length,
      missing: chk.missing,
      forbidden: chk.forbidden,
      letterHeightMm: letterHeight(font, size),
    };
  }

  // ------------------------------------------------------------------- symbols

  // Parses an SVG path `d` string into absolute M/L/C/Q/Z commands.
  // Supports M L H V C S Q T A Z, absolute and relative.
  function parsePathD(d) {
    const tokens = String(d).match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
    const out = [];
    let i = 0, cmd = null, x = 0, y = 0, sx = 0, sy = 0, lcx = null, lcy = null, lqx = null, lqy = null;
    const num = () => parseFloat(tokens[i++]);
    const isCmd = t => /^[A-Za-z]$/.test(t);
    while (i < tokens.length) {
      if (isCmd(tokens[i])) cmd = tokens[i++];
      else if (cmd === null) throw new Error('Bad path data');
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      if (C !== 'C' && C !== 'S') { lcx = lcy = null; }
      if (C !== 'Q' && C !== 'T') { lqx = lqy = null; }
      switch (C) {
        case 'M': {
          let nx = num(), ny = num();
          if (rel) { nx += x; ny += y; }
          x = sx = nx; y = sy = ny;
          out.push({ type: 'M', x, y });
          cmd = rel ? 'l' : 'L';
          break;
        }
        case 'L': {
          let nx = num(), ny = num();
          if (rel) { nx += x; ny += y; }
          x = nx; y = ny; out.push({ type: 'L', x, y });
          break;
        }
        case 'H': { let nx = num(); if (rel) nx += x; x = nx; out.push({ type: 'L', x, y }); break; }
        case 'V': { let ny = num(); if (rel) ny += y; y = ny; out.push({ type: 'L', x, y }); break; }
        case 'C': {
          let x1 = num(), y1 = num(), x2 = num(), y2 = num(), nx = num(), ny = num();
          if (rel) { x1 += x; y1 += y; x2 += x; y2 += y; nx += x; ny += y; }
          out.push({ type: 'C', x1, y1, x2, y2, x: nx, y: ny });
          lcx = x2; lcy = y2; x = nx; y = ny;
          break;
        }
        case 'S': {
          let x2 = num(), y2 = num(), nx = num(), ny = num();
          if (rel) { x2 += x; y2 += y; nx += x; ny += y; }
          const x1 = lcx === null ? x : 2 * x - lcx, y1 = lcy === null ? y : 2 * y - lcy;
          out.push({ type: 'C', x1, y1, x2, y2, x: nx, y: ny });
          lcx = x2; lcy = y2; x = nx; y = ny;
          break;
        }
        case 'Q': {
          let x1 = num(), y1 = num(), nx = num(), ny = num();
          if (rel) { x1 += x; y1 += y; nx += x; ny += y; }
          out.push({ type: 'Q', x1, y1, x: nx, y: ny });
          lqx = x1; lqy = y1; x = nx; y = ny;
          break;
        }
        case 'T': {
          let nx = num(), ny = num();
          if (rel) { nx += x; ny += y; }
          const x1 = lqx === null ? x : 2 * x - lqx, y1 = lqy === null ? y : 2 * y - lqy;
          out.push({ type: 'Q', x1, y1, x: nx, y: ny });
          lqx = x1; lqy = y1; x = nx; y = ny;
          break;
        }
        case 'A': {
          const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
          let nx = num(), ny = num();
          if (rel) { nx += x; ny += y; }
          for (const c of arcToCubics(x, y, rx, ry, rot, large, sweep, nx, ny)) out.push(c);
          x = nx; y = ny;
          break;
        }
        case 'Z':
          out.push({ type: 'Z' }); x = sx; y = sy;
          break;
        default:
          throw new Error('Unsupported path command ' + cmd);
      }
    }
    return out;
  }

  // SVG elliptical arc -> cubic Beziers (SVG spec, appendix F.6).
  function arcToCubics(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
    if (rx === 0 || ry === 0) return [{ type: 'L', x: x2, y: y2 }];
    rx = Math.abs(rx); ry = Math.abs(ry);
    const phi = phiDeg * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
    let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let co = Math.sqrt(Math.max(0, num / den));
    if (fa === fs) co = -co;
    const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => {
      const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      return a;
    };
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!fs && dt > 0) dt -= 2 * Math.PI;
    if (fs && dt < 0) dt += 2 * Math.PI;
    const segs = Math.ceil(Math.abs(dt) / (Math.PI / 2));
    const out = [];
    const step = dt / segs, k = 4 / 3 * Math.tan(step / 4);
    let t = t1;
    const pt = (tt) => [cx + rx * Math.cos(tt) * cos - ry * Math.sin(tt) * sin,
                        cy + rx * Math.cos(tt) * sin + ry * Math.sin(tt) * cos];
    const der = (tt) => [-rx * Math.sin(tt) * cos - ry * Math.cos(tt) * sin,
                         -rx * Math.sin(tt) * sin + ry * Math.cos(tt) * cos];
    for (let i = 0; i < segs; i++) {
      const ta = t, tb = t + step;
      const pa = pt(ta), pb = pt(tb), da = der(ta), db = der(tb);
      out.push({ type: 'C',
        x1: pa[0] + k * da[0], y1: pa[1] + k * da[1],
        x2: pb[0] - k * db[0], y2: pb[1] - k * db[1],
        x: pb[0], y: pb[1] });
      t = tb;
    }
    // land exactly on the end point
    const last = out[out.length - 1]; last.x = x2; last.y = y2;
    return out;
  }

  /**
   * Symbol outlines, scaled to widthMm and centred on (0,0).
   * sym: { d: string | string[], fillRule?: 'nonzero'|'evenodd' }
   */
  function layoutSymbol(sym, widthMm) {
    const ds = Array.isArray(sym.d) ? sym.d : [sym.d];
    let polys = [];
    // each sub-path is merged on its own first, so its own fill rule applies
    for (const d of ds) {
      const fl = flattenCommands(parsePathD(d), 0.05);
      polys.push(...union(fl, sym.fillRule || 'nonzero'));
    }
    polys = union(polys, 'nonzero');
    const b = bbox(polys);
    if (!b || b.w === 0) return { polys: [], ink: null };
    // flatten again at the final scale for accurate curves
    const s = widthMm / b.w;
    let fine = [];
    for (const d of ds) {
      const cmds = parsePathD(d).map(c => {
        const o = { type: c.type };
        for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) if (k in c) o[k] = (c[k] - (k[0] === 'x' ? b.cx : b.cy)) * s;
        return o;
      });
      fine.push(...union(flattenCommands(cmds, TOL), sym.fillRule || 'nonzero'));
    }
    fine = union(fine, 'nonzero');
    return { polys: fine, ink: bbox(fine) };
  }

  // ----------------------------------------------------------------- writers

  function areaOutline(area) {
    if (area.shape === 'ellipse') {
      const n = 180, pts = [];
      for (let i = 0; i < n; i++) {
        const a = 2 * Math.PI * i / n;
        pts.push([area.w / 2 + area.w / 2 * Math.cos(a), area.h / 2 + area.h / 2 * Math.sin(a)]);
      }
      return pts;
    }
    return [[0, 0], [area.w, 0], [area.w, area.h], [0, area.h]];
  }

  /**
   * DXF R12, millimetres. Each outline is a closed POLYLINE on layer ENGRAVE.
   * opt.origin: 'center' (0,0 = centre of the area) or 'corner'
   * (0,0 = bottom-left corner of the area). opt.guide adds the area outline
   * on layer GUIDE (hide it before engraving).
   */
  function toDXF(polys, area, opt) {
    const o = opt || {};
    const center = o.origin !== 'corner';
    const tx = x => center ? x - area.w / 2 : x;
    const ty = y => center ? area.h / 2 - y : area.h - y;
    const L = [];
    const w = (code, val) => { L.push(String(code)); L.push(String(val)); };
    const f = v => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4);

    const all = polys.slice();
    if (o.guide) all.push(areaOutline(area));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of all) for (const [x, y] of p) {
      const X = tx(x), Y = ty(y);
      x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
    }
    if (x0 === Infinity) { x0 = y0 = x1 = y1 = 0; }

    w(0, 'SECTION'); w(2, 'HEADER');
    w(9, '$ACADVER'); w(1, 'AC1009');
    w(9, '$INSUNITS'); w(70, 4);
    w(9, '$MEASUREMENT'); w(70, 1);
    w(9, '$EXTMIN'); w(10, f(x0)); w(20, f(y0)); w(30, f(0));
    w(9, '$EXTMAX'); w(10, f(x1)); w(20, f(y1)); w(30, f(0));
    w(0, 'ENDSEC');

    w(0, 'SECTION'); w(2, 'TABLES');
    w(0, 'TABLE'); w(2, 'LTYPE'); w(70, 1);
    w(0, 'LTYPE'); w(2, 'CONTINUOUS'); w(70, 0); w(3, 'Solid line'); w(72, 65); w(73, 0); w(40, f(0));
    w(0, 'ENDTAB');
    w(0, 'TABLE'); w(2, 'LAYER'); w(70, o.guide ? 2 : 1);
    w(0, 'LAYER'); w(2, 'ENGRAVE'); w(70, 0); w(62, 7); w(6, 'CONTINUOUS');
    if (o.guide) { w(0, 'LAYER'); w(2, 'GUIDE'); w(70, 0); w(62, 1); w(6, 'CONTINUOUS'); }
    w(0, 'ENDTAB');
    w(0, 'ENDSEC');

    const poly = (pts, layer, color) => {
      w(0, 'POLYLINE'); w(8, layer); w(62, color); w(66, 1);
      w(10, f(0)); w(20, f(0)); w(30, f(0)); w(70, 1);
      for (const [x, y] of pts) {
        w(0, 'VERTEX'); w(8, layer); w(10, f(tx(x))); w(20, f(ty(y))); w(30, f(0));
      }
      w(0, 'SEQEND'); w(8, layer);
    };

    w(0, 'SECTION'); w(2, 'ENTITIES');
    for (const p of polys) poly(p, 'ENGRAVE', 7);
    if (o.guide) poly(areaOutline(area), 'GUIDE', 1);
    w(0, 'ENDSEC');
    w(0, 'EOF');
    return L.join('\r\n') + '\r\n';
  }

  /** SVG in millimetres. Origin is always the top-left of the area. */
  function toSVG(polys, area, opt) {
    const o = opt || {};
    const d = polysToPathD(polys, 4);
    let guide = '';
    if (o.guide) {
      guide = area.shape === 'ellipse'
        ? `<ellipse cx="${area.w / 2}" cy="${area.h / 2}" rx="${area.w / 2}" ry="${area.h / 2}"/>`
        : `<rect x="0" y="0" width="${area.w}" height="${area.h}"/>`;
      guide = `\n  <g id="GUIDE" fill="none" stroke="#ff0000" stroke-width="0.1">${guide}</g>`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${area.w}mm" height="${area.h}mm" viewBox="0 0 ${area.w} ${area.h}">
  <g id="ENGRAVE"><path d="${d}" fill="#000000" fill-rule="evenodd"/></g>${guide}
</svg>
`;
  }

  return {
    init, loadFont, hasFont, getFont, layoutText, layoutSymbol, union, translate, scalePolys,
    bbox, polysToPathD, toDXF, toSVG, parsePathD, flattenCommands, visualRuns, checkChars,
    cleanText, baseDir,
  };
}));

// Engraving symbols for the editor. Converted from Dan's DXF vector files
// (POLYLINE + bulge arcs -> tessellated SVG paths, normalised to a 100-unit
// box, Y-flipped, centred). Each shape uses even-odd fill so inner contours
// read as holes. label = the exact "סמלים לבחירה" option name on the site.
(function (root) {
  const SYMBOLS = [
    { id: 'heart_hollow', label: 'לב חלול רגיל', defaultWidthMm: 25, fillRule: 'evenodd',
      d: 'M85.42 44.13 L86.18 41.40 L86.55 38.58 L86.54 35.89 L86.21 33.22 L85.56 30.60 L84.68 28.37 L83.52 26.27 L82.08 24.35 L80.39 22.65 L78.46 21.21 L76.34 20.07 L73.94 19.20 L71.44 18.67 L68.89 18.49 L66.46 18.68 L64.08 19.24 L61.30 20.34 L58.69 21.79 L56.37 23.49 L54.27 25.44 L52.76 27.26 L51.53 29.27 L51.42 29.45 L51.28 29.62 L51.13 29.77 L50.96 29.90 L50.78 30.01 L50.59 30.10 L50.38 30.17 L50.17 30.20 L49.96 30.22 L49.74 30.20 L49.53 30.17 L49.33 30.10 L49.13 30.01 L48.95 29.90 L48.78 29.77 L48.63 29.62 L48.49 29.45 L48.38 29.27 L47.15 27.26 L45.64 25.44 L43.54 23.49 L41.22 21.79 L38.61 20.34 L35.83 19.24 L33.45 18.68 L31.02 18.49 L28.47 18.67 L25.97 19.20 L23.57 20.07 L21.45 21.21 L19.53 22.65 L17.83 24.35 L16.39 26.27 L15.23 28.37 L14.35 30.60 L13.70 33.22 L13.37 35.89 L13.36 38.58 L13.73 41.40 L14.49 44.13 L16.00 47.74 L17.88 51.17 L19.77 54.01 L21.85 56.71 L24.84 60.15 L28.00 63.45 L31.96 67.19 L36.10 70.73 L42.95 76.17 L49.95 81.43 L52.92 79.24 L55.87 77.04 L57.77 75.60 L59.65 74.14 L63.16 71.29 L66.61 68.36 L69.29 65.94 L71.89 63.44 L75.05 60.15 L78.05 56.70 L80.13 54.00 L82.02 51.17 L83.91 47.74 L85.42 44.13 Z M47.47 16.32 L48.80 17.82 L50.00 19.42 L51.20 17.82 L52.53 16.32 L55.51 13.54 L58.81 11.13 L62.55 9.05 L66.54 7.48 L70.13 6.62 L73.80 6.34 L77.57 6.60 L81.26 7.39 L84.80 8.68 L87.98 10.39 L90.88 12.55 L93.42 15.11 L95.55 17.95 L97.28 21.06 L98.57 24.36 L99.51 28.12 L99.99 31.97 L100.00 35.84 L99.46 39.94 L98.35 43.92 L96.29 48.86 L93.71 53.54 L91.18 57.32 L88.40 60.93 L84.51 65.42 L80.39 69.70 L77.03 72.93 L73.57 76.05 L69.16 79.80 L64.67 83.44 L62.26 85.31 L59.84 87.16 L55.45 90.42 L51.04 93.66 L50.86 93.78 L50.66 93.87 L50.44 93.94 L50.22 93.98 L50.00 94.00 L49.78 93.99 L49.56 93.94 L49.35 93.88 L49.15 93.78 L48.96 93.66 L44.65 90.51 L40.36 87.33 L37.81 85.40 L35.30 83.44 L30.81 79.81 L26.41 76.07 L22.94 72.94 L19.57 69.70 L15.47 65.42 L11.58 60.93 L8.80 57.33 L6.28 53.54 L3.70 48.86 L1.64 43.93 L0.53 39.94 L0.00 35.84 L0.01 31.97 L0.49 28.12 L1.43 24.36 L2.72 21.06 L4.45 17.95 L6.58 15.11 L9.12 12.55 L12.02 10.39 L15.20 8.68 L18.74 7.39 L22.43 6.60 L26.20 6.34 L29.87 6.62 L33.46 7.48 L37.45 9.05 L41.19 11.13 L44.49 13.54 L47.47 16.32 Z' },
    { id: 'heart_fancy', label: 'לב חלול מעוצב', defaultWidthMm: 26, fillRule: 'evenodd',
      d: 'M49.68 96.15 L49.41 94.91 L48.95 93.35 L48.37 91.68 L47.73 90.10 L46.75 88.05 L45.63 86.03 L44.37 84.05 L42.98 82.09 L41.46 80.17 L39.79 78.28 L37.99 76.42 L36.06 74.59 L34.20 72.98 L32.16 71.35 L29.66 69.49 L26.41 67.19 L21.07 63.35 L18.92 61.71 L17.05 60.19 L15.40 58.76 L13.91 57.36 L12.53 55.95 L11.21 54.48 L9.43 52.34 L7.98 50.42 L6.73 48.54 L5.55 46.52 L4.22 44.24 L3.47 43.00 L2.79 41.72 L2.17 40.42 L1.63 39.08 L1.16 37.72 L0.75 36.34 L0.42 34.93 L0.16 33.50 L0.04 32.04 L0.00 30.11 L0.04 28.16 L0.17 26.67 L0.41 25.28 L0.73 23.92 L1.13 22.58 L1.59 21.28 L2.12 20.00 L2.73 18.77 L3.39 17.57 L4.13 16.41 L4.92 15.29 L5.77 14.22 L6.69 13.20 L7.66 12.23 L8.69 11.31 L9.77 10.45 L10.90 9.65 L12.08 8.90 L14.06 7.85 L16.12 6.98 L18.24 6.28 L20.42 5.77 L22.63 5.44 L24.87 5.29 L27.11 5.34 L29.35 5.57 L31.43 5.97 L33.51 6.53 L35.57 7.26 L37.60 8.14 L39.59 9.17 L41.54 10.36 L43.42 11.69 L45.25 13.15 L47.33 15.09 L49.17 17.02 L49.56 17.47 L49.75 17.21 L50.59 16.13 L51.56 15.01 L52.65 13.87 L53.81 12.72 L55.03 11.61 L56.28 10.54 L57.54 9.55 L58.78 8.66 L60.23 7.73 L61.72 6.88 L63.25 6.12 L64.81 5.45 L66.40 4.87 L68.02 4.37 L69.68 3.97 L71.35 3.66 L73.03 3.52 L75.26 3.49 L77.51 3.55 L79.24 3.70 L81.14 4.07 L82.94 4.54 L84.65 5.13 L86.26 5.83 L87.79 6.65 L89.23 7.58 L90.58 8.64 L91.86 9.82 L92.65 10.64 L93.39 11.50 L94.79 13.33 L96.04 15.29 L97.13 17.37 L98.06 19.55 L98.82 21.81 L99.40 24.15 L99.80 26.53 L99.92 27.98 L99.99 29.75 L100.00 31.52 L99.94 32.93 L99.78 34.40 L99.56 35.83 L99.28 37.24 L98.93 38.61 L98.52 39.97 L98.05 41.30 L97.50 42.62 L96.89 43.92 L96.20 45.21 L95.44 46.49 L94.61 47.76 L93.71 49.03 L92.72 50.30 L91.66 51.58 L90.52 52.86 L89.29 54.15 L87.87 55.57 L86.45 56.92 L84.97 58.25 L83.39 59.60 L79.70 62.51 L74.96 66.01 L70.50 69.30 L67.18 71.89 L65.78 73.08 L64.45 74.26 L61.75 76.87 L59.87 78.80 L58.28 80.57 L56.84 82.32 L55.42 84.23 L54.36 85.77 L53.40 87.31 L52.54 88.83 L51.79 90.32 L51.15 91.77 L50.63 93.16 L50.24 94.48 L49.98 95.72 L49.80 96.51 L49.74 96.44 L49.68 96.15 Z M50.26 91.39 L50.50 89.92 L50.65 88.61 L50.73 87.26 L50.75 85.67 L50.72 83.64 L50.59 82.38 L50.28 80.80 L49.90 79.30 L49.43 77.87 L48.89 76.53 L48.46 75.67 L48.49 75.87 L48.68 76.48 L49.14 78.06 L49.53 79.68 L49.80 81.10 L49.89 82.06 L49.88 82.15 L49.85 82.11 L49.75 81.66 L49.45 80.25 L49.04 78.74 L48.52 77.13 L47.88 75.40 L47.27 73.95 L47.09 73.58 L47.04 73.51 L47.02 73.52 L47.20 74.06 L47.88 75.98 L48.51 77.96 L48.76 78.94 L48.98 80.07 L49.35 82.79 L49.62 86.13 L49.81 90.13 L49.91 93.06 L49.92 93.11 L49.94 93.09 L50.00 92.83 L50.26 91.39 Z M48.58 89.68 L47.91 87.72 L47.01 85.66 L45.90 83.58 L44.64 81.52 L43.05 79.27 L41.34 77.16 L39.39 75.06 L37.10 72.82 L36.55 72.28 L36.53 72.24 L36.69 72.36 L38.15 73.63 L39.81 75.23 L41.46 76.97 L42.92 78.64 L44.00 80.06 L45.14 81.69 L46.18 83.32 L46.99 84.72 L47.55 85.75 L47.39 85.26 L46.95 84.31 L45.73 81.97 L44.67 80.24 L43.49 78.57 L41.97 76.68 L39.92 74.31 L39.61 73.93 L39.64 73.94 L39.79 74.07 L41.20 75.54 L43.09 77.72 L44.79 79.96 L45.55 81.10 L46.26 82.24 L46.90 83.39 L47.48 84.53 L47.94 85.43 L47.96 85.45 L47.95 85.38 L47.82 84.99 L47.02 83.14 L46.08 81.27 L44.95 79.42 L43.55 77.41 L42.00 75.39 L40.44 73.54 L40.35 73.43 L40.40 73.46 L40.87 73.90 L41.64 74.68 L42.41 75.55 L44.20 77.81 L45.36 79.43 L46.34 80.96 L47.15 82.42 L47.83 83.84 L48.07 84.28 L47.92 83.80 L47.47 82.71 L46.28 80.17 L45.68 79.08 L45.04 78.01 L44.34 76.96 L43.62 75.95 L43.07 75.19 L43.04 75.13 L43.06 75.14 L43.26 75.36 L44.40 76.83 L45.53 78.48 L46.60 80.19 L47.53 81.88 L47.95 82.69 L48.11 82.92 L47.63 81.66 L47.08 80.42 L46.45 79.17 L45.78 77.95 L45.08 76.79 L44.68 76.11 L44.61 75.94 L44.72 76.07 L45.41 77.00 L46.12 78.07 L46.83 79.27 L47.53 80.57 L48.22 81.86 L48.26 81.90 L48.25 81.84 L48.09 81.41 L47.42 79.86 L46.59 78.19 L45.72 76.63 L44.96 75.44 L44.76 75.14 L44.77 75.11 L44.84 75.17 L45.35 75.75 L46.06 76.76 L46.85 78.03 L47.62 79.40 L47.98 80.03 L48.04 80.10 L48.02 80.02 L47.29 78.40 L46.22 76.40 L45.02 74.55 L43.62 72.75 L41.97 70.94 L41.34 70.26 L41.24 70.12 L41.30 70.14 L42.29 71.06 L43.65 72.49 L45.02 74.06 L46.07 75.39 L46.75 76.31 L46.78 76.33 L46.76 76.26 L46.56 75.89 L45.87 74.75 L44.94 73.39 L43.96 72.06 L43.09 70.98 L42.62 70.40 L43.17 70.94 L44.24 72.17 L45.13 73.28 L46.31 74.95 L47.10 76.20 L47.15 76.24 L47.10 76.08 L46.88 75.58 L46.51 74.89 L45.49 73.20 L44.35 71.51 L43.43 70.33 L43.05 69.85 L43.22 69.98 L43.65 70.42 L44.69 71.63 L45.92 73.28 L46.80 74.69 L47.26 75.45 L47.04 74.87 L46.50 73.81 L45.88 72.76 L45.28 71.82 L44.65 70.95 L43.97 70.11 L43.21 69.29 L42.35 68.44 L40.21 66.55 L38.68 65.33 L37.03 64.14 L35.28 63.00 L33.45 61.92 L33.12 61.74 L33.08 61.74 L33.13 61.79 L34.10 62.44 L35.71 63.57 L37.57 65.00 L39.23 66.37 L40.25 67.33 L40.48 67.59 L40.25 67.41 L39.40 66.68 L37.86 65.43 L36.12 64.17 L34.28 62.95 L32.45 61.85 L30.39 60.70 L29.84 60.44 L31.28 61.39 L33.56 62.89 L35.88 64.58 L37.38 65.77 L37.52 65.89 L37.51 65.91 L37.05 65.60 L34.94 64.11 L33.09 62.91 L29.81 60.99 L28.38 60.20 L27.76 59.91 L27.89 60.04 L28.28 60.30 L31.11 62.15 L34.01 64.19 L35.39 65.27 L35.45 65.34 L35.37 65.31 L34.79 64.92 L33.13 63.81 L30.88 62.41 L25.71 59.35 L23.97 58.42 L23.88 58.40 L23.94 58.46 L24.54 58.87 L26.64 60.33 L28.83 61.88 L29.67 62.52 L29.58 62.49 L29.20 62.26 L27.48 61.14 L25.81 60.07 L23.85 58.88 L22.77 58.24 L22.57 58.14 L22.53 58.13 L22.53 58.16 L23.15 58.66 L24.97 59.95 L26.28 60.91 L27.18 61.68 L27.26 61.76 L27.19 61.72 L26.04 60.96 L24.57 60.05 L23.03 59.11 L21.96 58.41 L21.87 58.37 L21.91 58.45 L21.93 58.52 L21.81 58.50 L21.73 58.48 L21.76 58.54 L22.19 58.87 L24.88 60.74 L26.43 61.84 L24.96 60.98 L22.22 59.30 L19.59 57.61 L18.26 56.77 L19.50 57.74 L21.68 59.43 L23.53 60.88 L25.83 62.69 L28.60 64.82 L29.98 65.89 L29.40 65.55 L28.05 64.61 L25.11 62.45 L22.01 60.21 L19.52 58.43 L17.59 56.99 L16.05 55.76 L14.74 54.62 L14.34 54.25 L14.74 54.69 L15.80 55.69 L17.40 57.04 L22.81 61.34 L23.61 61.96 L23.77 62.12 L23.79 62.16 L23.39 61.94 L22.41 61.29 L19.57 59.31 L17.27 57.57 L15.21 55.84 L13.12 53.90 L12.45 53.27 L12.38 53.23 L12.48 53.37 L13.78 54.69 L15.96 56.70 L19.70 59.87 L21.90 61.57 L25.19 63.97 L26.48 64.93 L26.54 64.99 L26.48 64.97 L26.03 64.69 L23.30 62.87 L20.75 61.09 L18.50 59.44 L16.68 57.99 L14.84 56.38 L12.93 54.55 L11.12 52.68 L9.60 50.96 L8.94 50.19 L8.81 50.06 L8.85 50.15 L9.82 51.42 L11.23 53.13 L12.57 54.63 L13.95 56.08 L15.43 57.50 L17.03 58.93 L18.80 60.41 L20.78 61.96 L23.01 63.62 L25.51 65.43 L31.16 69.46 L33.85 71.51 L35.89 73.21 L37.97 75.12 L39.91 77.04 L41.54 78.81 L42.59 80.08 L43.59 81.38 L44.53 82.70 L45.42 84.04 L46.24 85.39 L47.00 86.76 L47.69 88.14 L48.32 89.52 L48.79 90.51 L48.58 89.68 Z M43.18 73.53 L41.97 72.08 L41.86 71.94 L41.96 72.01 L42.50 72.57 L43.22 73.40 L43.82 74.16 L44.02 74.49 L43.18 73.53 Z M27.92 62.71 L27.49 62.34 L27.93 62.58 L28.40 62.95 L28.43 63.02 L28.38 63.02 L27.92 62.71 Z M22.04 58.62 L21.97 58.56 L22.01 58.53 L22.18 58.62 L22.20 58.71 L22.04 58.62 Z M52.65 87.16 L53.60 85.55 L54.69 83.89 L55.90 82.21 L57.22 80.52 L58.64 78.83 L60.14 77.17 L61.72 75.55 L63.34 73.98 L65.98 71.61 L69.73 68.45 L73.62 65.15 L76.55 62.52 L78.82 60.26 L80.79 58.04 L82.19 56.29 L83.44 54.56 L84.56 52.85 L85.54 51.14 L86.40 49.42 L87.14 47.68 L87.77 45.89 L88.30 44.06 L88.72 42.26 L89.00 40.56 L89.15 38.88 L89.20 37.09 L89.14 35.21 L88.95 33.49 L88.62 31.84 L88.13 30.14 L87.76 29.12 L87.36 28.14 L86.92 27.20 L86.44 26.30 L85.92 25.44 L85.36 24.62 L84.77 23.84 L84.15 23.11 L83.50 22.43 L82.81 21.79 L82.10 21.21 L81.36 20.67 L80.60 20.19 L79.81 19.77 L79.00 19.40 L78.17 19.10 L76.80 18.74 L75.36 18.54 L73.92 18.51 L72.56 18.65 L71.67 18.84 L70.78 19.10 L69.89 19.43 L69.00 19.84 L68.11 20.31 L67.23 20.84 L66.35 21.44 L65.49 22.11 L64.63 22.84 L63.78 23.63 L62.13 25.39 L60.54 27.39 L59.03 29.60 L57.88 31.57 L56.92 33.53 L56.15 35.46 L55.60 37.28 L55.27 38.96 L55.19 39.73 L55.17 40.45 L55.21 41.11 L55.32 41.70 L55.49 42.22 L55.73 42.67 L56.07 43.07 L56.63 43.59 L57.27 44.12 L57.88 44.57 L58.42 44.99 L58.08 44.84 L57.33 44.41 L55.76 43.40 L54.92 42.72 L54.09 41.93 L53.25 41.05 L52.43 40.08 L51.63 39.04 L50.86 37.93 L50.14 36.77 L49.46 35.57 L48.10 33.02 L47.20 31.41 L46.36 30.03 L45.55 28.84 L44.73 27.81 L43.88 26.92 L42.96 26.13 L41.96 25.40 L40.84 24.71 L39.92 24.22 L39.67 24.13 L39.64 24.13 L39.67 24.17 L40.23 24.57 L41.28 25.37 L42.38 26.42 L43.45 27.62 L44.38 28.86 L45.81 31.19 L46.47 32.33 L46.74 32.89 L46.51 32.58 L45.95 31.75 L44.55 29.74 L43.36 28.20 L43.23 28.06 L43.24 28.11 L43.71 28.80 L44.81 30.50 L43.81 29.40 L42.03 27.47 L41.11 26.60 L41.09 26.62 L41.18 26.74 L41.60 27.22 L42.66 28.42 L43.76 29.89 L44.99 31.72 L46.43 34.02 L47.75 36.12 L49.03 37.99 L50.26 39.64 L51.45 41.05 L52.14 41.77 L52.89 42.48 L54.56 43.84 L56.37 45.09 L58.25 46.15 L59.17 46.62 L59.48 46.81 L58.16 46.35 L56.46 45.63 L55.13 44.90 L53.90 44.10 L52.73 43.18 L51.58 42.13 L50.16 40.64 L49.53 39.86 L48.92 39.03 L47.69 37.10 L46.32 34.60 L45.15 32.45 L44.12 30.79 L43.10 29.40 L41.94 28.07 L41.23 27.35 L40.48 26.66 L39.73 26.05 L39.04 25.54 L38.75 25.36 L38.69 25.33 L38.70 25.36 L39.44 26.00 L40.48 26.97 L41.49 28.06 L42.45 29.27 L43.33 30.54 L44.40 32.32 L44.79 33.03 L44.92 33.34 L44.54 32.77 L43.38 30.96 L42.20 29.33 L41.12 28.11 L39.91 26.93 L38.75 25.94 L37.82 25.31 L37.60 25.21 L37.56 25.21 L37.58 25.23 L38.11 25.64 L38.67 26.08 L39.30 26.67 L39.96 27.35 L40.57 28.07 L41.37 29.11 L41.17 28.95 L40.57 28.35 L39.04 26.88 L38.30 26.28 L37.57 25.76 L36.84 25.31 L36.10 24.92 L35.35 24.60 L34.56 24.33 L33.63 24.10 L32.69 23.96 L31.73 23.92 L30.77 23.96 L29.81 24.10 L28.85 24.33 L27.90 24.66 L26.96 25.07 L26.20 25.47 L25.48 25.92 L24.78 26.40 L24.12 26.93 L22.88 28.10 L21.78 29.42 L20.83 30.88 L20.02 32.46 L19.37 34.16 L18.89 35.96 L18.72 37.12 L18.63 38.51 L18.64 39.91 L18.75 41.09 L19.02 42.45 L19.41 43.63 L20.00 44.82 L20.88 46.22 L21.63 47.29 L22.41 48.27 L23.29 49.26 L24.35 50.34 L25.76 51.65 L27.30 52.90 L29.17 54.26 L31.60 55.90 L36.62 59.26 L38.00 60.26 L39.31 61.29 L41.29 62.97 L43.03 64.68 L44.61 66.47 L46.09 68.43 L46.86 69.59 L47.59 70.80 L48.27 72.05 L48.90 73.34 L49.47 74.64 L49.97 75.94 L50.40 77.24 L50.76 78.52 L50.98 79.18 L51.24 78.61 L51.68 77.60 L52.32 76.27 L53.67 73.75 L54.86 71.88 L56.11 70.16 L57.47 68.53 L59.00 66.91 L60.58 65.41 L62.22 64.00 L63.95 62.67 L65.78 61.39 L69.22 59.13 L71.03 57.91 L72.46 56.90 L73.64 55.98 L74.68 55.08 L76.15 53.63 L77.39 52.19 L78.41 50.73 L79.21 49.26 L79.83 47.86 L80.39 46.43 L80.90 44.97 L81.36 43.50 L81.76 42.04 L82.09 40.59 L82.35 39.17 L82.53 37.80 L82.62 36.54 L82.63 35.03 L82.59 33.51 L82.49 32.26 L82.20 30.60 L81.78 28.97 L81.24 27.44 L80.62 26.08 L79.95 24.93 L79.24 23.88 L78.48 22.95 L77.67 22.12 L76.81 21.40 L75.89 20.78 L74.92 20.26 L73.89 19.85 L73.11 19.58 L74.33 19.63 L75.23 19.69 L76.10 19.81 L76.95 19.98 L77.77 20.20 L78.56 20.49 L79.34 20.83 L80.10 21.23 L80.84 21.68 L81.74 22.38 L82.77 23.34 L83.75 24.38 L84.54 25.36 L85.17 26.35 L85.82 27.58 L86.41 28.85 L86.85 30.02 L87.27 31.47 L87.58 32.99 L87.78 34.45 L87.84 35.73 L87.83 36.08 L87.82 36.16 L87.75 35.41 L87.60 34.17 L87.36 32.87 L87.09 31.76 L86.82 31.08 L86.55 30.45 L86.03 29.09 L85.82 28.63 L85.96 29.12 L86.37 30.54 L86.77 32.38 L86.93 33.49 L87.05 34.74 L87.11 35.79 L87.07 36.27 L87.02 36.25 L86.99 36.10 L86.92 35.39 L86.82 34.29 L86.63 33.17 L86.37 32.02 L86.03 30.86 L85.53 29.47 L84.79 27.84 L83.81 25.81 L83.30 24.89 L82.62 24.07 L81.60 23.09 L81.54 23.07 L81.60 23.16 L82.00 23.61 L82.72 24.40 L83.25 25.07 L83.62 25.67 L83.88 26.27 L84.36 27.43 L84.93 28.86 L85.48 30.56 L85.90 32.20 L86.10 33.43 L86.13 34.06 L85.96 33.20 L85.61 31.72 L85.48 31.33 L85.44 31.26 L85.43 31.31 L85.55 32.61 L85.68 34.28 L85.67 34.60 L85.65 34.68 L85.55 33.97 L85.24 32.05 L84.84 30.34 L84.34 28.80 L83.73 27.39 L82.78 25.72 L82.03 24.55 L82.25 25.02 L82.86 26.09 L83.39 27.12 L83.86 28.28 L84.25 29.56 L84.56 30.93 L84.80 32.37 L84.94 33.85 L85.00 35.36 L84.96 36.88 L84.78 38.99 L84.68 39.70 L84.59 40.05 L84.53 40.12 L84.55 40.01 L84.69 38.73 L84.83 36.76 L84.86 35.53 L84.79 34.28 L84.66 33.03 L84.44 31.78 L84.16 30.55 L83.80 29.37 L83.39 28.24 L82.90 27.18 L82.50 26.46 L82.51 26.55 L82.67 26.96 L83.25 28.36 L83.69 29.69 L84.02 31.08 L84.30 32.71 L84.41 33.92 L84.46 35.38 L84.44 36.82 L84.35 37.98 L83.81 40.96 L83.53 42.18 L83.37 42.64 L83.56 41.43 L83.81 40.03 L83.97 38.82 L84.06 37.65 L84.08 36.36 L84.00 34.09 L83.74 32.03 L83.54 31.04 L83.30 30.08 L82.65 28.15 L82.17 27.06 L82.20 27.25 L82.44 27.95 L82.91 29.46 L83.25 31.02 L83.48 32.64 L83.60 34.30 L83.59 36.00 L83.46 37.75 L83.21 39.54 L82.84 41.36 L82.30 43.42 L81.66 45.45 L80.91 47.47 L80.05 49.46 L79.07 51.45 L77.97 53.44 L76.75 55.44 L75.40 57.45 L73.51 60.03 L71.42 62.63 L69.06 65.30 L66.40 68.12 L65.08 69.39 L64.98 69.45 L65.00 69.40 L65.41 68.90 L66.87 67.20 L67.33 66.64 L67.43 66.50 L67.41 66.50 L67.27 66.60 L67.21 66.60 L68.20 65.50 L68.90 64.75 L69.19 64.37 L69.10 64.39 L68.87 64.57 L68.65 64.77 L68.56 64.81 L68.38 64.92 L67.95 65.27 L66.76 66.24 L66.06 66.76 L65.94 66.81 L67.00 65.92 L69.31 64.00 L69.98 63.37 L70.13 63.19 L70.14 63.13 L68.44 64.33 L66.67 65.60 L66.63 65.61 L66.67 65.55 L66.94 65.30 L67.93 64.49 L69.66 63.05 L71.08 61.73 L71.58 61.21 L70.63 61.93 L68.78 63.26 L67.30 64.29 L66.84 64.60 L66.78 64.62 L66.82 64.57 L67.94 63.66 L69.71 62.27 L71.25 60.98 L72.42 59.92 L73.07 59.22 L73.19 59.05 L73.19 59.02 L73.15 59.04 L72.45 59.64 L71.27 60.55 L69.54 61.77 L67.98 62.82 L67.48 63.12 L67.30 63.20 L67.91 62.73 L69.65 61.44 L71.18 60.19 L72.56 58.99 L72.65 58.89 L72.63 58.88 L72.21 59.18 L70.25 60.53 L67.48 62.32 L65.22 63.76 L64.38 64.31 L64.26 64.38 L64.23 64.36 L64.62 63.99 L65.67 63.19 L69.14 60.74 L70.55 59.76 L71.68 58.92 L72.73 58.06 L73.85 57.07 L74.93 56.03 L74.95 55.97 L74.86 56.02 L74.34 56.43 L72.66 57.66 L70.05 59.35 L66.13 61.83 L64.88 62.68 L63.65 63.58 L61.47 65.33 L60.48 66.23 L59.54 67.15 L58.65 68.09 L57.81 69.07 L57.01 70.09 L56.24 71.15 L55.50 72.26 L55.46 72.36 L55.64 72.15 L57.04 70.53 L58.63 68.88 L60.30 67.31 L61.97 65.88 L63.26 64.93 L63.27 64.96 L63.14 65.10 L62.52 65.71 L60.17 67.98 L58.96 69.19 L60.09 68.26 L61.61 67.05 L61.58 67.11 L61.40 67.31 L60.58 68.13 L59.39 69.34 L59.37 69.38 L59.47 69.31 L59.99 68.87 L61.23 67.88 L62.92 66.63 L64.40 65.60 L64.87 65.30 L65.04 65.23 L63.98 66.07 L62.50 67.23 L61.08 68.42 L59.74 69.63 L58.48 70.87 L57.31 72.11 L56.25 73.35 L55.29 74.58 L54.45 75.80 L53.95 76.61 L53.90 76.71 L54.02 76.56 L55.78 74.25 L56.59 73.32 L57.51 72.34 L58.22 71.63 L58.60 71.31 L58.64 71.30 L58.58 71.41 L58.10 71.97 L56.99 73.24 L55.99 74.50 L55.05 75.83 L54.11 77.28 L53.42 78.46 L53.31 78.68 L53.49 78.46 L53.96 77.74 L54.68 76.66 L55.64 75.41 L56.75 74.11 L57.91 72.87 L58.84 71.95 L58.97 71.83 L58.86 71.97 L57.31 73.71 L56.13 75.19 L55.22 76.52 L54.48 77.86 L54.31 78.23 L54.29 78.30 L54.32 78.29 L54.85 77.48 L55.32 76.78 L55.91 75.99 L57.38 74.26 L59.05 72.53 L60.72 71.01 L61.59 70.33 L61.62 70.33 L61.57 70.40 L61.26 70.74 L60.83 71.15 L60.49 71.40 L60.07 71.70 L59.49 72.23 L58.09 73.72 L56.68 75.42 L56.10 76.21 L55.67 76.88 L54.74 78.69 L54.36 79.51 L54.27 79.74 L54.27 79.79 L54.92 78.78 L55.63 77.55 L55.94 77.06 L56.08 76.95 L56.19 76.96 L56.58 76.62 L57.42 75.75 L58.54 74.57 L58.62 74.50 L58.62 74.53 L58.36 74.87 L56.47 77.34 L55.73 78.42 L55.11 79.40 L54.27 80.92 L54.25 81.00 L54.32 80.92 L54.73 80.28 L56.03 78.38 L57.65 76.29 L59.33 74.34 L60.80 72.83 L61.21 72.46 L60.92 72.82 L60.40 73.41 L59.58 74.31 L58.41 75.79 L57.14 77.51 L56.02 79.13 L54.71 81.20 L54.68 81.27 L54.79 81.14 L55.44 80.21 L56.89 78.25 L58.67 76.11 L61.30 73.33 L62.59 72.05 L63.19 71.51 L62.79 71.98 L61.70 73.11 L59.66 75.25 L58.91 76.15 L58.13 77.17 L56.63 79.26 L55.39 81.19 L54.34 83.09 L53.41 85.08 L52.37 87.40 L52.10 87.97 L52.06 88.09 L52.07 88.10 L52.65 87.16 Z M57.72 74.89 L58.29 74.26 L58.38 74.19 L58.38 74.21 L58.15 74.49 L57.58 75.11 L57.55 75.13 L57.56 75.11 L57.72 74.89 Z M64.06 71.33 L64.96 70.34 L66.97 68.27 L69.09 66.08 L71.06 63.95 L72.88 61.88 L74.55 59.90 L76.04 58.00 L77.35 56.21 L78.48 54.53 L79.41 52.96 L79.86 52.19 L80.08 51.90 L79.92 52.30 L79.44 53.18 L78.13 55.33 L76.55 57.57 L74.63 60.06 L72.57 62.57 L70.54 64.89 L68.57 66.97 L66.38 69.18 L64.66 70.85 L64.17 71.28 L64.06 71.36 L64.06 71.33 Z M62.02 69.98 L62.23 69.80 L62.11 69.98 L61.90 70.16 L62.02 69.98 Z M67.30 69.15 L69.39 67.25 L71.00 65.79 L71.91 64.87 L72.68 63.93 L73.92 62.53 L75.30 61.01 L75.61 60.69 L75.69 60.64 L75.68 60.67 L75.61 60.84 L75.64 60.86 L75.98 60.45 L77.04 59.21 L77.90 58.19 L78.86 56.95 L79.82 55.59 L80.70 54.25 L80.73 54.22 L80.72 54.27 L80.62 54.57 L80.30 55.17 L79.75 56.05 L78.51 57.81 L77.25 59.35 L76.67 59.98 L75.28 61.46 L73.74 63.08 L73.58 63.22 L73.52 63.36 L73.49 63.45 L73.44 63.45 L73.33 63.48 L73.18 63.61 L72.85 64.09 L72.48 64.56 L71.78 65.28 L69.12 67.67 L67.84 68.75 L67.30 69.15 Z M72.97 64.24 L73.57 63.63 L74.34 62.83 L76.40 60.61 L78.27 58.62 L78.74 58.03 L79.25 57.32 L80.41 55.52 L81.09 54.31 L81.86 52.89 L83.10 50.62 L84.11 48.46 L84.58 47.48 L84.53 47.73 L84.30 48.33 L83.52 50.12 L82.62 52.01 L81.99 53.17 L80.75 55.42 L80.40 56.02 L80.07 56.56 L79.64 57.20 L78.89 58.17 L78.03 59.19 L77.25 60.05 L76.39 60.94 L76.32 61.05 L76.45 60.99 L76.78 60.72 L77.30 60.20 L78.62 58.75 L79.84 57.30 L80.22 56.77 L80.37 56.50 L80.58 56.15 L81.74 54.35 L83.18 51.95 L84.03 50.40 L84.78 48.87 L85.43 47.40 L85.96 46.00 L86.33 45.06 L86.34 45.10 L86.29 45.29 L86.09 45.96 L85.47 47.72 L84.68 49.49 L83.56 51.67 L82.36 53.81 L81.32 55.46 L81.07 55.84 L81.06 55.89 L81.11 55.85 L81.84 54.94 L82.67 53.80 L83.46 52.64 L84.18 51.46 L84.86 50.27 L85.48 49.08 L86.03 47.88 L86.52 46.70 L86.94 45.52 L87.10 45.10 L87.19 44.95 L86.86 46.11 L86.15 47.99 L85.33 49.83 L84.39 51.63 L83.34 53.37 L82.17 55.08 L80.88 56.74 L79.47 58.37 L77.94 59.95 L76.47 61.33 L75.48 62.16 L73.03 64.33 L72.76 64.52 L72.97 64.24 Z M75.34 59.98 L76.59 58.28 L77.99 56.28 L79.32 54.29 L80.37 52.63 L80.92 51.76 L80.94 51.75 L80.92 51.82 L80.73 52.21 L80.17 53.22 L79.38 54.51 L77.60 57.15 L76.35 58.79 L75.36 60.02 L75.03 60.38 L75.34 59.98 Z M77.25 58.37 L78.12 57.09 L79.46 55.17 L80.62 53.39 L81.59 51.80 L82.32 50.42 L82.46 50.16 L82.52 50.12 L81.86 51.54 L81.19 52.74 L80.20 54.32 L79.14 55.94 L78.23 57.23 L77.54 58.16 L77.18 58.60 L77.16 58.57 L77.25 58.37 Z M86.46 44.47 L86.60 43.97 L86.65 43.91 L86.62 44.11 L86.49 44.61 L86.44 44.67 L86.46 44.47 Z M51.69 40.35 L51.61 40.23 L51.72 40.31 L51.88 40.47 L51.87 40.50 L51.83 40.49 L51.69 40.35 Z M51.19 39.76 L50.04 38.33 L49.50 37.59 L49.19 37.07 L49.08 36.85 L49.24 37.08 L49.76 37.76 L51.50 40.05 L51.19 39.76 Z M50.01 37.78 L49.71 37.26 L49.52 36.94 L49.71 37.17 L50.03 37.64 L50.14 37.94 L50.01 37.78 Z M86.16 34.37 L86.17 34.20 L86.20 34.22 L86.20 34.53 L86.17 34.55 L86.16 34.37 Z M86.96 32.07 L86.97 31.97 L87.01 32.01 L87.00 32.19 L86.97 32.17 L86.96 32.07 L86.96 32.07 Z M86.82 31.57 L86.81 31.25 L86.90 31.49 L86.92 31.81 L86.82 31.57 L86.82 31.57 Z M56.21 77.08 L56.16 77.06 L56.03 77.15 L55.85 77.40 L55.90 77.42 L56.03 77.33 L56.21 77.08 Z M46.42 72.84 L45.91 71.96 L45.24 70.97 L44.45 69.94 L43.57 68.90 L42.26 67.59 L40.65 66.20 L38.87 64.87 L37.07 63.68 L36.81 63.54 L36.75 63.53 L37.21 63.91 L38.66 65.03 L40.26 66.36 L41.85 67.79 L43.29 69.18 L44.17 70.12 L45.01 71.08 L45.69 71.94 L46.08 72.54 L46.39 73.05 L46.62 73.32 L46.42 72.84 Z M47.27 71.49 L46.44 70.13 L45.42 68.60 L44.68 67.61 L43.90 66.67 L43.07 65.75 L42.18 64.83 L40.41 63.18 L38.46 61.62 L36.15 59.98 L33.27 58.13 L30.12 56.12 L27.61 54.40 L25.56 52.85 L23.82 51.35 L22.85 50.41 L21.94 49.44 L21.07 48.43 L20.26 47.39 L19.50 46.32 L18.80 45.22 L18.15 44.09 L17.56 42.93 L17.03 41.76 L16.56 40.56 L16.15 39.35 L15.80 38.12 L15.51 36.88 L15.29 35.63 L15.14 34.38 L15.05 33.11 L15.03 32.01 L15.08 30.89 L15.19 29.76 L15.37 28.64 L15.61 27.51 L15.90 26.40 L16.26 25.31 L16.67 24.24 L17.10 23.30 L17.57 22.40 L18.09 21.54 L18.65 20.72 L19.26 19.95 L19.91 19.21 L20.60 18.52 L21.33 17.87 L22.10 17.27 L22.91 16.71 L23.75 16.20 L24.63 15.74 L25.54 15.33 L26.48 14.98 L27.45 14.67 L28.45 14.42 L30.30 14.11 L31.22 14.03 L32.14 14.00 L33.99 14.10 L35.88 14.40 L36.90 14.58 L36.83 14.53 L36.56 14.44 L35.58 14.20 L33.04 13.72 L32.10 13.64 L30.92 13.62 L29.73 13.65 L28.76 13.73 L27.65 13.92 L26.55 14.18 L25.47 14.52 L24.42 14.93 L23.40 15.41 L22.42 15.95 L21.49 16.56 L20.61 17.22 L19.56 18.04 L19.54 18.04 L19.61 17.97 L19.99 17.58 L20.77 16.88 L21.61 16.24 L22.50 15.67 L23.45 15.16 L24.44 14.71 L25.47 14.32 L26.54 14.01 L27.64 13.75 L28.77 13.57 L29.92 13.45 L31.10 13.41 L32.29 13.43 L33.49 13.52 L34.69 13.68 L35.90 13.92 L37.11 14.23 L38.24 14.51 L37.90 14.35 L36.97 14.05 L34.75 13.47 L33.42 13.23 L32.28 13.08 L31.17 13.02 L29.91 13.04 L28.89 13.10 L27.88 13.21 L26.91 13.38 L25.96 13.60 L25.04 13.87 L24.14 14.19 L23.28 14.57 L22.44 15.00 L21.63 15.48 L20.85 16.01 L20.10 16.60 L19.37 17.23 L18.68 17.92 L18.02 18.66 L17.38 19.45 L16.78 20.29 L16.27 21.12 L15.76 22.10 L15.28 23.15 L14.87 24.21 L14.59 24.95 L14.51 25.13 L14.48 25.16 L14.77 24.13 L15.19 23.00 L15.66 21.94 L16.17 20.95 L16.73 20.03 L17.34 19.16 L18.01 18.34 L18.74 17.57 L19.54 16.84 L20.57 16.02 L21.63 15.29 L22.74 14.66 L23.90 14.11 L25.10 13.66 L26.36 13.29 L27.67 13.01 L29.03 12.82 L29.94 12.76 L30.96 12.76 L33.17 12.91 L35.39 13.25 L36.42 13.48 L37.35 13.74 L37.97 13.88 L37.70 13.75 L36.95 13.49 L35.08 12.96 L33.86 12.70 L32.74 12.54 L31.60 12.45 L30.29 12.43 L28.94 12.47 L27.66 12.58 L26.44 12.78 L25.26 13.06 L24.12 13.42 L23.00 13.88 L21.88 14.44 L20.76 15.09 L19.94 15.67 L19.01 16.45 L18.10 17.31 L17.33 18.13 L16.45 19.14 L16.41 19.16 L16.44 19.11 L16.65 18.78 L17.23 18.06 L18.08 17.15 L19.22 16.10 L20.45 15.17 L21.75 14.37 L23.12 13.70 L24.56 13.15 L26.06 12.74 L27.62 12.46 L29.23 12.32 L30.08 12.25 L30.43 12.18 L29.89 12.12 L28.64 12.11 L27.23 12.14 L26.22 12.20 L25.20 12.38 L24.12 12.65 L23.07 12.98 L22.14 13.34 L21.62 13.52 L21.86 13.37 L22.49 13.09 L23.92 12.56 L24.88 12.31 L25.81 12.13 L26.80 12.02 L27.93 11.96 L29.24 11.94 L30.53 12.00 L32.10 12.16 L34.26 12.44 L34.57 12.47 L34.61 12.47 L34.59 12.44 L33.95 12.25 L32.73 11.96 L31.33 11.69 L29.83 11.48 L27.90 11.44 L26.15 11.47 L25.15 11.59 L24.38 11.74 L24.23 11.74 L24.22 11.71 L25.03 11.53 L26.09 11.38 L27.19 11.29 L28.34 11.25 L29.51 11.28 L30.69 11.36 L31.89 11.50 L33.08 11.69 L34.26 11.94 L36.49 12.59 L38.48 13.31 L38.83 13.45 L38.95 13.47 L38.34 13.13 L37.03 12.57 L35.50 11.99 L34.24 11.57 L32.31 11.08 L30.50 10.77 L28.69 10.61 L26.73 10.59 L25.28 10.60 L25.04 10.58 L25.11 10.54 L26.06 10.47 L27.57 10.45 L29.19 10.50 L30.47 10.61 L32.21 10.90 L34.01 11.28 L35.69 11.73 L37.10 12.19 L37.97 12.51 L38.01 12.50 L37.86 12.40 L37.02 12.00 L35.68 11.48 L34.11 10.96 L32.59 10.53 L30.77 10.12 L29.06 9.85 L27.41 9.71 L25.78 9.69 L24.86 9.71 L24.72 9.69 L24.84 9.67 L26.01 9.59 L27.30 9.60 L28.67 9.68 L30.09 9.84 L31.53 10.08 L32.95 10.38 L34.32 10.74 L35.60 11.16 L36.55 11.46 L36.59 11.45 L36.56 11.42 L36.27 11.25 L35.23 10.79 L33.81 10.29 L32.26 9.82 L30.79 9.46 L29.39 9.18 L28.26 9.01 L27.14 8.93 L25.78 8.91 L24.51 8.92 L23.49 8.98 L22.56 9.09 L21.56 9.28 L20.90 9.37 L21.52 9.19 L22.81 8.96 L24.10 8.81 L25.38 8.73 L26.66 8.72 L27.95 8.80 L29.26 8.94 L30.58 9.17 L31.93 9.47 L33.32 9.86 L34.60 10.19 L34.42 10.07 L33.84 9.81 L32.15 9.17 L30.39 8.66 L28.50 8.30 L26.58 8.10 L24.70 8.08 L23.01 8.19 L21.40 8.39 L19.82 8.69 L18.25 9.09 L17.10 9.40 L17.34 9.29 L18.05 9.04 L19.70 8.55 L20.76 8.31 L21.84 8.13 L22.93 8.00 L24.05 7.93 L25.18 7.91 L26.32 7.95 L27.47 8.04 L28.64 8.19 L29.53 8.31 L29.60 8.29 L29.48 8.23 L29.30 8.15 L29.48 8.15 L30.94 8.44 L33.02 9.00 L34.63 9.58 L36.20 10.29 L37.72 11.14 L39.21 12.12 L40.64 13.24 L42.04 14.49 L43.38 15.87 L44.68 17.39 L46.02 19.16 L46.38 19.64 L46.57 19.81 L46.67 19.86 L46.79 20.05 L46.91 20.23 L46.99 20.27 L47.08 20.31 L47.20 20.50 L47.34 20.78 L47.49 20.55 L47.57 20.41 L47.56 20.25 L47.23 19.57 L46.37 18.18 L45.34 16.78 L44.16 15.39 L42.86 14.05 L42.23 13.43 L42.04 13.20 L42.29 13.36 L42.96 13.94 L44.08 14.98 L45.16 16.13 L46.24 17.40 L47.33 18.84 L47.94 19.59 L47.85 19.37 L47.54 18.81 L46.63 17.35 L45.70 16.08 L44.68 14.85 L44.62 14.77 L44.69 14.83 L45.17 15.30 L45.91 16.10 L46.63 16.94 L47.27 17.78 L47.78 18.54 L48.15 19.10 L48.23 19.19 L48.25 19.15 L48.08 18.71 L47.66 17.79 L47.32 17.25 L46.89 16.66 L46.77 16.49 L46.76 16.46 L47.10 16.80 L47.56 17.35 L48.02 17.99 L48.37 18.48 L48.56 18.69 L48.61 18.67 L48.58 18.58 L48.23 18.06 L47.83 17.44 L47.77 17.28 L48.04 17.47 L48.38 17.77 L48.70 18.03 L48.95 18.18 L49.04 18.17 L48.98 18.01 L48.80 17.74 L48.10 16.92 L47.07 15.86 L45.03 14.02 L42.93 12.39 L41.86 11.65 L40.77 10.95 L39.67 10.31 L38.54 9.72 L37.40 9.18 L36.24 8.69 L35.06 8.24 L33.86 7.85 L32.63 7.50 L31.39 7.20 L28.82 6.74 L27.61 6.63 L26.05 6.55 L23.78 6.58 L21.53 6.81 L19.33 7.22 L17.19 7.80 L15.13 8.56 L13.17 9.48 L11.33 10.57 L10.46 11.17 L9.64 11.81 L8.72 12.62 L7.69 13.64 L6.71 14.69 L5.94 15.62 L4.75 17.36 L3.69 19.25 L2.80 21.25 L2.08 23.31 L1.81 24.33 L1.55 25.51 L1.35 26.70 L1.21 27.76 L1.14 29.16 L1.15 30.80 L1.24 32.41 L1.39 33.70 L1.67 35.09 L2.04 36.50 L2.49 37.91 L3.02 39.31 L3.61 40.67 L4.26 41.99 L4.97 43.23 L5.72 44.38 L6.56 45.54 L7.44 46.63 L8.34 47.67 L9.29 48.64 L10.28 49.57 L11.31 50.45 L12.40 51.28 L13.55 52.07 L14.81 52.88 L16.12 53.64 L17.49 54.36 L18.98 55.06 L20.63 55.77 L22.46 56.50 L26.87 58.08 L29.14 58.89 L31.19 59.68 L33.06 60.47 L34.80 61.29 L36.65 62.25 L38.41 63.30 L40.08 64.42 L41.65 65.61 L43.11 66.86 L44.46 68.17 L45.69 69.54 L46.79 70.95 L47.31 71.64 L47.35 71.67 L47.27 71.49 Z M31.28 58.08 L27.97 56.53 L25.20 55.34 L23.40 54.60 L21.63 53.77 L20.15 52.98 L19.21 52.35 L17.58 50.98 L16.43 49.96 L14.91 48.50 L13.44 47.03 L12.49 46.00 L12.36 45.83 L12.38 45.83 L12.90 46.32 L15.34 48.67 L17.90 50.96 L19.18 52.02 L20.20 52.78 L21.10 53.31 L22.00 53.72 L22.72 54.03 L23.98 54.63 L25.43 55.20 L26.36 55.58 L27.82 56.27 L29.65 57.17 L29.98 57.32 L30.07 57.32 L28.74 56.52 L26.91 55.53 L25.60 54.98 L24.82 54.62 L23.84 54.08 L22.84 53.43 L22.22 52.85 L21.67 52.30 L21.01 51.75 L20.09 50.96 L18.94 49.84 L17.79 48.64 L16.87 47.58 L15.20 45.25 L13.63 42.80 L12.43 40.53 L11.38 38.39 L11.08 37.66 L11.02 37.50 L11.04 37.49 L11.70 38.75 L12.88 41.03 L14.05 43.09 L15.23 44.97 L16.44 46.67 L17.68 48.21 L18.97 49.61 L20.33 50.88 L21.75 52.04 L22.27 52.45 L22.45 52.65 L22.27 52.59 L22.17 52.53 L22.13 52.56 L22.36 52.80 L22.99 53.25 L25.18 54.58 L26.17 55.09 L26.21 55.09 L26.17 55.03 L25.82 54.77 L24.25 53.67 L23.45 53.08 L22.60 52.37 L20.30 50.24 L19.23 49.15 L18.23 48.01 L17.34 46.87 L16.57 45.75 L16.36 45.39 L16.34 45.34 L16.39 45.38 L17.25 46.50 L18.32 47.84 L19.51 49.16 L20.87 50.50 L22.45 51.92 L23.96 53.08 L26.19 54.66 L28.69 56.32 L31.01 57.77 L31.89 58.33 L31.77 58.30 L31.28 58.08 L31.28 58.08 Z M23.98 55.49 L22.01 54.68 L19.91 53.73 L17.97 52.79 L16.50 52.00 L15.24 51.21 L14.01 50.36 L12.82 49.44 L11.68 48.47 L10.58 47.45 L9.53 46.38 L8.54 45.26 L7.62 44.11 L6.89 43.09 L6.19 41.99 L5.52 40.82 L4.90 39.61 L4.34 38.39 L3.85 37.17 L3.44 35.97 L3.12 34.82 L2.80 33.32 L2.83 33.33 L2.89 33.52 L3.15 34.42 L3.84 36.67 L4.72 38.82 L5.77 40.88 L7.00 42.84 L8.41 44.71 L10.00 46.47 L11.76 48.15 L13.71 49.72 L15.82 51.18 L16.85 51.83 L17.64 52.27 L18.06 52.47 L18.18 52.49 L17.43 51.89 L16.04 50.79 L14.60 49.59 L13.31 48.45 L12.35 47.53 L12.17 47.33 L12.16 47.30 L12.20 47.33 L12.94 47.96 L15.60 50.15 L17.78 51.92 L18.80 52.73 L19.96 53.46 L21.32 54.18 L22.99 54.93 L24.56 55.61 L24.55 55.65 L24.43 55.63 L23.98 55.49 L23.98 55.49 Z M21.17 52.73 L19.93 51.86 L18.49 50.60 L17.49 49.65 L16.50 48.60 L15.52 47.46 L14.56 46.23 L13.33 44.49 L12.44 43.12 L12.40 43.00 L12.53 43.16 L13.20 44.14 L13.98 45.25 L14.88 46.40 L15.85 47.56 L16.86 48.70 L17.88 49.76 L18.88 50.72 L19.81 51.54 L20.64 52.18 L21.78 52.97 L22.16 53.25 L22.20 53.30 L22.14 53.29 L21.17 52.73 Z M20.26 49.18 L19.14 47.93 L18.12 46.67 L17.19 45.41 L16.35 44.13 L15.58 42.82 L14.89 41.48 L14.26 40.09 L13.70 38.66 L13.27 37.32 L12.90 35.90 L12.59 34.44 L12.36 32.95 L12.21 31.49 L12.14 30.07 L12.15 28.74 L12.25 27.52 L12.56 25.70 L12.71 25.00 L12.81 24.75 L12.60 25.99 L12.47 26.72 L12.40 27.38 L12.36 29.51 L12.39 31.63 L12.56 33.11 L13.00 35.38 L13.56 37.44 L14.29 39.45 L15.23 41.54 L16.43 43.76 L17.78 45.89 L19.30 47.91 L20.99 49.86 L21.21 50.15 L20.26 49.18 Z M11.81 45.13 L11.66 44.92 L11.66 44.86 L11.94 45.19 L12.10 45.46 L11.81 45.13 Z M16.05 44.96 L15.97 44.81 L15.99 44.78 L16.18 45.01 L16.24 45.19 L16.05 44.96 Z M14.92 43.12 L14.78 42.76 L15.01 43.12 L15.15 43.48 L14.92 43.12 Z M14.25 41.92 L13.61 40.68 L13.00 39.37 L12.43 38.00 L11.91 36.62 L11.44 35.22 L11.03 33.85 L10.70 32.52 L10.44 31.26 L10.33 29.95 L10.28 28.12 L10.30 26.33 L10.40 25.11 L10.50 24.63 L10.56 24.51 L10.49 25.24 L10.39 26.45 L10.37 28.08 L10.44 29.78 L10.58 31.19 L10.79 32.33 L11.06 33.52 L11.41 34.75 L11.82 36.03 L12.83 38.66 L14.07 41.34 L14.70 42.67 L14.25 41.92 Z M10.79 36.94 L10.69 36.65 L10.83 36.84 L10.93 37.13 L10.79 36.94 Z M12.27 35.62 L11.55 32.66 L11.31 30.75 L11.23 28.84 L11.31 27.00 L11.55 25.31 L11.83 24.18 L12.19 22.94 L12.54 21.96 L12.66 21.68 L12.73 21.61 L12.55 22.27 L11.99 24.22 L11.57 26.26 L11.48 27.43 L11.46 29.15 L11.50 31.06 L11.70 32.57 L12.17 34.86 L12.37 35.79 L12.27 35.62 L12.27 35.62 Z M4.61 34.40 L4.26 33.21 L3.99 31.96 L3.80 30.67 L3.68 29.37 L3.65 28.06 L3.69 26.77 L3.81 25.52 L4.02 24.32 L4.31 23.13 L4.67 21.95 L5.10 20.78 L5.59 19.64 L6.14 18.53 L6.74 17.47 L7.39 16.47 L8.08 15.53 L8.68 14.83 L9.42 14.06 L10.18 13.33 L10.86 12.76 L11.74 12.10 L11.77 12.09 L11.74 12.13 L11.45 12.39 L9.76 13.98 L9.00 14.80 L8.30 15.62 L7.67 16.46 L7.09 17.32 L6.56 18.19 L6.10 19.08 L5.32 20.76 L4.79 22.26 L4.33 23.83 L4.05 25.18 L3.92 26.58 L3.88 28.29 L3.91 29.80 L4.02 31.05 L4.22 32.28 L4.55 33.70 L4.87 35.08 L4.61 34.40 Z M6.18 31.53 L6.20 31.43 L6.24 31.47 L6.23 31.64 L6.19 31.63 L6.18 31.53 L6.18 31.53 Z M6.02 30.74 L5.86 29.77 L5.77 28.88 L5.74 27.93 L5.75 26.80 L5.83 25.42 L5.98 24.20 L6.23 23.04 L6.59 21.84 L6.97 20.87 L7.46 19.77 L7.98 18.73 L8.47 17.89 L8.99 17.14 L9.59 16.37 L10.94 14.86 L12.38 13.50 L13.10 12.91 L13.79 12.41 L14.43 12.00 L14.56 11.92 L14.57 11.94 L13.43 12.79 L12.56 13.49 L11.60 14.35 L10.69 15.27 L9.94 16.13 L9.36 16.90 L8.81 17.74 L8.30 18.60 L7.85 19.45 L7.22 20.83 L6.74 22.12 L6.36 23.40 L6.08 24.78 L5.92 26.05 L5.86 27.49 L5.90 28.93 L6.03 30.21 L6.15 31.24 L6.14 31.28 L6.11 31.22 L6.02 30.74 L6.02 30.74 Z M9.44 29.64 L9.45 29.50 L9.48 29.53 L9.48 29.80 L9.45 29.80 L9.44 29.64 L9.44 29.64 Z M9.34 28.65 L9.34 26.87 L9.47 25.21 L9.80 23.49 L10.00 22.72 L10.19 22.18 L10.28 22.01 L10.27 22.11 L9.89 23.75 L9.65 25.07 L9.51 26.35 L9.42 27.84 L9.37 28.83 L9.35 28.88 L9.34 28.65 Z M4.79 26.13 L4.89 24.95 L5.11 23.71 L5.44 22.43 L5.88 21.15 L6.41 19.88 L7.02 18.65 L7.71 17.48 L8.47 16.39 L9.66 14.97 L10.93 13.71 L11.59 13.14 L11.74 13.03 L11.77 13.03 L10.71 14.14 L9.33 15.62 L8.20 17.09 L7.26 18.63 L6.45 20.32 L5.81 21.98 L5.34 23.52 L5.01 25.10 L4.79 26.85 L4.77 26.90 L4.77 26.78 L4.79 26.13 L4.79 26.13 Z M14.30 25.76 L14.32 25.66 L14.35 25.70 L14.34 25.88 L14.31 25.86 L14.30 25.76 L14.30 25.76 Z M7.90 25.36 L7.98 24.56 L8.21 23.42 L8.48 22.32 L8.71 21.68 L8.77 21.60 L8.76 21.70 L8.46 22.88 L8.07 24.73 L7.95 25.30 L7.91 25.41 L7.90 25.36 Z M12.85 24.50 L12.87 24.40 L12.91 24.44 L12.90 24.61 L12.87 24.60 L12.85 24.50 L12.85 24.50 Z M7.26 23.53 L7.39 22.89 L7.72 21.83 L8.14 20.67 L8.54 19.74 L8.76 19.34 L8.84 19.27 L8.57 19.97 L7.76 22.13 L7.41 23.15 L7.26 23.53 L7.26 23.53 Z M8.80 21.34 L8.82 21.25 L8.85 21.29 L8.85 21.46 L8.81 21.45 L8.80 21.34 L8.80 21.34 Z M9.34 18.40 L9.99 17.38 L10.69 16.43 L10.85 16.26 L10.87 16.26 L10.83 16.33 L10.01 17.58 L9.34 18.52 L9.25 18.61 L9.34 18.40 Z M12.16 15.37 L12.48 15.08 L12.76 14.93 L12.43 15.22 L12.21 15.37 L12.16 15.37 Z M23.92 11.78 L24.09 11.78 L24.08 11.82 L23.97 11.83 L23.88 11.81 L23.92 11.78 L23.92 11.78 Z M23.82 10.79 L24.05 10.79 L24.06 10.82 L23.94 10.83 L23.81 10.82 L23.82 10.79 Z M24.32 10.69 L24.59 10.70 L24.59 10.73 L24.43 10.74 L24.29 10.72 L24.32 10.69 L24.32 10.69 Z M23.19 9.88 L23.42 9.88 L23.43 9.92 L23.30 9.93 L23.18 9.92 L23.19 9.88 Z M23.78 9.79 L24.09 9.79 L24.11 9.82 L23.94 9.83 L23.76 9.82 L23.78 9.79 Z M80.23 60.84 L83.01 58.58 L85.53 56.41 L87.69 54.39 L89.41 52.61 L91.31 50.37 L92.98 48.14 L94.43 45.89 L95.69 43.60 L96.32 42.26 L96.88 40.91 L97.37 39.54 L97.79 38.17 L98.14 36.78 L98.42 35.38 L98.63 33.98 L98.77 32.57 L98.84 31.15 L98.83 29.73 L98.76 28.31 L98.61 26.89 L98.39 25.47 L98.10 24.04 L97.74 22.63 L97.31 21.21 L96.60 19.29 L95.76 17.46 L94.81 15.72 L93.74 14.09 L92.57 12.56 L91.30 11.16 L89.93 9.87 L88.47 8.72 L87.43 8.02 L86.36 7.38 L85.25 6.81 L84.10 6.31 L82.92 5.87 L81.68 5.49 L80.40 5.18 L79.06 4.92 L77.50 4.78 L75.47 4.75 L73.40 4.81 L71.74 4.97 L70.45 5.20 L69.17 5.49 L67.90 5.83 L66.65 6.22 L65.41 6.67 L64.19 7.17 L62.98 7.71 L61.79 8.31 L60.63 8.95 L59.48 9.64 L58.36 10.38 L57.27 11.16 L56.20 11.99 L55.15 12.87 L54.14 13.79 L53.15 14.75 L51.33 16.73 L50.52 17.71 L49.77 18.71 L49.07 19.73 L48.41 20.79 L47.14 23.11 L46.48 24.52 L45.86 25.98 L45.51 26.92 L45.51 27.01 L45.67 26.76 L46.47 25.29 L46.71 24.94 L46.51 25.46 L46.11 26.40 L46.01 26.74 L46.00 26.83 L46.03 26.84 L46.11 26.68 L46.39 26.01 L47.08 24.68 L47.93 23.14 L48.71 21.84 L49.76 20.29 L50.87 18.80 L52.05 17.39 L53.29 16.04 L54.59 14.77 L55.95 13.58 L57.36 12.47 L58.82 11.44 L60.08 10.63 L60.15 10.61 L60.03 10.70 L58.78 11.60 L57.47 12.58 L56.22 13.60 L55.03 14.67 L53.89 15.78 L52.79 16.96 L51.73 18.20 L50.71 19.51 L49.70 20.90 L48.87 22.23 L47.97 23.85 L47.13 25.54 L46.49 27.05 L46.26 27.70 L46.21 27.97 L46.33 27.85 L46.60 27.30 L47.28 25.83 L48.04 24.38 L48.86 22.96 L49.75 21.59 L50.68 20.28 L51.66 19.04 L52.67 17.89 L53.70 16.84 L54.45 16.12 L53.81 16.80 L52.18 18.64 L50.72 20.54 L49.43 22.49 L48.31 24.49 L47.07 27.15 L46.66 28.17 L46.54 28.64 L46.61 28.64 L46.69 28.51 L47.49 26.80 L48.08 25.68 L48.08 25.79 L47.96 26.12 L47.78 26.55 L47.75 26.67 L48.14 26.00 L48.64 25.14 L48.64 25.19 L48.56 25.39 L48.19 26.13 L47.35 27.97 L47.04 28.76 L46.95 29.12 L47.15 28.72 L47.80 27.33 L48.17 26.66 L48.35 26.40 L47.92 27.48 L47.48 28.60 L47.65 28.34 L48.00 27.59 L48.93 25.64 L49.60 24.49 L50.52 23.06 L51.46 21.72 L52.16 20.85 L52.71 20.27 L52.28 20.81 L51.39 22.06 L50.42 23.60 L49.52 25.19 L48.84 26.56 L48.28 27.86 L48.21 28.04 L48.23 28.05 L48.85 26.83 L49.59 25.47 L50.49 24.00 L51.35 22.73 L51.98 21.98 L52.02 21.95 L52.00 22.01 L51.78 22.35 L50.69 23.99 L50.28 24.67 L50.12 25.01 L49.65 26.00 L49.05 27.21 L48.41 28.67 L47.92 29.91 L47.80 30.31 L47.78 30.48 L47.91 30.31 L48.80 28.30 L49.13 27.67 L49.31 27.43 L48.82 28.63 L48.14 30.33 L48.04 30.76 L48.07 30.96 L48.17 31.00 L48.26 30.85 L48.75 29.72 L49.13 28.96 L49.48 28.38 L49.71 27.99 L49.47 28.69 L49.14 29.46 L48.92 29.97 L48.63 30.79 L48.60 30.96 L48.64 30.99 L48.73 30.84 L49.04 30.05 L49.76 28.52 L50.53 26.96 L51.00 26.10 L51.11 26.00 L51.11 26.08 L50.85 26.73 L50.41 27.85 L50.09 28.69 L49.90 29.24 L49.93 29.25 L49.99 29.19 L50.17 28.86 L50.53 28.03 L50.71 27.54 L51.00 26.94 L51.79 25.56 L52.77 24.14 L53.77 22.93 L54.16 22.54 L54.30 22.46 L54.19 22.67 L53.81 23.12 L53.24 23.84 L52.56 24.83 L51.87 25.90 L51.32 26.87 L50.92 27.70 L51.40 26.98 L52.17 25.83 L53.14 24.54 L53.97 23.56 L54.22 23.31 L54.29 23.26 L54.32 23.29 L54.69 22.99 L55.60 22.13 L56.91 20.89 L58.16 19.83 L59.30 18.97 L60.29 18.34 L60.50 18.24 L60.52 18.23 L60.48 18.27 L59.53 18.96 L57.99 20.16 L56.47 21.52 L55.26 22.74 L54.88 23.21 L54.69 23.53 L54.50 23.92 L54.18 24.37 L53.20 25.73 L52.13 27.42 L51.14 29.16 L50.40 30.67 L49.76 32.40 L49.54 33.15 L49.47 33.54 L49.49 33.57 L49.54 33.52 L49.67 33.21 L50.31 31.67 L51.09 30.00 L52.17 28.14 L53.12 26.67 L53.29 26.47 L53.20 26.64 L52.54 27.82 L51.75 29.33 L51.04 30.78 L50.59 31.81 L50.13 33.23 L49.91 34.24 L49.93 34.25 L49.99 34.14 L50.18 33.65 L50.67 32.38 L51.26 31.10 L51.95 29.82 L52.74 28.56 L53.55 27.38 L54.32 26.39 L55.18 25.41 L56.29 24.27 L57.99 22.70 L59.72 21.34 L61.56 20.15 L63.56 19.08 L64.87 18.50 L66.20 17.99 L67.53 17.58 L68.86 17.26 L70.19 17.02 L71.50 16.88 L72.80 16.83 L74.06 16.88 L75.29 17.01 L76.42 17.19 L77.50 17.43 L78.56 17.75 L80.10 18.35 L81.54 19.08 L82.88 19.94 L84.12 20.94 L85.27 22.08 L86.31 23.34 L87.26 24.74 L88.10 26.28 L88.80 27.82 L89.33 29.34 L89.74 30.96 L90.07 32.80 L90.28 34.24 L90.24 33.20 L90.08 31.46 L89.78 29.64 L89.37 27.89 L88.88 26.40 L88.17 24.89 L87.21 23.28 L86.86 22.72 L86.78 22.57 L86.80 22.55 L87.13 22.96 L87.63 23.72 L88.65 25.51 L89.39 27.22 L89.97 29.05 L90.40 31.07 L90.70 33.34 L90.76 33.74 L90.78 33.82 L90.80 33.81 L90.80 33.24 L90.73 32.17 L90.51 29.99 L90.22 28.59 L89.81 27.10 L89.33 25.69 L88.83 24.52 L88.51 23.77 L89.14 24.92 L89.58 25.92 L90.02 27.06 L90.41 28.25 L90.72 29.37 L91.03 31.10 L91.21 32.93 L91.23 33.10 L91.24 33.08 L91.26 32.53 L91.21 31.17 L91.04 29.72 L90.75 28.22 L90.37 26.72 L89.91 25.28 L89.37 23.93 L88.78 22.73 L88.14 21.72 L87.21 20.58 L86.12 19.47 L84.90 18.42 L83.61 17.49 L81.84 16.48 L80.92 16.02 L80.29 15.76 L80.16 15.70 L80.13 15.65 L80.42 15.72 L81.07 15.97 L82.62 16.68 L83.98 17.48 L85.26 18.43 L86.47 19.51 L87.58 20.72 L88.58 22.04 L89.31 23.24 L89.79 24.31 L90.31 25.64 L90.78 27.01 L91.13 28.20 L91.46 29.90 L91.64 31.34 L91.70 31.79 L91.73 31.50 L91.71 30.75 L91.54 28.92 L91.29 27.44 L90.93 25.94 L90.51 24.56 L90.07 23.42 L89.64 22.58 L89.14 21.78 L88.50 20.93 L87.65 19.94 L86.48 18.68 L85.35 17.64 L84.18 16.74 L82.85 15.90 L82.07 15.43 L81.99 15.36 L82.05 15.35 L82.45 15.53 L83.23 15.97 L84.80 16.95 L85.53 17.52 L86.31 18.22 L87.03 18.93 L87.59 19.57 L88.56 20.72 L89.18 21.49 L89.76 22.38 L90.29 23.37 L90.77 24.46 L91.19 25.62 L91.55 26.84 L91.84 28.11 L92.05 29.42 L92.17 30.36 L92.12 29.42 L91.97 27.96 L91.68 26.35 L91.30 24.79 L90.85 23.47 L90.39 22.41 L89.89 21.41 L89.40 20.59 L88.99 20.04 L88.38 19.35 L87.58 18.40 L87.27 18.03 L87.26 17.99 L87.34 18.06 L88.30 19.09 L89.21 20.14 L89.28 20.19 L89.25 20.09 L89.20 19.91 L89.34 20.09 L90.44 21.89 L91.06 23.16 L91.63 24.70 L92.10 26.33 L92.41 27.87 L92.53 28.74 L92.50 27.93 L92.31 26.31 L91.90 24.51 L91.65 23.65 L91.37 22.87 L90.45 20.88 L89.74 19.34 L89.52 18.80 L89.29 18.25 L89.18 18.02 L88.89 17.59 L87.97 16.41 L86.80 15.18 L85.48 14.03 L84.02 12.99 L82.49 12.09 L81.60 11.59 L81.78 11.64 L82.38 11.91 L83.52 12.53 L84.73 13.33 L85.96 14.29 L87.16 15.35 L87.83 16.04 L88.49 16.79 L89.01 17.44 L89.27 17.87 L90.22 19.72 L91.20 21.67 L91.88 23.29 L92.40 24.94 L92.89 26.98 L92.96 27.22 L92.93 26.76 L92.77 25.61 L92.47 24.29 L92.05 22.90 L91.55 21.57 L90.38 19.07 L89.26 16.93 L88.86 16.35 L88.37 15.71 L87.13 14.35 L85.98 13.29 L84.78 12.35 L83.48 11.52 L82.04 10.74 L80.88 10.14 L81.13 10.23 L81.93 10.59 L83.48 11.38 L84.86 12.25 L86.17 13.29 L87.54 14.58 L88.48 15.55 L89.13 16.32 L89.66 17.13 L90.24 18.19 L91.64 20.94 L92.31 22.55 L92.78 23.71 L92.73 23.41 L92.53 22.74 L91.94 21.05 L91.33 19.64 L90.60 18.24 L90.44 17.90 L90.37 17.66 L90.42 17.55 L90.55 17.65 L91.09 18.50 L91.53 19.18 L91.23 18.52 L90.71 17.68 L89.92 16.57 L89.03 15.40 L88.21 14.41 L87.13 13.28 L86.00 12.25 L84.81 11.33 L83.57 10.51 L82.28 9.79 L80.93 9.18 L79.53 8.67 L78.07 8.27 L77.42 8.10 L77.46 8.08 L77.71 8.10 L78.51 8.23 L79.39 8.45 L80.33 8.76 L81.31 9.15 L82.29 9.59 L83.26 10.10 L84.20 10.65 L85.07 11.23 L86.41 12.30 L87.79 13.58 L88.99 14.85 L89.81 15.92 L90.01 16.21 L90.10 16.27 L90.13 16.19 L90.26 16.27 L90.37 16.34 L90.33 16.25 L89.33 14.84 L88.04 13.17 L87.32 12.37 L86.54 11.61 L85.70 10.90 L84.81 10.23 L83.87 9.61 L82.90 9.06 L81.91 8.56 L80.89 8.14 L80.13 7.81 L80.45 7.87 L81.14 8.12 L82.82 8.86 L83.76 9.37 L84.68 9.94 L85.58 10.58 L86.50 11.30 L88.03 12.74 L88.75 13.50 L89.26 14.11 L89.43 14.32 L89.47 14.32 L89.19 13.85 L88.06 12.39 L86.81 10.98 L85.66 9.94 L84.36 8.97 L82.97 8.13 L81.56 7.45 L80.98 7.19 L80.87 7.13 L80.88 7.11 L81.95 7.48 L83.01 7.95 L84.06 8.49 L85.08 9.11 L86.05 9.80 L86.98 10.54 L87.84 11.34 L88.64 12.18 L89.35 13.05 L90.26 14.34 L91.04 15.69 L91.74 17.07 L92.34 18.46 L92.85 19.88 L93.26 21.33 L93.57 22.81 L93.80 24.33 L93.93 25.89 L93.98 27.49 L93.89 29.92 L93.77 31.10 L93.60 32.26 L93.37 33.44 L93.08 34.65 L92.32 37.21 L91.85 38.55 L91.39 39.75 L90.14 42.47 L89.38 44.09 L89.45 44.03 L89.62 43.79 L89.94 43.35 L89.97 43.36 L89.90 43.52 L89.62 44.14 L89.51 44.47 L90.89 42.26 L91.70 40.71 L92.59 38.77 L93.15 37.57 L92.77 38.67 L91.92 40.72 L91.21 42.22 L90.40 43.77 L89.51 45.35 L88.55 46.93 L88.25 47.45 L88.14 47.73 L88.42 47.41 L89.07 46.50 L90.77 43.95 L91.90 41.93 L92.90 39.85 L93.23 39.18 L93.17 39.46 L92.92 40.09 L92.03 42.03 L90.96 44.15 L90.11 45.64 L87.90 49.02 L87.74 49.29 L87.93 49.07 L88.82 47.86 L89.78 46.63 L89.95 46.42 L89.97 46.27 L89.94 46.20 L90.00 46.22 L90.11 46.19 L90.25 46.03 L91.34 44.38 L91.00 45.08 L90.78 45.52 L90.75 45.61 L90.78 45.60 L91.28 44.69 L92.17 42.93 L93.66 39.78 L94.32 37.94 L94.56 37.27 L94.68 37.05 L94.33 38.30 L93.63 40.25 L92.85 42.01 L91.86 44.06 L90.60 46.44 L89.33 48.57 L89.01 49.02 L89.37 48.64 L90.53 47.05 L91.93 44.92 L92.63 43.68 L93.29 42.37 L93.91 41.00 L94.47 39.61 L94.97 38.21 L95.39 36.84 L95.72 35.51 L95.97 34.26 L96.12 33.60 L96.14 33.80 L96.08 34.25 L95.81 35.68 L95.39 37.40 L94.94 38.97 L94.48 40.27 L93.93 41.66 L93.39 42.92 L92.95 43.79 L92.35 44.92 L91.83 45.86 L91.09 47.04 L89.54 49.32 L88.89 50.24 L89.42 49.63 L90.43 48.38 L91.74 46.53 L93.02 44.44 L94.17 42.28 L95.09 40.23 L95.70 38.52 L96.24 36.68 L96.67 34.85 L96.95 33.11 L97.19 31.34 L97.20 31.31 L97.20 31.41 L97.18 31.95 L97.03 33.56 L96.71 35.40 L96.27 37.31 L95.72 39.15 L95.24 40.51 L94.71 41.82 L94.14 43.10 L93.52 44.34 L92.84 45.56 L92.12 46.75 L91.33 47.93 L90.49 49.09 L89.87 49.97 L90.19 49.62 L90.85 48.76 L92.40 46.59 L93.42 45.02 L94.28 43.54 L95.03 42.07 L95.72 40.54 L96.45 38.62 L97.03 36.74 L97.47 34.78 L97.81 32.63 L97.89 32.08 L97.92 31.98 L97.94 32.03 L97.87 33.02 L97.66 34.49 L97.37 36.10 L97.03 37.53 L96.49 39.34 L95.82 41.14 L95.04 42.93 L94.14 44.70 L93.12 46.44 L92.00 48.16 L90.77 49.85 L89.44 51.50 L88.31 52.75 L86.80 54.30 L85.09 55.98 L83.39 57.57 L78.47 62.12 L78.16 62.44 L78.56 62.13 L80.23 60.84 L80.23 60.84 Z M48.15 30.72 L48.43 29.94 L48.60 29.58 L48.70 29.45 L48.59 29.79 L48.26 30.54 L48.16 30.78 L48.14 30.79 L48.15 30.72 Z M97.24 30.63 L97.26 30.49 L97.29 30.52 L97.28 30.79 L97.25 30.79 L97.24 30.63 L97.24 30.63 Z M54.22 25.13 L55.29 23.69 L56.31 22.61 L57.23 21.71 L56.40 22.61 L55.08 24.14 L54.32 25.08 L54.14 25.27 L54.22 25.13 Z M95.11 23.67 L94.83 22.16 L94.47 20.67 L94.01 19.21 L93.47 17.78 L92.85 16.40 L92.15 15.07 L91.37 13.81 L90.53 12.61 L89.07 10.94 L88.37 10.15 L89.15 10.84 L90.34 12.09 L91.43 13.48 L92.40 15.02 L93.25 16.67 L93.97 18.43 L94.56 20.28 L95.00 22.20 L95.29 24.16 L95.33 24.64 L95.32 24.72 L95.30 24.69 L95.11 23.67 Z M49.46 23.49 L49.94 22.74 L50.22 22.38 L49.80 23.11 L49.31 23.81 L49.27 23.84 L49.28 23.80 L49.46 23.49 Z M52.56 23.65 L53.29 22.63 L54.41 21.33 L55.71 20.01 L56.93 18.91 L57.74 18.29 L57.76 18.28 L57.72 18.33 L57.47 18.55 L56.62 19.36 L55.33 20.66 L53.26 22.88 L52.65 23.62 L52.54 23.72 L52.56 23.65 Z M54.50 22.38 L54.66 22.12 L55.06 21.66 L55.79 20.96 L55.84 20.93 L55.81 20.98 L55.53 21.30 L54.79 22.16 L54.59 22.37 L54.52 22.41 L54.50 22.38 Z M83.93 18.82 L82.85 18.14 L81.70 17.55 L80.49 17.04 L79.22 16.61 L77.89 16.26 L76.52 16.00 L75.10 15.82 L73.65 15.74 L71.72 15.77 L69.83 15.97 L67.94 16.36 L65.99 16.93 L64.52 17.38 L64.81 17.23 L65.61 16.92 L67.53 16.30 L69.12 15.92 L70.70 15.68 L72.28 15.57 L73.92 15.58 L75.40 15.67 L76.76 15.83 L78.04 16.06 L79.23 16.36 L80.36 16.74 L81.44 17.20 L82.49 17.74 L83.52 18.38 L84.54 19.08 L84.74 19.26 L84.74 19.31 L83.93 18.82 Z M88.84 18.66 L87.74 17.36 L86.58 16.12 L85.69 15.35 L84.71 14.60 L83.72 13.94 L82.81 13.42 L82.49 13.23 L82.38 13.13 L82.72 13.26 L83.45 13.67 L84.33 14.22 L85.11 14.77 L86.27 15.72 L87.37 16.75 L88.30 17.75 L88.97 18.62 L89.09 18.83 L89.09 18.91 L89.00 18.86 L88.84 18.66 Z M53.23 18.57 L53.53 18.28 L53.82 18.01 L53.55 18.31 L53.30 18.57 L53.25 18.60 L53.23 18.57 Z M54.41 17.28 L55.80 15.96 L56.02 15.79 L56.03 15.79 L55.98 15.84 L55.20 16.65 L53.81 17.97 L53.95 17.77 L54.41 17.28 Z M86.18 16.97 L85.44 16.37 L84.60 15.76 L83.71 15.19 L82.80 14.68 L81.97 14.20 L82.90 14.61 L83.79 15.10 L84.69 15.68 L85.54 16.30 L86.27 16.93 L86.95 17.60 L86.18 16.97 Z M56.62 17.00 L57.96 15.83 L59.63 14.61 L61.21 13.61 L61.76 13.30 L61.98 13.22 L61.05 13.82 L59.13 15.10 L57.20 16.60 L56.51 17.15 L56.46 17.16 L56.62 17.00 Z M89.92 15.97 L89.85 15.81 L89.98 15.91 L90.07 16.04 L90.08 16.12 L90.01 16.10 L89.92 15.97 Z M81.81 12.92 L81.61 12.80 L81.58 12.75 L81.99 12.92 L82.19 13.04 L82.22 13.09 L81.81 12.92 Z M81.18 12.65 L81.11 12.59 L81.13 12.56 L81.36 12.65 L81.43 12.71 L81.40 12.74 L81.18 12.65 Z M79.92 9.85 L79.85 9.79 L79.87 9.77 L80.10 9.85 L80.17 9.92 L80.14 9.94 L79.92 9.85 Z M21.68 58.23 L21.43 58.04 L21.19 57.89 L21.40 58.08 L21.62 58.25 L21.67 58.26 L21.68 58.23 Z M89.66 50.26 L89.74 50.15 L89.63 50.23 L89.48 50.37 L89.47 50.41 L89.51 50.42 L89.66 50.26 L89.66 50.26 Z M88.58 49.09 L88.66 48.98 L88.55 49.06 L88.40 49.20 L88.39 49.23 L88.43 49.25 L88.58 49.09 L88.58 49.09 Z M89.14 48.32 L89.56 47.62 L89.47 47.71 L89.18 48.09 L88.76 48.69 L88.70 48.84 L88.74 48.85 L89.14 48.32 Z M90.02 46.98 L90.08 46.85 L90.02 46.85 L89.82 47.10 L89.77 47.23 L89.82 47.23 L90.02 46.98 Z M54.73 37.44 L54.99 36.44 L55.30 35.41 L56.12 33.30 L57.15 31.16 L58.36 29.04 L59.72 26.98 L61.20 25.04 L62.78 23.27 L63.59 22.46 L64.41 21.71 L64.67 21.47 L64.67 21.45 L64.59 21.49 L63.78 22.11 L62.18 23.53 L60.67 25.08 L59.28 26.73 L58.02 28.45 L57.53 29.12 L57.49 29.15 L57.50 29.10 L57.66 28.81 L58.77 27.12 L60.11 25.38 L61.52 23.75 L62.85 22.43 L63.99 21.38 L63.99 21.36 L63.88 21.43 L63.33 21.84 L62.08 22.88 L60.81 24.09 L59.59 25.38 L58.47 26.71 L57.66 27.70 L57.66 27.68 L57.73 27.56 L58.08 27.02 L59.00 25.76 L60.09 24.44 L61.29 23.15 L62.52 21.98 L62.91 21.62 L62.97 21.55 L62.94 21.55 L61.98 22.29 L60.77 23.36 L59.47 24.67 L58.24 26.06 L57.23 27.36 L56.72 28.03 L56.69 28.05 L56.71 28.00 L56.86 27.70 L57.49 26.74 L58.39 25.55 L59.43 24.29 L60.49 23.11 L61.02 22.55 L61.15 22.37 L60.22 23.16 L59.27 24.08 L58.21 25.21 L57.34 26.20 L57.00 26.70 L57.00 26.79 L56.95 26.73 L56.90 26.71 L56.82 26.74 L56.59 26.95 L55.89 27.88 L55.03 29.25 L54.17 30.81 L53.26 32.81 L52.97 33.56 L52.90 33.89 L53.27 33.04 L53.63 32.20 L54.07 31.32 L55.11 29.52 L56.50 27.39 L56.81 27.01 L56.40 27.76 L55.46 29.36 L54.61 30.98 L53.90 32.54 L53.36 33.94 L52.94 35.35 L52.94 35.39 L53.00 35.28 L53.26 34.60 L53.97 32.79 L54.21 32.27 L54.37 32.03 L54.50 31.80 L54.64 31.57 L54.70 31.53 L54.72 31.56 L54.59 31.83 L54.29 32.56 L53.90 33.62 L53.27 35.70 L53.07 36.76 L53.09 36.75 L53.14 36.64 L53.32 36.04 L53.74 34.68 L54.32 33.20 L54.69 32.31 L54.81 32.14 L54.50 33.21 L54.06 34.60 L53.73 35.89 L53.50 37.10 L53.38 38.21 L53.33 39.02 L53.45 38.21 L53.76 36.49 L54.13 35.09 L54.66 33.67 L54.88 33.14 L55.00 32.96 L54.77 33.74 L54.30 35.33 L53.97 36.94 L53.81 38.60 L53.78 39.32 L53.81 39.59 L53.95 38.64 L54.18 37.02 L54.67 35.28 L54.96 34.43 L55.18 33.92 L55.27 33.80 L55.25 33.88 L54.81 35.42 L54.45 37.03 L54.36 37.95 L54.33 39.02 L54.34 40.19 L54.42 39.33 L54.73 37.44 L54.73 37.44 Z M54.95 31.57 L55.10 31.12 L55.46 30.33 L55.84 29.57 L56.07 29.24 L55.68 30.11 L55.11 31.31 L54.95 31.57 Z M57.34 28.12 L57.53 27.88 L57.47 28.06 L57.28 28.29 L57.26 28.27 L57.34 28.12 Z M53.02 37.15 L52.99 37.13 L52.98 37.26 L52.99 37.38 L53.02 37.37 L53.02 37.15 Z M18.21 34.61 L18.66 33.16 L19.25 31.75 L19.97 30.40 L20.80 29.13 L21.75 27.93 L22.81 26.83 L23.96 25.83 L25.20 24.95 L26.54 24.20 L28.08 23.52 L29.71 22.96 L31.33 22.55 L32.54 22.38 L34.39 22.34 L36.22 22.38 L37.34 22.55 L38.69 22.90 L39.96 23.35 L41.17 23.91 L42.37 24.59 L42.84 24.87 L42.98 24.90 L42.79 24.71 L42.28 24.29 L41.33 23.53 L40.89 23.21 L40.29 22.86 L38.72 22.15 L38.19 21.93 L38.08 21.87 L38.09 21.86 L39.09 22.17 L40.03 22.53 L40.90 22.96 L41.81 23.51 L42.87 24.24 L43.27 24.51 L43.30 24.50 L43.23 24.41 L42.16 23.52 L40.88 22.58 L39.85 21.95 L38.79 21.50 L37.44 21.08 L36.50 20.78 L37.37 20.94 L38.52 21.27 L39.62 21.67 L40.58 22.12 L41.29 22.57 L42.04 23.10 L43.66 24.15 L43.86 24.25 L42.64 23.28 L41.80 22.61 L41.47 22.29 L41.43 22.18 L41.23 22.02 L40.45 21.58 L39.36 21.08 L38.16 20.64 L36.42 20.18 L34.57 19.85 L34.00 19.76 L33.86 19.72 L33.84 19.70 L34.29 19.70 L35.11 19.80 L37.08 20.18 L38.44 20.57 L39.75 21.04 L41.00 21.58 L42.17 22.19 L42.51 22.32 L42.30 22.05 L42.03 21.84 L41.30 21.44 L40.32 20.91 L39.26 20.43 L38.08 20.00 L36.74 19.60 L36.56 19.54 L36.53 19.52 L36.56 19.51 L37.69 19.78 L39.31 20.30 L40.41 20.75 L41.60 21.34 L42.66 21.92 L43.36 22.38 L43.93 22.79 L43.46 22.28 L42.76 21.69 L42.01 21.15 L41.21 20.65 L40.36 20.19 L39.46 19.78 L38.51 19.42 L37.51 19.10 L36.46 18.83 L35.88 18.68 L35.76 18.63 L35.76 18.61 L36.78 18.77 L37.63 18.98 L38.53 19.26 L40.39 19.97 L42.18 20.83 L43.75 21.77 L44.08 21.99 L44.12 22.00 L44.09 21.96 L43.25 21.28 L42.20 20.54 L41.13 19.88 L40.03 19.30 L38.90 18.82 L37.74 18.41 L36.54 18.09 L35.31 17.86 L34.03 17.70 L33.27 17.63 L33.89 17.62 L34.99 17.68 L36.32 17.90 L37.75 18.24 L39.15 18.68 L40.37 19.16 L41.52 19.70 L42.68 20.35 L43.93 21.14 L44.58 21.54 L43.48 20.68 L41.79 19.50 L41.03 19.05 L40.22 18.64 L38.50 17.92 L36.68 17.38 L34.80 17.02 L33.63 16.91 L32.23 16.91 L30.52 17.02 L30.37 17.05 L30.43 16.99 L30.88 16.87 L31.70 16.78 L32.67 16.73 L33.58 16.74 L35.00 16.88 L36.42 17.14 L37.83 17.50 L39.23 17.96 L40.60 18.52 L41.94 19.19 L43.22 19.94 L44.44 20.78 L44.66 20.92 L44.35 20.63 L43.79 20.15 L43.08 19.64 L41.38 18.60 L39.53 17.64 L38.64 17.25 L37.82 16.94 L36.40 16.55 L34.87 16.26 L33.37 16.11 L32.05 16.10 L31.49 16.12 L31.41 16.10 L31.45 16.06 L32.06 16.00 L33.23 16.01 L34.55 16.08 L35.57 16.20 L36.88 16.48 L38.16 16.83 L39.42 17.26 L40.63 17.76 L41.80 18.32 L42.92 18.94 L43.96 19.62 L44.94 20.36 L45.71 20.98 L45.28 20.48 L44.63 19.79 L43.86 19.11 L43.00 18.44 L42.06 17.81 L41.07 17.23 L40.04 16.70 L39.00 16.24 L37.95 15.87 L36.01 15.34 L34.11 15.03 L33.18 14.96 L32.27 14.93 L31.36 14.96 L30.46 15.04 L29.58 15.18 L28.71 15.37 L27.85 15.61 L27.00 15.91 L26.16 16.25 L25.33 16.66 L24.51 17.11 L23.70 17.62 L22.80 18.30 L21.81 19.19 L20.86 20.15 L20.11 21.03 L19.86 21.37 L19.83 21.44 L19.86 21.43 L20.77 20.64 L21.63 19.91 L22.50 19.25 L23.49 18.61 L24.69 17.93 L25.18 17.68 L25.33 17.64 L25.15 17.80 L24.64 18.11 L23.80 18.64 L22.98 19.22 L22.19 19.86 L21.44 20.53 L20.72 21.25 L20.05 22.01 L19.42 22.79 L18.85 23.60 L17.91 25.20 L17.52 25.95 L17.40 26.26 L18.04 25.25 L18.69 24.25 L19.41 23.29 L20.22 22.37 L21.11 21.50 L22.06 20.68 L23.08 19.92 L24.15 19.21 L25.29 18.57 L26.87 17.86 L27.56 17.61 L27.98 17.52 L27.99 17.54 L27.91 17.59 L27.54 17.74 L26.56 18.12 L25.58 18.57 L24.63 19.08 L23.72 19.64 L22.85 20.24 L22.05 20.88 L21.32 21.54 L20.68 22.21 L19.87 23.23 L19.05 24.41 L18.25 25.74 L17.46 27.23 L17.23 27.71 L17.19 27.81 L17.21 27.81 L17.79 26.89 L18.53 25.71 L19.21 24.72 L19.89 23.88 L20.59 23.12 L21.61 22.17 L22.65 21.31 L23.65 20.58 L24.54 20.05 L24.85 19.91 L24.91 19.89 L24.89 19.92 L24.18 20.40 L23.18 21.09 L22.26 21.82 L21.39 22.62 L20.59 23.50 L19.83 24.46 L19.12 25.51 L18.43 26.67 L17.76 27.95 L17.59 28.33 L17.57 28.40 L17.59 28.40 L18.04 27.68 L18.56 26.83 L19.13 26.01 L19.77 25.23 L20.46 24.47 L21.39 23.58 L22.43 22.67 L23.30 21.99 L23.58 21.81 L23.71 21.77 L22.88 22.47 L22.08 23.17 L21.23 23.99 L20.47 24.80 L19.96 25.46 L19.07 26.84 L18.46 27.93 L17.97 29.00 L17.77 29.60 L18.08 29.03 L18.57 28.14 L19.12 27.27 L19.74 26.43 L20.41 25.62 L21.13 24.85 L21.89 24.13 L22.70 23.47 L23.53 22.87 L24.67 22.17 L25.34 21.86 L24.77 22.25 L23.64 23.03 L22.41 24.08 L21.24 25.26 L20.26 26.42 L19.69 27.27 L19.11 28.27 L18.57 29.32 L18.13 30.34 L17.72 31.51 L17.76 31.51 L17.82 31.35 L18.58 29.73 L19.06 28.80 L19.59 27.94 L20.15 27.13 L20.76 26.37 L21.42 25.66 L22.14 24.99 L22.92 24.36 L23.76 23.76 L25.05 22.97 L25.60 22.68 L25.83 22.59 L25.15 23.06 L24.15 23.73 L23.22 24.44 L22.37 25.19 L21.58 26.00 L20.85 26.86 L20.19 27.78 L19.58 28.76 L19.03 29.81 L18.63 30.73 L18.22 31.78 L17.92 32.67 L17.83 33.12 L17.92 32.97 L18.11 32.47 L18.89 30.61 L19.52 29.41 L20.21 28.29 L20.98 27.26 L21.83 26.31 L22.75 25.44 L23.75 24.65 L24.83 23.94 L25.98 23.30 L27.53 22.62 L28.80 22.16 L29.03 22.11 L28.80 22.22 L27.63 22.74 L26.79 23.14 L25.98 23.58 L24.44 24.58 L23.04 25.73 L21.78 27.03 L20.66 28.45 L19.71 29.99 L18.94 31.64 L18.62 32.49 L18.34 33.37 L17.91 35.22 L17.77 36.00 L17.73 36.52 L17.74 36.64 L17.76 36.63 L17.86 36.18 L18.21 34.61 Z M36.00 20.70 L36.17 20.71 L36.16 20.74 L36.05 20.75 L35.96 20.74 L36.00 20.70 L36.00 20.70 Z M35.99 19.44 L36.22 19.44 L36.23 19.47 L36.11 19.49 L35.98 19.47 L35.99 19.44 Z M34.96 18.54 L35.23 18.54 L35.23 18.57 L35.07 18.58 L34.92 18.57 L34.96 18.54 L34.96 18.54 Z M53.41 31.21 L54.18 29.99 L55.44 28.10 L56.12 27.21 L57.20 25.93 L59.44 23.42 L59.84 22.97 L59.90 22.88 L59.85 22.90 L59.23 23.47 L58.21 24.51 L56.41 26.47 L55.06 28.24 L53.87 30.19 L53.16 31.45 L53.09 31.63 L53.23 31.49 L53.41 31.21 Z M54.42 28.33 L54.60 28.02 L54.37 28.28 L53.63 29.45 L53.00 30.63 L53.03 30.62 L53.12 30.48 L53.47 29.93 L54.42 28.33 Z M52.60 26.04 L53.84 24.43 L54.51 23.58 L54.63 23.35 L54.62 23.31 L54.58 23.30 L54.12 23.76 L53.33 24.77 L52.47 25.98 L51.80 27.03 L51.69 27.24 L51.78 27.16 L52.60 26.04 Z M56.03 26.44 L56.08 26.31 L56.05 26.26 L55.87 26.44 L55.81 26.57 L55.84 26.62 L56.03 26.44 L56.03 26.44 Z M56.74 25.55 L57.14 25.04 L56.80 25.36 L56.30 25.91 L56.19 26.08 L56.18 26.12 L56.23 26.12 L56.74 25.55 Z M43.11 22.99 L42.72 22.68 L42.31 22.42 L42.00 22.26 L41.91 22.25 L41.88 22.28 L42.70 22.89 L43.59 23.46 L43.11 22.99 Z M38.63 14.63 L38.40 14.54 L38.38 14.57 L38.45 14.63 L38.67 14.72 L38.70 14.69 L38.63 14.63 Z M30.76 8.54 L30.59 8.53 L30.55 8.57 L30.64 8.58 L30.75 8.57 L30.76 8.54 L30.76 8.54 Z M30.40 8.45 L30.23 8.44 L30.19 8.48 L30.28 8.49 L30.39 8.48 L30.40 8.45 L30.40 8.45 Z M30.00 8.35 L29.77 8.35 L29.76 8.38 L29.89 8.40 L30.01 8.38 L30.00 8.35 Z' },
    { id: 'heart_full', label: 'לב', defaultWidthMm: 24, fillRule: 'evenodd',
      d: 'M47.47 16.32 L48.80 17.82 L50.00 19.42 L51.20 17.82 L52.53 16.32 L55.51 13.54 L58.81 11.13 L62.55 9.05 L66.54 7.48 L70.13 6.62 L73.80 6.34 L77.57 6.60 L81.26 7.39 L84.80 8.68 L87.98 10.39 L90.88 12.55 L93.42 15.11 L95.55 17.95 L97.28 21.06 L98.57 24.36 L99.51 28.12 L99.99 31.97 L100.00 35.84 L99.46 39.94 L98.35 43.92 L96.29 48.86 L93.71 53.54 L91.18 57.32 L88.40 60.93 L84.51 65.42 L80.39 69.70 L77.03 72.93 L73.57 76.05 L69.16 79.80 L64.67 83.44 L62.26 85.31 L59.84 87.16 L55.45 90.42 L51.04 93.66 L50.86 93.78 L50.66 93.87 L50.44 93.94 L50.22 93.98 L50.00 94.00 L49.78 93.99 L49.56 93.94 L49.35 93.88 L49.15 93.78 L48.96 93.66 L44.65 90.51 L40.36 87.33 L37.81 85.40 L35.30 83.44 L30.81 79.81 L26.41 76.07 L22.94 72.94 L19.57 69.70 L15.47 65.42 L11.58 60.93 L8.80 57.33 L6.28 53.54 L3.70 48.86 L1.64 43.93 L0.53 39.94 L0.00 35.84 L0.01 31.97 L0.49 28.12 L1.43 24.36 L2.72 21.06 L4.45 17.95 L6.58 15.11 L9.12 12.55 L12.02 10.39 L15.20 8.68 L18.74 7.39 L22.43 6.60 L26.20 6.34 L29.87 6.62 L33.46 7.48 L37.45 9.05 L41.19 11.13 L44.49 13.54 L47.47 16.32 Z' },
    { id: 'crown', label: 'כתר', defaultWidthMm: 30, fillRule: 'evenodd',
      d: 'M70.93 29.53 L71.17 29.52 L71.40 29.47 L71.63 29.39 L71.85 29.29 L72.05 29.16 L72.23 29.00 L72.39 28.82 L72.65 28.46 L72.84 28.06 L72.99 27.65 L73.08 27.21 L73.11 26.77 L73.08 26.33 L72.99 25.90 L72.84 25.48 L72.65 25.09 L72.40 24.72 L72.23 24.54 L72.05 24.39 L71.85 24.25 L71.63 24.15 L71.40 24.07 L71.17 24.03 L70.93 24.01 L70.69 24.03 L70.45 24.07 L70.22 24.15 L70.00 24.26 L69.80 24.39 L69.62 24.54 L69.46 24.72 L69.21 25.09 L69.01 25.48 L68.86 25.90 L68.78 26.33 L68.75 26.77 L68.78 27.21 L68.87 27.65 L69.01 28.06 L69.21 28.46 L69.46 28.82 L69.62 29.00 L69.80 29.16 L70.00 29.29 L70.22 29.39 L70.45 29.47 L70.69 29.52 L70.93 29.53 Z M97.82 36.89 L97.58 36.90 L97.34 36.95 L97.11 37.02 L96.90 37.13 L96.70 37.26 L96.51 37.42 L96.35 37.60 L96.10 37.96 L95.90 38.35 L95.76 38.77 L95.67 39.20 L95.64 39.64 L95.67 40.09 L95.76 40.52 L95.90 40.94 L96.10 41.33 L96.35 41.69 L96.51 41.87 L96.70 42.03 L96.90 42.16 L97.11 42.27 L97.34 42.34 L97.58 42.39 L97.82 42.41 L98.06 42.39 L98.30 42.34 L98.53 42.27 L98.74 42.16 L98.94 42.03 L99.13 41.87 L99.29 41.69 L99.54 41.33 L99.74 40.94 L99.88 40.52 L99.97 40.09 L100.00 39.64 L99.97 39.20 L99.88 38.77 L99.74 38.35 L99.54 37.96 L99.29 37.60 L99.13 37.42 L98.94 37.26 L98.74 37.13 L98.53 37.02 L98.30 36.95 L98.06 36.90 L97.82 36.89 Z M50.00 25.78 L50.24 25.76 L50.47 25.71 L50.70 25.63 L50.91 25.52 L51.11 25.39 L51.29 25.23 L51.45 25.05 L51.69 24.69 L51.89 24.30 L52.03 23.88 L52.11 23.46 L52.14 23.02 L52.11 22.58 L52.03 22.15 L51.89 21.74 L51.69 21.35 L51.45 20.99 L51.29 20.81 L51.11 20.65 L50.91 20.52 L50.70 20.41 L50.47 20.33 L50.24 20.28 L50.00 20.26 L49.76 20.28 L49.53 20.33 L49.30 20.41 L49.09 20.52 L48.89 20.65 L48.71 20.81 L48.55 20.99 L48.31 21.35 L48.11 21.74 L47.97 22.15 L47.89 22.58 L47.86 23.02 L47.89 23.46 L47.97 23.88 L48.11 24.30 L48.31 24.69 L48.55 25.05 L48.71 25.23 L48.89 25.39 L49.09 25.52 L49.30 25.63 L49.53 25.71 L49.76 25.76 L50.00 25.78 Z M86.49 35.30 L86.73 35.28 L86.97 35.24 L87.20 35.16 L87.41 35.06 L87.61 34.92 L87.80 34.77 L87.96 34.59 L88.21 34.22 L88.41 33.83 L88.55 33.41 L88.64 32.98 L88.67 32.54 L88.64 32.10 L88.55 31.67 L88.41 31.25 L88.21 30.85 L87.96 30.49 L87.80 30.31 L87.61 30.16 L87.41 30.02 L87.20 29.92 L86.97 29.84 L86.73 29.80 L86.49 29.78 L86.25 29.80 L86.01 29.84 L85.78 29.92 L85.57 30.02 L85.37 30.16 L85.18 30.31 L85.02 30.49 L84.77 30.86 L84.57 31.25 L84.43 31.67 L84.34 32.10 L84.31 32.54 L84.34 32.98 L84.43 33.41 L84.57 33.83 L84.77 34.22 L85.02 34.59 L85.18 34.77 L85.37 34.92 L85.57 35.06 L85.78 35.16 L86.01 35.24 L86.25 35.28 L86.49 35.30 Z M29.07 29.53 L29.31 29.52 L29.55 29.47 L29.78 29.39 L29.99 29.29 L30.20 29.16 L30.38 29.00 L30.54 28.82 L30.79 28.46 L30.99 28.06 L31.13 27.65 L31.22 27.21 L31.25 26.77 L31.22 26.33 L31.14 25.90 L30.99 25.48 L30.79 25.09 L30.54 24.72 L30.38 24.54 L30.20 24.39 L30.00 24.25 L29.78 24.15 L29.55 24.07 L29.31 24.03 L29.07 24.01 L28.83 24.03 L28.60 24.07 L28.37 24.15 L28.15 24.26 L27.95 24.39 L27.76 24.54 L27.60 24.72 L27.35 25.09 L27.15 25.48 L27.01 25.90 L26.92 26.33 L26.89 26.77 L26.92 27.21 L27.01 27.65 L27.16 28.06 L27.35 28.46 L27.60 28.82 L27.77 29.00 L27.95 29.16 L28.15 29.29 L28.37 29.39 L28.60 29.47 L28.83 29.52 L29.07 29.53 Z M17.85 78.38 L17.77 78.44 L17.69 78.51 L17.63 78.58 L17.58 78.66 L17.53 78.75 L17.50 78.84 L17.48 78.94 L17.47 79.03 L17.47 79.13 L17.49 79.23 L17.52 79.32 L17.54 79.39 L17.57 79.46 L17.61 79.52 L17.65 79.58 L17.71 79.63 L17.77 79.68 L17.83 79.71 L17.90 79.74 L17.97 79.76 L18.04 79.77 L18.12 79.77 L18.19 79.76 L18.26 79.74 L19.36 79.23 L20.48 78.76 L21.60 78.35 L22.73 77.99 L24.94 77.35 L27.17 76.76 L29.40 76.22 L31.63 75.73 L34.14 75.23 L36.67 74.80 L39.19 74.42 L41.71 74.10 L45.85 73.74 L50.00 73.62 L54.15 73.74 L58.28 74.10 L60.81 74.42 L63.33 74.80 L65.86 75.23 L68.37 75.73 L70.60 76.22 L72.83 76.76 L75.06 77.35 L77.27 77.99 L78.40 78.35 L79.52 78.76 L80.64 79.23 L81.74 79.74 L81.81 79.76 L81.88 79.77 L81.96 79.77 L82.03 79.76 L82.10 79.74 L82.17 79.71 L82.23 79.68 L82.29 79.63 L82.35 79.58 L82.39 79.52 L82.43 79.46 L82.46 79.39 L82.48 79.32 L82.51 79.23 L82.53 79.13 L82.53 79.03 L82.52 78.94 L82.50 78.84 L82.47 78.75 L82.42 78.66 L82.37 78.58 L82.31 78.51 L82.23 78.44 L82.15 78.38 L81.03 77.87 L79.89 77.39 L78.76 76.98 L77.61 76.61 L75.37 75.96 L73.11 75.36 L70.85 74.81 L68.59 74.31 L66.04 73.81 L63.49 73.36 L60.93 72.98 L58.37 72.65 L54.19 72.29 L50.00 72.17 L45.81 72.29 L41.63 72.65 L39.07 72.98 L36.51 73.36 L33.95 73.81 L31.41 74.31 L29.14 74.81 L26.89 75.36 L24.63 75.96 L22.39 76.61 L21.24 76.98 L20.11 77.39 L18.97 77.87 L17.85 78.38 Z M2.18 36.89 L1.94 36.90 L1.70 36.95 L1.47 37.02 L1.26 37.13 L1.06 37.26 L0.87 37.42 L0.71 37.60 L0.46 37.96 L0.26 38.35 L0.12 38.77 L0.03 39.20 L0.00 39.64 L0.03 40.09 L0.12 40.52 L0.26 40.94 L0.46 41.33 L0.71 41.69 L0.87 41.87 L1.06 42.03 L1.26 42.16 L1.47 42.27 L1.70 42.34 L1.94 42.39 L2.18 42.41 L2.42 42.39 L2.66 42.34 L2.89 42.27 L3.10 42.16 L3.30 42.03 L3.49 41.87 L3.65 41.69 L3.90 41.33 L4.10 40.94 L4.24 40.52 L4.33 40.09 L4.36 39.64 L4.33 39.20 L4.24 38.77 L4.10 38.35 L3.90 37.96 L3.65 37.60 L3.49 37.42 L3.30 37.26 L3.10 37.13 L2.89 37.02 L2.66 36.95 L2.42 36.90 L2.18 36.89 Z M49.77 54.96 L49.77 54.97 L45.10 55.15 L40.44 55.63 L37.60 56.04 L34.76 56.53 L31.92 57.10 L29.10 57.73 L26.58 58.36 L24.08 59.04 L21.57 59.79 L19.08 60.60 L17.68 61.10 L16.29 61.66 L14.90 62.29 L13.53 62.97 L14.14 64.72 L14.73 66.48 L15.30 68.26 L15.85 70.05 L16.34 71.75 L16.81 73.45 L17.26 75.18 L17.68 76.91 L20.99 75.49 L24.38 74.27 L27.73 73.29 L31.15 72.52 L35.84 71.74 L40.56 71.17 L45.28 70.83 L50.00 70.72 L54.72 70.83 L59.44 71.17 L64.16 71.74 L68.85 72.52 L72.26 73.29 L75.62 74.27 L79.01 75.49 L82.31 76.91 L82.74 75.18 L83.19 73.46 L83.66 71.75 L84.15 70.05 L84.70 68.26 L85.27 66.48 L85.86 64.72 L86.47 62.97 L85.10 62.29 L83.71 61.66 L82.32 61.11 L80.92 60.60 L78.43 59.79 L75.92 59.04 L73.42 58.36 L70.90 57.73 L68.08 57.10 L65.24 56.53 L62.40 56.04 L59.56 55.63 L54.90 55.15 L50.23 54.97 L50.23 54.96 L50.18 54.96 L50.14 54.96 L50.11 54.97 L50.09 54.97 L50.07 54.97 L50.06 54.96 L50.03 54.96 L50.00 54.96 L49.97 54.96 L49.94 54.96 L49.93 54.97 L49.91 54.97 L49.89 54.97 L49.86 54.96 L49.82 54.96 L49.77 54.96 Z M13.51 35.30 L13.75 35.28 L13.99 35.24 L14.21 35.16 L14.43 35.06 L14.63 34.92 L14.82 34.77 L14.98 34.59 L15.23 34.22 L15.43 33.83 L15.57 33.41 L15.66 32.98 L15.69 32.54 L15.66 32.10 L15.57 31.67 L15.43 31.25 L15.23 30.86 L14.98 30.49 L14.82 30.31 L14.63 30.16 L14.43 30.02 L14.21 29.92 L13.99 29.84 L13.75 29.80 L13.51 29.78 L13.27 29.80 L13.03 29.84 L12.80 29.92 L12.59 30.02 L12.39 30.16 L12.20 30.31 L12.04 30.49 L11.79 30.86 L11.59 31.25 L11.45 31.67 L11.36 32.10 L11.33 32.54 L11.36 32.98 L11.45 33.41 L11.59 33.83 L11.79 34.22 L12.04 34.59 L12.20 34.77 L12.39 34.92 L12.59 35.06 L12.80 35.16 L13.03 35.24 L13.27 35.28 L13.51 35.30 Z M4.43 44.11 L4.35 44.19 L4.29 44.27 L4.23 44.36 L4.19 44.45 L4.17 44.55 L4.15 44.67 L4.15 44.78 L4.16 44.89 L4.19 45.00 L4.23 45.11 L4.58 45.82 L4.96 46.51 L5.35 47.16 L5.78 47.78 L6.14 48.26 L6.53 48.72 L6.92 49.12 L7.34 49.50 L8.25 51.22 L9.14 52.94 L10.02 54.68 L10.89 56.42 L11.19 57.06 L11.49 57.71 L11.77 58.37 L12.05 59.04 L13.49 58.31 L14.96 57.64 L16.42 57.04 L17.91 56.50 L20.51 55.65 L23.13 54.85 L25.73 54.13 L28.36 53.47 L31.33 52.79 L34.31 52.20 L37.29 51.68 L40.28 51.25 L45.13 50.77 L50.00 50.61 L54.87 50.77 L59.71 51.25 L62.71 51.68 L65.68 52.20 L68.67 52.79 L71.64 53.47 L74.26 54.13 L76.87 54.85 L79.49 55.65 L82.09 56.50 L83.57 57.04 L85.03 57.64 L86.51 58.31 L87.95 59.04 L88.22 58.37 L88.51 57.72 L88.80 57.07 L89.11 56.44 L89.98 54.69 L90.86 52.95 L91.75 51.22 L92.65 49.50 L93.07 49.12 L93.47 48.72 L93.86 48.27 L94.22 47.79 L94.65 47.16 L95.04 46.51 L95.42 45.82 L95.77 45.11 L95.81 45.00 L95.84 44.89 L95.85 44.78 L95.85 44.67 L95.83 44.55 L95.81 44.45 L95.77 44.36 L95.71 44.27 L95.65 44.18 L95.57 44.11 L95.52 44.08 L95.46 44.05 L95.40 44.03 L95.34 44.02 L95.28 44.01 L95.21 44.02 L95.14 44.04 L95.07 44.07 L95.01 44.10 L94.95 44.14 L94.90 44.19 L94.85 44.25 L94.82 44.31 L94.78 44.37 L94.19 45.50 L93.49 46.57 L92.76 47.47 L91.94 48.30 L91.32 48.77 L90.62 49.13 L90.16 49.28 L89.70 49.37 L89.22 49.40 L88.74 49.37 L88.26 49.28 L87.74 49.11 L87.23 48.89 L86.89 48.69 L86.57 48.44 L86.28 48.16 L86.04 47.84 L85.71 47.28 L85.46 46.68 L85.30 46.05 L84.93 42.12 L85.25 38.19 L85.27 38.09 L85.27 37.99 L85.26 37.89 L85.24 37.80 L85.20 37.71 L85.16 37.62 L85.10 37.54 L85.04 37.46 L84.96 37.40 L84.88 37.35 L84.81 37.33 L84.74 37.32 L84.67 37.32 L84.61 37.33 L84.54 37.35 L84.48 37.37 L84.42 37.41 L84.36 37.45 L84.31 37.49 L84.27 37.54 L84.23 37.60 L84.20 37.66 L84.17 37.72 L83.42 39.45 L82.50 41.09 L81.51 42.48 L80.36 43.74 L79.75 44.27 L79.08 44.72 L78.36 45.09 L77.67 45.33 L76.96 45.48 L76.23 45.53 L75.65 45.49 L75.07 45.37 L74.58 45.20 L74.12 44.96 L73.69 44.67 L73.30 44.33 L72.75 43.69 L72.29 42.99 L71.94 42.23 L71.29 40.22 L70.86 38.16 L70.64 35.98 L70.65 33.79 L70.66 33.71 L70.65 33.62 L70.64 33.53 L70.61 33.45 L70.58 33.37 L70.53 33.30 L70.48 33.23 L70.42 33.17 L70.35 33.11 L70.28 33.07 L70.20 33.03 L70.12 33.03 L70.05 33.03 L69.98 33.05 L69.91 33.07 L69.84 33.10 L69.78 33.14 L69.72 33.18 L69.67 33.24 L69.62 33.30 L69.59 33.36 L69.56 33.43 L69.54 33.50 L68.86 35.45 L67.95 37.30 L66.92 38.83 L65.70 40.21 L64.89 40.90 L64.00 41.49 L63.05 41.97 L62.15 42.29 L61.21 42.49 L60.25 42.55 L59.91 42.54 L59.58 42.52 L59.27 42.47 L58.96 42.41 L58.06 42.17 L57.19 41.84 L56.31 41.40 L55.47 40.90 L54.83 40.41 L54.23 39.87 L53.64 39.21 L53.11 38.50 L52.64 37.74 L52.23 36.95 L51.86 36.07 L51.56 35.17 L51.21 33.89 L50.92 32.59 L50.69 31.25 L50.53 29.90 L50.53 29.82 L50.51 29.74 L50.48 29.66 L50.45 29.59 L50.40 29.52 L50.35 29.46 L50.29 29.41 L50.22 29.36 L50.15 29.32 L50.08 29.29 L50.00 29.27 L49.92 29.29 L49.85 29.32 L49.77 29.36 L49.71 29.41 L49.65 29.46 L49.60 29.52 L49.55 29.59 L49.52 29.67 L49.49 29.74 L49.47 29.82 L49.47 29.90 L49.31 31.25 L49.08 32.59 L48.79 33.89 L48.44 35.17 L48.14 36.07 L47.76 36.95 L47.35 37.74 L46.88 38.50 L46.36 39.21 L45.77 39.87 L45.17 40.41 L44.53 40.90 L43.69 41.40 L42.81 41.84 L41.94 42.17 L41.04 42.41 L40.73 42.47 L40.42 42.52 L40.09 42.54 L39.75 42.55 L38.79 42.49 L37.85 42.29 L36.95 41.97 L36.00 41.49 L35.11 40.90 L34.30 40.20 L33.08 38.83 L32.05 37.30 L31.14 35.45 L30.46 33.50 L30.44 33.43 L30.41 33.36 L30.38 33.30 L30.33 33.24 L30.28 33.18 L30.22 33.14 L30.16 33.10 L30.09 33.07 L30.02 33.05 L29.95 33.03 L29.88 33.03 L29.80 33.03 L29.72 33.07 L29.65 33.11 L29.58 33.17 L29.52 33.23 L29.47 33.30 L29.42 33.37 L29.39 33.45 L29.36 33.53 L29.35 33.62 L29.34 33.71 L29.35 33.79 L29.35 35.98 L29.14 38.16 L28.71 40.22 L28.06 42.23 L27.71 42.99 L27.25 43.69 L26.70 44.33 L26.31 44.67 L25.88 44.96 L25.41 45.20 L24.92 45.37 L24.35 45.49 L23.77 45.53 L23.04 45.48 L22.33 45.33 L21.64 45.09 L20.92 44.72 L20.25 44.27 L19.64 43.74 L18.49 42.48 L17.50 41.09 L16.58 39.45 L15.83 37.72 L15.80 37.66 L15.77 37.60 L15.73 37.54 L15.69 37.49 L15.64 37.45 L15.58 37.41 L15.52 37.37 L15.46 37.35 L15.39 37.33 L15.33 37.32 L15.26 37.32 L15.19 37.33 L15.12 37.35 L15.04 37.40 L14.96 37.46 L14.90 37.54 L14.84 37.62 L14.80 37.71 L14.76 37.80 L14.74 37.89 L14.73 37.99 L14.73 38.09 L14.75 38.19 L15.07 42.12 L14.70 46.05 L14.54 46.68 L14.29 47.28 L13.96 47.84 L13.72 48.16 L13.43 48.44 L13.11 48.69 L12.77 48.89 L12.26 49.11 L11.74 49.28 L11.26 49.37 L10.78 49.40 L10.30 49.37 L9.83 49.28 L9.38 49.13 L8.68 48.77 L8.05 48.30 L7.23 47.47 L6.50 46.57 L5.81 45.50 L5.21 44.37 L5.18 44.31 L5.15 44.25 L5.10 44.19 L5.05 44.14 L4.99 44.10 L4.93 44.07 L4.86 44.04 L4.79 44.02 L4.72 44.01 L4.66 44.02 L4.60 44.03 L4.54 44.05 L4.48 44.08 L4.43 44.11 Z M11.90 60.70 L11.83 60.75 L11.76 60.81 L11.71 60.88 L11.66 60.95 L11.62 61.03 L11.60 61.11 L11.57 61.22 L11.56 61.33 L11.56 61.44 L11.58 61.55 L11.61 61.66 L11.63 61.73 L11.66 61.79 L11.70 61.84 L11.74 61.90 L11.79 61.94 L11.85 61.98 L11.91 62.02 L11.97 62.04 L12.04 62.06 L12.10 62.07 L12.17 62.07 L12.24 62.06 L12.31 62.05 L12.37 62.03 L13.68 61.32 L15.02 60.66 L16.35 60.09 L17.70 59.58 L20.32 58.69 L22.95 57.87 L25.58 57.12 L28.22 56.44 L31.20 55.75 L34.20 55.14 L37.19 54.62 L40.19 54.17 L45.09 53.68 L50.00 53.51 L54.91 53.68 L59.80 54.17 L62.81 54.62 L65.80 55.14 L68.80 55.75 L71.78 56.44 L74.42 57.12 L77.05 57.87 L79.68 58.69 L82.30 59.58 L83.65 60.09 L84.98 60.66 L86.32 61.32 L87.63 62.03 L87.69 62.05 L87.76 62.06 L87.83 62.07 L87.89 62.07 L87.96 62.06 L88.03 62.04 L88.09 62.02 L88.15 61.98 L88.21 61.94 L88.26 61.90 L88.30 61.84 L88.34 61.79 L88.37 61.73 L88.39 61.66 L88.42 61.55 L88.44 61.44 L88.44 61.33 L88.43 61.22 L88.40 61.11 L88.37 61.03 L88.34 60.95 L88.29 60.88 L88.24 60.81 L88.17 60.75 L88.10 60.70 L86.77 59.98 L85.41 59.32 L84.06 58.73 L82.69 58.21 L80.04 57.32 L77.37 56.48 L74.71 55.72 L72.03 55.03 L69.02 54.33 L65.98 53.71 L62.95 53.18 L59.91 52.73 L54.97 52.23 L50.00 52.06 L45.03 52.23 L40.09 52.73 L37.05 53.18 L34.02 53.71 L30.98 54.33 L27.96 55.03 L25.29 55.72 L22.63 56.48 L19.96 57.32 L17.31 58.21 L15.94 58.73 L14.59 59.32 L13.23 59.98 L11.90 60.70 Z' },
    { id: 'star_david', label: 'מגן דוד', defaultWidthMm: 25, fillRule: 'evenodd',
      d: 'M50.00 100.00 L36.47 76.50 L44.52 76.50 L50.00 86.11 L69.94 51.50 L73.93 58.48 L50.00 100.00 Z M6.70 75.00 L20.23 51.50 L24.29 58.48 L18.73 68.02 L58.69 68.02 L54.63 75.00 L6.70 75.00 Z M6.70 25.00 L33.83 25.00 L29.77 31.98 L18.73 31.98 L38.68 66.52 L30.70 66.52 L6.70 25.00 Z M50.00 0.00 L63.53 23.50 L55.48 23.50 L50.00 13.96 L30.06 48.50 L26.00 41.52 L50.00 0.00 Z M93.30 25.00 L79.77 48.50 L75.71 41.52 L81.27 31.98 L41.31 31.98 L45.37 25.00 L93.30 25.00 Z M93.30 75.00 L66.17 75.00 L70.23 68.02 L81.27 68.02 L61.25 33.48 L69.30 33.48 L93.30 75.00 Z' },
    { id: 'chef_hat', label: 'כובע שף', defaultWidthMm: 28, fillRule: 'evenodd',
      d: 'M26.92 83.17 L29.25 82.52 L31.64 82.18 L40.63 81.67 L49.63 81.48 L57.43 81.60 L65.21 82.03 L69.08 82.47 L72.90 83.21 L72.02 88.09 L71.35 88.14 L70.68 88.13 L68.80 88.02 L66.92 87.84 L64.52 87.59 L62.11 87.34 L61.79 87.31 L61.47 87.29 L55.92 87.09 L50.37 87.02 L44.50 87.08 L38.63 87.28 L38.06 87.31 L37.49 87.36 L35.31 87.57 L33.13 87.80 L31.30 87.97 L29.48 88.11 L28.64 88.14 L27.80 88.13 L27.79 88.08 L27.78 88.04 L27.56 86.88 L27.34 85.73 L27.13 84.62 L26.94 83.51 L26.92 83.34 L26.92 83.17 Z M25.89 27.62 L25.90 27.79 L25.91 27.95 L25.89 29.32 L25.85 30.68 L25.88 31.62 L26.02 32.55 L26.08 32.77 L26.17 32.98 L26.29 33.18 L26.43 33.36 L26.63 33.55 L26.84 33.71 L27.08 33.84 L27.33 33.94 L27.59 34.01 L27.86 34.04 L28.13 34.04 L28.40 34.00 L28.66 33.93 L28.97 33.79 L29.27 33.62 L29.53 33.41 L29.78 33.17 L29.98 32.90 L30.16 32.61 L30.29 32.29 L30.38 31.97 L31.12 28.94 L32.05 25.97 L32.65 24.53 L33.42 23.18 L34.92 21.18 L36.66 19.40 L38.62 17.85 L40.75 16.56 L43.04 15.55 L45.43 14.84 L47.89 14.44 L50.39 14.36 L52.87 14.59 L55.30 15.14 L57.65 15.99 L59.87 17.13 L62.10 18.65 L64.14 20.43 L65.68 22.19 L66.97 24.15 L66.99 24.19 L67.02 24.24 L67.22 24.67 L67.42 25.11 L68.40 27.33 L68.62 27.97 L68.80 28.62 L68.98 29.39 L69.11 30.16 L69.24 31.01 L69.39 31.85 L69.44 32.09 L69.51 32.33 L69.61 32.60 L69.75 32.85 L69.91 33.08 L70.11 33.29 L70.33 33.48 L70.57 33.64 L70.83 33.76 L71.10 33.85 L71.38 33.91 L71.67 33.93 L71.95 33.91 L72.24 33.86 L72.51 33.77 L72.77 33.65 L73.01 33.49 L73.23 33.31 L73.43 33.10 L73.56 32.91 L73.67 32.70 L73.76 32.49 L73.81 32.26 L73.93 31.35 L73.93 30.43 L73.89 29.39 L73.92 28.35 L73.94 28.13 L73.99 27.92 L74.07 27.71 L75.46 27.49 L76.87 27.45 L78.27 27.58 L81.07 28.24 L83.75 29.28 L85.93 30.49 L87.92 31.97 L89.70 33.72 L91.12 35.55 L92.26 37.57 L93.10 39.73 L93.61 42.03 L93.75 44.37 L93.52 46.71 L92.90 49.10 L91.93 51.37 L90.64 53.46 L89.70 54.64 L88.68 55.75 L87.73 56.61 L86.70 57.39 L86.18 57.74 L84.79 58.56 L83.34 59.28 L82.05 59.81 L80.72 60.23 L77.88 60.95 L77.70 61.06 L77.53 61.19 L77.38 61.34 L77.26 61.51 L77.15 61.70 L76.51 63.27 L76.04 64.89 L75.89 65.53 L75.75 66.16 L75.37 67.89 L74.99 69.61 L74.00 74.18 L73.01 78.76 L72.99 78.83 L72.96 78.90 L71.99 78.90 L71.01 78.87 L69.23 78.77 L67.45 78.63 L65.24 78.44 L63.04 78.27 L62.41 78.23 L61.77 78.19 L57.57 78.07 L53.37 78.03 L45.72 78.09 L38.07 78.23 L37.18 78.26 L36.30 78.31 L34.35 78.45 L32.40 78.61 L30.62 78.75 L28.85 78.86 L27.85 78.90 L26.85 78.91 L24.77 69.46 L23.96 65.94 L23.09 62.43 L22.96 62.05 L22.78 61.70 L22.71 61.59 L22.62 61.50 L22.53 61.42 L22.42 61.35 L22.31 61.30 L20.87 60.79 L19.41 60.38 L16.95 59.57 L14.64 58.42 L12.52 56.94 L10.59 55.12 L8.93 53.06 L7.59 50.77 L6.79 48.82 L6.29 46.76 L6.08 44.66 L6.18 42.55 L6.61 40.27 L7.33 38.07 L8.34 35.99 L9.61 34.05 L10.94 32.52 L12.47 31.18 L14.17 30.06 L16.01 29.18 L19.21 28.18 L22.53 27.65 L25.89 27.62 Z M80.85 64.77 L83.57 64.08 L86.27 63.33 L86.94 63.11 L87.59 62.85 L89.74 61.71 L91.72 60.31 L93.75 58.47 L95.57 56.41 L97.19 54.06 L98.51 51.52 L99.31 49.26 L99.77 46.91 L99.87 45.99 L99.97 45.07 L99.99 44.84 L100.00 44.60 L99.92 42.04 L99.52 39.51 L98.88 37.18 L98.00 34.93 L97.13 33.30 L96.04 31.81 L93.61 29.24 L90.89 26.97 L88.40 25.40 L85.71 24.19 L82.83 23.36 L79.86 22.95 L76.15 22.92 L72.46 23.31 L71.20 20.37 L69.47 17.68 L66.98 14.87 L64.13 12.44 L61.07 10.57 L57.73 9.25 L53.77 8.39 L49.73 8.13 L45.72 8.48 L41.80 9.42 L38.46 10.80 L35.38 12.71 L32.55 15.12 L30.08 17.89 L28.41 20.44 L27.19 23.24 L24.28 22.98 L21.35 22.91 L19.27 23.03 L17.20 23.34 L15.15 23.87 L13.16 24.61 L11.06 25.65 L9.07 26.89 L5.35 30.15 L4.50 31.15 L3.66 32.15 L3.53 32.31 L3.41 32.48 L2.09 34.81 L1.07 37.30 L0.37 39.89 L0.01 42.55 L0.00 45.24 L0.33 47.85 L0.99 50.41 L1.98 52.85 L3.28 55.14 L4.86 57.25 L7.23 59.62 L9.92 61.61 L12.88 63.18 L19.25 64.78 L19.39 65.58 L19.56 66.38 L19.79 67.43 L20.04 68.47 L22.61 81.31 L23.67 86.22 L24.87 91.10 L24.91 91.22 L24.97 91.33 L25.04 91.44 L25.12 91.53 L25.22 91.61 L25.32 91.68 L25.93 91.76 L26.54 91.76 L28.88 91.61 L31.21 91.38 L37.61 90.65 L45.79 90.20 L53.99 90.17 L61.40 90.53 L68.79 91.30 L71.02 91.58 L73.26 91.86 L73.42 91.87 L73.58 91.87 L73.78 91.84 L73.99 91.79 L74.18 91.71 L74.36 91.61 L74.53 91.49 L74.69 91.34 L74.94 91.04 L75.14 90.70 L75.29 90.33 L75.38 89.95 L79.19 71.18 L79.76 68.51 L80.41 65.86 L80.60 65.30 L80.85 64.77 Z M48.85 47.09 L48.01 48.05 L47.22 49.05 L47.11 49.22 L47.02 49.40 L46.97 49.59 L46.96 49.63 L46.96 49.67 L47.01 51.47 L47.07 53.27 L47.47 69.16 L47.52 70.32 L47.65 71.48 L47.77 71.97 L47.96 72.45 L48.07 72.64 L48.20 72.82 L48.36 72.98 L48.54 73.11 L48.73 73.23 L48.94 73.32 L49.36 73.44 L49.79 73.49 L50.23 73.49 L50.67 73.42 L51.30 73.17 L51.35 73.14 L51.40 73.11 L51.44 73.08 L51.48 73.05 L51.60 72.95 L51.71 72.84 L51.82 72.71 L51.91 72.58 L52.01 72.40 L52.08 72.20 L52.14 72.00 L52.16 71.80 L52.43 67.08 L52.59 62.37 L52.77 51.23 L52.75 50.08 L52.61 48.93 L52.54 48.62 L52.41 48.32 L52.24 48.05 L52.09 47.86 L51.91 47.69 L51.70 47.55 L51.49 47.44 L51.25 47.36 L50.06 47.13 L48.85 47.09 Z M69.78 54.36 L69.92 54.09 L70.03 53.81 L70.09 53.51 L70.12 53.21 L70.12 52.91 L70.07 52.61 L69.96 52.24 L69.80 51.89 L69.59 51.56 L69.34 51.27 L69.05 51.01 L68.75 50.81 L68.43 50.65 L68.08 50.54 L67.73 50.47 L67.37 50.45 L67.01 50.48 L66.64 50.55 L66.27 50.68 L65.92 50.84 L65.60 51.05 L65.31 51.30 L65.04 51.57 L64.58 52.19 L64.19 52.85 L63.43 54.39 L62.75 55.97 L62.26 57.30 L61.85 58.66 L61.37 60.68 L60.98 62.71 L59.92 69.84 L59.81 70.79 L59.76 71.75 L59.79 72.20 L59.89 72.63 L59.98 72.86 L60.10 73.06 L60.25 73.25 L60.42 73.41 L60.61 73.55 L60.96 73.73 L61.32 73.86 L61.70 73.95 L62.08 73.98 L62.61 73.94 L63.13 73.83 L63.36 73.74 L63.57 73.62 L63.77 73.47 L63.90 73.33 L64.01 73.17 L64.10 73.00 L64.16 72.82 L64.75 70.28 L65.23 67.72 L65.77 64.65 L66.37 61.59 L66.58 60.70 L66.85 59.83 L67.38 58.40 L67.97 57.00 L68.35 56.26 L68.79 55.56 L69.78 54.36 Z M36.15 73.62 L37.38 73.84 L38.63 73.85 L38.82 73.82 L39.01 73.76 L39.19 73.69 L39.36 73.59 L39.51 73.47 L39.65 73.34 L39.76 73.20 L39.85 73.05 L39.92 72.89 L39.96 72.72 L39.99 72.55 L39.99 72.37 L39.64 68.39 L39.09 64.43 L37.83 58.65 L35.97 53.03 L35.73 52.53 L35.43 52.06 L35.07 51.63 L34.66 51.25 L34.21 50.93 L33.72 50.67 L33.41 50.55 L33.08 50.47 L32.76 50.43 L32.42 50.43 L32.09 50.47 L31.77 50.56 L31.47 50.68 L31.18 50.84 L30.91 51.04 L30.67 51.27 L30.46 51.52 L30.28 51.81 L30.14 52.11 L30.04 52.42 L29.98 52.75 L29.96 53.08 L29.98 53.41 L30.05 53.74 L30.15 54.05 L30.29 54.35 L31.53 56.64 L32.65 58.99 L33.21 60.44 L33.65 61.94 L35.12 70.36 L35.37 71.50 L35.68 72.61 L35.88 73.13 L36.15 73.62 Z' },
    { id: 'saltbae', label: 'איש המלח', defaultWidthMm: 22, fillRule: 'evenodd',
      d: 'M33.27 45.04 L34.77 44.78 L35.07 45.81 L35.07 45.84 L35.08 45.87 L35.10 45.94 L35.13 46.01 L36.32 49.73 L36.38 49.92 L36.44 50.15 L36.51 50.37 L36.55 50.51 L36.60 50.66 L37.10 52.10 L38.76 57.38 L38.91 57.79 L39.07 58.19 L40.04 60.50 L41.02 62.81 L41.73 64.56 L42.36 66.33 L42.60 67.21 L42.77 68.11 L43.17 70.42 L43.22 70.63 L45.67 84.62 L45.72 85.32 L45.68 86.02 L45.54 86.71 L45.31 87.38 L44.99 88.00 L42.71 91.40 L42.35 92.05 L41.96 92.63 L41.45 92.53 L40.96 92.36 L39.33 91.62 L37.74 90.82 L36.25 90.01 L34.79 89.16 L34.72 89.10 L34.64 89.04 L34.58 88.97 L34.53 88.89 L32.59 79.96 L32.47 78.99 L32.44 78.01 L32.58 74.12 L32.82 70.23 L33.13 65.73 L33.41 61.22 L33.45 60.22 L33.46 59.21 L33.20 51.77 L33.14 48.94 L33.14 46.11 L33.18 45.58 L33.27 45.04 Z M27.00 25.56 L26.77 25.09 L26.62 24.58 L26.11 21.90 L25.69 19.21 L25.36 16.57 L25.10 13.92 L25.08 13.35 L25.13 12.79 L24.51 12.64 L23.87 12.59 L23.55 12.60 L23.24 12.66 L22.94 12.76 L22.67 14.16 L22.62 15.59 L23.00 21.22 L23.60 26.83 L22.58 27.23 L22.14 26.95 L21.74 26.60 L19.13 24.01 L16.58 21.36 L16.37 21.17 L16.14 21.01 L15.88 20.88 L15.62 20.78 L15.34 20.73 L15.21 20.98 L15.11 21.26 L15.05 21.54 L15.02 21.83 L15.03 22.08 L15.07 22.33 L15.15 22.56 L15.26 22.79 L16.95 25.20 L17.19 25.57 L17.45 25.92 L18.69 27.51 L19.95 29.08 L22.53 32.63 L24.75 36.42 L26.09 39.50 L27.02 42.73 L27.98 48.62 L28.38 50.77 L28.62 52.95 L28.73 55.36 L28.69 57.77 L28.61 59.07 L28.49 60.37 L28.12 63.70 L27.70 67.03 L27.35 69.73 L26.99 72.44 L26.95 72.75 L26.90 73.06 L26.41 77.08 L26.15 81.13 L26.19 83.14 L26.46 85.14 L26.69 85.94 L27.05 86.70 L28.29 88.72 L29.65 90.65 L30.31 91.67 L34.59 97.78 L34.86 98.06 L35.17 98.30 L35.89 98.71 L36.65 99.07 L37.56 99.45 L38.47 99.81 L38.77 99.92 L39.07 100.00 L44.98 95.67 L47.73 92.01 L47.82 91.85 L47.89 91.68 L47.94 91.50 L47.97 91.31 L47.97 91.13 L47.80 89.29 L47.48 87.47 L46.92 84.55 L46.46 81.62 L45.56 74.73 L44.77 67.82 L44.70 67.42 L44.59 67.02 L43.30 63.26 L41.96 59.52 L41.52 58.23 L41.11 56.93 L40.53 54.90 L39.98 52.85 L39.37 50.19 L38.89 47.51 L38.84 46.74 L38.93 45.98 L39.37 44.01 L39.90 42.05 L40.15 41.34 L40.49 40.66 L41.32 38.95 L41.90 37.13 L42.30 34.89 L42.43 32.61 L42.37 31.59 L42.21 30.58 L41.95 29.65 L41.59 28.76 L41.12 27.71 L40.70 26.65 L40.56 26.19 L40.47 25.72 L40.22 23.92 L40.00 22.13 L39.99 21.95 L40.01 21.78 L40.02 21.75 L40.03 21.72 L40.32 20.96 L40.61 20.21 L40.74 19.77 L40.79 19.31 L40.79 19.16 L40.76 19.02 L40.72 18.88 L40.66 18.74 L39.56 18.58 L38.32 19.79 L38.18 19.90 L36.92 22.08 L36.85 22.56 L36.84 23.05 L36.92 24.23 L37.08 25.41 L37.15 26.29 L37.07 27.18 L37.01 27.45 L36.92 27.70 L36.79 27.94 L36.63 28.16 L35.56 27.37 L35.42 27.17 L35.30 26.95 L35.23 26.71 L35.12 26.09 L35.10 25.47 L35.18 23.89 L35.29 22.31 L35.35 21.90 L35.44 21.49 L35.67 20.85 L36.00 20.24 L36.40 19.69 L36.95 19.13 L37.56 18.64 L38.23 18.23 L40.39 17.43 L40.22 16.03 L39.80 15.84 L39.36 15.71 L38.91 15.63 L38.45 15.61 L38.03 15.65 L37.61 15.74 L37.21 15.90 L36.83 16.10 L35.14 17.12 L35.11 17.15 L35.08 17.17 L35.05 17.20 L35.01 17.23 L34.40 17.77 L33.86 18.37 L33.50 18.87 L33.21 19.42 L32.66 20.74 L32.18 22.09 L31.93 22.94 L31.77 23.81 L31.70 24.86 L31.69 24.92 L31.67 24.98 L31.65 25.03 L31.62 25.08 L31.58 25.13 L31.40 25.30 L31.19 25.43 L31.11 25.19 L31.06 24.94 L31.04 24.69 L31.06 24.44 L31.51 21.34 L32.07 18.26 L32.63 15.30 L33.09 12.32 L33.09 12.25 L33.09 12.18 L33.08 12.12 L33.06 12.06 L33.03 12.00 L32.99 11.94 L32.95 11.89 L32.65 11.78 L32.35 11.72 L31.63 11.67 L30.90 11.66 L30.48 12.66 L30.16 13.70 L29.45 16.81 L28.85 19.94 L28.84 20.04 L28.82 20.14 L28.78 20.33 L28.74 20.52 L28.10 24.48 L28.05 24.69 L27.96 24.88 L27.84 25.07 L27.70 25.23 L27.58 25.33 L27.45 25.42 L27.30 25.48 L27.15 25.53 L27.00 25.56 Z M63.27 5.68 L63.38 5.26 L63.53 4.85 L63.81 4.23 L64.13 3.63 L64.37 3.15 L64.55 2.64 L64.63 2.27 L64.64 1.89 L64.19 1.73 L63.73 1.58 L62.87 1.34 L62.01 1.12 L61.43 1.00 L60.84 0.90 L60.67 0.89 L60.49 0.91 L60.39 0.94 L60.30 0.98 L59.76 1.26 L59.23 1.56 L58.11 2.15 L57.38 2.51 L56.63 2.81 L55.39 3.23 L54.13 3.58 L53.30 3.86 L52.51 4.24 L52.33 4.35 L52.17 4.49 L52.03 4.65 L51.91 4.83 L47.99 12.04 L47.74 12.58 L47.57 13.16 L47.42 14.01 L47.37 14.87 L47.34 15.88 L47.29 16.88 L47.15 19.22 L46.98 21.56 L46.97 22.63 L47.08 23.70 L47.36 25.04 L47.77 26.35 L48.21 27.70 L48.56 29.09 L48.68 29.86 L48.70 30.64 L48.65 32.36 L48.61 34.09 L48.62 34.24 L48.63 34.39 L48.83 35.23 L48.87 35.42 L49.24 37.45 L49.43 37.18 L49.59 36.90 L49.70 36.59 L50.08 35.14 L50.36 33.66 L50.69 32.10 L51.19 30.58 L51.83 29.21 L52.63 27.92 L54.68 25.32 L55.53 21.16 L55.96 19.16 L56.05 19.03 L56.15 18.91 L56.27 18.81 L56.40 18.72 L56.90 18.47 L57.43 18.30 L58.42 18.05 L59.40 17.77 L59.51 17.73 L59.62 17.67 L59.71 17.61 L60.75 16.47 L61.02 16.71 L61.28 16.96 L62.59 18.34 L63.88 19.74 L64.62 20.50 L65.41 21.20 L66.25 21.85 L67.14 22.45 L71.34 24.97 L72.07 25.39 L72.85 25.75 L73.30 25.90 L73.76 25.98 L76.82 25.95 L76.86 25.99 L76.89 26.03 L78.45 27.97 L80.00 29.90 L79.98 30.33 L79.91 30.74 L79.45 32.36 L78.95 33.97 L78.81 34.31 L78.63 34.62 L78.40 34.92 L78.14 35.18 L77.85 35.40 L77.04 35.87 L76.17 36.22 L75.26 36.45 L74.77 36.53 L74.29 36.58 L73.65 36.63 L73.01 36.66 L71.57 36.69 L71.24 36.74 L70.93 36.84 L70.13 37.17 L69.36 37.54 L68.00 38.28 L68.11 38.57 L68.26 38.85 L68.28 38.88 L68.31 38.91 L68.34 38.93 L68.37 38.95 L68.41 38.97 L68.46 38.98 L68.51 38.99 L68.56 38.99 L68.60 38.98 L69.01 38.89 L69.40 38.77 L69.51 38.73 L69.62 38.68 L69.93 38.55 L70.22 38.41 L71.01 38.00 L71.31 37.91 L71.62 37.86 L71.93 37.85 L73.42 37.95 L74.91 38.13 L75.41 38.18 L75.91 38.15 L76.40 38.06 L76.87 37.90 L77.20 37.75 L77.50 37.55 L77.78 37.32 L78.02 37.06 L78.23 36.76 L80.54 32.49 L81.45 30.90 L83.10 28.47 L83.37 27.92 L83.55 27.33 L83.69 26.40 L83.74 25.47 L83.70 24.01 L83.60 22.55 L83.43 20.99 L83.20 19.43 L82.97 18.01 L82.76 16.58 L82.74 16.38 L82.74 16.19 L83.38 17.19 L83.79 17.96 L84.23 18.71 L84.38 18.91 L84.55 19.08 L84.77 19.22 L84.90 17.37 L84.98 15.51 L84.98 15.46 L84.97 15.42 L84.96 15.38 L84.94 15.34 L84.92 15.30 L84.89 15.27 L84.32 14.91 L84.07 14.69 L83.85 14.43 L83.51 13.93 L83.20 13.41 L83.15 13.33 L83.11 13.25 L82.42 12.06 L81.73 10.88 L77.38 3.44 L77.15 3.02 L76.89 2.62 L76.82 2.53 L76.74 2.45 L76.65 2.39 L76.54 2.32 L76.41 2.26 L75.75 2.04 L75.08 1.84 L68.87 0.00 L65.72 3.35 L65.71 3.37 L65.70 3.38 L65.65 3.43 L65.60 3.48 L63.27 5.68 Z M56.81 36.22 L56.40 36.34 L56.00 36.52 L55.64 36.75 L55.31 37.03 L55.16 37.20 L55.03 37.39 L54.92 37.60 L54.84 37.81 L54.78 38.03 L54.75 38.26 L54.75 38.94 L54.83 39.62 L54.99 40.28 L55.12 40.63 L55.29 40.96 L55.50 41.27 L55.75 41.54 L56.28 42.00 L56.85 42.39 L57.46 42.70 L58.11 42.94 L58.79 43.10 L59.47 43.18 L60.17 43.17 L60.85 43.08 L61.52 42.90 L62.03 42.70 L62.51 42.43 L62.94 42.10 L63.33 41.72 L63.67 41.29 L63.82 41.03 L63.94 40.76 L64.02 40.48 L64.07 40.18 L64.07 39.89 L64.04 39.59 L63.98 39.31 L63.83 38.90 L63.63 38.51 L63.42 38.19 L63.16 37.91 L62.54 37.38 L61.86 36.93 L61.12 36.57 L60.35 36.31 L59.18 36.10 L57.99 36.07 L56.81 36.22 Z M77.35 40.21 L77.32 40.18 L77.28 40.16 L76.85 39.80 L76.42 39.45 L76.14 39.25 L75.83 39.08 L75.42 38.91 L74.99 38.78 L73.85 38.60 L72.69 38.59 L71.45 38.78 L70.25 39.14 L69.66 39.42 L69.12 39.78 L68.90 39.98 L68.72 40.21 L68.57 40.46 L68.47 40.69 L68.41 40.92 L68.39 41.17 L68.40 41.42 L68.49 41.88 L68.64 42.33 L68.85 42.75 L69.28 43.36 L69.82 43.88 L70.16 44.12 L70.52 44.31 L70.92 44.44 L71.85 44.63 L72.79 44.74 L73.54 44.75 L74.29 44.67 L75.13 44.45 L75.91 44.09 L76.14 43.93 L76.35 43.74 L76.54 43.52 L76.69 43.28 L76.85 42.94 L76.95 42.58 L77.18 41.40 L77.35 40.21 Z M71.15 52.21 L71.14 51.67 L71.10 51.13 L71.08 51.02 L71.04 50.91 L71.00 50.81 L70.94 50.74 L70.87 50.67 L70.80 50.61 L70.72 50.56 L70.30 50.39 L69.87 50.27 L69.42 50.15 L68.99 49.98 L68.43 49.69 L67.89 49.36 L67.65 49.40 L67.43 49.46 L66.84 49.68 L66.26 49.92 L65.81 50.08 L65.35 50.17 L64.89 50.20 L64.44 50.16 L64.22 50.10 L64.00 50.02 L63.53 49.79 L63.07 49.54 L62.60 49.27 L62.10 49.02 L61.80 48.90 L61.48 48.81 L60.77 49.39 L60.03 49.94 L59.98 49.98 L59.92 50.00 L59.85 50.02 L59.79 50.03 L58.17 49.84 L57.38 49.88 L56.62 50.04 L56.51 50.07 L56.41 50.12 L56.32 50.19 L56.24 50.26 L56.16 50.35 L56.10 50.44 L56.05 50.55 L56.01 50.67 L55.99 50.79 L55.99 50.91 L55.99 50.96 L56.00 51.00 L56.02 51.05 L56.04 51.09 L56.07 51.12 L56.10 51.16 L56.14 51.19 L56.23 51.24 L56.33 51.29 L56.43 51.32 L56.79 51.38 L57.14 51.40 L59.77 51.32 L62.21 51.81 L68.14 51.85 L68.50 51.86 L68.86 51.89 L69.24 51.94 L69.62 52.03 L70.00 52.11 L70.39 52.17 L70.77 52.20 L71.15 52.21 Z M48.75 76.21 L49.32 76.81 L49.95 77.35 L50.65 77.85 L51.38 78.29 L51.53 78.22 L51.67 78.14 L53.03 77.12 L54.38 76.08 L54.35 75.79 L54.28 75.50 L54.12 75.00 L53.92 74.51 L53.27 72.86 L50.30 73.66 L50.12 73.75 L49.94 73.86 L49.78 73.99 L49.64 74.14 L49.52 74.31 L49.06 75.23 L48.75 76.21 Z M55.86 35.27 L57.97 35.43 L60.07 35.65 L60.63 35.74 L61.18 35.89 L61.73 36.10 L62.25 36.39 L62.76 36.76 L63.23 37.20 L63.79 37.76 L64.36 38.31 L64.51 38.44 L64.69 38.56 L64.86 38.33 L65.00 38.08 L65.18 37.62 L65.32 37.14 L63.65 35.84 L61.84 34.74 L59.85 33.82 L57.76 33.13 L57.39 33.03 L55.58 32.48 L55.26 32.47 L54.94 32.51 L54.87 32.53 L54.81 32.55 L54.76 32.59 L54.70 32.63 L54.66 32.68 L54.62 32.73 L54.59 32.79 L54.56 32.85 L54.55 32.92 L54.54 32.99 L54.54 33.05 L54.63 33.50 L54.79 33.94 L54.80 33.96 L54.82 33.98 L55.34 34.62 L55.86 35.27 Z M58.56 57.28 L58.65 57.46 L58.75 57.64 L58.88 57.80 L59.03 57.95 L60.00 58.73 L61.03 59.42 L61.86 59.87 L62.75 60.20 L63.67 60.42 L64.01 60.45 L64.35 60.44 L64.70 60.38 L65.03 60.28 L65.34 60.14 L65.98 59.74 L66.59 59.29 L67.34 58.61 L68.05 57.88 L68.75 56.87 L68.43 56.96 L68.12 57.10 L68.00 57.18 L67.89 57.28 L67.80 57.39 L67.59 57.67 L67.35 57.91 L67.07 58.15 L66.76 58.36 L63.22 59.23 L63.01 59.24 L62.80 59.22 L62.59 59.16 L61.73 58.83 L60.90 58.43 L59.88 57.91 L58.86 57.39 L58.71 57.33 L58.56 57.28 Z M45.37 61.43 L46.43 62.79 L47.12 62.59 L47.77 62.28 L48.37 61.88 L48.43 61.83 L48.49 61.76 L48.53 61.69 L48.57 61.62 L48.60 61.54 L48.62 61.46 L48.62 61.37 L48.62 61.29 L48.60 61.20 L48.58 61.12 L48.51 60.98 L48.43 60.84 L48.33 60.71 L48.21 60.60 L48.09 60.50 L47.95 60.42 L47.47 60.21 L46.97 60.08 L46.46 60.02 L46.40 60.09 L46.34 60.16 L46.14 60.41 L45.95 60.67 L45.37 61.43 Z M42.78 46.41 L42.95 46.65 L43.15 46.88 L43.38 47.08 L43.63 47.24 L43.89 47.38 L44.01 47.42 L44.13 47.45 L44.24 47.46 L44.36 47.45 L44.48 47.43 L44.60 47.39 L44.71 47.34 L44.81 47.28 L45.16 46.98 L45.47 46.63 L45.54 46.52 L45.60 46.41 L45.64 46.29 L45.67 46.16 L45.58 45.82 L45.44 45.51 L45.23 45.20 L44.98 44.93 L43.73 45.66 L43.58 45.75 L42.78 46.41 Z M65.67 55.52 L65.57 55.48 L65.48 55.45 L65.38 55.43 L63.76 55.30 L62.13 55.19 L62.26 55.71 L62.46 56.20 L62.50 56.27 L62.54 56.34 L62.60 56.39 L62.66 56.44 L62.73 56.48 L62.86 56.53 L62.99 56.56 L63.12 56.58 L63.25 56.58 L64.10 56.46 L64.93 56.27 L65.25 56.18 L65.56 56.07 L65.58 56.07 L65.58 56.06 L65.59 56.06 L65.60 56.05 L65.61 56.04 L65.61 56.03 L65.67 55.52 Z M39.69 70.65 L41.08 70.56 L41.14 69.18 L39.81 68.96 L39.69 69.34 L39.63 69.73 L39.63 70.19 L39.69 70.65 Z M35.98 58.37 L37.08 58.44 L37.20 58.21 L37.29 57.96 L37.34 57.71 L37.35 57.45 L37.34 57.39 L37.33 57.34 L37.31 57.29 L37.29 57.24 L37.26 57.20 L37.22 57.16 L37.18 57.13 L37.14 57.10 L37.09 57.07 L37.04 57.05 L36.86 57.02 L36.68 57.01 L36.50 57.02 L36.32 57.07 L36.26 57.10 L36.20 57.13 L36.14 57.17 L36.10 57.22 L36.05 57.28 L36.02 57.34 L35.99 57.40 L35.96 57.55 L35.94 57.70 L35.95 58.04 L35.98 58.37 Z M43.01 53.79 L43.22 53.92 L43.44 54.02 L43.59 54.07 L43.75 54.09 L43.87 54.08 L43.98 54.07 L44.30 54.00 L44.62 53.91 L44.68 52.89 L44.05 52.94 L43.42 53.06 L43.35 53.08 L43.28 53.11 L43.22 53.15 L43.16 53.19 L43.10 53.25 L43.01 53.79 Z M51.13 67.62 L52.55 67.85 L52.56 67.41 L52.54 66.97 L52.51 66.62 L52.46 66.28 L52.26 66.32 L52.07 66.39 L51.89 66.48 L51.73 66.60 L51.58 66.73 L51.44 66.88 L51.33 67.05 L51.24 67.23 L51.18 67.42 L51.13 67.62 Z M37.39 65.86 L37.40 65.88 L37.42 65.90 L37.44 65.92 L37.45 65.94 L37.48 66.03 L37.50 66.12 L37.50 66.13 L37.50 66.13 L37.50 66.14 L37.50 66.14 L37.51 66.15 L37.51 66.15 L37.52 66.15 L37.52 66.16 L37.53 66.16 L37.53 66.16 L37.54 66.16 L37.72 66.15 L37.89 66.13 L38.35 66.09 L38.34 66.09 L38.33 66.08 L38.31 66.07 L38.31 66.05 L38.30 66.04 L38.29 66.03 L38.29 66.01 L38.29 66.00 L38.29 65.81 L38.32 65.62 L38.26 65.59 L38.19 65.56 L38.12 65.55 L38.05 65.54 L37.97 65.55 L37.90 65.56 L37.76 65.61 L37.62 65.68 L37.50 65.76 L37.39 65.86 Z M47.17 56.86 L47.30 56.79 L47.42 56.71 L47.53 56.61 L47.63 56.50 L47.71 56.38 L47.78 56.26 L47.84 56.12 L47.19 56.17 L47.17 56.86 Z' },
    { id: 'knives_crossed', label: 'סכינים מוצלבות', defaultWidthMm: 35, fillRule: 'evenodd',
      d: 'M33.05 56.90 L32.80 56.79 L32.56 56.66 L32.28 56.45 L32.03 56.23 L32.17 55.96 L32.35 55.72 L32.62 55.40 L32.93 55.10 L33.38 54.68 L33.82 54.24 L34.08 53.97 L34.33 53.68 L34.58 53.38 L34.84 53.10 L34.95 53.00 L35.07 52.90 L35.26 52.77 L35.45 52.64 L35.52 52.58 L35.59 52.52 L36.76 51.09 L39.24 48.72 L39.31 48.66 L39.38 48.59 L39.87 48.01 L40.36 47.43 L41.70 46.18 L43.33 44.37 L44.97 42.57 L45.07 42.46 L45.18 42.37 L50.64 36.59 L50.66 36.56 L50.69 36.54 L51.04 36.24 L51.39 35.95 L54.81 32.10 L55.48 31.57 L56.08 30.78 L58.55 28.24 L59.23 27.40 L59.97 26.61 L61.70 24.93 L63.49 23.31 L64.62 22.03 L71.42 16.30 L71.20 16.55 L70.96 16.78 L70.70 17.02 L70.44 17.25 L70.14 17.50 L69.86 17.76 L69.44 18.19 L69.04 18.62 L68.77 18.92 L68.49 19.20 L67.55 20.14 L66.59 21.07 L65.69 21.95 L64.81 22.84 L64.46 23.20 L64.13 23.58 L63.03 24.91 L62.48 25.42 L61.95 25.94 L61.83 26.07 L61.73 26.20 L61.60 26.36 L61.47 26.51 L61.01 26.98 L60.54 27.44 L59.47 28.79 L58.25 29.99 L57.93 30.37 L57.60 30.74 L57.12 31.22 L56.63 31.69 L56.14 32.16 L55.67 32.65 L55.15 33.24 L54.66 33.85 L54.43 34.13 L54.19 34.41 L54.07 34.52 L53.95 34.63 L53.76 34.76 L53.58 34.90 L53.51 34.97 L53.43 35.04 L52.25 36.45 L51.94 36.71 L51.64 36.97 L51.62 36.99 L51.60 37.01 L48.61 40.08 L47.47 41.54 L47.40 41.61 L47.33 41.67 L47.08 41.89 L46.82 42.10 L46.56 42.32 L46.32 42.55 L45.73 43.17 L45.15 43.81 L44.53 44.50 L43.89 45.18 L43.58 45.50 L43.25 45.80 L43.14 45.91 L43.03 46.03 L42.75 46.38 L42.48 46.74 L42.23 47.06 L41.96 47.37 L41.72 47.61 L41.46 47.82 L41.28 47.97 L41.12 48.13 L40.97 48.30 L40.83 48.47 L40.67 48.68 L40.51 48.89 L40.42 48.99 L40.31 49.10 L39.79 49.59 L39.27 50.09 L39.18 50.18 L39.09 50.29 L38.90 50.52 L38.70 50.74 L38.26 51.17 L37.80 51.59 L37.65 51.74 L37.51 51.89 L37.31 52.15 L37.12 52.42 L36.95 52.66 L36.76 52.88 L36.42 53.20 L36.06 53.50 L35.90 53.64 L35.75 53.79 L35.47 54.13 L35.20 54.48 L34.93 54.83 L34.65 55.18 L34.47 55.36 L34.29 55.53 L33.89 55.88 L33.52 56.26 L33.27 56.57 L33.05 56.90 Z M66.14 46.40 L66.31 46.21 L66.48 46.00 L66.48 45.99 L66.49 45.98 L73.74 37.49 L73.75 37.48 L73.76 37.47 L74.35 36.84 L74.92 36.19 L76.20 34.67 L77.45 33.13 L78.70 31.58 L79.95 30.04 L80.08 29.89 L80.21 29.74 L80.59 29.33 L80.95 28.89 L81.68 27.91 L82.39 26.90 L82.81 26.27 L83.22 25.64 L83.83 24.68 L84.44 23.71 L85.64 21.61 L86.68 19.41 L87.60 17.03 L88.34 14.57 L88.93 11.86 L89.28 9.09 L89.33 6.88 L89.13 4.66 L89.10 4.44 L89.05 4.21 L88.94 3.73 L88.83 3.25 L88.72 2.78 L88.62 2.32 L88.61 2.26 L88.60 2.21 L88.37 2.27 L88.02 2.54 L87.66 2.81 L87.66 2.81 L87.36 3.03 L87.06 3.25 L86.84 3.39 L86.63 3.53 L75.54 11.71 L75.53 11.71 L75.53 11.71 L75.22 11.93 L74.93 12.16 L74.37 12.63 L73.82 13.12 L73.22 13.66 L72.60 14.18 L72.12 14.56 L71.63 14.92 L71.50 15.02 L71.36 15.13 L71.30 15.20 L71.23 15.27 L71.11 15.42 L70.99 15.56 L70.89 15.65 L70.80 15.75 L70.79 15.75 L70.79 15.76 L67.97 18.15 L67.97 18.15 L67.96 18.15 L67.84 18.25 L67.73 18.36 L67.65 18.45 L67.58 18.53 L67.45 18.70 L67.32 18.86 L67.25 18.94 L67.17 19.03 L67.00 19.19 L66.83 19.36 L66.54 19.62 L66.24 19.87 L65.84 20.22 L65.43 20.56 L65.37 20.61 L65.31 20.66 L58.21 27.55 L58.04 27.74 L57.87 27.92 L57.58 28.20 L57.28 28.48 L57.02 28.72 L56.77 28.97 L56.59 29.16 L56.42 29.37 L56.32 29.50 L56.22 29.63 L56.07 29.83 L55.92 30.03 L55.82 30.15 L55.73 30.28 L55.68 30.34 L55.63 30.39 L55.55 30.48 L55.46 30.56 L55.08 30.89 L54.70 31.21 L54.56 31.33 L54.44 31.46 L54.19 31.76 L53.95 32.07 L53.69 32.41 L53.41 32.75 L53.26 32.91 L53.10 33.06 L53.05 33.11 L52.99 33.16 L52.81 33.30 L52.62 33.45 L52.56 33.51 L52.50 33.56 L52.36 33.71 L52.22 33.85 L52.10 33.98 L51.97 34.11 L51.85 34.22 L51.72 34.33 L51.57 34.46 L51.42 34.58 L51.36 34.63 L51.30 34.68 L47.98 38.43 L47.86 38.56 L47.74 38.69 L47.09 39.33 L46.44 39.95 L45.81 40.56 L45.20 41.19 L44.88 41.54 L44.57 41.92 L44.39 42.15 L44.21 42.38 L44.17 42.42 L44.14 42.46 L44.03 42.58 L43.91 42.68 L43.75 42.83 L43.57 42.96 L43.41 43.09 L43.26 43.23 L42.96 43.55 L42.68 43.89 L42.31 44.31 L41.93 44.72 L41.50 45.16 L41.05 45.58 L40.98 45.65 L40.91 45.72 L40.80 45.85 L40.70 45.99 L40.57 46.17 L40.43 46.34 L40.36 46.43 L40.28 46.51 L40.16 46.63 L40.03 46.74 L39.89 46.85 L39.75 46.95 L39.64 47.03 L39.53 47.11 L39.44 47.20 L39.35 47.29 L39.34 47.29 L39.34 47.29 L37.66 49.07 L37.65 49.08 L37.64 49.08 L37.52 49.21 L37.40 49.34 L37.13 49.69 L36.86 50.04 L36.60 50.38 L36.33 50.70 L36.13 50.89 L35.93 51.06 L35.93 51.06 L35.92 51.06 L35.45 51.42 L35.42 51.44 L35.40 51.47 L35.25 51.65 L35.11 51.83 L34.74 52.33 L34.74 52.33 L34.74 52.33 L34.62 52.47 L34.50 52.61 L34.39 52.72 L34.27 52.83 L33.89 53.16 L33.53 53.50 L32.99 54.03 L32.45 54.58 L31.86 55.23 L31.28 55.90 L31.20 56.01 L31.12 56.12 L32.79 57.74 L33.31 58.15 L33.82 58.57 L34.00 58.73 L34.15 58.91 L34.15 58.92 L34.16 58.92 L34.31 59.13 L34.35 59.17 L34.38 59.21 L34.49 59.30 L34.59 59.39 L34.82 59.57 L35.05 59.74 L35.16 59.82 L35.27 59.90 L35.49 60.04 L35.50 60.05 L35.50 60.05 L35.56 60.10 L35.61 60.14 L36.04 60.60 L36.47 61.05 L36.58 61.16 L36.70 61.27 L37.01 61.50 L37.33 61.73 L37.64 61.95 L37.94 62.20 L38.16 62.41 L38.36 62.64 L42.13 65.92 L42.15 65.93 L42.16 65.94 L42.24 66.04 L42.33 66.14 L42.44 66.29 L42.56 66.44 L42.60 66.50 L42.65 66.55 L42.80 66.68 L42.94 66.80 L43.95 67.53 L43.95 67.53 L43.95 67.53 L44.27 67.78 L44.57 68.05 L44.92 68.37 L45.26 68.71 L45.39 68.83 L45.54 68.93 L45.65 68.99 L45.77 69.04 L46.14 68.54 L46.52 68.04 L46.85 67.66 L47.19 67.29 L47.19 67.29 L47.19 67.29 L47.67 66.82 L47.79 66.69 L47.91 66.57 L48.00 66.46 L48.09 66.35 L48.10 66.34 L48.11 66.33 L49.86 64.43 L49.87 64.42 L49.88 64.41 L49.97 64.33 L50.06 64.26 L50.11 64.23 L50.16 64.20 L50.24 64.12 L50.32 64.04 L59.92 53.41 L59.93 53.40 L59.93 53.39 L60.01 53.31 L60.08 53.23 L60.17 53.10 L60.26 52.97 L60.40 52.75 L60.54 52.53 L60.58 52.47 L60.62 52.42 L60.69 52.32 L60.78 52.22 L60.96 52.04 L61.14 51.85 L61.14 51.85 L61.90 51.10 L62.46 50.52 L62.99 49.91 L63.45 49.35 L63.87 48.77 L64.06 48.51 L64.27 48.27 L64.73 47.80 L65.20 47.34 L65.67 46.88 L66.14 46.40 Z M68.95 55.97 L66.40 53.61 L66.38 53.60 L66.37 53.58 L65.94 53.08 L65.51 52.60 L65.35 52.43 L65.18 52.26 L64.95 52.05 L64.72 51.83 L64.58 51.68 L64.45 51.53 L64.44 51.53 L64.44 51.52 L64.17 51.20 L64.14 51.18 L64.11 51.17 L63.92 51.40 L63.72 51.62 L63.37 51.99 L63.00 52.34 L62.69 52.64 L62.40 52.96 L62.09 53.35 L61.79 53.76 L61.69 53.90 L61.59 54.02 L61.18 54.46 L60.76 54.88 L60.34 55.33 L59.92 55.79 L59.62 56.15 L59.34 56.52 L59.32 56.53 L59.31 56.55 L58.05 57.89 L58.05 57.89 L58.04 57.89 L57.94 57.99 L57.84 58.09 L57.78 58.14 L57.71 58.18 L57.69 58.19 L57.67 58.21 L57.63 58.25 L57.58 58.29 L55.91 60.19 L55.77 60.38 L55.63 60.55 L55.53 60.65 L55.43 60.74 L55.28 60.87 L55.13 60.99 L55.08 61.04 L55.02 61.09 L54.96 61.16 L54.89 61.24 L54.78 61.38 L54.67 61.52 L54.56 61.67 L54.44 61.81 L54.33 61.93 L54.22 62.04 L52.55 63.80 L52.54 63.81 L52.54 63.81 L52.42 63.93 L52.31 64.06 L52.06 64.37 L51.81 64.68 L51.50 65.11 L51.18 65.53 L54.34 68.96 L54.55 68.84 L54.76 68.70 L55.26 68.31 L55.74 67.88 L55.88 67.75 L56.01 67.62 L56.20 67.42 L56.40 67.21 L56.58 67.03 L56.76 66.84 L56.81 66.79 L56.86 66.75 L56.86 66.74 L56.87 66.74 L60.75 63.52 L60.81 63.46 L60.86 63.40 L60.97 63.26 L61.08 63.13 L61.19 63.00 L61.30 62.87 L61.44 62.74 L61.59 62.61 L61.70 62.53 L61.81 62.44 L61.99 62.32 L62.16 62.19 L62.35 62.06 L62.53 61.93 L62.62 61.86 L62.71 61.80 L62.82 61.70 L62.92 61.60 L63.08 61.44 L63.23 61.26 L63.40 61.07 L63.59 60.89 L64.05 60.51 L64.52 60.14 L64.68 60.02 L64.83 59.89 L64.88 59.84 L64.92 59.78 L65.03 59.63 L65.15 59.48 L65.23 59.39 L65.31 59.30 L65.47 59.14 L65.64 59.00 L66.01 58.72 L66.39 58.45 L66.70 58.22 L67.00 57.97 L67.15 57.83 L67.29 57.67 L67.51 57.40 L67.75 57.15 L67.93 56.98 L68.12 56.82 L68.22 56.75 L68.31 56.69 L68.48 56.60 L68.65 56.51 L68.71 56.47 L68.77 56.43 L68.79 56.40 L68.81 56.38 L68.84 56.31 L68.87 56.24 L68.91 56.11 L68.95 55.97 Z M41.68 27.38 L40.11 25.75 L38.50 24.16 L36.99 22.70 L35.46 21.27 L34.63 20.51 L33.78 19.78 L33.77 19.77 L33.76 19.77 L31.46 17.60 L30.86 17.16 L30.86 17.16 L30.85 17.16 L30.69 17.03 L30.53 16.89 L30.40 16.75 L30.27 16.61 L30.06 16.39 L29.85 16.18 L29.47 15.87 L29.09 15.57 L28.61 15.20 L28.15 14.82 L27.73 14.45 L27.33 14.07 L15.21 4.70 L14.86 4.44 L14.50 4.19 L13.78 3.72 L13.05 3.25 L12.23 2.75 L11.40 2.28 L11.38 2.26 L11.36 2.25 L11.12 3.65 L10.93 5.05 L10.81 6.40 L10.75 7.75 L10.76 9.09 L10.84 10.43 L10.98 11.71 L11.20 12.99 L11.47 14.19 L11.81 15.39 L12.25 16.73 L12.76 18.06 L13.26 19.25 L13.81 20.42 L14.57 21.95 L15.38 23.46 L28.01 39.63 L28.07 39.70 L28.12 39.77 L28.20 39.88 L28.28 40.00 L28.32 40.05 L28.35 40.09 L28.44 40.18 L28.52 40.28 L28.53 40.28 L28.54 40.29 L31.85 44.09 L31.86 44.10 L31.86 44.11 L31.97 44.24 L32.07 44.37 L32.34 44.65 L32.61 44.93 L32.90 45.24 L33.17 45.56 L33.60 46.09 L34.02 46.63 L34.16 46.81 L34.31 46.98 L34.72 47.41 L35.14 47.83 L35.47 48.17 L35.77 48.54 L35.93 48.77 L36.07 49.00 L36.15 48.98 L36.24 48.96 L36.32 48.94 L36.41 48.92 L36.49 48.89 L36.56 48.85 L36.63 48.81 L36.69 48.76 L36.75 48.71 L36.80 48.65 L36.92 48.51 L37.04 48.36 L37.64 47.58 L37.64 47.57 L37.64 47.57 L38.17 46.92 L38.74 46.29 L39.17 45.85 L39.62 45.44 L39.62 45.44 L40.29 44.88 L40.46 44.72 L40.63 44.55 L40.81 44.35 L40.99 44.16 L41.03 44.11 L41.06 44.06 L41.40 43.62 L41.74 43.17 L41.99 42.85 L42.26 42.54 L42.41 42.38 L42.58 42.22 L45.86 38.80 L46.01 38.62 L46.18 38.44 L46.39 38.26 L46.60 38.10 L46.76 37.97 L46.91 37.83 L47.24 37.46 L47.56 37.07 L47.86 36.70 L48.18 36.36 L48.42 36.15 L48.67 35.96 L48.79 35.86 L48.90 35.75 L49.02 35.61 L49.12 35.46 L43.99 29.78 L43.92 29.71 L43.85 29.65 L43.65 29.49 L43.45 29.34 L43.30 29.22 L43.16 29.08 L42.97 28.88 L42.80 28.67 L42.25 28.01 L41.68 27.38 Z M4.57 90.75 L4.63 90.52 L4.71 90.31 L4.83 90.11 L4.83 90.11 L4.97 89.94 L5.12 89.79 L5.29 89.66 L5.47 89.56 L5.66 89.49 L5.86 89.44 L6.09 89.41 L6.33 89.42 L6.72 89.46 L7.11 89.53 L7.15 89.54 L7.20 89.56 L7.23 89.58 L7.27 89.61 L7.30 89.64 L7.33 89.68 L7.49 89.97 L7.60 90.28 L7.68 90.60 L7.71 90.92 L7.70 91.15 L7.65 91.37 L7.58 91.58 L7.48 91.78 L7.35 91.96 L7.23 92.10 L7.09 92.21 L6.94 92.31 L6.78 92.39 L6.61 92.45 L6.43 92.48 L6.20 92.50 L5.98 92.49 L5.75 92.44 L5.54 92.37 L5.34 92.27 L5.15 92.14 L4.99 91.99 L4.84 91.82 L4.73 91.62 L4.64 91.42 L4.59 91.26 L4.56 91.09 L4.56 90.92 L4.57 90.75 Z M0.35 93.55 L0.62 94.17 L0.97 94.74 L1.40 95.26 L1.40 95.26 L1.40 95.26 L1.94 95.85 L2.04 95.95 L2.14 96.04 L2.32 96.20 L2.51 96.35 L3.28 96.88 L4.09 97.30 L4.89 97.59 L5.71 97.78 L6.62 97.85 L7.53 97.79 L8.51 97.59 L9.46 97.25 L10.20 96.88 L10.89 96.43 L11.45 95.96 L11.95 95.42 L12.19 95.12 L12.42 94.82 L12.53 94.66 L12.64 94.49 L12.71 94.35 L12.78 94.21 L12.82 94.10 L12.85 93.98 L12.85 93.97 L12.86 93.96 L12.89 93.67 L12.93 93.38 L12.97 93.12 L13.02 92.86 L13.08 92.59 L13.15 92.31 L13.28 91.97 L13.46 91.66 L14.00 90.96 L14.58 90.28 L14.58 90.28 L14.59 90.28 L15.52 89.28 L15.77 89.01 L16.02 88.73 L16.12 88.62 L16.21 88.50 L16.22 88.50 L16.22 88.49 L17.76 86.57 L17.86 86.43 L17.97 86.30 L18.03 86.25 L18.08 86.20 L18.14 86.16 L18.20 86.11 L18.25 86.07 L18.30 86.02 L26.26 77.05 L26.27 77.04 L26.28 77.04 L26.72 76.57 L27.16 76.10 L27.90 75.25 L28.62 74.40 L29.32 73.58 L30.03 72.76 L30.26 72.51 L30.50 72.26 L30.57 72.20 L30.64 72.14 L30.71 72.08 L30.79 72.02 L30.80 72.01 L30.81 72.00 L30.90 71.89 L31.00 71.78 L31.43 71.29 L31.88 70.82 L32.14 70.59 L32.42 70.40 L32.68 70.26 L32.97 70.17 L33.16 70.14 L33.35 70.14 L33.53 70.16 L33.62 70.18 L33.70 70.20 L33.85 70.25 L33.99 70.29 L34.14 70.34 L34.30 70.39 L34.37 70.41 L34.45 70.43 L34.75 70.48 L35.05 70.50 L35.40 70.49 L35.75 70.45 L36.02 70.39 L36.29 70.29 L36.62 70.12 L36.94 69.92 L37.18 69.74 L37.41 69.55 L37.75 69.22 L38.09 68.89 L39.27 67.63 L39.27 67.63 L39.27 67.63 L39.63 67.26 L40.01 66.91 L40.18 66.75 L40.36 66.61 L40.30 66.42 L40.24 66.24 L40.22 66.19 L40.19 66.15 L40.15 66.11 L40.11 66.06 L39.69 65.72 L39.27 65.39 L38.82 65.03 L38.37 64.66 L37.25 63.73 L36.15 62.78 L34.88 61.68 L33.63 60.55 L33.35 60.28 L33.10 59.99 L32.90 59.77 L32.69 59.55 L32.12 59.03 L31.53 58.53 L30.84 57.98 L30.12 57.46 L29.97 57.37 L29.83 57.30 L29.53 57.70 L29.22 58.08 L28.02 59.38 L26.78 60.65 L25.96 61.48 L25.13 62.30 L25.01 62.43 L24.88 62.56 L24.39 63.07 L23.90 63.60 L23.65 63.89 L23.40 64.19 L22.95 64.75 L22.48 65.30 L22.24 65.56 L21.98 65.81 L21.67 66.10 L21.35 66.40 L21.29 66.47 L21.22 66.54 L21.22 66.54 L21.21 66.55 L16.78 71.12 L16.77 71.13 L16.76 71.14 L16.53 71.35 L16.31 71.58 L16.01 71.93 L15.73 72.29 L15.39 72.73 L15.04 73.17 L14.88 73.36 L14.70 73.54 L14.59 73.65 L14.48 73.75 L14.30 73.88 L14.13 74.01 L14.03 74.08 L13.95 74.16 L13.75 74.37 L13.56 74.59 L13.40 74.78 L13.24 74.96 L13.08 75.11 L12.92 75.25 L12.73 75.40 L12.54 75.56 L12.45 75.64 L12.38 75.71 L12.29 75.80 L12.21 75.90 L12.03 76.12 L11.86 76.35 L11.69 76.57 L11.51 76.78 L11.39 76.91 L11.26 77.04 L7.97 80.45 L7.54 80.97 L7.11 81.48 L6.82 81.79 L6.51 82.08 L6.22 82.36 L5.93 82.63 L5.87 82.70 L5.81 82.76 L5.33 83.39 L5.33 83.40 L5.32 83.40 L5.19 83.55 L5.05 83.68 L4.87 83.84 L4.68 83.99 L2.46 86.20 L2.44 86.22 L2.42 86.24 L1.96 86.85 L1.50 87.46 L0.86 88.43 L0.38 89.48 L0.11 90.48 L0.00 91.52 L0.03 92.21 L0.15 92.89 L0.35 93.55 Z M28.78 65.48 L28.65 65.32 L28.55 65.14 L28.46 64.96 L28.41 64.77 L28.37 64.57 L28.36 64.36 L28.38 64.16 L28.42 63.97 L28.49 63.78 L28.59 63.58 L28.72 63.40 L28.87 63.24 L29.06 63.08 L29.26 62.95 L29.48 62.85 L29.69 62.78 L29.91 62.73 L30.13 62.72 L30.34 62.74 L30.53 62.79 L30.72 62.87 L30.88 62.96 L31.03 63.07 L31.16 63.21 L31.33 63.44 L31.45 63.70 L31.53 63.98 L31.56 64.27 L31.54 64.56 L31.47 64.83 L31.39 65.02 L31.28 65.20 L31.14 65.36 L30.98 65.51 L30.80 65.64 L30.61 65.75 L30.38 65.83 L30.14 65.89 L29.89 65.92 L29.68 65.92 L29.46 65.88 L29.26 65.81 L29.08 65.72 L28.92 65.61 L28.78 65.48 Z M17.29 77.30 L17.14 77.08 L17.03 76.84 L16.96 76.64 L16.93 76.42 L16.93 76.23 L16.96 76.05 L17.02 75.87 L17.11 75.70 L17.22 75.54 L17.35 75.40 L17.58 75.21 L17.83 75.03 L18.04 74.90 L18.26 74.81 L18.50 74.74 L18.65 74.72 L18.81 74.72 L18.97 74.74 L19.13 74.78 L19.30 74.84 L19.46 74.94 L19.61 75.05 L19.82 75.28 L19.98 75.54 L20.08 75.77 L20.15 76.01 L20.19 76.26 L20.20 76.51 L20.17 76.76 L20.12 76.94 L20.05 77.11 L19.96 77.27 L19.84 77.42 L19.71 77.54 L19.56 77.65 L19.38 77.75 L19.20 77.81 L19.00 77.86 L18.66 77.88 L18.32 77.86 L18.00 77.78 L17.69 77.65 L17.54 77.56 L17.40 77.44 L17.29 77.30 Z M75.89 79.62 L76.18 79.94 L76.47 80.24 L76.90 80.66 L77.32 81.07 L77.34 81.10 L77.36 81.12 L82.64 87.08 L82.76 87.22 L82.88 87.36 L83.49 88.10 L84.10 88.85 L84.56 89.40 L85.03 89.93 L85.30 90.22 L85.58 90.50 L85.93 90.84 L86.25 91.19 L86.41 91.38 L86.54 91.59 L86.66 91.85 L86.75 92.11 L86.86 92.57 L86.95 93.04 L87.05 93.55 L87.19 94.05 L87.33 94.39 L87.50 94.71 L87.67 94.96 L87.87 95.19 L88.27 95.61 L88.69 96.01 L89.03 96.30 L89.38 96.58 L89.70 96.79 L90.02 96.98 L90.44 97.19 L90.87 97.36 L91.36 97.52 L91.87 97.65 L92.99 97.80 L94.12 97.78 L95.12 97.62 L96.07 97.29 L96.88 96.87 L97.62 96.33 L98.30 95.67 L98.88 94.92 L99.33 94.13 L99.67 93.28 L99.90 92.43 L100.00 91.55 L99.98 90.65 L99.82 89.76 L99.54 88.98 L99.14 88.26 L98.63 87.53 L98.07 86.82 L97.67 86.38 L97.23 85.97 L96.87 85.67 L96.52 85.36 L96.46 85.30 L96.39 85.24 L96.13 84.98 L95.87 84.71 L95.57 84.37 L95.28 84.01 L94.79 83.42 L94.27 82.85 L93.66 82.21 L93.03 81.59 L92.40 80.97 L91.78 80.34 L91.55 80.09 L91.33 79.83 L91.04 79.48 L90.74 79.14 L90.03 78.41 L89.31 77.69 L88.58 76.97 L87.88 76.24 L87.65 76.00 L87.45 75.74 L87.26 75.51 L87.05 75.28 L86.89 75.13 L86.71 74.98 L86.48 74.79 L86.27 74.58 L85.88 74.15 L85.51 73.70 L85.08 73.17 L84.63 72.66 L84.42 72.43 L84.19 72.22 L83.87 71.95 L83.87 71.95 L83.87 71.95 L83.77 71.86 L83.68 71.78 L83.59 71.68 L83.50 71.58 L83.22 71.25 L82.92 70.94 L82.45 70.45 L81.96 69.98 L81.36 69.40 L80.77 68.83 L80.63 68.69 L80.50 68.55 L80.40 68.44 L80.31 68.33 L79.92 67.86 L79.54 67.38 L79.25 67.03 L78.95 66.70 L78.27 65.97 L77.57 65.25 L76.81 64.48 L76.07 63.71 L75.83 63.46 L75.61 63.20 L75.50 63.08 L75.39 62.97 L75.26 62.86 L75.13 62.76 L74.95 62.62 L74.78 62.48 L74.65 62.36 L74.52 62.23 L74.43 62.13 L74.34 62.02 L73.97 61.55 L73.60 61.08 L73.36 60.78 L73.10 60.50 L72.91 60.32 L72.71 60.16 L72.45 59.94 L72.20 59.71 L71.99 59.48 L71.81 59.25 L71.62 58.98 L71.42 58.71 L71.36 58.64 L71.29 58.57 L69.98 57.41 L69.91 57.47 L69.84 57.53 L69.34 57.90 L68.83 58.27 L68.42 58.58 L68.02 58.91 L67.78 59.13 L67.55 59.37 L67.37 59.57 L67.17 59.77 L66.98 59.93 L66.79 60.08 L66.49 60.30 L66.20 60.53 L66.16 60.56 L66.12 60.59 L64.26 62.51 L64.16 62.60 L64.05 62.70 L63.81 62.89 L63.56 63.09 L59.68 66.39 L59.76 66.58 L59.86 66.76 L60.14 67.13 L60.46 67.48 L61.12 68.08 L61.13 68.08 L61.33 68.27 L61.53 68.47 L61.67 68.62 L61.81 68.77 L62.18 69.21 L62.57 69.63 L62.75 69.80 L62.93 69.94 L63.31 70.17 L63.71 70.33 L64.24 70.46 L64.78 70.51 L65.09 70.51 L65.40 70.49 L65.64 70.45 L65.87 70.39 L65.94 70.37 L66.00 70.34 L66.11 70.30 L66.21 70.26 L66.32 70.22 L66.43 70.18 L66.48 70.16 L66.53 70.14 L66.67 70.11 L66.82 70.10 L66.96 70.10 L67.18 70.15 L67.38 70.23 L67.59 70.35 L67.78 70.48 L68.14 70.78 L68.49 71.10 L68.67 71.28 L68.85 71.47 L69.38 72.09 L69.90 72.73 L70.41 73.35 L70.94 73.96 L71.20 74.24 L71.47 74.51 L71.49 74.52 L71.50 74.53 L75.54 79.15 L75.56 79.17 L75.57 79.19 L75.73 79.41 L75.89 79.62 Z M92.66 89.87 L92.77 89.79 L92.88 89.71 L92.90 89.71 L92.91 89.70 L93.06 89.63 L93.28 89.51 L93.51 89.43 L93.75 89.37 L93.91 89.35 L94.07 89.36 L94.24 89.38 L94.39 89.43 L94.57 89.50 L94.73 89.60 L94.88 89.73 L95.02 89.88 L95.14 90.05 L95.24 90.24 L95.33 90.48 L95.38 90.73 L95.41 90.98 L95.39 91.24 L95.34 91.49 L95.29 91.65 L95.21 91.79 L95.12 91.93 L95.02 92.06 L94.90 92.17 L94.76 92.27 L94.62 92.35 L94.40 92.43 L94.18 92.49 L93.95 92.52 L93.73 92.52 L93.51 92.50 L93.29 92.44 L93.09 92.36 L92.90 92.26 L92.72 92.13 L92.58 91.99 L92.46 91.83 L92.36 91.65 L92.27 91.40 L92.21 91.15 L92.18 90.93 L92.19 90.71 L92.23 90.53 L92.29 90.36 L92.37 90.19 L92.48 90.05 L92.56 89.95 L92.66 89.87 Z M70.58 65.77 L70.39 65.84 L70.19 65.88 L69.99 65.89 L69.79 65.89 L69.59 65.85 L69.39 65.80 L69.21 65.72 L69.04 65.62 L68.89 65.50 L68.75 65.36 L68.63 65.21 L68.53 65.04 L68.45 64.86 L68.40 64.66 L68.38 64.47 L68.38 64.27 L68.41 64.08 L68.47 63.89 L68.57 63.70 L68.69 63.51 L68.84 63.35 L69.15 63.09 L69.49 62.89 L69.70 62.80 L69.93 62.74 L70.16 62.71 L70.31 62.72 L70.47 62.74 L70.62 62.78 L70.76 62.84 L70.92 62.94 L71.07 63.05 L71.20 63.19 L71.37 63.43 L71.49 63.71 L71.54 63.91 L71.57 64.12 L71.58 64.33 L71.56 64.54 L71.51 64.74 L71.44 64.94 L71.35 65.12 L71.23 65.29 L71.09 65.44 L70.94 65.57 L70.77 65.69 L70.58 65.77 Z M79.81 76.76 L79.76 76.61 L79.74 76.46 L79.73 76.31 L79.75 76.12 L79.80 75.94 L79.88 75.75 L79.99 75.59 L80.08 75.48 L80.17 75.39 L80.29 75.29 L80.41 75.20 L80.50 75.15 L80.59 75.09 L80.59 75.09 L80.59 75.09 L80.64 75.03 L80.68 74.98 L80.74 74.92 L80.80 74.85 L80.85 74.80 L80.92 74.76 L81.00 74.73 L81.09 74.70 L81.18 74.69 L81.26 74.69 L81.56 74.72 L81.86 74.78 L82.06 74.84 L82.26 74.92 L82.44 75.03 L82.60 75.16 L82.71 75.27 L82.80 75.39 L82.87 75.52 L82.93 75.66 L82.97 75.81 L82.99 76.03 L82.98 76.24 L82.94 76.46 L82.82 76.81 L82.63 77.14 L82.38 77.43 L82.09 77.67 L81.90 77.78 L81.69 77.86 L81.48 77.92 L81.32 77.93 L81.17 77.93 L81.02 77.90 L80.87 77.86 L80.73 77.80 L80.54 77.69 L80.36 77.56 L80.20 77.41 L80.07 77.24 L79.92 77.01 L79.81 76.76 Z' },
    { id: 'cleaver_knife', label: 'סכין וגרזן מוצלבים', defaultWidthMm: 40, fillRule: 'evenodd',
      d: 'M55.39 58.76 L55.46 58.65 L55.54 58.55 L62.24 51.83 L68.95 45.13 L84.47 29.64 L85.18 29.00 L85.46 28.72 L85.74 28.44 L85.78 28.40 L85.82 28.36 L87.92 26.48 L88.07 26.38 L88.21 26.27 L88.27 26.22 L88.33 26.17 L88.64 25.84 L90.48 24.33 L90.80 24.02 L91.56 23.49 L92.38 22.84 L93.21 22.22 L93.70 21.86 L94.21 21.52 L95.05 21.00 L95.57 20.66 L96.11 20.35 L97.07 19.87 L98.04 19.42 L99.48 18.88 L99.65 18.82 L99.83 18.78 L99.91 18.77 L100.00 18.77 L99.98 20.13 L99.93 21.49 L99.87 22.24 L99.78 22.99 L99.68 23.69 L99.57 24.39 L99.52 24.65 L99.47 24.91 L98.74 27.98 L97.81 31.00 L97.02 33.01 L96.06 34.94 L93.52 39.18 L92.60 40.48 L92.51 40.60 L92.42 40.72 L92.39 40.76 L92.36 40.80 L91.13 42.41 L90.87 42.73 L90.77 42.86 L90.67 43.01 L90.65 43.03 L90.64 43.04 L89.89 43.97 L89.14 44.90 L87.89 46.43 L87.86 46.46 L87.84 46.49 L87.74 46.62 L87.64 46.75 L87.61 46.79 L87.57 46.83 L87.47 46.94 L87.37 47.04 L86.64 47.95 L86.37 48.26 L85.59 49.18 L85.07 49.81 L84.58 50.38 L83.00 52.20 L82.46 52.74 L81.98 53.40 L81.44 53.99 L80.91 54.60 L80.09 55.42 L79.86 55.76 L79.05 56.66 L78.28 57.53 L77.19 58.70 L77.16 58.72 L77.14 58.75 L77.13 58.76 L77.11 58.77 L77.07 58.80 L76.63 59.29 L76.49 59.48 L76.34 59.65 L75.70 60.35 L75.04 61.04 L74.50 61.64 L74.36 61.77 L74.22 61.90 L73.88 62.28 L73.55 62.66 L73.26 62.98 L72.94 63.29 L72.75 63.45 L72.54 63.60 L72.13 63.82 L71.71 64.02 L71.59 64.06 L71.46 64.08 L71.33 64.09 L71.09 64.07 L70.86 64.03 L70.63 63.96 L70.41 63.86 L69.80 63.45 L69.27 62.95 L68.59 62.24 L67.88 61.55 L67.69 61.39 L67.48 61.26 L67.24 61.16 L66.99 61.08 L66.73 61.04 L66.47 61.03 L66.21 61.05 L66.02 61.09 L65.83 61.16 L65.66 61.24 L65.50 61.35 L65.35 61.47 L65.22 61.62 L64.66 62.12 L64.22 62.74 L62.49 65.27 L62.42 65.37 L62.35 65.48 L62.30 65.55 L62.26 65.61 L62.06 65.87 L62.09 65.96 L62.14 66.05 L62.19 66.13 L62.33 66.27 L62.48 66.40 L62.57 66.47 L62.67 66.54 L62.71 66.58 L62.75 66.62 L62.98 66.89 L64.87 68.91 L65.80 69.90 L66.26 70.44 L66.76 70.94 L68.13 72.48 L68.26 72.64 L68.40 72.79 L68.51 72.89 L68.62 72.99 L69.09 73.51 L69.24 73.70 L69.36 73.90 L69.46 74.12 L69.52 74.35 L69.56 74.59 L69.56 74.84 L69.54 75.10 L69.48 75.35 L69.40 75.59 L69.29 75.82 L69.16 76.03 L69.01 76.22 L68.72 76.56 L68.41 76.89 L67.96 77.44 L67.57 77.86 L67.17 78.25 L66.54 78.79 L65.90 79.30 L65.51 79.56 L65.11 79.81 L64.57 80.09 L64.02 80.35 L63.01 80.74 L61.98 81.04 L61.14 81.18 L60.30 81.23 L59.86 81.20 L59.43 81.11 L59.03 80.95 L58.64 80.73 L58.48 80.60 L58.33 80.45 L58.20 80.27 L58.10 80.09 L58.02 79.89 L57.98 79.68 L57.84 78.97 L57.65 78.27 L57.41 77.56 L57.11 76.87 L56.09 75.06 L56.02 74.95 L55.95 74.85 L55.61 74.43 L55.27 74.03 L53.97 72.63 L51.56 74.42 L50.96 74.89 L50.43 75.42 L49.36 76.48 L49.12 76.78 L48.92 77.10 L48.76 77.45 L48.54 78.25 L48.42 79.07 L48.36 79.50 L48.24 79.91 L48.05 80.29 L47.95 80.45 L47.82 80.59 L47.68 80.71 L47.53 80.82 L47.36 80.90 L46.96 81.04 L46.55 81.11 L45.46 81.20 L44.36 81.23 L43.53 81.18 L42.72 81.00 L41.94 80.72 L41.20 80.34 L40.53 79.85 L39.92 79.28 L39.65 78.94 L39.43 78.58 L39.25 78.18 L39.12 77.77 L39.04 77.35 L39.01 76.92 L39.04 76.49 L39.12 76.06 L39.26 75.65 L39.41 75.32 L39.62 75.02 L40.63 73.75 L41.69 72.51 L42.10 72.06 L42.52 71.62 L42.68 71.46 L42.85 71.32 L43.09 71.14 L43.52 70.64 L45.33 68.75 L46.23 67.81 L47.11 66.94 L48.00 66.07 L48.03 66.05 L48.07 66.03 L48.10 66.01 L48.10 65.98 L48.08 65.95 L48.07 65.92 L47.98 65.80 L47.89 65.68 L43.34 59.99 L42.91 59.45 L42.47 58.93 L42.30 58.76 L42.13 58.60 L41.87 58.40 L41.58 58.23 L41.27 58.10 L41.01 58.03 L40.74 58.01 L40.46 58.02 L40.40 58.04 L40.34 58.06 L40.29 58.09 L40.07 58.23 L39.88 58.39 L39.77 58.49 L39.67 58.59 L37.61 60.60 L35.55 62.63 L33.62 64.51 L31.68 66.37 L31.56 66.47 L31.43 66.55 L30.61 65.82 L30.52 65.74 L30.44 65.66 L30.34 65.54 L30.24 65.41 L29.81 65.06 L29.45 64.64 L29.01 64.29 L23.69 58.94 L23.53 58.79 L23.38 58.62 L22.78 57.96 L22.19 57.29 L21.67 56.72 L21.15 56.17 L20.95 55.97 L20.73 55.78 L20.43 55.52 L20.13 55.24 L19.81 54.93 L19.50 54.60 L19.08 54.14 L18.66 53.69 L18.55 53.57 L18.43 53.45 L16.92 51.91 L16.22 51.11 L15.91 50.81 L15.61 50.50 L15.53 50.41 L15.46 50.32 L10.72 45.09 L10.69 45.06 L10.67 45.04 L10.15 44.47 L9.63 43.91 L9.28 43.48 L8.23 42.24 L8.15 42.16 L8.07 42.08 L8.05 42.05 L8.02 42.02 L7.17 41.02 L1.40 33.70 L0.38 32.21 L0.15 31.74 L0.00 31.24 L-0.03 31.00 L-0.03 30.76 L0.01 30.52 L0.05 30.42 L0.09 30.32 L0.15 30.23 L0.22 30.14 L0.49 29.89 L0.79 29.68 L1.24 29.36 L4.52 27.30 L6.20 26.24 L7.87 25.20 L8.33 24.92 L8.78 24.65 L12.99 22.03 L13.14 21.92 L13.30 21.81 L14.06 21.32 L14.84 20.83 L15.98 20.19 L17.18 19.67 L18.11 19.38 L19.08 19.23 L19.81 19.21 L20.54 19.28 L21.26 19.45 L21.98 19.71 L22.67 20.05 L23.30 20.48 L24.33 21.53 L24.44 21.67 L24.53 21.82 L24.68 22.10 L24.83 22.39 L24.98 22.72 L25.15 23.04 L25.20 23.14 L25.26 23.24 L30.36 31.08 L30.83 31.75 L32.08 33.49 L32.36 33.78 L32.86 34.41 L33.11 34.80 L33.88 35.74 L34.42 36.40 L34.90 37.07 L35.45 37.73 L36.56 38.97 L37.09 39.56 L38.73 41.48 L38.87 41.60 L39.00 41.71 L39.02 41.73 L39.04 41.75 L39.08 41.80 L39.13 41.85 L39.51 42.27 L39.88 42.68 L48.33 51.24 L48.65 51.49 L52.62 55.77 L52.70 55.88 L52.80 55.98 L52.84 56.02 L52.89 56.07 L53.73 57.00 L54.91 58.17 L55.14 58.45 L55.37 58.73 L55.38 58.74 L55.39 58.76 Z M71.40 57.33 L71.33 57.32 L71.26 57.30 L71.20 57.27 L71.14 57.23 L70.79 56.95 L70.46 56.64 L65.24 51.41 L65.27 51.33 L65.31 51.26 L65.36 51.20 L65.95 50.56 L66.56 49.93 L84.27 32.21 L84.66 31.82 L85.06 31.43 L85.34 31.15 L85.62 30.86 L85.89 30.59 L86.17 30.31 L86.23 30.25 L86.30 30.19 L86.65 29.86 L87.02 29.54 L87.04 29.51 L87.08 29.50 L87.06 29.60 L87.03 29.70 L86.98 29.80 L86.41 30.87 L85.81 31.92 L85.09 33.15 L84.37 34.39 L84.28 34.57 L84.18 34.75 L79.79 42.52 L79.57 42.89 L79.35 43.26 L79.31 43.34 L79.27 43.42 L74.83 51.21 L74.35 52.09 L71.90 56.40 L71.68 56.80 L71.47 57.19 L71.43 57.26 L71.40 57.33 Z M64.43 51.29 L64.44 51.28 L64.44 51.28 L64.45 51.28 L64.46 51.28 L64.47 51.28 L64.48 51.28 L64.49 51.28 L64.50 51.29 L64.51 51.29 L64.52 51.30 L64.52 51.31 L64.53 51.32 L64.56 51.36 L72.70 59.51 L73.31 60.12 L73.88 60.68 L73.92 60.67 L73.95 60.64 L73.98 60.62 L74.03 60.57 L74.07 60.50 L74.15 60.39 L74.24 60.29 L74.34 60.20 L74.35 60.19 L74.35 60.18 L74.81 59.66 L75.26 59.13 L75.80 58.61 L79.18 54.87 L79.68 54.30 L80.17 53.80 L80.63 53.19 L82.52 51.03 L84.47 48.85 L90.00 42.09 L91.02 40.75 L92.01 39.39 L93.14 37.71 L94.23 36.01 L95.10 34.49 L95.85 32.90 L96.74 30.65 L97.50 28.34 L98.14 25.97 L98.64 23.56 L98.86 21.91 L98.93 20.24 L98.78 20.28 L98.63 20.34 L98.11 20.57 L97.60 20.82 L92.64 24.02 L92.45 24.16 L92.26 24.30 L92.17 24.37 L92.08 24.45 L91.22 25.15 L90.90 25.34 L90.35 25.86 L89.80 26.30 L89.55 26.55 L88.67 27.31 L87.81 28.09 L86.40 29.41 L85.00 30.74 L80.88 34.87 L68.57 47.18 L66.55 49.19 L64.52 51.21 L64.48 51.25 L64.43 51.29 Z M5.54 28.88 L5.56 28.87 L5.58 28.86 L6.08 28.54 L6.58 28.22 L6.88 27.95 L10.14 25.66 L13.32 23.36 L13.33 23.35 L13.35 23.34 L13.67 23.12 L13.99 22.89 L15.76 21.64 L15.79 21.63 L15.81 21.62 L15.84 21.62 L15.87 21.62 L15.46 21.90 L10.28 25.11 L6.55 27.42 L4.66 28.59 L1.42 30.70 L1.30 30.79 L1.19 30.90 L1.14 30.95 L1.11 31.01 L2.67 33.45 L3.55 34.63 L4.40 35.77 L4.48 35.85 L4.55 35.94 L5.04 36.56 L5.54 37.19 L5.76 37.46 L6.63 38.58 L7.09 39.12 L7.93 40.06 L8.03 40.18 L8.94 41.22 L9.85 42.26 L9.88 42.30 L9.91 42.34 L10.33 42.92 L11.30 43.95 L11.44 44.09 L11.57 44.24 L11.67 44.36 L11.76 44.48 L11.80 44.53 L11.84 44.58 L11.94 44.68 L12.04 44.77 L12.28 45.01 L12.50 45.25 L12.85 45.68 L13.18 46.12 L15.61 48.67 L16.54 49.81 L17.04 50.29 L17.56 50.77 L18.50 51.89 L19.04 52.36 L20.05 53.40 L21.46 54.98 L22.49 55.95 L23.19 56.71 L23.90 57.47 L23.93 57.50 L23.96 57.53 L24.33 57.83 L24.68 58.15 L25.68 59.14 L26.66 60.15 L27.75 61.27 L28.85 62.39 L29.17 62.70 L29.51 63.01 L30.46 64.05 L31.49 64.97 L31.55 64.86 L31.62 64.75 L31.71 64.66 L33.04 63.39 L34.39 62.15 L35.81 60.66 L35.85 60.62 L35.89 60.58 L36.18 60.23 L36.48 59.87 L36.72 59.60 L36.97 59.34 L37.01 59.31 L37.05 59.29 L37.09 59.27 L37.14 59.25 L35.69 60.26 L34.91 60.76 L34.57 61.01 L34.22 61.26 L34.17 61.29 L34.12 61.31 L34.11 61.31 L34.10 61.30 L34.08 61.29 L34.07 61.28 L34.01 61.24 L33.99 61.22 L33.97 61.20 L33.97 61.20 L33.96 61.20 L33.80 61.05 L33.64 60.89 L33.39 60.59 L33.15 60.29 L32.64 59.81 L29.90 56.85 L29.50 56.33 L29.00 55.83 L28.10 54.81 L27.64 54.35 L26.30 52.84 L25.64 52.07 L24.93 51.37 L24.48 50.82 L24.38 50.73 L24.30 50.63 L24.17 50.48 L24.06 50.32 L23.58 49.87 L23.19 49.34 L20.63 46.55 L20.57 46.47 L20.50 46.39 L20.47 46.35 L20.44 46.32 L19.57 45.34 L18.22 43.77 L18.22 43.77 L18.21 43.76 L17.98 43.54 L17.75 43.33 L17.06 42.51 L16.99 42.44 L16.98 42.44 L16.98 42.44 L16.97 42.42 L16.95 42.41 L15.30 40.51 L12.43 37.26 L12.42 37.24 L12.41 37.22 L12.30 37.11 L12.20 36.99 L7.22 31.09 L6.33 30.05 L6.12 29.76 L6.03 29.64 L5.83 29.41 L5.66 29.16 L5.59 29.02 L5.54 28.88 Z M63.79 51.85 L63.75 51.91 L63.70 51.95 L63.17 52.50 L62.63 53.05 L53.98 61.69 L45.32 70.34 L45.32 70.34 L45.31 70.34 L45.30 70.35 L45.30 70.35 L45.29 70.35 L50.97 64.86 L54.46 61.60 L55.61 60.46 L57.38 58.82 L57.93 58.24 L59.41 56.94 L59.65 56.61 L61.41 54.95 L62.58 53.84 L63.61 52.84 L63.63 52.83 L63.64 52.82 L63.66 52.81 L63.68 52.81 L63.70 52.81 L63.72 52.81 L63.73 52.81 L63.75 52.81 L63.77 52.82 L64.10 53.01 L64.40 53.23 L68.42 56.82 L68.96 57.21 L69.89 58.12 L70.86 58.89 L71.32 59.27 L71.76 59.68 L71.78 59.70 L71.79 59.72 L71.81 59.75 L71.82 59.77 L71.82 59.80 L71.83 59.82 L71.81 59.82 L71.79 59.81 L71.77 59.81 L71.75 59.80 L71.74 59.78 L69.76 57.84 L67.80 55.88 L64.23 52.41 L64.00 52.16 L63.78 51.90 L63.78 51.90 L63.78 51.90 L63.77 51.89 L63.77 51.89 L63.77 51.88 L63.77 51.88 L63.77 51.88 L63.77 51.87 L63.78 51.87 L63.78 51.86 L63.78 51.86 L63.78 51.86 L63.79 51.85 Z M45.72 51.28 L45.60 51.37 L45.49 51.46 L45.39 51.56 L45.30 51.65 L44.86 52.00 L44.04 52.75 L42.72 53.84 L42.35 54.25 L40.68 55.71 L40.37 56.02 L40.03 56.30 L40.01 56.31 L39.98 56.32 L39.96 56.33 L39.93 56.34 L39.91 56.34 L39.88 56.34 L39.90 56.31 L39.92 56.28 L39.95 56.25 L39.99 56.22 L40.61 55.77 L41.41 55.16 L45.11 52.45 L45.69 52.02 L46.29 51.61 L46.31 51.59 L46.34 51.58 L46.37 51.58 L46.40 51.57 L46.43 51.57 L46.51 51.58 L46.59 51.60 L46.67 51.63 L46.74 51.67 L46.81 51.71 L46.87 51.77 L48.20 53.18 L49.47 54.65 L49.62 54.84 L49.78 55.02 L49.85 55.10 L49.93 55.18 L50.47 55.64 L53.38 58.71 L53.43 58.76 L53.49 58.81 L53.68 59.01 L53.88 59.20 L54.27 59.59 L54.30 59.61 L54.32 59.64 L54.33 59.66 L54.34 59.69 L54.34 59.70 L54.35 59.71 L54.35 59.71 L54.34 59.72 L54.34 59.73 L54.34 59.73 L54.34 59.74 L54.33 59.74 L54.33 59.75 L54.32 59.75 L54.37 59.69 L54.43 59.63 L54.53 59.53 L54.63 59.43 L49.53 53.86 L49.01 53.33 L48.54 52.73 L46.53 50.56 L45.72 51.28 Z M43.94 49.22 L43.90 49.22 L43.87 49.21 L43.84 49.19 L43.81 49.17 L43.78 49.15 L42.72 48.11 L41.68 47.05 L39.05 44.30 L37.70 42.80 L36.98 42.09 L36.36 41.29 L34.98 39.81 L32.36 36.76 L32.08 36.32 L31.42 35.56 L31.33 35.43 L31.24 35.30 L31.18 35.22 L31.11 35.15 L30.67 34.52 L26.76 28.84 L26.65 28.65 L26.54 28.46 L26.52 28.42 L26.49 28.38 L24.56 25.34 L24.31 24.92 L26.38 28.53 L27.11 29.79 L27.89 31.02 L29.07 32.80 L30.30 34.55 L36.77 42.31 L43.94 49.22 Z M19.62 22.96 L19.47 23.00 L19.33 23.06 L19.19 23.14 L19.07 23.24 L18.95 23.35 L18.86 23.47 L18.77 23.60 L18.71 23.74 L18.66 23.89 L18.63 24.05 L18.62 24.20 L18.63 24.36 L18.66 24.51 L18.71 24.66 L18.77 24.80 L18.85 24.93 L18.95 25.05 L19.05 25.16 L19.18 25.26 L19.31 25.34 L19.45 25.40 L19.60 25.45 L19.75 25.48 L19.90 25.49 L20.05 25.48 L20.21 25.45 L20.35 25.40 L20.49 25.34 L20.62 25.26 L20.74 25.17 L20.85 25.06 L20.95 24.94 L21.03 24.81 L21.09 24.67 L21.13 24.52 L21.16 24.37 L21.17 24.22 L21.16 24.07 L21.13 23.92 L21.09 23.76 L21.02 23.61 L20.93 23.47 L20.83 23.34 L20.71 23.23 L20.57 23.13 L20.43 23.05 L20.27 22.99 L20.11 22.95 L19.95 22.93 L19.78 22.93 L19.62 22.96 Z M63.30 75.26 L63.16 75.25 L63.02 75.22 L62.88 75.18 L62.76 75.11 L62.64 75.04 L62.53 74.94 L62.43 74.84 L62.35 74.72 L62.28 74.60 L62.23 74.47 L62.19 74.33 L62.18 74.19 L62.18 74.05 L62.19 73.91 L62.23 73.77 L62.28 73.64 L62.35 73.51 L62.43 73.40 L62.53 73.29 L62.65 73.20 L62.78 73.12 L62.91 73.06 L63.06 73.02 L63.20 72.99 L63.35 72.99 L63.50 73.00 L63.65 73.03 L63.79 73.08 L63.93 73.15 L64.05 73.23 L64.17 73.32 L64.27 73.43 L64.31 73.49 L64.35 73.56 L64.37 73.62 L64.39 73.70 L64.40 73.77 L64.40 73.82 L64.39 73.87 L64.37 73.92 L64.35 73.97 L64.32 74.01 L64.29 74.05 L64.24 73.97 L64.19 73.89 L64.12 73.83 L64.04 73.77 L63.96 73.72 L63.88 73.69 L63.79 73.66 L63.70 73.65 L63.58 73.64 L63.46 73.65 L63.35 73.68 L63.23 73.72 L63.13 73.77 L63.03 73.84 L62.94 73.92 L62.89 73.98 L62.84 74.05 L62.81 74.13 L62.79 74.21 L62.77 74.29 L62.77 74.38 L62.78 74.48 L62.80 74.57 L62.84 74.66 L62.88 74.74 L63.30 75.26 Z M62.15 74.48 L62.18 74.61 L62.23 74.74 L62.29 74.86 L62.37 74.98 L62.46 75.08 L62.57 75.17 L62.68 75.25 L62.83 75.33 L63.00 75.39 L63.17 75.43 L63.34 75.45 L63.51 75.44 L63.69 75.41 L63.80 75.38 L63.90 75.33 L64.00 75.27 L64.23 75.08 L64.44 74.85 L64.51 74.76 L64.57 74.66 L64.61 74.55 L64.64 74.44 L64.66 74.25 L64.65 74.07 L64.62 73.88 L64.58 73.74 L64.52 73.60 L64.44 73.46 L64.35 73.34 L64.25 73.23 L64.13 73.14 L64.00 73.05 L63.86 72.99 L63.72 72.94 L63.57 72.91 L63.42 72.90 L63.27 72.90 L63.12 72.93 L63.07 72.94 L63.03 72.95 L62.85 73.05 L62.67 73.15 L62.57 73.21 L62.48 73.29 L62.41 73.37 L62.35 73.46 L62.23 73.72 L62.15 74.00 L62.13 74.16 L62.13 74.32 L62.15 74.48 Z M46.12 56.26 L45.94 56.24 L45.78 56.19 L45.62 56.12 L45.47 56.03 L45.38 55.95 L45.29 55.86 L45.22 55.76 L45.17 55.66 L45.13 55.55 L45.09 55.38 L45.07 55.22 L45.08 55.05 L45.11 54.88 L45.15 54.72 L45.22 54.57 L45.29 54.46 L45.38 54.35 L45.47 54.26 L45.58 54.18 L45.70 54.11 L45.82 54.05 L45.95 54.01 L46.08 53.99 L46.21 53.98 L46.34 54.00 L46.47 54.02 L46.60 54.06 L46.72 54.12 L46.83 54.19 L46.96 54.31 L47.08 54.43 L47.18 54.57 L47.25 54.73 L47.31 54.89 L47.35 55.06 L47.34 55.05 L47.33 55.04 L47.31 55.03 L47.28 55.01 L46.83 54.66 L46.73 54.62 L46.62 54.59 L46.50 54.58 L46.39 54.58 L46.28 54.59 L46.17 54.62 L46.07 54.66 L45.97 54.72 L45.88 54.79 L45.80 54.87 L45.74 54.94 L45.70 55.01 L45.66 55.09 L45.64 55.18 L45.62 55.26 L45.61 55.35 L45.62 55.44 L45.63 55.53 L45.66 55.61 L45.69 55.69 L45.74 55.77 L45.79 55.84 L45.92 55.98 L46.04 56.14 L46.08 56.20 L46.12 56.26 Z M45.00 55.41 L45.02 55.50 L45.04 55.59 L45.08 55.67 L45.12 55.75 L45.30 55.98 L45.51 56.18 L45.64 56.28 L45.79 56.35 L45.95 56.41 L46.12 56.44 L46.30 56.44 L46.48 56.43 L46.63 56.39 L46.78 56.33 L46.93 56.25 L47.06 56.15 L47.17 56.04 L47.27 55.91 L47.36 55.77 L47.43 55.62 L47.47 55.45 L47.50 55.29 L47.51 55.12 L47.49 54.95 L47.46 54.80 L47.41 54.66 L47.34 54.52 L47.25 54.40 L47.15 54.28 L47.03 54.19 L46.89 54.10 L46.74 54.03 L46.59 53.98 L46.43 53.94 L46.26 53.93 L46.10 53.94 L45.94 53.96 L45.79 54.01 L45.65 54.08 L45.51 54.17 L45.39 54.28 L45.29 54.40 L45.19 54.55 L45.11 54.71 L45.05 54.88 L45.01 55.05 L45.00 55.23 L45.00 55.41 Z M60.01 60.40 L60.02 60.28 L60.04 60.16 L60.07 60.04 L60.12 59.93 L60.18 59.83 L60.26 59.73 L60.34 59.64 L60.44 59.57 L60.54 59.51 L60.65 59.46 L60.77 59.42 L60.89 59.40 L61.01 59.40 L61.14 59.41 L61.26 59.44 L61.38 59.47 L61.49 59.53 L61.59 59.60 L61.69 59.68 L61.77 59.77 L61.84 59.88 L61.92 60.02 L61.97 60.18 L62.00 60.34 L62.01 60.50 L62.00 60.66 L61.97 60.82 L61.94 60.92 L61.89 61.01 L61.83 61.10 L61.76 61.18 L61.68 61.25 L61.60 61.31 L61.50 61.35 L61.40 61.39 L61.18 61.32 L61.22 61.26 L61.36 61.09 L61.40 61.02 L61.44 60.95 L61.47 60.87 L61.49 60.79 L61.49 60.71 L61.49 60.63 L61.47 60.52 L61.43 60.42 L61.39 60.32 L61.33 60.23 L61.25 60.15 L61.18 60.09 L61.11 60.04 L61.03 60.00 L60.94 59.97 L60.85 59.95 L60.77 59.94 L60.69 59.94 L60.61 59.96 L60.53 59.98 L60.45 60.02 L60.01 60.40 Z M59.87 60.75 L59.92 60.88 L59.97 61.00 L60.05 61.12 L60.13 61.23 L60.23 61.32 L60.34 61.40 L60.46 61.47 L60.59 61.53 L60.72 61.56 L60.85 61.59 L60.99 61.59 L61.13 61.58 L61.26 61.55 L61.39 61.51 L61.52 61.45 L61.63 61.37 L61.74 61.29 L61.83 61.19 L61.91 61.08 L61.98 60.96 L62.03 60.83 L62.07 60.70 L62.09 60.56 L62.09 60.42 L62.08 60.29 L62.05 60.15 L62.00 60.02 L61.94 59.90 L61.86 59.78 L61.76 59.68 L61.65 59.59 L61.52 59.52 L61.38 59.45 L61.23 59.41 L61.08 59.38 L60.92 59.38 L60.77 59.39 L60.65 59.42 L60.53 59.46 L60.41 59.51 L60.30 59.58 L60.21 59.66 L60.12 59.75 L60.04 59.85 L59.96 59.99 L59.91 60.13 L59.87 60.28 L59.85 60.44 L59.85 60.59 L59.87 60.75 Z M51.98 67.43 L52.01 67.28 L52.07 67.13 L52.15 67.00 L52.25 66.87 L52.33 66.79 L52.43 66.72 L52.53 66.66 L52.64 66.62 L52.76 66.59 L52.89 66.57 L53.02 66.57 L53.15 66.59 L53.28 66.62 L53.40 66.67 L53.52 66.73 L53.63 66.81 L53.73 66.90 L53.81 67.00 L53.88 67.11 L53.94 67.23 L53.98 67.36 L54.01 67.49 L54.02 67.61 L54.01 67.72 L53.99 67.84 L53.95 67.96 L53.90 68.06 L53.84 68.17 L53.76 68.26 L53.68 68.34 L53.58 68.41 L53.48 68.48 L53.37 68.52 L53.26 68.56 L53.14 68.58 L53.02 68.58 L53.16 68.41 L53.27 68.22 L53.35 68.01 L53.41 67.80 L53.42 67.74 L53.42 67.68 L53.42 67.61 L53.40 67.55 L53.38 67.49 L53.35 67.44 L53.32 67.39 L53.28 67.34 L53.18 67.25 L53.07 67.17 L52.95 67.12 L52.88 67.09 L52.81 67.08 L52.73 67.08 L52.66 67.08 L52.06 67.40 L51.98 67.43 Z M54.02 68.00 L54.06 67.87 L54.08 67.73 L54.09 67.59 L54.07 67.46 L54.04 67.32 L54.00 67.19 L53.94 67.06 L53.86 66.95 L53.77 66.84 L53.67 66.75 L53.56 66.67 L53.43 66.60 L53.31 66.55 L53.16 66.51 L53.02 66.49 L52.87 66.49 L52.73 66.51 L52.59 66.55 L52.45 66.61 L52.32 66.68 L52.21 66.77 L52.10 66.87 L52.01 66.99 L51.94 67.11 L51.88 67.25 L51.84 67.38 L51.82 67.51 L51.81 67.65 L51.82 67.79 L51.85 67.92 L51.89 68.05 L51.95 68.17 L52.02 68.29 L52.11 68.39 L52.21 68.49 L52.32 68.57 L52.44 68.64 L52.57 68.69 L52.70 68.73 L52.83 68.75 L52.97 68.75 L53.11 68.74 L53.24 68.71 L53.37 68.66 L53.49 68.60 L53.61 68.53 L53.71 68.44 L53.80 68.34 L53.89 68.23 L53.97 68.11 L54.00 68.06 L54.02 68.00 Z M44.27 75.00 L44.29 74.84 L44.33 74.68 L44.39 74.53 L44.47 74.39 L44.53 74.31 L44.59 74.24 L44.67 74.18 L44.75 74.13 L44.84 74.10 L45.00 74.06 L45.15 74.04 L45.31 74.04 L45.46 74.06 L45.61 74.11 L45.76 74.17 L45.86 74.23 L45.96 74.30 L46.05 74.38 L46.12 74.48 L46.19 74.58 L46.24 74.69 L46.27 74.81 L46.30 74.93 L46.30 75.05 L46.30 75.17 L46.28 75.29 L46.24 75.40 L46.19 75.51 L46.13 75.61 L46.06 75.71 L45.97 75.79 L45.88 75.87 L45.77 75.93 L45.66 75.98 L45.55 76.02 L45.43 76.04 L45.46 75.97 L45.48 75.90 L45.52 75.83 L45.56 75.75 L45.67 75.55 L45.78 75.34 L45.79 75.32 L45.79 75.29 L45.80 75.26 L45.79 75.18 L45.78 75.11 L45.75 75.04 L45.72 74.97 L45.65 74.86 L45.56 74.76 L45.46 74.67 L45.41 74.64 L45.36 74.62 L45.31 74.60 L45.26 74.59 L45.20 74.58 L45.15 74.59 L45.09 74.60 L44.80 74.70 L44.53 74.84 L44.27 75.00 Z M44.14 75.33 L44.18 75.46 L44.23 75.59 L44.30 75.71 L44.38 75.83 L44.48 75.92 L44.59 76.01 L44.72 76.08 L44.86 76.14 L45.01 76.18 L45.16 76.20 L45.31 76.20 L45.46 76.18 L45.60 76.15 L45.73 76.10 L45.85 76.03 L45.96 75.95 L46.06 75.85 L46.14 75.74 L46.22 75.62 L46.28 75.49 L46.32 75.35 L46.35 75.21 L46.35 75.06 L46.34 74.92 L46.31 74.78 L46.26 74.64 L46.20 74.51 L46.12 74.40 L46.02 74.29 L45.91 74.20 L45.78 74.12 L45.64 74.05 L45.50 74.00 L45.35 73.97 L45.20 73.96 L45.04 73.97 L44.92 73.99 L44.81 74.03 L44.70 74.08 L44.59 74.14 L44.50 74.22 L44.41 74.31 L44.34 74.40 L44.26 74.54 L44.20 74.69 L44.15 74.85 L44.13 75.01 L44.13 75.17 L44.14 75.33 Z M67.06 76.75 L67.05 76.85 L67.02 76.94 L66.98 77.03 L66.93 77.11 L66.87 77.18 L66.80 77.25 L65.75 78.04 L64.63 78.75 L63.73 79.20 L62.77 79.55 L61.97 79.72 L61.15 79.78 L60.50 79.76 L59.85 79.68 L59.71 79.65 L59.57 79.60 L59.45 79.52 L59.43 79.51 L59.41 79.48 L59.39 79.46 L59.38 79.44 L59.31 79.24 L59.26 79.03 L58.98 78.03 L58.59 77.07 L58.00 75.95 L57.32 74.89 L56.46 73.69 L56.62 73.82 L56.77 73.97 L56.89 74.13 L57.45 75.10 L57.96 76.09 L58.44 77.21 L58.84 78.36 L58.97 78.97 L59.02 79.60 L59.88 79.92 L60.56 80.03 L61.25 80.06 L61.94 79.99 L62.61 79.84 L63.58 79.48 L64.48 78.97 L65.30 78.33 L65.94 77.83 L67.06 76.75 Z M40.52 78.25 L40.53 78.25 L40.53 78.25 L40.53 78.25 L40.54 78.25 L40.54 78.26 L40.78 78.54 L41.02 78.82 L41.45 79.26 L41.94 79.62 L42.50 79.91 L43.10 80.11 L43.46 80.19 L43.83 80.23 L44.53 80.27 L45.23 80.28 L46.00 80.24 L46.77 80.14 L46.89 80.11 L47.00 80.07 L47.11 80.01 L47.20 79.94 L47.25 79.89 L47.29 79.83 L47.33 79.77 L47.36 79.71 L47.38 79.64 L47.48 79.12 L47.52 78.58 L47.58 77.96 L47.71 77.34 L47.90 76.81 L48.16 76.30 L48.30 76.10 L48.45 75.90 L48.86 75.44 L49.29 74.98 L49.73 74.55 L50.18 74.13 L50.22 74.10 L50.26 74.08 L50.31 74.06 L50.35 74.05 L50.34 74.09 L50.31 74.13 L50.28 74.16 L50.06 74.36 L49.83 74.54 L49.34 74.94 L48.87 75.38 L48.50 75.77 L48.16 76.20 L47.86 76.66 L47.63 77.16 L47.44 77.75 L47.33 78.36 L47.25 78.99 L47.16 79.63 L47.16 79.65 L47.16 79.66 L47.15 79.67 L47.11 79.72 L47.06 79.77 L47.01 79.81 L46.95 79.85 L46.89 79.87 L46.83 79.89 L46.05 80.03 L45.27 80.10 L44.54 80.12 L43.81 80.10 L43.43 80.06 L43.06 80.00 L42.58 79.86 L42.11 79.67 L41.82 79.51 L41.55 79.30 L41.05 78.84 L40.57 78.36 L40.56 78.34 L40.54 78.32 L40.53 78.30 L40.53 78.27 L40.52 78.25 Z M57.68 68.72 L58.88 67.77 L60.01 66.75 L60.70 66.04 L61.32 65.26 L63.99 61.52 L64.53 60.92 L65.14 60.38 L65.35 60.24 L65.59 60.12 L65.84 60.05 L65.96 60.03 L66.07 60.03 L66.87 60.10 L67.67 60.18 L66.90 60.01 L66.54 59.97 L66.17 59.97 L65.83 60.03 L65.51 60.15 L65.06 60.39 L64.65 60.70 L64.13 61.20 L63.66 61.75 L63.56 61.89 L63.45 62.02 L63.40 62.08 L63.34 62.15 L62.73 62.88 L61.64 64.50 L60.47 66.11 L60.13 66.56 L59.73 66.97 L58.70 67.89 L57.63 68.75 L56.30 69.84 L56.26 69.85 L56.22 69.86 L56.21 69.86 L56.20 69.86 L56.18 69.86 L56.17 69.85 L57.68 68.72 Z M48.88 65.23 L48.99 65.02 L48.21 64.09 L48.16 64.04 L48.12 63.99 L48.03 63.88 L47.96 63.77 L45.21 60.61 L44.79 60.02 L44.92 60.14 L45.03 60.27 L45.74 61.20 L46.44 62.14 L47.17 63.13 L47.90 64.10 L47.98 64.21 L48.07 64.30 L48.88 65.23 Z' },
  ];
  if (typeof module === 'object' && module.exports) module.exports = SYMBOLS;
  else root.DEMO_SYMBOLS = SYMBOLS;
}(typeof self !== 'undefined' ? self : this));

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
  const CSS_TEXT = '.dhe { --ground: #f6f4f0; --surface: #ffffff; --surface-2: #f7f5f1; --ink: #1d1a16; --muted: #6b645a; --line: #e0dbd2; --accent: #8f6f33; --accent-ink: #ffffff; --accent-soft: #f2eadb; --brand: #c8a96e; --danger: #b3261e; --danger-soft: #fbeae8; --stage: #e7e3dc; --focus: #2f6fd6; --ok: #1e7b3a; direction: rtl; text-align: right; color: var(--ink); font-family: inherit; font-size: 16px; line-height: 1.4; display: grid; gap: 12px; margin: 12px 0 20px; padding: 12px; background: var(--ground); border: 1px solid var(--line); border-radius: 14px; box-sizing: border-box; width: 100%; max-width: 760px; } .dhe *, .dhe *::before, .dhe *::after { box-sizing: border-box; } .dhe [hidden] { display: none !important; } .dhe button, .dhe textarea, .dhe input, .dhe output { font-family: inherit; color: inherit; margin: 0; text-transform: none; letter-spacing: normal; box-shadow: none; background-image: none; float: none; text-shadow: none; } .dhe button { cursor: pointer; line-height: 1.2; -webkit-tap-highlight-color: transparent; } .dhe :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; } .dhe p { margin: 0; } .dhe h2 { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: .02em; color: var(--muted); line-height: 1.3; } .dhe .dhe-btn { min-height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); font-weight: 600; font-size: 16px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; width: auto; height: auto; } .dhe .dhe-btn:hover { border-color: var(--accent); } .dhe .dhe-btn:disabled { opacity: .45; cursor: default; border-color: var(--line); } .dhe .dhe-btn.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); } .dhe .dhe-btn.primary:hover { filter: brightness(1.06); } .dhe .dhe-btn.danger { color: var(--danger); } .dhe .dhe-btn.icon { width: 44px; padding: 0; } .dhe .dhe-btn svg { width: 20px; height: 20px; } .dhe .dhe-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; } .dhe .dhe-bar .grow { flex: 1; min-width: 0; } .dhe .dhe-confirm { display: flex; gap: 9px; align-items: flex-start; margin: 10px 0 2px; padding: 11px 13px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); font-size: 13.5px; line-height: 1.45; color: var(--ink); cursor: pointer; transition: border-color .15s, background .15s; } .dhe .dhe-confirm input { width: 20px; height: 20px; margin: 0; flex: 0 0 auto; accent-color: var(--accent); cursor: pointer; } .dhe .dhe-confirm.flash { border-color: #b3261e; background: #fdeceb; animation: dhe-flash .4s ease 2; } @keyframes dhe-flash { 50% { border-color: #b3261e; box-shadow: 0 0 0 3px rgba(179,38,30,.15); } } .dhe .dhe-status { font-size: 14px; color: var(--muted); font-weight: 600; margin-top: -4px; } .dhe .dhe-status.ok { color: var(--ok); } .dhe .dhe-status.dirty { color: var(--accent); } .dhe .dhe-test { font-size: 12px; font-weight: 700; color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 2px 9px; } .dhe .dhe-tabs { display: inline-flex; background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; padding: 3px; gap: 3px; justify-self: start; } .dhe .dhe-tabs button { min-height: 38px; padding: 0 16px; border: 0; border-radius: 9px; background: transparent; font-weight: 600; font-size: 15px; color: var(--muted); } .dhe .dhe-tabs button[aria-selected="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.12); } .dhe .dhe-tabs .count { font-weight: 400; color: var(--muted); } .dhe .dhe-stage-wrap { display: grid; gap: 6px; justify-items: center; } .dhe .dhe-stage { position: relative; width: 100%; background: var(--stage); border-radius: 12px; overflow: hidden; } .dhe .dhe-stage img.dhe-bg { position: absolute; inset: 0; width: 100%; height: 100%; max-width: none; display: block; margin: 0; user-select: none; -webkit-user-drag: none; pointer-events: none; border: 0; } .dhe .dhe-stage .canvas-container { position: absolute !important; inset: 0; } .dhe .dhe-stage canvas { max-width: none !important; max-height: none !important; } .dhe .dhe-loading { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font-weight: 600; background: var(--stage); text-align: center; padding: 16px; z-index: 2; } .dhe .dhe-readout { width: 100%; display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; font-size: 13px; color: var(--muted); min-height: 18px; } .dhe .dhe-readout strong { color: var(--ink); font-weight: 600; } .dhe .dhe-quick { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 6px; } .dhe .dhe-size { display: inline-flex; align-items: stretch; border: 2px solid var(--accent); border-radius: 12px; overflow: hidden; background: var(--surface); box-shadow: 0 1px 3px rgba(0,0,0,.12); } .dhe .dhe-size button { width: 60px; min-height: 52px; border: 0; background: var(--accent-soft); color: var(--accent); font-size: 30px; font-weight: 700; line-height: 1; padding: 0; touch-action: manipulation; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; } .dhe .dhe-size button:active { background: var(--accent); color: var(--accent-ink); } .dhe .dhe-size-label { display: inline-flex; align-items: center; justify-content: center; min-width: 96px; padding: 0 14px; font-size: 18px; font-weight: 700; color: var(--ink); } .dhe .dhe-fine { color: var(--muted); font-size: 13px; } .dhe .dhe-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; } .dhe .dhe-toolbar .grow { flex: 1; } .dhe .dhe-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px; display: grid; gap: 12px; } .dhe .dhe-hint { color: var(--muted); font-size: 15px; } .dhe .dhe-edit { position: absolute; top: 6px; left: 6px; right: 6px; z-index: 6; display: flex; gap: 6px; align-items: flex-start; } .dhe .dhe-edit textarea { flex: 1; min-width: 0; min-height: 46px; box-sizing: border-box; border: 2px solid var(--accent); border-radius: 10px; background: rgba(255, 255, 255, 0.95); color: #1d1a16; padding: 9px 12px; font-size: 18px; line-height: 1.35; resize: none; overflow: auto; unicode-bidi: plaintext; text-align: center; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22); } .dhe .dhe-edit textarea:focus { outline: none; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22), 0 0 0 3px var(--accent-soft); } .dhe .dhe-edit textarea::placeholder { color: #8d857a; } .dhe .dhe-edit button { width: 46px; min-height: 46px; border: 0; border-radius: 10px; background: var(--accent); color: var(--accent-ink); font-size: 20px; font-weight: 700; padding: 0; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22); } .dhe .dhe-fonts { display: grid; gap: 8px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; -webkit-overflow-scrolling: touch; } .dhe .dhe-fonts::-webkit-scrollbar { display: none; } .dhe .dhe-fonts.dhe-dragging { cursor: grabbing; } .dhe .dhe-fonts.dhe-dragging .dhe-chip { pointer-events: none; } /* gentle, always-visible scrollbar under the fonts (shows there are more) */ .dhe .dhe-fontscroll { position: relative; height: 4px; border-radius: 999px; background: var(--accent-soft); margin: 6px 6px 0; } .dhe .dhe-fontscroll-thumb { position: absolute; top: 0; height: 100%; min-width: 20%; border-radius: 999px; background: var(--accent); opacity: .5; cursor: grab; touch-action: none; } .dhe .dhe-fontscroll-thumb:active { cursor: grabbing; opacity: .75; } .dhe .dhe-font-row { display: flex; gap: 8px; width: max-content; } .dhe .dhe-chip { flex: 0 0 96px; min-height: 52px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); padding: 5px 8px; display: grid; gap: 1px; text-align: center; cursor: pointer; } .dhe .dhe-chip .sample { font-size: 18px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; unicode-bidi: plaintext; } .dhe .dhe-chip .name { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .dhe .dhe-chip[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); } .dhe .dhe-chip.warn .name { color: var(--danger); } .dhe .dhe-chip.loading { opacity: .55; } .dhe .dhe-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; } .dhe .dhe-stepper { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--surface); } .dhe .dhe-stepper button { width: 44px; min-height: 42px; border: 0; background: var(--surface-2); font-size: 20px; font-weight: 700; padding: 0; touch-action: manipulation; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; } .dhe .dhe-stepper button:active { background: var(--accent-soft); } .dhe .dhe-stepper output { min-width: 128px; text-align: center; font-size: 14px; padding: 0 6px; } .dhe .dhe-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; } .dhe .dhe-seg button { min-height: 42px; padding: 0 12px; border: 0; background: var(--surface-2); font-weight: 600; font-size: 14px; } .dhe .dhe-seg button + button { border-inline-start: 1px solid var(--line); } .dhe .dhe-seg button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); } .dhe .dhe-symbols { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; } .dhe .dhe-sym { border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); padding: 10px 6px 6px; display: grid; gap: 4px; justify-items: center; font-size: 13px; color: var(--muted); } .dhe .dhe-sym svg { width: 44px; height: 38px; color: var(--ink); } .dhe .dhe-sym:hover { border-color: var(--accent); } .dhe .dhe-nudge { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; } .dhe .dhe-nudge-label { font-size: 13px; font-weight: 600; color: var(--muted); margin-inline-end: 4px; } .dhe .dhe-nudge button { width: 44px; height: 44px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); display: inline-grid; place-items: center; padding: 0; touch-action: manipulation; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; } .dhe .dhe-nudge button.wide { width: auto; padding: 0 14px; font-weight: 600; font-size: 14px; } .dhe .dhe-nudge button svg { width: 20px; height: 20px; } .dhe .dhe-nudge button:active { background: var(--accent-soft); border-color: var(--accent); } .dhe .dhe-issues { padding: 10px 14px; background: var(--danger-soft); color: var(--danger); border-radius: 10px; display: grid; gap: 4px; font-size: 14px; font-weight: 600; } .dhe details.dhe-settings { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 0 14px; } .dhe details.dhe-settings summary { min-height: 44px; display: flex; align-items: center; font-weight: 600; cursor: pointer; font-size: 15px; } .dhe details.dhe-settings .body { display: grid; gap: 10px; padding-bottom: 14px; font-size: 15px; } .dhe details.dhe-settings label { display: flex; gap: 8px; align-items: center; font-weight: 400; margin: 0; } .dhe details.dhe-settings input { width: 18px; height: 18px; accent-color: var(--accent); } .dhe .dhe-toast { position: fixed; left: 16px; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); margin: 0 auto; max-width: 520px; background: var(--ink); color: #fff; border-radius: 12px; padding: 12px 16px; font-weight: 600; font-size: 15px; box-shadow: 0 6px 24px rgba(0,0,0,.25); transition: opacity .2s, transform .2s; z-index: 2147483000; opacity: 0; transform: translateY(8px); pointer-events: none; text-align: center; } .dhe .dhe-toast.show { opacity: 1; transform: none; } @media (prefers-reduced-motion: reduce) { .dhe .dhe-toast { transition: none; } } @media (max-width: 420px) { .dhe { padding: 10px; } .dhe .dhe-stepper output { min-width: 108px; } .dhe .dhe-bar .dhe-btn { padding: 0 12px; } } ';
  const VERSION = '202609301647';

  // ------------------------------------------------------------------ config

  const CDN = 'https://cdn.jsdelivr.net/npm/';
  const LIBS = [
    { has: () => window.fabric, src: CDN + 'fabric@5.3.0/dist/fabric.min.js', sri: 'sha384-8E2vEX6CrzCvnhTD2fZ1qYM8/814HwUQP5F3fGZ7HQhjPdrBpUFY2F8ixbfIg8Xr' },
    { has: () => window.opentype, src: CDN + 'opentype.js@1.3.4/dist/opentype.min.js', sri: 'sha384-3TaxGqyHrMuRIWY5Z5WHNIzgNRqGIUJE+mk6tm+g1wkm9Ux2kUyOLfy9AsNWXA6u' },
    { has: () => window.bidi_js, src: CDN + 'bidi-js@1.0.3/dist/bidi.min.js', sri: 'sha384-wQtTdqzwTFhzi4xIX4wrLGvJHshKoK61RCcjZ4lwr/sZBggODJHSpl5bHBcUfeV2' },
    { has: () => window.ClipperLib, src: CDN + 'clipper-lib@6.4.2/clipper.js', sri: 'sha384-oV9/r5hoq7qHFHfbghYwt50E2fe8J20vXRW0eIGQl20k40zMEAhSXMCh9ANASVB9' },
  ];
  const JSZIP = { has: () => window.JSZip, src: CDN + 'jszip@3.10.1/dist/jszip.min.js', sri: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG' };

  // The shared server (Render) that stores the design files and hands the
  // customer a link. Overridable with <script data-dh-api="..."> on the loader.
  const API_BASE = (function () {
    try {
      var s = document.querySelector('script[data-dh-api]');
      if (s && s.getAttribute('data-dh-api')) return s.getAttribute('data-dh-api').replace(/\/+$/, '');
    } catch (e) { /* ignore */ }
    return 'https://dan-harita-api.onrender.com';
  }());

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

  // Symbol id -> exact option name in "סמלים לבחירה" on the product page.
  // When a customer adds a symbol, the matching checkbox is ticked on the
  // order form. Options not yet on the site are still mapped, so ticking
  // starts working automatically once Dan adds them with the same name.
  const SYMBOL_OPTION = {
    heart_hollow: 'לב חלול רגיל',
    heart_fancy: 'לב חלול מעוצב',
    heart_full: 'לב',
    crown: 'כתר',
    star_david: 'מגן דוד',
    chef_hat: 'כובע שף',
    saltbae: 'איש המלח',
    knives_crossed: 'סכינים מוצלבות',
    cleaver_knife: 'סכין וגרזן מוצלבים',
  };

  // A library of engraving surfaces, one entry per kind. `area` (position of
  // the engraving zone within the photo, in %) is optional — without it the
  // box is centred and auto-fitted to the image at the surface's mm ratio,
  // and can be hand-tuned per photo later.
  const SURFACES_LIB = {
    board: {
      slot: 'board', label: 'קרש', fileLabel: 'board',
      areaMm: { w: 280, h: 200 },
      engrave: { color: '#3a2211', opacity: 0.82, blend: 'multiply' },
      minLetterMm: 3, defaultTextMm: 16,
      limits: { textBoxes: 4, symbols: 3, linesPerBox: 3, charsPerLine: 30 },
      textFields: ['טקסט לחריטה קרש, שורה 1', 'טקסט לחריטה קרש, שורה 2', 'טקסט לחריטה קרש, שורה 3', 'טקסט לחריטה קרש'],
      danWrap: 'danWrap_2', placeholder: 'board',
    },
    knife: {
      slot: 'knife', label: 'סכין', fileLabel: 'knife',
      areaMm: { w: 110, h: 24 },
      engrave: { color: '#161616', opacity: 0.8, blend: 'multiply' },
      minLetterMm: 2, defaultTextMm: 8,
      limits: { textBoxes: 2, symbols: 2, linesPerBox: 2, charsPerLine: 24 },
      textFields: ['טקסט לחריטה סכין, שורה 1', 'טקסט לחריטה סכין, שורה 2', 'טקסט לחריטה סכין, שורה 3', 'טקסט לחריטה סכין'],
      danWrap: 'danWrap_1', placeholder: 'knife',
    },
  };

  // Products, by the base name of their engrave-bg images. An image named
  // engrave-bg-<base>-<n> is surface n (1-based) of that base's list, so the
  // number sets the order and the photos are uploaded in that order. Each
  // entry is a surface-library key, or { lib, area } to pin the engraving
  // box on that product's specific photo (area in % of the image).
  const PRODUCTS = {
    // pilot product 2851248, measured on Dan's photos
    'test': [
      { lib: 'board', area: { xPct: 16.5, yPct: 15.0, wPct: 66.5, hPct: 71.3, shape: 'rect' } },
      { lib: 'knife', area: { xPct: 17.9, yPct: 42.0, wPct: 35.5, hPct: 11.6, shape: 'rect' } },
    ],
    'mock': ['board', 'knife'],   // local test images: auto-fit the box
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

  // "test-1" -> { base:'test', index:1 }. No trailing number means index 1.
  function parseKey(key) {
    const m = /^(.*?)-(\d+)$/.exec(key);
    return m ? { base: m[1], index: parseInt(m[2], 10) } : { base: key, index: 1 };
  }

  // A centred box at the surface's mm ratio, ~80% of the image.
  function autoArea(imgW, imgH, areaMm) {
    const rMm = areaMm.w / areaMm.h, rImg = imgW / imgH;
    let wPct = 80, hPct = 80;
    if (rImg > rMm) wPct = hPct * (rMm / rImg); else hPct = wPct * (rImg / rMm);
    return { xPct: (100 - wPct) / 2, yPct: (100 - hPct) / 2, wPct, hPct, shape: 'rect' };
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
      // hidden only when the editor covers every engraving text field on the page.
      enter(surfaces) {
        const mine = new Set();
        for (const s of surfaces) {
          for (const n of s.textFields) { hide(rowOf(textInput(n))); mine.add(n); }
          if (s.danWrap) hide(document.getElementById(s.danWrap));
        }
        const stray = [...form.querySelectorAll('input.clsTextChooseProduct')].some(i => {
          const n = i.getAttribute('property_name') || '';
          return n.indexOf('טקסט לחריטה') === 0 && !mine.has(n) && rowOf(i) && rowOf(i).style.display !== 'none';
        });
        if (!stray) { hide(fontRow); hide(symRow); }
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
  const sizeControl = () => '<div class="dhe-size" role="group" aria-label="גודל">' +
    '<button type="button" data-size="down" aria-label="הקטנה">−</button>' +
    '<span class="dhe-size-label">גודל</span>' +
    '<button type="button" data-size="up" aria-label="הגדלה">+</button></div>';
  // A gentle scrollbar under the font rows, so it's clear there are more fonts
  // to scroll through, and you can drag it to move through them.
  const fontScrollBar = () => '<div class="dhe-fontscroll" data-el="fontScroll" aria-hidden="true"><span class="dhe-fontscroll-thumb" data-el="fontScrollThumb"></span></div>';

  function editorHtml(test) {
    return `
  <div class="dhe-bar">
    <button class="dhe-btn" data-el="btnForMe" type="button">עצבו בשבילי</button>
    <span class="grow"></span>
    ${test ? '<span class="dhe-test">מצב בדיקה</span>' : ''}
    <button class="dhe-btn primary" data-el="btnSave" type="button">אישור סופי של העיצוב</button>
  </div>
  <label class="dhe-confirm" data-el="confirmRow">
    <input type="checkbox" data-el="confirmChk">
    <span>אני מאשר/ת שזהו העיצוב הסופי לחריטה — הטקסט, האיות, הגופן והמיקום נכונים. העיצוב ייחרט בדיוק כפי שהוא נראה כאן, ולא תישלח סקיצה נוספת לאישור.</span>
  </label>
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
    <div class="dhe-readout"><span data-el="selInfo"></span></div>
    <div class="dhe-quick" data-el="quick" hidden>
      ${sizeControl()}
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
    ${fontScrollBar()}
    ${nudgeRow()}
  </section>
  <section class="dhe-panel" data-el="panelSym" hidden>
    <h2 data-el="symTitle">סמל</h2>
    <div class="dhe-row"><button class="dhe-btn danger" data-el="sDelete" type="button">מחיקה</button></div>
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
        // an empty text box: a big, tappable hint frame ("tap here to add
        // text"). The hint itself is drawn in after:render.
        const A = s.areaMm;
        const w = Math.min(A.w * 0.66, A.w - 4), h = Math.min(Math.max(o.sizeMm || 10, A.h * 0.2), A.h - 4);
        fo = new fabric.Rect(Object.assign({}, CTRL, { width: w, height: h, fill: 'rgba(200,169,110,0.12)', left: o.cx, top: o.cy }));
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
      // Pointer handling (mouse and touch alike): a press near an object
      // picks it, and a drag anywhere on the image moves the selection — so
      // on the computer you can drag from near the piece too, not only on it.
      let drag = null, tapT = null;
      canvas._shouldClearSelection = () => false;
      canvas.on('mouse:down', opt => {
        drag = null;
        tapT = null;
        if (opt.target) {
          // pressing on the object's own box — Fabric moves/resizes it itself;
          // remember the start so a tap with no movement can open the text
          tapT = { fo: opt.target, ox: opt.target.left, oy: opt.target.top };
          return;
        }
        // pressed off every object's box: do NOT grab a nearby object and drag
        // it. On touch, a tap close to a text still opens it for writing;
        // otherwise the press just clears the selection.
        const near = COARSE ? nearestObject(canvas.getPointer(opt.e), 22 / k) : null;
        if (near) { canvas.setActiveObject(near); tapT = { fo: near, ox: near.left, oy: near.top, near: true }; }
        else canvas.discardActiveObject();
      });
      const tapToEdit = fo => {
        const o = findObj(fo.dhId);
        if (o && o.type === 'text') startEdit(o);
      };
      canvas.on('mouse:up', () => {
        const t = tapT;
        drag = null;
        tapT = null;
        // a tap (no real move) on/near a text opens it for writing (touch)
        if (t && COARSE && Math.hypot(t.fo.left - t.ox, t.fo.top - t.oy) * k < 3) tapToEdit(t.fo);
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
        // dashed frame + hint on each empty text box (in the mm space)
        const empties = cur().objects.filter(o => o.type === 'text' && !o.text.trim());
        c.setLineDash([5 * px, 4 * px]); c.lineWidth = 1.6 * px; c.strokeStyle = 'rgba(143,111,51,0.85)';
        for (const o of empties) {
          const fo = foMap.get(o.id);
          if (!fo) continue;
          const w = fo.width * fo.scaleX, h = fo.height * fo.scaleY, rr = Math.min(3, h / 3, w / 3);
          c.beginPath();
          if (c.roundRect) c.roundRect(fo.left - w / 2, fo.top - h / 2, w, h, rr); else c.rect(fo.left - w / 2, fo.top - h / 2, w, h);
          c.stroke();
        }
        c.setLineDash([]);
        if (empties.length) {
          const hint = COARSE ? 'לחצו כאן להוספת הטקסט' : 'לחצו כאן פעמיים להוספת הטקסט';
          c.textAlign = 'center'; c.textBaseline = 'middle'; c.direction = 'rtl';
          c.fillStyle = 'rgba(93,74,38,0.95)';
          for (const o of empties) {
            const fo = foMap.get(o.id);
            if (!fo) continue;
            const boxW = fo.width * fo.scaleX;
            let fontMm = 15 / v[0], guard = 0;   // ~15 screen px, shrunk to fit
            c.font = `600 ${fontMm}px "Assistant", system-ui, sans-serif`;
            while (c.measureText(hint).width > boxW * 0.9 && fontMm > 3 / v[0] && guard++ < 40) {
              fontMm *= 0.92; c.font = `600 ${fontMm}px "Assistant", system-ui, sans-serif`;
            }
            c.fillText(hint, fo.left, fo.top);
          }
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
      const rowHe = document.createElement('div'); rowHe.className = 'dhe-font-row';
      const rowEn = document.createElement('div'); rowEn.className = 'dhe-font-row';
      E.fontChips.append(rowHe, rowEn);   // Hebrew on top, English below
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
        (/^en/.test(f.id) ? rowEn : rowHe).appendChild(b);
      }
      updateFontChips(o);
      const on = E.fontChips.querySelector(`[data-font="${o.font}"]`);
      if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      syncFontScroll();
      requestAnimationFrame(syncFontScroll);
    }

    function updateFontChips(o) {
      if (!o || o.type !== 'text') return;
      const line = (o.text.split('\n').find(l => l.trim()) || '').trim();
      const heChars = [...line].filter(c => /[֐-׿]/.test(c));
      const enChars = [...line].filter(c => /[A-Za-z]/.test(c));
      const heSample = (heChars.length ? heChars : [...'אבג']).slice(0, 12).join('');
      const enSample = (enChars.length ? enChars : [...'Abc']).slice(0, 12).join('');
      const clean = EE.cleanText(o.text);
      for (const b of E.fontChips.querySelectorAll('.dhe-chip')) {
        const f = FONTS.find(x => x.id === b.dataset.font);
        const loaded = EE.hasFont(f.id);
        const miss = loaded && EE.checkChars(clean, EE.getFont(f.id)).missing.length > 0;
        b.classList.toggle('warn', miss);
        b.classList.toggle('loading', !loaded);
        b.setAttribute('aria-pressed', String(o.font === f.id));
        b.querySelector('.sample').textContent = /^en/.test(f.id) ? enSample : heSample;
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
      // Selecting/tapping any object collapses the "בחרו סמל" picker grid,
      // so it doesn't linger over the text panel and confuse the customer.
      if (o) { E.symPanel.hidden = true; E.btnAddSym.setAttribute('aria-expanded', 'false'); }
      if (!o) { editId = null; updateReadout(); return; }
      if (o.type === 'text') {
        if (reset || editId !== o.id) buildFontChips(o); else updateFontChips(o);
      } else {
        E.symTitle.textContent = 'סמל: ' + symLabel(o.symbol);
      }
      editId = o.id;
      updateReadout();
    }

    // The only measurement the customer sees: the engraved letter height.
    function updateReadout(liveScale) {
      const fo = canvas && canvas.getActiveObject();
      const o = fo ? findObj(fo.dhId) : null;
      if (o && o.type === 'text' && !fo.dhEmpty) {
        E.selInfo.innerHTML = `גובה אות <strong>${fmt(layoutFor(o).letterHeightMm * (liveScale || 1))} מ״מ</strong>`;
      } else {
        E.selInfo.textContent = '';
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
      // If an empty text box already exists on this surface, don't add another
      // (that confuses people) — just jump back into editing the empty one.
      const empty = cur().objects.find(o => o.type === 'text' && !String(o.text || '').trim());
      if (empty) { syncPanel(true); startEdit(empty); return; }
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

    // The gentle scrollbar under the fonts: reflect the font strip's scroll and
    // let the customer drag it. Always visible, so it's clear there are more
    // fonts to scroll through.
    function fontScrollState() {
      const el = E.fontChips;
      // Cap to the NARROWER row so you can't scroll past the last chip into
      // blank space (the Hebrew and English rows differ a little in width).
      let content = el.scrollWidth || 1;
      for (const r of el.querySelectorAll('.dhe-font-row')) if (r.scrollWidth) content = Math.min(content, r.scrollWidth);
      const max = Math.max(0, content - el.clientWidth);
      return { max, frac: max <= 1 ? 0 : Math.min(1, Math.abs(el.scrollLeft) / max), ratio: el.clientWidth / content };
    }
    function syncFontScroll() {
      const t = E.fontScrollThumb; if (!t) return;
      const { frac, ratio } = fontScrollState();
      const w = Math.min(100, Math.max(16, ratio * 100));
      t.style.width = w + '%';
      t.style.insetInlineStart = (frac * (100 - w)) + '%';
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
      if (isSaved()) { E.status.textContent = 'העיצוב נשמר'; E.status.classList.add('ok'); } else { E.status.textContent = 'יש שינויים שלא נשמרו'; E.status.classList.add('dirty'); }
    }

    function afterChange(commit) {
      renderIssues(validate());
      renderTabs();
      updateUndo();
      updateStatus();
      canvas.requestRenderAll();
      scheduleSync();
      // Any real change means the current design is no longer the one the
      // customer approved, so the final-approval box must be ticked again.
      if (commit && E.confirmChk) E.confirmChk.checked = false;
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

    // base64 of a string (UTF-8 safe — the design JSON holds Hebrew) or a Blob.
    async function toB64(data) {
      let bytes;
      if (typeof data === 'string') bytes = new TextEncoder().encode(data);
      else bytes = new Uint8Array(await data.arrayBuffer());
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return btoa(bin);
    }

    // Sends the design files to the server, which stores them and returns a
    // short code plus a public preview link. Uses our id as the code.
    async function uploadDesign(id, files) {
      const payload = { code: id, productId: bridge.productId, files: {} };
      for (const f of files) payload.files[f.name] = await toB64(f.data);
      const r = await fetch(API_BASE + '/api/designs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let j = {};
      try { j = await r.json(); } catch (e) { /* ignore */ }
      if (!r.ok || !j.ok) throw new Error('upload ' + r.status + ' ' + (j.error || ''));
      return j; // { ok, code, view, preview }
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

    const designFieldText = (id, res) => `עוצב ע״י הלקוח - אין צורך בסקיצה · קוד ${id}`
      + (res && res.view ? ` · ${res.view}` : '')
      + (test ? ' · בדיקה' : '');

    // Remember the saved code in the browser so the site-wide widget can link
    // it to the order number once the customer reaches the payment page. Same
    // origin as the rest of the site, so localStorage is shared.
    const LINK_KEY = 'dh-link-pending';
    function rememberForOrderLink(code) {
      try {
        let arr = JSON.parse(localStorage.getItem(LINK_KEY) || '[]');
        const now = Date.now();
        arr = (Array.isArray(arr) ? arr : []).filter(x => x && x.code !== code && (now - (x.t || 0)) < 24 * 3600e3);
        arr.push({ code, t: now });
        localStorage.setItem(LINK_KEY, JSON.stringify(arr.slice(-20)));
      } catch (e) { /* storage unavailable */ }
    }

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
      // No designer reviews a self-made design, so the customer must actively
      // confirm this is final before it is committed to the order.
      if (!E.confirmChk.checked) {
        toast('יש לאשר את תיבת הסימון: זהו העיצוב הסופי לחריטה');
        E.confirmRow.classList.add('flash');
        E.confirmRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => E.confirmRow.classList.remove('flash'), 1200);
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
        // Store on the server (source of truth for engraving). In test mode a
        // server hiccup shouldn't block — we already have the ZIP; in live mode
        // it must succeed, so the order never carries a design we can't produce.
        let res = null;
        try {
          res = await uploadDesign(id, files);
        } catch (e) {
          console.error('[DHEditor] upload failed', e);
          if (!test) throw e;
          toast('העיצוב נשמר מקומית (השרת לא הגיב).');
        }
        const finalId = (res && res.code) || id;
        savedSnap = designSnap();
        savedId = finalId;
        bridge.setDesignField(designFieldText(finalId, res));
        rememberForOrderLink(finalId);
        saveDraft();
        updateStatus();
        toast('העיצוב נשמר');
      } catch (e) {
        console.error('[DHEditor] save failed', e);
        toast('השמירה לא הצליחה. נסו שוב.');
      } finally {
        saving = false;
        E.btnSave.disabled = false;
        E.btnSave.textContent = 'אישור סופי של העיצוב';
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
      if (dir === 'center') { fo.left = A.w / 2; fo.top = A.h / 2; }
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
      // gentle font scrollbar: reflect the strip's scroll and drag it to move
      E.fontChips.addEventListener('scroll', () => {
        const st = fontScrollState();
        if (st.max > 0 && Math.abs(E.fontChips.scrollLeft) > st.max + 1) {
          const rtl = getComputedStyle(E.fontChips).direction === 'rtl' ? -1 : 1;
          E.fontChips.scrollLeft = rtl * st.max;
        }
        syncFontScroll();
      }, { passive: true });
      window.addEventListener('resize', syncFontScroll);
      (function () {
        const thumb = E.fontScrollThumb, track = E.fontScroll;
        if (!thumb || !track) return;
        let dragging = false, startX = 0, startFrac = 0;
        thumb.addEventListener('pointerdown', e => {
          dragging = true; startX = e.clientX; startFrac = fontScrollState().frac;
          try { thumb.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
          e.preventDefault();
        });
        thumb.addEventListener('pointermove', e => {
          if (!dragging) return;
          const travel = track.clientWidth - thumb.clientWidth, st = fontScrollState();
          if (travel <= 0 || st.max <= 0) return;
          const rtl = getComputedStyle(track).direction === 'rtl' ? -1 : 1;
          const frac = Math.min(1, Math.max(0, startFrac + rtl * (e.clientX - startX) / travel));
          E.fontChips.scrollLeft = rtl * frac * st.max;
          syncFontScroll();
        });
        for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) thumb.addEventListener(ev, () => { dragging = false; });
      }());
      E.pinchHint.hidden = !COARSE;
      // desktop: drag the font strip sideways with the mouse
      (function () {
        const strip = E.fontChips;
        let down = false, moved = false, sx = 0, sl = 0;
        strip.addEventListener('mousedown', e => { down = true; moved = false; sx = e.pageX; sl = strip.scrollLeft; });
        window.addEventListener('mousemove', e => {
          if (!down) return;
          const dx = e.pageX - sx;
          if (!moved && Math.abs(dx) < 5) return;
          moved = true;
          strip.classList.add('dhe-dragging');
          strip.scrollLeft = sl - dx;
        });
        window.addEventListener('mouseup', () => {
          down = false;
          if (moved) setTimeout(() => strip.classList.remove('dhe-dragging'), 0);
        });
      }());
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
    // Group the images by base name and pick the product on the page (the
    // base with the most images — normally the only one). Within it, order
    // by the trailing number, so engrave-bg-<base>-1 is the first surface.
    const parsed = (ctx.bgs || []).map(b => Object.assign(parseKey(b.key), { url: b.url, key: b.key }));
    const byBase = {};
    for (const p of parsed) (byBase[p.base] = byBase[p.base] || []).push(p);
    const base = Object.keys(byBase).sort((a, b) => byBase[b].length - byBase[a].length)[0];
    const imgs = base ? byBase[base].sort((a, b) => a.index - b.index) : [];
    let libKeys = PRODUCTS[base] || (SURFACES_LIB[base] ? [base] : null);
    if (!libKeys) { console.warn('[DHEditor] no product config for "' + base + '", assuming board+knife'); libKeys = ['board', 'knife']; }
    const entries = libKeys.map(e => (typeof e === 'string' ? { lib: e } : e));

    const out = [];
    const usedSlots = new Set();
    const finish = (entry, imgObj, ord) => {
      const lib = SURFACES_LIB[entry.lib];
      const d = Object.assign({}, lib, entry.area ? { area: entry.area } : {}, { key: lib.slot, order: ord, img: imgObj });
      d.area = d.area || autoArea(imgObj.w, imgObj.h, d.areaMm);
      const rImg = (d.area.wPct * imgObj.w) / (d.area.hPct * imgObj.h), rMm = d.areaMm.w / d.areaMm.h;
      if (Math.abs(rImg / rMm - 1) > 0.02) console.warn(`[DHEditor] ${lib.slot}: area ratio ${rImg.toFixed(3)} vs ${rMm.toFixed(3)} mm — the box may not sit on the engraving zone`);
      out.push(d);
      usedSlots.add(lib.slot);
    };
    for (let i = 0; i < imgs.length; i++) {
      const entry = entries[i] || entries[entries.length - 1];
      const lib = SURFACES_LIB[entry.lib];
      if (!lib || usedSlots.has(lib.slot)) continue;
      const im = await loadImage(imgs[i].url);
      finish(entry, { el: im, url: imgs[i].url, w: im.naturalWidth, h: im.naturalHeight }, i);
    }
    // test mode: a surface from the product's list with no image yet gets a
    // drawn stand-in, so both tabs show even from a single placeholder image
    if (ctx.test) {
      entries.forEach((entry, i) => {
        const lib = SURFACES_LIB[entry.lib];
        if (!lib || usedSlots.has(lib.slot) || !lib.placeholder || !lib.textFields.some(bridge.hasField)) return;
        const c = lib.placeholder === 'knife' ? drawKnife() : drawBoard();
        finish(entry, { el: c, url: c.toDataURL('image/jpeg', 0.9), w: c.width, h: c.height }, i);
      });
    }
    for (const s of out) {
      s.textFields = bridge.fieldsPresent(s.textFields);
      s.requiresText = s.textFields.some(bridge.isRequired);
    }
    return out.sort((a, b) => a.order - b.order);
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

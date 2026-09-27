/* Dan Harita design editor 202609271348 */
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

// Sample symbols for the demo (original shapes). Real symbols will come
// from Dan's vector files. Each one is filled shapes only.
(function (root) {
  function starPath(cx, cy, rOut, rIn, n) {
    let d = '';
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 ? rIn : rOut;
      const a = -Math.PI / 2 + i * Math.PI / n;
      d += (i ? 'L' : 'M') + (cx + r * Math.cos(a)).toFixed(3) + ' ' + (cy + r * Math.sin(a)).toFixed(3);
    }
    return d + 'Z';
  }
  // a ring = outer circle clockwise + inner circle counter-clockwise (hole)
  function ringPath(cx, cy, ro, ri) {
    return `M${cx - ro} ${cy}A${ro} ${ro} 0 1 1 ${cx + ro} ${cy}A${ro} ${ro} 0 1 1 ${cx - ro} ${cy}Z` +
           `M${cx - ri} ${cy}A${ri} ${ri} 0 1 0 ${cx + ri} ${cy}A${ri} ${ri} 0 1 0 ${cx - ri} ${cy}Z`;
  }
  const SYMBOLS = [
    { id: 'heart', label: 'לב', defaultWidthMm: 18,
      d: 'M50 88C20 65 5 48 5 30C5 15 17 5 30 5C39 5 46 10 50 17C54 10 61 5 70 5C83 5 95 15 95 30C95 48 80 65 50 88Z' },
    { id: 'star', label: 'כוכב', defaultWidthMm: 18, d: starPath(50, 52, 48, 20, 5) },
    { id: 'rings', label: 'טבעות', defaultWidthMm: 28, d: [ringPath(35, 40, 30, 24), ringPath(75, 40, 30, 24)] },
    { id: 'crown', label: 'כתר', defaultWidthMm: 22,
      d: 'M5 70L10 22L30 44L50 8L70 44L90 22L95 70ZM5 77H95V90H5Z' },
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
  const CSS_TEXT = '.dhe { --ground: #f6f4f0; --surface: #ffffff; --surface-2: #f7f5f1; --ink: #1d1a16; --muted: #6b645a; --line: #e0dbd2; --accent: #8f6f33; --accent-ink: #ffffff; --accent-soft: #f2eadb; --brand: #c8a96e; --danger: #b3261e; --danger-soft: #fbeae8; --stage: #e7e3dc; --focus: #2f6fd6; --ok: #1e7b3a; direction: rtl; text-align: right; color: var(--ink); font-family: inherit; font-size: 16px; line-height: 1.4; display: grid; gap: 12px; margin: 12px 0 20px; padding: 12px; background: var(--ground); border: 1px solid var(--line); border-radius: 14px; box-sizing: border-box; width: 100%; max-width: 760px; } .dhe *, .dhe *::before, .dhe *::after { box-sizing: border-box; } .dhe [hidden] { display: none !important; } .dhe button, .dhe textarea, .dhe input, .dhe output { font-family: inherit; color: inherit; margin: 0; text-transform: none; letter-spacing: normal; box-shadow: none; background-image: none; float: none; text-shadow: none; } .dhe button { cursor: pointer; line-height: 1.2; -webkit-tap-highlight-color: transparent; } .dhe :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; } .dhe p { margin: 0; } .dhe h2 { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: .02em; color: var(--muted); line-height: 1.3; } .dhe .dhe-btn { min-height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); font-weight: 600; font-size: 16px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; width: auto; height: auto; } .dhe .dhe-btn:hover { border-color: var(--accent); } .dhe .dhe-btn:disabled { opacity: .45; cursor: default; border-color: var(--line); } .dhe .dhe-btn.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); } .dhe .dhe-btn.primary:hover { filter: brightness(1.06); } .dhe .dhe-btn.danger { color: var(--danger); } .dhe .dhe-btn.icon { width: 44px; padding: 0; } .dhe .dhe-btn svg { width: 20px; height: 20px; } .dhe .dhe-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; } .dhe .dhe-bar .grow { flex: 1; min-width: 0; } .dhe .dhe-status { font-size: 14px; color: var(--muted); font-weight: 600; margin-top: -4px; } .dhe .dhe-status.ok { color: var(--ok); } .dhe .dhe-status.dirty { color: var(--accent); } .dhe .dhe-test { font-size: 12px; font-weight: 700; color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 2px 9px; } .dhe .dhe-tabs { display: inline-flex; background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; padding: 3px; gap: 3px; justify-self: start; } .dhe .dhe-tabs button { min-height: 38px; padding: 0 16px; border: 0; border-radius: 9px; background: transparent; font-weight: 600; font-size: 15px; color: var(--muted); } .dhe .dhe-tabs button[aria-selected="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.12); } .dhe .dhe-tabs .count { font-weight: 400; color: var(--muted); } .dhe .dhe-stage-wrap { display: grid; gap: 6px; justify-items: center; } .dhe .dhe-stage { position: relative; width: 100%; background: var(--stage); border-radius: 12px; overflow: hidden; } .dhe .dhe-stage img.dhe-bg { position: absolute; inset: 0; width: 100%; height: 100%; max-width: none; display: block; margin: 0; user-select: none; -webkit-user-drag: none; pointer-events: none; border: 0; } .dhe .dhe-stage .canvas-container { position: absolute !important; inset: 0; } .dhe .dhe-stage canvas { max-width: none !important; max-height: none !important; } .dhe .dhe-loading { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font-weight: 600; background: var(--stage); text-align: center; padding: 16px; z-index: 2; } .dhe .dhe-readout { width: 100%; display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; font-size: 13px; color: var(--muted); min-height: 18px; } .dhe .dhe-readout strong { color: var(--ink); font-weight: 600; } .dhe .dhe-quick { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 6px; } .dhe .dhe-size { display: inline-flex; align-items: stretch; border: 2px solid var(--accent); border-radius: 12px; overflow: hidden; background: var(--surface); box-shadow: 0 1px 3px rgba(0,0,0,.12); } .dhe .dhe-size button { width: 60px; min-height: 52px; border: 0; background: var(--accent-soft); color: var(--accent); font-size: 30px; font-weight: 700; line-height: 1; padding: 0; touch-action: manipulation; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; } .dhe .dhe-size button:active { background: var(--accent); color: var(--accent-ink); } .dhe .dhe-size-label { display: inline-flex; align-items: center; justify-content: center; min-width: 96px; padding: 0 14px; font-size: 18px; font-weight: 700; color: var(--ink); } .dhe .dhe-fine { color: var(--muted); font-size: 13px; } .dhe .dhe-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; } .dhe .dhe-toolbar .grow { flex: 1; } .dhe .dhe-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px; display: grid; gap: 12px; } .dhe .dhe-hint { color: var(--muted); font-size: 15px; } .dhe .dhe-edit { position: absolute; top: 6px; left: 6px; right: 6px; z-index: 6; display: flex; gap: 6px; align-items: flex-start; } .dhe .dhe-edit textarea { flex: 1; min-width: 0; min-height: 46px; box-sizing: border-box; border: 2px solid var(--accent); border-radius: 10px; background: rgba(255, 255, 255, 0.95); color: #1d1a16; padding: 9px 12px; font-size: 18px; line-height: 1.35; resize: none; overflow: auto; unicode-bidi: plaintext; text-align: center; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22); } .dhe .dhe-edit textarea:focus { outline: none; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22), 0 0 0 3px var(--accent-soft); } .dhe .dhe-edit textarea::placeholder { color: #8d857a; } .dhe .dhe-edit button { width: 46px; min-height: 46px; border: 0; border-radius: 10px; background: var(--accent); color: var(--accent-ink); font-size: 20px; font-weight: 700; padding: 0; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22); } .dhe .dhe-fonts { display: grid; gap: 8px; overflow-x: auto; padding-bottom: 6px; scrollbar-width: thin; -webkit-overflow-scrolling: touch; } .dhe .dhe-fonts.dhe-dragging { cursor: grabbing; } .dhe .dhe-fonts.dhe-dragging .dhe-chip { pointer-events: none; } .dhe .dhe-font-row { display: flex; gap: 8px; width: max-content; } .dhe .dhe-chip { flex: 0 0 96px; min-height: 52px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); padding: 5px 8px; display: grid; gap: 1px; text-align: center; cursor: pointer; } .dhe .dhe-chip .sample { font-size: 18px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; unicode-bidi: plaintext; } .dhe .dhe-chip .name { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .dhe .dhe-chip[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); } .dhe .dhe-chip.warn .name { color: var(--danger); } .dhe .dhe-chip.loading { opacity: .55; } .dhe .dhe-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; } .dhe .dhe-stepper { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--surface); } .dhe .dhe-stepper button { width: 44px; min-height: 42px; border: 0; background: var(--surface-2); font-size: 20px; font-weight: 700; padding: 0; touch-action: manipulation; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; } .dhe .dhe-stepper button:active { background: var(--accent-soft); } .dhe .dhe-stepper output { min-width: 128px; text-align: center; font-size: 14px; padding: 0 6px; } .dhe .dhe-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; } .dhe .dhe-seg button { min-height: 42px; padding: 0 12px; border: 0; background: var(--surface-2); font-weight: 600; font-size: 14px; } .dhe .dhe-seg button + button { border-inline-start: 1px solid var(--line); } .dhe .dhe-seg button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); } .dhe .dhe-symbols { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; } .dhe .dhe-sym { border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); padding: 10px 6px 6px; display: grid; gap: 4px; justify-items: center; font-size: 13px; color: var(--muted); } .dhe .dhe-sym svg { width: 44px; height: 38px; color: var(--ink); } .dhe .dhe-sym:hover { border-color: var(--accent); } .dhe .dhe-nudge { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; } .dhe .dhe-nudge-label { font-size: 13px; font-weight: 600; color: var(--muted); margin-inline-end: 4px; } .dhe .dhe-nudge button { width: 44px; height: 44px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); display: inline-grid; place-items: center; padding: 0; touch-action: manipulation; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; } .dhe .dhe-nudge button.wide { width: auto; padding: 0 14px; font-weight: 600; font-size: 14px; } .dhe .dhe-nudge button svg { width: 20px; height: 20px; } .dhe .dhe-nudge button:active { background: var(--accent-soft); border-color: var(--accent); } .dhe .dhe-issues { padding: 10px 14px; background: var(--danger-soft); color: var(--danger); border-radius: 10px; display: grid; gap: 4px; font-size: 14px; font-weight: 600; } .dhe details.dhe-settings { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 0 14px; } .dhe details.dhe-settings summary { min-height: 44px; display: flex; align-items: center; font-weight: 600; cursor: pointer; font-size: 15px; } .dhe details.dhe-settings .body { display: grid; gap: 10px; padding-bottom: 14px; font-size: 15px; } .dhe details.dhe-settings label { display: flex; gap: 8px; align-items: center; font-weight: 400; margin: 0; } .dhe details.dhe-settings input { width: 18px; height: 18px; accent-color: var(--accent); } .dhe .dhe-toast { position: fixed; left: 16px; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); margin: 0 auto; max-width: 520px; background: var(--ink); color: #fff; border-radius: 12px; padding: 12px 16px; font-weight: 600; font-size: 15px; box-shadow: 0 6px 24px rgba(0,0,0,.25); transition: opacity .2s, transform .2s; z-index: 2147483000; opacity: 0; transform: translateY(8px); pointer-events: none; text-align: center; } .dhe .dhe-toast.show { opacity: 1; transform: none; } @media (prefers-reduced-motion: reduce) { .dhe .dhe-toast { transition: none; } } @media (max-width: 420px) { .dhe { padding: 10px; } .dhe .dhe-stepper output { min-width: 108px; } .dhe .dhe-bar .dhe-btn { padding: 0 12px; } } ';
  const VERSION = '202609271348';

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
          // Fabric moves/resizes it itself; remember the start so a tap with
          // no movement can open the text for writing (touch only)
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
        else if (d && d.picked && COARSE) tapToEdit(d.fo);   // touch: tap near a text edits it
        else if (d && !d.picked) canvas.discardActiveObject();
        else if (COARSE && t && Math.hypot(t.fo.left - t.ox, t.fo.top - t.oy) * k < 3) tapToEdit(t.fo);
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

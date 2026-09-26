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

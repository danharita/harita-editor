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

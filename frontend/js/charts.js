// Dependency-free SVG/HTML charts. Colours come from CSS variables (--s1..--s8 categorical, --accent sequential) so light/dark swap automatically.
import { h, svg, fmt, hover, tip } from './lib.js';

export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
const seqMix = (p) => `color-mix(in srgb, var(--s1) ${Math.round(8 + 92 * Math.max(0, Math.min(1, p)))}%, var(--surface-3))`;
const niceMax = (v) => { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))); const f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; };

export function legend(items) {
  return h('div', { class: 'legend' }, items.map(([label, color]) => h('span', null, h('i', { style: { background: color } }), label)));
}

/** Vertical bars: data [{label, value, color, tip}] */
export function barChart({ data, height = 200, format = fmt.int, color = 'var(--s1)', refLine, yMax, labelEvery = 1, rotate = false }) {
  const W = 560, H = height, m = { l: 44, r: 10, t: 12, b: rotate ? 44 : 26 };
  const max = yMax || niceMax(Math.max(...data.map((d) => d.value || 0), refLine || 0));
  const bw = (W - m.l - m.r) / data.length;
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  for (let i = 0; i <= 4; i++) {
    const y = m.t + (H - m.t - m.b) * (1 - i / 4);
    s.append(svg('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: i ? 'grid-line' : 'axis-line' }), svg('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end' }, format(max * i / 4)));
  }
  data.forEach((d, i) => {
    const bh = ((d.value || 0) / max) * (H - m.t - m.b), x = m.l + i * bw + bw * 0.16, w = bw * 0.68, y = H - m.b - bh;
    const r = Math.min(4, w / 2, bh);
    const path = svg('path', { class: 'mark', d: `M${x},${H - m.b} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${H - m.b} Z`, fill: d.color || color });
    hover(path, () => d.tip || `<b>${d.label}</b><br>${format(d.value)}`);
    s.append(path);
    if (i % labelEvery === 0) s.append(svg('text', rotate ? { x: x + w / 2, y: H - m.b + 12, 'text-anchor': 'end', transform: `rotate(-35 ${x + w / 2} ${H - m.b + 12})` } : { x: x + w / 2, y: H - 8, 'text-anchor': 'middle' }, d.label));
  });
  if (refLine != null) { const y = H - m.b - (refLine / max) * (H - m.t - m.b); s.append(svg('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, stroke: 'var(--s4)', 'stroke-dasharray': '5 4', 'stroke-width': 1.5 }), svg('text', { x: W - m.r, y: y - 5, 'text-anchor': 'end', fill: 'var(--s4)' }, `base ${format(refLine)}`)); }
  return s;
}

/** Horizontal bar rows (HTML): rows [{label, value, sub, color, href}] */
export function hbars({ rows, format = fmt.int, max, labelW = 150 }) {
  const m = max || Math.max(...rows.map((r) => r.value || 0), 1);
  return h('div', { class: 'col', style: { gap: '9px' } }, rows.map((r) => {
    const bar = h('div', { class: 'bar-inline', style: { height: '9px', flex: 1 } }, h('i', { style: { width: `${Math.max(1.5, (r.value / m) * 100)}%`, background: r.color || 'var(--s1)' } }));
    const row = h('div', { class: 'row', style: { gap: '10px' } }, h('div', { style: { width: labelW + 'px', fontSize: '12.5px' }, class: 't2 nowrap' }, r.href ? h('a', { href: r.href }, r.label) : r.label), bar,
      h('div', { style: { width: '78px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: '12.5px' } }, format(r.value)), r.sub ? h('div', { class: 'muted', style: { width: '64px', fontSize: '11.5px' } }, r.sub) : null);
    hover(row, () => r.tip || `<b>${r.label}</b><br>${format(r.value)}${r.sub ? ' · ' + r.sub : ''}`);
    return row;
  }));
}

/** Multi-series line/area with crosshair. x: labels[], series: [{name, values, color, area}] */
export function lineChart({ x, series, height = 230, format = fmt.int, stacked = false }) {
  const W = 640, H = height, m = { l: 48, r: 14, t: 14, b: 28 };
  const all = stacked ? x.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0)) : series.flatMap((s) => s.values.map((v) => v || 0));
  const max = niceMax(Math.max(...all, 1));
  const px = (i) => m.l + (x.length === 1 ? (W - m.l - m.r) / 2 : (i / (x.length - 1)) * (W - m.l - m.r));
  const py = (v) => m.t + (1 - v / max) * (H - m.t - m.b);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  for (let i = 0; i <= 4; i++) { const y = py(max * i / 4); s.append(svg('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: i ? 'grid-line' : 'axis-line' }), svg('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end' }, format(max * i / 4))); }
  x.forEach((l, i) => { if (x.length <= 12 || i % Math.ceil(x.length / 10) === 0) s.append(svg('text', { x: px(i), y: H - 8, 'text-anchor': 'middle' }, l)); });
  let base = x.map(() => 0);
  series.forEach((sr, si) => {
    const color = sr.color || SERIES[si];
    const top = sr.values.map((v, i) => (stacked ? base[i] : 0) + (v || 0));
    const pts = top.map((v, i) => `${px(i)},${py(v)}`);
    if (sr.area || stacked) {
      const bot = base.map((v, i) => `${px(i)},${py(stacked ? v : 0)}`).reverse();
      s.append(svg('polygon', { points: pts.concat(bot).join(' '), fill: color, opacity: stacked ? 0.78 : 0.14, stroke: stacked ? 'var(--surface)' : 'none', 'stroke-width': 1.5 }));
    }
    if (!stacked || si === series.length - 1 || true) s.append(svg('polyline', { points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    if (stacked) base = top;
  });
  const cross = svg('line', { y1: m.t, y2: H - m.b, stroke: 'var(--border-2)', 'stroke-width': 1, opacity: 0 }); s.append(cross);
  const dots = series.map((sr, si) => { const c = svg('circle', { r: 4.5, fill: sr.color || SERIES[si], stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 }); s.append(c); return c; });
  const hit = svg('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' });
  hit.addEventListener('mousemove', (e) => {
    const r = s.getBoundingClientRect(); const rel = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(x.length - 1, Math.round(((rel - m.l) / (W - m.l - m.r)) * (x.length - 1))));
    cross.setAttribute('x1', px(i)); cross.setAttribute('x2', px(i)); cross.setAttribute('opacity', 1);
    let acc = 0;
    dots.forEach((d, si) => { acc += stacked ? (series[si].values[i] || 0) : 0; d.setAttribute('cx', px(i)); d.setAttribute('cy', py(stacked ? acc : series[si].values[i] || 0)); d.setAttribute('opacity', 1); });
    tip(`<b>${x[i]}</b>` + series.map((sr, si) => `<br><span style="color:${sr.color || SERIES[si]}">●</span> ${sr.name}: <b>${(sr.format || format)(sr.values[i] || 0)}</b>`).join(''), e);
  });
  hit.addEventListener('mouseleave', () => { cross.setAttribute('opacity', 0); dots.forEach((d) => d.setAttribute('opacity', 0)); tip(null); });
  s.append(hit);
  return s;
}

/** XY chart for ROC / calibration: series [{name, points:[[x,y]], color, dash}], diag */
export function xyChart({ series, height = 260, xLabel, yLabel, diag = true, xFmt = (v) => v.toFixed(1), yFmt = (v) => v.toFixed(1) }) {
  const W = 420, H = height, m = { l: 44, r: 12, t: 10, b: 36 };
  const px = (v) => m.l + v * (W - m.l - m.r), py = (v) => m.t + (1 - v) * (H - m.t - m.b);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  for (let i = 0; i <= 5; i++) { const v = i / 5; s.append(svg('line', { x1: m.l, x2: W - m.r, y1: py(v), y2: py(v), class: i ? 'grid-line' : 'axis-line' }), svg('text', { x: m.l - 6, y: py(v) + 4, 'text-anchor': 'end' }, yFmt(v)), svg('text', { x: px(v), y: H - m.b + 14, 'text-anchor': 'middle' }, xFmt(v))); }
  if (diag) s.append(svg('line', { x1: px(0), y1: py(0), x2: px(1), y2: py(1), stroke: 'var(--muted)', 'stroke-dasharray': '4 4', opacity: 0.7 }));
  s.append(svg('text', { x: (m.l + W - m.r) / 2, y: H - 4, 'text-anchor': 'middle' }, xLabel || ''), svg('text', { x: 11, y: H / 2, 'text-anchor': 'middle', transform: `rotate(-90 11 ${H / 2})` }, yLabel || ''));
  series.forEach((sr, i) => {
    const c = sr.color || SERIES[i];
    if (sr.area) s.append(svg('polygon', { points: [[0, 0], ...sr.points, [1, 0]].map(([a, b]) => `${px(a)},${py(b)}`).join(' '), fill: c, opacity: 0.1 }));
    s.append(svg('polyline', { points: sr.points.map(([a, b]) => `${px(a)},${py(b)}`).join(' '), fill: 'none', stroke: c, 'stroke-width': 2.2, 'stroke-dasharray': sr.dash || null, 'stroke-linejoin': 'round' }));
    if (sr.dots) sr.points.forEach(([a, b], k) => { const d = svg('circle', { cx: px(a), cy: py(b), r: 4.5, fill: c, stroke: 'var(--surface)', 'stroke-width': 2, class: 'mark' }); hover(d, () => sr.dots[k] || `${xFmt(a)}, ${yFmt(b)}`); s.append(d); });
  });
  return s;
}

export function donut({ slices, size = 170, center, thickness = 22, format = fmt.int }) {
  const R = size / 2 - 4, r = R - thickness, cx = size / 2, tot = slices.reduce((a, b) => a + b.value, 0) || 1;
  const s = svg('svg', { viewBox: `0 0 ${size} ${size}`, class: 'chart', style: `max-width:${size}px;margin:auto` });
  let a0 = -Math.PI / 2;
  slices.forEach((sl, i) => {
    if (!sl.value) return;
    const a1 = a0 + (sl.value / tot) * Math.PI * 2 - (slices.filter((x) => x.value).length > 1 ? 0.025 : 0), large = a1 - a0 > Math.PI ? 1 : 0;
    const P = (rad, a) => `${cx + rad * Math.cos(a)},${cx + rad * Math.sin(a)}`;
    const p = svg('path', { class: 'mark', d: `M${P(R, a0)} A${R},${R} 0 ${large} 1 ${P(R, a1)} L${P(r, a1)} A${r},${r} 0 ${large} 0 ${P(r, a0)} Z`, fill: sl.color || SERIES[i] });
    hover(p, () => `<b>${sl.label}</b><br>${format(sl.value)} · ${fmt.pct(sl.value / tot)}`); s.append(p); a0 += (sl.value / tot) * Math.PI * 2;
  });
  if (center) s.append(svg('text', { x: cx, y: cx + 2, 'text-anchor': 'middle', style: 'font-size:22px;font-weight:700;fill:var(--text)' }, center.value), svg('text', { x: cx, y: cx + 18, 'text-anchor': 'middle' }, center.label));
  return h('div', null, s, legend(slices.map((sl, i) => [`${sl.label} (${format(sl.value)})`, sl.color || SERIES[i]])));
}

/** Funnel: stages [{stage, n}] -> bars scaled to first stage, step conversion between bars */
export function funnel({ stages, onClick }) {
  const top = stages[0].n || 1;
  return h('div', { class: 'col', style: { gap: '6px' } }, stages.map((st, i) => {
    const prev = i ? stages[i - 1].n : null, w = Math.max(3, (st.n / top) * 100);
    const row = h('div', { style: { display: 'grid', gridTemplateColumns: '170px 1fr 120px', alignItems: 'center', gap: '12px', cursor: onClick ? 'pointer' : 'default' }, onclick: onClick ? () => onClick(st) : null },
      h('div', { class: 't2', style: { fontSize: '12.5px' } }, st.stage),
      h('div', { style: { background: 'var(--surface-3)', borderRadius: '8px', height: '26px', overflow: 'hidden' } }, h('div', { class: 'mark', style: { width: w + '%', height: '100%', borderRadius: '8px', background: 'var(--s1)', opacity: String(0.5 + 0.5 * (i / (stages.length - 1 || 1))), transition: 'width .8s cubic-bezier(.2,.8,.2,1)' } })),
      h('div', { style: { fontVariantNumeric: 'tabular-nums', textAlign: 'right' } }, h('b', null, fmt.int(st.n)), h('span', { class: 'muted', style: { marginLeft: '8px', fontSize: '11.5px' } }, i ? `${fmt.pct(st.n / prev, 0)} of prev` : '100%')));
    hover(row, () => `<b>${st.stage}</b><br>${fmt.int(st.n)} (${fmt.pct(st.n / top)} of captured)${prev ? `<br><span class="k">drop-off ${fmt.int(prev - st.n)}</span>` : ''}`);
    return row;
  }));
}

/** Heatmap grid: rows[], cols[], value(r,c) -> {v, label, tip} */
export function heatmap({ rows, cols, cell, max, cw = 92, ch = 38, labelW = 100 }) {
  const W = labelW + cols.length * cw, H = 28 + rows.length * ch;
  const mx = max || Math.max(...rows.flatMap((r) => cols.map((c) => cell(r, c)?.v || 0)), 1);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', style: `min-width:${Math.min(W, 420)}px` });
  cols.forEach((c, j) => s.append(svg('text', { x: labelW + j * cw + cw / 2, y: 16, 'text-anchor': 'middle', class: 'lbl-2' }, c)));
  rows.forEach((r, i) => {
    s.append(svg('text', { x: labelW - 10, y: 28 + i * ch + ch / 2 + 4, 'text-anchor': 'end', class: 'lbl-2' }, r));
    cols.forEach((c, j) => {
      const d = cell(r, c) || { v: 0 }; const p = d.v / mx;
      const rect = svg('rect', { class: 'heat-cell', x: labelW + j * cw + 2, y: 28 + i * ch + 2, width: cw - 4, height: ch - 4, rx: 7, fill: d.bad ? 'color-mix(in srgb, var(--err) 55%, var(--surface-3))' : seqMix(p) });
      hover(rect, () => d.tip || `<b>${r} · ${c}</b><br>${d.label ?? d.v}`);
      s.append(rect, svg('text', { x: labelW + j * cw + cw / 2, y: 28 + i * ch + ch / 2 + 4, 'text-anchor': 'middle', style: `fill:${p > 0.55 ? '#fff' : 'var(--text)'};font-weight:600;pointer-events:none` }, d.label ?? d.v));
    });
  });
  return s;
}

/** Semi-circle gauge for a 0-100 score with band cut-offs */
export function gauge({ value, hot = 70, warm = 40, size = 190 }) {
  const W = size, R = size / 2 - 14, cx = W / 2, cy = W / 2 + 6, sw = 15;
  const ang = (v) => Math.PI * (1 - v / 100);
  const pt = (v, rad = R) => [cx + rad * Math.cos(ang(v)), cy - rad * Math.sin(ang(v))];
  const arc = (a, b, color) => { const [x1, y1] = pt(a), [x2, y2] = pt(b); return svg('path', { d: `M${x1},${y1} A${R},${R} 0 0 1 ${x2},${y2}`, stroke: color, 'stroke-width': sw, fill: 'none', 'stroke-linecap': 'butt', opacity: 0.3 }); };
  const s = svg('svg', { viewBox: `0 0 ${W} ${W / 2 + 34}`, class: 'chart', style: `max-width:${size}px;margin:auto` });
  s.append(arc(0, warm, 'var(--cold)'), arc(warm, hot, 'var(--warm)'), arc(hot, 100, 'var(--hot)'));
  const col = value >= hot ? 'var(--hot)' : value >= warm ? 'var(--warm)' : 'var(--cold)';
  const [x2, y2] = pt(Math.max(0.01, value)); const [x1, y1] = pt(0);
  s.append(svg('path', { d: `M${x1},${y1} A${R},${R} 0 0 1 ${x2},${y2}`, stroke: col, 'stroke-width': sw, fill: 'none', 'stroke-linecap': 'round' }));
  s.append(svg('text', { x: cx, y: cy - 6, 'text-anchor': 'middle', style: 'font-size:34px;font-weight:750;fill:var(--text)' }, value), svg('text', { x: cx, y: cy + 14, 'text-anchor': 'middle' }, '/ 100'));
  return s;
}

/** Single stacked horizontal bar with 2px gaps: segments [{label, value, color}] */
export function stackedBar({ segments, total, height = 22 }) {
  const t = total || segments.reduce((a, b) => a + b.value, 0) || 1;
  const bar = h('div', { style: { display: 'flex', gap: '2px', height: height + 'px', borderRadius: '8px', overflow: 'hidden', background: 'var(--surface-3)' } },
    segments.filter((s) => s.value > 0).map((s) => hover(h('div', { class: 'mark', style: { width: `${(s.value / t) * 100}%`, background: s.color, borderRadius: '3px' } }), () => `<b>${s.label}</b><br>${fmt.dec(s.value, 0)} pts`)));
  return bar;
}

export function sparkline(values, { color = 'var(--s1)', w = 90, hgt = 30 } = {}) {
  if (!values.length) return svg('svg', { width: w, height: hgt });
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * (w - 4) + 2},${hgt - 3 - ((v - min) / (max - min || 1)) * (hgt - 8)}`);
  const s = svg('svg', { width: w, height: hgt, class: 'spark', viewBox: `0 0 ${w} ${hgt}` });
  s.append(svg('polygon', { points: `2,${hgt} ${pts.join(' ')} ${w - 2},${hgt}`, fill: color, opacity: 0.14 }), svg('polyline', { points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-linejoin': 'round' }));
  return s;
}

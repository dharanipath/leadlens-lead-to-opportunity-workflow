// LeadLens shared UI toolkit: DOM helper, API client, formatters, icons, components. No dependencies.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Hyperscript. attrs: class, style(obj|string), on<Event>, html, dataset, any attribute; children: nodes|strings|arrays|null */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs && (attrs.nodeType || typeof attrs === 'string' || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c.nodeType ? c : document.createTextNode(String(c))); };
  kids.forEach(add);
  return el;
}
export function svg(tag, attrs, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v == null) continue; if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v); else el.setAttribute(k, v); }
  const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c.nodeType ? c : document.createTextNode(String(c))); };
  kids.forEach(add);
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const mount = (el, ...kids) => { clear(el); kids.forEach((k) => k && el.append(k.nodeType ? k : document.createTextNode(k))); return el; };

// ------------------------------------------------------------------------------------------------ roles
export const ROLES = {
  prospect: { label: 'Prospect', sub: 'Customer / prospect — submits interest, manages consent', initials: 'PR', home: '#/portal' },
  ops: { label: 'Marketing / Sales Ops', sub: 'Owns scoring, routing, campaigns, consent & de-dup', initials: 'OP', home: '#/overview' },
  agent: { label: 'Support / Sales Agent', sub: 'Works follow-up tasks, logs activity, moves deals', initials: 'AG', home: '#/workbench' },
  analyst: { label: 'Analyst', sub: 'Funnel, exceptions, held-out evaluation, SQL', initials: 'AN', home: '#/overview' },
  admin: { label: 'System Administrator', sub: 'Rule versions, validation, reproducibility, audit', initials: 'AD', home: '#/overview' },
};
export const role = {
  get() { try { return localStorage.getItem('ll_role') || 'ops'; } catch { return 'ops'; } },
  set(r) { try { localStorage.setItem('ll_role', r); } catch { /* ignore */ } },
};

// ------------------------------------------------------------------------------------------------ api
export class ApiError extends Error { constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.body = body || {}; } }
async function request(method, path, body) {
  const res = await fetch(path, { method, headers: { 'X-Role': role.get(), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
const qs = (p) => { const e = Object.entries(p || {}).filter(([, v]) => v !== '' && v != null); return e.length ? '?' + new URLSearchParams(e).toString() : ''; };
export const api = { get: (path, params) => request('GET', path + qs(params)), post: (path, body, params) => request('POST', path + qs(params), body ?? {}) };

// ------------------------------------------------------------------------------------------------ formatters
const nf = new Intl.NumberFormat('en-US');
export const fmt = {
  int: (n) => (n == null ? '—' : nf.format(Math.round(n))),
  dec: (n, d = 1) => (n == null ? '—' : Number(n).toFixed(d)),
  pct: (n, d = 1) => (n == null ? '—' : (n * 100).toFixed(d) + '%'),
  money: (n) => (n == null ? '—' : '$' + nf.format(Math.round(n))),
  moneyShort: (n) => { if (n == null) return '—'; const a = Math.abs(n); return (n < 0 ? '-' : '') + '$' + (a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K' : Math.round(a)); },
  short: (n) => { if (n == null) return '—'; const a = Math.abs(n); return a >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K' : String(Math.round(n)); },
  date: (s) => (s ? String(s).slice(0, 10) : '—'),
  ts: (s) => (s ? String(s).replace('T', ' ').replace('Z', '').slice(0, 16) : '—'),
  title: (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  hours: (h_) => (h_ == null ? '—' : Math.abs(h_) >= 48 ? (h_ / 24).toFixed(1) + 'd' : h_.toFixed(1) + 'h'),
};

// ------------------------------------------------------------------------------------------------ icons (stroke, 24x24)
const P = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10', funnel: 'M3 4h18l-7 8v7l-4 2v-9z', users: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M22 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  target: 'M12 22a10 10 0 100-20 10 10 0 000 20M12 18a6 6 0 100-12 6 6 0 000 12M12 14a2 2 0 100-4 2 2 0 000 4', sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  route: 'M6 19a3 3 0 100-6 3 3 0 000 6M18 11a3 3 0 100-6 3 3 0 000 6M9 16h5a4 4 0 004-4M6 13V9', check: 'M20 6L9 17l-5-5', checkcircle: 'M22 11.1V12a10 10 0 11-5.9-9.1M22 4L12 14l-3-3',
  briefcase: 'M4 7h16a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1zM8 7V5a2 2 0 012-2h4a2 2 0 012 2v2M3 13h18', kanban: 'M4 4h5v16H4zM10 4h5v10h-5zM16 4h5v13h-5z',
  megaphone: 'M3 11v2a1 1 0 001 1h2l5 4V6L6 10H4a1 1 0 00-1 1zM15 8a5 5 0 010 8M18 5a9 9 0 010 14', shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  copy: 'M8 8h12v12H8zM4 16V4h12', alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z', chart: 'M3 3v18h18M7 14l4-4 4 4 5-6',
  db: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3', book: 'M4 19.5A2.5 2.5 0 016.5 17H20V3H6.5A2.5 2.5 0 004 5.5zM4 19.5V22h16',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20M12 6v6l4 2', search: 'M11 19a8 8 0 100-16 8 8 0 000 16M21 21l-4.3-4.3', sun: 'M12 17a5 5 0 100-10 5 5 0 000 10M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z', zap: 'M13 2L3 14h9l-1 8 10-12h-9z', plus: 'M12 5v14M5 12h14', x: 'M18 6L6 18M6 6l12 12', info: 'M12 22a10 10 0 100-20 10 10 0 000 20M12 16v-4M12 8h.01',
  play: 'M6 4l14 8-14 8z', refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15', mail: 'M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zM22 6l-10 7L2 6',
  phone: 'M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 118 0v4', user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8', arrow: 'M5 12h14M13 5l7 7-7 7', terminal: 'M4 17l6-6-6-6M12 19h8',
  layers: 'M12 2l10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5', flag: 'M4 22V4M4 4h13l-2 4 2 4H4', trend: 'M23 6l-9.5 9.5-5-5L1 18M17 6h6v6', file: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M8 13h8M8 17h8',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 100-6 3 3 0 000 6', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z', dollar: 'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z', gitmerge: 'M18 21a3 3 0 100-6 3 3 0 000 6M6 9a3 3 0 100-6 3 3 0 000 6M6 9v12M18 15V9a6 6 0 00-6-6H9', history: 'M3 3v5h5M3.05 13A9 9 0 106 5.3L3 8M12 7v5l4 2',
};
export function icon(name, cls) {
  const s = svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: cls || '' });
  s.append(svg('path', { d: P[name] || P.info }));
  return s;
}

// ------------------------------------------------------------------------------------------------ components
export const link = (hash, text, cls) => h('a', { href: hash, class: cls || '' }, text);
export const leadLink = (id) => h('a', { href: `#/lead/${id}`, class: 'mono' }, id);
export const oppLink = (id) => (id ? h('a', { href: `#/pipeline/${id}`, class: 'mono' }, id) : '—');

export function pill(text, kind = 'muted', ico) { return h('span', { class: `pill ${kind}` }, ico ? icon(ico) : null, text); }
export const bandPill = (b) => pill(b, b === 'Hot' ? 'hot' : b === 'Warm' ? 'warm' : 'cold');
const STATUS_KIND = { New: 'info', Working: 'violet', Qualified: 'ok', Converted: 'ok', Disqualified: 'muted', Stale: 'warn', open: 'info', won: 'ok', lost: 'err', completed: 'ok', overdue: 'err', cancelled: 'muted', suppressed: 'warn' };
export const statusPill = (s) => pill(s, STATUS_KIND[s] || 'muted');
export const consentPill = (s) => (s === 'opted_out' ? pill('opted out', 'err', 'lock') : s === 'implied' ? pill('implied', 'warn') : pill('opted in', 'ok', 'check'));
export const SEV = { critical: 'err', high: 'err', medium: 'warn', low: 'info', info: 'muted' };
export function bandColor(b) { return b === 'Hot' ? 'var(--hot)' : b === 'Warm' ? 'var(--warm)' : 'var(--cold)'; }
export function scoreBar(score, band) {
  return h('div', { class: 'scorebar' }, h('b', null, score), h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${score}%`, background: bandColor(band || (score >= 70 ? 'Hot' : score >= 40 ? 'Warm' : 'Cold')) } })));
}

export function card(title, body, { sub, actions, cls, flat } = {}) {
  return h('section', { class: `card ${cls || ''} ${flat ? 'flat' : ''}` },
    title || actions ? h('div', { class: 'hd' }, title ? h('h3', null, title) : null, sub ? h('span', { class: 'sub' }, sub) : null, h('div', { class: 'grow' }), actions || null) : null,
    h('div', { class: 'bd' }, body));
}
export function pageHead(title, desc, actions) {
  return h('div', { class: 'page-head' }, h('div', null, h('h2', null, title), desc ? h('p', null, desc) : null), actions ? h('div', { class: 'actions' }, actions) : null);
}
export function callout(kind, ...kids) { return h('div', { class: `callout ${kind}` }, icon(kind === 'ok' ? 'checkcircle' : kind === 'err' ? 'alert' : kind === 'warn' ? 'alert' : 'info'), h('div', null, kids)); }
export const skeleton = (n = 3, hgt = 70) => h('div', { class: 'col' }, Array.from({ length: n }, () => h('div', { class: 'skeleton', style: { height: hgt + 'px' } })));
export const empty = (msg) => h('div', { class: 'empty' }, msg);

export function animateNumber(el, to, formatter = fmt.int, ms = 900) {
  const t0 = performance.now(); const from = 0;
  const step = (t) => { const p = Math.min(1, (t - t0) / ms); const e = 1 - Math.pow(1 - p, 3); el.textContent = formatter(from + (to - from) * e); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
export function kpi({ label, value, sub, ico, format = fmt.int, raw, spark, color }) {
  const val = h('div', { class: 'val', style: color ? { color } : null }, raw != null ? raw : '0');
  if (raw == null && value != null) animateNumber(val, value, format);
  return h('div', { class: 'card kpi' }, ico ? h('div', { class: 'ico' }, icon(ico)) : null, h('div', { class: 'lbl' }, label), val, sub ? h('div', { class: 'sub' }, sub) : null, spark || null);
}

/** columns: [{key,label,render(row),num,sort,cls}] */
export function table({ columns, rows, onRow, empty: emptyMsg = 'No rows', sort, onSort }) {
  const thead = h('tr', null, columns.map((c) => h('th', {
    class: `${c.num ? 'num' : ''} ${c.sort ? 'sortable' : ''}`, onclick: c.sort && onSort ? () => onSort(c.sort) : null,
  }, c.label, sort && c.sort && sort.key === c.sort ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '')));
  const body = rows.length ? rows.map((r) => h('tr', { class: onRow ? 'click' : '', onclick: onRow ? (e) => { if (e.target.closest('a,button')) return; onRow(r); } : null },
    columns.map((c) => h('td', { class: `${c.num ? 'num' : ''} ${c.cls || ''}` }, c.render ? c.render(r) : r[c.key] ?? '—')))) : [h('tr', null, h('td', { colspan: columns.length }, empty(emptyMsg)))];
  return h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, thead), h('tbody', null, body)));
}
export function pager({ page, total, size, onPage }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return h('div', { class: 'pager' }, h('span', null, `${fmt.int(total)} rows · page ${page} of ${fmt.int(pages)}`), h('div', { class: 'row' },
    h('button', { class: 'btn sm', disabled: page <= 1, onclick: () => onPage(1) }, '«'), h('button', { class: 'btn sm', disabled: page <= 1, onclick: () => onPage(page - 1) }, '‹ Prev'),
    h('button', { class: 'btn sm', disabled: page >= pages, onclick: () => onPage(page + 1) }, 'Next ›'), h('button', { class: 'btn sm', disabled: page >= pages, onclick: () => onPage(pages) }, '»')));
}
export function tabs(items, active, onChange) {
  const wrap = h('div', { class: 'tabs' });
  const render = (cur) => { clear(wrap); items.forEach(([k, label]) => wrap.append(h('button', { class: k === cur ? 'on' : '', onclick: () => { render(k); onChange(k); } }, label))); };
  render(active);
  return wrap;
}
export function chips(options, active, onChange) {
  const wrap = h('div', { class: 'chips' });
  const render = (cur) => { clear(wrap); options.forEach(([k, label]) => wrap.append(h('span', { class: `chip ${k === cur ? 'on' : ''}`, onclick: () => { render(k); onChange(k); } }, label))); };
  render(active);
  return wrap;
}
export function select(options, value, onChange, { placeholder } = {}) {
  const s = h('select', { onchange: (e) => onChange(e.target.value) }, placeholder != null ? h('option', { value: '' }, placeholder) : null,
    options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(value) }, l); }));
  return s;
}

export function toast(msg, kind = 'ok') {
  let box = $('.toasts'); if (!box) { box = h('div', { class: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}` }, icon(kind === 'ok' ? 'checkcircle' : 'alert'), h('div', null, msg));
  box.append(t); setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; setTimeout(() => t.remove(), 300); }, kind === 'ok' ? 3200 : 6000);
}
export function modal({ title, body, actions = [], wide }) {
  const close = () => ov.remove();
  const ov = h('div', { class: 'overlay', onclick: (e) => { if (e.target === ov) close(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}` }, h('div', { class: 'mh' }, h('h3', null, title), h('button', { class: 'iconbtn', onclick: close }, icon('x'))),
      h('div', { class: 'mb' }, body), actions.length ? h('div', { class: 'mf' }, actions.map((a) => h('button', { class: `btn ${a.kind || ''}`, onclick: async (e) => { if (await a.onClick?.(e, close) !== false && a.close !== false) close(); } }, a.label))) : null));
  document.body.append(ov);
  return { close, el: ov };
}
/** Run an action with error toasts; ApiError 409/422 rule blocks are shown as warnings with the rule name. */
export async function act(promiseFn, okMsg) {
  try { const r = await promiseFn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok'); return r; }
  catch (e) { if (e instanceof ApiError) { toast((e.body.rule ? `[${e.body.rule}] ` : '') + e.message, e.status === 409 || e.status === 422 ? 'warn' : 'err'); } else toast(String(e), 'err'); return null; }
}
export function kv(obj) { return h('dl', { class: 'kv' }, Object.entries(obj).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v ?? '—')])); }
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// tooltip singleton
let tipEl;
export function tip(html, evt) {
  if (!tipEl) { tipEl = h('div', { class: 'tip' }); document.body.append(tipEl); }
  if (html == null) { tipEl.style.opacity = '0'; return; }
  tipEl.innerHTML = html; tipEl.style.opacity = '1';
  const w = tipEl.offsetWidth, hh = tipEl.offsetHeight; let x = evt.clientX + 14, y = evt.clientY + 14;
  if (x + w > innerWidth - 8) x = evt.clientX - w - 14; if (y + hh > innerHeight - 8) y = evt.clientY - hh - 14;
  tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
}
export function hover(node, htmlFn) { node.addEventListener('mousemove', (e) => tip(typeof htmlFn === 'function' ? htmlFn() : htmlFn, e)); node.addEventListener('mouseleave', () => tip(null)); return node; }

// LeadLens SPA shell: hash router, role-aware navigation, global search, theme.
import { $, h, mount, clear, icon, api, role, ROLES, toast, skeleton, debounce, fmt, callout } from './lib.js';

const NAV = [
  ['Workflow', [
    ['portal', 'Prospect Portal', 'zap', ['prospect', 'ops', 'admin'], 'Capture a lead and watch every decision'],
    ['overview', 'Overview', 'home', ['ops', 'analyst', 'admin'], 'Funnel, KPIs and reconciliation'],
    ['leads', 'Leads', 'users', ['ops', 'agent', 'analyst', 'admin'], 'Search, filter, drill into a lead'],
    ['workbench', 'Task Workbench', 'checkcircle', ['agent', 'ops', 'admin'], 'Follow-ups with SLA & consent guard'],
    ['pipeline', 'Pipeline', 'kanban', ['agent', 'ops', 'analyst', 'admin'], 'Opportunities, stage history, won/lost'],
  ]],
  ['Rules & Decisions', [
    ['scoring', 'Scoring Rules', 'sliders', ['ops', 'analyst', 'admin'], 'Transparent weights, what-if, versions'],
    ['routing', 'Routing', 'route', ['ops', 'admin', 'analyst'], 'Territory × product coverage'],
    ['campaigns', 'Campaigns', 'megaphone', ['ops', 'analyst', 'admin'], 'Source performance & ROI'],
  ]],
  ['Governance', [
    ['consent', 'Consent', 'shield', ['ops', 'agent', 'prospect', 'admin', 'analyst'], 'Ledger, opt-outs, enforcement'],
    ['dedupe', 'De-duplication', 'copy', ['ops', 'analyst', 'admin'], 'Match tiers & merges'],
    ['exceptions', 'Exceptions', 'alert', ['ops', 'analyst', 'admin', 'agent'], 'Labelled edge cases vs detectors'],
  ]],
  ['Analytics & Data', [
    ['evaluation', 'Held-out Evaluation', 'chart', ['analyst', 'ops', 'admin'], 'AUC, lift, leakage audit'],
    ['data', 'Data & Lineage', 'db', ['analyst', 'admin', 'ops'], 'Dictionary, ERD, validation, SQL'],
    ['audit', 'Audit Trail', 'history', ['admin', 'analyst', 'ops'], 'Every state change and block'],
  ]],
];
const PAGES = Object.fromEntries(NAV.flatMap(([, items]) => items).map(([k, label, ico, roles, desc]) => [k, { label, ico, roles, desc }]));
PAGES.lead = { label: 'Lead 360', ico: 'users', roles: ['ops', 'agent', 'analyst', 'admin'] };

const app = $('#app');
let main, topTitle, crumb, navEl, roleBtn, seq = 0;

function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('ll_theme', t); } catch { /* ignore */ } }
try { applyTheme(localStorage.getItem('ll_theme') || 'dark'); } catch { /* ignore */ }

function buildShell() {
  const qp = new URLSearchParams(location.search);
  if (ROLES[qp.get('role')]) role.set(qp.get('role'));
  if (qp.get('theme')) applyTheme(qp.get('theme'));
  const r = role.get();
  navEl = h('nav', { class: 'nav' });
  roleBtn = h('button', { class: 'role-btn', onclick: toggleRoleMenu });
  const results = h('div', { class: 'search-results hidden' });
  const input = h('input', { placeholder: 'Jump to a lead, company or e-mail', id: 'gsearch', autocomplete: 'off' });
  input.addEventListener('input', debounce(async () => {
    const q = input.value.trim(); if (q.length < 2) { results.classList.add('hidden'); return; }
    try {
      const d = await api.get('/api/leads', { q, page_size: 6 });
      clear(results);
      if (!d.rows.length) results.append(h('div', { class: 'empty' }, 'No matching leads'));
      d.rows.forEach((l) => results.append(h('a', { href: `#/lead/${l.lead_id}`, onclick: () => { results.classList.add('hidden'); input.value = ''; } },
        h('div', { class: 'row' }, h('b', { class: 'mono' }, l.lead_id), h('span', { class: 'grow' }), h('span', { class: 'muted' }, `score ${l.score}`)), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${l.contact_name} · ${l.company_name}`))));
      results.classList.remove('hidden');
    } catch { /* ignore */ }
  }));
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.classList.add('hidden'); if (!e.target.closest('.role-menu') && !e.target.closest('.role-btn')) $('.role-menu')?.remove(); });
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); } });
  topTitle = h('h1', null, ''); crumb = h('div', { class: 'crumb' }, '');
  const clock = h('div', { class: 'clock', id: 'clock', title: 'Dataset as-of date / simulation clock' }, 'as-of 2026-10-22');
  const themeBtn = h('button', { class: 'iconbtn', title: 'Toggle theme', onclick: () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(t); themeBtn.replaceChildren(icon(t === 'dark' ? 'sun' : 'moon')); window.dispatchEvent(new HashChangeEvent('hashchange')); } }, icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'));
  main = h('div', { class: 'page' });
  mount(app,
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('div', { class: 'logo' }, icon('funnel')), h('div', null, h('b', null, 'LeadLens'), h('small', null, 'Lead → Opportunity'))), navEl,
      h('div', { style: { marginTop: '22px', padding: '12px', fontSize: '11.5px', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: '12px', background: 'var(--surface)' } },
        h('b', { style: { color: 'var(--text-2)' } }, 'Synthetic data'), h('div', null, 'Seed 20261022 · no real people, no external data. Ground truth lives in a separate database.'))),
    h('div', { class: 'main' }, h('header', { class: 'topbar' }, h('div', null, crumb, topTitle), h('div', { class: 'grow' }), h('div', { class: 'search' }, icon('search'), input, h('kbd', null, 'Ctrl K'), results), clock, themeBtn, roleBtn), main));
  paintRole(r);
  paintNav();
  api.get('/api/meta').then((m) => { $('#clock').textContent = `as-of ${m.as_of.slice(0, 10)} · live ${m.clock.slice(11, 16)}`; }).catch(() => {});
}

function paintRole(r) {
  const R = ROLES[r];
  mount(roleBtn, h('div', { class: 'avatar' }, R.initials), h('div', { style: { textAlign: 'left', lineHeight: 1.15 } }, h('div', { style: { fontWeight: 600, fontSize: '12.5px' } }, R.label), h('div', { class: 'muted', style: { fontSize: '10.5px' } }, 'switch persona')));
}
function toggleRoleMenu() {
  const ex = $('.role-menu'); if (ex) { ex.remove(); return; }
  const cur = role.get();
  const menu = h('div', { class: 'role-menu' }, h('div', { class: 'muted', style: { padding: '6px 10px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.08em' } }, 'Act as (RBAC enforced by the API)'),
    Object.entries(ROLES).map(([k, R]) => h('button', { class: k === cur ? 'on' : '', onclick: () => { role.set(k); menu.remove(); paintRole(k); paintNav(); const allowed = PAGES[currentKey()]?.roles.includes(k); if (!allowed) location.hash = R.home; else route(); toast(`Now acting as ${R.label}`, 'ok'); } },
      h('div', { class: 'avatar' }, R.initials), h('div', null, h('b', null, R.label), h('small', null, R.sub)))));
  document.body.append(menu);
}
function paintNav() {
  const r = role.get(); const cur = currentKey(); clear(navEl);
  NAV.forEach(([group, items]) => {
    const vis = items.filter((i) => i[3].includes(r)); if (!vis.length) return;
    navEl.append(h('div', { class: 'nav-group' }, group));
    vis.forEach(([k, label, ico]) => navEl.append(h('a', { href: `#/${k}`, class: k === cur || (cur === 'lead' && k === 'leads') ? 'active' : '' }, icon(ico), h('span', null, label))));
  });
}
const hashPath = () => location.hash.replace(/^#\/?/, '').split('?')[0];
const currentKey = () => (hashPath().split('/')[0] || 'overview');

async function route() {
  const parts = hashPath().split('/');
  let key = parts[0] || ROLES[role.get()].home.slice(2);
  if (!PAGES[key]) key = 'overview';
  if (!PAGES[key].roles.includes(role.get()) && key !== 'lead') {
    mount(main, callout('warn', h('b', null, 'Not available for this persona. '), `The "${PAGES[key].label}" screen is hidden for ${ROLES[role.get()].label}. Switch persona (top right) to open it.`)); paintNav(); return;
  }
  paintNav();
  const my = ++seq;
  topTitle.textContent = PAGES[key].label; crumb.textContent = `LeadLens / ${key === 'lead' ? 'Leads / ' + (parts[1] || '') : PAGES[key].label}`;
  mount(main, h('div', { class: 'page-head' }, h('div', null, h('h2', null, PAGES[key].label), h('p', null, PAGES[key].desc || ''))), skeleton(3, 120));
  try {
    const mod = await import(`./pages/${key}.js`);
    const node = await mod.default({ params: parts.slice(1), query: new URLSearchParams(location.hash.split('?')[1] || ''), role: role.get() });
    if (my !== seq) return;
    mount(main, node); window.scrollTo({ top: 0 });
  } catch (e) {
    if (my !== seq) return;
    console.error(e);
    mount(main, callout('err', h('b', null, `Could not render ${PAGES[key].label}. `), String(e.message || e)));
  }
}

buildShell();
window.addEventListener('hashchange', route);
if (!location.hash) location.hash = ROLES[role.get()].home; else route();

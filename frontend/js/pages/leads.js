// Leads explorer: server-side filter / sort / pagination over all leads, with rule-engine flags surfaced on every row.
import { h, api, fmt, card, pageHead, icon, pill, table, pager, leadLink, bandPill, statusPill, consentPill, scoreBar, callout, debounce, mount, skeleton, kpi } from '../lib.js';
import { stackedBar } from '../charts.js';

// Filter state lives at module level so back-navigation from a lead keeps the user's view.
const DEFAULTS = { q: '', status: '', band: '', source: '', territory: '', product: '', consent: '', routing: '', rep_id: '', min_score: '', duplicates: false, flagged: false, sort: 'created', dir: 'desc', page: 1 };
const STATE = { ...DEFAULTS };
const PAGE_SIZE = 25;

const EXC = {
  opted_out_contacted: ['Opted-out contacted', 'Critical - an outbound e-mail/call was logged after the contact opted out of that channel.'],
  score_post_conversion: ['Score leakage', 'High - scored_ts is later than converted_ts: events after conversion influenced the score.'],
  lead_outside_territory: ['Outside territory', "High - the owning rep's territory differs from the lead's territory."],
  duplicate_opportunity: ['Duplicate opp.', 'High - a lead merged as a duplicate created its own opportunity while the canonical lead also converted.'],
  stage_history_gap: ['Stage gap', 'Medium - the opportunity StageHistory chain is broken (a transition row is missing).'],
};
const ROUTE_LABEL = { rule_based: 'rule-based', overflow_territory: 'overflow territory', unroutable_queue: 'unroutable queue', manual_override: 'manual override' };

const toParams = (s, { skipBand = false, size = PAGE_SIZE } = {}) => ({
  q: s.q.trim(), status: s.status, band: skipBand ? '' : s.band, source: s.source, territory: s.territory, product: s.product, consent: s.consent, routing: s.routing,
  rep_id: s.rep_id, min_score: s.min_score, duplicates: s.duplicates ? '1' : '', flagged: s.flagged ? '1' : '', sort: s.sort, dir: s.dir, page: s.page, page_size: size,
});
const activeCount = () => Object.keys(DEFAULTS).filter((k) => !['sort', 'dir', 'page'].includes(k) && STATE[k] !== DEFAULTS[k] && STATE[k] !== '').length;

export default async function leads({ role }) {
  const filters = await api.get('/api/leads/filters');
  const results = h('div', null, skeleton(3, 80));
  const stats = h('div', { class: 'grid g4' });
  const controls = {};
  let seq = 0;

  const refresh = (resetPage = true) => { if (resetPage) STATE.page = 1; load(); paintMeta(); };
  const debounced = debounce(() => refresh(), 300);

  // ------------------------------------------------------------------ filter bar
  const field = (label, key, options, placeholder = 'All') => {
    const sel = h('select', { onchange: (e) => { STATE[key] = e.target.value; refresh(); } },
      h('option', { value: '' }, placeholder), options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v }, l); }));
    sel.value = STATE[key]; controls[key] = sel;
    return h('label', { class: 'f' }, label, sel);
  };
  const qInput = h('input', { placeholder: 'Lead id, name, e-mail or company', value: STATE.q, oninput: (e) => { STATE.q = e.target.value; debounced(); }, style: { width: '100%' } });
  const minInput = h('input', { type: 'number', min: 0, max: 100, placeholder: '0', value: STATE.min_score, style: { width: '100%' }, oninput: (e) => { STATE.min_score = e.target.value; debounced(); } });
  const toggle = (label, key, ico, hint) => {
    const el = h('div', { class: `toggle ${STATE[key] ? 'on' : ''}`, title: hint, onclick: () => { STATE[key] = !STATE[key]; el.classList.toggle('on', STATE[key]); box.checked = STATE[key]; refresh(); } });
    const box = h('input', { type: 'checkbox', checked: STATE[key], onclick: (e) => e.stopPropagation(), onchange: () => { STATE[key] = box.checked; el.classList.toggle('on', STATE[key]); refresh(); } });
    el.append(box, icon(ico), label); el.querySelector('svg').style.cssText = 'width:15px;height:15px;color:var(--muted)';
    controls[key] = { sync: () => { box.checked = STATE[key]; el.classList.toggle('on', STATE[key]); } };
    return el;
  };
  const repOpts = filters.reps.map((r) => [r.rep_id, `${r.rep_id} · ${r.rep_name}`]);
  const filterCard = h('section', { class: 'card pad' },
    h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(220px,2fr) repeat(4, minmax(120px,1fr))', gap: '12px', alignItems: 'end' } },
      h('label', { class: 'f' }, 'Search', qInput),
      field('Status', 'status', filters.status), field('Score band', 'band', filters.band), field('Source', 'source', filters.source), field('Territory', 'territory', filters.territory)),
    h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(5, minmax(120px,1fr))', gap: '12px', alignItems: 'end', marginTop: '12px' } },
      field('Product', 'product', filters.product), field('Consent', 'consent', filters.consent.map((c) => [c, c.replace('_', ' ')])),
      field('Routing method', 'routing', filters.routing.map((r) => [r, ROUTE_LABEL[r] || r])), field('Owner rep', 'rep_id', repOpts), h('label', { class: 'f' }, 'Min score', minInput)),
    h('div', { class: 'row wrap', style: { marginTop: '12px', gap: '10px' } },
      toggle('Duplicates only', 'duplicates', 'copy', 'Leads merged into an earlier lead (same person + product within 30 days)'),
      toggle('Flagged exceptions only', 'flagged', 'alert', 'Leads carrying at least one rule-detector exception'),
      h('div', { class: 'grow' }),
      h('span', { class: 'muted', id: 'filter-meta', style: { fontSize: '12.5px' } }),
      h('button', { class: 'btn sm', onclick: () => { Object.assign(STATE, DEFAULTS); syncControls(); refresh(); } }, icon('refresh'), 'Reset')));

  const PRESETS = [
    ['Hot leads', { band: 'Hot' }], ['Opted out', { consent: 'opted_out' }], ['Unroutable queue', { routing: 'unroutable_queue' }],
    ['Manual overrides', { routing: 'manual_override' }], ['Flagged exceptions', { flagged: true }], ['Duplicates', { duplicates: true }], ['Stale', { status: 'Stale' }],
  ];
  const presets = h('div', { class: 'row wrap', style: { gap: '6px' } }, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Quick views'),
    PRESETS.map(([label, patch]) => h('span', { class: 'chip', onclick: () => { Object.assign(STATE, DEFAULTS, patch); syncControls(); refresh(); } }, label)));

  function syncControls() {
    qInput.value = STATE.q; minInput.value = STATE.min_score;
    Object.entries(controls).forEach(([k, c]) => { if (c.sync) c.sync(); else c.value = STATE[k]; });
  }
  function paintMeta() {
    const n = activeCount(); const el = filterCard.querySelector('#filter-meta');
    if (el) el.textContent = n ? `${n} filter${n > 1 ? 's' : ''} active` : 'no filters - showing every lead';
  }

  // ------------------------------------------------------------------ results
  const flagPills = (r) => (r.flags.length ? h('div', { class: 'row wrap', style: { gap: '4px' } }, r.flags.map((f) => { const p = pill(EXC[f]?.[0] || f, 'err', 'alert'); p.title = EXC[f]?.[1] || f; return p; })) : h('span', { class: 'muted' }, '-'));
  const cols = [
    { label: 'Lead', sort: 'created', render: (r) => h('div', { style: { whiteSpace: 'nowrap' } }, leadLink(r.lead_id), h('div', { class: 'muted', style: { fontSize: '11.5px' } }, fmt.date(r.created_ts), r.duplicate_of_lead_id ? ' · ' : '', r.duplicate_of_lead_id ? pill('dup of ' + r.duplicate_of_lead_id.slice(-6), 'warn', 'copy') : null)) },
    { label: 'Contact', render: (r) => h('div', { style: { minWidth: '140px' } }, h('b', null, r.contact_name), h('div', { class: 'muted', style: { fontSize: '11.5px' } }, r.job_title)) },
    { label: 'Company', sort: 'company', render: (r) => h('div', { style: { minWidth: '150px' } }, r.company_name, h('div', { class: 'muted', style: { fontSize: '11.5px' } }, r.industry)) },
    { label: 'Source / product', render: (r) => h('div', { style: { whiteSpace: 'nowrap' } }, r.source, h('div', { class: 'muted', style: { fontSize: '11.5px' } }, r.product_interest)) },
    { label: 'Score', sort: 'score', render: (r) => h('div', { class: 'row', style: { gap: '8px' } }, h('div', { style: { width: '104px' } }, scoreBar(r.score, r.score_band)), bandPill(r.score_band)) },
    { label: 'Status', sort: 'status', render: (r) => h('div', null, statusPill(r.status), r.status_reason ? h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '2px' } }, r.status_reason) : null) },
    { label: 'Consent', render: (r) => consentPill(r.consent_status) },
    { label: 'Owner / territory', render: (r) => h('div', { style: { minWidth: '150px' } }, h('div', { class: 'row wrap', style: { gap: '5px' } }, r.rep_name, r.routing_method !== 'rule_based' ? pill(ROUTE_LABEL[r.routing_method] || r.routing_method, r.routing_method === 'unroutable_queue' ? 'warn' : 'violet', 'route') : null),
      h('div', { class: 'muted', style: { fontSize: '11.5px' } }, `${r.assigned_rep_id} · ${r.territory}`)) },
    { label: 'Exceptions', render: flagPills },
    { label: 'Last activity', sort: 'activity', render: (r) => h('span', { class: 'muted nowrap' }, fmt.ts(r.last_activity_ts)) },
  ];

  async function load() {
    const my = ++seq;
    const base = toParams(STATE);
    const bandBase = toParams(STATE, { skipBand: true, size: 1 });
    try {
      const [d, ...bandCounts] = await Promise.all([api.get('/api/leads', base), ...filters.band.map((b) => api.get('/api/leads', { ...bandBase, band: b, page: 1 }))]);
      if (my !== seq) return;
      const bands = Object.fromEntries(filters.band.map((b, i) => [b, bandCounts[i].total]));
      const bandTotal = Object.values(bands).reduce((a, b) => a + b, 0);
      const rows = d.rows;
      const flagged = rows.filter((r) => r.flags.length).length;
      const optedOut = rows.filter((r) => r.consent_status === 'opted_out').length;
      const avg = rows.length ? rows.reduce((a, r) => a + r.score, 0) / rows.length : null;
      mount(stats,
        kpi({ label: 'Leads matching', raw: fmt.int(d.total), sub: activeCount() ? 'with the current filters' : 'all leads in the system', ico: 'users' }),
        h('div', { class: 'card kpi' }, h('div', { class: 'lbl' }, 'Score-band split (matching leads)'),
          h('div', { style: { marginTop: '8px' } }, stackedBar({ segments: filters.band.map((b) => ({ label: b, value: bands[b], color: `var(--${b.toLowerCase()})` })), total: bandTotal || 1, height: 14 })),
          h('div', { class: 'row wrap', style: { gap: '10px', marginTop: '8px', fontSize: '12px' } }, filters.band.map((b) => h('span', { class: 't2' }, h('i', { style: { display: 'inline-block', width: '9px', height: '9px', borderRadius: '3px', marginRight: '5px', background: `var(--${b.toLowerCase()})` } }), `${b} `, h('b', null, fmt.int(bands[b])), h('span', { class: 'muted' }, ` (${bandTotal ? fmt.pct(bands[b] / bandTotal, 0) : '0%'})`))))),
        kpi({ label: 'Exceptions on this page', raw: fmt.int(flagged), sub: `of ${rows.length} rows carry a rule-detector flag`, ico: 'alert', color: flagged ? 'var(--err)' : null }),
        kpi({ label: 'Avg score on this page', raw: avg == null ? '-' : fmt.dec(avg, 1), sub: `${optedOut} opted-out · page ${d.page}`, ico: 'target' }));
      mount(results,
        table({ columns: cols, rows, sort: { key: STATE.sort, dir: STATE.dir }, onRow: (r) => { location.hash = `#/lead/${r.lead_id}`; }, empty: 'No leads match these filters. Try resetting or widening them.',
          onSort: (key) => { if (STATE.sort === key) STATE.dir = STATE.dir === 'asc' ? 'desc' : 'asc'; else { STATE.sort = key; STATE.dir = key === 'company' ? 'asc' : 'desc'; } refresh(); } }),
        pager({ page: d.page, total: d.total, size: PAGE_SIZE, onPage: (p) => { STATE.page = p; load(); window.scrollTo({ top: 0 }); } }));
    } catch (e) {
      if (my !== seq) return;
      mount(results, callout('err', h('b', null, 'Could not load leads. '), String(e.message || e)));
    }
  }

  load(); paintMeta();
  return h('div', null,
    pageHead('Leads', 'Every lead with its score, owner, consent state and rule-engine exceptions. Filters run server-side over the full table; click a column header to sort, a row to open the Lead 360.',
      ['ops', 'admin'].includes(role) ? [h('a', { class: 'btn', href: '#/portal' }, icon('zap'), 'Capture a lead')] : null),
    h('div', { class: 'col', style: { gap: '12px' } }, presets, filterCard),
    h('div', { class: 'mt' }, stats),
    h('div', { class: 'mt' }, callout('info', h('b', null, 'How to read this table. '), 'Score = Fit (≤40) + Intent (≤35) + Engagement (≤25); Hot ≥ 70, Warm ≥ 40. A routing pill appears when the owner was NOT chosen by the territory × product rule. Red exception pills come from the rule detectors (hover for the rule) - they are surfaced, never hidden.')),
    h('div', { class: 'mt' }, results));
}

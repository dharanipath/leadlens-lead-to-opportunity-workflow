import { h, svg, api, fmt, card, kpi, pageHead, icon, pill, table, callout, hover, tip, chips, select } from '../lib.js';
import { hbars, legend, SERIES } from '../charts.js';

const ico = (n, sz = 16) => { const e = icon(n); e.style.cssText = `width:${sz}px;height:${sz}px;flex:none`; return e; };
const nf = new Intl.NumberFormat('en-US');
const roiTxt = (r) => (r == null ? '—' : `${r >= 0 ? '+' : '−'}${nf.format(Math.round(Math.abs(r) * 100))}%`);
const roiColor = (r) => (r == null ? 'var(--muted)' : r >= 0 ? 'var(--ok)' : 'var(--err)');
const STATUS = { active: 'info', completed: 'ok', planned: 'muted' };
const niceMax = (v) => { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; };

/** Scatter of cost-per-lead vs conversion; one point per campaign, coloured by channel, size = leads. */
function scatter(rows, chColor, hidden) {
  const W = 640, H = 340, m = { l: 52, r: 16, t: 14, b: 40 };
  const pts = rows.filter((r) => r.cpl != null && r.conv_rate != null);
  const xMax = niceMax(Math.max(...pts.map((p) => p.cpl)) * 1.05), yMax = niceMax(Math.max(...pts.map((p) => p.conv_rate)) * 1.05);
  const px = (v) => m.l + (v / xMax) * (W - m.l - m.r), py = (v) => m.t + (1 - v / yMax) * (H - m.t - m.b);
  const maxLeads = Math.max(...pts.map((p) => p.leads), 1);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  for (let i = 0; i <= 4; i++) {
    const y = py(yMax * i / 4), x = px(xMax * i / 4);
    s.append(svg('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: i ? 'grid-line' : 'axis-line' }), svg('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end' }, fmt.pct(yMax * i / 4, 0)),
      svg('text', { x, y: H - m.b + 16, 'text-anchor': 'middle' }, '$' + Math.round(xMax * i / 4)));
  }
  s.append(svg('text', { x: (m.l + W - m.r) / 2, y: H - 4, 'text-anchor': 'middle' }, 'Cost per lead (budget ÷ leads, USD)'), svg('text', { x: 12, y: H / 2, 'text-anchor': 'middle', transform: `rotate(-90 12 ${H / 2})` }, 'Lead → opportunity conversion'));
  pts.filter((p) => !hidden.has(p.channel)).forEach((p) => {
    const c = svg('circle', { class: 'mark', cx: px(p.cpl), cy: py(p.conv_rate), r: 5 + 8 * Math.sqrt(p.leads / maxLeads), fill: chColor[p.channel], 'fill-opacity': 0.72, stroke: 'var(--surface)', 'stroke-width': 1.5 });
    hover(c, () => `<b>${p.campaign_name}</b><br>${p.channel} · ${p.product_line} · ${p.target_region}<br>CPL ${fmt.money(p.cpl)} · conv ${fmt.pct(p.conv_rate)}<br>${fmt.int(p.leads)} leads · ROI ${roiTxt(p.roi)}`);
    c.addEventListener('click', () => { const q = document.querySelector('#camp-search'); if (q) { q.value = p.campaign_id; q.dispatchEvent(new Event('input')); q.scrollIntoView({ block: 'center' }); } });
    s.append(c);
  });
  return s;
}

export default async function campaigns() {
  const rows = await api.get('/api/campaigns');
  const channels = [...new Set(rows.map((r) => r.channel))].sort();
  const chColor = Object.fromEntries(channels.map((c, i) => [c, SERIES[i % SERIES.length]]));
  const tot = rows.reduce((a, r) => { a.budget += r.budget_usd; a.leads += r.leads; a.dups += r.dups; a.opps += r.opps; a.won += r.won_amount; a.touches += r.touches; return a; }, { budget: 0, leads: 0, dups: 0, opps: 0, won: 0, touches: 0 });
  const roiAll = (tot.won - tot.budget) / tot.budget;

  const kpis = h('div', { class: 'grid g4' },
    kpi({ label: 'Campaign budget', value: tot.budget, format: fmt.moneyShort, sub: `${rows.length} campaigns · ${channels.length} channels`, ico: 'dollar' }),
    kpi({ label: 'Leads attributed', value: tot.leads, sub: `${fmt.int(tot.leads - tot.dups)} unique after de-dup · CPL ${fmt.money(tot.budget / tot.leads)}`, ico: 'users' }),
    kpi({ label: 'Won revenue', value: tot.won, format: fmt.moneyShort, sub: `${fmt.int(tot.opps)} opportunities from unique leads`, ico: 'trend', color: 'var(--ok)' }),
    kpi({ label: 'Blended ROI', raw: roiTxt(roiAll), sub: '(won revenue − budget) ÷ budget, first-touch attributed', ico: 'chart', color: roiColor(roiAll) }));

  // ---- channel roll-up
  const ch = channels.map((c) => {
    const r = rows.filter((x) => x.channel === c), a = r.reduce((s, x) => ({ budget: s.budget + x.budget_usd, leads: s.leads + x.leads, dups: s.dups + x.dups, opps: s.opps + x.opps, won: s.won + x.won_amount }), { budget: 0, leads: 0, dups: 0, opps: 0, won: 0 });
    return { channel: c, n: r.length, ...a, unique: a.leads - a.dups, conv: a.leads - a.dups ? a.opps / (a.leads - a.dups) : 0, roi: a.budget ? (a.won - a.budget) / a.budget : null, cpl: a.leads ? a.budget / a.leads : null };
  });
  const roll = (title, key, format, sub, sort = true) => card(title, hbars({ rows: ch.slice().sort((a, b) => b[key] - a[key]).map((c) => ({ label: c.channel, value: Math.max(0, c[key]), color: chColor[c.channel], tip: `<b>${c.channel}</b> · ${c.n} campaigns<br>${title}: <b>${format(c[key])}</b><br><span class="k">${fmt.int(c.leads)} leads · ${fmt.money(c.budget)} budget</span>` })), format, labelW: 130 }), { sub });
  const rollups = h('div', { class: 'grid g3 mt' },
    roll('Leads by channel', 'leads', fmt.int, 'first-touch'), roll('Conversion by channel', 'conv', (v) => fmt.pct(v), 'opps ÷ unique leads'), roll('ROI by channel', 'roi', roiTxt, 'won revenue vs budget'));

  // ---- top / bottom ROI
  const ranked = rows.filter((r) => r.roi != null).slice().sort((a, b) => b.roi - a.roi);
  const rowFor = (r) => ({ label: r.campaign_name, value: Math.abs(r.roi), color: r.roi >= 0 ? 'var(--ok)' : 'var(--err)', tip: `<b>${r.campaign_name}</b><br>${r.channel} · budget ${fmt.money(r.budget_usd)}<br>won ${fmt.money(r.won_amount)} · ROI ${roiTxt(r.roi)}` });
  const top = card('Top 5 by ROI', hbars({ rows: ranked.slice(0, 5).map((r) => ({ ...rowFor(r), sub: fmt.moneyShort(r.won_amount) })), format: roiTxt, labelW: 235 }), { sub: 'best return on spend' });
  const losers = ranked.filter((r) => r.won_amount - r.budget_usd < 0).sort((a, b) => (a.won_amount - a.budget_usd) - (b.won_amount - b.budget_usd)).slice(0, 5);
  const bottom = card('Bottom 5 by ROI', hbars({ rows: losers.map((r) => ({ ...rowFor(r), value: r.budget_usd - r.won_amount, sub: roiTxt(r.roi), tip: `<b>${r.campaign_name}</b><br>${r.channel} · budget ${fmt.money(r.budget_usd)}<br>won ${fmt.money(r.won_amount)} · net ${fmt.money(r.won_amount - r.budget_usd)} · ROI ${roiTxt(r.roi)}` })), format: (v) => '−' + fmt.moneyShort(v), labelW: 235 }), { sub: 'ranked by net loss (ties at −100% broken by spend)' });
  const zero = ranked.filter((r) => r.won_amount === 0).length;
  bottom.querySelector('.bd').append(h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, `${zero} campaigns have no won revenue yet (−100%). Many are still active or recent, so deals have not matured.`));

  // ---- scatter
  const hidden = new Set(); const scBox = h('div');
  const drawSc = () => scBox.replaceChildren(scatter(rows, chColor, hidden));
  const leg = h('div', { class: 'legend' }, channels.map((c) => { const it = h('span', { style: { cursor: 'pointer', userSelect: 'none' }, onclick: () => { hidden.has(c) ? hidden.delete(c) : hidden.add(c); it.style.opacity = hidden.has(c) ? 0.4 : 1; drawSc(); } }, h('i', { style: { background: chColor[c] } }), c); return it; }));
  drawSc();
  const sc = card('Cost per lead vs conversion', [scBox, leg, h('p', { class: 'muted', style: { fontSize: '12px', margin: '8px 0 0' } }, 'One bubble per campaign; size = leads. Click a legend entry to hide a channel, click a bubble to find it in the table. Cheap leads (low-intent channels) tend to convert less — the cost of a lead alone is a poor measure of campaign value.')], { sub: 'colour = channel' });

  // ---- table
  const state = { sort: { key: 'roi', dir: 'desc' }, ch: '', q: '', status: '' };
  const tbox = h('div');
  const cols = [
    { label: 'Campaign', sort: 'campaign_name', render: (r) => h('div', null, h('b', { style: { fontWeight: 600 } }, r.campaign_name), h('div', { class: 'mono muted', style: { fontSize: '11px' } }, r.campaign_id)) },
    { label: 'Channel', sort: 'channel', render: (r) => h('span', { class: 'row', style: { gap: '6px' } }, h('i', { style: { width: '9px', height: '9px', borderRadius: '3px', background: chColor[r.channel], display: 'inline-block' } }), r.channel) },
    { label: 'Product', sort: 'product_line', render: (r) => r.product_line }, { label: 'Region', sort: 'target_region', render: (r) => r.target_region },
    { label: 'Dates', sort: 'start_date', render: (r) => h('span', { class: 'mono', style: { fontSize: '11.5px' } }, `${r.start_date.slice(5)} → ${r.end_date.slice(5)}`) },
    { label: 'Status', sort: 'status', render: (r) => pill(r.status, STATUS[r.status] || 'muted') },
    { label: 'Budget', num: true, sort: 'budget_usd', render: (r) => fmt.money(r.budget_usd) }, { label: 'Leads', num: true, sort: 'leads', render: (r) => fmt.int(r.leads) },
    { label: 'Unique', num: true, sort: 'unique', render: (r) => fmt.int(r.unique) }, { label: 'Touches', num: true, sort: 'touches', render: (r) => fmt.int(r.touches) },
    { label: 'Hot %', num: true, sort: 'hot_pct', render: (r) => fmt.pct(r.hot_pct, 1) }, { label: 'Avg score', num: true, sort: 'avg_score', render: (r) => r.avg_score },
    { label: 'Opps', num: true, sort: 'opps', render: (r) => fmt.int(r.opps) }, { label: 'Conv.', num: true, sort: 'conv_rate', render: (r) => fmt.pct(r.conv_rate) },
    { label: 'Won $', num: true, sort: 'won_amount', render: (r) => fmt.moneyShort(r.won_amount) }, { label: 'CPL', num: true, sort: 'cpl', render: (r) => (r.cpl == null ? '—' : fmt.money(r.cpl)) },
    { label: 'ROI', num: true, sort: 'roi', render: (r) => h('b', { style: { color: roiColor(r.roi) } }, (r.roi != null && r.roi < 0 ? '▼ ' : '▲ '), roiTxt(r.roi)) },
  ];
  const data = rows.map((r) => ({ ...r, unique: r.leads - r.dups, hot_pct: r.leads ? r.hot / r.leads : 0 }));
  function paintTable() {
    const q = state.q.toLowerCase();
    let list = data.filter((r) => (!state.ch || r.channel === state.ch) && (!state.status || r.status === state.status) && (!q || (r.campaign_name + ' ' + r.campaign_id).toLowerCase().includes(q)));
    const { key, dir } = state.sort; const k = dir === 'asc' ? 1 : -1;
    list = list.slice().sort((a, b) => { const x = a[key], y = b[key]; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * k; });
    tbox.replaceChildren(table({ columns: cols, rows: list, sort: state.sort, empty: 'No campaigns match the filters.', onSort: (key2) => { state.sort = { key: key2, dir: state.sort.key === key2 && state.sort.dir === 'desc' ? 'asc' : 'desc' }; paintTable(); } }),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } }, `${list.length} of ${rows.length} campaigns`));
    tbox.querySelectorAll('td').forEach((td) => { td.style.whiteSpace = 'nowrap'; });
  }
  paintTable();
  const search = h('input', { id: 'camp-search', type: 'search', placeholder: 'Search campaign…', oninput: (e) => { state.q = e.target.value; paintTable(); } });
  const tableCard = card('All campaigns', [
    h('div', { class: 'row wrap', style: { marginBottom: '10px' } }, search, select([...channels], '', (v) => { state.ch = v; paintTable(); }, { placeholder: 'All channels' }), select(['active', 'completed'], '', (v) => { state.status = v; paintTable(); }, { placeholder: 'Any status' }),
      h('span', { class: 'grow' }), h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Click a column header to sort')),
    tbox,
  ], { sub: 'sortable · unique = leads minus merged duplicates' });

  const bridge = callout('info', h('b', null, 'Multi-touch attribution via the LeadCampaign bridge. '), `Leads and campaigns are N:M: one lead can be touched by several campaigns. The "Leads", conversion and ROI figures here credit a lead to its `, h('b', null, 'first-touch'),
    ' campaign (lead.campaign_id) so revenue is never double-counted, while ', h('b', null, 'Touches'), ` counts every row in lead_campaign (${fmt.int(tot.touches)} touches for ${fmt.int(tot.leads)} first-touch leads, ${(tot.touches / tot.leads).toFixed(2)} per lead). Direct / website leads have no campaign and are excluded.`);

  return h('div', null,
    pageHead('Campaigns', 'Which campaigns and channels create leads that actually become revenue? Cost per lead, conversion, hot-lead share and ROI per campaign, rolled up by channel.',
      [h('a', { class: 'btn', href: '#/leads' }, icon('users'), 'Leads'), h('a', { class: 'btn', href: '#/data' }, icon('db'), 'Data dictionary')]),
    kpis, h('div', { class: 'mt' }, bridge), rollups,
    h('div', { class: 'grid g-32 mt' }, sc, h('div', { class: 'col' }, top, bottom)),
    h('div', { class: 'mt' }, tableCard));
}

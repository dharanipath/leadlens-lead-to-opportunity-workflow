import { h, api, fmt, card, kpi, pageHead, icon, pill, table, link, bandPill, callout } from '../lib.js';
import { funnel, lineChart, barChart, hbars, heatmap, legend, sparkline, SERIES } from '../charts.js';

export default async function overview({ role }) {
  const d = await api.get('/api/overview');
  const k = d.kpis, t = d.totals;
  const mo = d.monthly;
  const allOk = d.reconciliation.every((r) => r.ok);

  const hero = h('section', { class: 'card hero glow' },
    h('div', { style: { flex: 1 } },
      h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } }, pill('live workflow', 'info', 'zap'), pill(`as-of ${d.as_of.slice(0, 10)}`, 'muted', 'clock')),
      h('h2', null, 'Score → route → follow-up → win. Every decision traceable.'),
      h('p', null, `${fmt.int(t.leads)} leads from ${fmt.int(t.contacts)} contacts at ${fmt.int(t.companies)} companies were scored from fit, intent and engagement, routed by territory and product, `
        + `given SLA-bound follow-ups and tracked to ${fmt.int(t.opps)} opportunities. ${fmt.int(k.exceptions)} labelled exceptions are surfaced, not hidden.`)),
    h('div', { class: 'stat-row' },
      h('div', null, h('b', null, fmt.pct(k.lead_to_opp)), h('span', null, 'lead → opportunity')),
      h('div', null, h('b', null, fmt.pct(k.win_rate)), h('span', null, 'win rate (closed)')),
      h('div', null, h('b', null, fmt.moneyShort(k.won_amount)), h('span', null, 'won revenue'))));

  const spLeads = sparkline(mo.map((m) => m.leads)), spOpps = sparkline(mo.map((m) => m.opps || 0), { color: 'var(--s3)' }), spWon = sparkline(mo.map((m) => m.won_amount || 0), { color: 'var(--s7)' });
  const kpis = h('div', { class: 'grid g4' },
    kpi({ label: 'Leads captured', value: t.leads, sub: `${fmt.int(k.duplicates_merged)} merged as duplicates`, ico: 'users', spark: spLeads }),
    kpi({ label: 'Opportunities', value: t.opps, sub: `${fmt.int(d.pipeline.reduce((a, p) => a + p.n, 0))} open · ${fmt.pct(k.lead_to_opp)} of unique leads`, ico: 'briefcase', spark: spOpps }),
    kpi({ label: 'Won revenue', value: k.won_amount, format: fmt.moneyShort, sub: `avg deal ${fmt.money(k.avg_deal)}`, ico: 'dollar', spark: spWon }),
    kpi({ label: 'Weighted pipeline', value: k.weighted_pipeline, format: fmt.moneyShort, sub: `${fmt.moneyShort(k.open_pipeline)} open (unweighted)`, ico: 'trend' }),
    kpi({ label: 'Hot leads (score ≥ 70)', value: k.hot_share * 100, format: (v) => v.toFixed(1) + '%', sub: `avg score ${k.avg_score}`, ico: 'target', color: 'var(--hot)' }),
    kpi({ label: 'Median first response', value: k.median_first_response_h, format: (v) => v.toFixed(1) + ' h', sub: 'Hot-lead call SLA is 4 h', ico: 'clock' }),
    kpi({ label: 'Task SLA met', value: k.sla_met_pct * 100, format: (v) => v.toFixed(1) + '%', sub: `${fmt.int(k.tasks_overdue)} overdue · ${fmt.int(k.tasks_suppressed)} suppressed by consent`, ico: 'checkcircle' }),
    kpi({ label: 'Opted-out leads', value: k.opted_out_leads, sub: `${fmt.int(k.stale_leads)} stale leads (>60d idle)`, ico: 'shield' }));

  const fun = card('Conversion funnel', [funnel({ stages: d.funnel, onClick: (s) => { if (s.stage.startsWith('Opportunity') || s.stage.startsWith('Closed')) location.hash = '#/pipeline'; else location.hash = '#/leads'; } }),
    h('p', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } }, 'Bars scale to leads captured. “Qualified” counts every lead that ever reached the Qualified state (from the append-only status history).')], { sub: 'reconciled to source tables' });

  const rec = card('Reconciliation', [
    allOk ? callout('ok', h('b', null, 'Funnel reconciles. '), 'Every identity below holds on live data.') : callout('err', 'A reconciliation identity is broken.'),
    h('div', { class: 'col mt-s', style: { gap: '6px' } }, d.reconciliation.map((r) => h('div', { class: 'row', style: { fontSize: '12.5px' } }, icon(r.ok ? 'checkcircle' : 'alert', ''), h('span', { class: 'grow t2' }, r.name), h('span', { class: 'mono muted' }, r.right === 'true' ? 'true' : typeof r.right === 'string' ? `${fmt.int(r.left)} ${r.right}` : `${fmt.int(r.left)} = ${fmt.int(r.right)}`))))]);
  rec.querySelectorAll('.row svg').forEach((s) => { s.style.width = '15px'; s.style.color = 'var(--ok)'; s.style.flex = 'none'; });

  const months = mo.map((m) => m.m.slice(5));
  const trend = card('Lead & opportunity flow', [lineChart({ x: months, series: [{ name: 'Leads', values: mo.map((m) => m.leads), color: SERIES[0], area: true }, { name: 'Hot leads', values: mo.map((m) => m.hot), color: SERIES[1] }, { name: 'Opportunities created', values: mo.map((m) => m.opps || 0), color: SERIES[2] }] }),
    legend([['Leads', SERIES[0]], ['Hot leads', SERIES[1]], ['Opportunities created', SERIES[2]]])], { sub: 'monthly, 2026' });

  const band = card('Conversion by score band', [barChart({ data: d.by_band.map((b) => ({ label: b.band, value: b.rate, color: b.band === 'Hot' ? 'var(--hot)' : b.band === 'Warm' ? 'var(--warm)' : 'var(--cold)', tip: `<b>${b.band}</b><br>${fmt.pct(b.rate)} converted<br><span class="k">${fmt.int(b.converted)} of ${fmt.int(b.n)} leads · avg score ${b.avg_score}</span>` })), format: (v) => fmt.pct(v, 0), height: 210 }),
    h('p', { class: 'muted', style: { fontSize: '12px' } }, 'Leads older than 45 days, duplicates excluded. A monotone ramp (Hot > Warm > Cold) shows the score separates outcomes.')], { sub: 'matured leads' });

  const pipe = card('Open pipeline by stage', [hbars({ rows: d.pipeline.map((p) => ({ label: p.stage, value: p.amt, sub: `${p.n} deals`, tip: `<b>${p.stage}</b><br>${fmt.money(p.amt)} · ${p.n} deals<br><span class="k">weighted ${fmt.money(p.weighted)}</span>` })), format: fmt.moneyShort, labelW: 100 })], { sub: 'unweighted $' });

  const src = card('Source performance', table({ columns: [
    { label: 'Source', render: (r) => r.source }, { label: 'Leads', num: true, render: (r) => fmt.int(r.leads) }, { label: 'Avg score', num: true, render: (r) => r.avg_score },
    { label: 'Hot', num: true, render: (r) => fmt.pct(r.hot_share, 0) }, { label: 'Opps', num: true, render: (r) => fmt.int(r.opps) }, { label: 'Conv.', num: true, render: (r) => fmt.pct(r.conv_rate) },
    { label: 'Won $', num: true, render: (r) => fmt.moneyShort(r.won_amount) }], rows: d.by_source }), { cls: 'span2' });

  const terrs = ['NA-East', 'NA-West', 'EMEA', 'APAC', 'LATAM'];
  const prods = ['Analytics', 'Security', 'Automation', 'Collaboration'];
  const cellMap = Object.fromEntries(d.heat.map((x) => [x.territory + '|' + x.product, x]));
  const heat = card('Lead → opp conversion · territory × product', [heatmap({ rows: terrs, cols: prods, cw: 96, labelW: 78, cell: (r, c) => { const x = cellMap[r + '|' + c]; return x ? { v: x.opps / x.leads, label: fmt.pct(x.opps / x.leads, 0), tip: `<b>${r} · ${c}</b><br>${fmt.int(x.leads)} leads → ${fmt.int(x.opps)} opps (${fmt.pct(x.opps / x.leads)})` } : { v: 0, label: '–' }; } })]);

  const exTypes = { opted_out_contacted: ['Opted-out lead contacted', 'shield'], score_post_conversion: ['Score uses post-conversion event', 'clock'], lead_outside_territory: ['Lead outside territory', 'route'], duplicate_opportunity: ['Duplicate opportunity', 'copy'], stage_history_gap: ['Stage history gap', 'history'] };
  const exc = card('Exceptions surfaced by rule detectors', h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(5, minmax(0,1fr))' } },
    Object.entries(exTypes).map(([key, [label, ico]]) => h('a', { href: `#/exceptions?type=${key}`, onclick: () => { sessionStorage.setItem('ex_type', key); }, class: 'card flat', style: { padding: '14px', textDecoration: 'none', color: 'inherit', background: 'var(--surface-2)' } },
      h('div', { class: 'muted row', style: { fontSize: '12px' } }, icon(ico, ''), label), h('div', { style: { fontSize: '26px', fontWeight: 720, marginTop: '4px', color: 'var(--err)' } }, fmt.int(d.exceptions[key] || 0)), h('div', { class: 'muted', style: { fontSize: '11.5px' } }, 'detected by rule engine')))),
    { sub: 'each one is labelled in a separate ground-truth file' });
  exc.querySelectorAll('.row svg').forEach((s) => { s.style.width = '14px'; });

  return h('div', null, pageHead('Command center', 'End-to-end view of the lead-to-opportunity workflow — capture, score, route, follow up, convert, win.',
    [h('a', { class: 'btn', href: '#/portal' }, icon('zap'), 'Capture a lead'), h('a', { class: 'btn', href: '#/evaluation' }, icon('chart'), 'Held-out evaluation')]),
  hero, h('div', { class: 'mt' }, kpis), h('div', { class: 'grid g-32 mt' }, fun, rec), h('div', { class: 'grid g2 mt' }, trend, band),
  h('div', { class: 'grid g2 mt' }, pipe, heat), h('div', { class: 'grid mt' }, src), h('div', { class: 'mt' }, exc));
}

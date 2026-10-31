import { h, svg, api, ApiError, fmt, card, kpi, pageHead, icon, pill, table, callout, leadLink, bandPill, statusPill, modal, act, toast, hover, empty } from '../lib.js';
import { barChart, donut, legend, SERIES } from '../charts.js';

const TERRS = ['NA-East', 'NA-West', 'EMEA', 'APAC', 'LATAM'];
const PRODS = ['Analytics', 'Security', 'Automation', 'Collaboration'];
const TERR_COLOR = Object.fromEntries(TERRS.map((t, i) => [t, SERIES[i]]));
const METHOD = {
  rule_based: { label: 'Rule based', color: 'var(--s3)', desc: 'territory + product specialist, least-loaded' },
  overflow_territory: { label: 'Overflow (territory)', color: 'var(--s4)', desc: 'no product specialist in territory → least-loaded territory rep' },
  unroutable_queue: { label: 'Unroutable → Sales-Ops queue', color: 'var(--s8)', desc: "region 'Other' has no territory map → REP-000 + manual_routing task" },
  manual_override: { label: 'Manual override', color: 'var(--s7)', desc: 'Sales-Ops assigned with a recorded reason' },
};
const isOpsAdmin = (r) => r === 'ops' || r === 'admin';

/** Territory × product coverage grid: rep count (big) + lead count (small); zero coverage is hatched/red with the fallback path spelled out. */
function coverageGrid(d) {
  const cov = Object.fromEntries(d.coverage.map((x) => [x.territory + '|' + x.product, x.reps]));
  const led = Object.fromEntries(d.leads.map((x) => [x.territory + '|' + x.product, x]));
  const rows = [...TERRS, 'Other'];
  const labelW = 74, cw = 118, ch = 54, top = 30;
  const W = labelW + PRODS.length * cw, H = top + rows.length * ch + 4;
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
  PRODS.forEach((p, j) => s.append(svg('text', { x: labelW + j * cw + cw / 2, y: 18, 'text-anchor': 'middle', class: 'lbl-2' }, p)));
  rows.forEach((t, i) => {
    s.append(svg('text', { x: labelW - 10, y: top + i * ch + ch / 2 + 4, 'text-anchor': 'end', class: 'lbl-2' }, t));
    PRODS.forEach((p, j) => {
      const reps = t === 'Other' ? 0 : cov[t + '|' + p] || 0, L = led[t + '|' + p] || { leads: 0, overflow: 0, unroutable: 0 };
      const none = reps === 0, pct = Math.min(1, reps / 5);
      const x = labelW + j * cw + 2, y = top + i * ch + 2;
      const fill = none ? 'color-mix(in srgb, var(--err) 22%, var(--surface-2))' : `color-mix(in srgb, var(--s1) ${Math.round(14 + 70 * pct)}%, var(--surface-3))`;
      const rect = svg('rect', { class: 'heat-cell', x, y, width: cw - 4, height: ch - 4, rx: 9, fill, stroke: none ? 'var(--err)' : 'none', 'stroke-dasharray': none ? '5 3' : null, 'stroke-width': 1.4 });
      const path = none ? (t === 'Other' ? 'unroutable → REP-000 queue' : 'overflow → territory rep') : null;
      hover(rect, () => `<b>${t} · ${p}</b><br>${none ? 'No eligible specialist' : fmt.int(reps) + ' eligible rep' + (reps > 1 ? 's' : '')}<br>${fmt.int(L.leads)} leads${L.overflow ? ` · ${fmt.int(L.overflow)} overflow` : ''}${L.unroutable ? ` · ${fmt.int(L.unroutable)} unroutable` : ''}${path ? `<br><span class="k">Path: ${path}</span>` : ''}`);
      const light = !none && pct > 0.55;
      s.append(rect,
        svg('text', { x: x + (cw - 4) / 2, y: y + 22, 'text-anchor': 'middle', style: `fill:${light ? '#fff' : none ? 'var(--err)' : 'var(--text)'};font-weight:700;font-size:${none ? 12 : 17}px;pointer-events:none` }, none ? '0 reps' : String(reps)),
        svg('text', { x: x + (cw - 4) / 2, y: y + 38, 'text-anchor': 'middle', style: `fill:${light ? '#fff' : 'var(--text-2)'};font-size:10.5px;pointer-events:none` }, none ? (t === 'Other' ? `${fmt.int(L.leads)} to queue` : `${fmt.int(L.leads)} overflow`) : `${fmt.int(L.leads)} leads`));
    });
  });
  return s;
}

function stepList(rules) {
  return h('ol', { style: { margin: 0, paddingLeft: '0', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '8px' } }, rules.map((r, i) => h('li', { style: { display: 'grid', gridTemplateColumns: '26px 1fr', gap: '10px', alignItems: 'start', fontSize: '13px' } },
    h('span', { style: { width: '24px', height: '24px', borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 700, fontSize: '12px' } }, i + 1), h('span', { class: 't2', style: { paddingTop: '2px' } }, r))));
}

export default async function routing({ role }) {
  const root = h('div');
  let d = await api.get('/api/routing');
  let repsCache = null;
  const getReps = async () => (repsCache ||= (await api.get('/api/reps')).filter((r) => r.role !== 'Queue'));
  const canAssign = isOpsAdmin(role);

  async function refresh() { d = await api.get('/api/routing'); paint(); }

  function openAssign(row) {
    const sel = h('select', { style: { width: '100%' } }, h('option', { value: '' }, 'Loading reps…'));
    const reason = h('textarea', { rows: 3, style: { width: '100%', resize: 'vertical' }, placeholder: 'Why is this rep taking the lead? (mandatory, written to the audit trail)' });
    const hint = h('div', { class: 'mt-s' });
    getReps().then((reps) => {
      sel.replaceChildren(h('option', { value: '' }, 'Choose a rep…'), ...reps.map((r) => h('option', { value: r.rep_id }, `${r.rep_id} · ${r.rep_name} · ${r.territory} · ${r.role}${r.products ? ' · ' + r.products : ''}`)));
    });
    const body = h('div', { class: 'col' },
      h('div', { class: 'row wrap', style: { gap: '8px' } }, leadLink(row.lead_id), bandPill(row.score_band), pill(row.territory === 'Other' ? "region 'Other'" : row.territory, row.territory === 'Other' ? 'warn' : 'muted'), pill(row.product_interest, 'info'), h('span', { class: 'muted' }, row.company_name)),
      callout('info', h('b', null, 'Manual override of the unroutable queue. '), `Region "${row.territory}" has no territory map, so rule-based routing could not pick an owner. Sales-Ops may assign any rep, `
        + 'but only with a written reason; the lead is then tagged ', h('span', { class: 'mono' }, 'manual_override'), ', the open manual_routing task is resolved and the follow-up tasks for its score band are created. '
        + 'For leads that already have a normal owner the API refuses out-of-territory assignment with a 422.'),
      h('label', { class: 'f' }, 'Assign to', sel), h('label', { class: 'f' }, 'Reason (required)', reason), hint);
    modal({
      title: `Assign ${row.lead_id}`, body,
      actions: [{ label: 'Cancel', close: true },
        {
          label: 'Assign lead', kind: 'primary', onClick: async () => {
            if (!sel.value) { hint.replaceChildren(callout('warn', 'Pick a rep.')); return false; }
            if (reason.value.trim().length < 5) { hint.replaceChildren(callout('warn', 'A reason of at least a few words is mandatory for a manual override.')); return false; }
            const r = await act(() => api.post(`/api/leads/${row.lead_id}/assign`, { rep_id: sel.value, reason: reason.value.trim() }),
              (x) => `${row.lead_id} → ${x.assigned_rep_id} (${x.routing_method})${x.tasks_created?.length ? ` · ${x.tasks_created.length} follow-up task(s) created` : ''}`);
            if (!r) return false;
            await refresh();
            return true;
          },
        }],
    });
  }

  const demoOut = h('div', { class: 'mt-s' });
  async function tryOutOfTerritory(btn) {
    btn.disabled = true; demoOut.replaceChildren(h('div', { class: 'skeleton', style: { height: '60px' } }));
    try {
      const [{ rows }, reps] = await Promise.all([api.get('/api/leads', { status: 'Working', page_size: 30 }), getReps()]);
      const lead = rows.find((r) => r.territory !== 'Other' && r.assigned_rep_id !== 'REP-000' && !r.duplicate_of_lead_id) || rows[0];
      const rep = reps.find((r) => ['SDR', 'AE'].includes(r.role) && r.territory !== lead.territory);
      let out;
      try {
        const ok = await api.post(`/api/leads/${lead.lead_id}/assign`, { rep_id: rep.rep_id, reason: 'Demo: attempt to hand a lead to a rep outside its territory' });
        out = callout('warn', h('b', null, 'Unexpected: the assignment was accepted. '), JSON.stringify(ok));
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        out = h('div', { class: 'col', style: { gap: '8px' } },
          h('div', { class: 'row wrap' }, pill(`HTTP ${e.status}`, 'err', 'lock'), pill(e.body.rule || 'blocked', 'err'), h('span', { class: 'muted' }, 'rule enforced by the API, not by the UI')),
          callout('err', h('b', null, 'Blocked. '), e.message),
          h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Attempted: ', leadLink(lead.lead_id), ` (territory ${lead.territory}) → ${rep.rep_id} ${rep.rep_name} (${rep.territory}). The lead keeps its owner ${lead.assigned_rep_id}; the attempt was written to the `, h('a', { href: '#/audit' }, 'audit trail'), ' with outcome "blocked".'));
        toast('Out-of-territory assignment blocked (422) — recorded in the audit trail', 'warn');
      }
      demoOut.replaceChildren(out);
    } catch (e) { demoOut.replaceChildren(callout('err', String(e.message || e))); }
    btn.disabled = false;
  }

  function paint() {
    const m = d.methods, total = Object.values(m).reduce((a, b) => a + b, 0) || 1;
    const rule = m.rule_based || 0, over = m.overflow_territory || 0, unr = m.unroutable_queue || 0, man = m.manual_override || 0;
    const kpis = h('div', { class: 'grid g4' },
      kpi({ label: 'Routed by rule', value: rule, sub: `${fmt.pct(rule / total)} of all leads · territory + product + least-loaded`, ico: 'route', color: 'var(--ok)' }),
      kpi({ label: 'Overflow routing', value: over, sub: 'no product specialist in territory (e.g. LATAM × Collaboration)', ico: 'users' }),
      kpi({ label: 'Unroutable → Sales-Ops queue', value: unr, sub: `${fmt.int(man)} manually overridden so far`, ico: 'flag' }),
      kpi({ label: 'Leads outside territory', value: d.violations, sub: 'labelled violations in the data · click to inspect', ico: 'alert', color: 'var(--err)' }));
    kpis.lastChild.style.cursor = 'pointer'; kpis.lastChild.onclick = () => { location.hash = '#/exceptions'; };

    const heat = card('Coverage matrix · territory × product', [
      h('div', { style: { overflowX: 'auto' } }, coverageGrid(d)),
      h('div', { class: 'row wrap mt-s', style: { gap: '14px', fontSize: '12px' } },
        h('span', { class: 't2' }, h('i', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '3px', background: 'color-mix(in srgb, var(--s1) 70%, var(--surface-3))', marginRight: '6px' } }), 'eligible reps (RepProduct bridge) · lower line = leads'),
        h('span', { class: 't2' }, h('i', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '3px', border: '1.5px dashed var(--err)', background: 'color-mix(in srgb, var(--err) 22%, var(--surface-2))', marginRight: '6px' } }), 'zero coverage → fallback path')),
      callout('info', h('b', null, 'Gaps are handled, not hidden. '), 'LATAM has no Collaboration specialist, so those leads follow the overflow path (least-loaded LATAM rep, method ', h('span', { class: 'mono' }, 'overflow_territory'),
        "). Region 'Other' has no territory at all, so leads land in the Sales-Ops queue with a manual_routing task."),
    ], { sub: 'active SDR/AE only · managers never receive leads' });
    heat.querySelector('.bd').style.display = 'flex'; heat.querySelector('.bd').style.flexDirection = 'column'; heat.querySelector('.bd').style.gap = '10px';

    const donutCard = card('Routing method distribution', [
      donut({ slices: Object.keys(METHOD).map((k) => ({ label: METHOD[k].label, value: m[k] || 0, color: METHOD[k].color })), size: 190, thickness: 26, center: { value: fmt.short(total), label: 'leads routed' } }),
      h('div', { class: 'col mt-s', style: { gap: '5px', fontSize: '12px' } }, Object.entries(METHOD).map(([k, v]) => h('div', { class: 'muted' }, h('b', { class: 't2' }, v.label + ': '), v.desc))),
    ], { sub: 'every lead records method + reason' });

    const loads = d.loads;
    const loadCard = card('Rep load · leads owned', [
      barChart({ data: loads.map((r) => ({ label: r.rep_id.slice(4), value: r.leads, color: TERR_COLOR[r.territory] || 'var(--muted)', tip: `<b>${r.rep_name}</b> · ${r.rep_id}<br>${r.territory} · ${r.role}<br>${fmt.int(r.leads)} leads owned` })), height: 230, rotate: true, labelEvery: 1 }),
      legend(TERRS.map((t) => [t, TERR_COLOR[t]])),
      h('p', { class: 'muted', style: { fontSize: '12px', margin: '8px 0 0' } }, 'Bars are lifetime leads per SDR/AE, coloured by territory. At routing time the engine balances on currently open leads (New/Working/Qualified), so the least-loaded eligible rep receives the next lead.'),
    ], { sub: 'REP-id suffix on the x axis' });

    const rulesCard = card('Documented routing rules', stepList(d.rules), { sub: 'applied in this order' });

    const enforce = card('Territory enforcement', [
      h('div', { class: 'row', style: { gap: '16px', alignItems: 'flex-start' } },
        h('a', { href: '#/exceptions', style: { textDecoration: 'none', textAlign: 'center', minWidth: '110px' } },
          h('div', { style: { fontSize: '40px', fontWeight: 750, color: 'var(--err)', lineHeight: 1.05 } }, fmt.int(d.violations)), h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Leads outside territory')),
        h('div', { class: 't2', style: { fontSize: '13px' } }, 'The owner of these leads covers a different territory than the lead’s company region. They are seeded, labelled defects that the detector finds (observed = labelled in Data → Validation). ',
          'New assignments can no longer create them: the API refuses any manual assignment outside the lead’s territory with a ', h('b', null, '422 routing_enforced'), '. ', h('a', { href: '#/exceptions' }, 'Open the exception list →'))),
      h('div', { class: 'divider' }),
      h('div', { class: 'col', style: { gap: '4px', fontSize: '12.5px' } }, d.violation_examples.slice(0, 4).map((e) => h('div', { class: 'row' }, leadLink(e.lead_id), h('span', { class: 'muted nowrap', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, e.message)))),
      h('div', { class: 'divider' }),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', disabled: !canAssign, title: canAssign ? '' : 'Only Sales/Marketing Ops and Admin can assign leads', onclick: (e) => tryOutOfTerritory(e.currentTarget) }, icon('lock'), 'Try an out-of-territory assignment'),
        h('span', { class: 'muted', style: { fontSize: '12px' } }, canAssign ? 'Picks a normal Working lead and a rep from another territory; expect a 422.' : 'Switch persona to Ops/Admin to run the live test.')),
      demoOut,
    ]);

    const q = d.queue;
    const queue = card('Sales-Ops queue · unroutable leads (REP-000)', [
      callout('warn', h('b', null, `${fmt.int(unr)} leads have no territory map. `), "Their company region is 'Other', so they cannot be routed by rule. Each sits with the Sales-Ops queue owner and carries a ", h('span', { class: 'mono' }, 'manual_routing'),
        ' task (SLA 8 h). An Ops user may override with ', h('b', null, 'any rep plus a mandatory reason'), ' — the only case where assigning outside a territory is allowed. Newest 40 shown.'),
      h('div', { class: 'mt-s' }, table({
        columns: [
          { label: 'Lead', render: (r) => leadLink(r.lead_id) }, { label: 'Created', render: (r) => fmt.ts(r.created_ts) }, { label: 'Company', render: (r) => r.company_name },
          { label: 'Product', render: (r) => r.product_interest }, { label: 'Band', render: (r) => bandPill(r.score_band) }, { label: 'Score', num: true, render: (r) => r.score },
          { label: 'manual_routing task', render: (r) => (r.task_id ? h('span', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'mono muted' }, r.task_id.replace('TASK-LEAD-2026-', '…')), statusPill(r.task_status || 'open')) : '—') },
          { label: 'Due', render: (r) => fmt.ts(r.due_ts) },
          { label: '', render: (r) => h('button', { class: 'btn sm primary', disabled: !canAssign, title: canAssign ? 'Override with a reason' : 'Ops / Admin only', onclick: () => openAssign(r) }, icon('user'), 'Assign') },
        ], rows: q, empty: 'Queue is empty — every lead has an owner.',
      })),
    ], { sub: canAssign ? 'Assign opens a reason-required override' : 'read-only for this persona' });

    root.replaceChildren(
      pageHead('Routing', 'Leads are routed by territory (company region) × product via the RepProduct bridge to the least-loaded eligible rep. Gaps and exceptions have explicit, auditable fallback paths.',
        [h('a', { class: 'btn', href: '#/exceptions' }, icon('alert'), 'Exceptions'), h('a', { class: 'btn', href: '#/audit' }, icon('history'), 'Audit trail')]),
      kpis,
      h('div', { class: 'grid g-32 mt' }, heat, donutCard),
      h('div', { class: 'grid g-32 mt' }, loadCard, rulesCard),
      h('div', { class: 'grid g2 mt' }, enforce, h('div', null)),
      h('div', { class: 'mt' }, queue));
    // let the enforcement card use the full row on small screens and sit beside a short note on wide ones
    const g = root.children[4]; g.replaceChildren(enforce, card('Why a queue and not a guess?', h('div', { class: 'col t2', style: { fontSize: '13px' } },
      h('div', null, 'Guessing an owner for a lead with no territory would silently break the “one accountable owner per territory” rule and hide a data-quality problem. Instead:'),
      h('ul', { style: { margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('li', null, 'the lead is owned by the Sales-Ops queue (REP-000) and visibly flagged unroutable_queue;'), h('li', null, 'a manual_routing task makes the gap a work item with an SLA;'),
        h('li', null, 'resolving it requires a person, a rep, and a written reason — all captured in the audit trail;'), h('li', null, 'after assignment the method becomes manual_override so reports can separate human decisions from rule decisions.')),
      h('div', { class: 'row wrap' }, pill('rule_based', 'ok'), pill('overflow_territory', 'warn'), pill('unroutable_queue', 'err'), pill('manual_override', 'violet')))));
  }

  paint();
  return root;
}

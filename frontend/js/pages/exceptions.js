// Exceptions: the five labelled edge cases, rule-based detectors graded against a separate ground truth, drill-down, live prevention demos, dedupe recall.
import { h, api, ApiError, fmt, card, pageHead, icon, pill, table, pager, callout, skeleton, leadLink, oppLink, SEV, toast } from '../lib.js';

const ic = (n, s = 15) => { const e = icon(n); e.style.cssText = `width:${s}px;height:${s}px;flex:none`; return e; };
const ICON = { opted_out_contacted: 'shield', score_post_conversion: 'clock', lead_outside_territory: 'route', duplicate_opportunity: 'copy', stage_history_gap: 'history' };
const EXPLAIN = {
  opted_out_contacted: {
    wrong: 'A rep (or automation) sent an outbound e-mail or placed a call after the contact’s latest applicable opt-out. The activity log shows an outreach at a moment when the consent ledger said “do not contact” for that channel (or for all channels).',
    expected: 'Outreach on a channel must be preceded by a valid opt-in and no later opt-out. The correct decision is to suppress the task, not to contact, and to record the suppression so the lead can still be reported on.',
    prevent: 'The consent gate runs on every task completion and every outbound activity log. If the contact has no valid consent for the channel, the API returns HTTP 409 (consent_enforced), the task is cancelled and the blocked attempt is written to the audit trail.',
    impact: 'Regulatory and brand risk. Severity: critical.' },
  score_post_conversion: {
    wrong: 'The lead’s scored_ts is later than its converted_ts. Events that happened after the lead had already become an opportunity influenced the score, so the score “knows” the outcome (target leakage) and any model evaluation using it is optimistic.',
    expected: 'A score may only use activity up to the cut-off, and the cut-off may never be later than conversion: cutoff ≤ scored_ts ≤ converted_ts. A converted lead is scored as-of its conversion moment.',
    prevent: 'Rescoring clamps the cut-off to converted_ts and says so in its response (“leakage guard”). Features are limited to inbound activity in the 30-day look-back before that cut-off. Evaluation also reports AUC with and without these leads.',
    impact: 'Inflates reported model quality and can distort routing priorities. Severity: high.' },
  lead_outside_territory: {
    wrong: 'The lead is owned by a rep whose territory differs from the territory of the lead’s company region, for example an EMEA lead sitting with a NA-East rep.',
    expected: 'Leads are routed to a rep covering the lead’s territory and product. Only unroutable leads (region “Other”) may be hand-assigned out of the queue, with a stated reason.',
    prevent: 'The assignment API checks territory and product coverage before writing. An out-of-territory owner is refused with HTTP 422 (routing_enforced) and the attempt is audited; the routing screen shows the coverage matrix.',
    impact: 'Slower response, wrong language and time zone, misreported rep performance. Severity: high.' },
  duplicate_opportunity: {
    wrong: 'A lead that was merged as a duplicate of another lead still produced its own opportunity, while the canonical lead also converted. The same buying intent is now counted twice in pipeline and conversion.',
    expected: 'Only the canonical lead may convert. A duplicate must be merged, never converted, and an open opportunity for the same company and product must block a second one.',
    prevent: 'The conversion endpoint refuses duplicates and repeat opportunities with HTTP 409 (duplicate_opportunity_prevented), naming the canonical lead and opportunity so the rep can continue there.',
    impact: 'Double-counted pipeline and two reps working one buyer. Severity: high.' },
  stage_history_gap: {
    wrong: 'The opportunity’s StageHistory chain is broken: a row’s from_stage does not equal the previous row’s to_stage, so a transition (for example Discovery → Proposal) was never recorded.',
    expected: 'Every stage change appends exactly one row and the chain is contiguous from “Qualified” to the current stage, so time-in-stage and conversion between stages can be trusted.',
    prevent: 'The advance API only allows the next stage (or Closed Lost) and refuses any skip with HTTP 422 (stage_gap_prevented). Closed deals cannot be re-opened (lifecycle_enforced), and every refusal is audited.',
    impact: 'Broken funnel analytics and an audit trail that cannot prove the sales process was followed. Severity: medium.' },
};
const GRID = 'repeat(auto-fit, minmax(200px, 1fr))';
const PAGE_SIZE = 12;

export default async function page({ role }) {
  const d = await api.get('/api/exceptions');
  const ev = d.evaluation || {};
  const evBy = Object.fromEntries((ev.types || []).map((t) => [t.issue_type, t]));
  const isAnalyst = (ev.types || []).length > 0;
  const types = d.summary.map((s) => s.issue_type);

  let sel = null;
  try { sel = sessionStorage.getItem('ex_type'); sessionStorage.removeItem('ex_type'); } catch { /* ignore */ }
  if (!sel) sel = (new URLSearchParams(location.hash.split('?')[1] || '')).get('type');
  if (!types.includes(sel)) sel = types[0];
  let pageNo = 1;

  const cardsWrap = h('div', { style: { display: 'grid', gridTemplateColumns: GRID, gap: '14px' } });
  const detailWrap = h('div', { class: 'mt' });
  const demoResult = h('div', { class: 'mt-s' });

  // ------------------------------------------------------------------------------------------------ type cards
  function paintCards() {
    cardsWrap.replaceChildren(...d.summary.map((s) => {
      const e = evBy[s.issue_type], on = s.issue_type === sel;
      const perfect = e && e.detected === e.labelled && e.false_positive === 0 && e.missed === 0;
      return h('div', { class: 'card', role: 'button', tabindex: 0, style: { padding: '16px 18px', cursor: 'pointer', borderColor: on ? 'var(--accent)' : 'var(--border)', boxShadow: on ? '0 0 0 3px var(--accent-soft), var(--shadow)' : 'var(--shadow)' },
        onclick: () => select(s.issue_type), onkeydown: (ev_) => { if (ev_.key === 'Enter') select(s.issue_type); } },
      h('div', { class: 'row', style: { gap: '8px' } }, h('div', { style: { width: '30px', height: '30px', borderRadius: '9px', display: 'grid', placeItems: 'center', background: 'var(--accent-soft)', color: 'var(--accent)' } }, ic(ICON[s.issue_type], 16)),
        h('div', { class: 'grow' }), pill(s.severity, SEV[s.severity] || 'muted', 'alert')),
      h('div', { style: { fontWeight: 650, marginTop: '10px', lineHeight: 1.3 } }, s.title), h('div', { class: 'muted', style: { fontSize: '12px' } }, `Area: ${s.area}`),
      h('p', { class: 't2', style: { fontSize: '12.5px', margin: '8px 0 10px', minHeight: '56px' } }, s.rule),
      h('div', { class: 'row', style: { alignItems: 'baseline', gap: '8px' } }, h('span', { style: { fontSize: '30px', fontWeight: 740, letterSpacing: '-.03em', color: 'var(--err)', fontVariantNumeric: 'tabular-nums' } }, fmt.int(s.detected)), h('span', { class: 'muted', style: { fontSize: '12px' } }, 'detected by rules')),
      e ? h('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)', fontSize: '12px' } },
        h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, h('span', { class: 'muted' }, 'labelled'), h('b', null, fmt.int(e.labelled)), h('span', { class: 'muted' }, 'precision'), h('b', null, fmt.pct(e.precision, 0)), h('span', { class: 'muted' }, 'recall'), h('b', null, fmt.pct(e.recall, 0))),
        h('div', { style: { marginTop: '7px' } }, perfect ? pill('detector == ground truth', 'ok', 'check') : pill(`${e.false_positive} false pos · ${e.missed} missed`, 'warn', 'alert')))
        : h('div', { class: 'muted', style: { marginTop: '10px', fontSize: '11.5px' } }, 'Grading against ground truth is shown to analyst, ops and admin personas.'));
    }));
  }

  // ------------------------------------------------------------------------------------------------ detail
  async function select(t) { sel = t; pageNo = 1; paintCards(); await paintDetail(); }
  async function paintDetail() {
    const my = sel;
    detailWrap.replaceChildren(skeleton(1, 260));
    let list;
    try { list = await api.get('/api/exceptions/list', { type: sel, page: pageNo, page_size: PAGE_SIZE }); } catch (e) { detailWrap.replaceChildren(callout('err', e.message)); return; }
    if (my !== sel) return;
    const meta = d.summary.find((s) => s.issue_type === sel), x = EXPLAIN[sel];
    const tbl = table({ columns: [
      { label: 'Entity', cls: 'nowrap', render: (r) => (r.entity_type === 'opportunity' ? oppLink(r.entity_id) : r.entity_type === 'lead' ? leadLink(r.entity_id) : h('span', { class: 'mono', style: { fontSize: '11.5px' } }, r.entity_id)) },
      { label: 'Lead', cls: 'nowrap', render: (r) => (r.lead_id ? leadLink(r.lead_id) : '—') },
      { label: 'What the detector saw', render: (r) => h('span', { style: { fontSize: '12.5px' } }, r.message) }, { label: 'Severity', render: (r) => pill(r.severity, SEV[r.severity] || 'muted') }], rows: list.rows, empty: 'Nothing detected' });
    const explain = card('Explanation', h('div', { class: 'col', style: { gap: '14px' } },
      [['What went wrong', x.wrong, 'alert', 'var(--err)'], ['Expected decision', x.expected, 'checkcircle', 'var(--ok)'], ['How the system prevents it today', x.prevent, 'shield', 'var(--accent)']].map(([t, body, i, c]) =>
        h('div', { style: { display: 'grid', gridTemplateColumns: '26px 1fr', gap: '8px' } }, h('div', { style: { color: c, paddingTop: '1px' } }, ic(i, 18)), h('div', null, h('b', { style: { fontSize: '13px' } }, t), h('div', { class: 't2', style: { fontSize: '12.5px', lineHeight: 1.55 } }, body)))),
      h('div', { class: 'muted', style: { fontSize: '12px' } }, x.impact)), { sub: meta.title });
    detailWrap.replaceChildren(h('div', { class: 'grid g-32' },
      card(`Detected exceptions · ${meta.title}`, [tbl, pager({ page: list.page, total: list.total, size: PAGE_SIZE, onPage: (p) => { pageNo = p; paintDetail(); } })], { sub: `${fmt.int(list.total)} found by rule` }), explain));
  }

  // ------------------------------------------------------------------------------------------------ prevention demos
  const show = (title, req, status, body, blocked) => {
    const rule = body?.rule;
    demoResult.replaceChildren(callout(blocked ? 'ok' : status >= 400 ? 'warn' : 'info', h('div', null,
      h('div', { class: 'row wrap', style: { gap: '8px' } }, pill(`HTTP ${status}`, blocked ? 'ok' : status >= 400 ? 'warn' : 'info'), rule ? pill(rule, 'err', 'shield') : null, h('b', null, title)),
      h('div', { class: 'code', style: { margin: '8px 0', fontSize: '11.5px' } }, req),
      h('div', null, body?.error || body?.note || JSON.stringify(body)),
      blocked ? h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, 'The system refused the action. The blocked attempt is recorded in the audit trail.') : null)));
  };
  async function call(title, method, path, payload, expectBlock = true) {
    demoResult.replaceChildren(skeleton(1, 90));
    try { const r = await api.post(path, payload); show(`${title}: accepted`, `${method} ${path}  ${JSON.stringify(payload)}`, 200, r, false); toast('Request was accepted by the API', 'ok'); return r; }
    catch (e) { if (!(e instanceof ApiError)) { demoResult.replaceChildren(callout('err', String(e))); return null; } show(e.status === 403 ? `${title}: RBAC refused this persona` : `${title}: blocked`, `${method} ${path}  ${JSON.stringify(payload)}`, e.status, e.body, expectBlock && e.status !== 403); return null; }
  }
  const DEMOS = {
    opted_out_contacted: ['Log an e-mail to an opted-out lead', async () => {
      const l = (await api.get('/api/leads', { consent: 'opted_out', page_size: 1 })).rows[0];
      if (!l) return toast('No opted-out lead found', 'warn');
      await call('Outbound e-mail to opted-out contact', 'POST', `/api/leads/${l.lead_id}/activity`, { activity_type: 'email_outbound' });
    }],
    score_post_conversion: ['Rescore a converted lead', async () => {
      const rows = (await api.get('/api/leads', { status: 'Converted', page_size: 20 })).rows.filter((r) => !(r.flags || []).includes('score_post_conversion'));
      const l = rows[0]; if (!l) return toast('No converted lead found', 'warn');
      await call('Rescore converted lead (leakage guard clamps the cut-off)', 'POST', `/api/leads/${l.lead_id}/rescore`, {}, false);
    }],
    lead_outside_territory: ['Assign to an out-of-territory rep', async () => {
      const list = await api.get('/api/exceptions/list', { type: 'lead_outside_territory', page_size: 1 });
      const e = list.rows[0]; const rep = e && /owner (REP-\d+)/.exec(e.message)?.[1]; if (!rep) return toast('No flagged lead found', 'warn');
      await call(`Assign ${e.lead_id} to ${rep} (wrong territory)`, 'POST', `/api/leads/${e.lead_id}/assign`, { rep_id: rep });
    }],
    duplicate_opportunity: ['Convert a merged duplicate lead', async () => {
      const rows = (await api.get('/api/leads', { duplicates: 1, page_size: 50 })).rows.filter((r) => r.status !== 'Converted' && !r.opportunity_id);
      const l = rows[0]; if (!l) return toast('No unconverted duplicate lead found', 'warn');
      await call(`Convert duplicate lead ${l.lead_id} into an opportunity`, 'POST', `/api/leads/${l.lead_id}/convert`, {});
    }],
    stage_history_gap: ['Skip an opportunity stage', async () => {
      const b = await api.get('/api/opportunities/board');
      const o = b.columns.find((c) => c.stage === 'Qualified')?.cards[0]; if (!o) return toast('No open opportunity found', 'warn');
      await call(`Move ${o.opportunity_id} Qualified → Negotiation (skips two stages)`, 'POST', `/api/opportunities/${o.opportunity_id}/advance`, { to_stage: 'Negotiation' });
    }],
  };
  const demoRow = card('Prevention demo · try to break the rule', [
    h('p', { class: 'muted', style: { fontSize: '12.5px', margin: '0 0 12px' } }, 'Each button picks a suitable real record and calls the live API with an action that would recreate the exception. A green result means a business rule stopped it. Some actions require a specific persona (switch persona top right): RBAC refusals are shown too.'),
    h('div', { class: 'row wrap', style: { gap: '8px' } }, types.map((t) => h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await DEMOS[t][1](); } catch (err) { demoResult.replaceChildren(callout('err', String(err.message || err))); } finally { b.disabled = false; } } }, ic(ICON[t]), DEMOS[t][0]))),
    demoResult], { sub: 'live API calls' });

  // ------------------------------------------------------------------------------------------------ dedupe + ground truth
  const dd = ev.dedupe || {};
  const dedupe = isAnalyst && Object.keys(dd).length ? card('De-duplication recall · planted vs detected', [
    h('div', { class: 'grid g2' }, [['duplicate_contact', 'Duplicate contacts'], ['duplicate_lead', 'Duplicate leads']].map(([k, label]) => {
      const x = dd[k]; if (!x) return null;
      return h('div', { class: 'card flat', style: { padding: '14px 16px', background: 'var(--surface-2)' } },
        h('div', { class: 'row' }, h('b', null, label), h('div', { class: 'grow' }), pill(`recall ${fmt.pct(x.recall)}`, x.recall >= 0.9 ? 'ok' : 'warn')),
        h('div', { style: { display: 'flex', height: '14px', borderRadius: '8px', overflow: 'hidden', gap: '2px', margin: '10px 0 6px', background: 'var(--surface-3)' } },
          h('div', { class: 'mark', style: { width: `${(x.detected / x.planted) * 100}%`, background: 'var(--s3)' }, title: `${x.detected} detected` }), h('div', { class: 'mark', style: { width: `${(x.missed / x.planted) * 100}%`, background: 'var(--s8)' }, title: `${x.missed} missed` })),
        h('div', { class: 'row', style: { gap: '14px', fontSize: '12.5px', flexWrap: 'wrap' } }, h('span', null, h('b', null, fmt.int(x.planted)), h('span', { class: 'muted' }, ' planted')), h('span', null, h('b', { style: { color: 'var(--ok)' } }, fmt.int(x.detected)), h('span', { class: 'muted' }, ' detected')), h('span', null, h('b', { style: { color: 'var(--err)' } }, fmt.int(x.missed)), h('span', { class: 'muted' }, ' missed'))));
    })),
    h('p', { class: 'muted', style: { fontSize: '12.5px', margin: '12px 0 0' } }, 'The generator plants duplicates in easy (typo, case, nickname) and hard variants (for example a double-barrelled surname with a changed e-mail local part). The rule-based matcher is tuned for precision, so the misses are the deliberate “hard” ones that need human review. We report the gap rather than hide it.'),
    h('a', { href: '#/dedupe', style: { fontSize: '12.5px', display: 'inline-block', marginTop: '8px' } }, 'Open the de-duplication review queue →')], { sub: 'detectors vs labelled duplicates' }) : null;

  const truth = callout('info', h('div', null, h('b', null, 'Ground truth is stored separately. '), 'The labelled edge cases live in ', h('span', { class: 'mono' }, 'data/full/ground_truth/*'), ' and in their own SQLite database. They are used only to ',
    h('i', null, 'grade'), ' the detectors (the precision / recall on each card), never as an input: every detector reads operational tables only, and the application never joins labels into scores, routing or workflows.'));

  paintCards();
  await paintDetail();
  return h('div', null,
    pageHead('Exceptions', 'Five known edge cases are hunted by transparent rule-based detectors and graded against a hidden, separately stored ground truth. Each one has an explanation, a drill-down and a live prevention demo.',
      [h('a', { class: 'btn', href: '#/pipeline' }, icon('kanban'), 'Pipeline'), h('a', { class: 'btn', href: '#/leads' }, icon('users'), 'Leads')]),
    truth, h('div', { class: 'mt' }, cardsWrap), detailWrap, h('div', { class: 'mt' }, demoRow), dedupe ? h('div', { class: 'mt' }, dedupe) : null);
}

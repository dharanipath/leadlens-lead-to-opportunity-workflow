// Lead 360: one screen that shows every decision made about a lead - score explanation, routing, consent, follow-ups, opportunity - with the
// business rules and exceptions that apply, plus role-gated actions that the API enforces (409/422 rule blocks are surfaced, not hidden).
import { h, api, ApiError, fmt, card, pageHead, icon, pill, table, tabs, chips, bandPill, statusPill, consentPill, scoreBar, leadLink, oppLink, callout, kv, modal, toast, act, mount, skeleton, empty } from '../lib.js';
import { gauge, stackedBar, legend } from '../charts.js';

const PERM = { convert: ['agent', 'ops', 'admin'], rescore: ['ops', 'admin'], log: ['agent', 'ops', 'admin'], assign: ['ops', 'admin'], consent: ['prospect', 'ops', 'agent', 'admin'], complete: ['agent', 'ops', 'admin'], advance: ['agent', 'ops', 'admin'] };
const PRICE = { Analytics: 480, Security: 720, Automation: 420, Collaboration: 240 };
const DISCOUNTS = [0, 5, 10, 15, 20];
const OPEN_STAGES = ['Qualified', 'Discovery', 'Proposal', 'Negotiation'];
const ALL_STAGES = [...OPEN_STAGES, 'Closed Won', 'Closed Lost'];
const ACT_TYPES = [['Inbound (prospect-driven)', ['support_inquiry', 'web_visit', 'pricing_page_view', 'content_download', 'email_open', 'email_click', 'webinar_attend', 'demo_request', 'trial_signup', 'form_submit']], ['Outbound (rep-driven, consent-checked for e-mail / call)', ['email_outbound', 'call_outbound', 'meeting', 'demo_delivered']]];
const DIM = { fit: { label: 'Fit', cap: 40, color: 'var(--s1)', why: 'who they are: industry, company size, seniority, region' }, intent: { label: 'Intent', cap: 35, color: 'var(--s3)', why: 'what they asked for: demo, pricing, trial, downloads' }, engagement: { label: 'Engagement', cap: 25, color: 'var(--s7)', why: 'how they interact: clicks, opens, visits, recency' } };
const EXC_TAB = { opted_out_contacted: 'activities', score_post_conversion: 'overview', lead_outside_territory: 'routing', duplicate_opportunity: 'opportunity', stage_history_gap: 'opportunity' };
const KIND_GROUP = { lead: 'life', status: 'life', activity_inbound: 'in', activity_outbound: 'out', task: 'task', task_done: 'task', consent_opted_in: 'consent', consent_opted_out: 'consent', stage: 'opp' };
const ROUTE_LABEL = { rule_based: 'rule-based', overflow_territory: 'overflow territory', unroutable_queue: 'unroutable queue', manual_override: 'manual override' };
const TABS = [['overview', 'Overview'], ['timeline', 'Timeline'], ['activities', 'Activities'], ['tasks', 'Tasks'], ['consent', 'Consent'], ['routing', 'Routing'], ['opportunity', 'Opportunity'], ['history', 'History']];

const tpill = (text, kind, ico, title) => { const p = pill(text, kind, ico); if (title) p.title = title; return p; };
const ico = (name, px = 16) => { const s = icon(name); s.style.cssText = `width:${px}px;height:${px}px;flex:none`; return s; };
const field = (label, input, hint) => h('label', { class: 'f' }, label, input, hint ? h('span', { class: 'muted', style: { fontWeight: 450, fontSize: '11.5px' } }, hint) : null);
const dimKey = (k) => (DIM[k] ? k : 'fit');
const num = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
const canAt = (events, ch, ts) => { let best = null; for (const e of events) { if (e.effective_ts <= ts && (e.channel === ch || e.channel === 'all') && (!best || e.effective_ts >= best.effective_ts)) best = e; } return !!best && best.status === 'opted_in'; };
const tint = (tr, kind) => { tr.style.background = `color-mix(in srgb, var(--${kind}) 9%, transparent)`; tr.style.boxShadow = `inset 3px 0 0 var(--${kind})`; };

export default async function lead({ params, query, role }) {
  const id = params[0] || '';
  let data;
  try { data = await fetchAll(id); } catch (e) {
    const missing = e instanceof ApiError && e.status === 404;
    return h('div', null, pageHead('Lead 360', 'Everything the system knows and has decided about one lead.', h('a', { class: 'btn', href: '#/leads' }, icon('users'), 'All leads')),
      callout(missing ? 'warn' : 'err', h('b', null, missing ? `No lead found for "${id}". ` : 'Could not load this lead. '), missing ? 'Check the id (format LEAD-2026-000010) or search by name, e-mail or company on the Leads page.' : String(e.message || e)),
      h('div', { class: 'mt' }, h('a', { class: 'btn primary', href: '#/leads' }, 'Browse leads')));
  }

  const state = { tab: TABS.some(([k]) => k === query?.get('tab')) ? query.get('tab') : 'overview', tlGroup: 'all', tlDesc: false, tlAll: false };
  const root = h('div');
  const reload = async () => { try { data = await fetchAll(id); paint(); } catch (e) { toast(String(e.message || e), 'err'); } };
  const can = (k) => PERM[k].includes(role);

  // ------------------------------------------------------------------ write helper: runs the call, shows a rule block inside `slot` (modal) and as a toast
  async function post(path, body, okMsg, slot) {
    let err = null;
    const r = await act(async () => { try { return await api.post(path, body); } catch (e) { err = e; throw e; } }, okMsg);
    if (!r && err instanceof ApiError && slot) mount(slot, callout(err.status === 409 || err.status === 422 ? 'warn' : 'err', h('b', null, err.body.rule ? `Rule fired: ${err.body.rule}. ` : `HTTP ${err.status}. `), err.message));
    return { ok: !!r, res: r, err };
  }

  function paint() {
    const d = data.lead360;
    const L = d.lead;
    const tabBar = h('div', { class: 'mt' });
    const body = h('div', { class: 'mt' });
    const renderTab = () => {
      mount(body, ({ overview, timeline, activities, tasks, consent, routing, opportunity, history })[state.tab](ctx));
    };
    const go = (k) => { state.tab = k; mount(tabBar, tabs(TABS.map(([key, label]) => [key, label + badge(key)]), state.tab, (x) => { state.tab = x; renderTab(); })); renderTab(); };
    const badge = (key) => {
      if (key === 'activities') return ` · ${d.activities.length}`;
      if (key === 'tasks') return ` · ${d.tasks.length}`;
      if (key === 'opportunity') return d.opportunity ? ' · 1' : '';
      if (key === 'consent') return ` · ${d.consents.length}`;
      return '';
    };
    const ctx = { d, L, go, opp: data.opp, role, can, reload, post };
    mount(tabBar, tabs(TABS.map(([key, label]) => [key, label + badge(key)]), state.tab, (x) => { state.tab = x; renderTab(); }));
    renderTab();
    mount(root, pageHead(`${d.contact.first_name} ${d.contact.last_name}`, `${d.lead.lead_id} · ${d.company.company_name} · every decision about this lead, with the rule that produced it.`,
      [h('a', { class: 'btn', href: '#/leads' }, icon('arrow'), 'All leads')]),
    headerCard(ctx), banners(ctx), tabBar, body);
  }

  // ====================================================================================================== header
  function actionsRow({ d, L, can }) {
    const a = [];
    if (can('convert')) a.push(h('button', { class: 'btn primary', disabled: L.status === 'Converted', title: L.status === 'Converted' ? `Already converted to ${L.opportunity_id}` : 'Create an opportunity from this lead', onclick: () => convertModal(ctx0()) }, icon('briefcase'), 'Convert to opportunity'));
    if (can('rescore')) a.push(h('button', { class: 'btn', onclick: () => rescore() }, icon('refresh'), 'Rescore'));
    if (can('log')) a.push(h('button', { class: 'btn', onclick: () => logModal() }, icon('plus'), 'Log activity'));
    if (!a.length) a.push(h('span', { class: 'muted row', style: { fontSize: '12.5px', gap: '6px' } }, ico('lock', 14), ` Read-only for the ${role} persona - write actions are hidden (and refused by the API).`));
    return h('div', { class: 'row wrap', style: { gap: '8px', marginTop: '14px' } }, a);
  }
  const ctx0 = () => ({ d: data.lead360, L: data.lead360.lead });

  function headerCard(c) {
    const { d, L } = c; const S = d.score; const ct = d.contact, co = d.company, rep = d.rep;
    const inTerr = d.routing.in_territory;
    const info = (label, node) => h('div', null, h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 } }, label), h('div', { style: { marginTop: '2px' } }, node));
    return h('section', { class: 'card hero glow', style: { alignItems: 'stretch', flexWrap: 'wrap' } },
      h('div', { style: { flex: '1 1 460px', minWidth: 0 } },
        h('div', { class: 'row wrap', style: { gap: '8px', marginBottom: '8px' } }, h('span', { class: 'mono', style: { fontWeight: 650 } }, L.lead_id), statusPill(L.status), L.status_reason ? pill(L.status_reason, 'muted') : null, bandPill(L.score_band), consentPill(L.consent_status),
          L.duplicate_of_lead_id ? pill('merged duplicate', 'warn', 'copy') : null, d.exceptions.length ? tpill(`${d.exceptions.length} exception${d.exceptions.length > 1 ? 's' : ''}`, 'err', 'alert') : null),
        h('h2', null, `${ct.first_name} ${ct.last_name}`), h('div', { class: 't2' }, `${ct.job_title} · ${ct.seniority} · ${ct.department}`),
        h('div', { style: { marginTop: '4px' } }, h('b', null, co.company_name), h('span', { class: 't2' }, ` · ${co.industry} · ${fmt.int(co.employee_count)} employees · ${co.region}, ${co.country}`)),
        h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '14px', marginTop: '16px' } },
          info('Owner rep', h('div', null, `${rep.rep_name}`, h('div', { class: 'row wrap', style: { gap: '5px', marginTop: '2px' } }, h('span', { class: 'muted', style: { fontSize: '12px' } }, `${rep.rep_id} · ${rep.territory}`), L.routing_method !== 'rule_based' ? pill(ROUTE_LABEL[L.routing_method] || L.routing_method, L.routing_method === 'unroutable_queue' ? 'warn' : 'violet') : null, rep.role !== 'Queue' ? (inTerr ? tpill('in territory', 'ok', 'check') : tpill('outside territory', 'err', 'alert', `Lead territory ${L.territory}, owner covers ${rep.territory}`)) : null))),
          info('Source / campaign', h('div', null, L.source, h('div', { class: 'muted', style: { fontSize: '12px' } }, d.campaign ? `${d.campaign.campaign_id} · ${d.campaign.campaign_name}` : 'no campaign (direct)'))),
          info('Interested in', h('div', null, L.product_interest, h('div', { class: 'muted', style: { fontSize: '12px' } }, `territory ${L.territory}`))),
          info('Consent now', h('div', { class: 'row wrap', style: { gap: '5px' } }, d.can_contact.email ? tpill('e-mail allowed', 'ok', 'mail') : tpill('e-mail blocked', 'err', 'lock'), d.can_contact.phone ? tpill('phone allowed', 'ok', 'phone') : tpill('phone blocked', 'err', 'lock'))),
          info('Created', h('div', null, fmt.ts(L.created_ts), h('div', { class: 'muted', style: { fontSize: '12px' } }, `last activity ${fmt.ts(L.last_activity_ts)}`))),
          info('Opportunity', L.opportunity_id ? oppLink(L.opportunity_id) : h('span', { class: 'muted' }, 'none yet'))),
        actionsRow(c)),
      h('div', { style: { flex: '0 0 230px', display: 'grid', placeItems: 'center', textAlign: 'center' } },
        h('div', null, gauge({ value: L.score, size: 220 }), h('div', { class: 'row', style: { justifyContent: 'center', gap: '8px', marginTop: '-4px' } }, bandPill(L.score_band), S.reproduced ? tpill('reproducible', 'ok', 'check', 'Recomputed from the rule set and activity: identical to the stored score') : tpill('not reproducible', 'err', 'alert')),
          h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '6px' } }, `rule set v${L.score_version} · scored ${fmt.ts(L.scored_ts)}`))));
  }

  function banners({ d, L, go }) {
    const out = [];
    d.exceptions.forEach((e) => {
      const kind = e.severity === 'medium' ? 'warn' : 'err';
      out.push(callout(kind, h('div', { class: 'row wrap', style: { gap: '8px' } }, h('b', null, e.title), tpill(e.severity, kind), tpill(e.area, 'muted'), h('span', { class: 'grow' }), h('button', { class: 'btn sm', onclick: () => go(EXC_TAB[e.issue_type] || 'overview') }, 'Show evidence', icon('arrow'))),
        h('div', { style: { marginTop: '3px' } }, e.message, ' ', e.entity_type === 'opportunity' ? oppLink(e.entity_id) : null), h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } }, 'Rule: ', e.rule)));
    });
    if (d.duplicate_of) out.push(callout('warn', h('b', null, 'Merged duplicate. '), 'Same person + same product within 30 days of ', leadLink(d.duplicate_of.lead_id), ` (created ${fmt.date(d.duplicate_of.created_ts)}, status ${d.duplicate_of.status}${d.duplicate_of.opportunity_id ? ', opportunity ' : ''}`, d.duplicate_of.opportunity_id ? oppLink(d.duplicate_of.opportunity_id) : null, '). A duplicate inherits the canonical lead\'s owner and may not create its own opportunity.'));
    if (d.duplicates.length) out.push(callout('info', h('b', null, `${d.duplicates.length} later lead${d.duplicates.length > 1 ? 's were' : ' was'} merged into this one: `), d.duplicates.map((x, i) => [i ? ', ' : '', leadLink(x.lead_id)])));
    if (d.merged_contacts.length) out.push(callout('info', h('b', null, 'Contact de-duplication. '), `${d.merged_contacts.length} duplicate contact record${d.merged_contacts.length > 1 ? 's' : ''} resolved to this canonical contact (${d.merged_contacts.map((m) => m.contact_id).join(', ')}).`));
    return out.length ? h('div', { class: 'col mt' }, out) : h('span');
  }

  // ====================================================================================================== modals / actions
  function convertModal() {
    const { d, L } = { d: data.lead360, L: data.lead360.lead };
    const unit = PRICE[L.product_interest]; const suggested = Math.max(5, Math.min(5000, Math.floor(d.company.employee_count * 0.1)));
    const seats = h('input', { type: 'number', min: 1, value: suggested, style: { width: '100%' } });
    const disc = h('select', null, DISCOUNTS.map((x) => h('option', { value: x }, `${x}%`)));
    const preview = h('div', { class: 'code', style: { whiteSpace: 'normal' } });
    const slot = h('div');
    const upd = () => { const s = Number(seats.value) || 0, dc = Number(disc.value); preview.textContent = `${fmt.int(s)} seats × ${fmt.money(unit)} × (1 − ${dc}%) = ${fmt.money(s * unit * (100 - dc) / 100)} / year`; };
    seats.oninput = upd; disc.onchange = upd; upd();
    modal({ title: 'Convert lead to opportunity', body: h('div', { class: 'col' },
      callout('info', 'Guards that run on convert: ', h('b', null, 'duplicate lead'), ' (a merged duplicate cannot create its own opportunity), ', h('b', null, 'duplicate opportunity'), ' (same company + product already open), ', h('b', null, 'routing'), ' (not in the Sales-Ops queue) and ', h('b', null, 'consent'), ' (not opted out of every channel).'),
      h('div', { class: 'formgrid' }, field('Seats', seats, `suggested ${suggested} (10% of ${fmt.int(d.company.employee_count)} employees)`), field('Discount', disc, 'approved tiers only')),
      field(`Amount (${L.product_interest} @ ${fmt.money(unit)} per seat / year)`, preview), slot),
    actions: [{ label: 'Cancel', close: true }, { label: 'Create opportunity', kind: 'primary', onClick: async () => {
      const r = await post(`/api/leads/${L.lead_id}/convert`, { seats: Number(seats.value), discount_pct: Number(disc.value) }, (x) => `Converted → ${x.opportunity_id} (${fmt.money(x.amount_usd)})`, slot);
      if (r.ok) { state.tab = 'opportunity'; reload(); return true; }
      reload(); return false;
    } }] });
  }

  async function rescore() {
    const L = data.lead360.lead;
    const r = await act(() => api.post(`/api/leads/${L.lead_id}/rescore`), null);
    if (!r) return;
    modal({ title: 'Rescored', body: h('div', { class: 'col' },
      h('div', { class: 'row', style: { gap: '14px', fontSize: '22px', fontWeight: 700 } }, h('span', { class: 'muted' }, r.before), ico('arrow', 22), h('span', null, r.after), bandPill(r.band)),
      kv({ 'Rule set': `v${r.version}`, 'Score cut-off (scored_ts)': fmt.ts(r.scored_ts) }),
      r.note ? callout('warn', h('b', null, 'Leakage guard. '), r.note.replace(/^leakage guard:\s*/i, '').replace(/^./, (c) => c.toUpperCase()) + '.', ' Without the guard the score would also count events that happened after the customer had already converted.') : callout('ok', 'No leakage guard needed: the lead has not converted, so the cut-off is the current time. Only inbound events up to the cut-off, within the 30-day window, are counted.')),
    actions: [{ label: 'Close' }] });
    reload();
  }

  function logModal() {
    const L = data.lead360.lead; const dd = data.lead360;
    const type = h('select', null, ACT_TYPES.map(([g, items]) => h('optgroup', { label: g }, items.map((t) => h('option', { value: t }, t.replace(/_/g, ' '))))));
    const detail = h('input', { placeholder: 'optional note', style: { width: '100%' } }); const slot = h('div');
    modal({ title: `Log activity on ${L.lead_id}`, body: h('div', { class: 'col' },
      callout('info', 'Outbound ', h('b', null, 'e-mail'), ' and ', h('b', null, 'call'), ' are checked against the consent ledger at this moment: ', dd.can_contact.email ? 'e-mail is currently allowed' : h('b', null, 'e-mail is currently BLOCKED'), '; ', dd.can_contact.phone ? 'phone is currently allowed.' : h('b', null, 'phone is currently BLOCKED.')),
      field('Activity type', type), field('Note', detail), slot),
    actions: [{ label: 'Cancel', close: true }, { label: 'Log activity', kind: 'primary', onClick: async () => {
      const r = await post(`/api/leads/${L.lead_id}/activity`, { activity_type: type.value, detail: detail.value.trim() || undefined }, (x) => `Logged ${x.activity_id}`, slot);
      if (r.ok) { reload(); return true; } return false;
    } }] });
  }

  function showBlock(err, t) {
    modal({ title: 'Blocked by the consent rule', body: h('div', { class: 'col' }, callout('err', h('b', null, `[${err.body.rule || 'rule'}] `), err.message),
      h('p', { class: 'muted', style: { margin: 0, fontSize: '12.5px' } }, `Task ${t.task_id} was cancelled (opted_out_before_completion) and the attempt was written to the audit log. Consent is re-checked at completion time.`)), actions: [{ label: 'Close' }] });
  }

  // ====================================================================================================== tabs
  const T = {};
  const overview = ({ d, L }) => {
    const S = d.score; const dims = S.dimensions;
    const leaked = S.leak ? S.activities_used.filter((a) => a.activity_ts > S.converted_ts) : [];
    const dimRows = Object.keys(DIM).map((k) => {
      const x = dims[k]; const pct = Math.max(0, Math.min(100, (x.points / x.cap) * 100));
      return h('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr 120px', gap: '12px', alignItems: 'center' }, title: DIM[k].why },
        h('div', null, h('b', null, DIM[k].label), h('div', { class: 'muted', style: { fontSize: '11px' } }, DIM[k].why.split(':')[0])),
        h('div', { class: 'bar-inline', style: { height: '10px' } }, h('i', { style: { width: `${pct}%`, background: DIM[k].color } })),
        h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '6px' } }, h('b', null, x.points), h('span', { class: 'muted' }, `/ ${x.cap}`), x.capped ? tpill('capped', 'warn', null, 'Raw rule points exceeded the dimension cap and were truncated') : null));
    });
    const total = stackedBar({ segments: Object.keys(DIM).map((k) => ({ label: `${DIM[k].label} (cap ${DIM[k].cap})`, value: dims[k].points, color: DIM[k].color })), total: 100, height: 20 });
    const markers = h('div', { style: { position: 'relative', height: '16px', fontSize: '10.5px', color: 'var(--muted)' } },
      h('span', { style: { position: 'absolute', left: '40%', transform: 'translateX(-50%)' } }, '▲ Warm ≥ 40'), h('span', { style: { position: 'absolute', left: '70%', transform: 'translateX(-50%)' } }, '▲ Hot ≥ 70'));

    const grp = Object.keys(DIM).map((k) => {
      const rules = S.breakdown.filter((b) => dimKey(b.dimension) === k);
      return [h('tr', null, h('td', { colspan: 6, style: { background: 'var(--surface-2)', fontWeight: 650 } }, h('span', { class: 'row', style: { gap: '8px' } }, h('i', { style: { width: '10px', height: '10px', borderRadius: '3px', background: DIM[k].color, display: 'inline-block' } }), `${DIM[k].label} - ${dims[k].points} of ${dims[k].cap} points`, dims[k].capped ? tpill('dimension capped', 'warn') : null))),
        ...rules.map((b) => h('tr', { style: b.points === 0 ? { opacity: 0.55 } : null },
          h('td', { class: 'mono nowrap' }, b.rule_id), h('td', null, h('div', null, b.feature.replace('act:', 'activity: ').replace(/_/g, ' ')), h('div', { class: 'muted', style: { fontSize: '11.5px' } }, b.description)),
          h('td', null, h('code', { class: 'mono' }, num(b.observed))), h('td', { class: 'num' }, h('b', null, b.points > 0 ? `+${b.points}` : String(b.points)), b.raw_points !== b.points ? h('span', { class: 'muted' }, ` (raw ${b.raw_points})`) : null),
          h('td', { class: 'num muted' }, b.rule_cap), h('td', null, b.capped ? tpill('capped', 'warn', 'alert', 'Rule-level cap applied') : h('span', { class: 'muted' }, '-'))))];
    });
    const breakdown = h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Rule', 'Feature', 'Observed', 'Points', 'Cap', 'Capped'].map((x, i) => h('th', { class: i >= 3 && i < 5 ? 'num' : '' }, x)))), h('tbody', null, grp)));

    const repro = S.reproduced
      ? callout('ok', h('b', null, 'Score reproducible ✓ '), `recomputed from ScoreRule v${S.rule_version} + the activity log = ${S.score} (stored ${S.stored_score}), using only inbound events between ${fmt.ts(S.window_start)} and the cut-off ${fmt.ts(S.cutoff)} (scored_ts, 30-day window).`)
      : callout('err', h('b', null, 'Score NOT reproducible. '), `Recomputed ${S.score} at cut-off ${fmt.ts(S.cutoff)} vs stored ${S.stored_score} - the stored score no longer matches the rules + activity.`);
    const leak = S.leak ? callout('err', h('b', null, 'Target leakage: this score used events after the lead had converted. '),
      h('div', { style: { marginTop: '3px' } }, `The lead converted at ${fmt.ts(S.converted_ts)} but was scored at ${fmt.ts(S.cutoff)}. ${leaked.length ? `${leaked.length} inbound event${leaked.length > 1 ? 's' : ''} between conversion and the cut-off fed the score (marked below). ` : 'No inbound event fell inside that gap, but the cut-off itself is already post-conversion. '}A score may only use information available at decision time, otherwise "conversion" leaks into its own predictor and inflates measured accuracy.`),
      leaked.length ? h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, leaked.map((a) => h('li', null, h('span', { class: 'mono' }, a.activity_id), ` · ${a.activity_type.replace(/_/g, ' ')} · ${fmt.ts(a.activity_ts)}`))) : null,
      S.activities_after_cutoff.length ? h('div', { class: 'muted', style: { marginTop: '6px', fontSize: '12.5px' } }, `Also ${S.activities_after_cutoff.length} inbound event(s) after the cut-off exist but are correctly ignored.`) : null,
      h('div', { class: 'muted', style: { marginTop: '6px', fontSize: '12.5px' } }, 'Fix: Rescore clamps the cut-off to converted_ts (leakage guard).')) : null;

    const usedTable = S.activities_used.length ? h('div', { class: 'tablewrap', style: { maxHeight: '320px', overflowY: 'auto' } }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Activity', 'Type', 'When'].map((x) => h('th', null, x)))),
      h('tbody', null, S.activities_used.map((a) => { const bad = S.leak && a.activity_ts > S.converted_ts; const tr = h('tr', null, h('td', { class: 'mono', style: { fontSize: '11.5px' } }, a.activity_id.replace('ACT-' + L.lead_id + '-', '#')), h('td', null, a.activity_type.replace(/_/g, ' '), bad ? [' ', tpill('post-conversion', 'err')] : null), h('td', { class: 'muted nowrap' }, fmt.ts(a.activity_ts))); if (bad) tint(tr, 'err'); return tr; })))) : empty('No inbound events fell inside the 30-day scoring window.');
    const counts = Object.entries(S.features.counts || {});
    const facts = kv({ Contact: `${d.contact.email}`, Phone: d.contact.phone || '—', Company: `${d.company.company_name} (${d.company.domain})`, 'Account status': d.company.account_status, 'Free e-mail domain': S.features.free_email ? 'yes - fit penalty' : 'no', 'Days since last inbound': S.features.days_since_last_inbound ?? '—' });

    return h('div', { class: 'grid g-32' },
      h('div', { class: 'col' },
        card('Score explainability', h('div', { class: 'col', style: { gap: '14px' } },
          h('div', { class: 'row', style: { alignItems: 'baseline', gap: '10px' } }, h('span', { style: { fontSize: '30px', fontWeight: 750 } }, S.score), h('span', { class: 'muted' }, '/ 100 = Fit + Intent + Engagement'), h('div', { class: 'grow' }), bandPill(S.band)),
          h('div', null, total, markers, legend(Object.keys(DIM).map((k) => [`${DIM[k].label} ${dims[k].points} / ${DIM[k].cap}`, DIM[k].color]))),
          h('div', { class: 'col', style: { gap: '10px' } }, dimRows), repro, leak),
        { sub: `rule set v${S.rule_version}` }),
        card('Per-rule breakdown', [breakdown, h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, 'Every point comes from a transparent ScoreRule row: points = rule(observed value), truncated at the rule cap, then each dimension is truncated at its own cap (Fit ≤ 40, Intent ≤ 35, Engagement ≤ 25). Greyed rows contributed nothing.')], { sub: `${S.breakdown.length} rules` })),
      h('div', { class: 'col' },
        card('Window & cut-off', kv({ 'Scored at (cut-off)': fmt.ts(S.cutoff), 'Window start': fmt.ts(S.window_start), 'Rule set': `ScoreRule v${S.rule_version}`, 'Events used': `${S.activities_used.length} inbound`, 'Events after cut-off': `${S.activities_after_cutoff.length} (ignored)`, 'Converted at': S.converted_ts ? fmt.ts(S.converted_ts) : 'not converted', Bands: 'Hot ≥ 70 · Warm ≥ 40 · Cold < 40' })),
        card('Inbound activity that fed the score', usedTable, { sub: counts.map(([k, v]) => `${v}× ${k.replace(/_/g, ' ')}`).slice(0, 3).join(' · ') }),
        card('Contact & company', facts)));
  };

  const timeline = ({ d }) => {
    const groups = [['all', 'Everything'], ['life', 'Lifecycle'], ['in', 'Inbound activity'], ['out', 'Outbound activity'], ['task', 'Tasks'], ['consent', 'Consent'], ['opp', 'Opportunity']];
    const viol = violations(d);
    const holder = h('div');
    const draw = () => {
      let ev = d.timeline.filter((e) => state.tlGroup === 'all' || KIND_GROUP[e.kind] === state.tlGroup);
      if (state.tlDesc) ev = [...ev].reverse();
      const shown = state.tlAll ? ev : ev.slice(0, 120);
      mount(holder, ev.length ? h('div', { class: 'timeline' }, shown.map((e) => {
        const aid = (e.detail.match(/ACT-[\w-]+/) || [])[0]; const bad = aid && viol.has(aid);
        return h('div', { class: `tl-item k-${e.kind}` }, h('div', { class: 'ts' }, fmt.ts(e.ts)), h('div', { class: 'tt row wrap', style: { gap: '8px' } }, e.title.charAt(0).toUpperCase() + e.title.slice(1), bad ? tpill('no valid consent at this time', 'err', 'lock', 'Outbound contact made after the contact opted out on this channel') : null), h('div', { class: 'dd' }, e.detail));
      }), ev.length > shown.length ? h('button', { class: 'btn sm', onclick: () => { state.tlAll = true; draw(); } }, `Show all ${ev.length} events`) : null) : empty('No events in this group.'));
    };
    draw();
    return card('Merged timeline', h('div', { class: 'col' },
      h('div', { class: 'row wrap' }, chips(groups, state.tlGroup, (k) => { state.tlGroup = k; draw(); }), h('div', { class: 'grow' }), chips([['asc', 'Oldest first'], ['desc', 'Newest first']], state.tlDesc ? 'desc' : 'asc', (k) => { state.tlDesc = k === 'desc'; draw(); })),
      holder), { sub: `${d.timeline.length} events from lead, status, activity, task, consent and stage records` });
  };

  /** activity ids of outbound e-mail/call made when the ledger did not allow that channel (the "opted-out contact contacted" rule) */
  function violations(d) {
    const s = new Set(d.exceptions.filter((e) => e.issue_type === 'opted_out_contacted').map((e) => e.entity_id));
    d.activities.forEach((a) => { const ch = a.activity_type === 'email_outbound' ? 'email' : a.activity_type === 'call_outbound' ? 'phone' : null; if (ch && !canAt(d.consents, ch, a.activity_ts)) s.add(a.activity_id); });
    return s;
  }

  const activities = ({ d }) => {
    const viol = violations(d);
    const t = table({ columns: [
      { label: 'Activity', render: (a) => h('span', { class: 'mono nowrap' }, a.activity_id) }, { label: 'Type', render: (a) => a.activity_type.replace(/_/g, ' ') },
      { label: 'Direction', render: (a) => pill(a.direction, a.direction === 'inbound' ? 'info' : 'violet') }, { label: 'Channel', render: (a) => a.channel }, { label: 'When', render: (a) => h('span', { class: 'nowrap' }, fmt.ts(a.activity_ts)) },
      { label: 'Rep', render: (a) => a.rep_id || '—' }, { label: 'Task', render: (a) => (a.task_id ? h('span', { class: 'mono', style: { fontSize: '11px' } }, a.task_id.replace('TASK-' + d.lead.lead_id + '-', 'T')) : '—') }, { label: 'Detail', render: (a) => a.detail || '—' },
      { label: 'Consent at that time', render: (a) => { const ch = a.activity_type === 'email_outbound' ? 'email' : a.activity_type === 'call_outbound' ? 'phone' : null; if (!ch) return h('span', { class: 'muted' }, a.direction === 'inbound' ? 'n/a (inbound)' : 'n/a'); return viol.has(a.activity_id) ? tpill(`NO ${ch} consent`, 'err', 'lock') : tpill(`${ch} allowed`, 'ok', 'check'); } }],
    rows: d.activities, empty: 'No activity recorded for this lead.' });
    [...t.querySelectorAll('tbody tr')].forEach((tr, i) => { if (d.activities[i] && viol.has(d.activities[i].activity_id)) tint(tr, 'err'); });
    return h('div', { class: 'col' },
      viol.size ? callout('err', h('b', null, `${viol.size} outbound contact${viol.size > 1 ? 's' : ''} without valid consent. `), 'Rule: an outbound e-mail or call must be backed by the latest applicable consent-ledger event (channel-specific or "all") being opted_in at that timestamp. Highlighted rows were logged after an opt-out - see the Consent tab for the ledger.')
        : callout('info', h('b', null, 'Consent check. '), 'Each outbound e-mail/call is compared with the consent ledger at its timestamp; none of this lead\'s outreach violated an opt-out.'),
      card(null, t));
  };

  const tasks = ({ d, L, can }) => {
    const rows = d.tasks;
    const t = table({ columns: [
      { label: 'Task', render: (x) => h('span', { class: 'mono nowrap', style: { fontSize: '11.5px' } }, x.task_id) }, { label: 'Type', render: (x) => fmt.title(x.task_type) },
      { label: 'Priority', render: (x) => pill(x.priority, x.priority === 'P1' ? 'hot' : x.priority === 'P2' ? 'warm' : 'cold') }, { label: 'Owner', render: (x) => x.assigned_rep_id },
      { label: 'Due', render: (x) => h('span', { class: 'nowrap' }, fmt.ts(x.due_ts), h('div', { class: 'muted', style: { fontSize: '11px' } }, `SLA ${x.sla_hours}h`)) },
      { label: 'Completed', render: (x) => (x.completed_ts ? h('span', { class: 'nowrap' }, fmt.ts(x.completed_ts)) : '—') },
      { label: 'SLA', render: (x) => (x.sla_met == null ? h('span', { class: 'muted' }, '—') : x.sla_met ? tpill('met', 'ok', 'check') : tpill('missed', 'err', 'alert')) },
      { label: 'Status', render: (x) => statusPill(x.status) }, { label: 'Outcome / reason', render: (x) => (x.outcome ? fmt.title(x.outcome) : x.cancel_reason ? h('span', { class: 't2' }, fmt.title(x.cancel_reason)) : '—') },
      { label: '', render: (x) => {
        if (!(x.status === 'open' || x.status === 'overdue')) return null;
        if (!can('complete')) return h('span', { class: 'muted', style: { fontSize: '11.5px' } }, 'read-only');
        const out = h('select', { style: { width: '128px', padding: '4px 6px', fontSize: '12.5px' } }, ['connected', 'replied', 'no_answer', 'meeting_booked', 'not_interested', 'resolved'].map((o) => h('option', { value: o }, fmt.title(o))));
        return h('div', { class: 'row', style: { gap: '6px' } }, out, h('button', { class: 'btn sm primary', onclick: async (e) => {
          e.currentTarget.disabled = true; let err = null;
          const r = await act(async () => { try { return await api.post(`/api/tasks/${x.task_id}/complete`, { outcome: out.value }); } catch (er) { err = er; throw er; } }, (z) => `Task completed · SLA ${z.sla_met ? 'met' : 'missed'}${z.lead_status_change ? ' · lead ' + z.lead_status_change : ''}`);
          if (!r && err?.status === 409 && err.body.rule === 'consent_enforced') showBlock(err, x);
          reload();
        } }, icon('check'), 'Complete'));
      } }],
    rows, empty: 'No follow-up tasks for this lead.' });
    const sup = rows.filter((x) => x.status === 'suppressed' || x.status === 'cancelled').length;
    return h('div', { class: 'col' },
      callout('info', h('b', null, `Follow-up SLA for a ${L.score_band} lead: `), `${{ Hot: 'first-response call within 4 h (P1)', Warm: 'follow-up e-mail within 24 h (P2)', Cold: 'nurture check within 72 h (P3)' }[L.score_band]}. SLA is met when completed_ts ≤ due_ts. `,
        sup ? `${sup} task${sup > 1 ? 's were' : ' was'} suppressed or cancelled by the consent rule (no outreach without opt-in).` : 'Completing an e-mail/call task re-checks consent at that moment.'),
      card(null, t));
  };

  const consent = ({ d, L, can }) => {
    const cur = (ch) => d.can_contact[ch];
    const ask = (title, channel, status, impact) => {
      const slot = h('div'); const src = h('input', { value: 'preference_center', style: { width: '100%' } });
      modal({ title, body: h('div', { class: 'col' }, callout(status === 'opted_out' ? 'warn' : 'info', impact), field('Source recorded in the ledger', src), slot),
        actions: [{ label: 'Cancel', close: true }, { label: status === 'opted_out' ? 'Record opt-out' : 'Record opt-in', kind: status === 'opted_out' ? 'danger' : 'primary', onClick: async () => {
          const r = await post('/api/consent', { contact_id: d.contact.contact_id, channel, status, source: src.value || 'preference_center' }, (x) => `Ledger row ${x.consent_id} appended` + (x.tasks_cancelled.length ? ` · ${x.tasks_cancelled.length} task(s) cancelled` : '') + (x.leads_disqualified.length ? ` · ${x.leads_disqualified.length} lead(s) disqualified` : ''), slot);
          if (r.ok) { reload(); return true; } return false; } }] });
    };
    const chanCard = (ch, label, icoName) => h('div', { class: 'card flat', style: { padding: '14px', background: 'var(--surface-2)' } },
      h('div', { class: 'row' }, ico(icoName), h('b', null, label), h('div', { class: 'grow' }), cur(ch) ? tpill('allowed', 'ok', 'check') : tpill('blocked', 'err', 'lock')),
      can('consent') ? h('div', { style: { marginTop: '10px' } }, cur(ch)
        ? h('button', { class: 'btn sm danger', onclick: () => ask(`Opt out of ${label.toLowerCase()}`, ch, 'opted_out', `Appends an opted_out row to the ledger. Open ${ch === 'email' ? 'e-mail' : 'call'} tasks for this contact are cancelled${ch === 'email' ? ' and the lead\'s consent state becomes opted_out' : ''}.`) }, icon('lock'), `Opt out of ${ch === 'email' ? 'e-mail' : 'phone'}`)
        : h('button', { class: 'btn sm', onclick: () => ask(`Opt in to ${label.toLowerCase()}`, ch, 'opted_in', 'Appends an opted_in row. Earlier rows are never edited - the latest applicable event wins.') }, icon('check'), `Opt in to ${ch === 'email' ? 'e-mail' : 'phone'}`)) : null);
    const ledger = table({ columns: [
      { label: 'Ledger id', render: (c) => h('span', { class: 'mono' }, c.consent_id) }, { label: 'Effective', render: (c) => h('span', { class: 'nowrap' }, fmt.ts(c.effective_ts)) }, { label: 'Channel', render: (c) => c.channel },
      { label: 'Status', render: (c) => (c.status === 'opted_in' ? tpill('opted in', 'ok', 'check') : tpill('opted out', 'err', 'lock')) }, { label: 'Legal basis', render: (c) => fmt.title(c.legal_basis) }, { label: 'Source', render: (c) => fmt.title(c.source) }], rows: d.consents });
    return h('div', { class: 'grid g-21' },
      card('Consent ledger (append-only)', [ledger, h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, 'Rule: the latest ledger event that applies to a channel (a channel-specific row or an "all" row) with effective time ≤ now decides whether it may be contacted. No record means no contact. Rows are never edited or deleted.')], { sub: `contact ${d.contact.contact_id}` }),
      h('div', { class: 'col' },
        card('Current permission', h('div', { class: 'col' }, chanCard('email', 'E-mail', 'mail'), chanCard('phone', 'Phone', 'phone'),
          can('consent') && (cur('email') || cur('phone')) ? h('button', { class: 'btn danger', onclick: () => ask('Opt out of all channels', 'all', 'opted_out', 'An all-channel opt-out cancels every open outreach task, and the lead is Disqualified (reason: Opted out). The contact becomes ineligible for conversion.') }, icon('lock'), 'Opt out of everything') : null,
          !can('consent') ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, `The ${role} persona cannot change consent.`) : null,
          h('div', { class: 'row' }, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Lead-level state:'), consentPill(L.consent_status))))));
  };

  const routing = ({ d, L, can }) => {
    const R = d.routing; const queue = d.rep.role === 'Queue';
    const reassign = (preset) => {
      const slot = h('div'); const reason = h('input', { placeholder: queue ? 'required when taking a lead out of the queue' : 'why is this being reassigned?', style: { width: '100%' } });
      const sel = h('select', null, h('optgroup', { label: `Eligible: ${L.territory} reps` }, R.eligible_reps.map((r) => h('option', { value: r.rep_id, selected: r.rep_id === preset }, `${r.rep_id} · ${r.rep_name} (${r.role}) - ${r.open_leads} open${r.covers_product ? '' : ' - no product cover'}`))), h('optgroup', { label: 'Other territories (the rule will block these)' }, h('option', { value: '' }, 'loading reps…')));
      api.get('/api/leads/filters').then((f) => { const og = sel.querySelectorAll('optgroup')[1]; og.replaceChildren(...f.reps.filter((r) => r.rep_id !== 'REP-000' && !R.eligible_reps.some((e) => e.rep_id === r.rep_id)).map((r) => h('option', { value: r.rep_id }, `${r.rep_id} · ${r.rep_name} (${r.territory})`))); }).catch(() => {});
      modal({ title: `Reassign ${L.lead_id}`, body: h('div', { class: 'col' }, callout('info', h('b', null, 'Routing rule: '), `a lead may only be owned by a rep who covers its territory (${L.territory}). Manual picks outside it are rejected with 422 and audited. Unroutable leads in the Sales-Ops queue can be overridden with a reason.`), field('New owner', sel), field('Reason', reason), slot),
        actions: [{ label: 'Cancel', close: true }, { label: 'Reassign', kind: 'primary', onClick: async () => {
          const r = await post(`/api/leads/${L.lead_id}/assign`, { rep_id: sel.value, reason: reason.value.trim() || undefined }, (x) => `Reassigned to ${x.assigned_rep_id} (${x.routing_method})${x.tasks_created.length ? ` · ${x.tasks_created.length} task(s) created` : ''}`, slot);
          if (r.ok) { reload(); return true; } reload(); return false; } }] });
    };
    const terrBox = (label, value, ok) => h('div', { class: 'card flat', style: { padding: '14px', background: 'var(--surface-2)', flex: 1 } }, h('div', { class: 'muted', style: { fontSize: '11.5px' } }, label), h('div', { style: { fontSize: '20px', fontWeight: 700, marginTop: '2px' } }, value));
    const tbl = table({ columns: [
      { label: 'Rep', render: (r) => h('div', null, h('b', null, r.rep_name), ' ', r.rep_id === L.assigned_rep_id ? tpill('current owner', 'info', 'user') : null, h('div', { class: 'muted', style: { fontSize: '11.5px' } }, `${r.rep_id} · ${r.role}`)) }, { label: 'Territory', render: (r) => (r.territory === L.territory ? tpill(r.territory, 'ok', 'check') : tpill(r.territory, 'err', 'x')) },
      { label: 'Covers product', render: (r) => (r.covers_product ? tpill(`${L.product_interest} ✓`, 'ok', 'check') : tpill(`no ${L.product_interest}`, 'muted')) }, { label: 'Open leads', num: true, render: (r) => fmt.int(r.open_leads) }, { label: 'Status', render: (r) => (r.active_to ? tpill('left ' + fmt.date(r.active_to), 'muted') : tpill('active', 'ok')) },
      { label: '', render: (r) => (can('assign') && r.rep_id !== L.assigned_rep_id ? h('button', { class: 'btn sm', onclick: () => reassign(r.rep_id) }, 'Assign') : null) }], rows: R.eligible_reps, empty: `No active reps cover territory ${L.territory} - this lead is unroutable and sits in the Sales-Ops queue.` });
    return h('div', { class: 'col' },
      !R.in_territory ? callout('err', h('b', null, 'Assigned outside territory. '), `The lead's territory is ${R.lead_territory} but its owner ${d.rep.rep_name} covers ${R.owner_territory}. The routing rule only allows reps who cover the lead's territory; new manual assignments like this are refused (422).`) : null,
      card('Routing decision', h('div', { class: 'col' },
        h('div', { class: 'row wrap', style: { gap: '10px' } }, tpill(ROUTE_LABEL[R.decision] || R.decision, R.decision === 'rule_based' ? 'ok' : R.decision === 'unroutable_queue' ? 'warn' : 'violet', 'route'), h('span', { class: 't2' }, queue ? 'Parked in the Sales-Ops queue (REP-000): region has no territory map, so a manual_routing task was created.' : R.decision === 'rule_based' ? 'Chosen by territory × product, least-loaded eligible rep.' : R.decision === 'overflow_territory' ? 'No product specialist in the territory: least-loaded territory rep.' : 'Assigned manually by Sales Ops.')),
        h('div', { class: 'code', style: { whiteSpace: 'pre-wrap' } }, R.reason || '(no reason recorded)'),
        h('div', { class: 'row wrap', style: { gap: '12px', alignItems: 'stretch' } }, terrBox('Lead territory (company region)', R.lead_territory), h('div', { class: 'row', style: { fontSize: '26px', fontWeight: 700, color: R.in_territory ? 'var(--ok)' : 'var(--err)' }, title: R.in_territory ? 'owner covers the lead territory' : 'owner does NOT cover the lead territory' }, R.in_territory ? '✓' : '✗'),
          terrBox('Owner territory', queue ? 'Global (queue)' : R.owner_territory)),
        can('assign') ? h('div', null, h('button', { class: 'btn', onclick: () => reassign() }, icon('route'), 'Reassign…')) : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, `Only Sales Ops / Admin can reassign (you are ${role}).`))),
      card(`Eligible reps for ${L.territory} × ${L.product_interest}`, [tbl, h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, 'Eligible = active SDR/AE in the territory. A rep that covers the product is preferred; otherwise the least-loaded territory rep takes it (overflow).')]));
  };

  const opportunity = ({ d, L, opp, can }) => {
    const o = d.opportunity;
    if (!o) {
      return card('No opportunity yet', h('div', { class: 'col' }, h('p', { class: 'muted', style: { margin: 0 } }, L.duplicate_of_lead_id ? `This lead is a merged duplicate of ${L.duplicate_of_lead_id}; duplicates cannot create their own opportunity.` : L.status === 'Disqualified' ? `The lead is disqualified (${L.status_reason || 'no reason'}), so it will not progress.` : 'Qualify the lead and convert it to create an opportunity. Conversion records the seats × price × discount and the initial stage history.'),
        can('convert') ? h('div', null, h('button', { class: 'btn primary', onclick: () => convertModal() }, icon('briefcase'), 'Convert to opportunity')) : null));
    }
    const hist = d.stage_history;
    // chain integrity (same test as the backend): every row's from_stage must equal the previous row's to_stage
    const gaps = []; const rowsOut = [];
    hist.forEach((s, i) => { const prev = i ? hist[i - 1].to_stage : ''; if ((s.from_stage || '') !== prev) { gaps.push({ from: prev || '(start)', to: s.from_stage || '(start)', id: s.stage_history_id }); rowsOut.push({ ghost: true, from: prev, to: s.from_stage }); } rowsOut.push(s); });
    const reached = new Set(hist.map((s) => s.to_stage));
    const maxIdx = o.status === 'won' ? 3 : Math.max(-1, ...OPEN_STAGES.map((s, i) => (reached.has(s) ? i : -1)));
    const nodes = OPEN_STAGES.map((s, i) => ({ s, st: reached.has(s) ? (s === o.stage ? 'current' : 'done') : i < maxIdx ? 'missing' : 'pending' }));
    nodes.push({ s: o.status === 'lost' ? 'Closed Lost' : 'Closed Won', st: o.status === 'open' ? 'pending' : 'current', final: true, lost: o.status === 'lost' });
    const col = { done: 'var(--ok)', current: o.status === 'lost' ? 'var(--err)' : 'var(--accent)', missing: 'var(--err)', pending: 'var(--border-2)' };
    const stepper = h('div', { style: { display: 'flex', alignItems: 'flex-start', padding: '8px 4px', overflowX: 'auto' } }, nodes.flatMap((n, i) => {
      const dot = h('div', { style: { width: '34px', height: '34px', borderRadius: '50%', display: 'grid', placeItems: 'center', border: `2px ${n.st === 'missing' ? 'dashed' : 'solid'} ${col[n.st]}`, color: col[n.st], background: n.st === 'done' || (n.st === 'current') ? `color-mix(in srgb, ${col[n.st]} 16%, var(--surface))` : 'var(--surface)', fontWeight: 700 } }, n.st === 'done' ? icon('check') : n.st === 'missing' ? icon('x') : n.final && n.lost ? icon('x') : i + 1);
      dot.querySelector('svg')?.setAttribute('style', 'width:16px;height:16px');
      const node = h('div', { style: { width: '104px', textAlign: 'center', flex: 'none' } }, h('div', { style: { display: 'grid', placeItems: 'center' } }, dot),
        h('div', { style: { fontSize: '12.5px', fontWeight: n.st === 'current' ? 700 : 560, marginTop: '6px', color: n.st === 'pending' ? 'var(--muted)' : 'var(--text)' } }, n.s),
        n.st === 'missing' ? h('div', { style: { marginTop: '3px' } }, tpill('MISSING step', 'err', 'alert', 'No StageHistory row records the transition into this stage')) : n.st === 'current' ? h('div', { class: 'muted', style: { fontSize: '11px' } }, o.status === 'open' ? 'current' : 'final') : null);
      const line = i < nodes.length - 1 ? h('div', { style: { flex: 1, minWidth: '24px', marginTop: '17px', height: '0', borderTop: `2px ${nodes[i + 1].st === 'missing' || n.st === 'missing' ? 'dashed' : 'solid'} ${n.st === 'done' && nodes[i + 1].st !== 'pending' ? 'var(--ok)' : nodes[i + 1].st === 'missing' || n.st === 'missing' ? 'var(--err)' : 'var(--border-2)'}` } }) : null;
      return [node, line];
    }));
    const seatsMath = h('div', { class: 'row wrap', style: { gap: '10px', fontSize: '15px' } }, h('b', null, fmt.int(o.seats)), h('span', { class: 'muted' }, 'seats ×'), h('b', null, fmt.money(o.unit_price_usd)), h('span', { class: 'muted' }, '× (1 −'), h('b', null, `${o.discount_pct}%`), h('span', { class: 'muted' }, ') ='), h('b', { style: { fontSize: '22px' } }, fmt.money(o.amount_usd)),
      Math.abs(o.seats * o.unit_price_usd * (100 - o.discount_pct) / 100 - o.amount_usd) < 0.01 ? tpill('maths checks out', 'ok', 'check') : tpill('amount differs from seats × price × discount', 'err', 'alert'));
    const nextOpts = o.status === 'open' ? ALL_STAGES.filter((s) => s !== o.stage) : [];
    const allowedNext = o.status === 'open' ? (OPEN_STAGES.indexOf(o.stage) < 3 ? [OPEN_STAGES[OPEN_STAGES.indexOf(o.stage) + 1]] : ['Closed Won']).concat('Closed Lost') : [];
    const toSel = h('select', null, nextOpts.map((s) => h('option', { value: s, selected: s === allowedNext[0] }, allowedNext.includes(s) ? `${s} (allowed)` : `${s} (skips a stage - will be blocked)`)));
    const reasons = h('select', null);
    const fillReasons = () => { const won = toSel.value === 'Closed Won'; const lost = toSel.value === 'Closed Lost'; reasons.replaceChildren(...(won ? (opp?.won_reasons || ['Product fit']) : lost ? (opp?.lost_reasons || ['No decision']) : []).map((x) => h('option', { value: x }, x))); reasons.disabled = !(won || lost); reasons.parentElement && (reasons.parentElement.style.opacity = won || lost ? 1 : 0.5); };
    toSel.onchange = fillReasons;
    const slot = h('div');
    const adv = o.status === 'open' && can('advance') ? h('div', { class: 'col' },
      h('div', { class: 'row wrap', style: { gap: '10px', alignItems: 'flex-end' } }, field('Move to stage', toSel), field('Reason (needed to close)', reasons),
        h('button', { class: 'btn primary', onclick: async () => { const r = await post(`/api/opportunities/${o.opportunity_id}/advance`, { to_stage: toSel.value, reason: reasons.disabled ? undefined : reasons.value }, (x) => `${o.opportunity_id} → ${x.stage}`, slot); if (r.ok) reload(); } }, icon('arrow'), 'Advance')), slot,
      h('p', { class: 'muted', style: { fontSize: '12px', margin: 0 } }, 'Stage-gap rule: an opportunity may only move to the next stage (or to Closed Lost). Skips are refused with 422 so StageHistory can never develop a hole.')) : o.status !== 'open' ? callout('info', `Closed (${o.status}): ${o.won_lost_reason || 'no reason recorded'}. Closed opportunities cannot move.`) : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, `The ${role} persona cannot advance opportunities.`);
    fillReasons();
    const histTable = h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['History id', 'From', 'To', 'When', 'By', 'Reason'].map((x) => h('th', null, x)))),
      h('tbody', null, rowsOut.map((s) => { if (s.ghost) { const tr = h('tr', null, h('td', { colspan: 6 }, h('span', { class: 'row', style: { gap: '8px' } }, tpill('MISSING ROW', 'err', 'alert'), h('span', { class: 't2' }, `no record of the transition ${s.from || '(start)'} → ${s.to || '(start)'}; the chain is broken here`)))); tint(tr, 'err'); return tr; }
        return h('tr', null, h('td', { class: 'mono', style: { fontSize: '11.5px' } }, s.stage_history_id), h('td', null, s.from_stage || '∅'), h('td', null, h('b', null, s.to_stage)), h('td', { class: 'nowrap muted' }, fmt.ts(s.changed_ts)), h('td', null, s.changed_by_rep_id || '—'), h('td', null, s.reason || '—')); }))));
    return h('div', { class: 'col' },
      gaps.length ? callout('err', h('b', null, 'Stage history has a gap. '), gaps.map((g) => `After "${g.from}" the next recorded row starts from "${g.to}" (${g.id}) - the intermediate transition was never written. `), 'Rule: every stage change must be a StageHistory row whose from_stage equals the previous row\'s to_stage. Without it, cycle-time and stage-conversion metrics are wrong.') : callout('ok', h('b', null, 'Stage history is complete. '), 'Each transition chains from the previous row.'),
      h('div', { class: 'grid g-21' },
        card(`Opportunity ${o.opportunity_id}`, h('div', { class: 'col' },
          h('div', { class: 'row wrap', style: { gap: '8px' } }, oppLink(o.opportunity_id), tpill(o.stage, o.status === 'won' ? 'ok' : o.status === 'lost' ? 'err' : 'info'), statusPill(o.status), pill(`${o.probability_pct}% probability`, 'muted'), h('a', { href: `#/pipeline/${o.opportunity_id}`, class: 'muted', style: { fontSize: '12px' } }, 'open in pipeline →')),
          seatsMath, stepper, adv)),
        card('Deal facts', kv({ Product: o.product_line, Owner: o.owner_rep_id, Created: fmt.ts(o.created_ts), 'Expected close': fmt.date(o.expected_close_date), Closed: o.closed_ts ? fmt.ts(o.closed_ts) : '—', 'Won / lost reason': o.won_lost_reason || '—', 'Weighted value': fmt.money(o.amount_usd * o.probability_pct / 100) }))),
      card('Stage history', histTable, { sub: `${hist.length} recorded transitions${gaps.length ? ` · ${gaps.length} gap` : ''}` }));
  };

  const history = ({ d }) => {
    const sh = table({ columns: [{ label: 'History id', render: (x) => h('span', { class: 'mono nowrap', style: { fontSize: '11.5px' } }, x.lead_status_history_id) }, { label: 'Transition', render: (x) => h('span', { class: 'row', style: { gap: '6px' } }, x.from_status ? statusPill(x.from_status) : h('span', { class: 'muted' }, '∅'), icon('arrow'), statusPill(x.to_status)) },
      { label: 'When', render: (x) => h('span', { class: 'nowrap' }, fmt.ts(x.changed_ts)) }, { label: 'By', render: (x) => x.changed_by_rep_id || 'system' }, { label: 'Reason', render: (x) => x.reason || '—' }], rows: d.status_history });
    sh.querySelectorAll('td svg').forEach((s) => { s.style.cssText = 'width:14px;height:14px;color:var(--muted)'; });
    const touches = d.touches.length ? table({ columns: [{ label: 'Campaign', render: (x) => `${x.campaign_id} · ${x.campaign_name}` }, { label: 'Channel', render: (x) => x.channel }, { label: 'Touch', render: (x) => pill(fmt.title(x.touch_type), x.touch_type === 'first_touch' ? 'info' : 'muted') }, { label: 'When', render: (x) => fmt.ts(x.touch_ts) }], rows: d.touches }) : empty('No campaign touches recorded.');
    const dupBlock = (d.duplicate_of || d.duplicates.length || d.merged_contacts.length) ? h('div', { class: 'col' },
      d.duplicate_of ? callout('warn', h('b', null, 'This lead is a duplicate of '), leadLink(d.duplicate_of.lead_id), ` (${d.duplicate_of.status}, created ${fmt.date(d.duplicate_of.created_ts)}).`) : null,
      d.duplicates.length ? table({ columns: [{ label: 'Merged-in lead', render: (x) => leadLink(x.lead_id) }, { label: 'Created', render: (x) => fmt.ts(x.created_ts) }, { label: 'Status', render: (x) => statusPill(x.status) }, { label: 'Opportunity', render: (x) => oppLink(x.opportunity_id) }], rows: d.duplicates }) : null,
      d.merged_contacts.length ? table({ columns: [{ label: 'Merged contact', render: (x) => h('span', { class: 'mono' }, x.contact_id) }, { label: 'Name', render: (x) => `${x.first_name} ${x.last_name}` }, { label: 'E-mail', render: (x) => x.email }], rows: d.merged_contacts }) : null)
      : empty('No duplicates or merged contacts - this is a unique lead on a unique contact.');
    return h('div', { class: 'grid g2' },
      card('Lead status history', [sh, h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, 'Append-only. Allowed transitions: New → Working / Qualified / Disqualified / Stale · Working → Qualified / Disqualified / Stale · Qualified → Converted / Disqualified / Stale · Stale → Working / Disqualified. Converted and Disqualified are terminal.')], { sub: `${d.status_history.length} rows` }),
      h('div', { class: 'col' }, card('Duplicates & merges', dupBlock, { sub: 'de-duplication lineage' }), card('Campaign touches', touches)));
  };
  Object.assign(T, { overview, timeline, activities, tasks, consent, routing, opportunity, history });

  paint();
  return root;
}

async function fetchAll(id) {
  const lead360 = await api.get(`/api/leads/${id}`);
  let opp = null;
  if (lead360.opportunity) { try { opp = await api.get(`/api/opportunities/${lead360.opportunity.opportunity_id}`); } catch { /* optional */ } }
  return { lead360, lead: lead360, opp };
}

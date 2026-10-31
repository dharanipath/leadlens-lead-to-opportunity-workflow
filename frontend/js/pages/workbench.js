// Task Workbench: a rep's follow-up queue with SLA countdowns and the consent guard enforced at completion time.
import { h, api, ApiError, fmt, card, kpi, pageHead, icon, pill, bandPill, statusPill, leadLink, callout, chips, pager, mount, skeleton, empty, act, modal, toast } from '../lib.js';

const AS_OF_LABEL = '2026-10-22';
const TYPES = [['', 'All types'], ['first_response_call', 'First-response call'], ['follow_up_email', 'Follow-up e-mail'], ['demo_scheduling', 'Demo scheduling'], ['nurture_check', 'Nurture check'], ['re_engage', 'Re-engage'], ['duplicate_review', 'Duplicate review'], ['manual_routing', 'Manual routing']];
const PRIOS = [['', 'Any priority'], ['P1', 'P1 · Hot'], ['P2', 'P2 · Warm'], ['P3', 'P3 · Cold']];
const OUTCOMES = ['connected', 'no_answer', 'replied', 'meeting_booked', 'not_interested', 'resolved'];
const PAGE_SIZE = 12;
const WRITERS = ['agent', 'ops', 'admin'];
const LS_KEY = 'wb_rep';

// view state survives navigating away and back
const VIEW = { status: 'open', type: '', priority: '', sort: 'due', page: 1 };

const ls = { get() { try { return localStorage.getItem(LS_KEY); } catch { return null; } }, set(v) { try { localStorage.setItem(LS_KEY, v); } catch { /* ignore */ } } };
const typeLabel = (t) => (TYPES.find(([k]) => k === t) || [0, fmt.title(t)])[1];

/** consent badge derived from the lead's e-mail consent state and the task's channel (server re-checks at completion) */
function consentBadge(t) {
  if (!t.channel) return pill('no outreach · no consent check', 'muted', 'info');
  const ico = t.channel === 'phone' ? 'phone' : 'mail';
  if (t.consent_status === 'opted_out' && t.channel === 'email') { const p = pill('BLOCKED - opted out (e-mail)', 'err', 'lock'); p.title = 'Consent ledger says this contact opted out of e-mail. Completing the task will be refused and audited.'; return p; }
  if (t.consent_status === 'opted_out') { const p = pill('e-mail opted out - phone re-checked on completion', 'warn', 'phone'); p.title = 'The lead-level consent state tracks e-mail. Phone consent is verified against the ledger at the moment you complete the call; an all-channel opt-out will block it.'; return p; }
  const label = t.channel === 'phone' ? 'phone consent re-checked on completion' : (t.consent_status === 'implied' ? 'e-mail allowed (implied)' : 'e-mail allowed');
  const p = pill(label, t.channel === 'phone' ? 'info' : 'ok', ico); p.title = 'Latest applicable ledger event is opted_in; the API re-checks at the moment of completion.'; return p;
}

function slaBlock(t) {
  if (t.status === 'completed') return h('div', { class: 'row wrap', style: { gap: '8px', fontSize: '12.5px' } }, pill(t.sla_met ? 'SLA met' : 'SLA missed', t.sla_met ? 'ok' : 'err', t.sla_met ? 'check' : 'alert'), h('span', { class: 'muted' }, `completed ${fmt.ts(t.completed_ts)} · outcome ${fmt.title(t.outcome)} · due ${fmt.ts(t.due_ts)}`));
  if (t.status === 'cancelled' || t.status === 'suppressed') return h('div', { class: 'row wrap', style: { gap: '8px', fontSize: '12.5px' } }, statusPill(t.status), h('span', { class: 'muted' }, `reason: ${fmt.title(t.cancel_reason || 'n/a')} · was due ${fmt.ts(t.due_ts)}`));
  const left = t.hours_to_due; const total = t.sla_hours || 1; const used = Math.max(0, Math.min(1, (total - left) / total));
  const late = left < 0; const kind = late ? 'err' : left <= total * 0.25 ? 'warn' : 'ok';
  const text = late ? `overdue by ${fmt.hours(-left)}` : `due in ${fmt.hours(left)}`;
  return h('div', { class: 'row wrap', style: { gap: '10px', fontSize: '12.5px' } }, pill(text, kind, 'clock'),
    h('div', { class: 'bar-inline', style: { width: '110px', height: '6px' }, title: `${Math.round(used * 100)}% of the ${total}h SLA window consumed (as-of ${AS_OF_LABEL})` }, h('i', { style: { width: `${used * 100}%`, background: `var(--${kind})` } })),
    h('span', { class: 'muted' }, `SLA ${total}h · due ${fmt.ts(t.due_ts)}`));
}

export default async function workbench({ role }) {
  const loadReps = async () => (await api.get('/api/reps')).filter((r) => r.role === 'SDR' || r.role === 'AE');
  let reps = await loadReps();
  const canWrite = WRITERS.includes(role);
  const byLoad = [...reps].sort((a, b) => b.open_tasks - a.open_tasks);
  let repId = ls.get(); if (!reps.some((r) => r.rep_id === repId)) repId = byLoad[0].rep_id;

  const kpis = h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' } }, skeleton(1, 96), skeleton(1, 96), skeleton(1, 96), skeleton(1, 96), skeleton(1, 96));
  const list = h('div', { class: 'col' }, skeleton(4, 110));
  const statusChips = h('div'); const typeChips = h('div'); const prioChips = h('div');
  let counts = {}; let seq = 0;

  const repSel = h('select', { style: { minWidth: '320px' }, onchange: (e) => { repId = e.target.value; ls.set(repId); VIEW.page = 1; refresh(true); } },
    reps.map((r) => h('option', { value: r.rep_id, selected: r.rep_id === repId }, `${r.rep_id} · ${r.rep_name} (${r.role} · ${r.territory}) - ${fmt.int(r.open_tasks)} open`)));

  async function loadCounts() {
    const d = await api.get('/api/tasks', { rep_id: repId, page_size: 1 }); counts = d.summary || {};
  }
  function paintChips() {
    const c = (k) => (counts[k] != null ? ` · ${fmt.int(counts[k])}` : ' · 0');
    mount(statusChips, chips([['open', 'Open' + c('open')], ['overdue', 'Overdue' + c('overdue')], ['completed', 'Completed' + c('completed')], ['suppressed', 'Suppressed' + c('suppressed')], ['cancelled', 'Cancelled' + c('cancelled')]], VIEW.status, (k) => { VIEW.status = k; VIEW.page = 1; load(); }));
    mount(typeChips, chips(TYPES, VIEW.type, (k) => { VIEW.type = k; VIEW.page = 1; load(); }));
    mount(prioChips, chips(PRIOS, VIEW.priority, (k) => { VIEW.priority = k; VIEW.page = 1; load(); }));
  }
  function paintKpis() {
    const r = reps.find((x) => x.rep_id === repId);
    mount(kpis,
      kpi({ label: 'Open tasks (incl. overdue)', value: r.open_tasks, sub: `${fmt.int(r.open_leads)} open leads owned`, ico: 'checkcircle' }),
      kpi({ label: 'Overdue', value: r.overdue_tasks, sub: r.open_tasks ? `${fmt.pct(r.overdue_tasks / r.open_tasks, 0)} of the open queue` : 'queue is clear', ico: 'clock', color: r.overdue_tasks ? 'var(--err)' : null }),
      kpi({ label: 'Completed', value: counts.completed || 0, sub: 'all time', ico: 'check' }),
      kpi({ label: 'SLA met (completed)', value: r.sla_pct == null ? 0 : r.sla_pct * 100, format: (v) => v.toFixed(1) + '%', sub: 'completed on or before due time', ico: 'target' }),
      kpi({ label: 'Win rate', value: r.win_rate == null ? 0 : r.win_rate * 100, format: (v) => v.toFixed(1) + '%', sub: `${r.won} won / ${r.lost} lost · ${fmt.moneyShort(r.won_amount)}`, ico: 'trend' }));
  }

  function showBlock(err, t) {
    modal({ title: 'Blocked by the consent rule', body: h('div', { class: 'col' },
      callout('err', h('b', null, `[${err.body.rule || 'rule'}] `), err.message),
      h('div', { class: 'kv' }, h('dt', null, 'Task'), h('dd', { class: 'mono' }, t.task_id), h('dt', null, 'Lead'), h('dd', null, leadLink(t.lead_id)), h('dt', null, 'Channel'), h('dd', null, err.body.channel || t.channel || '-'), h('dt', null, 'What happened'), h('dd', null, 'The task was cancelled (opted_out_before_completion) and the blocked attempt was written to the audit log. No outreach was recorded.')),
      h('p', { class: 'muted', style: { margin: 0, fontSize: '12.5px' } }, 'Consent is re-checked at the moment of completion, not just when the task was created - an opt-out that arrives in between always wins.')),
    actions: [{ label: 'Open lead', kind: 'primary', onClick: () => { location.hash = `#/lead/${t.lead_id}`; } }, { label: 'Close' }] });
  }

  async function complete(t, outcome) {
    let err = null;
    const r = await act(async () => { try { return await api.post(`/api/tasks/${t.task_id}/complete`, { outcome }); } catch (e) { err = e; throw e; } },
      (x) => `Task completed · SLA ${x.sla_met ? 'met' : 'missed'}${x.lead_status_change ? ` · lead ${x.lead_status_change}` : ''}`);
    if (!r && err instanceof ApiError && err.status === 409 && err.body.rule === 'consent_enforced') showBlock(err, t);
    await refresh(false);
  }

  function taskCard(t) {
    const outSel = h('select', { style: { width: '150px' } }, (t.channel === 'phone' ? ['connected', 'no_answer', 'meeting_booked', 'not_interested'] : t.channel === 'email' ? ['replied', 'no_answer', 'meeting_booked', 'not_interested'] : ['resolved', ...OUTCOMES.filter((o) => o !== 'resolved')]).map((o) => h('option', { value: o }, fmt.title(o))));
    const open = t.status === 'open' || t.status === 'overdue';
    const blocked = t.channel === 'email' && t.consent_status === 'opted_out';
    const actions = h('div', { class: 'col', style: { gap: '8px', alignItems: 'stretch', minWidth: '160px' } },
      open && canWrite ? [outSel, h('button', { class: `btn sm ${blocked ? 'danger' : 'primary'}`, title: blocked ? 'Will be refused by the consent guard - try it to see the rule fire' : 'Mark the follow-up done', onclick: (e) => { e.currentTarget.disabled = true; complete(t, outSel.value); } }, icon(blocked ? 'lock' : 'check'), blocked ? 'Try to complete' : 'Complete')] : null,
      h('a', { class: 'btn sm', href: `#/lead/${t.lead_id}` }, icon('arrow'), 'Open lead'));
    return h('div', { class: `taskcard ${t.priority}` }, h('div', { class: 'strip' }),
      h('div', { class: 'col', style: { gap: '8px', minWidth: 0 } },
        h('div', { class: 'row wrap', style: { gap: '8px' } }, h('b', { style: { fontSize: '14.5px' } }, typeLabel(t.task_type)), pill(t.priority, t.priority === 'P1' ? 'hot' : t.priority === 'P2' ? 'warm' : 'cold'), statusPill(t.status),
          t.channel ? h('span', { class: 'muted row nowrap', style: { gap: '4px', fontSize: '12px' } }, icon(t.channel === 'phone' ? 'phone' : 'mail'), t.channel === 'phone' ? 'call' : 'e-mail') : null, consentBadge(t)),
        h('div', { class: 'row wrap', style: { gap: '10px', fontSize: '13px' } }, leadLink(t.lead_id), h('span', null, h('b', null, t.contact_name), h('span', { class: 't2' }, ` · ${t.company_name}`)),
          h('span', { class: 'row', style: { gap: '6px' } }, h('b', null, t.score), bandPill(t.score_band)), h('span', { class: 'muted' }, t.product_interest), h('span', { class: 'muted' }, 'lead ' + t.lead_status)),
        slaBlock(t)),
      actions);
  }

  async function load() {
    const my = ++seq;
    mount(list, skeleton(4, 110));
    try {
      const d = await api.get('/api/tasks', { rep_id: repId, status: VIEW.status, type: VIEW.type, priority: VIEW.priority, sort: VIEW.sort, page: VIEW.page, page_size: PAGE_SIZE });
      if (my !== seq) return;
      mount(list,
        h('div', { class: 'row', style: { fontSize: '12.5px' } }, h('span', { class: 'muted' }, `${fmt.int(d.total)} task${d.total === 1 ? '' : 's'} · ordered by ${VIEW.sort === 'priority' ? 'priority, then due time' : 'due time (earliest first)'}`), h('div', { class: 'grow' }),
          h('span', { class: 'muted' }, 'Sort'), chips([['due', 'Due'], ['priority', 'Priority']], VIEW.sort, (k) => { VIEW.sort = k; VIEW.page = 1; load(); })),
        ...(d.rows.length ? d.rows.map(taskCard) : [empty('No tasks match this view. Pick another status or clear the type / priority filters.')]),
        d.total > PAGE_SIZE ? pager({ page: d.page, total: d.total, size: PAGE_SIZE, onPage: (p) => { VIEW.page = p; load(); } }) : null);
    } catch (e) { if (my === seq) mount(list, callout('err', h('b', null, 'Could not load tasks. '), String(e.message || e))); }
  }
  async function refresh(full) {
    if (full) { mount(kpis, skeleton(1, 96)); }
    reps = await loadReps(); await loadCounts(); paintChips(); paintKpis(); await load();
  }

  // ------------------------------------------------------------------ side panel
  const sla = card('SLA & consent rules', h('div', { class: 'col', style: { gap: '10px' } },
    h('div', { class: 'col', style: { gap: '6px', fontSize: '13px' } },
      h('div', { class: 'row' }, bandPill('Hot'), h('span', { class: 't2' }, 'call within '), h('b', null, '4 h'), h('span', { class: 'muted' }, ' · P1')),
      h('div', { class: 'row' }, bandPill('Warm'), h('span', { class: 't2' }, 'e-mail within '), h('b', null, '24 h'), h('span', { class: 'muted' }, ' · P2')),
      h('div', { class: 'row' }, bandPill('Cold'), h('span', { class: 't2' }, 'nurture within '), h('b', null, '72 h'), h('span', { class: 'muted' }, ' · P3'))),
    h('p', { class: 'muted', style: { margin: 0, fontSize: '12.5px' } }, `SLA met = completed_ts ≤ due_ts. Countdowns are measured from the dataset as-of date (${AS_OF_LABEL}), so tasks that were never worked are shown as overdue by the time elapsed since.`),
    callout('warn', h('b', null, 'Consent guard. '), 'Calls and e-mails need a valid opt-in on that channel at the moment you complete the task. If the contact opted out, the API answers 409, cancels the task and audits the attempt - no outreach is logged.'),
    h('p', { class: 'muted', style: { margin: 0, fontSize: '12.5px' } }, 'Completing a first outreach on a New lead moves it to Working; re-engaging a Stale lead moves it back to Working.')));

  const leadInput = h('input', { placeholder: 'LEAD-2026-000010', style: { width: '100%' } });
  const detail = h('input', { placeholder: 'What did the customer ask? (optional)', style: { width: '100%' } });
  const quick = card('Quick log · inbound support inquiry', canWrite ? h('div', { class: 'col' },
    h('p', { class: 'muted', style: { margin: 0, fontSize: '12.5px' } }, 'A support inquiry is an inbound signal: it needs no consent and it feeds the engagement score on the next rescore.'),
    h('label', { class: 'f' }, 'Lead id', leadInput), h('label', { class: 'f' }, 'Note', detail),
    h('button', { class: 'btn primary', onclick: async () => {
      const id = leadInput.value.trim().toUpperCase();
      if (!/^LEAD-\d{4}-\d{6}$/.test(id)) { toast('Enter a lead id like LEAD-2026-000010', 'warn'); return; }
      const r = await act(() => api.post(`/api/leads/${id}/activity`, { activity_type: 'support_inquiry', detail: detail.value.trim() || 'support inquiry (workbench quick log)' }), (x) => `Logged ${x.activity_id}`);
      if (r) { leadInput.value = ''; detail.value = ''; }
    } }, icon('plus'), 'Log support inquiry')) : callout('info', `The ${role} persona is read-only here. Switch to Support / Sales Agent to log activity.`));

  const head = pageHead('Task workbench', 'Work the follow-up queue the scoring and routing engines created for you: highest priority first, every task carrying its SLA clock and consent state.',
    h('label', { class: 'f', style: { flexDirection: 'row', alignItems: 'center', gap: '8px' } }, 'Working as rep', repSel));

  loadCounts().then(() => { if (!counts.open && counts.overdue && VIEW.status === 'open') VIEW.status = 'overdue'; refresh(true); });
  return h('div', null, head, kpis,
    h('div', { class: 'grid mt', style: { gridTemplateColumns: 'minmax(0, 1fr) 340px', alignItems: 'start' } },
      h('div', { class: 'col' },
        h('section', { class: 'card pad col', style: { gap: '10px' } },
          h('div', { class: 'row wrap', style: { alignItems: 'flex-start' } }, h('span', { class: 'muted', style: { width: '58px', fontSize: '12px', paddingTop: '8px' } }, 'Status'), statusChips),
          h('div', { class: 'row wrap', style: { alignItems: 'flex-start' } }, h('span', { class: 'muted', style: { width: '58px', fontSize: '12px', paddingTop: '8px' } }, 'Type'), typeChips),
          h('div', { class: 'row wrap', style: { alignItems: 'flex-start' } }, h('span', { class: 'muted', style: { width: '58px', fontSize: '12px', paddingTop: '8px' } }, 'Priority'), prioChips)),
        list),
      h('div', { class: 'col' }, sla, quick)));
}

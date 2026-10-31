import { h, api, fmt, card, kpi, pageHead, icon, pill, table, callout, leadLink, bandPill, statusPill, consentPill, act, debounce, hover, SEV } from '../lib.js';
import { lineChart, hbars, donut, legend, SERIES } from '../charts.js';

const REASONS = {
  no_consent_at_creation: ['Suppressed at creation', 'task needed a channel without valid consent → created as “suppressed”, no outreach'],
  opted_out_before_completion: ['Cancelled by later opt-out', 'open task cancelled the moment the contact opted out of its channel'],
};
const BASIS = { consent: ['Consent', 'var(--s1)'], legitimate_interest: ['Legitimate interest', 'var(--s3)'], contract: ['Contract', 'var(--s7)'] };
const SOURCE_LABEL = { email_unsubscribe: 'E-mail unsubscribe link', web_form: 'Web form', preference_center: 'Preference centre', support_request: 'Support request', sales_call: 'Sales call', list_import: 'List import' };
const ico = (n, sz = 16) => { const e = icon(n); e.style.cssText = `width:${sz}px;height:${sz}px;flex:none`; return e; };
const CAN_WRITE = ['prospect', 'ops', 'agent', 'admin'];

/** Latest applicable ledger event per channel: an event on the channel itself or on 'all' (append-only: the newest one wins). */
function governing(ledger, channel) {
  const ev = ledger.filter((e) => e.channel === channel || e.channel === 'all');
  return ev.length ? ev.slice().sort((a, b) => a.effective_ts.localeCompare(b.effective_ts)).at(-1) : null;
}

export default async function consent({ params, role }) {
  const d = await api.get('/api/consent');
  const hashQ = new URLSearchParams((location.hash.split('?')[1] || ''));
  const deepLink = (params && params[0] && /^CON-\d{6}$/.test(params[0]) ? params[0] : null) || hashQ.get('contact');
  const canWrite = CAN_WRITE.includes(role);
  const ls = d.lead_states, totalLeads = (ls.opted_in || 0) + (ls.implied || 0) + (ls.opted_out || 0);

  // ------------------------------------------------------------------------------------------------ KPIs
  const kpis = h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(5, minmax(0,1fr))' } },
    kpi({ label: 'Leads · opted in', value: ls.opted_in, sub: `${fmt.pct(ls.opted_in / totalLeads)} of leads · explicit consent`, ico: 'checkcircle', color: 'var(--ok)' }),
    kpi({ label: 'Leads · implied', value: ls.implied, sub: 'legitimate interest / contract basis', ico: 'info', color: 'var(--warn)' }),
    kpi({ label: 'Leads · opted out', value: ls.opted_out, sub: `${fmt.pct(ls.opted_out / totalLeads)} · outreach suppressed`, ico: 'lock', color: 'var(--err)' }),
    kpi({ label: 'Contacts opted out', value: d.contacts_opted_out, sub: 'at least one opt-out event in the ledger', ico: 'shield' }),
    (() => { const k = kpi({ label: 'Violations (labelled)', value: d.violations, sub: 'outbound contact after an opt-out · inspect', ico: 'alert', color: 'var(--err)' }); k.style.cursor = 'pointer'; k.onclick = () => { location.hash = '#/exceptions'; }; return k; })());

  // ------------------------------------------------------------------------------------------------ preference centre
  const result = h('div');
  const detail = h('div');
  const results = h('div', { class: 'col', style: { gap: '6px' } });
  const input = h('input', { type: 'search', placeholder: 'Search contact by name, e-mail or ID (e.g. CON-000480)…', style: { width: '100%' }, value: deepLink || '' });

  async function search(q) {
    if (!q || q.length < 2) { results.replaceChildren(); return; }
    results.replaceChildren(h('div', { class: 'skeleton', style: { height: '40px' } }));
    const { rows } = await api.get('/api/contacts/search', { q });
    results.replaceChildren(...(rows.length ? rows.map((r) => h('button', { class: 'btn ghost', style: { justifyContent: 'flex-start', textAlign: 'left', width: '100%', borderColor: 'var(--border)' }, onclick: () => { loadContact(r.contact_id); } },
      h('span', { class: 'mono' }, r.contact_id), h('b', null, r.name), h('span', { class: 'muted' }, `${r.company_name} · ${r.email}`), h('span', { class: 'grow' }), r.contact_status === 'merged' ? pill('merged duplicate', 'warn', 'copy') : null)) : [h('div', { class: 'muted' }, 'No contact matches.')]));
  }

  async function loadContact(id, silent) {
    results.replaceChildren();
    detail.replaceChildren(h('div', { class: 'skeleton', style: { height: '220px' } }));
    let c;
    try { c = await api.get(`/api/contacts/${id}`); } catch (e) { detail.replaceChildren(callout('err', String(e.message || e))); return; }
    const ct = c.contact, ledger = c.consents.slice().sort((a, b) => a.effective_ts.localeCompare(b.effective_ts));
    const gEmail = governing(ledger, 'email'), gPhone = governing(ledger, 'phone');
    const gov = new Set([gEmail?.consent_id, gPhone?.consent_id].filter(Boolean));

    const chan = (label, icn, ok, ev) => h('div', { class: 'card flat', style: { padding: '12px 14px', background: 'var(--surface-2)', flex: 1 } },
      h('div', { class: 'row', style: { gap: '8px', color: 'var(--text-2)', fontWeight: 600 } }, ico(icn), label),
      h('div', { style: { margin: '6px 0 4px' } }, ok ? pill('can contact', 'ok', 'check') : pill('do not contact', 'err', 'lock')),
      h('div', { class: 'muted', style: { fontSize: '11.5px' } }, ev ? `governed by ${ev.consent_id} · ${ev.status.replace('_', ' ')} on ${ev.channel} · ${fmt.date(ev.effective_ts)}` : 'no applicable event → no consent on file'));

    const act1 = (status, channel, kind) => h('button', { class: `btn sm ${kind || ''}`, disabled: !canWrite, onclick: async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      const r = await act(() => api.post('/api/consent', { contact_id: ct.contact_id, channel, status, source: 'preference_center' }), (x) => `Ledger event ${x.consent_id} appended`);
      if (r) {
        result.replaceChildren(callout(status === 'opted_out' ? 'warn' : 'ok', h('div', null, h('b', null, `${r.consent_id} appended `), `(${channel} → ${status.replace('_', ' ')}, effective ${fmt.ts(r.effective_ts)}). Nothing was overwritten — the ledger is append-only.`),
          h('div', { class: 'row wrap mt-s', style: { gap: '8px' } }, pill(`${r.tasks_cancelled.length} task(s) cancelled`, r.tasks_cancelled.length ? 'warn' : 'muted', 'x'), pill(`${r.leads_disqualified.length} lead(s) disqualified`, r.leads_disqualified.length ? 'err' : 'muted', 'lock'),
            ...r.leads_disqualified.map((l) => leadLink(l)), r.tasks_cancelled.length ? h('span', { class: 'mono muted', style: { fontSize: '11.5px' } }, r.tasks_cancelled.slice(0, 4).join(', ') + (r.tasks_cancelled.length > 4 ? '…' : '')) : null)));
        await loadContact(ct.contact_id, true);
      } else btn.disabled = false;
    } }, status === 'opted_out' ? icon('lock') : icon('check'), `${status === 'opted_out' ? 'Opt out of' : 'Opt in to'} ${channel === 'all' ? 'all channels' : channel}`);

    detail.replaceChildren(h('div', { class: 'grid g-21' },
      h('div', { class: 'col' },
        h('div', { class: 'row wrap', style: { gap: '10px' } }, h('h3', { style: { fontSize: '17px' } }, `${ct.first_name} ${ct.last_name}`), h('span', { class: 'mono muted' }, ct.contact_id),
          ct.contact_status === 'merged' ? pill('merged duplicate', 'warn', 'copy') : pill('active', 'ok')),
        h('div', { class: 'muted' }, `${ct.job_title} · ${ct.company_name} (${ct.region}) · ${ct.email}${ct.phone ? ' · ' + ct.phone : ''}`),
        ct.merged_into_contact_id ? callout('warn', 'This record was merged by de-duplication into ', h('a', { href: `#/consent/${ct.merged_into_contact_id}`, class: 'mono' }, ct.merged_into_contact_id), '. Consent must be honoured on every duplicate, so check both ledgers.') : null,
        h('div', { class: 'row', style: { gap: '12px', alignItems: 'stretch' } }, chan('E-mail', 'mail', c.can_contact.email, gEmail), chan('Phone', 'phone', c.can_contact.phone, gPhone)),
        h('div', { style: { fontWeight: 650, marginTop: '4px' } }, 'Preference centre'),
        canWrite ? null : callout('info', 'The Analyst persona is read-only. Switch to Prospect, Ops, Agent or Admin to change consent.'),
        h('div', { class: 'row wrap' }, act1('opted_out', 'email', 'danger'), act1('opted_out', 'phone', 'danger'), act1('opted_out', 'all', 'danger')),
        h('div', { class: 'row wrap' }, act1('opted_in', 'email'), act1('opted_in', 'phone'), act1('opted_in', 'all')),
        h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Opt-out cancels the contact’s open tasks on that channel; an all-channel (or e-mail) opt-out also flips every linked lead to opted-out, and an all-channel opt-out disqualifies open leads. Opt-in is just a newer event: the latest applicable one wins.'),
        result,
        h('div', { style: { fontWeight: 650, marginTop: '6px' } }, `Linked leads (${c.leads.length})`),
        table({ columns: [{ label: 'Lead', render: (r) => leadLink(r.lead_id) }, { label: 'Status', render: (r) => statusPill(r.status) }, { label: 'Band', render: (r) => bandPill(r.score_band) }, { label: 'Score', num: true, render: (r) => r.score }, { label: 'Product', render: (r) => r.product_interest }], rows: c.leads, empty: 'No leads for this contact.' })),
      h('div', null,
        h('div', { style: { fontWeight: 650, marginBottom: '8px' } }, `Consent ledger (${ledger.length} event${ledger.length === 1 ? '' : 's'})`),
        h('div', { class: 'timeline' }, ledger.slice().reverse().map((e) => h('div', { class: `tl-item k-consent_${e.status}` },
          h('div', { class: 'ts' }, fmt.ts(e.effective_ts), ' · ', e.consent_id),
          h('div', { class: 'tt row wrap', style: { gap: '6px' } }, e.status === 'opted_out' ? pill('opted out', 'err', 'lock') : pill('opted in', 'ok', 'check'), pill(e.channel, 'muted', e.channel === 'phone' ? 'phone' : e.channel === 'email' ? 'mail' : 'layers'), gov.has(e.consent_id) ? pill('governs now', 'info', 'zap') : null),
          h('div', { class: 'dd' }, `legal basis ${fmt.title(e.legal_basis)} · via ${SOURCE_LABEL[e.source] || e.source}`)))),
        h('div', { class: 'muted mt-s', style: { fontSize: '12px' } }, 'Rows are never edited or deleted — a change of mind is a new event. “Governs now” marks the newest applicable event for each channel (a channel-specific event or an all-channel one).'))));
    if (!silent) detail.scrollIntoView?.({ block: 'nearest' });
  }

  const doSearch = debounce((v) => search(v.trim()), 250);
  input.addEventListener('input', () => doSearch(input.value));
  const centre = card('Consent ledger lookup & preference centre', [
    h('div', { class: 'muted', style: { fontSize: '13px', marginBottom: '10px' } }, role === 'prospect' ? 'As a prospect you manage your own communication preferences here. Find your record, review the ledger, and opt out or in per channel.'
      : 'Look up any contact to see the full append-only consent history, what outreach is currently allowed, and record a change on their behalf (source: preference_center).'),
    h('div', { class: 'search', style: { width: '100%', maxWidth: 'none' } }, icon('search'), input), h('div', { class: 'mt-s' }, results), h('div', { class: 'mt-s' }, detail),
  ], { sub: 'POST /api/consent · roles: prospect, ops, agent, admin' });
  if (!deepLink) detail.append(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Try ', h('a', { href: '#/consent/CON-000480' }, 'CON-000480'), ' or type a name to begin.'));
  else { loadContact(deepLink); }

  // ------------------------------------------------------------------------------------------------ charts
  const mo = d.monthly, months = mo.map((m) => m.m.slice(2));
  const trend = card('Opt-in and opt-out events per month', [
    h('div', { class: 'muted', style: { fontSize: '12px', fontWeight: 600 } }, 'Opt-in events'),
    lineChart({ x: months, series: [{ name: 'Opt-in events', values: mo.map((m) => m.opt_in), color: 'var(--ok)', area: true }], height: 150 }),
    h('div', { class: 'muted', style: { fontSize: '12px', fontWeight: 600, marginTop: '8px' } }, 'Opt-out events'),
    lineChart({ x: months, series: [{ name: 'Opt-out events', values: mo.map((m) => m.opt_out), color: 'var(--err)', area: true }], height: 150 }),
    legend([['Opt-in', 'var(--ok)'], ['Opt-out', 'var(--err)']]),
    h('p', { class: 'muted', style: { fontSize: '12px', margin: '6px 0 0' } }, 'Two separate scales on purpose (no dual axis): opt-ins dwarf opt-outs, but the opt-out curve shows when outreach intensity triggered unsubscribes.'),
  ], { sub: 'ledger events by effective month' });

  const policy = card('Enforcement policy', h('div', { class: 'col', style: { gap: '10px' } }, d.policy.map((p) => h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '10px', fontSize: '13px' } }, h('span', { style: { color: 'var(--ok)', marginTop: '2px' } }, ico('shield')), h('span', { class: 't2' }, p)))), { sub: 'enforced in the API, not just displayed' });

  const src = card('Opt-out sources', hbars({ rows: d.optout_sources.map((s, i) => ({ label: SOURCE_LABEL[s.source] || s.source, value: s.n, color: SERIES[i] })), labelW: 140 }), { sub: 'where opt-outs are captured' });

  const basisTot = {}; d.bases.forEach((b) => { basisTot[b.b] = (basisTot[b.b] || 0) + b.n; });
  const basis = card('Legal basis of ledger events', [donut({ slices: Object.entries(basisTot).map(([k, v]) => ({ label: (BASIS[k] || [k])[0], value: v, color: (BASIS[k] || [])[1] })), size: 170, center: { value: fmt.short(Object.values(basisTot).reduce((a, b) => a + b, 0)), label: 'events' } }),
    h('p', { class: 'muted', style: { fontSize: '12px', margin: '6px 0 0' } }, 'Every opt-out carries the basis “consent” (checked by validation V160). Implied basis (legitimate interest, contract) never overrides a later opt-out.')], { sub: 'GDPR-style lawful basis' });

  const supTot = d.suppressed.reduce((a, b) => a + b.n, 0);
  const sup = card('Tasks suppressed or cancelled', [hbars({ rows: d.suppressed.map((s, i) => ({ label: (REASONS[s.r] || [s.r])[0], value: s.n, color: SERIES[i + 1], tip: `<b>${(REASONS[s.r] || [s.r])[0]}</b><br>${fmt.int(s.n)} tasks<br><span class="k">${(REASONS[s.r] || [])[1] || ''}</span>` })), labelW: 160 }),
    h('div', { class: 'col mt-s', style: { gap: '4px', fontSize: '12px' } }, d.suppressed.map((s) => h('div', { class: 'muted' }, h('b', { class: 't2' }, (REASONS[s.r] || [s.r])[0] + ': '), (REASONS[s.r] || [])[1] || ''))),
    h('div', { class: 'mt-s' }, pill(`${fmt.int(supTot)} tasks never executed as outreach`, 'warn', 'shield'))], { sub: 'consent guard at creation and at completion' });

  const viol = card('Violations · opted-out contacted (labelled examples)', [
    callout('err', h('b', null, `${fmt.int(d.violations)} outbound e-mails/calls were logged after an opt-out. `), 'These are seeded, labelled defects: the detector finds exactly the labelled set (validation V158: observed = labelled, 0 unlabelled, 0 missed). The write path now blocks them — completing a call/e-mail task re-checks consent and returns 409. ', h('a', { href: '#/exceptions?type=opted_out_contacted' }, 'All exceptions →')),
    h('div', { class: 'mt-s' }, table({ columns: [
      { label: 'Lead', render: (r) => leadLink(r.lead_id) }, { label: 'Activity', render: (r) => h('span', { class: 'mono muted' }, r.entity_id) }, { label: 'Severity', render: (r) => pill(r.severity, SEV[r.severity] || 'muted', 'alert') },
      { label: 'What happened', render: (r) => r.message }], rows: d.violation_examples, empty: 'No violations.' })),
  ], { sub: `first ${d.violation_examples.length} of ${fmt.int(d.violations)}` });

  return h('div', null,
    pageHead('Consent', 'An append-only consent ledger decides who may be contacted on which channel. Opt-outs suppress and cancel outreach immediately and are enforced where work is done, not only reported.',
      [h('a', { class: 'btn', href: '#/exceptions?type=opted_out_contacted' }, icon('alert'), 'Violations'), h('a', { class: 'btn', href: '#/audit' }, icon('history'), 'Audit trail')]),
    kpis, h('div', { class: 'mt' }, centre),
    h('div', { class: 'grid g-32 mt' }, trend, policy),
    h('div', { class: 'grid g3 mt' }, src, basis, sup),
    h('div', { class: 'mt' }, viol));
}

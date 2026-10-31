import { h, api, ApiError, fmt, card, kpi, pageHead, icon, pill, table, callout, leadLink, oppLink, statusPill, chips, hover } from '../lib.js';
import { donut, legend, SERIES } from '../charts.js';

const ico = (n, sz = 16) => { const e = icon(n); e.style.cssText = `width:${sz}px;height:${sz}px;flex:none`; return e; };
const FREE = ['freemail.example', 'webmail.example', 'inbox.example'];
const normEmail = (e) => { const x = (e || '').trim().toLowerCase(); if (!x.includes('@')) return x; const [l, d] = x.split('@'); return `${l.split('+')[0]}@${d}`; };
const normName = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
const markStyle = { background: 'color-mix(in srgb, var(--warn) 28%, transparent)', borderRadius: '3px', padding: '0 1px', fontWeight: 650, color: 'var(--text)' };

/** Highlights the differing middle of two strings (common prefix/suffix kept plain). Returns [nodeForA, nodeForB]. */
function diff(a, b) {
  a = a || ''; b = b || '';
  if (a === b) return [a, b];
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const part = (s) => [s.slice(0, i), s.slice(i, s.length - j) ? h('span', { style: markStyle }, s.slice(i, s.length - j)) : null, s.slice(s.length - j)];
  return [h('span', null, part(a)), h('span', null, part(b))];
}
const tierPill = (t) => (t === 1 ? pill('Tier 1 · e-mail', 'info', 'mail') : pill('Tier 2 · name + company', 'violet', 'users'));
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5 * 10) / 10;

function personCell(first, last, email, who, other) {
  const [f1] = diff(first, other.first), [l1] = diff(last, other.last), [e1] = diff(email, other.email);
  return h('div', { style: { lineHeight: 1.35 } }, h('div', null, f1, ' ', l1), h('div', { class: 'mono muted', style: { fontSize: '11.5px', wordBreak: 'break-all' } }, e1), who);
}

export default async function dedupe({ role }) {
  const canReview = ['analyst', 'admin', 'ops'].includes(role);
  const [d, review] = await Promise.all([api.get('/api/dedupe'), canReview ? api.get('/api/dedupe/review').catch(() => null) : Promise.resolve(null)]);
  const t1 = d.tier_counts['1'], t2 = d.tier_counts['2'];
  const bothConverted = d.lead_pairs.filter((p) => p.dup_opp && p.canon_opp).length;

  // ------------------------------------------------------------------------------------------------ KPIs
  const rc = review?.stats.duplicate_contact;
  const kpis = h('div', { class: 'grid g4' },
    kpi({ label: 'Contacts merged', value: d.contacts.merged, sub: `${fmt.int(d.contacts.active)} active canonical contacts remain`, ico: 'copy' }),
    kpi({ label: 'Tier 1 · normalised e-mail', value: t1, sub: `${fmt.pct(t1 / (t1 + t2), 0)} of contact merges · deterministic`, ico: 'mail' }),
    kpi({ label: 'Tier 2 · name + company', value: t2, sub: `${fmt.pct(t2 / (t1 + t2), 0)} of contact merges · fuzzy first name`, ico: 'users' }),
    kpi({ label: 'Leads merged', value: d.merged_leads, sub: rc ? `contact-match recall ${fmt.pct(rc.recall)} vs planted truth` : 'same contact + product within 30 days', ico: 'gitmerge' }));

  // ------------------------------------------------------------------------------------------------ rule cards
  const ruleMeta = {
    1: { title: 'Tier 1 · exact normalised e-mail', ico: 'mail', color: 'var(--s1)', ex: ['Jane.Doe+promo@Acme.com', 'jane.doe@acme.com'], n: t1, note: 'lower-case, trimmed, “+tag” stripped. Deterministic: no false positives from names.' },
    2: { title: 'Tier 2 · same company + last name + similar first name', ico: 'users', color: 'var(--s7)', ex: ['Jen Nguyen @ Halcyon', 'Jennifer Nguyen @ Halcyon'], n: t2, note: 'nickname table, initial match or string ratio ≥ 0.80. Catches different mailboxes for one person.' },
    lead: { title: 'Lead rule · same person + product within 30 days', ico: 'gitmerge', color: 'var(--s3)', ex: ['LEAD-B (Security, day 2)', '→ merged into LEAD-A (day 0)'], n: d.merged_leads, note: 'later lead becomes Disqualified: Duplicate and inherits the earlier lead’s owner, so no second rep chases the same buyer.' },
  };
  const rules = h('div', { class: 'grid g3' }, d.rules.map((r) => {
    const m = ruleMeta[r.tier];
    return h('div', { class: 'card', style: { padding: '16px 18px', borderTop: `3px solid ${m.color}` } },
      h('div', { class: 'row', style: { gap: '9px', marginBottom: '6px' } }, ico(m.ico, 18), h('h3', { style: { fontSize: '14px' } }, m.title), h('div', { class: 'grow' }), pill(fmt.int(m.n), 'muted')),
      h('div', { class: 't2', style: { fontSize: '13px' } }, r.rule),
      h('div', { class: 'code mt-s', style: { fontSize: '11.5px', padding: '8px 10px' } }, `${m.ex[0]}\n  ≡ ${m.ex[1]}`),
      h('div', { class: 'muted mt-s', style: { fontSize: '12px' } }, m.note));
  }));

  // ------------------------------------------------------------------------------------------------ contact pair table
  let tierFilter = 'all', showAll = false;
  const pairsBox = h('div');
  const renderPairs = () => {
    let rows = d.contact_pairs.filter((p) => tierFilter === 'all' || String(p.tier) === tierFilter);
    const total = rows.length; if (!showAll) rows = rows.slice(0, 12);
    pairsBox.replaceChildren(table({ columns: [
      { label: 'Tier / reason', render: (p) => h('div', { class: 'col', style: { gap: '4px' } }, tierPill(p.tier), h('span', { class: 'muted', style: { fontSize: '11.5px' } }, p.reason)) },
      { label: 'Duplicate (merged away)', render: (p) => personCell(p.dup_first, p.dup_last, p.dup_email, h('a', { class: 'mono', href: `#/consent/${p.dup_id}`, style: { fontSize: '11.5px' } }, p.dup_id), { first: p.canon_first, last: p.canon_last, email: p.canon_email }) },
      { label: '', render: () => h('span', { class: 'muted' }, icon('arrow', '')) },
      { label: 'Canonical (survivor)', render: (p) => personCell(p.canon_first, p.canon_last, p.canon_email, h('a', { class: 'mono', href: `#/consent/${p.canon_id}`, style: { fontSize: '11.5px' } }, p.canon_id), { first: p.dup_first, last: p.dup_last, email: p.dup_email }) },
      { label: 'Company', render: (p) => p.company_name },
      { label: 'E-mail after normalising', render: (p) => { const same = normEmail(p.dup_email) === normEmail(p.canon_email); return same ? h('div', null, pill('identical', 'ok', 'check'), h('div', { class: 'mono muted', style: { fontSize: '11px', wordBreak: 'break-all' } }, normEmail(p.dup_email))) : pill('differs → needs Tier 2', 'warn', 'alert'); } },
    ], rows, empty: 'No pairs.' }), total > 12 ? h('div', { class: 'row mt-s' }, h('button', { class: 'btn sm', onclick: () => { showAll = !showAll; renderPairs(); } }, showAll ? 'Show fewer' : `Show all ${total} sample pairs`), h('span', { class: 'muted', style: { fontSize: '12px' } }, `Sample of the first ${d.contact_pairs.length} of ${fmt.int(d.contacts.merged)} merged contacts`)) : null);
    pairsBox.querySelectorAll('svg').forEach((s) => { s.style.cssText = 'width:16px;height:16px'; });
  };
  renderPairs();
  const pairsCard = card('Contact merges · duplicate vs canonical', [
    h('div', { class: 'row wrap', style: { marginBottom: '10px' } }, chips([['all', 'All tiers'], ['1', 'Tier 1 · e-mail'], ['2', 'Tier 2 · name + company']], 'all', (k) => { tierFilter = k; showAll = false; renderPairs(); }),
      h('span', { class: 'grow' }), h('span', { class: 'muted', style: { fontSize: '12px' } }, h('span', { style: markStyle }, 'highlight'), ' = characters that differ between the two records')),
    pairsBox,
  ], { sub: 'the earliest-created record survives' });

  // ------------------------------------------------------------------------------------------------ lead pairs
  const leadCard = card('Lead merges · duplicate → canonical', [
    callout(bothConverted ? 'warn' : 'info', h('b', null, 'Merged ≠ safe by itself. '), 'A merged lead must never open its own opportunity. In the sample below ', h('b', null, `${bothConverted} pair(s)`), ' converted separately — both the duplicate and the canonical lead have an opportunity (a labelled ', h('a', { href: '#/exceptions?type=duplicate_opportunity' }, 'duplicate_opportunity'), ' exception).'),
    h('div', { class: 'mt-s' }, table({ columns: [
      { label: 'Duplicate lead', render: (p) => leadLink(p.dup_lead) }, { label: '', render: () => h('span', { class: 'muted' }, '→') }, { label: 'Canonical lead', render: (p) => leadLink(p.canon_lead) },
      { label: 'Product', render: (p) => p.product }, { label: 'Created (dup / canonical)', render: (p) => h('span', { class: 'mono', style: { fontSize: '11.5px' } }, `${fmt.date(p.dup_created)} / ${fmt.date(p.canon_created)}`) },
      { label: 'Gap', num: true, render: (p) => `${daysBetween(p.canon_created, p.dup_created)} d` },
      { label: 'Duplicate status', render: (p) => statusPill(p.dup_status) },
      { label: 'Opportunities', render: (p) => (p.dup_opp && p.canon_opp ? h('div', { class: 'col', style: { gap: '3px' } }, pill('converted separately', 'err', 'alert'), h('span', { class: 'row', style: { gap: '6px', fontSize: '11.5px' } }, oppLink(p.dup_opp), '·', oppLink(p.canon_opp)))
        : p.dup_opp || p.canon_opp ? h('span', { class: 'row', style: { gap: '6px' } }, oppLink(p.dup_opp || p.canon_opp), h('span', { class: 'muted' }, p.dup_opp ? '(duplicate only)' : '(canonical only)')) : h('span', { class: 'muted' }, 'none')) },
    ], rows: d.lead_pairs.slice(0, 15), empty: 'No lead merges.' })),
    h('div', { class: 'muted mt-s', style: { fontSize: '12px' } }, `First 15 of ${fmt.int(d.merged_leads)} merged leads (sample of ${d.lead_pairs.length} loaded).`),
  ], { sub: '30-day window · same canonical contact + product' });
  leadCard.querySelectorAll('.tablewrap svg').forEach((s) => { s.style.cssText = 'width:14px;height:14px'; });

  // ------------------------------------------------------------------------------------------------ analyst panel
  let analyst;
  if (review) {
    const st = review.stats;
    const stat = (label, s) => h('div', { class: 'card flat', style: { padding: '14px 16px', background: 'var(--surface-2)' } },
      h('div', { class: 'muted', style: { fontSize: '12px', fontWeight: 600 } }, label),
      h('div', { class: 'row', style: { alignItems: 'baseline', gap: '10px', margin: '4px 0' } }, h('span', { style: { fontSize: '26px', fontWeight: 730 } }, fmt.pct(s.recall)), h('span', { class: 'muted' }, 'recall')),
      h('div', { class: 'bar-inline', style: { height: '8px' } }, h('i', { style: { width: `${s.recall * 100}%`, background: 'var(--ok)' } })),
      h('div', { class: 'row wrap mt-s', style: { gap: '6px' } }, pill(`${fmt.int(s.planted)} planted`, 'muted'), pill(`${fmt.int(s.detected)} detected`, 'ok', 'check'), pill(`${fmt.int(s.missed)} missed`, 'warn', 'alert')));
    analyst = card('Analyst view · planted vs detected (recall)', [
      h('div', { class: 'grid g2' }, stat('Duplicate contacts · rules vs ground truth', st.duplicate_contact), stat('Duplicate leads · rules vs ground truth', st.duplicate_lead)),
      callout('info', h('b', null, 'Precision vs recall is a deliberate trade-off. '), 'The generator planted duplicates in easy and hard variants and recorded them in a separate ground-truth file (never used to match). Our rules are tuned for ',
        h('b', null, 'precision'), ': merging two different people would wrongly pool their consent and ownership, which is worse than leaving a rare duplicate unmerged. The cost is the recall gap below — surfaced here for review, not hidden.'),
      h('div', { style: { fontWeight: 650, margin: '12px 0 8px' } }, `Missed on purpose · ${st.duplicate_contact.missed} planted contact duplicates no rule can see (first ${review.missed_examples.length})`),
      table({ columns: [
        { label: 'Planted duplicate', render: (m) => personCell(m.dup.first_name, m.dup.last_name, m.dup.email, h('a', { class: 'mono', href: `#/consent/${m.dup.contact_id}`, style: { fontSize: '11.5px' } }, m.dup.contact_id), { first: m.canonical.first_name, last: m.canonical.last_name, email: m.canonical.email }) },
        { label: 'Canonical contact', render: (m) => personCell(m.canonical.first_name, m.canonical.last_name, m.canonical.email, h('a', { class: 'mono', href: `#/consent/${m.canonical.contact_id}`, style: { fontSize: '11.5px' } }, m.canonical.contact_id), { first: m.dup.first_name, last: m.dup.last_name, email: m.dup.email }) },
        { label: 'Variant', render: (m) => pill((/variant=(\w+)/.exec(m.detail) || [])[1] || 'hard', 'warn') },
        { label: 'Why the rules miss it', render: (m) => { const a = normName(m.dup.last_name), b = normName(m.canonical.last_name); return h('span', { class: 't2', style: { fontSize: '12.5px' } }, a !== b ? `normalised last names differ (“${a}” ≠ “${b}”) and the mailbox differs, so neither tier fires` : 'no tier fires'); } },
      ], rows: review.missed_examples.slice(0, 8), empty: 'No misses.' }),
      h('div', { class: 'muted mt-s', style: { fontSize: '12px' } }, 'Typical hard case: a hyphenated or changed surname plus a new mailbox. Relaxing Tier 2 to catch these would also merge genuine namesakes at the same company.'),
    ], { sub: 'reads the separate ground-truth DB — evaluation only, never used for matching' });
  } else {
    analyst = card('Analyst view · planted vs detected (recall)', callout('info', h('b', null, 'Not available for this persona. '), 'Recall against the labelled ground truth is shown to Analyst, Ops and Admin. Ground truth is kept in a separate database so it can never influence matching.'));
  }

  // ------------------------------------------------------------------------------------------------ matcher widget
  const canTry = ['prospect', 'ops', 'admin'].includes(role);
  const f = { first_name: h('input', { value: '' }), last_name: h('input', { value: '' }), email: h('input', { value: '', style: { width: '100%' } }), company_name: h('input', { value: '' }) };
  const prod = h('select', null, ['Analytics', 'Security', 'Automation', 'Collaboration'].map((p) => h('option', { value: p }, p)));
  const region = h('select', null, ['NA-East', 'NA-West', 'EMEA', 'APAC', 'LATAM', 'Other'].map((p) => h('option', { value: p, selected: p === 'EMEA' }, p)));
  const out = h('div', { class: 'mt' });
  const usable = d.contact_pairs.filter((p) => !FREE.includes((p.dup_email.split('@')[1] || '').toLowerCase()));
  const fill = (rec) => { f.first_name.value = rec.first; f.last_name.value = rec.last; f.email.value = rec.email; f.company_name.value = rec.company; };
  const pairSel = h('select', { style: { maxWidth: '100%' }, onchange: (e) => { const [i, side] = e.target.value.split('|'); if (i === '') return; const p = usable[+i]; fill(side === 'dup' ? { first: p.dup_first, last: p.dup_last, email: p.dup_email, company: p.company_name } : { first: p.canon_first, last: p.canon_last, email: p.canon_email, company: p.company_name }); } },
    h('option', { value: '' }, 'Load an existing contact from a merged pair…'),
    usable.slice(0, 24).flatMap((p, i) => [h('option', { value: `${i}|dup` }, `T${p.tier} · duplicate ${p.dup_id} · ${p.dup_first} ${p.dup_last} <${p.dup_email}>`), h('option', { value: `${i}|canon` }, `T${p.tier} · canonical ${p.canon_id} · ${p.canon_first} ${p.canon_last} <${p.canon_email}>`)]));
  if (usable.length) { const p = usable.find((x) => x.tier === 2) || usable[0]; fill({ first: p.dup_first, last: p.dup_last, email: p.dup_email, company: p.company_name }); }
  const runBtn = h('button', { class: 'btn primary', disabled: !canTry, onclick: async () => {
    runBtn.disabled = true; out.replaceChildren(h('div', { class: 'skeleton', style: { height: '90px' } }));
    try {
      const r = await api.post('/api/leads/intake', { first_name: f.first_name.value, last_name: f.last_name.value, email: f.email.value, company_name: f.company_name.value, region: region.value, product_interest: prod.value, consent_email: true }, { dry_run: 1 });
      const steps = r.trace.filter((s) => ['company', 'contact', 'dedupe'].includes(s.key));
      out.replaceChildren(h('div', { class: 'col' },
        h('div', { class: 'row wrap' }, pill('dry run · rolled back', 'info', 'refresh'), h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Nothing was saved. This is the exact code path a real intake would take.'),
          r.exceptions.includes('duplicate_contact_matched') ? pill('duplicate contact matched', 'warn', 'copy') : pill('new contact would be created', 'ok', 'plus')),
        h('div', { class: 'steps' }, steps.map((s, i) => h('div', { class: `step ${s.status}`, style: { animationDelay: `${i * 120}ms` } }, h('div', { class: 'n' }, s.status === 'ok' ? icon('check') : icon('alert')),
          h('div', null, h('h4', null, s.title, ' ', h('span', { class: 'mono muted', style: { fontSize: '11px', fontWeight: 400 } }, s.key)), h('p', null, s.detail),
            s.data?.tier ? h('div', { class: 'mt-s' }, tierPill(s.data.tier)) : null)))),
        h('div', { class: 'muted', style: { fontSize: '12px' } }, `Result if submitted: ${r.contact_id} · lead ${r.status}${r.status_reason ? ' (' + r.status_reason + ')' : ''} · routed to ${r.rep_id} (${r.routing_method}).`)));
    } catch (e) {
      out.replaceChildren(callout(e instanceof ApiError && e.status < 500 ? 'warn' : 'err', h('b', null, e.status ? `HTTP ${e.status}: ` : ''), String(e.message || e)));
    }
    runBtn.disabled = !canTry;
  } }, ico('play', 15), 'Run matcher (dry run)');
  const lab = (t, el) => h('label', { class: 'f' }, t, el);
  const matcher = card('Try the matcher', [
    h('div', { class: 'muted', style: { fontSize: '13px', marginBottom: '10px' } }, 'Submit an existing person’s details as a brand-new web lead and see how de-duplication decides — via ', h('span', { class: 'mono' }, 'POST /api/leads/intake?dry_run=1'),
      ' (the transaction is rolled back). Edit the e-mail to “name+tag@…” for Tier 1, or change the first name to a nickname for Tier 2.'),
    canTry ? null : callout('info', h('b', null, 'Intake is limited to Prospect, Ops and Admin. '), 'Switch persona to try the matcher.'),
    h('div', { class: 'mt-s' }, pairSel),
    h('div', { class: 'formgrid mt-s' }, lab('First name', f.first_name), lab('Last name', f.last_name), h('div', { class: 'full' }, lab('E-mail', f.email)), lab('Company name', f.company_name), lab('Product interest', prod), lab('Region (used only for a new company)', region)),
    h('div', { class: 'row mt-s' }, runBtn, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Company is resolved by e-mail domain first, then contacts are compared inside it.')), out,
  ], { sub: 'live trace of the de-dup decision' });

  return h('div', null,
    pageHead('De-duplication', 'Contacts are matched by two deterministic tiers and leads by a 30-day same-product rule. Every merge keeps the earliest record, is traceable to a reason, and its recall against labelled truth is measured.',
      [h('a', { class: 'btn', href: '#/exceptions?type=duplicate_opportunity' }, icon('alert'), 'Duplicate opportunities'), h('a', { class: 'btn', href: '#/data' }, icon('db'), 'Data lineage')]),
    kpis, h('div', { class: 'mt' }, rules),
    h('div', { class: 'mt' }, pairsCard), h('div', { class: 'mt' }, leadCard), h('div', { class: 'mt' }, analyst), h('div', { class: 'mt' }, matcher));
}

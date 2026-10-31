import { h, api, fmt, card, pageHead, icon, pill, callout, act, toast, bandPill, leadLink, ApiError, clear, role as roleStore } from '../lib.js';
import { stackedBar, legend } from '../charts.js';

const PRESETS = {
  hot: { label: 'Hot enterprise buyer', f: { first_name: 'Maya', last_name: 'Fernandes', email: 'maya.fernandes@brightwave-fintech.example', job_title: 'Chief Technology Officer', seniority: 'C-level', company_name: 'Brightwave FinTech', industry: 'FinTech', employee_count: 2400, region: 'NA-East', product_interest: 'Security', consent_email: true, consent_phone: true, demo_request: true, trial_signup: true, pricing_views: 3, downloads: 2, email_clicks: 3, web_visits: 4 } },
  warm: { label: 'Warm mid-market', f: { first_name: 'Tomas', last_name: 'Eriksen', email: 'tomas.eriksen@nordlogix.example', job_title: 'Operations Manager', seniority: 'Manager', company_name: 'Nordlogix', industry: 'Logistics', employee_count: 320, region: 'EMEA', product_interest: 'Automation', consent_email: true, consent_phone: false, demo_request: false, trial_signup: false, pricing_views: 1, downloads: 1, email_clicks: 2, web_visits: 3 } },
  cold: { label: 'Cold — free e-mail browser', f: { first_name: 'Sam', last_name: 'Ortiz', email: 'sam.ortiz77@freemail.example', job_title: 'Software Engineer', seniority: 'IC', company_name: 'Self-employed', industry: 'Education', employee_count: 8, region: 'LATAM', product_interest: 'Collaboration', consent_email: true, consent_phone: false, demo_request: false, trial_signup: false, pricing_views: 0, downloads: 0, email_clicks: 0, web_visits: 1 } },
  optout: { label: 'No consent (opt-out)', f: { first_name: 'Priya', last_name: 'Raman', email: 'priya.raman@lumenhealth-group.example', job_title: 'VP Operations', seniority: 'VP', company_name: 'Lumen Health Group', industry: 'Healthcare', employee_count: 5200, region: 'APAC', product_interest: 'Analytics', consent_email: false, consent_phone: false, demo_request: true, trial_signup: false, pricing_views: 2, downloads: 1, email_clicks: 0, web_visits: 3 } },
  other: { label: 'Region without coverage', f: { first_name: 'Einar', last_name: 'Sigurdsson', email: 'einar@fjordcloud.example', job_title: 'Director of IT', seniority: 'Director', company_name: 'Fjord Cloud', industry: 'Software', employee_count: 450, region: 'Other', country: 'Iceland', product_interest: 'Analytics', consent_email: true, consent_phone: true, demo_request: true, trial_signup: false, pricing_views: 2, downloads: 1, email_clicks: 1, web_visits: 2 } },
  lovelace: { label: 'LATAM · uncovered product', f: { first_name: 'Lucia', last_name: 'Mendes', email: 'lucia.mendes@andescompute.example', job_title: 'Director of Engineering', seniority: 'Director', company_name: 'Andes Compute', industry: 'Software', employee_count: 900, region: 'LATAM', product_interest: 'Collaboration', consent_email: true, consent_phone: true, demo_request: true, trial_signup: true, pricing_views: 2, downloads: 2, email_clicks: 2, web_visits: 3 } },
};
const STATUS_ICON = { ok: 'check', warn: 'alert', blocked: 'x' };
let last = null;

export default async function portal({ role }) {
  const camps = await api.get('/api/campaigns').catch(() => []);
  const allowed = ['prospect', 'ops', 'admin'].includes(role);
  const state = { ...PRESETS.hot.f };
  const form = h('form', { class: 'col', style: { gap: '14px' }, onsubmit: (e) => { e.preventDefault(); run(false); } });
  const out = h('div', { class: 'col' });
  const field = (label, key, type = 'text', opts) => h('label', { class: 'f' }, label, opts
    ? h('select', { onchange: (e) => { state[key] = e.target.value; } }, opts.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(state[key]) === String(v) }, l); }))
    : h('input', { type, value: state[key] ?? '', oninput: (e) => { state[key] = type === 'number' ? Number(e.target.value) : e.target.value; }, required: key === 'email' || key === 'first_name' || key === 'last_name' }));
  const toggle = (label, key, sub) => { const el = h('div', { class: `toggle ${state[key] ? 'on' : ''}`, onclick: () => { state[key] = !state[key]; el.classList.toggle('on', state[key]); chk.style.opacity = state[key] ? 1 : 0.2; } }, h('span', { style: { width: '16px', display: 'inline-block' } }), h('div', null, h('div', null, label), sub ? h('small', { class: 'muted' }, sub) : null)); const chk = icon('check'); chk.style.cssText = 'width:16px;height:16px;color:var(--accent);opacity:' + (state[key] ? 1 : 0.2); el.firstChild.append(chk); return el; };
  const slider = (label, key, max) => { const v = h('b', null, state[key] ?? 0); return h('label', { class: 'f' }, h('span', { class: 'row' }, label, h('span', { class: 'grow' }), v), h('input', { type: 'range', min: 0, max, value: state[key] ?? 0, oninput: (e) => { state[key] = Number(e.target.value); v.textContent = e.target.value; } })); };

  const render = () => {
    clear(form);
    form.append(
      h('div', { class: 'formgrid' }, field('First name', 'first_name'), field('Last name', 'last_name'), field('Work e-mail', 'email', 'email'), field('Job title', 'job_title'),
        field('Seniority', 'seniority', 'text', ['C-level', 'VP', 'Director', 'Manager', 'IC']), field('Company', 'company_name'),
        field('Industry', 'industry', 'text', ['Software', 'FinTech', 'Healthcare', 'Telecom', 'Manufacturing', 'Logistics', 'Energy', 'Media', 'Retail', 'Education']), field('Employees', 'employee_count', 'number'),
        field('Region (territory)', 'region', 'text', [['NA-East', 'NA-East'], ['NA-West', 'NA-West'], ['EMEA', 'EMEA'], ['APAC', 'APAC'], ['LATAM', 'LATAM'], ['Other', 'Other (no territory map)']]),
        field('Product of interest', 'product_interest', 'text', ['Analytics', 'Security', 'Automation', 'Collaboration']),
        h('div', { class: 'full' }, field('Campaign (source)', 'campaign_id', 'text', [['', 'Direct / Website (no campaign)'], ...camps.filter((c) => c.status !== 'planned').sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 12).map((c) => [c.campaign_id, `${c.campaign_name} — ${c.channel}`])]))),
      h('div', null, h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: '6px', fontWeight: 650 } }, 'Consent captured on the form'),
        h('div', { class: 'grid g2', style: { gap: '8px' } }, toggle('E-mail consent', 'consent_email', 'marketing & sales e-mail'), toggle('Phone consent', 'consent_phone', 'sales calls'))),
      h('div', null, h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.08em', margin: '2px 0 6px', fontWeight: 650 } }, 'Prospect behaviour (feeds INTENT & ENGAGEMENT scoring)'),
        h('div', { class: 'grid g2', style: { gap: '8px' } }, toggle('Requested a demo', 'demo_request'), toggle('Started a free trial', 'trial_signup'), toggle('Attended a webinar', 'webinar'), toggle('Asked pre-sales support', 'support')),
        h('div', { class: 'grid g2 mt-s', style: { gap: '10px 18px' } }, slider('Pricing-page views', 'pricing_views', 6), slider('Content downloads', 'downloads', 4), slider('E-mail clicks', 'email_clicks', 6), slider('Website visits', 'web_visits', 6))),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', type: 'button', onclick: () => run(true) }, icon('eye'), 'Preview decisions (dry run)'),
        h('button', { class: 'btn primary', type: 'submit' }, icon('zap'), 'Submit lead'),
        h('button', { class: 'btn ghost', type: 'button', disabled: !last, onclick: () => { Object.assign(state, last); render(); run(false); } }, icon('copy'), 'Submit same person again')));
  };

  const preset = (k) => { Object.keys(state).forEach((x) => delete state[x]); Object.assign(state, PRESETS[k].f); render(); toast(`Loaded preset “${PRESETS[k].label}”`, 'ok'); };

  async function run(dry) {
    const body = { ...state, signals: { demo_request: !!state.demo_request, trial_signup: !!state.trial_signup, webinar: !!state.webinar, support: !!state.support,
      pricing_views: state.pricing_views || 0, downloads: state.downloads || 0, email_clicks: state.email_clicks || 0, web_visits: state.web_visits || 0 } };
    if (!body.campaign_id) delete body.campaign_id;
    if (state.region !== 'Other') delete body.country;
    clear(out); out.append(h('div', { class: 'skeleton', style: { height: '90px' } }), h('div', { class: 'skeleton', style: { height: '90px' } }));
    try {
      const r = await api.post('/api/leads/intake', body, dry ? { dry_run: 1 } : undefined);
      if (!dry) last = { ...state };
      showTrace(r, dry);
      if (!dry) { toast(`Lead ${r.lead_id} created`, 'ok'); render(); }
    } catch (e) {
      clear(out); out.append(callout(e.status === 403 ? 'warn' : 'err', h('b', null, e.status === 403 ? 'RBAC: ' : 'Error: '), e.message, e.body?.required ? ` (allowed roles: ${e.body.required.join(', ')})` : ''));
    }
  }

  function showTrace(r, dry) {
    clear(out);
    const banner = h('div', { class: 'card glow pad', style: { display: 'flex', gap: '18px', alignItems: 'center', flexWrap: 'wrap' } },
      h('div', null, h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.08em' } }, dry ? 'Dry run — nothing persisted' : 'Lead created'), h('div', { style: { fontSize: '20px', fontWeight: 700 } }, dry ? 'Decision preview' : r.lead_id)),
      h('div', { style: { fontSize: '40px', fontWeight: 760, letterSpacing: '-.03em', color: r.band === 'Hot' ? 'var(--hot)' : r.band === 'Warm' ? 'var(--warm)' : 'var(--cold)' } }, r.score), bandPill(r.band),
      pill(r.status + (r.status_reason ? ` · ${r.status_reason}` : ''), r.status === 'New' ? 'info' : 'warn'),
      h('div', { class: 'grow' }), !dry ? h('a', { class: 'btn primary', href: `#/lead/${r.lead_id}` }, 'Open Lead 360', icon('arrow')) : null);
    out.append(banner);
    if (r.exceptions.length) out.append(callout('warn', h('b', null, 'Exception path taken: '), r.exceptions.map((x) => x.replace(/_/g, ' ')).join(' · ')));
    const steps = h('div', { class: 'steps' });
    r.trace.forEach((t, i) => {
      const body = h('div', null, h('h4', null, t.title), h('p', null, t.detail));
      if (t.key === 'score') {
        const dims = t.data.dimensions, col = { fit: 'var(--s1)', intent: 'var(--s2)', engagement: 'var(--s3)' };
        body.append(h('div', { style: { marginTop: '10px' } }, stackedBar({ segments: ['fit', 'intent', 'engagement'].map((d) => ({ label: `${d} (cap ${dims[d].cap})`, value: dims[d].points, color: col[d] })), total: 100 }),
          legend(['fit', 'intent', 'engagement'].map((d) => [`${d} ${dims[d].points}/${dims[d].cap}`, col[d]]))),
          h('div', { class: 'col mt-s', style: { gap: '3px' } }, t.data.breakdown.map((b) => h('div', { class: 'row', style: { fontSize: '12px' } }, h('span', { class: 'mono muted', style: { width: '74px' } }, b.rule_id), h('span', { class: 'grow t2' }, `${b.feature.replace('act:', '')} = ${typeof b.observed === 'boolean' ? (b.observed ? 'yes' : 'no') : b.observed}`),
            h('b', { style: { color: b.points < 0 ? 'var(--err)' : 'var(--text)' } }, (b.points > 0 ? '+' : '') + fmt.dec(b.points, 0) + (b.capped ? ' (cap)' : ''))))));
      }
      if (t.key === 'route' && t.data.eligible?.length) body.append(h('div', { class: 'row wrap mt-s', style: { gap: '6px' } }, t.data.eligible.map((id) => pill(`${id} · load ${t.data.loads[id] ?? 0}`, id === t.data.rep_id ? 'ok' : 'muted'))));
      if (t.key === 'tasks') body.append(h('div', { class: 'col mt-s', style: { gap: '4px' } }, t.data.tasks.map((k) => h('div', { class: 'row', style: { fontSize: '12px' } }, h('span', { class: 'mono muted' }, k.task_id), h('span', { class: 'grow t2' }, `${k.type.replace(/_/g, ' ')} → ${k.owner}`), pill(k.priority, k.priority === 'P1' ? 'hot' : k.priority === 'P2' ? 'warm' : 'cold'), h('span', { class: 'muted mono' }, `SLA ${k.sla_hours}h`), pill(k.status, k.status === 'suppressed' ? 'warn' : 'info')))));
      steps.append(h('div', { class: `step ${t.status}`, style: { animationDelay: `${i * 140}ms` } }, h('div', { class: 'n' }, t.status === 'ok' ? icon('check') : t.status === 'warn' ? icon('alert') : String(i + 1)), body));
    });
    out.append(steps);
    out.append(callout('info', h('b', null, 'Traceability: '), 'each step is persisted as explicit rows (Company/Contact, append-only Consent events, Lead + LeadStatusHistory, Activity, Task) and an audit entry — nothing is overwritten.'));
  }

  render();
  out.append(card('Decision trace', h('div', { class: 'empty' }, 'Submit or preview a lead to watch every decision: validation → consent → company/contact de-duplication → scoring → lead de-duplication → territory/product routing → follow-up tasks → audit.')));

  if (location.hash.includes('autorun')) setTimeout(() => run(true), 60);
  return h('div', null,
    pageHead('Prospect Portal', 'The customer-facing entry point of the workflow. Submit interest as a prospect and see — step by step — how the system captures consent, de-duplicates, scores, routes and creates SLA-bound follow-ups.',
      [pill(`acting as ${roleStore.get()}`, 'violet', 'user')]),
    !allowed ? callout('warn', h('b', null, 'Read-only persona. '), 'Intake is permitted for Prospect, Marketing/Sales Ops and Admin. Switch persona (top right) to submit leads.') : null,
    h('div', { class: 'row wrap', style: { margin: '14px 0' } }, h('span', { class: 'muted' }, 'Scenario presets:'), ...Object.entries(PRESETS).map(([k, p]) => h('span', { class: 'chip', onclick: () => preset(k) }, p.label))),
    h('div', { class: 'grid g-23' }, card('Lead capture form', form, { sub: 'POST /api/leads/intake' }), h('div', null, out)));
}

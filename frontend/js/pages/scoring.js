// Scoring Rules: transparent model explanation, versions, rule diagnostics and a what-if simulator (held-out evaluation).
import { h, api, ApiError, fmt, card, kpi, pageHead, icon, pill, table, modal, toast, act, callout, skeleton, empty, debounce } from '../lib.js';
import { xyChart, legend } from '../charts.js';

const DIMS = [
  ['fit', 'Fit', 40, 'var(--s1)', 'Who they are: industry, company size, buyer seniority, region and e-mail quality.'],
  ['intent', 'Intent', 35, 'var(--s2)', 'What they asked for: demo requests, pricing views, trials and bottom-funnel downloads.'],
  ['engagement', 'Engagement', 25, 'var(--s3)', 'How they interact: e-mail clicks and opens, webinars, visits, support questions, recency.'],
];
const TYPE_LABEL = { lookup: 'lookup', band: 'bands', per_count: 'per event', flag_count: 'flag (once)', flag: 'flag', threshold_gt: 'threshold' };
const ic = (n, s = 14) => { const e = icon(n); e.style.cssText = `width:${s}px;height:${s}px;flex:none`; return e; };
const sgn = (n, d = 0) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d);

export default async function page({ role }) {
  const [rulesResp, evalResp] = await Promise.all([
    api.get('/api/score-rules'),
    api.get('/api/evaluation').catch((e) => ({ _error: e })),
  ]);
  const activeV = (rulesResp.versions.find((v) => v.is_active) || rulesResp.versions[0]).version;
  const allRules = rulesResp.rules;
  const active = allRules.filter((r) => r.version === activeV);
  const scoring = active.filter((r) => !['dimension_cap', 'band_threshold'].includes(r.rule_type));
  const evalOk = evalResp && !evalResp._error;
  const canSim = ['ops', 'analyst', 'admin'].includes(role);

  // ------------------------------------------------------------------------------------------------ overview strip
  const hot = rulesResp.bands.hot, warm = rulesResp.bands.warm;
  const bandStrip = h('div', null,
    h('div', { style: { display: 'flex', height: '30px', borderRadius: '9px', overflow: 'hidden', gap: '2px' } },
      [['Cold', 0, warm - 1, 'var(--cold)'], ['Warm', warm, hot - 1, 'var(--warm)'], ['Hot', hot, 100, 'var(--hot)']].map(([n, a, b, c]) =>
        h('div', { style: { flex: `${b - a + 1} 1 0`, background: `color-mix(in srgb, ${c} 28%, var(--surface-3))`, borderTop: `3px solid ${c}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 650 } }, `${n} ${a}–${b}`))),
    h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } }, `Hot ≥ ${hot}: first call within 4 h · Warm ≥ ${warm}: follow-up e-mail within 24 h · Cold: nurture within 72 h.`));
  const formula = card('How a lead score is built', [
    h('div', { class: 'row wrap', style: { gap: '8px', fontSize: '14px', marginBottom: '14px' } },
      ...DIMS.flatMap(([k, label, cap, color], i) => [i ? h('span', { class: 'muted' }, '+') : null, h('span', { class: 'pill', style: { background: `color-mix(in srgb, ${color} 18%, transparent)`, color: 'var(--text)', borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, fontSize: '12.5px' } }, `min(${label}, ${cap})`)]),
      h('span', { class: 'muted' }, '='), h('span', { class: 'pill info', style: { fontSize: '12.5px' } }, 'score 0–100')),
    bandStrip,
    h('ul', { style: { margin: '14px 0 0 18px', padding: 0, color: 'var(--text-2)', fontSize: '13px', lineHeight: 1.65 } },
      h('li', null, h('b', null, 'Transparent: '), `every point comes from a ScoreRule row (${active.length} rules in version ${activeV}); the Lead 360 page lists the exact rules that fired.`),
      h('li', null, h('b', null, `${rulesResp.lookback_days}-day look-back: `), 'only activity in the 30 days before the scoring cut-off counts, so stale interest decays.'),
      h('li', null, h('b', null, 'Capped by dimension: '), 'a lead cannot buy a high score with one noisy signal; the caps guarantee the 40 / 35 / 25 balance.'))]);

  const contract = card('Anti-leakage contract', [
    h('div', { class: 'col', style: { gap: '10px' } },
      [['Inbound only', 'Only prospect-driven (inbound) activity feeds the score. Rep outreach is excluded, so the model cannot reward its own follow-up.', 'arrow'],
        ['Cut-off ordering', 'cutoff ≤ scored_ts ≤ converted_ts. A score may only see events up to the moment it was computed, and never beyond conversion.', 'clock'],
        ['Rescoring is clamped', 'Rescoring a converted lead clamps the cut-off to converted_ts and says so in the response (leakage guard).', 'shield'],
        ['Versioned & dated', 'Rule sets carry effective_from / effective_to. Each lead stores the score_version that produced its score, so history is never rewritten.', 'history']].map(([t, d, i]) =>
        h('div', { style: { display: 'grid', gridTemplateColumns: '28px 1fr', gap: '10px' } }, h('div', { style: { color: 'var(--accent)', paddingTop: '2px' } }, ic(i, 18)), h('div', null, h('b', { style: { fontSize: '13px' } }, t), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, d)))))]);

  // ------------------------------------------------------------------------------------------------ rule rendering
  function chip(text, strength, neg) {
    return h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center', padding: '2px 9px', borderRadius: '99px', fontSize: '12px', border: '1px solid var(--border)', background: `color-mix(in srgb, ${neg ? 'var(--err)' : 'var(--accent)'} ${Math.round(8 + 28 * strength)}%, var(--surface-2))`, whiteSpace: 'nowrap' } }, text);
  }
  function ruleDetail(r) {
    const p = r.params || {};
    if (r.rule_type === 'lookup') {
      const m = Object.entries(p.map).sort((a, b) => b[1] - a[1]), mx = Math.max(...m.map((x) => x[1]), 1);
      return h('div', { class: 'row wrap', style: { gap: '5px', marginTop: '6px' } }, m.map(([k, v]) => chip([k, h('b', null, `+${v}`)], v / mx)));
    }
    if (r.rule_type === 'band') {
      const b = p.bands, mx = Math.max(...b.map((x) => x[1]), 1);
      return h('div', { class: 'row wrap', style: { gap: '5px', marginTop: '6px' } }, b.map(([lo, pts], i) => chip([i === 0 ? `≥ ${fmt.int(lo)}` : `${fmt.int(lo)}–${fmt.int(b[i - 1][0] - 1)}`, h('b', null, `+${pts}`)], pts / mx)));
    }
    if (r.rule_type === 'per_count') return h('div', { style: { marginTop: '6px', fontSize: '12.5px' }, class: 't2' }, h('b', null, `+${p.per} pts each`), ` · cap ${r.max_points} (${Math.round(r.max_points / p.per)} events)`);
    if (r.rule_type === 'flag_count') return h('div', { style: { marginTop: '6px', fontSize: '12.5px' }, class: 't2' }, h('b', null, `+${p.points} pts`), ' once, if the event occurred at least once in the look-back');
    if (r.rule_type === 'flag') return h('div', { style: { marginTop: '6px', fontSize: '12.5px' }, class: 't2' }, h('b', { style: { color: p.points < 0 ? 'var(--err)' : 'inherit' } }, `${sgn(p.points)} pts`), ' when the flag is true');
    if (r.rule_type === 'threshold_gt') return h('div', { style: { marginTop: '6px', fontSize: '12.5px' }, class: 't2' }, h('b', { style: { color: p.points < 0 ? 'var(--err)' : 'inherit' } }, `${sgn(p.points)} pts`), ` when ${r.feature.replace(/_/g, ' ')} > ${p.threshold}`);
    return null;
  }
  const dimCard = ([k, label, cap, color, blurb]) => {
    const rs = scoring.filter((r) => r.dimension === k);
    const pot = rs.reduce((a, r) => a + Math.max(0, r.max_points), 0);
    return h('section', { class: 'card', style: { borderTop: `3px solid ${color}` } },
      h('div', { class: 'hd' }, h('h3', null, label), h('span', { class: 'sub' }, `≤ ${cap} pts`), h('div', { class: 'grow' }), pill(`${rs.length} rules`, 'muted')),
      h('div', { class: 'bd' }, h('p', { class: 'muted', style: { margin: '0 0 10px', fontSize: '12.5px' } }, blurb),
        h('div', { class: 'row', style: { fontSize: '12px', marginBottom: '12px', gap: '8px' } }, pill(`ceiling of rules: ${pot} pts`, 'muted'), pot > cap ? pill(`capped at ${cap}`, 'warn', 'shield') : pill(`= cap ${cap}`, 'ok', 'check')),
        h('div', { class: 'col', style: { gap: '14px' } }, rs.map((r) => {
          const neg = r.max_points === 0, pts = neg ? (r.params.points || 0) : r.max_points;
          return h('div', null,
            h('div', { class: 'row', style: { gap: '8px' } }, h('div', { style: { flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 580 } }, r.description), pill(TYPE_LABEL[r.rule_type] || r.rule_type, 'muted')),
            h('div', { class: 'row', style: { gap: '8px', marginTop: '5px' } },
              h('div', { class: 'bar-inline', style: { flex: 1, height: '7px' } }, h('i', { style: { width: `${Math.max(2, Math.min(100, Math.abs(pts) / cap * 100))}%`, background: neg ? 'var(--err)' : color } })),
              h('span', { style: { width: '62px', textAlign: 'right', fontWeight: 650, fontSize: '12.5px', fontVariantNumeric: 'tabular-nums', color: neg ? 'var(--err)' : 'var(--text)' } }, neg ? `${sgn(pts)} pts` : `up to ${pts}`)),
            h('div', { class: 'muted mono', style: { fontSize: '10.5px', marginTop: '3px' } }, `${r.rule_id} · feature ${r.feature}`), ruleDetail(r));
        }))));
  };

  const versions = card('Rule versions · history preserved', [
    table({ columns: [
      { label: 'Version', render: (v) => h('b', null, `v${v.version}`) }, { label: 'Status', render: (v) => (v.is_active ? pill('active', 'ok', 'check') : pill('retired', 'muted')) },
      { label: 'Effective from', render: (v) => h('span', { class: 'mono' }, fmt.date(v.effective_from)) }, { label: 'Effective to', render: (v) => (v.effective_to ? h('span', { class: 'mono' }, fmt.date(v.effective_to)) : h('span', { class: 'muted' }, 'open-ended')) },
      { label: 'Rules', num: true, render: (v) => v.rules }, { label: 'Leads scored', num: true, render: (v) => fmt.int(v.leads_scored) }], rows: rulesResp.versions }),
    h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, 'Publishing a new version closes the current one (effective_to = today) and inserts a full new rule set; nothing is edited in place. Existing leads keep the score_version they were scored with until they are re-scored, so every historical score stays reproducible and auditable.')],
    { sub: 'effective-dated, append-only' });

  // ------------------------------------------------------------------------------------------------ diagnostics
  function liftBar(l, cov) {
    if (l == null) return h('span', { class: 'muted', style: { fontSize: '12px' } }, cov === 0 ? 'never fires in train' : 'always on');
    const mx = 3, w = Math.min(1, l / mx) * 100;
    return h('div', { class: 'row', style: { gap: '8px' } }, h('div', { style: { position: 'relative', width: '110px', height: '8px', borderRadius: '6px', background: 'var(--surface-3)' } },
      h('div', { style: { width: w + '%', height: '100%', borderRadius: '6px', background: l >= 1 ? 'var(--s3)' : 'var(--s8)' } }), h('div', { style: { position: 'absolute', left: `${100 / mx}%`, top: '-3px', bottom: '-3px', width: '2px', background: 'var(--text-2)', opacity: 0.7 }, title: 'lift = 1.0× (no signal)' })),
    h('b', { style: { fontVariantNumeric: 'tabular-nums', width: '44px' } }, `${l.toFixed(2)}×`));
  }
  const diagCard = card('Rule diagnostics (TRAIN split)', evalOk ? [
    table({ columns: [
      { label: 'Rule', render: (r) => h('div', null, h('div', { style: { fontWeight: 560 } }, r.description), h('div', { class: 'muted mono', style: { fontSize: '10.5px' } }, r.rule_id)) },
      { label: 'Dimension', render: (r) => pill(r.dimension, 'muted') },
      { label: 'Coverage', render: (r) => h('div', { class: 'row', style: { gap: '8px' } }, h('div', { class: 'bar-inline', style: { width: '70px' } }, h('i', { style: { width: `${r.coverage * 100}%` } })), h('span', { style: { fontVariantNumeric: 'tabular-nums', fontSize: '12.5px' } }, fmt.pct(r.coverage, 0))) },
      { label: 'Converts when active', num: true, render: (r) => fmt.pct(r.rate_when_active) }, { label: 'When inactive', num: true, render: (r) => fmt.pct(r.rate_when_inactive) },
      { label: 'Lift', render: (r) => liftBar(r.lift, r.coverage) }], rows: evalResp.rule_diagnostics }),
    h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, 'Coverage = share of training leads where the rule fired (non-zero points). Lift = conversion when it fired ÷ conversion when it did not; the tick marks 1.0× (no signal). Rules that are always on (lookups) have no “inactive” group. Computed on the TRAIN split only, so the held-out test stays untouched.')]
    : callout('warn', h('b', null, 'Diagnostics need the analyst, ops or admin persona. '), evalResp?._error?.message || 'Not available.'), { sub: 'evidence each rule carries signal' });

  // ------------------------------------------------------------------------------------------------ what-if simulator
  const sim = { mult: Object.fromEntries(scoring.map((r) => [r.rule_id, 1])), caps: { fit: 40, intent: 35, engagement: 25 }, thr: { hot, warm } };
  const baseRoc = evalOk ? evalResp.metrics.test.roc : null;
  let seq = 0, lastSim = null, tuned = null;
  const controls = h('div'), results = h('div', null, skeleton(2, 120)), tuneBox = h('div');

  const dirty = () => Object.values(sim.mult).some((v) => Math.abs(v - 1) > 1e-9) || sim.caps.fit !== 40 || sim.caps.intent !== 35 || sim.caps.engagement !== 25 || sim.thr.hot !== hot || sim.thr.warm !== warm;
  const run = debounce(async () => {
    const my = ++seq;
    results.style.opacity = '.6';
    try {
      const out = await api.post('/api/evaluation/simulate', { multipliers: sim.mult, caps: sim.caps, thresholds: sim.thr });
      if (my !== seq) return;
      lastSim = out; paintResults(out); results.style.opacity = '1';
    } catch (e) {
      if (my !== seq) return;
      results.style.opacity = '1';
      results.replaceChildren(callout('err', e instanceof ApiError ? `${e.message}` : String(e)));
    }
  }, 280);

  function slider({ label, title, min, max, step, get, set, fmtVal, hint }) {
    const val = h('span', { class: 'mono', style: { width: '48px', textAlign: 'right', fontSize: '12px' } }, fmtVal(get()));
    const hintEl = h('span', { class: 'muted', style: { fontSize: '11px', width: '74px' } }, hint ? hint(get()) : '');
    const input = h('input', { type: 'range', min, max, step, value: get(), style: { flex: 1, minWidth: 0 }, oninput: (e) => { set(parseFloat(e.target.value)); val.textContent = fmtVal(get()); if (hint) hintEl.textContent = hint(get()); val.style.color = get() !== 1 && fmtVal === mulFmt ? 'var(--accent)' : ''; run(); } });
    if (fmtVal === mulFmt && get() !== 1) val.style.color = 'var(--accent)';
    return h('div', { class: 'row', style: { gap: '8px' }, title }, h('div', { class: 't2', style: { width: '138px', fontSize: '12px', lineHeight: 1.25, flex: 'none' } }, label), input, val, hintEl);
  }
  const mulFmt = (v) => `${Number(v).toFixed(2)}×`;
  const shortDesc = (r) => r.description.replace(/ - .*$/, '').replace(/\s*\(.*\)$/, '');

  function renderControls() {
    controls.replaceChildren(
      ...DIMS.map(([k, label, , color]) => h('div', { style: { marginBottom: '14px' } },
        h('div', { class: 'row', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 650, color: 'var(--muted)', marginBottom: '4px' } }, h('i', { style: { width: '9px', height: '9px', borderRadius: '3px', background: color, display: 'inline-block' } }), label, ' weights'),
        h('div', { class: 'col', style: { gap: '2px' } }, scoring.filter((r) => r.dimension === k).map((r) => slider({
          label: shortDesc(r), title: `${r.rule_id}: ${r.description}`, min: 0, max: 2, step: 0.05, get: () => sim.mult[r.rule_id], set: (v) => { sim.mult[r.rule_id] = v; }, fmtVal: mulFmt,
          hint: (m) => (r.max_points ? `max ${Math.round(r.max_points * m)}` : `${sgn(Math.round((r.params.points || 0) * m))} pts`) }))))),
      h('div', { style: { marginBottom: '14px' } }, h('div', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 650, color: 'var(--muted)', marginBottom: '4px' } }, 'Dimension caps'),
        h('div', { class: 'col', style: { gap: '2px' } }, DIMS.map(([k, label, cap]) => slider({ label: `${label} cap`, title: `Maximum points the ${label} dimension can contribute (default ${cap})`, min: 10, max: 60, step: 1, get: () => sim.caps[k], set: (v) => { sim.caps[k] = v; }, fmtVal: (v) => `${v} pts` })))),
      h('div', null, h('div', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 650, color: 'var(--muted)', marginBottom: '4px' } }, 'Band thresholds'),
        h('div', { class: 'col', style: { gap: '2px' } },
          slider({ label: 'Hot ≥', title: 'Score at or above this is Hot', min: 50, max: 95, step: 1, get: () => sim.thr.hot, set: (v) => { sim.thr.hot = v; if (sim.thr.warm >= v) { sim.thr.warm = v - 1; renderControls(); } }, fmtVal: (v) => String(v) }),
          slider({ label: 'Warm ≥', title: 'Score at or above this (and below Hot) is Warm', min: 10, max: 80, step: 1, get: () => sim.thr.warm, set: (v) => { sim.thr.warm = Math.min(v, sim.thr.hot - 1); }, fmtVal: (v) => String(v) }))));
  }

  const delta = (a, b, d = 4) => {
    const x = b - a;
    if (Math.abs(x) < 0.5 * Math.pow(10, -d)) return h('span', { class: 'muted', style: { fontSize: '12px' } }, '± 0');
    return h('span', { style: { fontSize: '12px', fontWeight: 650, color: x > 0 ? 'var(--ok)' : 'var(--err)' } }, `${x > 0 ? '▲' : '▼'} ${sgn(x, d)}`);
  };
  const metricTile = (label, a, b, trainA, trainB, d = 4) => h('div', { class: 'card flat', style: { padding: '12px 14px', background: 'var(--surface-2)' } },
    h('div', { class: 'muted', style: { fontSize: '11.5px', fontWeight: 600 } }, label),
    h('div', { class: 'row', style: { gap: '8px', marginTop: '4px', alignItems: 'baseline', flexWrap: 'wrap' } }, h('span', { class: 'muted', style: { fontVariantNumeric: 'tabular-nums' } }, a.toFixed(d)), h('span', { class: 'muted' }, '→'), h('b', { style: { fontSize: '22px', letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums' } }, b.toFixed(d)), delta(a, b, d)),
    h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } }, `train ${trainA.toFixed(d)} → ${trainB.toFixed(d)}`));

  function pairBars(rows, format, title) {
    const mx = Math.max(...rows.flatMap((r) => [r.a, r.b]), 0.0001);
    return h('div', null, h('div', { class: 'muted', style: { fontSize: '11.5px', fontWeight: 600, marginBottom: '8px' } }, title),
      h('div', { class: 'col', style: { gap: '10px' } }, rows.map((r) => {
        const bar = (v, c) => h('div', { class: 'row', style: { gap: '8px' } }, h('div', { style: { flex: 1, height: '8px', borderRadius: '6px', background: 'var(--surface-3)', overflow: 'hidden' } }, h('div', { class: 'mark', style: { width: `${Math.max(1, (v / mx) * 100)}%`, height: '100%', background: c, borderRadius: '6px', transition: 'width .4s' } })), h('span', { style: { width: '54px', textAlign: 'right', fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' } }, format(v)));
        const row = h('div', { style: { display: 'grid', gridTemplateColumns: '48px 1fr', gap: '8px', alignItems: 'center' } }, h('b', { style: { fontSize: '12.5px', color: r.color } }, r.label), h('div', { class: 'col', style: { gap: '3px' } }, bar(r.a, 'var(--muted)'), bar(r.b, 'var(--s1)')));
        return row;
      })));
  }

  function paintResults(out) {
    const b = out.baseline, s = out.scenario, tb = b.test, ts = s.test;
    const bands = ['Hot', 'Warm', 'Cold'], col = { Hot: 'var(--hot)', Warm: 'var(--warm)', Cold: 'var(--cold)' };
    const bb = (set, name) => set.bands.find((x) => x.band === name) || {};
    const moves = Object.entries(out.band_moves || {}).sort((x, y) => y[1] - x[1]);
    const same = !dirty();
    results.replaceChildren(
      h('div', { class: 'row wrap', style: { gap: '8px', marginBottom: '10px' } }, h('h3', { style: { fontSize: '14px' } }, 'Scenario vs baseline'), pill('held-out TEST split', 'info', 'shield'), h('span', { class: 'muted', style: { fontSize: '12px' } }, `${fmt.int(0 + (evalOk ? evalResp.population.test : 0))} leads · baseline = active rule set v${activeV}`)),
      same ? callout('info', 'Move any slider to see how the held-out metrics, bands and ROC curve react. Baseline and scenario are identical until you change something.') : null,
      h('div', { class: 'grid g3', style: { marginTop: same ? '10px' : 0 } },
        metricTile('ROC AUC', tb.auc, ts.auc, b.train.auc, s.train.auc), metricTile('Average precision', tb.avg_precision, ts.avg_precision, b.train.avg_precision, s.train.avg_precision), metricTile('KS statistic', tb.ks, ts.ks, b.train.ks, s.train.ks)),
      h('div', { class: 'grid g2 mt' },
        card('Band distribution & conversion', [
          pairBars(bands.map((n) => ({ label: n, color: col[n], a: bb(tb, n).share || 0, b: bb(ts, n).share || 0 })), (v) => fmt.pct(v, 1), 'Share of leads in each band'),
          h('div', { style: { height: '14px' } }),
          pairBars(bands.map((n) => ({ label: n, color: col[n], a: bb(tb, n).rate || 0, b: bb(ts, n).rate || 0 })), (v) => fmt.pct(v, 1), 'Conversion rate of each band'),
          legend([['Baseline', 'var(--muted)'], ['Scenario', 'var(--s1)']]),
          h('p', { class: 'muted', style: { fontSize: '12px', margin: '8px 0 0' } }, 'A good model keeps the ramp Hot > Warm > Cold. Lowering the Hot cut-off adds leads but dilutes Hot conversion.')], { flat: true }),
        card('Band migration (all matured leads)', moves.length ? [h('div', { class: 'col', style: { gap: '8px' } }, moves.map(([k, n]) => { const [from, to] = k.split('->'); return h('div', { class: 'row', style: { gap: '8px' } }, pill(from, from.toLowerCase()), ic('arrow'), pill(to, to.toLowerCase()), h('div', { class: 'grow' }), h('b', { style: { fontVariantNumeric: 'tabular-nums' } }, fmt.int(n)), h('span', { class: 'muted', style: { fontSize: '12px' } }, 'leads')); })),
          h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, 'Each lead whose band changes under the scenario would get a different SLA and task priority.')] : empty('No lead changes band'), { flat: true })),
      card('ROC curve · test split', [h('div', { style: { maxWidth: '520px', margin: 'auto' } }, xyChart({
        series: [...(baseRoc ? [{ name: 'Baseline', points: baseRoc, color: 'var(--muted)', dash: '5 4' }] : []), { name: 'Scenario', points: ts.roc, color: 'var(--s1)' }], xLabel: 'False-positive rate', yLabel: 'True-positive rate', height: 280 })),
      legend([['Baseline (active rules)', 'var(--muted)'], ['Scenario', 'var(--s1)'], ['Chance', 'var(--muted)']]), h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } }, `Scenario AUC ${ts.auc.toFixed(4)} vs baseline ${tb.auc.toFixed(4)} (${sgn(ts.auc - tb.auc, 4)}).`)], { cls: 'mt', flat: true }));
  }

  // tune ---------------------------------------------------------------------------------------------
  async function autoTune(btn) {
    btn.disabled = true;
    const spin = ic('refresh', 15); spin.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 900, iterations: Infinity });
    btn.replaceChildren(spin, 'Tuning on TRAIN split… (~5 s)');
    tuneBox.replaceChildren(skeleton(1, 90));
    try {
      tuned = await api.post('/api/evaluation/tune', {});
      paintTune();
    } catch (e) {
      tuneBox.replaceChildren(callout(e.status === 403 ? 'warn' : 'err', e.status === 403 ? 'Auto-tune is available to the analyst and admin personas.' : e.message));
    } finally { btn.disabled = false; btn.replaceChildren(icon('zap'), 'Auto-tune on TRAIN split'); }
  }
  function paintTune() {
    const t = tuned, gTrain = t.train_auc.after - t.train_auc.before, gTest = t.test_auc.after - t.test_auc.before;
    const changed = Object.entries(t.multipliers).filter(([, v]) => v !== 1);
    const side = (title, kind, a, b) => h('div', { class: 'card flat', style: { padding: '12px 14px', background: 'var(--surface-2)' } }, h('div', { class: 'row' }, h('span', { class: 'muted', style: { fontSize: '11.5px', fontWeight: 600 } }, title), h('div', { class: 'grow' }), pill(kind, kind === 'honest estimate' ? 'ok' : 'muted', kind === 'honest estimate' ? 'shield' : null)),
      h('div', { class: 'row', style: { gap: '8px', alignItems: 'baseline', marginTop: '4px' } }, h('span', { class: 'muted' }, a.toFixed(4)), h('span', { class: 'muted' }, '→'), h('b', { style: { fontSize: '22px' } }, b.toFixed(4)), delta(a, b)));
    tuneBox.replaceChildren(h('div', { class: 'card', style: { background: 'var(--surface-2)', borderColor: 'color-mix(in srgb, var(--accent) 40%, var(--border))' } }, h('div', { class: 'bd' },
      h('div', { class: 'row wrap', style: { marginBottom: '10px' } }, h('b', null, 'Auto-tune result'), pill('coordinate ascent, grid ' + t.grid.join(' / '), 'muted'), h('div', { class: 'grow' }),
        h('button', { class: 'btn primary sm', onclick: () => { Object.keys(sim.mult).forEach((k) => { sim.mult[k] = t.multipliers[k] ?? 1; }); renderControls(); run(); toast('Tuned multipliers applied to the sliders', 'ok'); } }, icon('sliders'), 'Apply to sliders')),
      h('div', { class: 'grid g2' }, side('TRAIN AUC (what the tuner optimised)', 'optimised on this', t.train_auc.before, t.train_auc.after), side('Held-out TEST AUC', 'honest estimate', t.test_auc.before, t.test_auc.after)),
      callout(gTest <= 0 ? 'warn' : 'info', h('div', null, h('b', null, 'Read this honestly. '), t.note,
        ` Train gain ${sgn(gTrain, 4)} vs test gain ${sgn(gTest, 4)}${gTrain > 0 ? ` — only ${Math.max(0, Math.round((gTest / gTrain) * 100))}% of the train improvement survives on unseen leads; the rest is fitting noise.` : '.'}`)),
      h('div', { class: 'row wrap', style: { marginTop: '10px', gap: '6px' } }, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Suggested multipliers:'), changed.length ? changed.map(([k, v]) => h('span', { class: 'pill muted mono', title: allRules.find((r) => r.rule_id === k)?.description }, `${k.replace('SR-V1-', '#')} ×${v}`)) : h('span', { class: 'muted', style: { fontSize: '12px' } }, 'none — the shipped weights are already at the optimum on train.')))));
  }

  // publish ------------------------------------------------------------------------------------------
  function publish() {
    const changed = Object.entries(sim.mult).filter(([, v]) => Math.abs(v - 1) > 1e-9);
    const note = h('textarea', { rows: 3, style: { width: '100%', resize: 'vertical' }, placeholder: 'Why are these weights changing? (stored in the audit trail)' });
    modal({ title: `Publish as rule set v${activeV + 1}`, body: h('div', { class: 'col' },
      callout('info', h('div', null, h('b', null, 'History is preserved. '), `Version ${activeV} is closed (effective_to = today) and a new full rule set v${activeV + 1} is inserted. Nothing is overwritten. Leads already scored keep their stored score_version until they are re-scored; new and re-scored leads use v${activeV + 1}. The evaluation snapshot on this page stays based on the seeded data.`)),
      changed.length ? h('div', { class: 'row wrap', style: { gap: '6px' } }, changed.map(([k, v]) => h('span', { class: 'pill muted mono', title: allRules.find((r) => r.rule_id === k)?.description }, `${k.replace('SR-V1-', '#')} ×${Number(v).toFixed(2)}`))) : callout('warn', 'All multipliers are 1.00× — publishing would create an identical new version.'),
      sim.caps.fit !== 40 || sim.caps.intent !== 35 || sim.caps.engagement !== 25 || sim.thr.hot !== hot || sim.thr.warm !== warm ? callout('warn', 'Caps and band thresholds are simulation-only here; the publish endpoint applies the rule multipliers.') : null, h('label', { class: 'f' }, 'Change note', note)),
    actions: [{ label: 'Cancel', close: true }, { label: `Publish v${activeV + 1}`, kind: 'primary', close: false, onClick: async (e, close) => {
      const r = await act(() => api.post('/api/score-rules/publish', { multipliers: sim.mult, note: note.value || null }), (x) => `Published rule set v${x.version} (v${x.previous} closed, history preserved)`);
      if (r) { close(); window.dispatchEvent(new HashChangeEvent('hashchange')); }
      return false;
    } }] });
  }

  const tuneBtn = h('button', { class: 'btn', onclick: (e) => autoTune(e.currentTarget) }, icon('zap'), 'Auto-tune on TRAIN split');
  const simulator = canSim ? h('div', null,
    h('div', { class: 'row wrap', style: { margin: '28px 0 12px' } }, h('div', null, h('h3', { style: { fontSize: '17px' } }, 'What-if simulator'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Re-score the matured, held-out population with different weights and see the consequence before anything is published. Labels come from the separate ground-truth store and are only used to grade.')),
      h('div', { class: 'grow' }), h('button', { class: 'btn', onclick: () => { Object.keys(sim.mult).forEach((k) => { sim.mult[k] = 1; }); sim.caps = { fit: 40, intent: 35, engagement: 25 }; sim.thr = { hot, warm }; renderControls(); run(); } }, icon('refresh'), 'Reset'),
      tuneBtn, h('button', { class: 'btn primary', disabled: role !== 'admin', title: role === 'admin' ? 'Publish the current multipliers as a new rule version' : 'Only the admin persona can publish rule versions', onclick: publish }, icon('layers'), 'Publish as new version')),
    role !== 'admin' ? h('div', { class: 'muted', style: { fontSize: '12px', margin: '-4px 0 10px', textAlign: 'right' } }, 'Publishing a rule version is restricted to the admin persona (RBAC).') : null,
    tuneBox,
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(340px, 5fr) minmax(0, 7fr)', gap: '16px', alignItems: 'start' }, class: 'sim-grid mt' },
      card('Levers', [h('p', { class: 'muted', style: { fontSize: '12px', margin: '0 0 12px' } }, 'Multipliers scale each rule’s points (0× switches a rule off, 2× doubles it). Final points are re-clamped by the dimension caps.'), controls], { flat: false }), results))
    : callout('info', 'The what-if simulator is available to the ops, analyst and admin personas.');

  renderControls();
  if (canSim) setTimeout(run, 0);

  return h('div', null,
    pageHead('Scoring rules', 'Lead score = Fit (≤ 40) + Intent (≤ 35) + Engagement (≤ 25), computed only from visible, versioned rules. Inspect them, test them against held-out outcomes, and change them safely.',
      [h('a', { class: 'btn', href: '#/evaluation' }, icon('chart'), 'Held-out evaluation')]),
    h('div', { class: 'grid g-32' }, formula, contract),
    h('div', { class: 'grid g3 mt' }, DIMS.map(dimCard)),
    h('div', { class: 'mt' }, versions), h('div', { class: 'mt' }, diagCard), simulator);
}

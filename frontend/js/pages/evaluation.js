// Held-out evaluation: TEST-split headline metrics, ROC, lift, calibration, bands, confusion matrix, leakage audit, loss drivers.
import { h, api, fmt, card, kpi, pageHead, icon, pill, table, callout, toast, bandPill } from '../lib.js';
import { xyChart, barChart, lineChart, hbars, legend } from '../charts.js';

const ic = (n, s = 16) => { const e = icon(n); e.style.cssText = `width:${s}px;height:${s}px;flex:none`; return e; };
const DRIVERS = {
  slow_first_response: ['Slow first response', 'The lead was Hot but the first response missed its SLA (4 h for Hot), so interest cooled before anyone called.'],
  still_open: ['Still open', 'Responded to in time and not disqualified or stale, but still in New / Working / Qualified with no opportunity yet: not a loss, just not converted.'],
  merged_duplicate: ['Merged duplicate', 'Another record for the same person converted; this one was merged into it and so never converts on its own.'],
  went_cold: ['Went cold', 'The lead was followed up in time but then went quiet: no activity for 60+ days, so its status became Stale.'],
  consent_blocked: ['Consent blocked', 'The contact opted out, so follow-up was suppressed by the consent gate. A correct outcome: score is high, contact is not allowed.'],
  unroutable: ['Unroutable', 'Region outside every territory (“Other”), so the lead sat in the Sales-Ops queue without an owning rep.'],
  disqualified_competitor: ['Disqualified: competitor', 'A rep disqualified the lead because the buyer was a competitor.'],
  disqualified_no_budget: ['Disqualified: no budget', 'A rep disqualified the lead because the buyer had no budget.'],
  disqualified_not_a_fit: ['Disqualified: not a fit', 'A rep disqualified the lead as outside the ICP.'],
  disqualified_unresponsive: ['Disqualified: unresponsive', 'A rep disqualified the lead after repeated attempts got no reply.'],
};

export default async function page({ role }) {
  let d;
  try { d = await api.get('/api/evaluation'); } catch (e) {
    return h('div', null, pageHead('Held-out evaluation', 'Does the score actually predict conversion on leads the model has never been tuned on?'),
      callout(e.status === 403 ? 'warn' : 'err', h('div', null, h('b', null, e.status === 403 ? 'This screen needs the analyst, ops or admin persona. ' : 'Could not load the evaluation. '), e.message, e.status === 403 ? ' Evaluation joins model scores with outcome labels from the ground-truth store, which is restricted by RBAC.' : '')));
  }
  const tr = d.metrics.train, te = d.metrics.test, lk = d.leakage, pop = d.population;

  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `leadlens_evaluation_rule_v${d.rule_version}.json` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Metrics JSON downloaded', 'ok');
  };

  // ------------------------------------------------------------------------------------------------ header / population
  const split = card('Population and split', h('div', { class: 'grid g4' },
    [['Matured, eligible leads', fmt.int(pop.matured_eligible), 'leads at least 45 days old with a settled outcome'], ['TRAIN split', fmt.int(pop.train), `${100 - d.split.test_pct}% — used for diagnostics and tuning`],
      ['TEST split (held out)', fmt.int(pop.test), `${d.split.test_pct}% — every headline metric below`], ['Rule version', `v${d.rule_version}`, 'weights fixed a priori, not fitted to these labels']].map(([l, v, s]) =>
      h('div', null, h('div', { class: 'muted', style: { fontSize: '12px', fontWeight: 600 } }, l), h('div', { style: { fontSize: '24px', fontWeight: 720, letterSpacing: '-.02em' } }, v), h('div', { class: 'muted', style: { fontSize: '12px' } }, s)))),
    { sub: 'who is evaluated, and who is not' });
  split.querySelector('.bd').append(h('div', { class: 'divider' }), h('div', { class: 'col', style: { gap: '6px', fontSize: '12.5px', color: 'var(--text-2)' } },
    h('div', { class: 'row', style: { alignItems: 'flex-start' } }, ic('layers', 15), h('span', null, h('b', null, 'Exclusions: '), pop.excluded_note + '.')),
    h('div', { class: 'row', style: { alignItems: 'flex-start' } }, ic('lock', 15), h('span', null, h('b', null, 'Deterministic split: '), h('span', { class: 'mono' }, d.split.method), ` — the same lead is always in the same fold, fixed at data-generation time, so nobody can re-cut the split to flatter the result.`)),
    h('div', { class: 'row', style: { alignItems: 'flex-start' } }, ic('shield', 15), h('span', null, h('b', null, 'Headline = TEST only. '), 'Train values are shown next to each metric purely to prove the model is not overfit.'))));

  // ------------------------------------------------------------------------------------------------ KPIs
  const gapNote = (a, b, d_ = 3) => { const g = a - b; return `train ${b.toFixed(d_)} · gap ${(g >= 0 ? '+' : '−') + Math.abs(g).toFixed(d_)}`; };
  const fit = Math.abs(te.auc - tr.auc) < 0.03;
  const kpis = h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(5, minmax(0,1fr))' } },
    kpi({ label: 'ROC AUC · test', value: te.auc, format: (v) => v.toFixed(3), sub: gapNote(te.auc, tr.auc), ico: 'target' }),
    kpi({ label: 'Average precision · test', value: te.avg_precision, format: (v) => v.toFixed(3), sub: gapNote(te.avg_precision, tr.avg_precision), ico: 'chart' }),
    kpi({ label: 'KS statistic · test', value: te.ks, format: (v) => v.toFixed(3), sub: gapNote(te.ks, tr.ks), ico: 'sliders' }),
    kpi({ label: 'Precision @ top 10% · test', value: te.precision_at_k.top_10pct * 100, format: (v) => v.toFixed(1) + '%', sub: `train ${fmt.pct(tr.precision_at_k.top_10pct)} · ${(te.precision_at_k.top_10pct / te.base_rate).toFixed(1)}× base rate`, ico: 'flag' }),
    kpi({ label: 'Base conversion rate · test', value: te.base_rate * 100, format: (v) => v.toFixed(1) + '%', sub: `${fmt.int(te.positives)} of ${fmt.int(te.n)} converted · train ${fmt.pct(tr.base_rate)}`, ico: 'users' }));
  const verdict = fit ? callout('ok', h('div', null, h('b', null, 'No sign of overfitting. '), `Test AUC ${te.auc.toFixed(3)} vs train ${tr.auc.toFixed(3)}: the gap is ${Math.abs(te.auc - tr.auc).toFixed(3)}. The rules were set before seeing these outcomes, so train and test behave alike. An AUC of 0.5 would be a coin flip, 1.0 a perfect ranking.`))
    : callout('warn', `Test AUC differs from train by ${Math.abs(te.auc - tr.auc).toFixed(3)}; investigate possible overfit or drift.`);

  // ------------------------------------------------------------------------------------------------ ROC + lift
  const roc = card('ROC curve · train vs held-out test', [h('div', { style: { maxWidth: '520px', margin: 'auto' } }, xyChart({ series: [{ name: 'Train', points: tr.roc, color: 'var(--muted)', dash: '5 4' }, { name: 'Test', points: te.roc, color: 'var(--s1)' }], xLabel: 'False-positive rate', yLabel: 'True-positive rate', height: 290 })),
    legend([[`Train (AUC ${tr.auc.toFixed(3)})`, 'var(--muted)'], [`Test (AUC ${te.auc.toFixed(3)})`, 'var(--s1)']]),
    h('p', { class: 'muted', style: { fontSize: '12px', margin: '8px 0 0' } }, 'Each point is a score cut-off: how many converters (y) we catch for how many non-converters we also flag (x). The dashed diagonal is a random ranking. The two curves lying on top of each other is the visual proof of generalisation.')], { sub: `KS test ${te.ks.toFixed(3)}` });

  const lift = card('Lift by score decile · test', [barChart({ data: te.lift.map((x) => ({ label: `D${x.decile}`, value: x.lift, color: x.lift >= 1 ? 'var(--s1)' : 'var(--s8)', tip: `<b>Decile ${x.decile} (top ${x.decile * 10}% cumulative)</b><br>score ${x.min_score}–${x.max_score}<br>${fmt.pct(x.rate)} converted (${fmt.int(x.converted)} of ${fmt.int(x.n)})<br><span class="k">lift ${x.lift.toFixed(2)}× · base ${fmt.pct(te.base_rate)}</span>` })), format: (v) => `${+v.toFixed(2)}×`, refLine: 1, height: 230 }),
    h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, 'D1 = the 10% of leads with the highest scores. Lift = conversion rate of the decile ÷ overall rate; the dashed line is 1.0× (no better than random).'),
    h('div', { class: 'divider' }),
    h('div', { style: { fontSize: '12.5px', fontWeight: 600, marginBottom: '4px' } }, 'Cumulative capture of converters'),
    lineChart({ x: ['0', ...te.lift.map((x) => `${x.decile * 10}%`)], series: [{ name: 'Model', values: [0, ...te.lift.map((x) => x.cum_capture * 100)], color: 'var(--s1)', area: true }, { name: 'Random', values: [0, ...te.lift.map((x) => x.decile * 10)], color: 'var(--muted)' }], format: (v) => v.toFixed(0) + '%', height: 190 }),
    legend([['Model', 'var(--s1)'], ['Random ranking', 'var(--muted)']]),
    h('p', { class: 'muted', style: { fontSize: '12px', margin: '6px 0 0' } }, `Working the top 20% of leads by score reaches ${fmt.pct(te.lift[1].cum_capture, 0)} of all eventual converters (random would reach 20%).`)], { sub: 'ranking power' });

  // ------------------------------------------------------------------------------------------------ calibration + bands + confusion
  const calib = card('Calibration · observed conversion by score', [barChart({ data: te.calibration.map((c) => ({ label: c.bin, value: c.rate || 0, tip: `<b>Score ${c.bin}</b><br>${fmt.pct(c.rate)} converted<br><span class="k">${fmt.int(c.n)} leads</span>` })), format: (v) => fmt.pct(v, 0), refLine: te.base_rate, height: 230, rotate: false }),
    h('p', { class: 'muted', style: { fontSize: '12px', margin: '6px 0 0' } }, 'Bars should rise left to right: a higher score means a higher observed conversion rate. The dashed line is the overall base rate. Scores are rankings, not probabilities, so the bars show what “70+” has historically meant.')], { sub: 'monotone ramp expected' });

  const bandRows = te.bands;
  const bands = card('Score bands · test', [table({ columns: [
    { label: 'Band', render: (r) => bandPill(r.band) }, { label: 'Leads', num: true, render: (r) => fmt.int(r.n) }, { label: 'Share', num: true, render: (r) => fmt.pct(r.share, 1) },
    { label: 'Converted', num: true, render: (r) => fmt.int(r.converted) }, { label: 'Conversion', num: true, render: (r) => h('b', null, fmt.pct(r.rate)) },
    { label: 'Won', num: true, render: (r) => fmt.int(r.won) }, { label: 'Win rate', num: true, render: (r) => fmt.pct(r.win_rate) }], rows: bandRows }),
  h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, `Hot leads convert ${(bandRows[0].rate / bandRows[2].rate).toFixed(1)}× as often as Cold and also win more of the deals they open: the score separates both conversion and deal quality, not only volume. Win rate = won ÷ converted.`)], { sub: 'what the bands mean in outcomes' });

  const cf = te.confusion_hot;
  const cell = (n, label, good, sub) => h('div', { style: { padding: '14px', borderRadius: '12px', textAlign: 'center', border: `1px solid ${good ? 'color-mix(in srgb, var(--ok) 40%, transparent)' : 'color-mix(in srgb, var(--err) 35%, transparent)'}`, background: `color-mix(in srgb, ${good ? 'var(--ok)' : 'var(--err)'} 9%, var(--surface-2))` } },
    h('div', { style: { fontSize: '22px', fontWeight: 720, fontVariantNumeric: 'tabular-nums' } }, fmt.int(n)), h('div', { style: { fontSize: '12px', fontWeight: 600 } }, label), h('div', { class: 'muted', style: { fontSize: '11px' } }, sub));
  const hd = (t) => h('div', { class: 'muted', style: { fontSize: '11px', fontWeight: 650, textTransform: 'uppercase', letterSpacing: '.06em', textAlign: 'center', alignSelf: 'end', paddingBottom: '2px' } }, t);
  const confusion = card('Confusion matrix at the Hot cut-off · test', [
    h('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr 1fr', gap: '8px' } }, h('div'), hd('Converted'), hd('Did not convert'),
      h('div', { class: 't2', style: { fontSize: '12px', fontWeight: 600, alignSelf: 'center' } }, 'Predicted Hot'), cell(cf.tp, 'True positive', true, 'Hot and converted'), cell(cf.fp, 'False positive', false, 'Hot but did not convert'),
      h('div', { class: 't2', style: { fontSize: '12px', fontWeight: 600, alignSelf: 'center' } }, 'Predicted not Hot'), cell(cf.fn, 'False negative', false, 'missed converter'), cell(cf.tn, 'True negative', true, 'correctly not Hot')),
    h('div', { class: 'grid g2 mt' }, h('div', { class: 'card flat', style: { padding: '10px 14px', background: 'var(--surface-2)' } }, h('div', { class: 'muted', style: { fontSize: '11.5px' } }, 'Precision (Hot → converted)'), h('b', { style: { fontSize: '20px' } }, fmt.pct(cf.precision))),
      h('div', { class: 'card flat', style: { padding: '10px 14px', background: 'var(--surface-2)' } }, h('div', { class: 'muted', style: { fontSize: '11.5px' } }, 'Recall (converters that are Hot)'), h('b', { style: { fontSize: '20px' } }, fmt.pct(cf.recall)))),
    h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, `Hot is deliberately selective: ${fmt.pct(cf.precision, 0)} of Hot leads convert (base rate ${fmt.pct(te.base_rate, 0)}) but Hot only contains ${fmt.pct(cf.recall, 0)} of all converters. The Hot cut-off protects rep capacity (4 h call SLA); Warm leads still get a 24 h follow-up.`)], { sub: 'precision vs recall trade-off' });

  // ------------------------------------------------------------------------------------------------ leakage audit
  const dAuc = lk.auc_test_all - lk.auc_test_excluding_leaked;
  const aucPair = (label, a, b) => h('div', { class: 'card flat', style: { padding: '12px 14px', background: 'var(--surface-2)' } }, h('div', { class: 'muted', style: { fontSize: '11.5px', fontWeight: 600 } }, label),
    h('div', { class: 'row', style: { gap: '10px', alignItems: 'baseline', marginTop: '4px', flexWrap: 'wrap' } }, h('span', null, h('b', { style: { fontSize: '22px' } }, a.toFixed(4)), h('span', { class: 'muted', style: { fontSize: '11.5px' } }, ' with leaked')), h('span', { class: 'muted' }, 'vs'), h('span', null, h('b', { style: { fontSize: '22px' } }, b.toFixed(4)), h('span', { class: 'muted', style: { fontSize: '11.5px' } }, ' without'))),
    h('div', { style: { fontSize: '12px', fontWeight: 650, color: a - b > 0 ? 'var(--warn)' : 'var(--ok)' } }, `leaked leads inflate AUC by ${(a - b).toFixed(4)}`));
  const leak = card('Leakage audit', [
    h('div', { class: 'row wrap', style: { gap: '12px', marginBottom: '12px' } }, h('div', { style: { fontSize: '30px', fontWeight: 740, letterSpacing: '-.03em', color: 'var(--warn)' } }, fmt.int(lk.leaked_leads)),
      h('div', { style: { fontSize: '13px' } }, h('b', null, 'leads scored after they converted'), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${fmt.int(lk.leaked_in_population)} of them fall inside the evaluated population; the detector reads operational data only.`))),
    h('div', { class: 'grid g2' }, aucPair('Held-out test AUC', lk.auc_test_all, lk.auc_test_excluding_leaked), aucPair('Whole matured population AUC', lk.auc_population_all, lk.auc_population_excluding_leaked)),
    callout('info', h('div', null, h('b', null, 'Why it matters. '), `A score that has seen post-conversion events “knows” the answer. Here the effect is small (${dAuc.toFixed(4)} AUC) because only ${fmt.int(lk.leaked_leads)} leads are affected, but the headline numbers above are still the ones that include them; the clean figure is the right one to quote when you need a strict estimate.`)),
    h('div', { style: { fontSize: '12.5px', fontWeight: 650, margin: '14px 0 6px' } }, 'Feature audit'),
    h('ul', { style: { margin: '0 0 0 18px', padding: 0, fontSize: '12.5px', color: 'var(--text-2)', lineHeight: 1.65 } }, lk.feature_audit.map((x) => h('li', null, x))),
    h('div', { style: { marginTop: '12px' } }, callout('ok', h('div', null, h('b', null, 'Labels live in a separate ground-truth database. '), 'Outcome labels (converted, won, split) are read from ground_truth.db only to build the target vector y. They are never joined into the features, and the scoring engine never opens that database.'))),
    h('a', { href: '#/exceptions', style: { fontSize: '12.5px', display: 'inline-block', marginTop: '10px' }, onclick: () => sessionStorage.setItem('ex_type', 'score_post_conversion') }, 'See the leaked leads in Exceptions →')], { sub: 'target-leakage check' });

  // ------------------------------------------------------------------------------------------------ non-converters
  const hs = d.high_score_non_converters;
  const totalDrv = hs.drivers.reduce((a, x) => a + x.n, 0);
  const drivers = card('Why do high-scoring leads not convert?', [
    h('div', { class: 'row wrap', style: { gap: '12px', marginBottom: '12px' } }, h('div', { style: { fontSize: '30px', fontWeight: 740, letterSpacing: '-.03em', color: 'var(--hot)' } }, fmt.int(hs.n_hot_matured)),
      h('div', { style: { fontSize: '13px' } }, h('b', null, 'matured leads scored Hot'), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${fmt.int(totalDrv)} of them (${fmt.pct(totalDrv / hs.n_hot_matured, 0)}) did not convert, and each carries a recorded cause: mostly process, not model error.`))),
    hbars({ rows: hs.drivers.map((x) => ({ label: (DRIVERS[x.driver] || [fmt.title(x.driver)])[0], value: x.n, sub: fmt.pct(x.n / totalDrv, 0), color: x.driver === 'consent_blocked' ? 'var(--s4)' : 'var(--s2)',
      tip: `<b>${(DRIVERS[x.driver] || [x.driver])[0]}</b><br>${fmt.int(x.n)} leads (${fmt.pct(x.n / totalDrv)})<br><span class="k">${(DRIVERS[x.driver] || ['', ''])[1]}</span>` })), labelW: 170 }),
    h('div', { class: 'divider' }),
    h('div', { class: 'col', style: { gap: '7px', fontSize: '12.5px' } }, hs.drivers.map((x) => h('div', { style: { display: 'grid', gridTemplateColumns: '170px 1fr', gap: '10px' } }, h('b', { style: { fontWeight: 600 } }, (DRIVERS[x.driver] || [fmt.title(x.driver)])[0]), h('span', { class: 'muted' }, (DRIVERS[x.driver] || ['', 'Recorded loss driver.'])[1])))),
    h('p', { class: 'muted', style: { fontSize: '12px', margin: '12px 0 0' } }, 'Drivers are the ground-truth labels for matured Hot leads that did not convert; the first matching cause wins (consent, then routing, duplicate, SLA, disqualification, stale, still open). Slow first response is the largest actionable cause: it is fixed by the SLA-bound task workbench, not by changing the scoring weights.')], { sub: 'false positives explained' });

  // ------------------------------------------------------------------------------------------------ diagnostics
  const mxLift = 3;
  const diag = card('Rule diagnostics (TRAIN split)', [table({ columns: [
    { label: 'Rule', render: (r) => h('div', null, h('div', { style: { fontWeight: 560 } }, r.description), h('div', { class: 'muted mono', style: { fontSize: '10.5px' } }, `${r.rule_id} · ${r.feature}`)) }, { label: 'Dimension', render: (r) => pill(r.dimension, 'muted') },
    { label: 'Max pts', num: true, render: (r) => r.max_points || '—' }, { label: 'Coverage', num: true, render: (r) => fmt.pct(r.coverage, 0) },
    { label: 'Converts when active', num: true, render: (r) => fmt.pct(r.rate_when_active) }, { label: 'When inactive', num: true, render: (r) => fmt.pct(r.rate_when_inactive) },
    { label: 'Lift', render: (r) => (r.lift == null ? h('span', { class: 'muted', style: { fontSize: '12px' } }, r.coverage === 0 ? 'never fires' : 'always on') : h('div', { class: 'row', style: { gap: '8px' } },
      h('div', { style: { position: 'relative', width: '110px', height: '8px', borderRadius: '6px', background: 'var(--surface-3)' } }, h('div', { style: { width: `${Math.min(1, r.lift / mxLift) * 100}%`, height: '100%', borderRadius: '6px', background: r.lift >= 1 ? 'var(--s3)' : 'var(--s8)' } }), h('div', { style: { position: 'absolute', left: `${100 / mxLift}%`, top: '-3px', bottom: '-3px', width: '2px', background: 'var(--text-2)', opacity: 0.7 } })),
      h('b', { style: { fontVariantNumeric: 'tabular-nums' } }, `${r.lift.toFixed(2)}×`))) }], rows: d.rule_diagnostics }),
  h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, 'Every rule with a switch-like behaviour shows lift well above 1.0× except the free-e-mail penalty, whose lift is below 1.0× — exactly the direction a penalty should point. Tick = 1.0× (no signal).')], { sub: 'each rule must earn its points' });

  return h('div', null,
    pageHead('Held-out evaluation', 'Does the score predict conversion on leads it was never tuned on? Headline numbers use the deterministic 30 % TEST split only; labels come from a separate ground-truth database.',
      [h('button', { class: 'btn', onclick: download }, icon('file'), 'Download metrics JSON'), h('a', { class: 'btn', href: '#/scoring' }, icon('sliders'), 'Scoring rules & what-if')]),
    split, h('div', { class: 'mt' }, kpis), h('div', { class: 'mt' }, verdict),
    h('div', { class: 'grid g2 mt' }, roc, lift), h('div', { class: 'grid g2 mt' }, calib, bands), h('div', { class: 'grid g2 mt' }, confusion, leak), h('div', { class: 'mt' }, drivers), h('div', { class: 'mt' }, diag));
}

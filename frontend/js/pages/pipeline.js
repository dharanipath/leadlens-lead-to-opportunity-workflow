// Pipeline: kanban board, KPI strip, won/lost analysis and an opportunity detail modal (stage stepper, history, gap detection, guarded advance).
import { h, api, ApiError, fmt, card, kpi, pageHead, icon, pill, table, bandPill, leadLink, select, chips, modal, toast, act, callout, skeleton, empty, SEV } from '../lib.js';
import { funnel, hbars } from '../charts.js';

const OPEN = ['Qualified', 'Discovery', 'Proposal', 'Negotiation'];
const STAGE_COLOR = { 'Closed Won': 'var(--ok)', 'Closed Lost': 'var(--err)' };
const STAGE_HELP = {
  Qualified: 'Lead converted, opportunity created',
  Discovery: 'Needs and budget confirmed',
  Proposal: 'Quote sent to the buyer',
  Negotiation: 'Terms and discount in play',
  'Closed Won': 'Deal signed, reason recorded',
  'Closed Lost': 'Deal lost, reason recorded',
};
const CAN_ADVANCE = ['agent', 'ops', 'admin'];
const ic = (n, s = 13) => { const e = icon(n); e.style.cssText = `width:${s}px;height:${s}px;flex:none`; return e; };
const days = (a, b) => (new Date(b) - new Date(a)) / 86400000;

export default async function page({ params, role }) {
  const filters = { rep_id: '', product: '' };
  const [board0, reps] = await Promise.all([api.get('/api/opportunities/board'), api.get('/api/reps').catch(() => [])]);
  const stageFlow = await loadFlow(role);

  const kpiWrap = h('div');
  const boardWrap = h('div', { class: 'mt' });
  const reasonWrap = h('div', { class: 'mt' });

  async function reload(initial) {
    let b = initial;
    if (!b) {
      boardWrap.replaceChildren(skeleton(1, 340));
      try { b = await api.get('/api/opportunities/board', filters); } catch (e) { boardWrap.replaceChildren(callout('err', String(e.message || e))); return; }
    }
    paintKpis(b);
    paintBoard(b);
    if (initial) paintReasons(b);
  }

  // ---------------------------------------------------------------------------------------------------------- KPI strip
  function paintKpis(b) {
    const cols = Object.fromEntries(b.columns.map((c) => [c.stage, c]));
    const openCols = OPEN.map((s) => cols[s]);
    const openAmt = openCols.reduce((a, c) => a + c.amount, 0), openN = openCols.reduce((a, c) => a + c.n, 0);
    const weighted = openCols.reduce((a, c) => a + c.amount * c.probability / 100, 0);
    const won = cols['Closed Won'].n, lost = cols['Closed Lost'].n;
    const filtered = filters.rep_id || filters.product;
    kpiWrap.replaceChildren(h('div', { class: 'grid g4' },
      kpi({ label: 'Open pipeline', value: openAmt, format: fmt.moneyShort, sub: `${fmt.int(openN)} open deals${filtered ? ' (filtered)' : ''}`, ico: 'briefcase' }),
      kpi({ label: 'Weighted pipeline', value: weighted, format: fmt.moneyShort, sub: 'Σ amount × stage probability (10 / 25 / 50 / 75 %)', ico: 'trend' }),
      kpi({ label: 'Avg cycle · won deals', value: b.avg_cycle_days_won, format: (v) => v.toFixed(0) + ' days', sub: 'created → closed, all won deals (not filtered)', ico: 'clock' }),
      kpi({ label: 'Win rate (closed)', value: won + lost ? (won / (won + lost)) * 100 : 0, format: (v) => v.toFixed(1) + '%', sub: `${fmt.int(won)} won · ${fmt.int(lost)} lost${filtered ? ' (filtered)' : ''}`, ico: 'checkcircle', color: 'var(--ok)' })));
  }

  // ---------------------------------------------------------------------------------------------------------- board
  function paintBoard(b) {
    const cols = b.columns.map((c) => {
      const accent = STAGE_COLOR[c.stage] || 'var(--accent)';
      const cards = c.cards.length ? c.cards.map((o) => kcard(o)) : [h('div', { class: 'muted', style: { fontSize: '12px', padding: '14px 6px', textAlign: 'center' } }, 'No deals match the filters')];
      return h('div', { class: 'kcol', style: { borderTop: `3px solid ${accent}`, display: 'flex', flexDirection: 'column' } },
        h('div', { class: 'kh', style: { display: 'block' } },
          h('div', { class: 'row', style: { gap: '7px' } }, h('span', { class: 'nowrap' }, c.stage), h('span', { class: 'pill muted' }, fmt.int(c.n))),
          h('div', { class: 'row', style: { gap: '6px', marginTop: '3px', fontSize: '12.5px' } }, h('b', { style: { fontVariantNumeric: 'tabular-nums' } }, fmt.moneyShort(c.amount)), h('span', { class: 'muted', style: { fontWeight: 450 } }, `· ${c.probability}% prob.`)),
          h('div', { class: 'muted', style: { fontSize: '11.5px', fontWeight: 450, marginTop: '2px' } }, STAGE_HELP[c.stage])),
        h('div', { style: { overflowY: 'auto', maxHeight: '640px', paddingRight: '2px' } }, cards,
          c.n > c.cards.length ? h('div', { class: 'muted', style: { fontSize: '11.5px', textAlign: 'center', padding: '6px 0 2px' } }, `Showing newest ${c.cards.length} of ${fmt.int(c.n)}`) : null));
    });
    boardWrap.replaceChildren(h('div', { class: 'kanban', style: { gridTemplateColumns: 'repeat(6, minmax(172px, 1fr))' } }, cols),
      h('p', { class: 'muted', style: { fontSize: '12px', margin: '8px 2px 0' } }, 'Stages move strictly one step at a time: Qualified → Discovery → Proposal → Negotiation → Closed. Skipping a stage or re-opening a closed deal is refused by the API (HTTP 422) and logged to the audit trail. Click a card for its full stage history.'));
  }

  function kcard(o) {
    const closed = o.status !== 'open';
    return h('div', { class: 'kcard', onclick: () => openDetail(o.opportunity_id, reload.bind(null, null)) },
      h('div', { class: 'row', style: { gap: '6px', alignItems: 'flex-start' } },
        h('b', { style: { flex: 1, minWidth: 0, fontSize: '13px', lineHeight: 1.3, overflowWrap: 'anywhere' } }, o.company_name), bandPill(o.score_band)),
      h('div', { class: 'row', style: { marginTop: '7px', gap: '8px' } }, h('span', { class: 'amt' }, fmt.money(o.amount_usd)), pill(o.product_line, 'muted')),
      h('div', { style: { marginTop: '6px', fontSize: '11.5px' }, class: 'muted' },
        h('div', { class: 'row', style: { gap: '5px' } }, ic('user'), h('span', null, o.rep_name)),
        closed ? h('div', { class: 'row', style: { gap: '6px', marginTop: '3px' } }, pill(o.won_lost_reason || '—', o.status === 'won' ? 'ok' : 'err'), h('span', null, fmt.date(o.closed_ts)))
          : h('div', { class: 'row', style: { gap: '5px', marginTop: '2px' } }, ic('flag'), h('span', null, `expected close ${fmt.date(o.expected_close_date)}`))),
      h('div', { style: { marginTop: '6px', fontSize: '11.5px' } }, h('a', { href: `#/pipeline/${o.opportunity_id}`, class: 'mono', onclick: (e) => e.stopPropagation() }, o.opportunity_id)));
  }

  // ---------------------------------------------------------------------------------------------------------- reasons + stage flow
  function paintReasons(b) {
    let mode = 'amt';
    const wonBox = h('div'), lostBox = h('div'), insight = h('div');
    const rows = (status, color) => {
      const rs = b.reasons.filter((r) => r.status === status).sort((x, y) => y[mode] - x[mode]);
      return rs.length ? hbars({ rows: rs.map((r) => ({ label: r.reason || '—', value: r[mode], color, sub: mode === 'amt' ? `${fmt.int(r.n)} deals` : fmt.moneyShort(r.amt),
        tip: `<b>${r.reason}</b><br>${fmt.int(r.n)} deals · ${fmt.money(r.amt)}<br><span class="k">avg ${fmt.money(r.amt / r.n)}</span>` })), format: mode === 'amt' ? fmt.moneyShort : fmt.int, labelW: 140 }) : empty('No closed deals');
    };
    const paint = () => {
      wonBox.replaceChildren(rows('won', 'var(--s3)')); lostBox.replaceChildren(rows('lost', 'var(--s8)'));
      const tw = b.reasons.filter((r) => r.status === 'won').sort((x, y) => y.amt - x.amt)[0], tl = b.reasons.filter((r) => r.status === 'lost').sort((x, y) => y.amt - x.amt)[0];
      insight.replaceChildren(tw && tl ? callout('info', h('b', null, 'Read-out: '), `most revenue is won on “${tw.reason}” (${fmt.moneyShort(tw.amt)}) and lost to “${tl.reason}” (${fmt.moneyShort(tl.amt)}). Reasons are mandatory on close, so every closed deal explains itself.`) : null);
    };
    paint();
    const toggle = chips([['amt', 'By revenue ($)'], ['n', 'By deal count']], mode, (k) => { mode = k; paint(); });
    const flow = card('Stage conversion', stageFlow ? [funnel({ stages: stageFlow.stages }),
      h('p', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } }, 'Distinct opportunities that ever entered each stage (from the append-only StageHistory), as % of the previous stage. Closed Won counts only wins; losses can occur at any open stage. Opportunities with a gap in their history are slightly under-counted at the skipped stage.')]
      : [funnel({ stages: stageMix(b) }), h('p', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } }, 'Where deals sit today (all opportunities, current stage). The entered-stage funnel from StageHistory is available to Analyst / Admin personas.')],
    { sub: stageFlow ? 'from StageHistory' : 'current stage mix' });
    reasonWrap.replaceChildren(h('div', { class: 'row', style: { marginBottom: '12px' } }, h('h3', { style: { fontSize: '15px' } }, 'Why deals are won and lost'), h('span', { class: 'muted', style: { fontSize: '12px' } }, 'all closed deals, independent of the filters above'), h('div', { class: 'grow' }), toggle),
      h('div', { class: 'grid g2' },
        card('Won reasons', wonBox, { sub: `${fmt.int(b.reasons.filter((r) => r.status === 'won').reduce((a, r) => a + r.n, 0))} deals` }),
        card('Lost reasons', lostBox, { sub: `${fmt.int(b.reasons.filter((r) => r.status === 'lost').reduce((a, r) => a + r.n, 0))} deals` })),
      h('div', { class: 'mt-s' }, insight), h('div', { class: 'mt' }, flow));
  }
  const stageMix = (b) => b.columns.map((c) => ({ stage: c.stage, n: c.n }));

  // ---------------------------------------------------------------------------------------------------------- filters
  const repOpts = (Array.isArray(reps) ? reps : []).filter((r) => r.opps > 0).map((r) => [r.rep_id, `${r.rep_name} · ${r.rep_id} (${r.opps})`]);
  const productOpts = ['Analytics', 'Security', 'Automation', 'Collaboration'];
  const filterBar = h('div', { class: 'row wrap' },
    h('label', { class: 'f', style: { minWidth: '230px' } }, 'Owner rep', select(repOpts, '', (v) => { filters.rep_id = v; reload(); }, { placeholder: 'All reps' })),
    h('label', { class: 'f', style: { minWidth: '170px' } }, 'Product', select(productOpts, '', (v) => { filters.product = v; reload(); }, { placeholder: 'All products' })),
    h('button', { class: 'btn ghost sm', style: { alignSelf: 'flex-end' }, onclick: () => { filters.rep_id = ''; filters.product = ''; filterBar.querySelectorAll('select').forEach((s) => { s.value = ''; }); reload(); } }, icon('refresh'), 'Reset'),
    h('div', { class: 'grow' }),
    h('div', { class: 'muted', style: { alignSelf: 'flex-end', fontSize: '12px' } }, 'Card badge = lead score band · filters re-query the board'));

  await reload(board0);
  const node = h('div', null,
    pageHead('Opportunity pipeline', 'Every deal moves through Qualified → Discovery → Proposal → Negotiation → Closed one recorded step at a time. Won / lost reasons are mandatory, and the stage history is append-only.',
      [h('a', { class: 'btn', href: '#/exceptions' }, icon('alert'), 'Stage-gap exceptions')]),
    h('div', { class: 'card pad' }, filterBar), h('div', { class: 'mt' }, kpiWrap), boardWrap, reasonWrap);
  if (params[0] && /^OPP-/.test(params[0])) setTimeout(() => openDetail(params[0], () => reload()), 0);
  return node;

  // ---------------------------------------------------------------------------------------------------------- detail modal
  function openDetail(oid, onChanged) {
    const holder = h('div', null, skeleton(3, 90));
    const m = modal({ title: `Opportunity ${oid}`, body: holder, wide: true });
    const target = `#/pipeline/${oid}`;
    if (location.hash !== target) history.replaceState(null, '', target);
    const onKey = (e) => { if (e.key === 'Escape') m.close(); };
    document.addEventListener('keydown', onKey);
    const obs = new MutationObserver(() => {
      if (!document.body.contains(m.el)) { obs.disconnect(); document.removeEventListener('keydown', onKey); if (location.hash.startsWith('#/pipeline/')) history.replaceState(null, '', '#/pipeline'); }
    });
    obs.observe(document.body, { childList: true });
    const load = async () => {
      let d, clock;
      try { [d, clock] = await Promise.all([api.get(`/api/opportunities/${oid}`), api.get('/api/health').then((x) => x.clock).catch(() => new Date().toISOString())]); }
      catch (e) { holder.replaceChildren(callout('err', e instanceof ApiError && e.status === 404 ? `Opportunity ${oid} was not found.` : String(e.message || e))); return; }
      holder.replaceChildren(detailView(d, clock, async () => { await load(); onChanged?.(); }));
    };
    load();
  }

  function detailView(d, clock, refresh) {
    const o = d.opportunity;
    const maths = o.seats * o.unit_price_usd * (100 - o.discount_pct) / 100;
    const mathsOk = Math.abs(maths - o.amount_usd) < 0.5;
    const hist = d.history;
    const bad = new Set(hist.map((x, i) => ((x.from_stage || '') !== (i ? hist[i - 1].to_stage : '') ? x.stage_history_id : null)).filter(Boolean));

    const head = h('div', { class: 'row wrap', style: { marginBottom: '14px' } },
      h('div', null, h('div', { style: { fontSize: '19px', fontWeight: 680, letterSpacing: '-.02em' } }, o.company_name), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, `${o.contact_name} · ${o.product_line}`)),
      h('div', { class: 'grow' }), pill(o.status, o.status === 'won' ? 'ok' : o.status === 'lost' ? 'err' : 'info', o.status === 'won' ? 'check' : o.status === 'lost' ? 'x' : 'clock'), pill(o.stage, 'violet'),
      d.chain_ok ? pill('history intact', 'ok', 'checkcircle') : pill('history gap', 'err', 'alert'));

    const summary = card('Summary', h('dl', { class: 'kv' },
      ...[['Opportunity', h('span', { class: 'mono' }, o.opportunity_id)], ['Lead', leadLink(o.lead_id)], ['Owner rep', `${o.rep_name} (${o.owner_rep_id})`], ['Created', fmt.ts(o.created_ts)],
        ['Expected close', fmt.date(o.expected_close_date)], ['Probability', `${o.probability_pct}% at ${o.stage}`], ['Closed', o.closed_ts ? fmt.ts(o.closed_ts) : '—'],
        ['Won / lost reason', o.won_lost_reason ? pill(o.won_lost_reason, o.status === 'won' ? 'ok' : 'err') : '—']].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])), { flat: true });

    const amountCard = card('How the amount is built', [
      h('div', { class: 'row wrap', style: { gap: '8px', fontSize: '13px' } },
        mathBox(fmt.int(o.seats), 'seats'), h('span', { class: 'muted' }, '×'), mathBox('$' + fmt.int(o.unit_price_usd), `${o.product_line} / seat / yr`), h('span', { class: 'muted' }, '×'),
        mathBox(`${100 - o.discount_pct}%`, `after ${o.discount_pct}% discount`), h('span', { class: 'muted' }, '='), mathBox(fmt.money(o.amount_usd), 'amount', true)),
      h('div', { class: 'mt-s row', style: { fontSize: '12.5px' } }, mathsOk ? pill('reconciles', 'ok', 'check') : pill(`expected ${fmt.money(maths)}`, 'err', 'alert'),
        h('span', { class: 'muted' }, `${fmt.int(o.seats)} × $${fmt.int(o.unit_price_usd)} × ${(100 - o.discount_pct) / 100} = ${fmt.money(maths)}`)),
      h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, 'Unit price comes from the product price list; discount is limited to 0 / 5 / 10 / 15 / 20 %.')], { flat: true });

    const tl = card('Stage progression', [stepper(d, clock),
      d.chain_ok ? null : callout('err', h('div', null, h('b', null, 'Missing step detected. '),
        'This opportunity is a ', h('span', { class: 'mono' }, 'stage_history_gap'), ' exception: StageHistory is append-only and each row must start where the previous one ended (from_stage = previous to_stage). A transition row is absent, so the audit trail cannot prove the deal passed through that stage.',
        h('ul', { style: { margin: '8px 0 0 18px', padding: 0 } }, d.chain_issues.map((x) => h('li', { class: 'mono', style: { fontSize: '12px' } }, x))),
        h('div', { class: 'muted', style: { marginTop: '6px', fontSize: '12px' } }, 'Prevention today: the advance API refuses any skipped stage with HTTP 422 (stage_gap_prevented). Use the demo button below to see it.')))], { flat: true });

    const histTable = card('Stage history (append-only)', table({ columns: [
      { label: 'ID', render: (r) => h('span', { class: 'mono nowrap', style: { fontSize: '11.5px' } }, r.stage_history_id) },
      { label: 'Transition', render: (r) => h('span', { class: 'row', style: { gap: '6px' } }, r.from_stage ? pill(r.from_stage, 'muted') : h('span', { class: 'muted' }, '∅ start'), ic('arrow'), pill(r.to_stage, r.to_stage === 'Closed Won' ? 'ok' : r.to_stage === 'Closed Lost' ? 'err' : 'violet'), bad.has(r.stage_history_id) ? pill('gap before this row', 'err', 'alert') : null) },
      { label: 'Timestamp', render: (r) => h('span', { class: 'mono' }, fmt.ts(r.changed_ts)) }, { label: 'By', render: (r) => r.changed_by_rep_id || '—' }, { label: 'Reason', render: (r) => r.reason || '—' }], rows: hist }), { flat: true });

    const exc = card('Exceptions on this deal', d.exceptions.length ? h('div', { class: 'col' }, d.exceptions.map((e) => h('div', { class: 'row', style: { alignItems: 'flex-start' } }, pill(e.severity, SEV[e.severity] || 'muted', 'alert'),
      h('div', null, h('b', null, e.title), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, e.message), h('a', { href: '#/exceptions', onclick: () => sessionStorage.setItem('ex_type', e.issue_type), style: { fontSize: '12px' } }, 'Open in Exceptions →')))))
      : h('div', { class: 'row muted' }, ic('checkcircle', 16), 'No detector flags this opportunity.'), { flat: true });

    return h('div', null, head, h('div', { class: 'grid g2' }, summary, amountCard), h('div', { class: 'mt' }, tl), h('div', { class: 'mt' }, histTable), h('div', { class: 'mt' }, exc), h('div', { class: 'mt' }, actionsCard(d, refresh)));
  }

  function mathBox(big, small, hi) { return h('div', { style: { padding: '8px 12px', borderRadius: '10px', background: hi ? 'var(--accent-soft)' : 'var(--surface-2)', border: `1px solid ${hi ? 'var(--accent)' : 'var(--border)'}`, textAlign: 'center' } },
    h('div', { style: { fontWeight: 700, fontVariantNumeric: 'tabular-nums' } }, big), h('div', { class: 'muted', style: { fontSize: '10.5px' } }, small)); }

  function stepper(d, clock) {
    const o = d.opportunity, hist = d.history;
    const closedRow = hist.find((x) => x.to_stage === 'Closed Won' || x.to_stage === 'Closed Lost');
    const lastIdx = o.status === 'open' ? OPEN.indexOf(o.stage) : 4;
    const cells = [...OPEN, o.status === 'lost' ? 'Closed Lost' : o.status === 'won' ? 'Closed Won' : 'Closed'].map((label, i) => {
      const row = i < 4 ? hist.find((x) => x.to_stage === label) : closedRow;
      const state = row ? (i === lastIdx && o.status === 'open' ? 'current' : 'done') : i <= lastIdx ? 'missing' : 'future';
      let dwell = null, span = false;
      if (row && i < 4) {
        const k = hist.indexOf(row), nxt = hist[k + 1];
        if (nxt) { dwell = days(row.changed_ts, nxt.changed_ts); span = (nxt.from_stage || '') !== row.to_stage; } else if (o.status === 'open') dwell = days(row.changed_ts, clock);
      }
      return { label, state, row, dwell, span };
    });
    const col = (s) => (s === 'done' ? 'var(--ok)' : s === 'current' ? 'var(--accent)' : s === 'missing' ? 'var(--err)' : 'var(--border-2)');
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))', margin: '4px 0 16px' } }, cells.map((c, i) => {
      const next = cells[i + 1];
      const line = next ? h('div', { style: { position: 'absolute', top: '16px', left: '50%', width: '100%', height: 0, borderTop: `2px ${next.state === 'missing' || c.state === 'missing' ? 'dashed' : 'solid'} ${next.state === 'future' ? 'var(--border-2)' : next.state === 'missing' || c.state === 'missing' ? 'var(--err)' : 'var(--ok)'}` } }) : null;
      const circle = h('div', { style: { position: 'relative', zIndex: 1, margin: '0 auto', width: '34px', height: '34px', borderRadius: '50%', display: 'grid', placeItems: 'center', background: c.state === 'current' ? 'var(--accent-soft)' : c.state === 'missing' ? 'color-mix(in srgb, var(--err) 14%, var(--surface))' : 'var(--surface)', border: `2px solid ${col(c.state)}`, color: col(c.state), fontWeight: 700, fontSize: '12.5px' } },
        c.state === 'done' ? icon(c.label === 'Closed Lost' ? 'x' : 'check') : c.state === 'missing' ? icon('alert') : String(i + 1));
      circle.querySelector('svg')?.setAttribute('style', 'width:16px;height:16px');
      return h('div', { style: { position: 'relative', textAlign: 'center', padding: '0 4px' } }, line, circle,
        h('div', { style: { marginTop: '8px', fontWeight: 620, fontSize: '13px', color: c.state === 'missing' ? 'var(--err)' : c.state === 'future' ? 'var(--muted)' : 'var(--text)' } }, c.label),
        c.state === 'missing' ? h('div', { style: { marginTop: '4px' } }, pill('MISSING step', 'err', 'alert'), h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '3px' } }, 'no StageHistory row')) :
          c.row ? h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '3px', lineHeight: 1.4 } }, h('div', { class: 'mono' }, fmt.ts(c.row.changed_ts)),
            c.dwell != null ? h('div', null, `${c.dwell.toFixed(1)} d ${c.state === 'current' ? 'so far' : 'in stage'}`) : null, c.span ? h('div', { style: { color: 'var(--warn)' } }, 'spans an unrecorded step') : null) :
            h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '3px' } }, 'not reached'));
    }));
  }

  function actionsCard(d, refresh) {
    const o = d.opportunity;
    const allowed = CAN_ADVANCE.includes(role);
    const result = h('div', { class: 'mt-s' });
    const reasonSel = {};
    const nextOpen = d.next_stages.filter((s) => !s.startsWith('Closed'));
    const post = async (to, reason, label) => {
      const r = await act(() => api.post(`/api/opportunities/${o.opportunity_id}/advance`, { to_stage: to, reason }), (x) => `${o.opportunity_id} → ${x.stage}${reason ? ` (${reason})` : ''}`);
      if (r) await refresh();
    };
    const closeGroup = (to, list) => d.next_stages.includes(to) ? h('div', { class: 'row wrap', style: { gap: '8px' } },
      (() => { const s = select(list, '', () => {}, { placeholder: `${to === 'Closed Won' ? 'Won' : 'Lost'} reason…` }); reasonSel[to] = s; return s; })(),
      h('button', { class: `btn ${to === 'Closed Lost' ? 'danger' : ''}`, disabled: !allowed, onclick: () => { if (!reasonSel[to].value) { toast(`Pick a ${to === 'Closed Won' ? 'won' : 'lost'} reason first: closing a deal requires one.`, 'warn'); return; } post(to, reasonSel[to].value); } }, icon(to === 'Closed Won' ? 'check' : 'x'), to)) : null;

    // choose a transition the API must refuse
    const i = OPEN.indexOf(o.stage);
    const allowedSet = new Set(d.next_stages);
    const skipTo = o.status !== 'open' ? 'Discovery' : [OPEN[i + 2], 'Closed Won', 'Qualified'].find((s) => s && s !== o.stage && !allowedSet.has(s));
    const skipLabel = o.status !== 'open' ? `Try re-opening: ${o.stage} → Discovery` : `Try ${o.stage} → ${skipTo}`;
    const tryBlocked = async () => {
      result.replaceChildren(skeleton(1, 54));
      try {
        const r = await api.post(`/api/opportunities/${o.opportunity_id}/advance`, { to_stage: skipTo, reason: skipTo === 'Closed Won' ? 'Product fit' : undefined });
        result.replaceChildren(callout('warn', h('b', null, 'Unexpected: the API accepted this transition. '), JSON.stringify(r)));
        await refresh();
      } catch (e) {
        const b = e.body || {};
        result.replaceChildren(callout('ok', h('div', null, h('div', { class: 'row wrap', style: { gap: '8px' } }, pill(`HTTP ${e.status}`, 'warn'), b.rule ? pill(b.rule, 'err', 'shield') : null, h('b', null, 'Refused by the API — no row written to StageHistory')),
          h('div', { style: { marginTop: '6px' } }, e.message), h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, 'The blocked attempt itself is recorded in the audit trail (action advance_stage, outcome blocked).'))));
        toast(`${b.rule ? `[${b.rule}] ` : ''}${e.message}`, e.status === 409 || e.status === 422 ? 'warn' : 'err');
      }
    };

    return card('Advance this opportunity', [
      !allowed ? callout('info', `The ${role} persona is read-only for stage changes (allowed: agent, ops, admin). The refusal demo below still works and will return HTTP 403.`) : null,
      h('div', { class: 'col', style: { gap: '12px', marginTop: allowed ? 0 : '10px' } },
        o.status !== 'open' ? callout('warn', `This deal is closed (${o.stage}). Lifecycle rule: closed opportunities cannot move.`) : h('div', { class: 'row wrap', style: { gap: '10px' } },
          nextOpen.map((s) => h('button', { class: 'btn primary', disabled: !allowed, onclick: () => post(s) }, icon('arrow'), `Advance to ${s}`)),
          h('span', { class: 'muted', style: { fontSize: '12px' } }, 'one step at a time')),
        o.status === 'open' ? h('div', { class: 'row wrap', style: { gap: '18px' } }, closeGroup('Closed Won', d.won_reasons), closeGroup('Closed Lost', d.lost_reasons)) : null,
        h('div', { class: 'divider', style: { margin: '2px 0' } }),
        h('div', { class: 'row wrap', style: { gap: '10px' } }, h('button', { class: 'btn', onclick: tryBlocked }, icon('shield'), skipLabel), h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Demo: calls the real endpoint with an illegal transition to show the business rule firing.')),
        result)], { flat: true });
  }
}

async function loadFlow(role) {
  if (!['analyst', 'admin'].includes(role)) return null;
  try {
    const r = await api.post('/api/sql', { sql: 'SELECT to_stage, COUNT(DISTINCT opportunity_id) n FROM stage_history GROUP BY to_stage' });
    const m = Object.fromEntries(r.rows);
    const order = ['Qualified', 'Discovery', 'Proposal', 'Negotiation', 'Closed Won'];
    return { stages: order.map((s) => ({ stage: s === 'Closed Won' ? 'Closed Won' : `Entered ${s}`, n: m[s] || 0 })) };
  } catch { return null; }
}

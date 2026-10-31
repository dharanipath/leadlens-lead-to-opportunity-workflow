import { h, svg, api, ApiError, fmt, card, kpi, pageHead, icon, pill, table, callout, tabs, chips, select, toast, tip, hover, debounce, SEV } from '../lib.js';
import { hbars, legend, SERIES } from '../charts.js';

const ico = (n, sz = 16) => { const e = icon(n); e.style.cssText = `width:${sz}px;height:${sz}px;flex:none`; return e; };
const bytesH = (b) => (b == null ? '—' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? (b / 1e3).toFixed(1) + ' KB' : b + ' B');
const short = (s, n = 12) => (s ? String(s).slice(0, n) : '—');
const show = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const clip = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const sampleId = (pat) => (pat ? pat.replace(/^\^|\$$/g, '').replace(/\\d\{(\d+)\}/g, (_, n) => '0'.repeat(n - 1) + '1').replace(/\\d\+/g, '1').replace(/\\/g, '') : '');
const copy = async (text, msg = 'Copied') => { try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('Copy not available in this browser', 'warn'); } };

function injectCss() {
  if (document.getElementById('data-page-css')) return;
  const st = document.createElement('style'); st.id = 'data-page-css';
  st.textContent = `@keyframes ll-spin{to{transform:rotate(360deg)}} .ll-spin{animation:ll-spin .9s linear infinite}
  .erd-svg .erd-edge{transition:opacity .15s,stroke-width .15s;fill:none} .erd-svg.focus .erd-edge:not(.on){opacity:.07} .erd-svg.focus .erd-node:not(.on){opacity:.32} .erd-svg .erd-node{transition:opacity .15s;cursor:pointer}
  .erd-svg .erd-edge.on{stroke-width:2.6} .erd-svg .erd-node:hover .erd-frame{stroke:var(--accent);stroke-width:1.8}
  details.vgroup>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;padding:12px 18px} details.vgroup>summary::-webkit-details-marker{display:none}
  details.vgroup[open]>summary .chev{transform:rotate(90deg)} .chev{transition:transform .15s;display:inline-block;color:var(--muted)}
  tr.gtrow td{background:color-mix(in srgb,var(--s7) 7%,transparent)} tr.xrow td{background:var(--surface-2);font-size:12.5px}`;
  document.head.append(st);
}

const GT_DESC = {
  gt_id: 'Row key of the ground-truth record', entity_type: 'Kind of record the label is about (lead, contact, activity, opportunity …)', entity_id: 'ID of the labelled record',
  issue_type: 'Which planted issue / edge case it is (e.g. duplicate_contact, opted_out_contacted)', is_injected: '1 when the generator deliberately injected the defect', severity: 'Severity assigned to the issue type',
  expected_decision: 'What a correct system should do (flag, merge, block …)', related_entity_id: 'Counterpart record (e.g. the canonical contact for a duplicate)', detail: 'Free-text parameters of the injection, e.g. variant=hard; detected_by_rules=no',
  lead_id: 'Lead the outcome belongs to', outcome: 'Final outcome label (won / lost / open / …)', converted: '1 if the lead became an opportunity', won: '1 if the opportunity was won', split: 'train / test assignment for the held-out evaluation',
  matured: '1 when the lead is old enough for its outcome to be final', loss_driver: 'Generator’s hidden reason behind a loss (analysis only)',
};
const ISSUE_DESC = {
  duplicate_contact: 'Planted duplicate people (easy to hard variants)', duplicate_lead: 'Planted duplicate leads inside the 30-day window', duplicate_opportunity: 'Merged lead that still produced its own opportunity',
  high_score_non_converter: 'Hot/high-score leads that never converted', lead_outside_territory: 'Owner covers a different territory than the lead', opted_out_contacted: 'Outbound e-mail/call after an opt-out',
  score_post_conversion: 'Score computed with events after conversion (leakage)', stage_history_gap: 'Broken stage-history chain', stale_lead: 'Leads idle for more than 60 days',
};

const GROUP = { company: 'Customer', contact: 'Customer', consent: 'Customer', campaign: 'Marketing', lead_campaign: 'Marketing', sales_rep: 'Sales org', rep_product: 'Sales org',
  lead: 'Lead lifecycle', activity: 'Lead lifecycle', task: 'Lead lifecycle', lead_status_history: 'Lead lifecycle', score_rule: 'Lead lifecycle', opportunity: 'Pipeline', stage_history: 'Pipeline' };
const GROUP_COLOR = { Customer: 'var(--s1)', Marketing: 'var(--s5)', 'Sales org': 'var(--s3)', 'Lead lifecycle': 'var(--s7)', Pipeline: 'var(--s4)' };
const POS = { company: [12, 30], contact: [12, 170], consent: [12, 330], stage_history: [12, 480], campaign: [274, 30], lead_campaign: [274, 170], score_rule: [274, 300], opportunity: [274, 430],
  lead: [536, 100], lead_status_history: [536, 340], sales_rep: [798, 30], task: [798, 190], activity: [798, 350], rep_product: [1060, 30] };

export default async function dataPage({ params, role }) {
  injectCss();
  const [meta, valInit, reproInit] = await Promise.all([api.get('/api/meta'), api.get('/api/validation').catch(() => null), api.get('/api/reproducibility').catch(() => null)]);
  const S = { tab: ['overview', 'dict', 'erd', 'val', 'repro', 'sql', 'gt'].includes(params?.[0]) ? params[0] : 'overview', entity: 'lead', val: valInit, repro: reproInit, valFilter: 'all', valCat: '', valQ: '', fq: '', sql: '', sqlRes: null, ids: null };
  const T = meta.tables, names = Object.keys(T);
  const content = h('div', { class: 'mt' });
  const canRun = role === 'analyst' || role === 'admin';

  // ================================================================================================ (a) overview / provenance
  function overview() {
    const files = Object.entries(meta.files || {}).sort(([a], [b]) => a.localeCompare(b));
    const totalRows = files.filter(([f]) => f.startsWith('csv/')).reduce((a, [, v]) => a + v.rows, 0), totalBytes = files.reduce((a, [, v]) => a + v.bytes, 0);
    const P = meta.parameters || {};
    const pfmt = (k, v) => (typeof v === 'number' && v < 1 && v > 0 ? `${(v * 100).toFixed(v * 100 < 1 ? 2 : 1)}%` : Number.isInteger(v) ? fmt.int(v) : String(v));
    const idsBox = h('tbody');
    const idRows = names.map((t) => { const pk = T[t].pk, f = T[t].fields.find((x) => x.name === pk[0]); return { t, pk, f, pat: f.pattern, composite: pk.length > 1 }; });
    const paintIds = () => { idsBox.replaceChildren(...idRows.map((r) => h('tr', null,
      h('td', null, h('b', { style: { fontWeight: 600 } }, T[r.t].entity), h('div', { class: 'mono muted', style: { fontSize: '11px' } }, r.t)), h('td', { class: 'mono' }, r.pk.join(' + ')),
      h('td', null, r.pat ? h('span', { class: 'mono', style: { fontSize: '11.5px' } }, r.pat) : h('span', { class: 'muted' }, 'composite of parent keys')),
      h('td', { class: 't2', style: { fontSize: '12.5px' } }, r.f.rule || r.f.description),
      h('td', null, S.ids?.[r.t] ? h('span', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'mono' }, S.ids[r.t]), pill('live', 'ok')) : h('span', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'mono muted' }, r.composite ? 'LEAD-… + CMP-…' : sampleId(r.pat)), pill('pattern', 'muted')))))); };
    paintIds();
    if (canRun && !S.ids) {
      const sql = idRows.map((r) => `SELECT '${r.t}' t, MIN(${r.pk.join(" || ' + ' || ")}) e FROM ${r.t}`).join(' UNION ALL ');
      api.post('/api/sql', { sql }).then((res) => { S.ids = Object.fromEntries(res.rows); paintIds(); }).catch(() => { });
    }
    const src = (meta.sources || []);
    return h('div', { class: 'col', style: { gap: '16px' } },
      h('div', { class: 'grid g4' },
        kpi({ label: 'Generator seed', raw: String(meta.seed), sub: 'fixed seed → byte-identical data', ico: 'zap' }), kpi({ label: 'Entities / tables', value: names.length, sub: `${meta.relationships.length} documented relationships`, ico: 'layers' }),
        kpi({ label: 'Rows generated', value: totalRows, format: fmt.int, sub: `${files.length} files · ${bytesH(totalBytes)} (csv + json + sql)`, ico: 'db' }), kpi({ label: 'Snapshot as-of', raw: fmt.date(meta.as_of), sub: `live clock continues from ${fmt.date(meta.clock)}`, ico: 'clock' })),
      h('div', { class: 'grid g-21' },
        card('How this dataset was produced', [
          h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '6px' } }, 'Generator command'),
          h('div', { class: 'row', style: { alignItems: 'stretch' } }, h('div', { class: 'code grow', style: { whiteSpace: 'pre-wrap' } }, meta.command || '(unknown)'), h('button', { class: 'btn', onclick: () => copy(meta.command || '', 'Command copied') }, ico('copy', 15), 'Copy')),
          h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '14px 0 6px' } }, 'Scale & behaviour parameters (manifest.parameters)'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '6px 18px' } }, Object.entries(P).map(([k, v]) => h('div', { class: 'row', style: { justifyContent: 'space-between', borderBottom: '1px dashed var(--border)', padding: '3px 0', fontSize: '12.5px' } }, h('span', { class: 'mono muted' }, k), h('b', { class: 'mono' }, k === 'seed' ? String(v) : pfmt(k, v))))),
        ], { sub: 'rerun it and you get the same bytes' }),
        card('Provenance & licence', [
          ...src.map((s) => h('div', { class: 'col', style: { gap: '8px' } }, h('div', { class: 'row wrap' }, h('b', null, s.name), pill(s.dataset_version || 'v1', 'muted'), pill('no external data', 'ok', 'shield')),
            h('dl', { class: 'kv', style: { gridTemplateColumns: '90px 1fr', fontSize: '12.5px' } }, h('dt', null, 'Licence'), h('dd', null, s.license), h('dt', null, 'Source URL'), h('dd', null, s.url || 'none — generated locally'), h('dt', null, 'Retrieved'), h('dd', null, s.retrieval_date || 'n/a'),
              h('dt', null, 'Attribution'), h('dd', null, s.attribution), h('dt', null, 'Notes'), h('dd', { class: 't2' }, s.notes)))),
          callout('info', 'All people, companies, e-mails (reserved ', h('span', { class: 'mono' }, '.example'), ' domains) and phone numbers are fabricated. Public CRM schemas (e.g. Salesforce Lead / Opportunity objects) informed the ', h('i', null, 'shape'), ' of the model only; no data or text was copied.'),
        ].map((x, i) => (i ? h('div', { class: 'mt-s' }, x) : x)), { sub: 'synthetic · freely redistributable' })),
      card('Generated files & checksums', [table({ columns: [
        { label: 'File', render: ([f]) => h('span', { class: 'mono' }, f) }, { label: 'Rows', num: true, render: ([, v]) => fmt.int(v.rows) }, { label: 'Bytes', num: true, render: ([, v]) => bytesH(v.bytes) },
        { label: 'SHA-256 (click to copy)', render: ([, v]) => h('a', { class: 'mono', href: 'javascript:void(0)', title: v.sha256, onclick: () => copy(v.sha256, 'SHA-256 copied') }, short(v.sha256, 16) + '…') }], rows: files, empty: 'No manifest' }),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } }, 'Checksums come from manifest.json and are re-derived by the reproducibility run (tab Reproducibility). Ground-truth files are written separately and are not listed in the input tables.')], { sub: `${files.length} files · ${bytesH(totalBytes)}` }),
      card('ID conventions', [h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Entity', 'Key', 'Pattern', 'Convention', 'Example'].map((x) => h('th', null, x)))), idsBox)),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } }, canRun ? 'Examples are read live from the database (first key of each table).' : 'Examples are derived from each key’s regex pattern; the Analyst and Admin personas see live values read from the database.')], { sub: 'immutable, human-readable, sortable keys' }));
  }

  // ================================================================================================ (b) dictionary
  function dict() {
    const body = h('div');
    const counts = S.val?.row_counts || {};
    const paint = () => {
      const q = S.fq.trim().toLowerCase();
      if (q) {
        const hits = names.flatMap((t) => T[t].fields.filter((f) => [f.name, f.description, f.type, f.rule, f.pattern, f.fk, f.units, (f.allowed || []).join(' ')].filter(Boolean).join(' ').toLowerCase().includes(q)).map((f) => ({ t, f })));
        body.replaceChildren(card(`${hits.length} field${hits.length === 1 ? '' : 's'} match “${S.fq}”`, fieldTable(hits.map((x) => x.f), hits.map((x) => x.t)), { sub: 'across all 14 entities' }));
        return;
      }
      const t = S.entity, e = T[t];
      const rels = meta.relationships.filter((r) => r[0] === t || r[1] === t || (r[3] || '').startsWith(t + '.') || (r[3] || '').startsWith(t + ' '));
      body.replaceChildren(h('div', { class: 'grid g-21', style: { alignItems: 'start' } },
        card(e.entity, [h('div', { class: 't2', style: { fontSize: '13.5px' } }, e.description), h('div', { class: 'row wrap mt-s' }, pill(`PK: ${e.pk.join(' + ')}`, 'warn', 'lock'), pill(`${e.fields.length} fields`, 'muted'), counts[t] != null ? pill(`${fmt.int(counts[t])} rows`, 'info', 'db') : null, pill(GROUP[t] || '', 'violet'))], { sub: t }),
        card('Lifecycle & relationships', [h('div', { class: 'mono', style: { fontSize: '12px', color: 'var(--text-2)' } }, e.lifecycle || 'Reference data — no state machine.'),
          h('div', { class: 'col mt-s', style: { gap: '3px', fontSize: '12px' } }, rels.map((r) => h('div', { class: 'muted' }, h('b', { class: 't2' }, `${r[0]} → ${r[1]}`), ` · ${r[2]} · ${r[3]} · ${r[4]}`)))], { sub: 'from the schema' })),
        h('div', { class: 'mt' }, card('Fields', fieldTable(e.fields, null, t), { sub: `${e.fields.length} fields · FK links open the parent entity` })));
    };
    const fieldTable = (fields, owners, cur) => table({ columns: [
      ...(owners ? [{ label: 'Entity', render: (f) => h('a', { href: 'javascript:void(0)', onclick: () => { S.entity = owners[fields.indexOf(f)]; S.fq = ''; render(); } }, owners[fields.indexOf(f)]) }] : []),
      { label: 'Field', render: (f) => h('span', { class: 'row', style: { gap: '6px' } }, h('b', { class: 'mono', style: { fontWeight: 600 } }, f.name), (cur || '') && T[cur].pk.includes(f.name) ? pill('PK', 'warn') : null) },
      { label: 'Type', render: (f) => pill(f.type, 'muted') }, { label: 'Req.', render: (f) => (f.required ? pill('required', 'info') : h('span', { class: 'muted' }, 'optional')) },
      { label: 'Allowed values', render: (f) => (f.allowed ? h('div', { class: 'row wrap', style: { gap: '4px', maxWidth: '260px' } }, f.allowed.slice(0, 8).map((a) => h('span', { class: 'chip', style: { cursor: 'default', padding: '1px 8px', fontSize: '11.5px' } }, String(a))), f.allowed.length > 8 ? h('span', { class: 'muted' }, `+${f.allowed.length - 8}`) : null) : '—') },
      { label: 'Units', render: (f) => f.units || '—' }, { label: 'Unique', render: (f) => (f.unique ? pill('unique', 'ok', 'check') : '—') },
      { label: 'Foreign key', render: (f) => (f.fk ? h('a', { class: 'mono', href: 'javascript:void(0)', onclick: () => { S.entity = f.fk.split('.')[0]; S.fq = ''; render(); } }, '→ ' + f.fk) : '—') },
      { label: 'Validation rule', render: (f) => h('div', { class: 'col', style: { gap: '3px', fontSize: '12px' } }, f.pattern ? h('span', { class: 'mono' }, f.pattern) : null, f.min != null || f.max != null ? h('span', { class: 'mono' }, `range ${f.min ?? '−∞'} … ${f.max ?? '∞'}`) : null, f.rule ? h('span', { class: 't2' }, f.rule) : null, !f.pattern && f.min == null && f.max == null && !f.rule ? (f.required ? h('span', { class: 'muted' }, 'not null') : '—') : null) },
      { label: 'Description', render: (f) => h('span', { class: 't2', style: { fontSize: '12.5px' } }, f.description) },
    ], rows: fields });
    const search = h('input', { type: 'search', placeholder: 'Search every field: name, description, rule, allowed value…', value: S.fq, style: { minWidth: '320px' }, oninput: debounce((e) => { S.fq = e.target.value; paint(); }, 200) });
    const chipsEl = chips(names.map((n) => [n, T[n].entity]), S.entity, (k) => { S.entity = k; S.fq = ''; search.value = ''; paint(); });
    paint();
    return h('div', null, h('div', { class: 'row wrap', style: { marginBottom: '12px', alignItems: 'flex-start' } }, h('div', { class: 'grow', style: { minWidth: '280px' } }, chipsEl), search), body);
  }

  // ================================================================================================ (c) ERD
  function erd() {
    const boxes = {}; const W = 214;
    const refd = new Set(); names.forEach((t) => T[t].fields.forEach((f) => { if (f.fk) refd.add(f.fk); }));
    names.forEach((t) => {
      const pk = T[t].pk; const rows = T[t].fields.filter((f) => pk.includes(f.name) || f.fk || refd.has(`${t}.${f.name}`)).map((f) => ({ name: f.name, pk: pk.includes(f.name), fk: !!f.fk, ref: refd.has(`${t}.${f.name}`) && !pk.includes(f.name) }));
      const more = T[t].fields.length - rows.length; const [x, y] = POS[t];
      boxes[t] = { t, x, y, w: W, rows, more, h: 28 + (rows.length + (more > 0 ? 1 : 0)) * 16 + 10 };
    });
    const rowY = (t, name) => { const b = boxes[t]; const i = b.rows.findIndex((r) => r.name === name); return b.y + 28 + (i < 0 ? 0 : i) * 16 + 8; };
    const edges = [];
    names.forEach((t) => T[t].fields.forEach((f) => {
      if (!f.fk) return; const [pt, pf] = f.fk.split('.'); const rel = meta.relationships.find((r) => r[3] === `${t}.${f.name}`);
      const card_ = rel ? rel[2].split(' ')[0].split(':') : ['1', 'N']; const opt = !f.required || (rel && /^optional/.test(rel[4]));
      edges.push({ parent: pt, pfield: pf, child: t, cfield: f.name, optional: opt, pc: card_[0], cc: card_[1] || 'N', rel, bridge: ['lead_campaign', 'rep_product'].includes(t) });
    }));
    const Wd = 1290, Ht = Math.max(...Object.values(boxes).map((b) => b.y + b.h)) + 24;
    const s = svg('svg', { viewBox: `0 0 ${Wd} ${Ht}`, class: 'erd-svg', style: `width:100%;min-width:1100px;display:block;font-family:var(--font)` });
    const edgeEls = [], nodeEls = {};
    const gE = svg('g'), gN = svg('g'); s.append(gE, gN);
    edges.forEach((e) => {
      const P = boxes[e.parent], C = boxes[e.child], py = rowY(e.parent, e.pfield), cy = rowY(e.child, e.cfield);
      let px, cx, sp, sc, dx;
      if (e.parent === e.child) { px = cx = P.x + P.w; sp = sc = 1; dx = 46; }
      else if (P.x + P.w + 8 <= C.x) { px = P.x + P.w; cx = C.x; sp = 1; sc = -1; dx = Math.max(36, Math.abs(cx - px) / 2); }
      else if (C.x + C.w + 8 <= P.x) { px = P.x; cx = C.x + C.w; sp = -1; sc = 1; dx = Math.max(36, Math.abs(cx - px) / 2); }
      else { px = P.x + P.w; cx = C.x + C.w; sp = sc = 1; dx = 52; }
      const d = `M${px},${py} C${px + sp * dx},${py} ${cx + sc * dx},${cy} ${cx},${cy}`;
      const color = GROUP_COLOR[GROUP[e.parent]] || 'var(--muted)';
      const path = svg('path', { class: 'erd-edge', d, stroke: color, 'stroke-width': 1.6, 'stroke-dasharray': e.optional ? '6 4' : null, opacity: 0.85 });
      const hit = svg('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 10, style: 'cursor:help' });
      const lab = (x, y, txt, anchor) => svg('text', { x, y, 'text-anchor': anchor, style: `font-size:10px;font-weight:650;fill:${color}` }, txt);
      const g = svg('g', null, hit, path, lab(px + sp * 7, py - 4, e.pc, sp > 0 ? 'start' : 'end'), lab(cx + sc * 7, cy - 4, e.cc, sc > 0 ? 'start' : 'end'));
      const tipHtml = `<b>${e.parent}.${e.pfield} → ${e.child}.${e.cfield}</b><br>${e.rel ? e.rel[2] : '1:N'} · ${e.rel ? e.rel[4] : e.optional ? 'optional' : 'mandatory'}${e.bridge ? '<br><span class="k">bridge table: realises an N:M relationship</span>' : ''}`;
      hover(hit, () => tipHtml);
      hit.addEventListener('mouseenter', () => focus([e], [e.parent, e.child])); hit.addEventListener('mouseleave', unfocus);
      e.el = path; gE.append(g); edgeEls.push(e);
    });
    names.forEach((t) => {
      const b = boxes[t], color = GROUP_COLOR[GROUP[t]];
      const g = svg('g', { class: 'erd-node', transform: `translate(${b.x},${b.y})`, onclick: () => { S.entity = t; S.fq = ''; setTab('dict'); } });
      g.append(svg('rect', { class: 'erd-frame', width: b.w, height: b.h, rx: 9, fill: 'var(--surface)', stroke: 'var(--border-2)', 'stroke-width': 1.2 }),
        svg('path', { d: `M0,9 Q0,0 9,0 H${b.w - 9} Q${b.w},0 ${b.w},9 V28 H0 Z`, fill: `color-mix(in srgb, ${color} 24%, var(--surface-2))` }), svg('rect', { x: 0, y: 0, width: 4, height: 28, fill: color, rx: 2 }),
        svg('text', { x: 14, y: 18, style: 'font-size:12.5px;font-weight:700;fill:var(--text)' }, T[t].entity.replace(/\s*\(.*\)/, '')));
      if (b.t === 'lead_campaign' || b.t === 'rep_product') g.append(svg('text', { x: b.w - 8, y: 18, 'text-anchor': 'end', style: 'font-size:9.5px;font-weight:650;fill:var(--text-2)' }, b.t === 'rep_product' ? 'N:M bridge' : 'N:M bridge'));
      b.rows.forEach((r, i) => {
        const y = 28 + i * 16 + 12;
        g.append(svg('text', { x: 10, y, style: `font-size:9px;font-weight:700;fill:${r.pk ? 'var(--warn)' : r.fk ? 'var(--accent)' : 'var(--muted)'}` }, r.pk && r.fk ? 'PK·FK' : r.pk ? 'PK' : r.fk ? 'FK' : 'ref'),
          svg('text', { x: 46, y, style: `font:11px var(--mono);fill:var(--text)` }, r.name));
      });
      if (b.more > 0) g.append(svg('text', { x: 10, y: 28 + b.rows.length * 16 + 12, style: 'font-size:10px;fill:var(--muted);font-style:italic' }, `+ ${b.more} more fields`));
      const hint = `<b>${T[t].entity}</b> · ${GROUP[t]}<br>${T[t].fields.length} fields · PK ${T[t].pk.join(' + ')}<br><span class="k">click to open in the data dictionary</span>`;
      hover(g, () => hint);
      g.addEventListener('mouseenter', () => { const es = edgeEls.filter((e) => e.parent === t || e.child === t); focus(es, [t, ...es.flatMap((e) => [e.parent, e.child])]); }); g.addEventListener('mouseleave', unfocus);
      nodeEls[t] = g; gN.append(g);
    });
    function focus(es, ns) { s.classList.add('focus'); edgeEls.forEach((e) => e.el.classList.toggle('on', es.includes(e))); Object.entries(nodeEls).forEach(([t, g]) => g.classList.toggle('on', ns.includes(t))); }
    function unfocus() { s.classList.remove('focus'); edgeEls.forEach((e) => e.el.classList.remove('on')); Object.values(nodeEls).forEach((g) => g.classList.remove('on')); }
    const lg = h('div', { class: 'row wrap', style: { gap: '16px', fontSize: '12px', marginTop: '10px' } },
      ...Object.entries(GROUP_COLOR).map(([g, c]) => h('span', { class: 't2' }, h('i', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '3px', background: c, marginRight: '6px' } }), g)),
      h('span', { class: 't2' }, svg('svg', { width: 34, height: 8, style: 'vertical-align:middle;margin-right:6px' }, svg('line', { x1: 0, x2: 34, y1: 4, y2: 4, stroke: 'var(--text-2)', 'stroke-width': 1.8 })), 'mandatory'),
      h('span', { class: 't2' }, svg('svg', { width: 34, height: 8, style: 'vertical-align:middle;margin-right:6px' }, svg('line', { x1: 0, x2: 34, y1: 4, y2: 4, stroke: 'var(--text-2)', 'stroke-width': 1.8, 'stroke-dasharray': '6 4' })), 'optional'),
      h('span', { class: 't2' }, h('b', { style: { color: 'var(--warn)' } }, 'PK'), ' primary key · ', h('b', { style: { color: 'var(--accent)' } }, 'FK'), ' foreign key · ', h('b', { class: 'muted' }, 'ref'), ' referenced non-key column'),
      h('span', { class: 'muted' }, 'Line ends show cardinality (1, N, 0..1). Hover a table or line to trace its relationships; click a table for its dictionary.'));
    const relTable = card('Relationships & cardinality', table({ columns: [
      { label: 'Parent', render: (r) => h('span', { class: 'mono' }, r[0]) }, { label: 'Child', render: (r) => h('span', { class: 'mono' }, r[1]) }, { label: 'Cardinality', render: (r) => pill(r[2], r[2].includes('N:M') ? 'violet' : 'info') },
      { label: 'Realised by', render: (r) => h('span', { class: 'mono', style: { fontSize: '12px' } }, r[3]) }, { label: 'Participation', render: (r) => (/^optional/.test(r[4]) ? pill(r[4], 'muted') : pill(r[4], 'ok')) }], rows: meta.relationships }),
    { sub: `${meta.relationships.length} relationships · N:M relationships are resolved through bridge tables lead_campaign and rep_product` });
    return h('div', null, card('Entity-relationship diagram', [h('div', { class: 'erd', style: { padding: '8px' } }, s), lg], { sub: 'positions are hand-laid; edges are generated from the schema’s foreign keys' }), h('div', { class: 'mt' }, relTable));
  }

  // ================================================================================================ (d) validation
  const isGT = (c) => /observed\s*==\s*labelled|== labelled/i.test(c.detail || '') || /== labelled/i.test(c.name);
  function validation() {
    const box = h('div'); const V = () => S.val || { checks: [], total: 0, passed: 0, failed: 0 };
    const runBtn = h('button', { class: 'btn primary', disabled: !canRun, title: canRun ? '' : 'Analyst / Admin only', onclick: async () => {
      runBtn.disabled = true; runBtn.replaceChildren(ico('refresh', 15), 'Running validation… (~20 s)'); runBtn.firstChild.classList.add('ll-spin');
      try {
        let res = await api.post('/api/validation/run');
        if (!res?.checks) res = await api.get('/api/validation');
        S.val = res; toast(`Validation finished: ${res.passed}/${res.total} checks passed`, res.failed ? 'warn' : 'ok'); paint();
      } catch (e) { toast(String(e.message || e), e instanceof ApiError && e.status === 403 ? 'warn' : 'err'); }
      runBtn.disabled = !canRun; runBtn.replaceChildren(ico('refresh', 15), 'Re-run validation');
    } }, ico('refresh', 15), 'Re-run validation');
    function paint() {
      const v = V();
      if (!v.checks.length) { box.replaceChildren(card('Validation', callout('warn', h('b', null, 'No validation summary found. '), 'Run the validator: ', h('span', { class: 'mono' }, 'python generator/validate.py'), canRun ? ' or press “Re-run validation”.' : '.')), h('div', { class: 'mt-s' }, runBtn)); return; }
      const gtN = v.checks.filter(isGT).length, cats = [...new Set(v.checks.map((c) => c.category))];
      const q = S.valQ.toLowerCase();
      const list = v.checks.filter((c) => (S.valFilter === 'all' || (S.valFilter === 'gt' ? isGT(c) : c.status === S.valFilter)) && (!S.valCat || c.category === S.valCat) && (!q || `${c.id} ${c.name} ${c.detail} ${show(c.observed)} ${show(c.expected)}`.toLowerCase().includes(q)));
      const groups = {}; list.forEach((c) => { (groups[c.category] ||= []).push(c); });
      const tiles = h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(5, minmax(0,1fr))' } },
        kpi({ label: 'Checks passed', raw: `${v.passed} / ${v.total}`, sub: v.failed ? `${v.failed} failing` : 'all checks green', ico: 'checkcircle', color: v.failed ? 'var(--err)' : 'var(--ok)' }),
        kpi({ label: 'Foreign keys checked', value: v.foreign_keys_checked ?? 0, sub: 'every FK resolves to a parent row', ico: 'layers' }),
        kpi({ label: 'Categories', value: cats.length, sub: cats.slice(0, 5).join(' · ') + '…', ico: 'grid' }),
        kpi({ label: 'Observed = labelled', value: gtN, sub: 'detector output equals ground-truth labels', ico: 'flag', color: 'var(--s7)' }),
        kpi({ label: 'Rows validated', value: Object.values(v.row_counts || {}).reduce((a, b) => a + b, 0), format: fmt.short, sub: `${Object.keys(v.row_counts || {}).length} tables`, ico: 'db' }));
      const filt = h('div', { class: 'row wrap', style: { margin: '14px 0' } },
        chips([['all', `All (${v.total})`], ['pass', `Passed (${v.passed})`], ['fail', `Failed (${v.failed})`], ['gt', `Observed = labelled (${gtN})`]], S.valFilter, (k) => { S.valFilter = k; paint(); }),
        select(cats, S.valCat, (c) => { S.valCat = c; paint(); }, { placeholder: 'All categories' }), h('input', { type: 'search', placeholder: 'Search checks…', value: S.valQ, oninput: debounce((e) => { S.valQ = e.target.value; paint(); const i = box.querySelector('input[type=search]'); i?.focus(); i?.setSelectionRange(i.value.length, i.value.length); }, 250) }),
        h('span', { class: 'grow' }), runBtn);
      const groupEls = Object.entries(groups).map(([cat, cs]) => {
        const bad = cs.filter((c) => c.status !== 'pass').length;
        const tb = h('tbody');
        cs.forEach((c) => {
          const detailRow = h('tr', { class: 'xrow hidden' }, h('td', { colspan: 6 }, h('div', { class: 'col', style: { gap: '4px' } }, h('div', null, h('b', null, c.id), ' · ', c.name), c.detail ? h('div', { class: 't2' }, 'Detail: ', h('span', { class: 'mono' }, c.detail)) : h('div', { class: 'muted' }, 'No additional detail.'),
            h('div', { class: 'mono', style: { fontSize: '11.5px' } }, `observed = ${show(c.observed)}`, h('br'), `expected = ${show(c.expected)}`))));
          const tr = h('tr', { class: `click ${isGT(c) ? 'gtrow' : ''}`, onclick: () => detailRow.classList.toggle('hidden') },
            h('td', { class: 'mono muted' }, c.id), h('td', null, c.name, isGT(c) ? h('span', { style: { marginLeft: '8px' } }, pill('observed = labelled', 'violet', 'flag')) : null),
            h('td', null, c.status === 'pass' ? pill('pass', 'ok', 'check') : pill('fail', 'err', 'alert')), h('td', { class: 'num mono' }, clip(show(c.observed), 40)), h('td', { class: 'num mono' }, clip(show(c.expected), 40)), h('td', { class: 'muted', style: { width: '28px' } }, '▾'));
          tb.append(tr, detailRow);
        });
        return h('details', { class: 'card vgroup', open: S.valCat || S.valQ || S.valFilter !== 'all' || bad > 0 }, h('summary', null, h('span', { class: 'chev' }, '▶'), h('b', null, fmt.title(cat)), pill(`${cs.length - bad}/${cs.length} pass`, bad ? 'err' : 'ok', bad ? 'alert' : 'check'), h('span', { class: 'grow' }), h('span', { class: 'muted', style: { fontSize: '12px' } }, 'click a row for detail')),
          h('div', { class: 'tablewrap', style: { border: 0, borderTop: '1px solid var(--border)', borderRadius: 0 } }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['ID', 'Check', 'Status', 'Observed', 'Expected', ''].map((x, i) => h('th', { class: i === 3 || i === 4 ? 'num' : '' }, x)))), tb)));
      });
      box.replaceChildren(tiles, filt, callout('info', h('b', null, 'Observed = labelled. '), `${gtN} checks compare what the rule engine detects against the labelled defects in the separate ground-truth file (e.g. opted-out contacted: observed 120 = labelled 120, 0 unlabelled, 0 missed). They prove the detectors are neither over- nor under-reporting; they are highlighted in violet.`),
        h('div', { class: 'col mt', style: { gap: '12px' } }, groupEls.length ? groupEls : [h('div', { class: 'empty' }, 'No checks match the filters.')]));
    }
    paint(); return box;
  }

  // ================================================================================================ (e) reproducibility
  function repro() {
    const r = S.repro, files = r?.files || [];
    const expl = card('What this proves', h('div', { class: 'col t2', style: { fontSize: '13px' } },
      h('div', null, h('b', null, 'Same seed → byte-identical files. '), 'The generator is run twice in separate processes with different ', h('span', { class: 'mono' }, 'PYTHONHASHSEED'), ' values (which would expose any dependence on dictionary/set ordering). Every output file must hash to the same SHA-256.'),
      h('div', null, h('b', null, 'Different seed → different data. '), 'A third run with seed + 1 must differ in every file, proving the checksum is sensitive and the data really depends on the seed.'),
      h('div', null, h('b', null, 'Matches the published dataset. '), 'Run 1 is also compared with data/full/manifest.json so the files you are looking at are exactly what the command produces.'),
      h('div', { class: 'row', style: { alignItems: 'stretch' } }, h('div', { class: 'code grow' }, 'python generator/reproduce.py'), h('button', { class: 'btn', onclick: () => copy('python generator/reproduce.py', 'Command copied') }, ico('copy', 15), 'Copy'))));
    if (!files.length) return h('div', { class: 'col', style: { gap: '16px' } }, card('Reproducibility report', h('div', { class: 'empty' }, ico('history', 28), h('div', { style: { fontWeight: 650, margin: '8px 0 4px', color: 'var(--text)' } }, 'No reproducibility report has been generated yet'),
      h('div', null, 'Run ', h('span', { class: 'mono' }, 'python generator/reproduce.py'), ' (takes a few minutes: it generates the full dataset three times). It writes ', h('span', { class: 'mono' }, 'data/full/reproducibility_report.json'), ' and this tab will fill in.'), r?.note ? h('div', { class: 'mono muted mt-s', style: { fontSize: '12px' } }, r.note) : null)), expl);
    const nOk = files.filter((f) => f.identical).length, nDiff = files.filter((f) => f.differs_with_other_seed).length;
    return h('div', { class: 'col', style: { gap: '16px' } },
      h('div', { class: 'grid g4' }, kpi({ label: 'Result', raw: r.all_identical ? 'Reproducible' : 'Mismatch', sub: `${nOk}/${files.length} files identical across runs`, ico: r.all_identical ? 'checkcircle' : 'alert', color: r.all_identical ? 'var(--ok)' : 'var(--err)' }),
        kpi({ label: 'Files compared', value: r.files_compared ?? files.length, sub: `scale ${r.scale || 'full'} · seed ${r.seed}`, ico: 'file' }), kpi({ label: 'Differ with another seed', value: nDiff, sub: `of ${files.length} files`, ico: 'refresh' }),
        kpi({ label: 'Command', raw: 'reproduce.py', sub: r.command || '', ico: 'terminal' })),
      r.note ? callout('info', r.note) : null,
      card('Per-file comparison', table({ columns: [
        { label: 'File', render: (f) => h('span', { class: 'mono' }, f.file) }, { label: 'Rows run 1', num: true, render: (f) => fmt.int(f.rows_run1) }, { label: 'Rows run 2', num: true, render: (f) => fmt.int(f.rows_run2) },
        { label: 'SHA-256 run 1', render: (f) => h('span', { class: 'mono', title: f.sha256_run1 }, short(f.sha256_run1)) }, { label: 'SHA-256 run 2', render: (f) => h('span', { class: 'mono', title: f.sha256_run2 }, short(f.sha256_run2)) },
        { label: 'Identical', render: (f) => (f.identical ? pill('identical', 'ok', 'check') : pill('differs', 'err', 'alert')) }, { label: 'Matches published', render: (f) => (f.matches_published_dataset == null ? '—' : f.matches_published_dataset ? pill('yes', 'ok', 'check') : pill('no', 'err', 'alert')) },
        { label: 'Differs with other seed', render: (f) => (f.differs_with_other_seed ? pill('yes ✓', 'ok', 'check') : h('span', { title: 'Content does not depend on the seed (fixed reference data), so identical bytes are expected' }, pill('no · fixed content', 'muted', 'info'))) }], rows: files }), { sub: 'run 1 vs run 2 use different PYTHONHASHSEED' }), expl);
  }

  // ================================================================================================ (f) SQL console
  const EXAMPLES = [
    ['Funnel counts', `SELECT 'Leads captured' stage, COUNT(*) n FROM lead\nUNION ALL SELECT 'Unique leads', COUNT(*) FROM lead WHERE duplicate_of_lead_id IS NULL\nUNION ALL SELECT 'Qualified (ever)', COUNT(DISTINCT lead_id) FROM lead_status_history WHERE to_status='Qualified'\nUNION ALL SELECT 'Converted', COUNT(*) FROM lead WHERE status='Converted'\nUNION ALL SELECT 'Opportunities won', COUNT(*) FROM opportunity WHERE status='won'`],
    ['Hot non-converters', `SELECT l.lead_id, l.score, l.status, l.status_reason, l.last_activity_ts, co.company_name\nFROM lead l JOIN company co ON co.company_id = l.company_id\nWHERE l.score_band = 'Hot' AND l.status <> 'Converted' AND l.duplicate_of_lead_id IS NULL\nORDER BY l.score DESC, l.lead_id LIMIT 25`],
    ['Consent violations (join)', `SELECT a.activity_id, a.lead_id, a.activity_type, a.activity_ts, c.channel AS optout_channel, c.effective_ts AS opted_out_at\nFROM activity a\nJOIN lead l ON l.lead_id = a.lead_id\nJOIN consent c ON c.contact_id = l.contact_id AND c.status = 'opted_out'\n  AND (c.channel = 'all' OR c.channel = CASE a.activity_type WHEN 'call_outbound' THEN 'phone' ELSE 'email' END)\nWHERE a.activity_type IN ('email_outbound','call_outbound') AND a.activity_ts > c.effective_ts\n  AND NOT EXISTS (SELECT 1 FROM consent c2 WHERE c2.contact_id = c.contact_id AND c2.status = 'opted_in'\n                  AND c2.effective_ts > c.effective_ts AND c2.effective_ts <= a.activity_ts AND (c2.channel = 'all' OR c2.channel = c.channel))\nORDER BY a.activity_ts LIMIT 50`],
    ['Stage-gap query', `SELECT s.opportunity_id, s.stage_history_id, s.from_stage, s.to_stage, s.changed_ts,\n  (SELECT p.to_stage FROM stage_history p WHERE p.opportunity_id = s.opportunity_id AND p.changed_ts < s.changed_ts ORDER BY p.changed_ts DESC LIMIT 1) AS previous_to_stage\nFROM stage_history s\nWHERE COALESCE(s.from_stage,'') <> COALESCE((SELECT p.to_stage FROM stage_history p WHERE p.opportunity_id = s.opportunity_id AND p.changed_ts < s.changed_ts ORDER BY p.changed_ts DESC LIMIT 1),'')\nORDER BY s.opportunity_id LIMIT 50`],
    ['Owner outside territory', `SELECT l.lead_id, l.territory AS lead_territory, r.rep_id, r.rep_name, r.territory AS rep_territory\nFROM lead l JOIN sales_rep r ON r.rep_id = l.assigned_rep_id\nWHERE r.role <> 'Queue' AND l.territory <> r.territory\nORDER BY l.lead_id LIMIT 50`],
  ];
  function sqlTab() {
    if (!canRun) return card('SQL console', [callout('warn', ico('lock', 16), h('b', null, ' Analyst and Admin only. '), 'The SQL console is a read-only window onto the runtime database for analysis. Your persona (', h('b', null, role), ') cannot run ad-hoc queries — the API returns 403.'), h('div', { class: 'muted mt-s', style: { fontSize: '12.5px' } }, 'Switch persona (top right) to Analyst or Admin to try it.')]);
    const ta = h('textarea', { rows: 9, spellcheck: 'false', style: { width: '100%', fontFamily: 'var(--mono)', fontSize: '12.5px', resize: 'vertical' } }); ta.value = S.sql || EXAMPLES[0][1];
    const out = h('div', { class: 'mt' });
    const run = async () => {
      S.sql = ta.value; btn.disabled = true; out.replaceChildren(h('div', { class: 'skeleton', style: { height: '80px' } })); const t0 = performance.now();
      try {
        const r = await api.post('/api/sql', { sql: ta.value }); const ms = Math.round(performance.now() - t0);
        out.replaceChildren(h('div', { class: 'row wrap', style: { marginBottom: '8px' } }, pill(`${fmt.int(r.rows.length)} row${r.rows.length === 1 ? '' : 's'}`, 'ok', 'check'), pill(`${ms} ms`, 'muted', 'clock'), r.rows.length >= r.truncated_at ? pill(`capped at ${r.truncated_at} rows`, 'warn', 'alert') : null),
          table({ columns: r.columns.map((c, i) => ({ label: c, num: r.rows.length && typeof r.rows[0][i] === 'number', render: (row) => { const v = row[i]; return v == null ? h('span', { class: 'muted' }, 'NULL') : /^(LEAD|OPP|CON|CO|REP|CMP)-/.test(String(v)) && c.match(/lead_id|opportunity_id/) ? h('a', { class: 'mono', href: (c === 'lead_id' || c === 'dup_lead') ? `#/lead/${v}` : `#/pipeline/${v}` }, String(v)) : String(v); } })), rows: r.rows, empty: 'Query returned no rows.' }));
      } catch (e) { out.replaceChildren(callout(e.status && e.status < 500 ? 'warn' : 'err', h('b', null, e.status ? `HTTP ${e.status}: ` : ''), String(e.message || e))); }
      btn.disabled = false;
    };
    const btn = h('button', { class: 'btn primary', onclick: run }, ico('play', 15), 'Run query');
    ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); });
    return card('SQL console', [
      callout('info', h('b', null, 'Read-only by construction. '), 'Only a single ', h('span', { class: 'mono' }, 'SELECT / WITH'), ' statement is accepted; it runs on a read-only SQLite connection with ', h('span', { class: 'mono' }, 'PRAGMA query_only'), ' and results are capped at 500 rows. The ground-truth database is a different file and is not reachable from here.'),
      h('div', { class: 'row wrap mt-s' }, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Examples:'), ...EXAMPLES.map(([l, q]) => h('span', { class: 'chip', onclick: () => { ta.value = q; S.sql = q; } }, l))),
      h('div', { class: 'mt-s' }, ta), h('div', { class: 'row mt-s' }, btn, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Ctrl + Enter to run · tables: ' + names.join(', ') + ', audit_log')), out,
    ], { sub: 'POST /api/sql · analyst, admin' });
  }

  // ================================================================================================ (g) ground truth
  function gt() {
    const v = S.val, counts = v?.ground_truth_counts || {}; const leak = v?.checks?.find((c) => /leak/i.test(c.name) && c.category === 'ground_truth');
    const fieldsTbl = (title, fields) => card(title, table({ columns: [{ label: 'Column', render: (f) => h('b', { class: 'mono', style: { fontWeight: 600 } }, f) }, { label: 'Meaning', render: (f) => h('span', { class: 't2' }, GT_DESC[f] || '') }], rows: fields }));
    return h('div', { class: 'col', style: { gap: '16px' } },
      callout('ok', h('b', null, 'Ground truth never feeds an input feature. '), 'Labels and planted-defect records live in a separate SQLite database (ground_truth.db) and separate files. Scoring, routing, de-duplication and every workflow endpoint open only the runtime database; only the evaluation and detector-comparison code opens the ground truth — to measure results, never to produce them.',
        leak ? h('div', { class: 'row mt-s' }, leak.status === 'pass' ? pill('validation: no label columns leak into input tables', 'ok', 'check') : pill('LEAK DETECTED', 'err', 'alert'), h('span', { class: 'mono muted', style: { fontSize: '11.5px' } }, leak.id)) : null),
      h('div', { class: 'grid g2' }, fieldsTbl('Anomaly ledger · ground_truth_fields', meta.ground_truth_fields), fieldsTbl('Outcome labels · outcome_fields', meta.outcome_fields)),
      card('Labelled population per issue type', Object.keys(counts).length ? [hbars({ rows: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n], i) => ({ label: fmt.title(k), value: n, sub: '', color: SERIES[i % 8], tip: `<b>${fmt.title(k)}</b><br>${fmt.int(n)} labelled<br><span class="k">${ISSUE_DESC[k] || ''}</span>` })), labelW: 190 }),
        h('div', { class: 'col mt-s', style: { gap: '3px', fontSize: '12px' } }, Object.keys(counts).map((k) => h('div', { class: 'muted' }, h('b', { class: 't2' }, fmt.title(k) + ': '), ISSUE_DESC[k] || ''))),
        h('div', { class: 'mt-s muted', style: { fontSize: '12px' } }, 'The detectors’ output is compared with these counts in the Validation tab (“observed = labelled”) and in ', h('a', { href: '#/exceptions' }, 'Exceptions'), '.')] : h('div', { class: 'empty' }, 'Validation summary not available.'), { sub: 'validation.ground_truth_counts' }));
  }

  // ================================================================================================ shell
  const TABS = [['overview', 'Overview & provenance'], ['dict', 'Data dictionary'], ['erd', 'ERD'], ['val', 'Validation'], ['repro', 'Reproducibility'], ['sql', 'SQL console'], ['gt', 'Ground truth']];
  const VIEWS = { overview, dict, erd, val: validation, repro, sql: sqlTab, gt };
  let tabsEl;
  function render() { content.replaceChildren(VIEWS[S.tab]()); }
  function setTab(k) { S.tab = k; tabsEl.replaceWith(tabsEl = tabs(TABS, k, (x) => { S.tab = x; render(); })); render(); }
  tabsEl = tabs(TABS, S.tab, (k) => { S.tab = k; render(); });
  render();
  return h('div', null, pageHead('Data & Lineage', 'Where the data came from, what every field means, how entities relate, whether it is valid, and that it can be regenerated byte-for-byte.',
    [h('a', { class: 'btn', href: '#/exceptions' }, icon('alert'), 'Exceptions'), h('a', { class: 'btn', href: '#/audit' }, icon('history'), 'Audit trail')]), tabsEl, content);
}

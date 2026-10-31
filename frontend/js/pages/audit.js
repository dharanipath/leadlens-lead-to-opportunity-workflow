import { h, api, fmt, card, kpi, pageHead, icon, pill, callout, chips, select, modal, act, toast, debounce, leadLink, oppLink } from '../lib.js';
import { hbars, SERIES } from '../charts.js';

const ico = (n, sz = 16) => { const e = icon(n); e.style.cssText = `width:${sz}px;height:${sz}px;flex:none`; return e; };
const ROLE_KIND = { prospect: 'info', ops: 'violet', agent: 'ok', analyst: 'warn', admin: 'err' };
const ACTION_LABEL = { lead_intake: 'Lead intake', consent_update: 'Consent update', assign_lead: 'Assign lead', advance_stage: 'Advance stage', convert_lead: 'Convert lead', complete_task: 'Complete task', task_complete: 'Complete task', rescore_lead: 'Re-score lead', log_activity: 'Log activity', publish_rules: 'Publish scoring rules' };

function entityLink(type, id) {
  if (!id) return h('span', { class: 'muted' }, '—');
  if (type === 'lead' || /^LEAD-/.test(id)) return leadLink(id);
  if (type === 'opportunity' || /^OPP-/.test(id)) return oppLink(id);
  if (type === 'contact' || /^CON-/.test(id)) return h('a', { class: 'mono', href: `#/consent/${id}` }, id);
  const m = /^(?:TASK|ACT)-(LEAD-\d{4}-\d{6})/.exec(id);
  if (m) return h('span', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'mono muted' }, id.replace(/LEAD-\d{4}-/, '…')), leadLink(m[1]));
  return h('span', { class: 'mono' }, id);
}

const parse = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return s; } };
function diffView(before, after) {
  const b = parse(before), a = parse(after);
  if (b == null && a == null) return h('div', { class: 'muted' }, 'No before/after payload was recorded for this entry.');
  const keys = [...new Set([...Object.keys(b && typeof b === 'object' ? b : {}), ...Object.keys(a && typeof a === 'object' ? a : {})])];
  const val = (v) => (v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const cell = (obj, k, side) => {
    const v = obj && typeof obj === 'object' ? obj[k] : undefined, other = (side === 'b' ? a : b)?.[k];
    const changed = JSON.stringify(v) !== JSON.stringify(other);
    return h('div', { class: 'mono', style: { fontSize: '12px', padding: '2px 8px', borderRadius: '5px', overflowWrap: 'anywhere', background: changed ? `color-mix(in srgb, ${side === 'b' ? 'var(--err)' : 'var(--ok)'} 13%, transparent)` : 'transparent', color: v === undefined ? 'var(--muted)' : 'var(--text)' } }, val(v));
  };
  return h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(110px, auto) 1fr 1fr', gap: '3px 10px', alignItems: 'start' } },
    h('div'), h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 650 } }, 'Before'), h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 650 } }, 'After'),
    ...(keys.length ? keys.flatMap((k) => [h('div', { class: 'mono muted', style: { fontSize: '12px', padding: '2px 0' } }, k), cell(b, k, 'b'), cell(a, k, 'a')])
      : [h('div'), h('div', { class: 'mono', style: { fontSize: '12px' } }, val(b)), h('div', { class: 'mono', style: { fontSize: '12px' } }, val(a))]));
}

export default async function audit({ role }) {
  let rows = (await api.get('/api/audit', { limit: 300 })).rows;
  const F = { outcome: 'all', action: '', q: '' };
  const root = h('div'); const listBox = h('div'); const kpiBox = h('div'); const chartBox = h('div');
  const isAdmin = role === 'admin';

  async function reload() { rows = (await api.get('/api/audit', { limit: 300 })).rows; paintAll(); }

  function paintKpis() {
    const ok = rows.filter((r) => r.outcome === 'ok').length, blocked = rows.filter((r) => r.outcome === 'blocked').length;
    const byAction = {}; rows.forEach((r) => { (byAction[r.action] ||= { ok: 0, blocked: 0 })[r.outcome === 'blocked' ? 'blocked' : 'ok']++; });
    kpiBox.replaceChildren(h('div', { class: 'grid g4' },
      kpi({ label: 'State changes (writes)', value: ok, sub: 'successful, each with before/after', ico: 'edit', color: 'var(--ok)' }),
      kpi({ label: 'Blocked attempts', value: blocked, sub: 'business rules enforced at the API', ico: 'shield', color: blocked ? 'var(--err)' : undefined }),
      kpi({ label: 'Distinct actions', value: Object.keys(byAction).length, sub: Object.keys(byAction).map((a) => ACTION_LABEL[a] || a).slice(0, 3).join(' · ') || 'none yet', ico: 'layers' }),
      kpi({ label: 'Block rate', raw: rows.length ? fmt.pct(blocked / rows.length, 0) : '—', sub: `of ${fmt.int(rows.length)} audited requests (latest 300)`, ico: 'chart' })));
    chartBox.replaceChildren(rows.length ? card('Audited actions', [hbars({ rows: Object.entries(byAction).sort((a, b) => (b[1].ok + b[1].blocked) - (a[1].ok + a[1].blocked)).map(([a, v], i) => ({ label: ACTION_LABEL[a] || fmt.title(a), value: v.ok + v.blocked, sub: v.blocked ? `${v.blocked} blocked` : '', color: SERIES[i % 8], tip: `<b>${ACTION_LABEL[a] || a}</b><br>${v.ok} ok · ${v.blocked} blocked` })), labelW: 160 }),
      h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, 'Counts include both successful changes and blocked rule violations, since both are audited.')], { sub: 'by action' }) : h('div'));
  }

  function paintList() {
    const q = F.q.toLowerCase();
    const list = rows.filter((r) => (F.outcome === 'all' || r.outcome === F.outcome) && (!F.action || r.action === F.action) && (!q || `${r.message} ${r.entity_id} ${r.action} ${r.actor_role}`.toLowerCase().includes(q)));
    if (!rows.length) {
      listBox.replaceChildren(card('Audit log', h('div', { class: 'empty' }, ico('history', 30), h('div', { style: { fontWeight: 650, margin: '8px 0 4px', color: 'var(--text)' } }, 'No audit entries yet'),
        h('div', { style: { maxWidth: '560px', margin: '0 auto' } }, 'Every state change (lead intake, consent update, assignment, conversion, stage move, task completion, rule publication) and every blocked business-rule violation is written here with who did it, when, and the before/after values. Try the ',
          h('a', { href: '#/portal' }, 'Prospect Portal'), ' or the ', h('a', { href: '#/workbench' }, 'Task Workbench'), ' — or attempt an out-of-territory assignment on ', h('a', { href: '#/routing' }, 'Routing'), ' — to generate entries.'))));
      return;
    }
    const tb = h('tbody');
    list.forEach((r) => {
      const blocked = r.outcome === 'blocked';
      const xr = h('tr', { class: 'xrow hidden' }, h('td', { colspan: 8, style: { background: 'var(--surface-2)' } }, h('div', { style: { padding: '6px 4px' } }, h('div', { class: 'row wrap', style: { marginBottom: '8px', gap: '8px' } }, h('b', null, `Audit #${r.audit_id}`), blocked ? pill('request refused — nothing changed', 'err', 'lock') : pill('applied', 'ok', 'check'), h('span', { class: 'muted', style: { fontSize: '12px' } }, r.message)), diffView(r.before_json, r.after_json))));
      const tr = h('tr', { class: 'click', onclick: (e) => { if (e.target.closest('a')) return; xr.classList.toggle('hidden'); } },
        h('td', { style: blocked ? { boxShadow: 'inset 3px 0 0 var(--err)', background: 'color-mix(in srgb, var(--err) 6%, transparent)' } : null, class: 'mono muted' }, `#${r.audit_id}`),
        h('td', { class: 'mono nowrap', style: blocked ? { background: 'color-mix(in srgb, var(--err) 6%, transparent)' } : null }, fmt.ts(r.ts)),
        h('td', { style: blocked ? { background: 'color-mix(in srgb, var(--err) 6%, transparent)' } : null }, pill(r.actor_role, ROLE_KIND[r.actor_role] || 'muted', 'user')),
        h('td', { class: 'nowrap', style: blocked ? { background: 'color-mix(in srgb, var(--err) 6%, transparent)' } : null }, ACTION_LABEL[r.action] || fmt.title(r.action)),
        h('td', { class: 'nowrap', style: blocked ? { background: 'color-mix(in srgb, var(--err) 6%, transparent)' } : null }, entityLink(r.entity_type, r.entity_id)),
        h('td', { style: blocked ? { background: 'color-mix(in srgb, var(--err) 6%, transparent)' } : null }, blocked ? pill('blocked', 'err', 'lock') : pill('ok', 'ok', 'check')),
        h('td', { style: Object.assign({ minWidth: '320px', fontSize: '12.5px' }, blocked ? { background: 'color-mix(in srgb, var(--err) 6%, transparent)' } : {}) }, r.message),
        h('td', { class: 'muted', style: blocked ? { background: 'color-mix(in srgb, var(--err) 6%, transparent)' } : null, title: 'Show before / after' }, (r.before_json || r.after_json) ? '▾' : ''));
      tb.append(tr, xr);
    });
    if (!list.length) tb.append(h('tr', null, h('td', { colspan: 8 }, h('div', { class: 'empty' }, 'No entries match the filters.'))));
    listBox.replaceChildren(h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['#', 'Time (UTC)', 'Role', 'Action', 'Entity', 'Outcome', 'Message', ''].map((x) => h('th', null, x)))), tb)),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } }, `${list.length} of ${rows.length} entries · click a row to expand the before / after values · blocked rows are highlighted`));
  }

  const actions = [...new Set(rows.map((r) => r.action))].sort();
  const search = h('input', { type: 'search', placeholder: 'Search message, entity, role…', oninput: debounce((e) => { F.q = e.target.value; paintList(); }, 200), style: { minWidth: '240px' } });
  const filters = h('div', { class: 'row wrap', style: { margin: '0 0 12px' } },
    chips([['all', 'All'], ['ok', 'OK (changes)'], ['blocked', 'Blocked (rules enforced)']], 'all', (k) => { F.outcome = k; paintList(); }),
    select(actions.map((a) => [a, ACTION_LABEL[a] || a]), '', (v) => { F.action = v; paintList(); }, { placeholder: 'All actions' }), search);
  function paintAll() { paintKpis(); paintList(); }

  const resetBtn = isAdmin ? h('button', { class: 'btn danger', onclick: () => {
    modal({ title: 'Reset demo data?', body: h('div', { class: 'col' }, callout('warn', h('b', null, 'This rebuilds the runtime database from the seed CSVs. '), 'All changes made in this session (new leads, consent events, assignments, stage moves) and the entire audit log will be discarded. The generated seed data itself is not modified.'),
      h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Use it to return to a clean state before a demo. This takes a few seconds.')),
    actions: [{ label: 'Cancel', close: true }, { label: 'Reset demo data', kind: 'danger', onClick: async () => {
      const r = await act(() => api.post('/api/reset'), (x) => x.message || 'Runtime database rebuilt'); if (!r) return false; await reload(); return true; } }] });
  } }, ico('refresh', 15), 'Reset demo data') : null;

  paintAll();
  return h('div', null,
    pageHead('Audit trail', 'Every state change and every blocked business-rule violation is recorded with actor, time, entity and before/after values — the evidence that rules are enforced, not just displayed.',
      [h('button', { class: 'btn', onclick: async () => { await reload(); toast('Audit log refreshed'); } }, ico('refresh', 15), 'Refresh'), resetBtn, !isAdmin ? h('span', { class: 'muted', style: { fontSize: '12px', alignSelf: 'center' }, title: 'Only the System Administrator can reset' }, 'Reset: admin only') : null]),
    kpiBox, rows.length ? h('div', { class: 'grid g-12 mt' }, chartBox, card('Traceability', h('div', { class: 'col t2', style: { fontSize: '13px' } },
      h('div', null, 'The audit log is the evidence that business rules are ', h('b', null, 'enforced'), ', not just displayed:'),
      h('ul', { style: { margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('li', null, h('b', null, 'OK rows'), ' show who changed what and the state before and after (expand a row).'), h('li', null, h('b', null, 'Blocked rows'), ' show the rule that fired (routing, stage-gap, consent, lifecycle …) and the request that was refused. Nothing was changed.'),
        h('li', null, 'Entity IDs link back to the lead, opportunity or contact for full context.')),
      h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Latest 300 entries, newest first.')), { sub: 'why this page matters' })) : null,
    h('div', { class: 'mt' }, rows.length ? filters : null, listBox));
}

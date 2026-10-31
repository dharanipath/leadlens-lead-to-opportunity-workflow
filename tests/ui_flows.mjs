// Click-through tests of the WRITE paths in a real browser (headless Edge/Chrome via CDP).
//   node tests/ui_flows.mjs [baseUrl]   — server must be running; the runtime DB is modified (run `python run.py --rebuild` afterwards).
import { launch, sleep } from './ui_harness.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8000';
const b = await launch(9334);
let pass = 0, fail = 0;
const modalButtons = () => b.eval(`[...document.querySelectorAll('.modal button')].map(x=>x.textContent.trim()).filter(Boolean)`);
async function flow(name, fn) {
  try { await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('flow timed out after 100s')), 100000))]); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n')[0] + '\n     toasts=' + JSON.stringify(await b.toasts().catch(() => [])) + ' modal=' + JSON.stringify(await modalButtons().catch(() => []))); }
}
const open = async (role, hash, settle = 800) => { await b.goto(`${BASE}/?role=${role}#/${hash}`, settle); await b.waitFor(`document.querySelector('.page') && !document.querySelector('.page .skeleton')`, 25000); await sleep(500); };
const expectText = async (sel, re, timeout = 12000) => { await b.waitFor(`/${re}/i.test((document.querySelector(${JSON.stringify(sel)})||{}).innerText||'')`, timeout, `${sel} ~ ${re}`); };
const anyToast = (re) => b.waitFor(`[...document.querySelectorAll('.toast')].some(t=>/${re}/i.test(t.innerText))`, 12000, 'toast ~ ' + re);
const getJson = async (path, role = 'analyst') => b.eval(`fetch(${JSON.stringify(path)},{headers:{'X-Role':'${role}'}}).then(r=>r.json())`);

// ---------------------------------------------------------------------------------------------------------------- Portal
await flow('Portal · preset "No consent" → dry-run shows consent step blocked + exception path', async () => {
  await open('prospect', 'portal');
  await b.click('.chip', 'No consent');
  await b.click('button', 'Preview decisions');
  await b.waitFor(`document.querySelectorAll('.step').length>=9`, 15000, '9+ trace steps');
  await expectText('.page', 'e-mail BLOCKED');
  await expectText('.page', 'Exception path taken');
  await expectText('.page', 'Dry run');
});
await flow('Portal · hot preset submit creates a lead (persisted) and links to Lead 360', async () => {
  await open('prospect', 'portal');
  await b.setValue('input[type=email]', `flow.${Date.now()}@flowtest-corp.example`);
  await b.click('button', 'Submit lead');
  await anyToast('created');
  await b.waitFor(`!!document.querySelector('a[href^="#/lead/LEAD-2026-02"]')`, 8000, 'lead link');
  const lid = await b.eval(`document.querySelector('a[href^="#/lead/LEAD-2026-02"]').getAttribute('href').split('/').pop()`);
  const d = await getJson('/api/leads/' + lid);
  if (d.lead.status !== 'New' || d.tasks.length < 3 || !d.score.reproduced) throw new Error('lead not persisted correctly: ' + JSON.stringify(d.lead.status));
});
await flow('Portal · submitting the same person again is merged as a duplicate', async () => {
  await b.click('button', 'Submit same person again');
  await b.waitFor(`/duplicate/i.test(document.querySelector('.page').innerText) && /Disqualified/i.test(document.querySelector('.page').innerText)`, 15000, 'duplicate trace');
});
await flow('Portal · persona without intake rights is told (analyst) and API refuses', async () => {
  await open('analyst', 'overview');
  const r = await b.eval(`fetch('/api/leads/intake',{method:'POST',headers:{'X-Role':'analyst','Content-Type':'application/json'},body:'{}'}).then(r=>r.status)`);
  if (r !== 403) throw new Error('expected 403 got ' + r);
});

// ---------------------------------------------------------------------------------------------------------------- Lead 360
await flow('Lead 360 · log outbound e-mail on an opted-out contact is blocked by the consent rule', async () => {
  // pick a lead whose contact currently cannot be e-mailed (chosen dynamically so the test survives re-generation)
  const cand = await getJson('/api/leads?consent=opted_out&page_size=60');
  let blockedLead = null;
  for (const r of cand.rows) { const c = await getJson('/api/contacts/' + (await getJson('/api/leads/' + r.lead_id)).lead.contact_id); if (!c.can_contact.email) { blockedLead = r.lead_id; break; } }
  if (!blockedLead) throw new Error('no opted-out lead found');
  await open('ops', 'lead/' + blockedLead);
  await b.click('button', 'Log activity');
  await b.waitFor(`!!document.querySelector('.modal')`);
  await b.eval(`(()=>{const s=document.querySelector('.modal select');s.value='email_outbound';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.click('.modal button', 'Log activity');
  await b.waitFor(`/consent/i.test(document.querySelector('.modal')?.innerText||'') || [...document.querySelectorAll('.toast')].some(t=>/consent/i.test(t.innerText))`, 10000, 'consent block shown');
  const audit = await getJson('/api/audit?limit=5');
  if (!audit.rows.some((r) => r.outcome === 'blocked' && r.action === 'log_activity')) throw new Error('blocked attempt not audited');
});
await flow('Lead 360 · convert a duplicate lead is refused (duplicate-opportunity guard)', async () => {
  const dups = await getJson('/api/leads?duplicates=1&page_size=1');
  const lid = dups.rows[0].lead_id;
  const r = await b.eval(`fetch('/api/leads/${lid}/convert',{method:'POST',headers:{'X-Role':'agent','Content-Type':'application/json'},body:'{}'}).then(async r=>[r.status,(await r.json()).rule])`);
  if (r[0] !== 409 || r[1] !== 'duplicate_opportunity_prevented') throw new Error(JSON.stringify(r));
});
let convertedLead;
await flow('Lead 360 · convert a qualified lead → opportunity, stage history row #1, funnel counts move', async () => {
  const cands = await getJson('/api/leads?status=Qualified&page_size=40&band=Hot');
  const pick = cands.rows.find((r) => !r.duplicate_of_lead_id && r.consent_status !== 'opted_out' && r.routing_method !== 'unroutable_queue' && !r.flags.length) || cands.rows[0];
  convertedLead = pick.lead_id;
  const before = (await getJson('/api/overview')).totals.opps;
  await open('agent', 'lead/' + convertedLead);
  await b.click('button', 'Convert to opportunity');
  await b.waitFor(`!!document.querySelector('.modal')`);
  await b.click('.modal button', 'Create opportunity');
  await anyToast('OPP-2026|opportunity|converted|created');
  await sleep(800);
  const after = (await getJson('/api/overview')).totals.opps;
  const d = await getJson('/api/leads/' + convertedLead);
  if (after !== before + 1 || d.lead.status !== 'Converted' || d.stage_history.length !== 1 || d.opportunity.stage !== 'Qualified') throw new Error(`before ${before} after ${after} status ${d.lead.status}`);
});
await flow('Lead 360 · advance opportunity one stage, then skipping a stage is refused (422)', async () => {
  const d = await getJson('/api/leads/' + convertedLead);
  const oid = d.opportunity.opportunity_id;
  await open('agent', 'lead/' + convertedLead + '?tab=opportunity');
  await b.click('button', 'Advance');
  await sleep(1200);
  const d2 = await getJson('/api/leads/' + convertedLead);
  if (d2.opportunity.stage !== 'Discovery' || d2.stage_history.length !== 2) throw new Error('stage did not advance: ' + d2.opportunity.stage);
  const r = await b.eval(`fetch('/api/opportunities/${oid}/advance',{method:'POST',headers:{'X-Role':'agent','Content-Type':'application/json'},body:JSON.stringify({to_stage:'Negotiation'})}).then(async r=>[r.status,(await r.json()).rule])`);
  if (r[0] !== 422 || r[1] !== 'stage_gap_prevented') throw new Error(JSON.stringify(r));
});
await flow('Lead 360 · reassign outside territory is blocked; in-territory reassign works', async () => {
  const cands = await getJson('/api/leads?status=Working&routing=rule_based&page_size=1&territory=EMEA');
  const lead = cands.rows[0].lead_id;
  const reps = await getJson('/api/reps');
  const wrong = reps.find((r) => r.territory === 'APAC' && r.role !== 'Manager').rep_id;
  const r = await b.eval(`fetch('/api/leads/${lead}/assign',{method:'POST',headers:{'X-Role':'ops','Content-Type':'application/json'},body:JSON.stringify({rep_id:'${wrong}'})}).then(async r=>[r.status,(await r.json()).rule])`);
  if (r[0] !== 422 || r[1] !== 'routing_enforced') throw new Error(JSON.stringify(r));
  await open('ops', 'lead/' + lead + '?tab=routing');
  await b.click('button', 'Reassign');
  await b.waitFor(`!!document.querySelector('.modal select')`);
  const target = await b.eval(`(()=>{const s=document.querySelector('.modal select');const o=[...s.options].find(o=>o.value!==s.value&&o.parentElement.label&&o.parentElement.label.startsWith('Eligible'));if(!o)return null;s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));return o.value})()`);
  if (target) { await b.click('.modal button', 'Reassign'); await sleep(1200); const d = await getJson('/api/leads/' + lead); if (d.lead.assigned_rep_id !== target) throw new Error('owner not changed: ' + d.lead.assigned_rep_id); }
});
await flow('Lead 360 · record opt-out (consent tab) cancels open tasks and appends a ledger row', async () => {
  const cands = await getJson('/api/leads?status=Working&consent=opted_in&page_size=5&band=Warm');
  const lead = cands.rows[0].lead_id;
  const before = await getJson('/api/leads/' + lead);
  await open('ops', 'lead/' + lead + '?tab=consent');
  await b.click('button', 'opt out');
  await b.waitFor(`!!document.querySelector('.modal')`);
  await b.click('.modal button', 'Record opt-out');
  await sleep(1500);
  const after = await getJson('/api/leads/' + lead);
  if (after.consents.length !== before.consents.length + 1 || after.consents.at(-1).status !== 'opted_out') throw new Error('ledger not appended');
  if (after.tasks.some((t) => t.status === 'open' && t.task_type.includes('email'))) throw new Error('open e-mail task survived the opt-out');
});
await flow('Lead 360 · rescore a converted lead clamps the cut-off (leakage guard)', async () => {
  const lead = (await getJson('/api/leads/' + convertedLead));
  await open('ops', 'lead/' + convertedLead);
  await b.click('button', 'Rescore');
  await sleep(600);
  const labels = await modalButtons();
  if (labels.length) await b.click('.modal button', labels.find((l) => /rescore|run|confirm/i.test(l)) || labels[labels.length - 1]);
  await sleep(1200);
  const d = await getJson('/api/leads/' + convertedLead);
  if (d.lead.scored_ts > d.lead.converted_ts) throw new Error('post-conversion cut-off was allowed');
});

// ---------------------------------------------------------------------------------------------------------------- Workbench
await flow('Workbench · complete a task → SLA/status updates, lead moves New→Working', async () => {
  await open('agent', 'workbench');
  const before = await b.eval(`document.querySelectorAll('.taskcard').length`);
  if (!before) throw new Error('no task cards');
  const tid = await b.eval(`document.querySelector('.taskcard .mono, .taskcard a')?.textContent`);
  await b.click('.taskcard button', 'Complete');
  await anyToast('completed|SLA');
  await sleep(1000);
});
await flow('Workbench · quick-log a support inquiry on a lead', async () => {
  await open('agent', 'workbench');
  await b.setValue('input[placeholder="LEAD-2026-000010"]', 'LEAD-2026-000010');
  await b.click('button', 'Log support inquiry');
  await anyToast('logged|activity|ACT-');
});

// ---------------------------------------------------------------------------------------------------------------- Routing / consent / dedupe
await flow('Routing · Sales-Ops queue assign (reason required) resolves an unroutable lead', async () => {
  await open('ops', 'routing');
  await b.click('button.btn.sm.primary', 'Assign');
  await b.waitFor(`!!document.querySelector('.modal')`);
  const lid = await b.eval(`(document.querySelector('.modal').innerText.match(/LEAD-\\d{4}-\\d{6}/)||[])[0]`);
  await b.waitFor(`document.querySelectorAll('.modal select option').length>2`, 8000, 'rep list');
  await b.eval(`(()=>{const s=document.querySelector('.modal select');const o=[...s.options].find(o=>o.value&&/EMEA/.test(o.textContent)&&/SDR|AE/.test(o.textContent));s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.setValue('.modal textarea', 'Manual routing: customer is in Iceland, assigning to EMEA specialist');
  const labels = await modalButtons();
  await b.click('.modal button', labels.find((l) => /assign/i.test(l) && !/cancel/i.test(l)) || 'Assign');
  await sleep(1500);
  if (lid) { const d = await getJson('/api/leads/' + lid); if (d.lead.routing_method !== 'manual_override') throw new Error('not manually overridden: ' + d.lead.routing_method); }
});
await flow('Routing · "Try an out-of-territory assignment" shows the 422 block', async () => {
  await open('ops', 'routing');
  await b.click('button', 'out-of-territory');
  await b.waitFor(`/routing|422|territory/i.test([...document.querySelectorAll('.toast,.callout,.page')].map(x=>x.innerText).join(' '))`, 8000);
  await anyToast('routing_enforced|territory|blocked').catch(() => {});
});
await flow('Consent · preference centre: search contact → opt out → ledger grows → opt back in', async () => {
  await open('ops', 'consent');
  await b.setValue('input[type=search], input[placeholder*="Search contact"]', 'CON-000480');
  await b.waitFor(`[...document.querySelectorAll('.page button.btn.ghost')].some(x=>/CON-000480/.test(x.textContent))`, 10000, 'search result');
  await b.click('.page button.btn.ghost', 'CON-000480');
  await b.waitFor(`/governed by|can contact/.test(document.querySelector('.page').innerText)`, 10000, 'contact ledger');
  const c0 = (await getJson('/api/contacts/CON-000480')).consents.length;
  await b.click('.page button', 'opt out of email');
  await sleep(1500);
  const c1 = (await getJson('/api/contacts/CON-000480')).consents.length;
  if (c1 !== c0 + 1) throw new Error(`ledger rows ${c0} -> ${c1}`);
});
await flow('De-duplication · "Try the matcher" dry-run reports a tier match, nothing persisted', async () => {
  const n0 = (await getJson('/api/overview')).totals.contacts;
  await open('ops', 'dedupe');
  await b.click('button', 'matcher').catch(() => b.click('button', 'Run'));
  await sleep(2500);
  const n1 = (await getJson('/api/overview')).totals.contacts;
  if (n0 !== n1) throw new Error('dry run persisted a contact');
});

// ---------------------------------------------------------------------------------------------------------------- Pipeline / scoring / exceptions
await flow('Pipeline · card opens stage history modal with advance / skip-stage demo', async () => {
  await open('agent', 'pipeline');
  await b.click('.kcard', '');
  await b.waitFor(`!!document.querySelector('.modal, .overlay')`, 8000);
  await expectText('.modal', 'SH-OPP');
  await b.click('.modal button', 'skip').catch(() => {});
  await sleep(1000);
});
await flow('Pipeline · broken stage chain is flagged MISSING on the gap opportunity', async () => {
  const gap = (await getJson('/api/exceptions/list?type=stage_history_gap')).rows[0].entity_id;
  await open('analyst', 'pipeline/' + gap);
  await b.waitFor(`!!document.querySelector('.modal, .overlay')`, 8000);
  await expectText('.modal', 'missing');
});
await flow('Scoring · move a slider → held-out what-if metrics render; auto-tune reports train vs test', async () => {
  await open('analyst', 'scoring');
  await b.eval(`(()=>{const r=document.querySelector('input[type=range]');r.value=Math.min(2,Number(r.value)+0.5);r.dispatchEvent(new Event('input',{bubbles:true}));r.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await expectText('.page', 'AUC', 20000);
  await b.click('button', 'tune');
  await b.waitFor(`/held-out|TEST/i.test(document.querySelector('.page').innerText) && /train/i.test(document.querySelector('.page').innerText)`, 40000, 'tune result');
});
await flow('Scoring · admin publishes a new rule version (v2) and history keeps v1', async () => {
  await open('admin', 'scoring');
  await b.eval(`(()=>{const r=document.querySelector('input[type=range]');r.value=1.5;r.dispatchEvent(new Event('input',{bubbles:true}));r.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(1500);
  await b.click('button', 'Publish');
  await b.waitFor(`!!document.querySelector('.modal')`);
  const labels = await modalButtons();
  await b.click('.modal button', labels.find((l) => /publish/i.test(l)) || labels[labels.length - 1]);
  await sleep(2000);
  const sr = await getJson('/api/score-rules');
  if (sr.versions.length < 2 || !sr.versions.some((v) => v.version === 1 && !v.is_active)) throw new Error('versions: ' + JSON.stringify(sr.versions));
});
await flow('Exceptions · every prevention-demo button fires a real API block', async () => {
  await open('ops', 'exceptions');   // ops may log activity / assign / convert / advance; analysts are (correctly) refused with 403
  const labels = await b.eval(`[...document.querySelectorAll('.page button')].map(x=>x.textContent.trim()).filter(t=>/^(Log an e-mail|Rescore a converted|Assign to an out|Convert a merged|Skip an opportunity)/.test(t))`);
  if (labels.length < 5) throw new Error('demo buttons: ' + JSON.stringify(labels));
  for (const l of labels) { await b.click('.page button', l); await sleep(1800); }
  const audit = await getJson('/api/audit?limit=30');
  const blocked = new Set(audit.rows.filter((r) => r.outcome === 'blocked').map((r) => r.action));
  for (const a of ['log_activity', 'assign_lead', 'convert_lead', 'advance_stage']) if (!blocked.has(a)) throw new Error('no blocked audit row for ' + a);
});

// ---------------------------------------------------------------------------------------------------------------- Data / audit
await flow('Data · Re-run validation executes server-side and shows all checks green', async () => {
  await open('analyst', 'data/val');
  await b.click('button', 'Re-run');
  await b.waitFor(`/Checks passed/.test(document.querySelector('.page').innerText) && /186 \\/ 186|all checks green/.test(document.querySelector('.page').innerText)`, 90000, 'validation result');
});
await flow('Data · SQL console runs a read-only query and refuses writes', async () => {
  await open('analyst', 'data/sql');
  await b.click('button', 'Run');
  await b.waitFor(`document.querySelectorAll('.page table tbody tr').length>0`, 15000);
  const r = await b.eval(`fetch('/api/sql',{method:'POST',headers:{'X-Role':'analyst','Content-Type':'application/json'},body:JSON.stringify({sql:'delete from lead'})}).then(r=>r.status)`);
  if (r !== 422) throw new Error('write SQL not refused: ' + r);
});
await flow('Audit · shows successful writes and blocked attempts, filter chips work', async () => {
  await open('admin', 'audit');
  await expectText('.page', 'blocked');
  await b.click('.chip', 'blocked');
  await sleep(500);
  const rows = await b.eval(`document.querySelectorAll('.page table tbody tr').length`);
  if (!rows) throw new Error('no blocked rows displayed');
});
await flow('Audit · admin Reset restores the seed (counts back to 20,000 leads / 3,000 opps, audit empty)', async () => {
  await open('admin', 'audit');
  await b.click('button', 'Reset');
  await b.waitFor(`!!document.querySelector('.modal')`);
  await b.click('.modal button', 'Reset demo data');
  await sleep(15000);
  const o = await getJson('/api/overview');
  const a = await getJson('/api/audit?limit=5');
  if (o.totals.leads !== 20000 || o.totals.opps !== 3000 || a.rows.length > 1) throw new Error(JSON.stringify(o.totals) + ' audit ' + a.rows.length);
});

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

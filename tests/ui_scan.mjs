// Loads every screen under every persona in a real browser and reports render failures / console errors.
//   node tests/ui_scan.mjs [baseUrl]      (server must be running)
import { launch, sleep } from './ui_harness.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8000';
const PAGES = ['portal', 'overview', 'leads', 'lead/LEAD-2026-000010', 'workbench', 'pipeline', 'pipeline/OPP-2026-000010', 'scoring', 'routing', 'campaigns', 'consent', 'dedupe',
  'exceptions', 'evaluation', 'data', 'data/dict', 'data/erd', 'data/val', 'data/repro', 'data/sql', 'data/gt', 'audit'];
const ROLES = ['prospect', 'ops', 'agent', 'analyst', 'admin'];
const EXPECTED_NOISE = /status of (403|409|422)|Failed to load resource|message channel closed/;

const b = await launch();
let bad = 0, n = 0;
for (const role of ROLES) {
  for (const page of PAGES) {
    n++;
    await b.goto(`${BASE}/?role=${role}#/${page}`, 700);
    try { await b.waitFor(`document.querySelector('.page') && !document.querySelector('.page .skeleton')`, 20000); } catch (e) { console.log(`FAIL ${role} #/${page}: still loading`); bad++; continue; }
    await sleep(400);
    const txt = await b.text('.page');
    const crash = /Could not render/.test(txt);
    const errs = b.logs.filter((l) => !EXPECTED_NOISE.test(l.text));
    const blank = txt.trim().length < 40;
    if (crash || errs.length || blank) { bad++; console.log(`FAIL ${role} #/${page}: ${crash ? txt.match(/Could not render[^\n]*\n?[^\n]*/)[0] : blank ? 'blank page' : ''} ${errs.map((e) => e.text).join(' | ').slice(0, 300)}`); }
  }
}
await b.close();
console.log(`${n - bad}/${n} screens rendered cleanly`);
process.exit(bad ? 1 : 0);

# LeadLens — Lead-to-Opportunity Intelligence

A complete full-stack solution for the workflow **score leads from fit, intent and engagement → assign follow-ups → track progression to
opportunity outcomes**. It generates a reproducible synthetic CRM (20,000 leads / 10,000 contacts / 5,000 companies / 3,000 opportunities),
enforces the business rules in a live API, and exposes every decision, exception and metric in a web UI.

* **Backend** — Python 3 standard library only (HTTP server + SQLite). No `pip install` needed.
* **Frontend** — dependency-free ES-module single-page app (custom SVG charts, dark/light themes, role-aware navigation).
* **Data** — deterministic generator (`seed = 20261022`), validator, reproducibility check, data dictionary, ground truth kept in a separate database.

## Quick start

```bash
python run.py                  # generates data/full on first run (~30 s), builds SQLite, opens http://127.0.0.1:8000
python run.py --scale starter  # 2,000-lead starter dataset, same generator
python run.py --rebuild        # discard demo edits and rebuild the runtime DB from the seed CSVs
```

Requirements: Python 3.11+ (developed on 3.13). Nothing else.

Dataset only:

```bash
python generator/generate.py --scale full --out data/full            # exact command used for the shipped data
python generator/generate.py --leads 20000 --contacts 10000 --companies 5000 --opps 3000 --seed 20261022 --out data/custom
python generator/validate.py data/full                               # 186 checks → data/full/validation_summary.json
python generator/reproduce.py --scale full --reference data/full     # regenerate twice (different PYTHONHASHSEED) and compare SHA-256
python -m unittest discover -s tests -v                              # unit + integration tests
```

## Submission documents (transparency & reasoning)

| Document | Contents |
|---|---|
| [`AI_USAGE.md`](AI_USAGE.md) | Tools used, where AI accelerated the work, where the project relies on it, defects the AI introduced and how they were caught, what was validated and how, and a section for the author's own review notes |
| [`PROMPT_HISTORY.md`](PROMPT_HISTORY.md) | Every prompt given to the LLM (verbatim) and the delegation prompts used for parallel sub-agents |
| [`REASONING.md`](REASONING.md) | Problem understanding, assumptions, key decisions and trade-offs, testing approach, how we know it works, limitations |
| [`docs/problem_statement.md`](docs/problem_statement.md) | The problem statement as provided |
| [`docs/business_rules.md`](docs/business_rules.md) | The documented scoring, routing, consent, de-dup, task, outcome and edge-case rules |

## Personas (top-right switcher; the API enforces RBAC with the `X-Role` header)

| Persona | Landing page | What they do |
|---|---|---|
| Customer / prospect | Prospect Portal | submit interest, grant/withdraw consent, watch the full decision trace |
| Marketing / Sales Ops | Overview | scoring rules & what-if, routing, campaigns, consent, de-dup, exceptions |
| Support / Sales agent | Task Workbench | complete SLA-bound follow-ups (consent-guarded), log activity, move deals |
| Analyst | Overview | funnel & reconciliation, exceptions vs ground truth, held-out evaluation, SQL console |
| System administrator | Overview | publish score-rule versions, validation, reproducibility, audit trail, reset |

## Screens

Prospect Portal · Overview (KPIs, funnel, reconciliation, heat-map) · Leads · **Lead 360** (score explainability, timeline, consent ledger, routing decision, opportunity & stage history) ·
Task Workbench · Pipeline (Kanban + stage history with gap detection) · Scoring Rules (transparent weights, what-if simulator, train-only auto-tune, publish new version) ·
Routing (territory × product coverage, Sales-Ops queue) · Campaigns · Consent (ledger + preference centre) · De-duplication · Exceptions (5 labelled edge cases, detector precision/recall,
live prevention demos) · Held-out Evaluation (AUC, lift, calibration, leakage audit) · Data & Lineage (dictionary, ERD, validation, reproducibility, provenance, SQL) · Audit Trail.

## Requirement traceability (problem statement → where it is satisfied)

| Requirement | Implementation |
|---|---|
| Entities: Company, Contact, Lead, Campaign, Activity, Consent, ScoreRule, SalesRep, Task, Opportunity, StageHistory | `generator/schema.py` (+ bridges `rep_product`, `lead_campaign`, history `lead_status_history`) |
| PK for every entity, FK for every relationship, cardinality, optional relationships, effective dates, lifecycles | `docs/data_dictionary.md`, `docs/erd.md`, `docs/schema.sql`; UI → Data & Lineage → Dictionary / ERD |
| Bridge tables for N:M; event history for state changes; validate joins | `rep_product`, `lead_campaign`; `consent`, `lead_status_history`, `stage_history`, `audit_log` are append-only; 40+ FK/join checks in `validate.py` |
| ID conventions `CO-000001`, `CON-000001`, `LEAD-2026-000001`, `ACT-<lead-id>-001`, `OPP-2026-000001`, `TASK-<lead-id>-001` | `core/util.py`; regex-validated per table; IDs assigned chronologically, never reused |
| Step 1 data dictionary (type, required, allowed values, units, uniqueness, validation) | generated from schema → `docs/data_dictionary.md|json` |
| Steps 2–3 parents first, deterministic IDs, domain logic | `generator/generate.py` (9 documented phases) |
| Step 4 volume 20k/10k/5k/3k, duplicates, opt-outs, stale, high-score non-converters, fixed seed, parameterised scale | `--scale full|starter`, `--leads/--contacts/--companies/--opps`; shipped `data/full/manifest.json` |
| Step 5 baseline first, then labelled edge cases (5 required) | `docs/business_rules.md §7`; counts 120 / 60 / 100 / 40 / 50 |
| Step 6 derived values from sources | score from rules, `amount = seats × price × (1−discount)`, SLA flags, statuses, `account_status`, `last_activity_ts`, consent state |
| Step 7 separate ground truth, never leaked | `data/full/ground_truth/` (CSV + JSON) and a **separate SQLite file**; validator asserts no label columns in inputs |
| Step 8 validation (PK, FK, enums, date order, arithmetic, lifecycle, duplicates) | `generator/validate.py` → 186 checks, UI → Data & Lineage → Validation |
| Step 9 CSV/JSON/SQL + README, dictionary, command, seed, source manifest, validation summary | `data/full/{csv,json,sql}`, `manifest.json`, `validation_summary.json`, `docs/` |
| Step 10 regenerate twice, compare counts/checksums | `generator/reproduce.py` → `reproducibility_report.json` (also in UI) |
| Rules: master data first; create company/contact; leads with source + consent; activity histories; transparent score weights; dedupe; route by territory/product; follow-up tasks; stage transitions + won/lost reasons | `docs/business_rules.md`, `core/*`, `backend/workflow.py` |
| Outcomes from documented rules, not random | propensity formula + hash-based deterministic noise (`business_rules.md §6`) |
| Acceptance: **score reproducible** | every one of 20,000 stored scores is recomputed from ScoreRule + activity (validation check; Lead 360 shows ✓ per lead) |
| Acceptance: **consent and routing enforced** | consent gate (HTTP 409) on task completion/outreach; routing guard (HTTP 422); detectors find only the labelled violations |
| Acceptance: **funnel reconciles** | Overview → Reconciliation panel + validation checks (Σ status = leads; converted = opportunities; open+won+lost = opps; monotone funnel) |
| Acceptance: **evaluation uses held-out outcomes** | deterministic 70/30 split; headline metrics on test only; train-only tuner reports honest test delta; leakage audit |
| Actors: prospect, marketing/sales ops, support agent, analyst, admin | persona switcher + RBAC (`backend/workflow.py PERMISSIONS`) |
| Expose key decisions & exceptions, traceability, measurable outputs | decision trace on every intake, Lead 360 timeline, audit log (incl. blocked attempts), KPIs/evaluation |
| Lawful provenance | synthetic only; reserved `.example` e-mail domains, fictional phone numbers; no external data — see `data/full/manifest.json → sources` |

## Architecture

```
core/        shared rules (scoring, routing+consent, de-dup, config)  ← used by generator, validator AND backend
generator/   schema (single source of truth) · generate.py · validate.py · reproduce.py · docs.py
backend/     db.py (SQLite loader, separate ground-truth DB) · analytics.py (reads) · workflow.py (writes + enforcement)
             detectors.py (exception rules) · evaluation.py (held-out metrics, what-if, tuner) · server.py (HTTP, RBAC header)
frontend/    index.html · css/app.css (design system) · js/{lib,charts,app}.js · js/pages/*.js (one module per screen)
data/        full/ (csv json sql ground_truth docs manifest validation reproducibility) · starter/ · runtime.db · ground_truth.db
docs/        data dictionary · ERD · DDL · business rules
tests/       unittest suite
```

### Key API endpoints (all JSON; `X-Role` header selects the persona)

`GET /api/overview · /api/leads · /api/leads/{id} · /api/tasks · /api/reps · /api/opportunities/board · /api/campaigns · /api/dedupe · /api/consent · /api/routing · /api/score-rules · /api/exceptions · /api/evaluation · /api/meta · /api/validation · /api/reproducibility · /api/audit`
`POST /api/leads/intake[?dry_run=1] · /api/leads/{id}/convert|assign|rescore|activity · /api/tasks/{id}/complete · /api/consent · /api/opportunities/{id}/advance · /api/score-rules/publish · /api/evaluation/simulate|tune · /api/sql · /api/reset`

Blocked business-rule violations return **409/422** with `{error, rule}` and are recorded in `audit_log` as `blocked`:
`consent_enforced`, `routing_enforced`, `duplicate_opportunity_prevented`, `stage_gap_prevented`, `lifecycle_enforced`.

## Data at a glance (seed 20261022, as-of 2026-10-22)

20,000 leads · 10,000 contacts (500 planted duplicates) · 5,000 companies · 3,000 opportunities · 40 campaigns · 34 reps + routing queue · 265,101 activities ·
30,559 tasks · 10,486 consent events · 11,874 stage-history rows · 51,741 lead-status events · 370 injected edge cases (+ 500 duplicate contacts, 1,200 duplicate leads,
2,572 stale leads and 639 high-score non-converters labelled in the ground truth).
Hot / Warm / Cold ≈ 7 % / 43 % / 50 %; lead→opportunity ≈ 16 % of unique leads; win rate ≈ 41 % of closed deals; held-out (test) AUC ≈ 0.77; campaign cost-per-lead ≈ $730 and blended ROI ≈ +156 %.

## Testing

```bash
python -m unittest discover -s tests -v    # rules, de-dup tiers, routing, consent, generator validation, byte-identical regeneration
node tests/ui_scan.mjs                     # opens all 22 screens under all 5 personas in headless Edge/Chrome and fails on any render/console error (server running)
node tests/ui_flows.mjs                    # clicks through the write paths (intake, convert, advance, consent, reassign, rescore, publish, validation re-run, reset) and asserts DB effects
```

`ui_*.mjs` drive a real browser through the Chrome DevTools protocol with no dependencies (Node 22+). They modify the runtime DB; the last flow uses the admin **Reset** to restore the seed.

## Limitations / honest notes

* All data is synthetic; distributions are plausible, not calibrated to a real company.
* The what-if/evaluation store is built from the seeded snapshot; leads created live through the portal are scored and routed but have no ground-truth label.
* The HTTP server is a single-process stdlib server meant for demonstration, not production hosting; RBAC is a header-based demo of the rule set, not authentication.
* Publishing a new score-rule version keeps history but does not automatically re-score existing leads (use *Rescore* per lead).

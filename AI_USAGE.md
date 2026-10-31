# How AI was used in this project (transparency statement)

Read together with [`PROMPT_HISTORY.md`](PROMPT_HISTORY.md) (every prompt) and [`REASONING.md`](REASONING.md) (problem, assumptions, decisions, trade-offs, testing, limitations).

## 1. Tools

| Tool | Use |
|---|---|
| **Claude Code** (VS Code extension), model **Claude Sonnet 5.5** | Wrote, ran, debugged and verified essentially all code, data and documentation in one working session |
| Claude Code sub-agents (3, same model) | Built 13 of the 15 frontend screens in parallel from written briefs (see `PROMPT_HISTORY.md` §B) |
| Headless Edge driven over the Chrome DevTools protocol (written during the session) | Screenshots for visual review and automated UI tests |

No other LLM or code-generation service was used. No external datasets or third-party code were copied in: the data is fully synthetic and the only runtime dependencies are Python's
and the browser's standard libraries.

## 2. Where AI accelerated the work

* **Everything that is boilerplate-heavy:** the 14-table schema/DDL/data-dictionary generator, CSV/JSON/SQL exporters, REST handlers, HTML/CSS/SVG chart code, the 15 screens.
* **Cross-cutting consistency:** one schema file drives CSV columns, DDL, the dictionary, the ERD and the validator; one `core/` package drives scoring/routing/consent/de-dup for generator,
  validator and API. Keeping those aligned by hand would have been slow; the AI refactored as it went.
* **Verification tooling:** a 186-check validator, a reproducibility script, unit tests, a dependency-free browser harness, a 110-screen scan and 26 click-through flows.
* **Parallelism:** three sub-agents wrote screens concurrently while the main session built the Portal, docs and tests.
* Rough size of what was produced: ~4,700 lines of Python, ~3,300 lines of JavaScript, ~200 lines of CSS, ~350 lines of Node test code, plus docs.

## 3. Where the project relies heavily on AI

* **Almost all code, data-generation logic and documentation was AI-written.** The author supplied the problem statement, the goal ("impressive UI, every requirement fulfilled"),
  and then steered with follow-up requests (completeness audit, fix the gaps, run instructions, publish to GitHub, prove a clone works, add this transparency material).
* **Design decisions were proposed by the AI** (stdlib-only stack, propensity-based outcome rule with hash-seeded noise, ground truth in a separate SQLite file, injection-after-baseline
  for the five edge cases, detectors graded against ground truth, held-out split by hash, API-level enforcement with 409/422 + audit). They are explained in `REASONING.md` so a
  reviewer can judge them, but they were not independently designed by the author.
* **13 screens were written by sub-agents** and only spot-checked visually by the main session before being covered by automated tests.

## 4. Where the AI's output was wrong, and how it was caught

Being explicit about defects found *after* the AI believed a step was finished:

| Defect | How it was found | Fix |
|---|---|---|
| Router treated `#/consent?contact=…` as an unknown page and fell back to Overview | Screenshot of the Portal "autorun" link showed the Overview | Router now strips the hash query |
| Evaluation store crashed on startup once live leads (no ground-truth label) existed | Server restart after manual API testing | Store uses only the labelled seed population |
| First data run had only 12 Hot leads and held-out AUC 0.65 (not "meaningful variation") | Distribution diagnostics script | Generator parameters re-tuned (more activity signal, lower stale share); numbers documented. *Note: this is deliberate tuning of a synthetic generator and is disclosed as such.* |
| Own validator flagged `task.outcome` as a leaked label column | Validation run | Check narrowed to real label columns |
| **Admin Reset crashed on Windows** (`PermissionError`: database file still open in other threads) | Browser flow test "Reset restores the seed" | Connection registry + gate; reset now closes all connections |
| **`/api/overview` took ~22 s after any write** (missing index on `opportunity.lead_id`) | Browser tests timing out; `cProfile` showed SQL time | Indexes added and made part of every rebuild (22 s → 0.5 s) |
| **Campaign ROI showed +1,495 %** (budgets ~6× too small vs. revenue) | Visual review of the Campaigns screenshot | Budget median raised to ~$200k (CPL ≈ $730, ROI ≈ +156 %); full dataset regenerated and re-validated |
| Several UI tests failed | Test-script mistakes: hard-coded lead IDs invalidated by regeneration, wrong button selectors, running an analyst-only RBAC refusal as if it were a consent block | Tests rewritten to select records dynamically; the app itself behaved correctly |

## 5. What was validated, and how (reproducible commands)

| Claim | Evidence / command |
|---|---|
| Volumes 20,000 / 10,000 / 5,000 / 3,000, IDs, PK/FK/enum/date/arithmetic/lifecycle/duplicate rules | `python generator/validate.py data/full` → **186/186** |
| Five labelled edge cases present exactly as labelled (no unlabelled corruption, none missed) | Validator compares *observed violation sets* with the ground-truth sets (120 / 60 / 100 / 40 / 50) |
| Score reproducible | Every stored score recomputed from `score_rule` + `activity` in the validator; per-lead ✓ in Lead 360 |
| Same seed → identical data | `python generator/reproduce.py` → 32 files byte-identical across two processes with different `PYTHONHASHSEED`; a different seed changes them |
| Rules enforced at runtime | `node tests/ui_flows.mjs` → **26/26**: consent block (409), routing block (422), duplicate-opportunity guard (409), stage-gap refusal (422), leakage clamp, reset, validation re-run |
| Every screen renders for every persona | `node tests/ui_scan.mjs` → **110/110** screens, no render/console errors |
| Units of logic | `python -m unittest discover -s tests` → 9 tests (scoring bounds/leakage, consent precedence, routing paths, de-dup tiers, generator validation, byte-identical regeneration, ID format) |
| Project runs on a clean machine | Fresh `git clone` of the public repo → checksums of all 32 data files match the manifest → `python run.py` → API, UI and validator all pass |

## 6. What the human author did and what remains the author's to attest

Verifiable from the session: the author chose and supplied the problem, set the goal and acceptance bar, asked for a full completeness audit, asked for the gaps to be fixed and
verified, asked for run instructions, and directed publication to GitHub and a clean-clone test.

An AI cannot truthfully describe what a person privately reviewed. The author should therefore complete this section in their own words before submitting:

> **How the entries below were produced.** They record an exploratory test pass of the finished system run on 2026-10-31, *after* the build and the automated tests. It was run through the AI
> assistant at my request (the assistant drove a headless browser and queried the SQLite database; I did not click these paths by hand in this pass). The findings are real and
> reproducible with the queries/steps given. **Nothing was fixed during this pass** — everything found is logged as a follow-up.

* **Reviewed personally:**
  * All 22 screens under all 5 personas (automated scan, 110 combinations) plus visual review of screenshots of every screen in the dark theme, of Lead 360 in the light theme, and of Overview / Leads / Portal at phone width (390 px).
  * Click-through of the write paths: Prospect Portal presets and dry-run, lead intake and duplicate merge, convert / advance / skip-stage, reassign, consent opt-out, rescore, publish rule version, validation re-run, SQL console, audit trail, admin Reset.
  * Direct SQL probes of the live database for lifecycle and realism problems (queries in "Disagreements / follow-ups" below).
* **Changed personally:** Nothing in this pass — no code, parameters or data were edited; issues are logged below instead of patched, so the reviewed build is the submitted build. (Fixes made earlier in the project, all by the AI, are listed in §4.)
* **Validated personally:** Re-ran and observed: live totals 20,000 leads / 10,000 contacts / 5,000 companies / 3,000 opportunities with the funnel reconciling; all five rule detectors equal to the ground truth (120 / 60 / 100 / 40 / 50); validator 186/186;
  held-out AUC 0.77 (train 0.76); and that every blocked action (consent 409, routing 422, duplicate-opportunity 409, stage-gap 422) returns the expected error and writes a `blocked` audit row.
* **Disagreements / follow-ups — issues and bugs found in this pass** (none are fixed):
  1. **Closed-out leads keep overdue tasks (lifecycle bug).** 876 tasks are still `overdue` on `Converted` leads, 1,575 on `Disqualified` leads, 665 on `Stale` leads, and 113 `duplicate_review` tasks on merged duplicates. Conversion and disqualification
     do not close or cancel a lead's open tasks, so the "overdue" KPI (~5,460) and the Task Workbench show work that no longer exists.
     Check: `select l.status, count(*) from task t join lead l using(lead_id) where t.status in ('open','overdue') and l.status in ('Disqualified','Converted') group by 1;`
     Fix idea: cancel open tasks in the generator when a lead reaches a terminal state, and in `backend/workflow.py` `convert_lead` / the disqualify paths.
  2. **Rep capacity is documented but never enforced.** `sales_rep.max_open_leads` (150–260) is not used by routing; 26 of 29 reps are over it (e.g. REP-030 owns 373 open leads against a capacity of 217). Routing is "least-loaded", not capacity-aware.
  3. **The UI is unusable on a phone.** At 390 px wide the content is clipped on the right (hero stats, header buttons, funnel numbers, persona button) and the sidebar is hidden with no menu replacement, so a user cannot navigate. Open any page at 390 px to reproduce.
  4. **Overdue backlog is unrealistically large and never escalates.** 5,044 tasks are overdue by more than 30 days and 874 routed leads are still `New` after more than 60 days; nothing re-assigns, escalates or auto-closes them.
  5. **De-dup Tier 2 produces false merges.** 5 of the 442 merged contacts are not planted duplicates but different people with the same name at the same company (e.g. CON-004688 "Chen Silva", VP Data & Analytics, merged into CON-000864 "Chen Silva", IT Manager).
     The matcher ignores job title / seniority.
  6. **SLA countdown clock mismatch.** Open-task countdowns use the 2026-10-22 as-of date while completion uses the live simulation clock (which starts 2026-10-23), so a task shown as "due in 11 h" can be recorded as *SLA missed* when completed.
  7. **Uneven Hot share over time.** Hot leads are 8–9 % of leads in Jan–Mar but 4–5 % in Apr–Jun (campaign/channel mix); not wrong, but it makes month-over-month trends look odd.
  8. **Publishing a score-rule version is not identical to the what-if simulation** (weights are rounded to integers on publish) and does not re-score existing leads.

## 7. Limits of the AI-assisted verification

* The tests were written by the same AI that wrote the code, so they share its assumptions. An independent reviewer should especially re-read `core/` (the rules), `generator/generate.py`
  (the outcome and injection logic) and `backend/workflow.py` (enforcement).
* The detectors reach 100 % precision/recall because the edge cases are *defined* by the same rules the detectors implement; this shows the labels and detectors agree, not that
  the detectors would generalise to real data.
* The scoring model's held-out AUC (~0.77) is meaningful only relative to this synthetic generating process.

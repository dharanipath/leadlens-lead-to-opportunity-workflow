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

## 6. My role as the author (first person) — and the line between my work and the AI's

I used an AI coding assistant for this submission and I want the split to be clear.

**What I did myself**
* **Chose the problem and set the bar.** I supplied the problem statement and the goal: a complete full-stack solution with a backend and an impressive UI, with every requirement in the statement fulfilled.
* **Steered the work with follow-up requests.** After the first build I asked whether it fulfilled *every* aspect of the statement, then asked for the shortfalls to be found and fixed so that everything works as the statement describes,
  then asked what someone else needs to do to run it, and then asked for it to be published.
* **Directed how it was published and shared.** I asked for a new, meaningfully named public GitHub repository and the URL, asked that every file needed to run on another machine be available there, and asked which link to share.
  I also asked for this transparency material to be added once I had the submission guidelines.
* **One request the AI advised against.** I asked for ignored files to be renamed and committed so nothing would be missing. The AI recommended against it (the ignored files are databases rebuilt on first run, one ~95 MB)
  and instead proved with a fresh clone that nothing was missing; the repository was left that way.

**What the AI did, at my direction** (not independent work by me)
* All code, data-generation logic, documentation and tests, including every check listed in §5 and the defects found and fixed in §4.
* The verification itself: running the validator, reproducibility script, unit tests, browser scan/flows and the clean-clone test. I received and relied on the AI's reports of these results.

**Additional checks I have made myself** — only list things you actually did, in your own words, and delete this line:
* _(e.g. "I opened the app and tried the Prospect Portal presets", "I re-ran `python run.py` on my machine", "I read `docs/business_rules.md`")_

**Where I would push back / follow up** — _(optional: anything in the design or results you disagree with or would change)_

## 7. Limits of the AI-assisted verification

* The tests were written by the same AI that wrote the code, so they share its assumptions. An independent reviewer should especially re-read `core/` (the rules), `generator/generate.py`
  (the outcome and injection logic) and `backend/workflow.py` (enforcement).
* The detectors reach 100 % precision/recall because the edge cases are *defined* by the same rules the detectors implement; this shows the labels and detectors agree, not that
  the detectors would generalise to real data.
* The scoring model's held-out AUC (~0.77) is meaningful only relative to this synthetic generating process.

# Reasoning: problem, assumptions, decisions, trade-offs, testing, limitations

## 1. The problem as understood

Build a working lead-to-opportunity workflow — score leads from **fit, intent and engagement**, route them and create **follow-up tasks**, and **track progression to won/lost** — and ship
a synthetic, validated, reproducible dataset that makes the workflow reviewable. The statement is explicit that reviewers care about: exposed decisions and exceptions, traceability,
measurable outputs, separate ground truth, reconciled funnel, reproducibility and lawful provenance. So the solution is three things that must agree with each other:
**(1) a dataset generator + validator, (2) a rule-enforcing application, (3) a UI that shows the decisions.** The same rules therefore live in one place (`core/`) and are used by all three.

## 2. Assumptions (and where each is documented)

| Assumption | Why |
|---|---|
| "Today" for the dataset is **2026-10-22** (derived from the seed `20261022`); the live clock continues from 2026-10-23 | Needed to define stale leads, overdue tasks, open vs closed deals |
| A lead is **scored 15 min after creation**, from *inbound* activity in the prior 30 days; later activity never changes a stored score | Makes "score uses post-conversion event" detectable as `scored_ts > converted_ts` |
| `ACT-<lead-id>-001` is read literally → `ACT-LEAD-2026-000001-001` | The convention lists the lead id inside the activity id |
| Territory = company region; region `Other` has no territory map (→ Sales-Ops queue `REP-000`) | Gives a genuine exception path for routing |
| Same canonical contact + same product within 30 days = duplicate lead | A concrete, testable rule |
| "Support agent" is modelled as a combined *Support / Sales Agent* persona who works tasks and logs inquiries | The statement lists the actor but no separate workflow for it |
| All people, companies, e-mails (reserved `.example` domains) and phones are fabricated; no external data | Keeps provenance unambiguous and lawful |
| An all-channel opt-out makes a contact ineligible for conversion | Makes "consent enforced" observable in outcomes |

## 3. Key decisions and trade-offs

1. **Zero dependencies (Python stdlib + SQLite, vanilla-JS SPA).** *Gain:* anyone can run `python run.py`; no install failures. *Cost:* a hand-rolled HTTP server and charts instead of mature frameworks — fine for a demo, not for production.
2. **One schema file as the single source of truth** for CSV columns, DDL, data dictionary, ERD and validator. *Gain:* docs cannot drift from data. *Cost:* the schema module is large.
3. **Outcomes from a documented propensity rule, not independent randomness.** `p = sigmoid(z)·maturity` with `z` from latent interest/budget, fit, and first-response SLA; conversion = top-N by `p − u`, where `u` is a *hash* of (seed, lead id). *Gain:* labels are explainable, reproducible and independent of RNG order; exact volume (3,000) is guaranteed. *Cost / caveat:* the score is predictive *because* activity was generated from the same latent — AUC ≈ 0.77 is a property of the simulation, not evidence about real data.
4. **Baseline first, then inject labelled edge cases** (five mutations on a valid dataset, each recorded in ground truth). *Gain:* corruption is never silent; the validator can demand `observed == labelled`. *Cost:* injection code must keep derived values consistent (scores are recomputed by the same engine).
5. **Ground truth in separate files and a separate SQLite database** that scoring/routing code never opens; only the evaluation module and the detector-grading view read it. *Gain:* leakage is structurally prevented and checkable. *Cost:* two databases to manage.
6. **Rule enforcement at the API, not only in the UI** — consent re-checked at task completion/outreach (409), territory on assignment (422), duplicate-opportunity guard on conversion (409), stage-gap and lifecycle rules (422), leakage clamp on rescoring; every block is written to `audit_log`. *Gain:* "enforced" is demonstrable and auditable.
7. **Append-only histories** (`consent`, `lead_status_history`, `stage_history`, `audit_log`; score rules versioned and effective-dated) instead of in-place edits. *Cost:* current-state columns on `lead`/`task`/`opportunity` are denormalised and validated against the histories.
8. **Held-out evaluation:** deterministic 70/30 hash split fixed at generation time; headline metrics on test only; the optional auto-tuner fits on train only and reports the test delta (it is small — the a-priori weights are already near-optimal on this data, which is reported rather than hidden).
9. **Role-aware UI with header-based RBAC** to show each actor's view and prove permissions are enforced server-side. *Cost:* not real authentication.
10. **Deliberately imperfect de-duplication** (~12 % "hard" duplicates are missed) so recall is measurable; a few distinct people with identical names are merged by tier 2 (false positives are visible in the UI).

## 4. How the work was tested

See `AI_USAGE.md` §5 for the command table. In short: a 186-check data validator (keys, joins, enums, date order, arithmetic, lifecycle, duplicates, consent/routing/leakage/funnel, label-leak checks), byte-for-byte reproducibility across processes, 9 unit tests, a 110-screen browser scan, 26 browser click-through flows that assert database effects (including every blocked rule), and a clean-clone run of the public repository. Defects found by this testing — and fixed — are listed in `AI_USAGE.md` §4.

## 5. How I know the solution works

* Volumes are exact; 186/186 checks pass; every one of 20,000 stored scores is reproduced from `score_rule` + `activity`.
* The funnel reconciles live (Σ status = leads; converted = opportunities; open + won + lost = opportunities; monotone funnel).
* Held-out test AUC 0.77 (train 0.76 → no sign of overfitting); conversion by band Hot 48 % > Warm 25 % > Cold 6 %.
* Every injected edge case is found by the rule detectors and nothing else is flagged; the blocked-action demos produce the expected 409/422 and an audit row.
* A fresh clone runs from one command and passes the same checks.

## 6. Limitations (known and disclosed)

* Synthetic data: distributions are plausible, not calibrated to a real business; model quality is relative to the generator.
* Detector precision/recall is 100 % by construction (edge cases are defined by the detectors' own rules).
* Task countdowns are measured from the dataset as-of date while completions use the live simulation clock, so a task completed "now" can show *SLA missed*.
* Publishing a score-rule version rounds weights to integers, so it can differ slightly from the what-if simulation; it does not auto-rescore existing leads (per-lead *Rescore* exists, with the leakage clamp).
* The Kanban shows the newest 30 cards per stage (counts/amounts cover all deals); evaluation covers the seeded snapshot only (live leads have no label).
* Single-process stdlib server, header-based roles, SQLite — a demonstration architecture.
* Tests were written by the same AI as the code (shared blind spots); an independent review of `core/`, `generator/generate.py` and `backend/workflow.py` is recommended.

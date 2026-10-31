# Documented business rules

Every derived value and every outcome label in the dataset comes from the rules below — none is drawn independently at random.
Implementation: `core/` (shared rules), `generator/generate.py` (data), `backend/workflow.py` (runtime enforcement).

## 1. Scoring (fit + intent + engagement) — `core/scoring.py`, table `score_rule`

| Dimension | Rule (ScoreRule id) | Points |
|---|---|---|
| Fit (cap 40) | Industry ICP tier (SR-V1-001) | Software/FinTech 12 · Healthcare 10 · Telecom 9 · Manufacturing 8 · Logistics 7 · Energy 6 · Media/Retail 5 · Education 3 |
| | Employees band (002) | ≥1000: 14 · ≥200: 10 · ≥50: 6 · ≥10: 3 · else 1 |
| | Seniority (003) | C-level 10 · VP 8 · Director 6 · Manager 3 · IC 1 |
| | Region priority (004) | NA 4 · EMEA 3 · APAC 2 · LATAM 1 |
| | Free e-mail domain (005) | −10 |
| Intent (cap 35) | Demo request (006) | +15 |
| | Pricing-page views (007) | 4 each, cap 12 |
| | Trial sign-up (008) | +10 |
| | Content downloads (009) | 3 each, cap 6 |
| Engagement (cap 25) | E-mail clicks (010) / opens (011) | 2 each cap 8 / 1 each cap 4 |
| | Webinar attended (012) / web visits (013) / support inquiry (014) | 6 cap 6 / 1 each cap 5 / 2 each cap 4 |
| | Inactivity > 14 days (015) | −5 |

`score = clamp(0..100, Σ round(clamp(dimension, 0, cap)))`; **Hot ≥ 70, Warm ≥ 40, else Cold** (SR-V1-030).
Rules are data (JSON params, effective-dated, versioned) so the exact score is reproducible from `score_rule` + `activity`.

**Anti-leakage contract.** Only *inbound* activities with `scored_ts − 30 d ≤ activity_ts ≤ scored_ts` feed a score. `scored_ts`
(= creation + 15 min) must be ≤ `converted_ts`. Violations are the labelled edge case *score uses post-conversion event*.

## 2. Routing — `core/routing.py`

Territory = company region. Eligible reps = active SDR/AE in that territory covering the lead's product (`rep_product` bridge, N:M).
Least-loaded eligible rep wins (ties by `rep_id`) → `rule_based`. No product specialist → least-loaded territory rep → `overflow_territory`
(LATAM has nobody covering *Collaboration*). Region *Other* (no territory map) → Sales-Ops queue `REP-000` + a `manual_routing` task →
`unroutable_queue`. Merged duplicates inherit the canonical lead's owner. The API rejects manual assignment outside the lead's territory (HTTP 422).

## 3. Consent — append-only `consent` ledger

`can_contact(events, channel, ts)`: the latest event with `effective_ts ≤ ts` and channel ∈ {channel, `all`} decides; no record ⇒ no contact.
Tasks needing a channel without consent are created `suppressed`; an opt-out before completion `cancels` the task; an all-channel opt-out
disqualifies open leads and makes the contact ineligible for conversion. Completing a call/e-mail task or logging an outbound touch
re-checks consent at that instant (HTTP 409 when blocked, audited as `blocked`).

## 4. De-duplication — `core/dedupe.py`

Tier 1: equal normalised e-mail (lower-case, `+tag` stripped). Tier 2: same company + same normalised last name + similar first name
(nickname table, initial, or SequenceMatcher ≥ 0.80). Canonical = earliest-created contact. Lead rule: same canonical contact + same product within
30 days of an earlier lead ⇒ merged (`duplicate_of_lead_id`, Disqualified: Duplicate, owner inherited, `duplicate_review` task).
~12 % of planted duplicate contacts are deliberately *hard* (hyphenated surname change + new mailbox) and are missed → recall is measurable.

## 5. Follow-up tasks (SLA)

| Band | Tasks (SLA hours from creation) |
|---|---|
| Hot (P1) | first_response_call 4 · follow_up_email 48 · demo_scheduling 120 |
| Warm (P2) | follow_up_email 24 · nurture_check 168 |
| Cold (P3) | nurture_check 72 |

`due_ts = created_ts + sla_hours`; `sla_met = completed_ts ≤ due_ts`. A rep's hidden diligence parameter drives completion delay.
Phone tasks fall back to e-mail when phone consent is missing.

## 6. Outcome generation (ground-truth labels)

*Conversion.* For every eligible lead (age ≥ 14 d, not a merged duplicate, no all-channel opt-out, routed to a rep) a propensity is computed:

```
z = −4.4 + 4.2·interest + 1.7·fit_points/40 + 0.8·[first-response SLA met] + 0.5·budget      (interest, budget = unobserved latent traits)
p = sigmoid(z) · min(1, 0.4 + 0.6·age/90)                u = sha256(seed | lead_id) → U(0,1)
```

Leads are ranked by margin `p − u`; the top *N* (N = 3000 − planned duplicate opportunities) are converted. Unobserved latents (`interest`, `budget`)
also generated the *observable* activity history, so the rule-based score is predictive but imperfect (held-out AUC ≈ 0.75).
*Win/loss.* `logit = −1.0 + 0.03(score−50) + 0.5·budget + 0.8(interest−0.4) + 0.025·discount%`; won iff a deterministic hash draw < sigmoid(logit).
Lost-at stage and won/lost reasons follow documented stage-dependent tables. Stage dwell times and the as-of date (2026-10-22) decide which deals remain open.
*Stale* = open lead with no activity for > 60 days (derived from `last_activity_ts`, not drawn). *High-score non-converter* = Hot, matured (≥ 45 d), not converted;
`loss_driver` is derived by priority: consent_blocked → unroutable → merged_duplicate → slow_first_response → disqualified_* → went_cold → still_open.
*Held-out split.* `sha256(seed | split | lead_id) % 100 < 30` ⇒ test; headline metrics use the test split only.

## 7. Labelled edge cases (injected after the valid baseline is built)

| issue_type | Count (full) | Mutation | Ground-truth label |
|---|---|---|---|
| opted_out_contacted | 120 | an outbound e-mail/call is added after the contact's all-channel opt-out | activity id |
| score_post_conversion | 60 | `scored_ts` moved after `converted_ts`, post-conversion intent events added, score recomputed by the same engine | lead id |
| lead_outside_territory | 100 | owner (and open tasks) replaced by a rep from another territory | lead id |
| duplicate_opportunity | 40 | a merged duplicate lead converts to its own opportunity while the canonical lead also converted | opportunity id |
| stage_history_gap | 50 | one intermediate StageHistory row removed (chain broken) | opportunity id |

Plus labelled populations: planted duplicate contacts/leads (with `detected_by_rules`), stale leads, high-score non-converters.
`generator/validate.py` passes a check only when *observed violations == labelled set* (no unlabelled corruption, nothing missed).

# Problem statement (as provided — verbatim)

**Business Context / Problem** — Score leads from fit, intent and engagement, assign follow-ups and track progression to opportunity outcomes.

**Objective and Scope** — Build a working solution for this end-to-end workflow: Score leads from fit, intent and engagement, assign follow-ups and track progression to opportunity outcomes. The solution should expose key decisions and exceptions, preserve traceability, and produce measurable outputs. Medium complexity means multiple related entities, conditional rules, at least one exception path and meaningful evaluation metrics.

**Primary Actors / Systems** — Customer/prospect, marketing/sales operations, support agent, analyst and system administrator

**Business Workflow and Rules**
1. Generate/reference master data first: Company, Contact, Lead, Campaign, Activity.
2. Generate dependent transaction/event records using valid parent IDs.
3. Apply business logic: Create company/contact master records; generate leads with source and consent; create activity histories; define transparent score features and weights; deduplicate records; route by territory/product; create follow-up tasks; record stage transitions and won/lost reasons.
4. Persist state changes as explicit records/events where relevant; do not overwrite history.
5. Generate outcomes and ground-truth labels from documented rules, not independent random assignment.

**Entities and Relationships** — Core entities: Company, Contact, Lead, Campaign, Activity, Consent, ScoreRule, SalesRep, Task, Opportunity, StageHistory. Define a primary key for every entity and foreign keys for every relationship. Document cardinality (1:1, 1:N, N:M), optional relationships, effective dates and lifecycle states. Use bridge tables for many-to-many relationships; retain event history for state changes; validate all joins. For deliberate anomaly cases, keep an issue_type/ground_truth label rather than silently corrupting unrelated rows.

**ID / Nomenclature Conventions** — CO-000001; CON-000001; LEAD-2026-000001; ACT-<lead-id>-001; OPP-2026-000001; TASK-<lead-id>-001.

**Synthetic Data Generation Instructions (Granular)**
- Step 1 — Write a data dictionary for: Company, Contact, Lead, Campaign, Activity, Consent, ScoreRule, SalesRep, Task, Opportunity, StageHistory. For each field specify type, required/optional, allowed values, units, uniqueness and validation rule.
- Step 2 — Create parent/master tables first, then child and event tables. Apply this domain-specific generation logic: Create company/contact master records; generate leads with source and consent; create activity histories; define transparent score features and weights; deduplicate records; route by territory/product; create follow-up tasks; record stage transitions and won/lost reasons.
- Step 3 — Apply deterministic IDs and naming: CO-000001; CON-000001; LEAD-2026-000001; ACT-<lead-id>-001; OPP-2026-000001; TASK-<lead-id>-001. Keep counters zero-padded, IDs immutable, and referenced IDs exactly consistent across files.
- Step 4 — Generate the baseline volume: Generate 20,000 leads, 10,000 contacts, 5,000 companies and 3,000 opportunities. Include duplicates, opt-outs, stale leads and high-score non-converters. Use a fixed seed (e.g. 20261022) and parameterize scale so starter and full datasets use the same generator.
- Step 5 — Generate valid baseline records first, then inject labelled edge cases: Opted-out lead contacted; score uses post-conversion event; lead assigned outside territory; duplicate creates duplicate opportunity; stage history has gaps.
- Step 6 — Calculate derived values (totals, balances, scores, statuses and dates) from source records rather than generating them independently.
- Step 7 — Produce a separate ground_truth.csv/json for known anomalies, expected decisions or labels; never leak it into input features.
- Step 8 — Run validation: primary-key uniqueness, foreign-key integrity, allowed enums, date ordering, arithmetic reconciliation, lifecycle transitions and duplicate checks.
- Step 9 — Export CSV/JSON/SQL seed data plus README, schema/data dictionary, generator command, fixed seed, source manifest and validation summary.
- Step 10 — Regenerate twice with the same seed and compare row counts/checksums to demonstrate reproducibility.

**Suggested Volume and Coverage** — Generate 20,000 leads, 10,000 contacts, 5,000 companies and 3,000 opportunities. Include duplicates, opt-outs, stale leads and high-score non-converters.

**Required Edge Cases / Negative Scenarios** — Opted-out lead contacted; score uses post-conversion event; lead assigned outside territory; duplicate creates duplicate opportunity; stage history has gaps.

**Validation Rules / Acceptance Criteria** — Score is reproducible; consent and routing are enforced; conversion funnel reconciles; evaluation uses held-out outcomes.

**Evaluation Focus for Generated Data** — Review: (a) realistic distributions and meaningful variation; (b) consistent IDs and valid joins; (c) dependency/lifecycle consistency across entities; (d) correct derived values and reconciliation; (e) normal, boundary, failure and exception coverage; (f) separate ground truth; (g) fixed-seed reproducibility, documentation and lawful provenance.

**Public Data Guidance / Lawful Use** — External data is optional. If used, record source URL, dataset/version, retrieval date, license/terms, attribution, transformations and fields discarded. Use only data you are legally permitted to access and redistribute; do not bypass access controls or collect confidential/personal information. If licensing or suitability is unclear, use synthetic data and cite public reference data only for schema inspiration.

**Goal given with the problem** — "build a complete fullstack working solution with frontend and backend to show end to end workflow with impressive UI based on the problem statement. make sure that every aspect given in the problem should fulfills its requirements."

# Data dictionary

Generated from `generator/schema.py` (single source of truth). Timestamps are ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`), dates `YYYY-MM-DD`, money in USD.

## Entities

| Table | Entity | Primary key | Lifecycle |
|---|---|---|---|
| `company` | Company | company_id | prospect -> customer (derived) |
| `contact` | Contact | contact_id | active -> merged |
| `campaign` | Campaign | campaign_id | planned -> active -> completed |
| `sales_rep` | SalesRep | rep_id | active (effective-dated) |
| `rep_product` | RepProduct (bridge N:M) | rep_id, product_line | — |
| `lead` | Lead | lead_id | New -> Working -> Qualified -> Converted \| Disqualified \| Stale (Stale -> Working re-engaged) |
| `lead_campaign` | LeadCampaign (bridge N:M) | lead_id, campaign_id | — |
| `consent` | Consent | consent_id | opted_in <-> opted_out (event ledger) |
| `score_rule` | ScoreRule | rule_id | versioned, effective-dated |
| `activity` | Activity | activity_id | — |
| `task` | Task | task_id | open -> completed \| overdue \| cancelled; suppressed at creation |
| `opportunity` | Opportunity | opportunity_id | Qualified -> Discovery -> Proposal -> Negotiation -> Closed Won \| Closed Lost |
| `stage_history` | StageHistory | stage_history_id | — |
| `lead_status_history` | LeadStatusHistory | lead_status_history_id | — |

## Relationships and cardinality

| Parent | Child | Cardinality | Key | Optionality |
|---|---|---|---|---|
| company | contact | 1:N | `contact.company_id` | mandatory |
| company | lead | 1:N | `lead.company_id` | mandatory |
| contact | lead | 1:N | `lead.contact_id` | mandatory |
| contact | consent | 1:N | `consent.contact_id` | mandatory (>=1 event) |
| contact | contact | 1:N (self) | `contact.merged_into_contact_id` | optional |
| campaign | lead | 1:N | `lead.campaign_id` | optional (direct leads) |
| lead | campaign | N:M | `lead_campaign (bridge)` | optional |
| sales_rep | product | N:M | `rep_product (bridge)` | mandatory for SDR/AE |
| sales_rep | lead | 1:N | `lead.assigned_rep_id` | mandatory |
| lead | lead | 1:N (self) | `lead.duplicate_of_lead_id` | optional |
| lead | activity | 1:N | `activity.lead_id` | mandatory (>=1) |
| lead | task | 1:N | `task.lead_id` | mandatory |
| sales_rep | task | 1:N | `task.assigned_rep_id` | mandatory |
| task | activity | 1:N | `activity.task_id` | optional |
| lead | opportunity | 1:0..1 | `opportunity.lead_id` | optional |
| opportunity | stage_history | 1:N | `stage_history.opportunity_id` | mandatory (>=1) |
| lead | lead_status_history | 1:N | `lead_status_history.lead_id` | mandatory (>=1) |
| score_rule | lead | 1:N | `lead.score_version` | mandatory |

## Company (`company`)

Master record of a prospect/customer account. Territory is derived from `region`.

**Primary key:** `company_id` · **Lifecycle:** prospect -> customer (derived)

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `company_id` | string | yes | — | — | yes | — | Immutable company key; CO-000001 sequence, ordered by created_date; pattern ^CO-\d{6}$ |
| `company_name` | string | yes | — | — |  | — | Legal/trading name (synthetic); non-empty |
| `domain` | string | yes | — | — | yes | — | Corporate web/e-mail domain (reserved .example TLD); lower-case, ends with .example |
| `industry` | enum | yes | Software, FinTech, Healthcare, Telecom, Manufacturing, Logistics, Energy, Media, Retail… | — |  | — | Industry vertical |
| `employee_count` | int | yes | — | employees |  | — | Head-count; >= 1; min 1 |
| `annual_revenue_usd` | int | yes | — | USD |  | — | Derived: employees x industry revenue-per-employee x noise; derived from employee_count; min 0 |
| `region` | enum | yes | NA-East, NA-West, EMEA, APAC, LATAM, Other | — |  | — | Sales region used for territory routing ('Other' = no territory map) |
| `country` | string | yes | — | — |  | — | Country, must belong to region; country in REGION_COUNTRIES[region] |
| `created_date` | date | yes | — | YYYY-MM-DD |  | — | Date account entered the CRM; <= earliest contact created_date |
| `account_status` | enum | yes | prospect, customer | — |  | — | Derived: 'customer' if the company has >= 1 Closed Won opportunity, else 'prospect'; derived from opportunity.status |

## Contact (`contact`)

Person at a company. Duplicates are merged (never deleted) via merged_into_contact_id.

**Primary key:** `contact_id` · **Lifecycle:** active -> merged

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `contact_id` | string | yes | — | — | yes | — | Immutable contact key; CON-000001 sequence, ordered by created_date; pattern ^CON-\d{6}$ |
| `company_id` | string | yes | — | — |  | company.company_id | Parent company |
| `first_name` | string | yes | — | — |  | — | Given name (synthetic) |
| `last_name` | string | yes | — | — |  | — | Family name (synthetic) |
| `email` | string | yes | — | — | yes | — | Mailbox on a reserved .example domain; contains '@', no whitespace, reserved .example domain |
| `phone` | string | no | — | — |  | — | Synthetic phone number; starts with '+' |
| `job_title` | string | yes | — | — |  | — | Job title |
| `seniority` | enum | yes | C-level, VP, Director, Manager, IC | — |  | — | Seniority tier used by FIT scoring |
| `department` | enum | yes | IT, Engineering, Operations, Finance, Marketing, Sales, Security, Data | — |  | — | Department |
| `created_date` | date | yes | — | YYYY-MM-DD |  | — | Date contact was created; >= company.created_date and <= first lead created |
| `contact_status` | enum | yes | active, merged | — |  | — | active \| merged (duplicate of another contact); merged <=> merged_into_contact_id is not null |
| `merged_into_contact_id` | string | no | — | — |  | contact.contact_id | Canonical contact when de-duplication merged this record; canonical record must be earlier and active |

## Campaign (`campaign`)

Marketing campaign / programme that sources leads.

**Primary key:** `campaign_id` · **Lifecycle:** planned -> active -> completed

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `campaign_id` | string | yes | — | — | yes | — | Campaign key; pattern ^CMP-\d{4}$ |
| `campaign_name` | string | yes | — | — |  | — | Display name |
| `channel` | enum | yes | Paid Search, Webinar, Email, Content Syndication, Trade Show, Partner Referral, Organic… | — |  | — | Marketing channel; becomes lead.source |
| `product_line` | enum | yes | Analytics, Security, Automation, Collaboration | — |  | — | Featured product |
| `target_region` | enum | yes | NA-East, NA-West, EMEA, APAC, LATAM, Global | — |  | — | Regional focus or Global |
| `start_date` | date | yes | — | YYYY-MM-DD |  | — | Campaign start |
| `end_date` | date | yes | — | YYYY-MM-DD |  | — | Campaign end; >= start_date |
| `budget_usd` | int | yes | — | USD |  | — | Planned spend; min 0 |
| `status` | enum | yes | planned, active, completed | — |  | — | Derived from dates vs. as-of date; derived from start/end vs AS_OF |

## SalesRep (`sales_rep`)

Sales representative (SDR/AE/Manager) or the Sales-Ops routing queue (REP-000).

**Primary key:** `rep_id` · **Lifecycle:** active (effective-dated)

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `rep_id` | string | yes | — | — | yes | — | Rep key; pattern ^REP-\d{3}$ |
| `rep_name` | string | yes | — | — |  | — | Full name (synthetic) |
| `email` | string | yes | — | — | yes | — | Work e-mail (reserved .example domain) |
| `role` | enum | yes | SDR, AE, Manager, Queue | — |  | — | Role |
| `territory` | enum | yes | NA-East, NA-West, EMEA, APAC, LATAM, Global | — |  | — | Covered territory ('Global' = Sales-Ops queue) |
| `team` | string | yes | — | — |  | — | Team name |
| `hire_date` | date | yes | — | YYYY-MM-DD |  | — | Hire date |
| `active_from` | date | yes | — | YYYY-MM-DD |  | — | Effective date from which the rep can receive leads; >= hire_date |
| `active_to` | date | no | — | YYYY-MM-DD |  | — | Effective end date (null = still active); >= active_from |
| `max_open_leads` | int | yes | — | leads |  | — | Capacity guideline; min 1 |

## RepProduct (bridge N:M) (`rep_product`)

Bridge: which products a rep specialises in (SalesRep N:M Product).

**Primary key:** `rep_id, product_line`

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `rep_id` | string | yes | — | — |  | sales_rep.rep_id | Rep |
| `product_line` | enum | yes | Analytics, Security, Automation, Collaboration | — |  | — | Product specialty |
| `effective_from` | date | yes | — | YYYY-MM-DD |  | — | Specialty effective date |

## Lead (`lead`)

A sales lead generated from a contact + source, scored, routed and tracked to an outcome.

**Primary key:** `lead_id` · **Lifecycle:** New -> Working -> Qualified -> Converted | Disqualified | Stale (Stale -> Working re-engaged)

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `lead_id` | string | yes | — | — | yes | — | Immutable lead key; LEAD-2026-000001 sequence by created_ts; pattern ^LEAD-2026-\d{6}$ |
| `contact_id` | string | yes | — | — |  | contact.contact_id | Person |
| `company_id` | string | yes | — | — |  | company.company_id | Account (must equal contact.company_id) |
| `campaign_id` | string | no | — | — |  | campaign.campaign_id | Primary (first-touch) campaign; null for direct leads |
| `source` | enum | yes | Paid Search, Webinar, Email, Content Syndication, Trade Show, Partner Referral, Organic… | — |  | — | Lead source = campaign channel or 'Direct / Website' |
| `product_interest` | enum | yes | Analytics, Security, Automation, Collaboration | — |  | — | Product the lead asked about |
| `created_ts` | timestamp | yes | — | ISO-8601 UTC |  | — | Lead creation time (UTC) |
| `consent_status` | enum | yes | opted_in, implied, opted_out | — |  | — | Derived from Consent events at the as-of date (e-mail channel); derived from consent |
| `territory` | enum | yes | NA-East, NA-West, EMEA, APAC, LATAM, Other | — |  | — | Territory snapshot = company.region at routing time; == company.region |
| `assigned_rep_id` | string | yes | — | — |  | sales_rep.rep_id | Current owner |
| `routing_method` | enum | yes | rule_based, overflow_territory, unroutable_queue, manual_override | — |  | — | How the owner was chosen |
| `routing_reason` | string | yes | — | — |  | — | Human-readable routing decision (traceability) |
| `score` | int | yes | — | points |  | — | Derived lead score (0-100) = fit + intent + engagement via ScoreRule; recomputable from score_rule + activity; min 0; max 100 |
| `score_band` | enum | yes | Hot, Warm, Cold | — |  | — | Hot >= 70, Warm >= 40, Cold; derived from score |
| `scored_ts` | timestamp | yes | — | ISO-8601 UTC |  | — | Score cut-off: only inbound activity <= this time may feed the score; must be <= converted_ts (otherwise post-conversion leakage) |
| `score_version` | int | yes | — | — |  | score_rule.version | ScoreRule version used |
| `status` | enum | yes | New, Working, Qualified, Converted, Disqualified, Stale | — |  | — | Lifecycle state |
| `status_reason` | string | no | Duplicate, Opted out, Not a fit, Unresponsive, No budget, Competitor, No activity > 60 … | — |  | — | Disqualification / stale reason; required when status in (Disqualified, Stale) |
| `duplicate_of_lead_id` | string | no | — | — |  | lead.lead_id | Canonical lead when this lead was merged by de-duplication; canonical lead created earlier; status = Disqualified (Duplicate) |
| `converted_ts` | timestamp | no | — | ISO-8601 UTC |  | — | Set when status = Converted; >= created_ts |
| `opportunity_id` | string | no | — | — |  | opportunity.opportunity_id | Opportunity created on conversion |
| `last_activity_ts` | timestamp | yes | — | ISO-8601 UTC |  | — | Derived: latest activity timestamp <= as-of; max(activity.activity_ts) |

## LeadCampaign (bridge N:M) (`lead_campaign`)

Bridge: every campaign touch that influenced a lead (Lead N:M Campaign).

**Primary key:** `lead_id, campaign_id`

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `lead_id` | string | yes | — | — |  | lead.lead_id | Lead |
| `campaign_id` | string | yes | — | — |  | campaign.campaign_id | Campaign |
| `touch_type` | enum | yes | first_touch, influence | — |  | — | first_touch or influence |
| `touch_ts` | timestamp | yes | — | ISO-8601 UTC |  | — | Time of the touch; <= lead.created_ts |

## Consent (`consent`)

Append-only consent ledger. The latest applicable event per channel governs outreach.

**Primary key:** `consent_id` · **Lifecycle:** opted_in <-> opted_out (event ledger)

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `consent_id` | string | yes | — | — | yes | — | Consent event key; pattern ^CNS-\d{6}$ |
| `contact_id` | string | yes | — | — |  | contact.contact_id | Person |
| `channel` | enum | yes | email, phone, all | — |  | — | Channel scope |
| `status` | enum | yes | opted_in, opted_out | — |  | — | opted_in \| opted_out |
| `legal_basis` | enum | yes | consent, legitimate_interest, contract | — |  | — | Lawful basis; opted_out events use basis 'consent' |
| `effective_ts` | timestamp | yes | — | ISO-8601 UTC |  | — | Effective from (history is never overwritten) |
| `source` | enum | yes | web_form, preference_center, email_unsubscribe, sales_call, list_import, support_request | — |  | — | Where the consent decision was captured |

## ScoreRule (`score_rule`)

Transparent scoring rule table (fit/intent/engagement weights, caps and band cut-offs), effective-dated and versioned.

**Primary key:** `rule_id` · **Lifecycle:** versioned, effective-dated

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `rule_id` | string | yes | — | — | yes | — | Rule key; pattern ^SR-V\d+-\d{3}$ |
| `version` | int | yes | — | — |  | — | Rule-set version; min 1 |
| `dimension` | enum | yes | fit, intent, engagement | — |  | — | Scoring dimension |
| `feature` | string | yes | — | — |  | — | Feature the rule reads (attribute, act:<type>, days_since_last_inbound) |
| `rule_type` | enum | yes | lookup, band, flag, flag_count, per_count, threshold_gt, dimension_cap, band_threshold | — |  | — | Evaluation method |
| `params` | json | yes | — | — |  | — | Weights / thresholds / lookup map (JSON) |
| `max_points` | int | yes | — | points |  | — | Cap for this rule (or dimension); min 0 |
| `description` | string | yes | — | — |  | — | Plain-English explanation |
| `effective_from` | date | yes | — | YYYY-MM-DD |  | — | Effective from |
| `effective_to` | date | no | — | YYYY-MM-DD |  | — | Effective to (null = open-ended) |
| `is_active` | bool | yes | 0, 1 | — |  | — | 1 = in force |

## Activity (`activity`)

Immutable engagement / outreach event on a lead.

**Primary key:** `activity_id`

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `activity_id` | string | yes | — | — | yes | — | ACT-<lead-id>-NNN, numbered chronologically per lead; pattern ^ACT-LEAD-2026-\d{6}-\d{3}$ |
| `lead_id` | string | yes | — | — |  | lead.lead_id | Parent lead |
| `contact_id` | string | yes | — | — |  | contact.contact_id | Person (must equal lead.contact_id) |
| `activity_type` | enum | yes | form_submit, web_visit, pricing_page_view, content_download, email_open, email_click, w… | — |  | — | Event type |
| `direction` | enum | yes | inbound, outbound | — |  | — | inbound (prospect-driven) or outbound (sales-driven); type determines direction |
| `channel` | enum | yes | web, email, phone, event, support, meeting | — |  | — | Channel |
| `activity_ts` | timestamp | yes | — | ISO-8601 UTC |  | — | Event time; >= lead.created_ts - 30 days (identity-resolved history) and <= as-of |
| `rep_id` | string | no | — | — |  | sales_rep.rep_id | Rep for outbound activities; required for outbound |
| `task_id` | string | no | — | — |  | task.task_id | Task that triggered an outbound activity |
| `detail` | string | no | — | — |  | — | Page / asset / note |

## Task (`task`)

Follow-up task created from routing + score band, with SLA.

**Primary key:** `task_id` · **Lifecycle:** open -> completed | overdue | cancelled; suppressed at creation

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `task_id` | string | yes | — | — | yes | — | TASK-<lead-id>-NNN; pattern ^TASK-LEAD-2026-\d{6}-\d{3}$ |
| `lead_id` | string | yes | — | — |  | lead.lead_id | Parent lead |
| `assigned_rep_id` | string | yes | — | — |  | sales_rep.rep_id | Task owner |
| `task_type` | enum | yes | first_response_call, follow_up_email, demo_scheduling, nurture_check, re_engage, duplic… | — |  | — | Task type |
| `priority` | enum | yes | P1, P2, P3 | — |  | — | P1 = Hot, P2 = Warm, P3 = Cold |
| `created_ts` | timestamp | yes | — | ISO-8601 UTC |  | — | Creation time |
| `due_ts` | timestamp | yes | — | ISO-8601 UTC |  | — | SLA due time = created_ts + sla_hours; == created_ts + sla_hours (+ offset for later steps) |
| `sla_hours` | int | yes | — | hours |  | — | SLA for the task's priority band; min 1 |
| `status` | enum | yes | open, completed, overdue, cancelled, suppressed | — |  | — | open \| completed \| overdue \| cancelled \| suppressed; suppressed = no consent at creation, cancelled = opt-out/duplicate before completion |
| `completed_ts` | timestamp | no | — | ISO-8601 UTC |  | — | Completion time; required iff status = completed; >= created_ts |
| `outcome` | enum | no | connected, no_answer, replied, meeting_booked, not_interested, resolved | — |  | — | Task outcome |
| `sla_met` | bool | no | 0, 1 | — |  | — | Derived: completed_ts <= due_ts; derived; null unless completed |
| `cancel_reason` | string | no | no_consent_at_creation, opted_out_before_completion, duplicate_lead | — |  | — | Why cancelled/suppressed |

## Opportunity (`opportunity`)

Sales opportunity created from a converted lead.

**Primary key:** `opportunity_id` · **Lifecycle:** Qualified -> Discovery -> Proposal -> Negotiation -> Closed Won | Closed Lost

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `opportunity_id` | string | yes | — | — | yes | — | Immutable opportunity key; OPP-2026-000001 sequence by created_ts; pattern ^OPP-2026-\d{6}$ |
| `lead_id` | string | yes | — | — | yes | lead.lead_id | Source lead (1 lead -> 0..1 opportunity) |
| `company_id` | string | yes | — | — |  | company.company_id | Account |
| `contact_id` | string | yes | — | — |  | contact.contact_id | Primary contact |
| `owner_rep_id` | string | yes | — | — |  | sales_rep.rep_id | Opportunity owner |
| `product_line` | enum | yes | Analytics, Security, Automation, Collaboration | — |  | — | Product sold |
| `seats` | int | yes | — | seats |  | — | Licensed seats; min 1 |
| `unit_price_usd` | int | yes | — | USD/seat/yr |  | — | List price per seat per year; min 1 |
| `discount_pct` | int | yes | 0, 5, 10, 15, 20 | % |  | — | Discount |
| `amount_usd` | decimal | yes | — | USD |  | — | Derived: seats x unit_price x (1 - discount/100); reconciles to seats x unit_price x (1-discount); min 0 |
| `stage` | enum | yes | Qualified, Discovery, Proposal, Negotiation, Closed Won, Closed Lost | — |  | — | Current stage == last StageHistory.to_stage |
| `status` | enum | yes | open, won, lost | — |  | — | Derived from stage: open / won / lost |
| `probability_pct` | int | yes | — | % |  | — | Derived from stage probability table; min 0; max 100 |
| `created_ts` | timestamp | yes | — | ISO-8601 UTC |  | — | Opportunity creation = lead conversion time; == lead.converted_ts |
| `expected_close_date` | date | yes | — | YYYY-MM-DD |  | — | Forecast close date; >= created date |
| `closed_ts` | timestamp | no | — | ISO-8601 UTC |  | — | Close time; required iff status in (won, lost) |
| `won_lost_reason` | enum | no | Product fit, Price / discount, Strong champion, Existing relationship, Fast response, L… | — |  | — | Won/lost reason; required iff closed; reason family must match won/lost |

## StageHistory (`stage_history`)

Append-only stage transition ledger for opportunities.

**Primary key:** `stage_history_id`

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `stage_history_id` | string | yes | — | — | yes | — | SH-<opp-id>-NN; pattern ^SH-OPP-2026-\d{6}-\d{2}$ |
| `opportunity_id` | string | yes | — | — |  | opportunity.opportunity_id | Parent opportunity |
| `from_stage` | enum | no | Qualified, Discovery, Proposal, Negotiation, Closed Won, Closed Lost | — |  | — | Previous stage (null for the first record) |
| `to_stage` | enum | yes | Qualified, Discovery, Proposal, Negotiation, Closed Won, Closed Lost | — |  | — | New stage |
| `changed_ts` | timestamp | yes | — | ISO-8601 UTC |  | — | Transition time; strictly increasing per opportunity |
| `changed_by_rep_id` | string | yes | — | — |  | sales_rep.rep_id | Rep who moved the stage |
| `reason` | string | no | — | — |  | — | Won/lost reason on closing transitions |

## LeadStatusHistory (`lead_status_history`)

Append-only lead lifecycle ledger (state changes are never overwritten).

**Primary key:** `lead_status_history_id`

| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |
|---|---|---|---|---|---|---|---|
| `lead_status_history_id` | string | yes | — | — | yes | — | LSH-<lead-id>-NN; pattern ^LSH-LEAD-2026-\d{6}-\d{2}$ |
| `lead_id` | string | yes | — | — |  | lead.lead_id | Parent lead |
| `from_status` | enum | no | New, Working, Qualified, Converted, Disqualified, Stale | — |  | — | Previous status |
| `to_status` | enum | yes | New, Working, Qualified, Converted, Disqualified, Stale | — |  | — | New status |
| `changed_ts` | timestamp | yes | — | ISO-8601 UTC |  | — | Transition time |
| `changed_by_rep_id` | string | no | — | — |  | sales_rep.rep_id | Rep (null = system rule) |
| `reason` | string | no | — | — |  | — | Reason |

## Ground-truth files (kept separate, never joined into input features)

`ground_truth/ground_truth.csv|json` — `gt_id`, `entity_type`, `entity_id`, `issue_type`, `is_injected`, `severity`, `expected_decision`, `related_entity_id`, `detail`

`ground_truth/ground_truth_outcomes.csv` — `lead_id`, `outcome`, `converted`, `won`, `split`, `matured`, `loss_driver`

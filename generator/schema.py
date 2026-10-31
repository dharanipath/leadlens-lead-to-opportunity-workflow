"""Single source of truth for the data model: fields, types, enums, keys, cardinalities.

Drives CSV column order, SQL DDL, data-dictionary export and the validator.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from core import config as C  # noqa: E402


def F(name, typ, req, desc, allowed=None, units=None, unique=False, rule=None, fk=None, pattern=None, lo=None, hi=None):
    return {"name": name, "type": typ, "required": req, "description": desc, "allowed": allowed, "units": units,
            "unique": unique, "rule": rule, "fk": fk, "pattern": pattern, "min": lo, "max": hi}


TABLES = {}


def T(name, entity, pk, desc, fields, lifecycle=None):
    TABLES[name] = {"entity": entity, "pk": pk if isinstance(pk, list) else [pk], "description": desc, "fields": fields, "lifecycle": lifecycle}


T("company", "Company", "company_id", "Master record of a prospect/customer account. Territory is derived from `region`.", [
    F("company_id", "string", True, "Immutable company key", unique=True, pattern=r"^CO-\d{6}$", rule="CO-000001 sequence, ordered by created_date"),
    F("company_name", "string", True, "Legal/trading name (synthetic)", rule="non-empty"),
    F("domain", "string", True, "Corporate web/e-mail domain (reserved .example TLD)", unique=True, rule="lower-case, ends with .example"),
    F("industry", "enum", True, "Industry vertical", allowed=C.INDUSTRIES),
    F("employee_count", "int", True, "Head-count", units="employees", lo=1, rule=">= 1"),
    F("annual_revenue_usd", "int", True, "Derived: employees x industry revenue-per-employee x noise", units="USD", lo=0, rule="derived from employee_count"),
    F("region", "enum", True, "Sales region used for territory routing ('Other' = no territory map)", allowed=C.ALL_REGIONS),
    F("country", "string", True, "Country, must belong to region", rule="country in REGION_COUNTRIES[region]"),
    F("created_date", "date", True, "Date account entered the CRM", units="YYYY-MM-DD", rule="<= earliest contact created_date"),
    F("account_status", "enum", True, "Derived: 'customer' if the company has >= 1 Closed Won opportunity, else 'prospect'", allowed=["prospect", "customer"],
      rule="derived from opportunity.status"),
], lifecycle="prospect -> customer (derived)")

T("contact", "Contact", "contact_id", "Person at a company. Duplicates are merged (never deleted) via merged_into_contact_id.", [
    F("contact_id", "string", True, "Immutable contact key", unique=True, pattern=r"^CON-\d{6}$", rule="CON-000001 sequence, ordered by created_date"),
    F("company_id", "string", True, "Parent company", fk="company.company_id"),
    F("first_name", "string", True, "Given name (synthetic)"),
    F("last_name", "string", True, "Family name (synthetic)"),
    F("email", "string", True, "Mailbox on a reserved .example domain", unique=True, rule="contains '@', no whitespace, reserved .example domain"),
    F("phone", "string", False, "Synthetic phone number", rule="starts with '+'"),
    F("job_title", "string", True, "Job title"),
    F("seniority", "enum", True, "Seniority tier used by FIT scoring", allowed=C.SENIORITIES),
    F("department", "enum", True, "Department", allowed=C.DEPARTMENTS),
    F("created_date", "date", True, "Date contact was created", units="YYYY-MM-DD", rule=">= company.created_date and <= first lead created"),
    F("contact_status", "enum", True, "active | merged (duplicate of another contact)", allowed=["active", "merged"],
      rule="merged <=> merged_into_contact_id is not null"),
    F("merged_into_contact_id", "string", False, "Canonical contact when de-duplication merged this record", fk="contact.contact_id",
      rule="canonical record must be earlier and active"),
], lifecycle="active -> merged")

T("campaign", "Campaign", "campaign_id", "Marketing campaign / programme that sources leads.", [
    F("campaign_id", "string", True, "Campaign key", unique=True, pattern=r"^CMP-\d{4}$"),
    F("campaign_name", "string", True, "Display name"),
    F("channel", "enum", True, "Marketing channel; becomes lead.source", allowed=C.CAMPAIGN_CHANNELS),
    F("product_line", "enum", True, "Featured product", allowed=C.PRODUCTS),
    F("target_region", "enum", True, "Regional focus or Global", allowed=C.REGIONS + ["Global"]),
    F("start_date", "date", True, "Campaign start", units="YYYY-MM-DD"),
    F("end_date", "date", True, "Campaign end", units="YYYY-MM-DD", rule=">= start_date"),
    F("budget_usd", "int", True, "Planned spend", units="USD", lo=0),
    F("status", "enum", True, "Derived from dates vs. as-of date", allowed=C.CAMPAIGN_STATUSES, rule="derived from start/end vs AS_OF"),
], lifecycle="planned -> active -> completed")

T("sales_rep", "SalesRep", "rep_id", "Sales representative (SDR/AE/Manager) or the Sales-Ops routing queue (REP-000).", [
    F("rep_id", "string", True, "Rep key", unique=True, pattern=r"^REP-\d{3}$"),
    F("rep_name", "string", True, "Full name (synthetic)"),
    F("email", "string", True, "Work e-mail (reserved .example domain)", unique=True),
    F("role", "enum", True, "Role", allowed=C.ROLES),
    F("territory", "enum", True, "Covered territory ('Global' = Sales-Ops queue)", allowed=C.TERRITORIES),
    F("team", "string", True, "Team name"),
    F("hire_date", "date", True, "Hire date", units="YYYY-MM-DD"),
    F("active_from", "date", True, "Effective date from which the rep can receive leads", units="YYYY-MM-DD", rule=">= hire_date"),
    F("active_to", "date", False, "Effective end date (null = still active)", units="YYYY-MM-DD", rule=">= active_from"),
    F("max_open_leads", "int", True, "Capacity guideline", units="leads", lo=1),
], lifecycle="active (effective-dated)")

T("rep_product", "RepProduct (bridge N:M)", ["rep_id", "product_line"], "Bridge: which products a rep specialises in (SalesRep N:M Product).", [
    F("rep_id", "string", True, "Rep", fk="sales_rep.rep_id"),
    F("product_line", "enum", True, "Product specialty", allowed=C.PRODUCTS),
    F("effective_from", "date", True, "Specialty effective date", units="YYYY-MM-DD"),
])

T("lead", "Lead", "lead_id", "A sales lead generated from a contact + source, scored, routed and tracked to an outcome.", [
    F("lead_id", "string", True, "Immutable lead key", unique=True, pattern=r"^LEAD-2026-\d{6}$", rule="LEAD-2026-000001 sequence by created_ts"),
    F("contact_id", "string", True, "Person", fk="contact.contact_id"),
    F("company_id", "string", True, "Account (must equal contact.company_id)", fk="company.company_id"),
    F("campaign_id", "string", False, "Primary (first-touch) campaign; null for direct leads", fk="campaign.campaign_id"),
    F("source", "enum", True, "Lead source = campaign channel or 'Direct / Website'", allowed=C.SOURCES),
    F("product_interest", "enum", True, "Product the lead asked about", allowed=C.PRODUCTS),
    F("created_ts", "timestamp", True, "Lead creation time (UTC)", units="ISO-8601 UTC"),
    F("consent_status", "enum", True, "Derived from Consent events at the as-of date (e-mail channel)", allowed=C.LEAD_CONSENT_STATES, rule="derived from consent"),
    F("territory", "enum", True, "Territory snapshot = company.region at routing time", allowed=C.ALL_REGIONS, rule="== company.region"),
    F("assigned_rep_id", "string", True, "Current owner", fk="sales_rep.rep_id"),
    F("routing_method", "enum", True, "How the owner was chosen", allowed=C.ROUTING_METHODS),
    F("routing_reason", "string", True, "Human-readable routing decision (traceability)"),
    F("score", "int", True, "Derived lead score (0-100) = fit + intent + engagement via ScoreRule", units="points", lo=0, hi=100, rule="recomputable from score_rule + activity"),
    F("score_band", "enum", True, "Hot >= 70, Warm >= 40, Cold", allowed=C.SCORE_BANDS, rule="derived from score"),
    F("scored_ts", "timestamp", True, "Score cut-off: only inbound activity <= this time may feed the score", units="ISO-8601 UTC",
      rule="must be <= converted_ts (otherwise post-conversion leakage)"),
    F("score_version", "int", True, "ScoreRule version used", fk="score_rule.version"),
    F("status", "enum", True, "Lifecycle state", allowed=C.LEAD_STATUSES),
    F("status_reason", "string", False, "Disqualification / stale reason", allowed=C.DISQUALIFY_REASONS + ["No activity > 60 days"],
      rule="required when status in (Disqualified, Stale)"),
    F("duplicate_of_lead_id", "string", False, "Canonical lead when this lead was merged by de-duplication", fk="lead.lead_id",
      rule="canonical lead created earlier; status = Disqualified (Duplicate)"),
    F("converted_ts", "timestamp", False, "Set when status = Converted", units="ISO-8601 UTC", rule=">= created_ts"),
    F("opportunity_id", "string", False, "Opportunity created on conversion", fk="opportunity.opportunity_id"),
    F("last_activity_ts", "timestamp", True, "Derived: latest activity timestamp <= as-of", units="ISO-8601 UTC", rule="max(activity.activity_ts)"),
], lifecycle="New -> Working -> Qualified -> Converted | Disqualified | Stale (Stale -> Working re-engaged)")

T("lead_campaign", "LeadCampaign (bridge N:M)", ["lead_id", "campaign_id"], "Bridge: every campaign touch that influenced a lead (Lead N:M Campaign).", [
    F("lead_id", "string", True, "Lead", fk="lead.lead_id"),
    F("campaign_id", "string", True, "Campaign", fk="campaign.campaign_id"),
    F("touch_type", "enum", True, "first_touch or influence", allowed=["first_touch", "influence"]),
    F("touch_ts", "timestamp", True, "Time of the touch", units="ISO-8601 UTC", rule="<= lead.created_ts"),
])

T("consent", "Consent", "consent_id", "Append-only consent ledger. The latest applicable event per channel governs outreach.", [
    F("consent_id", "string", True, "Consent event key", unique=True, pattern=r"^CNS-\d{6}$"),
    F("contact_id", "string", True, "Person", fk="contact.contact_id"),
    F("channel", "enum", True, "Channel scope", allowed=C.CONSENT_CHANNELS),
    F("status", "enum", True, "opted_in | opted_out", allowed=C.CONSENT_STATUSES),
    F("legal_basis", "enum", True, "Lawful basis", allowed=C.CONSENT_BASES, rule="opted_out events use basis 'consent'"),
    F("effective_ts", "timestamp", True, "Effective from (history is never overwritten)", units="ISO-8601 UTC"),
    F("source", "enum", True, "Where the consent decision was captured", allowed=C.CONSENT_SOURCES),
], lifecycle="opted_in <-> opted_out (event ledger)")

T("score_rule", "ScoreRule", ["rule_id"], "Transparent scoring rule table (fit/intent/engagement weights, caps and band cut-offs), effective-dated and versioned.", [
    F("rule_id", "string", True, "Rule key", unique=True, pattern=r"^SR-V\d+-\d{3}$"),
    F("version", "int", True, "Rule-set version", lo=1),
    F("dimension", "enum", True, "Scoring dimension", allowed=["fit", "intent", "engagement"]),
    F("feature", "string", True, "Feature the rule reads (attribute, act:<type>, days_since_last_inbound)"),
    F("rule_type", "enum", True, "Evaluation method", allowed=["lookup", "band", "flag", "flag_count", "per_count", "threshold_gt", "dimension_cap", "band_threshold"]),
    F("params", "json", True, "Weights / thresholds / lookup map (JSON)"),
    F("max_points", "int", True, "Cap for this rule (or dimension)", units="points", lo=0),
    F("description", "string", True, "Plain-English explanation"),
    F("effective_from", "date", True, "Effective from", units="YYYY-MM-DD"),
    F("effective_to", "date", False, "Effective to (null = open-ended)", units="YYYY-MM-DD"),
    F("is_active", "bool", True, "1 = in force", allowed=[0, 1]),
], lifecycle="versioned, effective-dated")

T("activity", "Activity", "activity_id", "Immutable engagement / outreach event on a lead.", [
    F("activity_id", "string", True, "ACT-<lead-id>-NNN, numbered chronologically per lead", unique=True, pattern=r"^ACT-LEAD-2026-\d{6}-\d{3}$"),
    F("lead_id", "string", True, "Parent lead", fk="lead.lead_id"),
    F("contact_id", "string", True, "Person (must equal lead.contact_id)", fk="contact.contact_id"),
    F("activity_type", "enum", True, "Event type", allowed=C.ACTIVITY_TYPES),
    F("direction", "enum", True, "inbound (prospect-driven) or outbound (sales-driven)", allowed=C.ACTIVITY_DIRECTIONS, rule="type determines direction"),
    F("channel", "enum", True, "Channel", allowed=C.ACTIVITY_CHANNELS),
    F("activity_ts", "timestamp", True, "Event time", units="ISO-8601 UTC", rule=">= lead.created_ts - 30 days (identity-resolved history) and <= as-of"),
    F("rep_id", "string", False, "Rep for outbound activities", fk="sales_rep.rep_id", rule="required for outbound"),
    F("task_id", "string", False, "Task that triggered an outbound activity", fk="task.task_id"),
    F("detail", "string", False, "Page / asset / note"),
])

T("task", "Task", "task_id", "Follow-up task created from routing + score band, with SLA.", [
    F("task_id", "string", True, "TASK-<lead-id>-NNN", unique=True, pattern=r"^TASK-LEAD-2026-\d{6}-\d{3}$"),
    F("lead_id", "string", True, "Parent lead", fk="lead.lead_id"),
    F("assigned_rep_id", "string", True, "Task owner", fk="sales_rep.rep_id"),
    F("task_type", "enum", True, "Task type", allowed=C.TASK_TYPES),
    F("priority", "enum", True, "P1 = Hot, P2 = Warm, P3 = Cold", allowed=C.TASK_PRIORITIES),
    F("created_ts", "timestamp", True, "Creation time", units="ISO-8601 UTC"),
    F("due_ts", "timestamp", True, "SLA due time = created_ts + sla_hours", units="ISO-8601 UTC", rule="== created_ts + sla_hours (+ offset for later steps)"),
    F("sla_hours", "int", True, "SLA for the task's priority band", units="hours", lo=1),
    F("status", "enum", True, "open | completed | overdue | cancelled | suppressed", allowed=C.TASK_STATUSES,
      rule="suppressed = no consent at creation, cancelled = opt-out/duplicate before completion"),
    F("completed_ts", "timestamp", False, "Completion time", units="ISO-8601 UTC", rule="required iff status = completed; >= created_ts"),
    F("outcome", "enum", False, "Task outcome", allowed=C.TASK_OUTCOMES),
    F("sla_met", "bool", False, "Derived: completed_ts <= due_ts", allowed=[0, 1], rule="derived; null unless completed"),
    F("cancel_reason", "string", False, "Why cancelled/suppressed", allowed=["no_consent_at_creation", "opted_out_before_completion", "duplicate_lead"]),
], lifecycle="open -> completed | overdue | cancelled; suppressed at creation")

T("opportunity", "Opportunity", "opportunity_id", "Sales opportunity created from a converted lead.", [
    F("opportunity_id", "string", True, "Immutable opportunity key", unique=True, pattern=r"^OPP-2026-\d{6}$", rule="OPP-2026-000001 sequence by created_ts"),
    F("lead_id", "string", True, "Source lead (1 lead -> 0..1 opportunity)", unique=True, fk="lead.lead_id"),
    F("company_id", "string", True, "Account", fk="company.company_id"),
    F("contact_id", "string", True, "Primary contact", fk="contact.contact_id"),
    F("owner_rep_id", "string", True, "Opportunity owner", fk="sales_rep.rep_id"),
    F("product_line", "enum", True, "Product sold", allowed=C.PRODUCTS),
    F("seats", "int", True, "Licensed seats", units="seats", lo=1),
    F("unit_price_usd", "int", True, "List price per seat per year", units="USD/seat/yr", lo=1),
    F("discount_pct", "int", True, "Discount", units="%", allowed=C.DISCOUNTS),
    F("amount_usd", "decimal", True, "Derived: seats x unit_price x (1 - discount/100)", units="USD", lo=0, rule="reconciles to seats x unit_price x (1-discount)"),
    F("stage", "enum", True, "Current stage == last StageHistory.to_stage", allowed=C.OPP_STAGES),
    F("status", "enum", True, "Derived from stage: open / won / lost", allowed=C.OPP_STATUSES),
    F("probability_pct", "int", True, "Derived from stage probability table", units="%", lo=0, hi=100),
    F("created_ts", "timestamp", True, "Opportunity creation = lead conversion time", units="ISO-8601 UTC", rule="== lead.converted_ts"),
    F("expected_close_date", "date", True, "Forecast close date", units="YYYY-MM-DD", rule=">= created date"),
    F("closed_ts", "timestamp", False, "Close time", units="ISO-8601 UTC", rule="required iff status in (won, lost)"),
    F("won_lost_reason", "enum", False, "Won/lost reason", allowed=C.WON_LOST_REASONS, rule="required iff closed; reason family must match won/lost"),
], lifecycle="Qualified -> Discovery -> Proposal -> Negotiation -> Closed Won | Closed Lost")

T("stage_history", "StageHistory", "stage_history_id", "Append-only stage transition ledger for opportunities.", [
    F("stage_history_id", "string", True, "SH-<opp-id>-NN", unique=True, pattern=r"^SH-OPP-2026-\d{6}-\d{2}$"),
    F("opportunity_id", "string", True, "Parent opportunity", fk="opportunity.opportunity_id"),
    F("from_stage", "enum", False, "Previous stage (null for the first record)", allowed=C.OPP_STAGES),
    F("to_stage", "enum", True, "New stage", allowed=C.OPP_STAGES),
    F("changed_ts", "timestamp", True, "Transition time", units="ISO-8601 UTC", rule="strictly increasing per opportunity"),
    F("changed_by_rep_id", "string", True, "Rep who moved the stage", fk="sales_rep.rep_id"),
    F("reason", "string", False, "Won/lost reason on closing transitions"),
])

T("lead_status_history", "LeadStatusHistory", "lead_status_history_id", "Append-only lead lifecycle ledger (state changes are never overwritten).", [
    F("lead_status_history_id", "string", True, "LSH-<lead-id>-NN", unique=True, pattern=r"^LSH-LEAD-2026-\d{6}-\d{2}$"),
    F("lead_id", "string", True, "Parent lead", fk="lead.lead_id"),
    F("from_status", "enum", False, "Previous status", allowed=C.LEAD_STATUSES),
    F("to_status", "enum", True, "New status", allowed=C.LEAD_STATUSES),
    F("changed_ts", "timestamp", True, "Transition time", units="ISO-8601 UTC"),
    F("changed_by_rep_id", "string", False, "Rep (null = system rule)", fk="sales_rep.rep_id"),
    F("reason", "string", False, "Reason"),
])

GROUND_TRUTH_FIELDS = ["gt_id", "entity_type", "entity_id", "issue_type", "is_injected", "severity", "expected_decision", "related_entity_id", "detail"]
OUTCOME_FIELDS = ["lead_id", "outcome", "converted", "won", "split", "matured", "loss_driver"]

LOAD_ORDER = ["company", "contact", "campaign", "sales_rep", "rep_product", "score_rule", "lead", "lead_campaign", "consent", "opportunity",
              "activity", "task", "stage_history", "lead_status_history"]

RELATIONSHIPS = [
    ("company", "contact", "1:N", "contact.company_id", "mandatory"),
    ("company", "lead", "1:N", "lead.company_id", "mandatory"),
    ("contact", "lead", "1:N", "lead.contact_id", "mandatory"),
    ("contact", "consent", "1:N", "consent.contact_id", "mandatory (>=1 event)"),
    ("contact", "contact", "1:N (self)", "contact.merged_into_contact_id", "optional"),
    ("campaign", "lead", "1:N", "lead.campaign_id", "optional (direct leads)"),
    ("lead", "campaign", "N:M", "lead_campaign (bridge)", "optional"),
    ("sales_rep", "product", "N:M", "rep_product (bridge)", "mandatory for SDR/AE"),
    ("sales_rep", "lead", "1:N", "lead.assigned_rep_id", "mandatory"),
    ("lead", "lead", "1:N (self)", "lead.duplicate_of_lead_id", "optional"),
    ("lead", "activity", "1:N", "activity.lead_id", "mandatory (>=1)"),
    ("lead", "task", "1:N", "task.lead_id", "mandatory"),
    ("sales_rep", "task", "1:N", "task.assigned_rep_id", "mandatory"),
    ("task", "activity", "1:N", "activity.task_id", "optional"),
    ("lead", "opportunity", "1:0..1", "opportunity.lead_id", "optional"),
    ("opportunity", "stage_history", "1:N", "stage_history.opportunity_id", "mandatory (>=1)"),
    ("lead", "lead_status_history", "1:N", "lead_status_history.lead_id", "mandatory (>=1)"),
    ("score_rule", "lead", "1:N", "lead.score_version", "mandatory"),
]

SQL_TYPES = {"string": "TEXT", "enum": "TEXT", "date": "TEXT", "timestamp": "TEXT", "int": "INTEGER", "decimal": "REAL", "bool": "INTEGER", "json": "TEXT"}


def columns(table):
    return [f["name"] for f in TABLES[table]["fields"]]


def ddl(table):
    t = TABLES[table]
    cols = []
    for f in t["fields"]:
        col = f"  {f['name']} {SQL_TYPES[f['type']]}"
        if f["required"]:
            col += " NOT NULL"
        cols.append(col)
    cols.append(f"  PRIMARY KEY ({', '.join(t['pk'])})")
    for f in t["fields"]:
        if f["fk"]:
            ft, fc = f["fk"].split(".")
            if ft in TABLES and ft != "score_rule":    # score_rule.version is not unique on its own: checked by the validator
                cols.append(f"  FOREIGN KEY ({f['name']}) REFERENCES {ft}({fc})")
    return f"CREATE TABLE {table} (\n" + ",\n".join(cols) + "\n);"

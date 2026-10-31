"""Shared constants, enums and business-rule parameters.

Used by the generator, validator and the backend so every layer applies the
same documented rules.
"""
from datetime import datetime

SEED = 20261022
AS_OF = datetime(2026, 10, 22, 23, 59, 59)          # snapshot date of the synthetic world
YEAR = 2026

REGIONS = ["NA-East", "NA-West", "EMEA", "APAC", "LATAM"]
ALL_REGIONS = REGIONS + ["Other"]                    # 'Other' = outside every territory map -> unroutable
TERRITORIES = REGIONS + ["Global"]                   # 'Global' = Sales-Ops routing queue
REGION_WEIGHTS = [25, 20, 30, 17, 8]
REGION_COUNTRIES = {
    "NA-East": ["United States", "Canada"],
    "NA-West": ["United States", "Canada", "Mexico"],
    "EMEA": ["United Kingdom", "Germany", "France", "Netherlands", "Spain", "Sweden", "United Arab Emirates", "South Africa"],
    "APAC": ["Australia", "India", "Singapore", "Japan", "New Zealand"],
    "LATAM": ["Brazil", "Argentina", "Chile", "Colombia"],
    "Other": ["Iceland", "Mongolia", "Kazakhstan"],
}
PHONE_CC = {"United States": "1", "Canada": "1", "Mexico": "52", "United Kingdom": "44", "Germany": "49", "France": "33",
            "Netherlands": "31", "Spain": "34", "Sweden": "46", "United Arab Emirates": "971", "South Africa": "27",
            "Australia": "61", "India": "91", "Singapore": "65", "Japan": "81", "New Zealand": "64", "Brazil": "55",
            "Argentina": "54", "Chile": "56", "Colombia": "57", "Iceland": "354", "Mongolia": "976", "Kazakhstan": "7"}

INDUSTRIES = ["Software", "FinTech", "Healthcare", "Telecom", "Manufacturing", "Logistics", "Energy", "Media", "Retail", "Education"]
INDUSTRY_WEIGHTS = [18, 14, 12, 6, 12, 8, 6, 6, 12, 6]
REVENUE_PER_EMPLOYEE = {"Software": 210000, "FinTech": 260000, "Healthcare": 150000, "Telecom": 280000, "Manufacturing": 190000,
                        "Logistics": 140000, "Energy": 520000, "Media": 170000, "Retail": 160000, "Education": 90000}

PRODUCTS = ["Analytics", "Security", "Automation", "Collaboration"]
PRODUCT_WEIGHTS = [30, 25, 25, 20]
UNIT_PRICE_USD = {"Analytics": 480, "Security": 720, "Automation": 420, "Collaboration": 240}   # per seat / year

SENIORITIES = ["C-level", "VP", "Director", "Manager", "IC"]
SENIORITY_WEIGHTS = [6, 10, 18, 28, 38]
DEPARTMENTS = ["IT", "Engineering", "Operations", "Finance", "Marketing", "Sales", "Security", "Data"]
TITLES = {
    "C-level": ["Chief Technology Officer", "Chief Information Officer", "Chief Operating Officer", "Chief Data Officer"],
    "VP": ["VP Engineering", "VP Operations", "VP IT", "VP Data & Analytics"],
    "Director": ["Director of IT", "Director of Engineering", "Director of Operations", "Director of Security"],
    "Manager": ["IT Manager", "Engineering Manager", "Operations Manager", "Product Manager", "Security Manager"],
    "IC": ["Software Engineer", "Data Analyst", "Systems Administrator", "Business Analyst", "Security Analyst"],
}

FREE_EMAIL_DOMAINS = ["freemail.example", "webmail.example", "inbox.example"]   # reserved .example TLD: no real mailboxes

SOURCES = ["Paid Search", "Webinar", "Email", "Content Syndication", "Trade Show", "Partner Referral", "Organic Social", "Direct / Website"]
CAMPAIGN_CHANNELS = SOURCES[:-1]
SOURCE_INTEREST = {"Partner Referral": 0.60, "Webinar": 0.50, "Trade Show": 0.45, "Direct / Website": 0.50, "Paid Search": 0.40,
                   "Email": 0.34, "Content Syndication": 0.26, "Organic Social": 0.30}
CAMPAIGN_STATUSES = ["planned", "active", "completed"]

ROLES = ["SDR", "AE", "Manager", "Queue"]
QUEUE_REP_ID = "REP-000"

ACTIVITY_TYPES = ["form_submit", "web_visit", "pricing_page_view", "content_download", "email_open", "email_click", "webinar_attend",
                  "demo_request", "trial_signup", "support_inquiry",                         # inbound (prospect-driven)
                  "email_outbound", "call_outbound", "meeting", "demo_delivered"]            # outbound / sales-driven
INBOUND_TYPES = ACTIVITY_TYPES[:10]
OUTBOUND_TYPES = ACTIVITY_TYPES[10:]
CONTACT_TYPES = {"email_outbound": "email", "call_outbound": "phone"}   # activity types that require channel consent
ACTIVITY_CHANNELS = ["web", "email", "phone", "event", "support", "meeting"]
ACTIVITY_DIRECTIONS = ["inbound", "outbound"]

CONSENT_CHANNELS = ["email", "phone", "all"]
CONSENT_STATUSES = ["opted_in", "opted_out"]
CONSENT_BASES = ["consent", "legitimate_interest", "contract"]
CONSENT_SOURCES = ["web_form", "preference_center", "email_unsubscribe", "sales_call", "list_import", "support_request"]
LEAD_CONSENT_STATES = ["opted_in", "implied", "opted_out"]

LEAD_STATUSES = ["New", "Working", "Qualified", "Converted", "Disqualified", "Stale"]
LEAD_TRANSITIONS = {
    None: ["New"],
    "New": ["Working", "Disqualified", "Stale", "Qualified"],
    "Working": ["Qualified", "Disqualified", "Stale"],
    "Qualified": ["Converted", "Disqualified", "Stale"],
    "Stale": ["Working", "Disqualified"],
    "Converted": [],
    "Disqualified": [],
}
DISQUALIFY_REASONS = ["Duplicate", "Opted out", "Not a fit", "Unresponsive", "No budget", "Competitor"]
ROUTING_METHODS = ["rule_based", "overflow_territory", "unroutable_queue", "manual_override"]
SCORE_BANDS = ["Hot", "Warm", "Cold"]

TASK_TYPES = ["first_response_call", "follow_up_email", "demo_scheduling", "nurture_check", "re_engage", "duplicate_review", "manual_routing"]
TASK_STATUSES = ["open", "completed", "overdue", "cancelled", "suppressed"]
TASK_PRIORITIES = ["P1", "P2", "P3"]
TASK_OUTCOMES = ["connected", "no_answer", "replied", "meeting_booked", "not_interested", "resolved"]
TASK_CHANNEL = {"first_response_call": "phone", "follow_up_email": "email", "nurture_check": "email", "re_engage": "email",
                "demo_scheduling": "email", "duplicate_review": None, "manual_routing": None}
SLA_HOURS = {"Hot": 4, "Warm": 24, "Cold": 72}
BAND_PRIORITY = {"Hot": "P1", "Warm": "P2", "Cold": "P3"}

OPP_STAGES = ["Qualified", "Discovery", "Proposal", "Negotiation", "Closed Won", "Closed Lost"]
OPEN_STAGES = OPP_STAGES[:4]
STAGE_PROB = {"Qualified": 10, "Discovery": 25, "Proposal": 50, "Negotiation": 75, "Closed Won": 100, "Closed Lost": 0}
OPP_STATUSES = ["open", "won", "lost"]
WON_REASONS = ["Product fit", "Price / discount", "Strong champion", "Existing relationship", "Fast response"]
LOST_REASONS = ["Lost to competitor", "Price too high", "No budget", "No decision", "Bad timing", "Not a fit"]
WON_LOST_REASONS = WON_REASONS + LOST_REASONS
DISCOUNTS = [0, 5, 10, 15, 20]

ANOMALY_TYPES = ["opted_out_contacted", "score_post_conversion", "lead_outside_territory", "duplicate_opportunity", "stage_history_gap"]
LABEL_TYPES = ["duplicate_lead", "duplicate_contact", "stale_lead", "high_score_non_converter"]

# Business parameters -------------------------------------------------------
SCORE_LOOKBACK_DAYS = 30
SCORE_DELAY_MINUTES = 15            # a lead is scored 15 min after creation (inbound history + form submit)
DUP_WINDOW_DAYS = 30                # same person + same product inside this window = duplicate lead
STALE_DAYS = 60                     # open lead with no activity for this long = Stale
MATURITY_DAYS = 45                  # outcome considered matured for evaluation
HOT_THRESHOLD, WARM_THRESHOLD = 70, 40
HOLDOUT_TEST_PCT = 30               # % of matured leads held out (deterministic hash split)

NICKNAMES = {"robert": "bob", "william": "bill", "richard": "dick", "james": "jim", "michael": "mike", "elizabeth": "liz", "katherine": "kate",
             "jennifer": "jen", "christopher": "chris", "alexander": "alex", "daniel": "dan", "matthew": "matt", "thomas": "tom",
             "margaret": "maggie", "patricia": "pat", "joseph": "joe", "andrew": "andy", "stephanie": "steph", "nicholas": "nick"}

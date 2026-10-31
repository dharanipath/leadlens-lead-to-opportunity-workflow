-- DDL generated from generator/schema.py
CREATE TABLE company (
  company_id TEXT NOT NULL,
  company_name TEXT NOT NULL,
  domain TEXT NOT NULL,
  industry TEXT NOT NULL,
  employee_count INTEGER NOT NULL,
  annual_revenue_usd INTEGER NOT NULL,
  region TEXT NOT NULL,
  country TEXT NOT NULL,
  created_date TEXT NOT NULL,
  account_status TEXT NOT NULL,
  PRIMARY KEY (company_id)
);
CREATE TABLE contact (
  contact_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  job_title TEXT NOT NULL,
  seniority TEXT NOT NULL,
  department TEXT NOT NULL,
  created_date TEXT NOT NULL,
  contact_status TEXT NOT NULL,
  merged_into_contact_id TEXT,
  PRIMARY KEY (contact_id),
  FOREIGN KEY (company_id) REFERENCES company(company_id),
  FOREIGN KEY (merged_into_contact_id) REFERENCES contact(contact_id)
);
CREATE TABLE campaign (
  campaign_id TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  channel TEXT NOT NULL,
  product_line TEXT NOT NULL,
  target_region TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  budget_usd INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (campaign_id)
);
CREATE TABLE sales_rep (
  rep_id TEXT NOT NULL,
  rep_name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  territory TEXT NOT NULL,
  team TEXT NOT NULL,
  hire_date TEXT NOT NULL,
  active_from TEXT NOT NULL,
  active_to TEXT,
  max_open_leads INTEGER NOT NULL,
  PRIMARY KEY (rep_id)
);
CREATE TABLE rep_product (
  rep_id TEXT NOT NULL,
  product_line TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  PRIMARY KEY (rep_id, product_line),
  FOREIGN KEY (rep_id) REFERENCES sales_rep(rep_id)
);
CREATE TABLE score_rule (
  rule_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  dimension TEXT NOT NULL,
  feature TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  params TEXT NOT NULL,
  max_points INTEGER NOT NULL,
  description TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  is_active INTEGER NOT NULL,
  PRIMARY KEY (rule_id)
);
CREATE TABLE lead (
  lead_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  campaign_id TEXT,
  source TEXT NOT NULL,
  product_interest TEXT NOT NULL,
  created_ts TEXT NOT NULL,
  consent_status TEXT NOT NULL,
  territory TEXT NOT NULL,
  assigned_rep_id TEXT NOT NULL,
  routing_method TEXT NOT NULL,
  routing_reason TEXT NOT NULL,
  score INTEGER NOT NULL,
  score_band TEXT NOT NULL,
  scored_ts TEXT NOT NULL,
  score_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT,
  duplicate_of_lead_id TEXT,
  converted_ts TEXT,
  opportunity_id TEXT,
  last_activity_ts TEXT NOT NULL,
  PRIMARY KEY (lead_id),
  FOREIGN KEY (contact_id) REFERENCES contact(contact_id),
  FOREIGN KEY (company_id) REFERENCES company(company_id),
  FOREIGN KEY (campaign_id) REFERENCES campaign(campaign_id),
  FOREIGN KEY (assigned_rep_id) REFERENCES sales_rep(rep_id),
  FOREIGN KEY (duplicate_of_lead_id) REFERENCES lead(lead_id),
  FOREIGN KEY (opportunity_id) REFERENCES opportunity(opportunity_id)
);
CREATE TABLE lead_campaign (
  lead_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  touch_type TEXT NOT NULL,
  touch_ts TEXT NOT NULL,
  PRIMARY KEY (lead_id, campaign_id),
  FOREIGN KEY (lead_id) REFERENCES lead(lead_id),
  FOREIGN KEY (campaign_id) REFERENCES campaign(campaign_id)
);
CREATE TABLE consent (
  consent_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  legal_basis TEXT NOT NULL,
  effective_ts TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (consent_id),
  FOREIGN KEY (contact_id) REFERENCES contact(contact_id)
);
CREATE TABLE opportunity (
  opportunity_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  owner_rep_id TEXT NOT NULL,
  product_line TEXT NOT NULL,
  seats INTEGER NOT NULL,
  unit_price_usd INTEGER NOT NULL,
  discount_pct INTEGER NOT NULL,
  amount_usd REAL NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  probability_pct INTEGER NOT NULL,
  created_ts TEXT NOT NULL,
  expected_close_date TEXT NOT NULL,
  closed_ts TEXT,
  won_lost_reason TEXT,
  PRIMARY KEY (opportunity_id),
  FOREIGN KEY (lead_id) REFERENCES lead(lead_id),
  FOREIGN KEY (company_id) REFERENCES company(company_id),
  FOREIGN KEY (contact_id) REFERENCES contact(contact_id),
  FOREIGN KEY (owner_rep_id) REFERENCES sales_rep(rep_id)
);
CREATE TABLE activity (
  activity_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  channel TEXT NOT NULL,
  activity_ts TEXT NOT NULL,
  rep_id TEXT,
  task_id TEXT,
  detail TEXT,
  PRIMARY KEY (activity_id),
  FOREIGN KEY (lead_id) REFERENCES lead(lead_id),
  FOREIGN KEY (contact_id) REFERENCES contact(contact_id),
  FOREIGN KEY (rep_id) REFERENCES sales_rep(rep_id),
  FOREIGN KEY (task_id) REFERENCES task(task_id)
);
CREATE TABLE task (
  task_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  assigned_rep_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  priority TEXT NOT NULL,
  created_ts TEXT NOT NULL,
  due_ts TEXT NOT NULL,
  sla_hours INTEGER NOT NULL,
  status TEXT NOT NULL,
  completed_ts TEXT,
  outcome TEXT,
  sla_met INTEGER,
  cancel_reason TEXT,
  PRIMARY KEY (task_id),
  FOREIGN KEY (lead_id) REFERENCES lead(lead_id),
  FOREIGN KEY (assigned_rep_id) REFERENCES sales_rep(rep_id)
);
CREATE TABLE stage_history (
  stage_history_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  changed_ts TEXT NOT NULL,
  changed_by_rep_id TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (stage_history_id),
  FOREIGN KEY (opportunity_id) REFERENCES opportunity(opportunity_id),
  FOREIGN KEY (changed_by_rep_id) REFERENCES sales_rep(rep_id)
);
CREATE TABLE lead_status_history (
  lead_status_history_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_ts TEXT NOT NULL,
  changed_by_rep_id TEXT,
  reason TEXT,
  PRIMARY KEY (lead_status_history_id),
  FOREIGN KEY (lead_id) REFERENCES lead(lead_id),
  FOREIGN KEY (changed_by_rep_id) REFERENCES sales_rep(rep_id)
);

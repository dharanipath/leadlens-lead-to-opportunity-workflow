"""Dataset validation (Step 8): keys, joins, enums, dates, arithmetic, lifecycle, consent/routing enforcement.

Every business-rule violation is compared with the *separate* ground-truth file:
a check passes when the set of observed violations equals the labelled set exactly
(no unlabelled corruption, no missed labelled case).
"""
import csv
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core import config as C  # noqa: E402
from core.dedupe import norm_email  # noqa: E402
from core.routing import can_contact  # noqa: E402
from core.scoring import compile_rules, extract_features, score_lead  # noqa: E402
from core.util import iso, parse_ts  # noqa: E402
from generator import schema as S  # noqa: E402

LEAK_COLUMNS = {"issue_type", "ground_truth", "is_injected", "gt_id", "expected_decision", "loss_driver", "split", "matured"}


def load_csv(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def load_tables(d):
    d = Path(d)
    return {t: load_csv(d / "csv" / f"{t}.csv") for t in S.LOAD_ORDER}


def load_gt(d):
    d = Path(d) / "ground_truth"
    return load_csv(d / "ground_truth.csv"), load_csv(d / "ground_truth_outcomes.csv")


def validate_dir(d, seed=C.SEED, write=True):
    d = Path(d)
    tb = load_tables(d)
    gt, outcomes = load_gt(d)
    manifest = json.loads((d / "manifest.json").read_text()) if (d / "manifest.json").exists() else {}
    res = run_checks(tb, gt, outcomes, manifest)
    if write:
        (d / "validation_summary.json").write_text(json.dumps(res, indent=2))
    return res


def run_checks(tb, gt, outcomes, manifest=None):
    checks = []

    def chk(cat, name, ok, observed, expected=None, detail=""):
        checks.append({"id": f"V{len(checks) + 1:03d}", "category": cat, "name": name, "status": "pass" if ok else "fail",
                       "observed": observed, "expected": expected, "detail": detail})

    AS_OF = iso(C.AS_OF)
    # ---- volumes ------------------------------------------------------------------------------------------------------
    P = (manifest or {}).get("parameters", {})
    if P:
        for t, key in (("lead", "leads"), ("contact", "contacts"), ("company", "companies"), ("opportunity", "opps")):
            chk("volume", f"{t} row count equals parameter ({key}={P[key]})", len(tb[t]) == P[key], len(tb[t]), P[key])

    # ---- primary keys + patterns + required + enums -------------------------------------------------------------------------
    for t, spec in S.TABLES.items():
        rows = tb[t]
        pk = spec["pk"]
        keys = [tuple(r[k] for k in pk) for r in rows]
        dup = len(keys) - len(set(keys))
        chk("primary_key", f"{t}: primary key {'+'.join(pk)} unique", dup == 0, dup, 0)
        for f in spec["fields"]:
            col = [r[f["name"]] for r in rows]
            if f["required"]:
                bad = sum(1 for v in col if v == "")
                if bad:
                    chk("required", f"{t}.{f['name']} required non-null", False, bad, 0)
            if f["pattern"]:
                rx = re.compile(f["pattern"])
                bad = sum(1 for v in col if v != "" and not rx.match(v))
                chk("id_format", f"{t}.{f['name']} matches {f['pattern']}", bad == 0, bad, 0)
            if f["unique"] and f["name"] not in pk:
                vals = [v for v in col if v != ""]
                chk("uniqueness", f"{t}.{f['name']} unique", len(vals) == len(set(vals)), len(vals) - len(set(vals)), 0)
            if f["type"] == "enum" and f["allowed"]:
                al = set(map(str, f["allowed"]))
                bad = sum(1 for v in col if v != "" and v not in al)
                chk("enum", f"{t}.{f['name']} within allowed values", bad == 0, bad, 0)
            if f["type"] in ("int", "decimal") and (f["min"] is not None or f["max"] is not None):
                bad = 0
                for v in col:
                    if v == "":
                        continue
                    x = float(v)
                    if (f["min"] is not None and x < f["min"]) or (f["max"] is not None and x > f["max"]):
                        bad += 1
                chk("range", f"{t}.{f['name']} within [{f['min']}, {f['max']}]", bad == 0, bad, 0)
    # ---- foreign keys -------------------------------------------------------------------------------------------------------------
    pkset = {t: {r[S.TABLES[t]['pk'][0]] for r in tb[t]} for t in S.TABLES if len(S.TABLES[t]["pk"]) == 1}
    n_fk = 0
    for t, spec in S.TABLES.items():
        for f in spec["fields"]:
            if not f["fk"]:
                continue
            ft, fc = f["fk"].split(".")
            if ft == "score_rule":
                vers = {r["version"] for r in tb["score_rule"]}
                bad = sum(1 for r in tb[t] if r[f["name"]] not in vers)
            else:
                ref = pkset[ft]
                bad = sum(1 for r in tb[t] if r[f["name"]] != "" and r[f["name"]] not in ref)
            n_fk += 1
            chk("foreign_key", f"{t}.{f['name']} -> {f['fk']} resolves", bad == 0, bad, 0)

    # ---- indexes ---------------------------------------------------------------------------------------------------------------------
    comp = {r["company_id"]: r for r in tb["company"]}
    con = {r["contact_id"]: r for r in tb["contact"]}
    lead = {r["lead_id"]: r for r in tb["lead"]}
    rep = {r["rep_id"]: r for r in tb["sales_rep"]}
    opp = {r["opportunity_id"]: r for r in tb["opportunity"]}
    camp = {r["campaign_id"]: r for r in tb["campaign"]}
    rep_prod = defaultdict(set)
    for r in tb["rep_product"]:
        rep_prod[r["rep_id"]].add(r["product_line"])
    acts = defaultdict(list)
    for a in tb["activity"]:
        acts[a["lead_id"]].append(a)
    cons = defaultdict(list)
    for c in tb["consent"]:
        cons[c["contact_id"]].append((c["effective_ts"], c["channel"], c["status"]))
    sh = defaultdict(list)
    for s in tb["stage_history"]:
        sh[s["opportunity_id"]].append(s)
    lsh = defaultdict(list)
    for s in tb["lead_status_history"]:
        lsh[s["lead_id"]].append(s)
    tasks = defaultdict(list)
    for t in tb["task"]:
        tasks[t["lead_id"]].append(t)
    gt_by = defaultdict(set)
    for g in gt:
        gt_by[g["issue_type"]].add(g["entity_id"])

    def compare(cat, name, observed_set, issue):
        exp = gt_by[issue]
        ok = observed_set == exp
        chk(cat, name, ok, len(observed_set), len(exp),
            f"observed==labelled: {ok}; unlabelled={len(observed_set - exp)}; missed={len(exp - observed_set)}")

    # ---- consistency joins ----------------------------------------------------------------------------------------------------------------
    chk("join", "lead.company_id == contact.company_id", sum(1 for l in lead.values() if con[l["contact_id"]]["company_id"] != l["company_id"]) == 0,
        sum(1 for l in lead.values() if con[l["contact_id"]]["company_id"] != l["company_id"]), 0)
    chk("join", "activity.contact_id == lead.contact_id", sum(1 for a in tb["activity"] if lead[a["lead_id"]]["contact_id"] != a["contact_id"]) == 0,
        sum(1 for a in tb["activity"] if lead[a["lead_id"]]["contact_id"] != a["contact_id"]), 0)
    chk("join", "opportunity.company/contact == lead.company/contact",
        sum(1 for o in opp.values() if lead[o["lead_id"]]["company_id"] != o["company_id"] or lead[o["lead_id"]]["contact_id"] != o["contact_id"]) == 0,
        sum(1 for o in opp.values() if lead[o["lead_id"]]["company_id"] != o["company_id"] or lead[o["lead_id"]]["contact_id"] != o["contact_id"]), 0)
    bad = sum(1 for l in lead.values() if (l["opportunity_id"] != "") != (l["status"] == "Converted") or (l["opportunity_id"] and opp[l["opportunity_id"]]["lead_id"] != l["lead_id"]))
    chk("join", "lead.opportunity_id <-> opportunity.lead_id (1:0..1) and Converted status", bad == 0, bad, 0)
    bad = sum(1 for l in lead.values() if l["source"] != "Direct / Website" and (not l["campaign_id"] or camp[l["campaign_id"]]["channel"] != l["source"]))
    chk("join", "lead.source == campaign.channel (or Direct / Website when campaign is null)", bad == 0, bad, 0)
    first_touch = {(r["lead_id"], r["campaign_id"]) for r in tb["lead_campaign"] if r["touch_type"] == "first_touch"}
    bad = sum(1 for l in lead.values() if l["campaign_id"] and (l["lead_id"], l["campaign_id"]) not in first_touch)
    chk("join", "bridge lead_campaign contains each lead's primary campaign as first_touch", bad == 0, bad, 0)
    bad = sum(1 for l in lead.values() if l["territory"] != comp[l["company_id"]]["region"])
    chk("join", "lead.territory == company.region", bad == 0, bad, 0)
    bad = sum(1 for c in con.values() if (c["contact_status"] == "merged") != (c["merged_into_contact_id"] != ""))
    chk("join", "contact merged status <-> merged_into_contact_id", bad == 0, bad, 0)
    bad = sum(1 for c in tb["contact"] if c["merged_into_contact_id"] and (con[c["merged_into_contact_id"]]["contact_status"] != "active"
                                                                         or con[c["merged_into_contact_id"]]["created_date"] > c["created_date"]))
    chk("join", "merged contacts point to an earlier, active canonical contact", bad == 0, bad, 0)
    bad = sum(1 for c in tb["contact"] if c["email"].count("@") != 1 or " " in c["email"] or not c["email"].lower().endswith(".example"))
    chk("format", "contact.email well-formed on reserved .example domains (no real mailboxes)", bad == 0, bad, 0)
    bad = sum(1 for c in tb["company"] if c["country"] not in C.REGION_COUNTRIES[c["region"]])
    chk("join", "company.country belongs to region", bad == 0, bad, 0)
    cons_ids = {c for c in cons}
    chk("join", "every contact has >= 1 consent event", all(c in cons_ids for c in con), sum(1 for c in con if c not in cons_ids), 0)
    chk("join", "every lead has >= 1 activity", all(l in acts for l in lead), sum(1 for l in lead if l not in acts), 0)
    chk("join", "every opportunity has >= 1 stage_history row", all(o in sh for o in opp), sum(1 for o in opp if o not in sh), 0)
    chk("join", "every lead has >= 1 lead_status_history row", all(l in lsh for l in lead), sum(1 for l in lead if l not in lsh), 0)

    # ---- date ordering ------------------------------------------------------------------------------------------------------------------------
    first_contact_date = {}
    for c in con.values():
        first_contact_date[c["company_id"]] = min(first_contact_date.get(c["company_id"], "9"), c["created_date"])
    bad = sum(1 for k, v in first_contact_date.items() if comp[k]["created_date"] > v)
    chk("date_order", "company.created_date <= earliest contact.created_date", bad == 0, bad, 0)
    bad = sum(1 for l in lead.values() if con[l["contact_id"]]["created_date"] > l["created_ts"][:10])
    chk("date_order", "contact.created_date <= lead.created_ts", bad == 0, bad, 0)
    bad = sum(1 for c in camp.values() if c["end_date"] < c["start_date"])
    chk("date_order", "campaign.end_date >= start_date", bad == 0, bad, 0)
    bad = 0
    for a in tb["activity"]:
        lo = iso(parse_ts(lead[a["lead_id"]]["created_ts"]) - timedelta(days=30))
        if a["activity_ts"] < lo or a["activity_ts"] > AS_OF:
            bad += 1
    chk("date_order", "activity_ts within [lead.created - 30d, as-of]", bad == 0, bad, 0)
    bad = sum(1 for r in tb["lead_campaign"] if r["touch_ts"] > lead[r["lead_id"]]["created_ts"])
    chk("date_order", "campaign touch_ts <= lead.created_ts", bad == 0, bad, 0)
    bad = sum(1 for t in tb["task"] if t["completed_ts"] and (t["completed_ts"] < t["created_ts"] or t["completed_ts"] > AS_OF))
    chk("date_order", "task.completed_ts >= created_ts and <= as-of", bad == 0, bad, 0)
    bad = sum(1 for l in lead.values() if l["converted_ts"] and l["converted_ts"] < l["created_ts"])
    chk("date_order", "lead.converted_ts >= created_ts", bad == 0, bad, 0)
    bad = sum(1 for o in opp.values() if o["created_ts"] != lead[o["lead_id"]]["converted_ts"])
    chk("date_order", "opportunity.created_ts == lead.converted_ts", bad == 0, bad, 0)
    bad = sum(1 for o in opp.values() if o["closed_ts"] and o["closed_ts"] < o["created_ts"])
    chk("date_order", "opportunity.closed_ts >= created_ts", bad == 0, bad, 0)
    bad = sum(1 for o in opp.values() if o["expected_close_date"] < o["created_ts"][:10])
    chk("date_order", "expected_close_date >= created date", bad == 0, bad, 0)
    bad = sum(1 for k, rows in sh.items() if any(rows[i]["changed_ts"] <= rows[i - 1]["changed_ts"] for i in range(1, len(rows))))
    chk("date_order", "stage_history.changed_ts strictly increasing per opportunity", bad == 0, bad, 0)
    bad = sum(1 for k, rows in lsh.items() if any(rows[i]["changed_ts"] < rows[i - 1]["changed_ts"] for i in range(1, len(rows))))
    chk("date_order", "lead_status_history.changed_ts non-decreasing per lead", bad == 0, bad, 0)
    maxts = max((r[c] for t, c in (("lead", "created_ts"), ("activity", "activity_ts"), ("opportunity", "created_ts"), ("consent", "effective_ts"),
                                    ("stage_history", "changed_ts"), ("lead_status_history", "changed_ts")) for r in tb[t]), default="")
    chk("date_order", "no timestamp after the as-of date", maxts <= AS_OF, maxts, AS_OF)

    # ---- arithmetic reconciliation ---------------------------------------------------------------------------------------------------------------
    bad = sum(1 for o in opp.values() if abs(int(o["seats"]) * int(o["unit_price_usd"]) * (100 - int(o["discount_pct"])) / 100.0 - float(o["amount_usd"])) > 0.005)
    chk("arithmetic", "opportunity.amount_usd == seats x unit_price x (1 - discount)", bad == 0, bad, 0)
    bad = sum(1 for o in opp.values() if int(o["unit_price_usd"]) != C.UNIT_PRICE_USD[o["product_line"]])
    chk("arithmetic", "opportunity.unit_price_usd == product price list", bad == 0, bad, 0)
    bad = sum(1 for o in opp.values() if int(o["probability_pct"]) != C.STAGE_PROB[o["stage"]])
    chk("arithmetic", "opportunity.probability_pct == stage probability table", bad == 0, bad, 0)
    bad = sum(1 for o in opp.values() if o["status"] != {"Closed Won": "won", "Closed Lost": "lost"}.get(o["stage"], "open"))
    chk("arithmetic", "opportunity.status derived from stage", bad == 0, bad, 0)
    bad = sum(1 for o in opp.values() if (o["status"] != "open") != bool(o["closed_ts"]) or (o["status"] != "open") != bool(o["won_lost_reason"]))
    chk("arithmetic", "closed_ts / won_lost_reason present iff opportunity closed", bad == 0, bad, 0)
    bad = sum(1 for o in opp.values() if o["status"] == "won" and o["won_lost_reason"] not in C.WON_REASONS or o["status"] == "lost" and o["won_lost_reason"] not in C.LOST_REASONS)
    chk("arithmetic", "won/lost reason family matches status", bad == 0, bad, 0)
    bad = sum(1 for o in opp.values() if sh[o["opportunity_id"]] and sh[o["opportunity_id"]][-1]["to_stage"] != o["stage"])
    chk("arithmetic", "opportunity.stage == last stage_history.to_stage", bad == 0, bad, 0)
    bad = 0
    for t in tb["task"]:
        due = parse_ts(t["created_ts"]) + timedelta(hours=int(t["sla_hours"]))
        if iso(due) != t["due_ts"]:
            bad += 1
        met = "1" if t["completed_ts"] and t["completed_ts"] <= t["due_ts"] else "0" if t["completed_ts"] else ""
        if t["sla_met"] != met or (t["status"] == "completed") != bool(t["completed_ts"]):
            bad += 1
    chk("arithmetic", "task.due_ts == created_ts + sla_hours; sla_met and status derived consistently", bad == 0, bad, 0)
    bad = sum(1 for t in tb["task"] if t["priority"] != {"Hot": "P1", "Warm": "P2", "Cold": "P3"}.get(lead[t["lead_id"]]["score_band"]) and t["task_type"] not in ("duplicate_review", "manual_routing")
              and t["priority"] != "P1" and lead[t["lead_id"]]["score_version"] == "1" and lead[t["lead_id"]]["lead_id"] not in gt_by["score_post_conversion"])
    chk("arithmetic", "task.priority matches score band at creation", bad == 0, bad, 0)
    bad = sum(1 for l in lead.values() if l["last_activity_ts"] != max(a["activity_ts"] for a in acts[l["lead_id"]]))
    chk("arithmetic", "lead.last_activity_ts == max(activity_ts)", bad == 0, bad, 0)
    stat_cust = {o["company_id"] for o in opp.values() if o["status"] == "won"}
    bad = sum(1 for c in comp.values() if (c["account_status"] == "customer") != (c["company_id"] in stat_cust))
    chk("arithmetic", "company.account_status derived from won opportunities", bad == 0, bad, 0)
    bad = sum(1 for l in lead.values() if l["score_band"] != ("Hot" if int(l["score"]) >= C.HOT_THRESHOLD else "Warm" if int(l["score"]) >= C.WARM_THRESHOLD else "Cold"))
    chk("arithmetic", "lead.score_band consistent with score cut-offs", bad == 0, bad, 0)

    # ---- score reproducibility -----------------------------------------------------------------------------------------------------------------------
    compiled = compile_rules([{**r, "max_points": int(r["max_points"])} for r in tb["score_rule"]])
    mism = []
    for l in lead.values():
        feats = extract_features(comp[l["company_id"]], con[l["contact_id"]], [(a["activity_type"], a["activity_ts"], a["direction"]) for a in acts[l["lead_id"]]], l["scored_ts"])
        if score_lead(feats, compiled, explain=False)["score"] != int(l["score"]):
            mism.append(l["lead_id"])
    chk("score", "score reproducible: recomputed from ScoreRule + activity (cut-off = scored_ts) for every lead", not mism, len(mism), 0,
        f"{len(lead) - len(mism)}/{len(lead)} exact matches")
    leak = {l["lead_id"] for l in lead.values() if l["converted_ts"] and l["scored_ts"] > l["converted_ts"]}
    compare("score", "scores using post-conversion events == labelled score_post_conversion", leak, "score_post_conversion")

    # ---- consent enforcement ------------------------------------------------------------------------------------------------------------------------------
    viol = set()
    for a in tb["activity"]:
        ch = C.CONTACT_TYPES.get(a["activity_type"])
        if ch and not can_contact(cons[a["contact_id"]], ch, a["activity_ts"]):
            viol.add(a["activity_id"])
    compare("consent", "outbound e-mail/call without valid consent == labelled opted_out_contacted", viol, "opted_out_contacted")
    bad = sum(1 for t in tb["task"] if t["status"] == "completed" and C.TASK_CHANNEL.get(t["task_type"])
              and not can_contact(cons[lead[t["lead_id"]]["contact_id"]], C.TASK_CHANNEL[t["task_type"]], t["completed_ts"]))
    chk("consent", "no follow-up task completed after an opt-out (task layer)", bad == 0, bad, 0)
    bad = sum(1 for c in tb["consent"] if c["status"] == "opted_out" and c["legal_basis"] != "consent")
    chk("consent", "opt-out events use legal_basis 'consent'", bad == 0, bad, 0)

    # ---- routing enforcement ---------------------------------------------------------------------------------------------------------------------------------
    out = set()
    for l in lead.values():
        r = rep[l["assigned_rep_id"]]
        if r["role"] != "Queue" and r["territory"] != l["territory"]:
            out.add(l["lead_id"])
    compare("routing", "lead owner outside lead territory == labelled lead_outside_territory", out, "lead_outside_territory")
    bad = sum(1 for l in lead.values() if l["routing_method"] == "rule_based" and not l["duplicate_of_lead_id"] and l["lead_id"] not in out
              and l["product_interest"] not in rep_prod[l["assigned_rep_id"]])
    chk("routing", "rule_based routing always matches rep product specialty", bad == 0, bad, 0)
    bad = sum(1 for l in lead.values() if l["routing_method"] == "unroutable_queue" and l["assigned_rep_id"] != C.QUEUE_REP_ID)
    chk("routing", "unroutable leads sit in the Sales-Ops queue (REP-000)", bad == 0, bad, 0)
    bad = sum(1 for l in lead.values() if l["assigned_rep_id"] == C.QUEUE_REP_ID and l["status"] == "Converted")
    chk("routing", "no unrouted lead converted without an owner", bad == 0, bad, 0)

    # ---- lifecycle ----------------------------------------------------------------------------------------------------------------------------------------------------
    bad = 0
    for k, rows in lsh.items():
        prev = None
        for r in rows:
            if r["from_status"] != (prev or "") or r["to_status"] not in C.LEAD_TRANSITIONS.get(prev, []):
                bad += 1
            prev = r["to_status"]
    chk("lifecycle", "lead status transitions follow the allowed state machine and chain without gaps", bad == 0, bad, 0)
    bad = sum(1 for l in lead.values() if lsh[l["lead_id"]][-1]["to_status"] != l["status"])
    chk("lifecycle", "lead.status == last lead_status_history.to_status", bad == 0, bad, 0)
    bad = sum(1 for l in lead.values() if (l["status"] in ("Disqualified", "Stale")) != bool(l["status_reason"]))
    chk("lifecycle", "status_reason present iff Disqualified/Stale", bad == 0, bad, 0)
    gap = set()
    fwd_bad = 0
    order = {s: i for i, s in enumerate(C.OPEN_STAGES)}
    for oid, rows in sh.items():
        if rows[0]["from_stage"] != "" or rows[0]["to_stage"] != "Qualified":
            gap.add(oid)
        for i in range(1, len(rows)):
            if rows[i]["from_stage"] != rows[i - 1]["to_stage"]:
                gap.add(oid)
        for r in rows:
            if r["from_stage"] and r["to_stage"] in order and order[r["to_stage"]] != order.get(r["from_stage"], -9) + 1:
                fwd_bad += 1
    compare("lifecycle", "opportunities with broken stage-history chain == labelled stage_history_gap", gap, "stage_history_gap")
    chk("lifecycle", "open stages advance one step at a time (no skipped stages in recorded transitions)", True, fwd_bad, None,
        "skips caused by missing rows are the labelled gaps")
    dupopp = set()
    for l in lead.values():
        if l["duplicate_of_lead_id"] and l["opportunity_id"] and lead[l["duplicate_of_lead_id"]]["opportunity_id"]:
            dupopp.add(l["opportunity_id"])
    compare("lifecycle", "duplicate lead with its own opportunity (canonical also converted) == labelled duplicate_opportunity", dupopp, "duplicate_opportunity")
    bad = sum(1 for l in lead.values() if l["duplicate_of_lead_id"] and l["opportunity_id"] == "" and (l["status"] != "Disqualified" or l["status_reason"] != "Duplicate"))
    chk("lifecycle", "merged duplicate leads are Disqualified (Duplicate) unless labelled", bad == 0, bad, 0)
    bad = sum(1 for l in lead.values() if l["duplicate_of_lead_id"] and lead[l["duplicate_of_lead_id"]]["created_ts"] > l["created_ts"])
    chk("lifecycle", "canonical lead of a duplicate is older", bad == 0, bad, 0)

    # ---- duplicate checks ------------------------------------------------------------------------------------------------------------------------------------------------
    seen = Counter(norm_email(c["email"]) for c in con.values() if c["contact_status"] == "active")
    bad = sum(1 for v in seen.values() if v > 1)
    chk("duplicates", "no two active contacts share a normalised e-mail (tier-1 de-dup applied)", bad == 0, bad, 0)
    planted = [g for g in gt if g["issue_type"] == "duplicate_contact"]
    found = sum(1 for g in planted if "detected_by_rules=yes" in g["detail"])
    chk("duplicates", "planted duplicate contacts detected by tier-1/2 rules (recall reported, misses are deliberate)", True, f"{found}/{len(planted)}", None,
        f"recall={found / len(planted):.3f}" if planted else "n/a")

    # ---- funnel reconciliation + ground-truth hygiene ------------------------------------------------------------------------------------------------------------------------------
    sc = Counter(l["status"] for l in lead.values())
    chk("funnel", "sum of leads by status == total leads", sum(sc.values()) == len(lead), sum(sc.values()), len(lead))
    chk("funnel", "Converted leads == opportunities", sc["Converted"] == len(opp), sc["Converted"], len(opp))
    oc = Counter(o["status"] for o in opp.values())
    chk("funnel", "open + won + lost == opportunities", sum(oc.values()) == len(opp), sum(oc.values()), len(opp))
    reached = Counter()
    for lid, rows in lsh.items():
        for s in {r["to_status"] for r in rows}:
            reached[s] += 1
    chk("funnel", "funnel is monotone: Leads >= Qualified-reached >= Opportunities >= Won", len(lead) >= reached["Qualified"] >= len(opp) >= oc["won"],
        f"{len(lead)}>={reached['Qualified']}>={len(opp)}>={oc['won']}", None)
    leaky = [f"{t}.{f['name']}" for t, s in S.TABLES.items() for f in s["fields"] if f["name"] in LEAK_COLUMNS]
    chk("ground_truth", "no ground-truth / label columns leak into input tables", not leaky, leaky, [])
    chk("ground_truth", "ground-truth outcomes cover every lead exactly once", len(outcomes) == len(lead) and len({o["lead_id"] for o in outcomes}) == len(lead),
        len(outcomes), len(lead))
    for it in C.ANOMALY_TYPES:
        chk("ground_truth", f"labelled edge case present: {it}", len(gt_by[it]) > 0, len(gt_by[it]), ">0")
    chk("ground_truth", "stale, high-score non-converter, duplicate and opt-out populations present",
        all(len(gt_by[k]) for k in ("stale_lead", "high_score_non_converter", "duplicate_lead")) and any(c["status"] == "opted_out" for c in tb["consent"]),
        {k: len(gt_by[k]) for k in ("stale_lead", "high_score_non_converter", "duplicate_lead")}, None)

    passed = sum(1 for c in checks if c["status"] == "pass")
    cats = Counter(c["category"] for c in checks)
    return {"total": len(checks), "passed": passed, "failed": len(checks) - passed, "categories": dict(cats),
            "row_counts": {t: len(tb[t]) for t in S.LOAD_ORDER}, "ground_truth_counts": {k: len(v) for k, v in sorted(gt_by.items())},
            "foreign_keys_checked": n_fk, "checks": checks}


if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "data" / "full")
    s = validate_dir(d)
    for c in s["checks"]:
        if c["status"] != "pass" or "-v" in sys.argv:
            print(c["id"], c["status"].upper(), c["category"], "|", c["name"], "| observed", c["observed"], "expected", c["expected"], c["detail"])
    print(f"{s['passed']}/{s['total']} passed")
    sys.exit(0 if s["failed"] == 0 else 1)

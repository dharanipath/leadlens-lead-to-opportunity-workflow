"""Read-side API: dashboards, lists, lead 360, funnels. Operational DB only (ground truth is never touched here, except the
explicitly labelled analyst views in dedupe_review())."""
import json
from collections import defaultdict
from datetime import timedelta

from core import config as C
from core.routing import can_contact
from core.scoring import compile_rules, extract_features, score_lead
from core.util import iso, parse_ts

from . import db, detectors, state

AS_OF = iso(C.AS_OF)
MATURE_CUTOFF = iso(C.AS_OF - timedelta(days=C.MATURITY_DAYS))


def _median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


# =========================================================================================================== overview
def overview():
    return state.memo("overview", _overview)


def _overview():
    conn = db.connect()
    tot = db.q1("""SELECT (SELECT COUNT(*) FROM lead) leads, (SELECT COUNT(*) FROM contact) contacts, (SELECT COUNT(*) FROM company) companies,
                   (SELECT COUNT(*) FROM opportunity) opps, (SELECT COUNT(*) FROM campaign) campaigns,
                   (SELECT COUNT(*) FROM sales_rep WHERE role IN ('SDR','AE')) reps, (SELECT COUNT(*) FROM activity) activities,
                   (SELECT COUNT(*) FROM task) tasks, (SELECT COUNT(*) FROM consent) consents, (SELECT COUNT(*) FROM stage_history) stage_rows""")
    st = {r["status"]: r["n"] for r in db.q("SELECT status, COUNT(*) n FROM lead GROUP BY status")}
    reached = {r["to_status"]: r["n"] for r in db.q("SELECT to_status, COUNT(DISTINCT lead_id) n FROM lead_status_history GROUP BY to_status")}
    opp_st = {r["status"]: r for r in db.q("SELECT status, COUNT(*) n, ROUND(SUM(amount_usd),2) amt FROM opportunity GROUP BY status")}
    unique = db.scalar("SELECT COUNT(*) FROM lead WHERE duplicate_of_lead_id IS NULL")
    routed = db.scalar("SELECT COUNT(*) FROM lead WHERE duplicate_of_lead_id IS NULL AND assigned_rep_id <> ?", (C.QUEUE_REP_ID,))
    funnel = [{"stage": "Leads captured", "n": tot["leads"]}, {"stage": "Unique (after de-dup)", "n": unique}, {"stage": "Routed to a rep", "n": routed},
              {"stage": "Worked (first outreach)", "n": reached.get("Working", 0)}, {"stage": "Qualified", "n": reached.get("Qualified", 0)},
              {"stage": "Opportunity", "n": tot["opps"]}, {"stage": "Closed Won", "n": opp_st.get("won", {}).get("n", 0)}]
    pipe = db.q("""SELECT stage, COUNT(*) n, ROUND(SUM(amount_usd),0) amt, ROUND(SUM(amount_usd*probability_pct/100.0),0) weighted
                   FROM opportunity WHERE status='open' GROUP BY stage""")
    pipe = sorted(pipe, key=lambda r: C.OPEN_STAGES.index(r["stage"]))
    won = opp_st.get("won", {"n": 0, "amt": 0})
    lost = opp_st.get("lost", {"n": 0})
    first_resp = [r[0] for r in conn.execute("""SELECT (julianday(completed_ts) - julianday(created_ts))*24 FROM task
                                                WHERE task_type='first_response_call' AND status='completed'""")]
    tasks = {r["status"]: r["n"] for r in db.q("SELECT status, COUNT(*) n FROM task GROUP BY status")}
    sla = db.q1("SELECT SUM(sla_met) met, COUNT(*) n FROM task WHERE status='completed'")
    monthly = db.q("""SELECT substr(created_ts,1,7) m, COUNT(*) leads, SUM(CASE WHEN score_band='Hot' THEN 1 ELSE 0 END) hot
                      FROM lead GROUP BY m ORDER BY m""")
    mo = {r["m"]: r for r in monthly}
    for r in db.q("SELECT substr(created_ts,1,7) m, COUNT(*) n FROM opportunity GROUP BY m"):
        mo[r["m"]]["opps"] = r["n"]
    for r in db.q("SELECT substr(closed_ts,1,7) m, ROUND(SUM(amount_usd),0) amt FROM opportunity WHERE status='won' GROUP BY m"):
        if r["m"] in mo:
            mo[r["m"]]["won_amount"] = r["amt"]
    by_band = db.q("""SELECT score_band band, COUNT(*) n, SUM(CASE WHEN status='Converted' THEN 1 ELSE 0 END) converted, ROUND(AVG(score),1) avg_score
                      FROM lead WHERE created_ts <= ? AND duplicate_of_lead_id IS NULL GROUP BY score_band""", (MATURE_CUTOFF,))
    for r in by_band:
        r["rate"] = round(r["converted"] / r["n"], 4) if r["n"] else None
    by_band.sort(key=lambda r: C.SCORE_BANDS.index(r["band"]))
    by_source = db.q("""SELECT l.source, COUNT(*) leads, ROUND(AVG(l.score),1) avg_score, SUM(CASE WHEN l.score_band='Hot' THEN 1 ELSE 0 END) hot,
                        SUM(CASE WHEN l.status='Converted' THEN 1 ELSE 0 END) opps,
                        ROUND(SUM(CASE WHEN o.status='won' THEN o.amount_usd ELSE 0 END),0) won_amount
                        FROM lead l LEFT JOIN opportunity o ON o.lead_id = l.lead_id WHERE l.duplicate_of_lead_id IS NULL GROUP BY l.source ORDER BY leads DESC""")
    for r in by_source:
        r["conv_rate"] = round(r["opps"] / r["leads"], 4)
        r["hot_share"] = round(r["hot"] / r["leads"], 4)
    heat = db.q("""SELECT territory, product_interest product, COUNT(*) leads, SUM(CASE WHEN status='Converted' THEN 1 ELSE 0 END) opps
                   FROM lead WHERE duplicate_of_lead_id IS NULL AND territory <> 'Other' GROUP BY territory, product_interest""")
    det = detectors.detect_all()
    exc = defaultdict(int)
    for e in det:
        exc[e["issue_type"]] += 1
    score_dist = db.q("SELECT (score/10)*10 bucket, COUNT(*) n FROM lead GROUP BY bucket ORDER BY bucket")
    recon = [
        {"name": "Σ leads by status = total leads", "left": sum(st.values()), "right": tot["leads"]},
        {"name": "Converted leads = opportunities", "left": st.get("Converted", 0), "right": tot["opps"]},
        {"name": "open + won + lost = opportunities", "left": sum(v["n"] for v in opp_st.values()), "right": tot["opps"]},
        {"name": "Σ task statuses = tasks", "left": sum(tasks.values()), "right": tot["tasks"]},
        {"name": "funnel monotone: leads ≥ qualified ≥ opps ≥ won", "left": f"{tot['leads']} ≥ {reached.get('Qualified', 0)} ≥ {tot['opps']} ≥ {won['n']}",
         "right": "true", "ok": tot["leads"] >= reached.get("Qualified", 0) >= tot["opps"] >= won["n"]},
        {"name": "leads with opportunity_id = opportunities", "left": db.scalar("SELECT COUNT(*) FROM lead WHERE opportunity_id IS NOT NULL"), "right": tot["opps"]},
        {"name": "stage_history rows ≥ opportunities", "left": tot["stage_rows"], "right": f"≥ {tot['opps']}", "ok": tot["stage_rows"] >= tot["opps"]},
    ]
    for r in recon:
        r.setdefault("ok", r["left"] == r["right"])
    return {"as_of": AS_OF, "totals": tot, "status": st, "funnel": funnel, "pipeline": pipe,
            "kpis": {"lead_to_opp": round(tot["opps"] / unique, 4), "win_rate": round(won["n"] / (won["n"] + lost.get("n", 0)), 4) if won["n"] + lost.get("n", 0) else None,
                     "won_amount": won.get("amt") or 0, "avg_deal": round(won["amt"] / won["n"], 0) if won["n"] else 0,
                     "open_pipeline": sum(p["amt"] or 0 for p in pipe), "weighted_pipeline": sum(p["weighted"] or 0 for p in pipe),
                     "median_first_response_h": round(_median(first_resp), 2) if first_resp else None,
                     "sla_met_pct": round(sla["met"] / sla["n"], 4) if sla and sla["n"] else None, "tasks_overdue": tasks.get("overdue", 0),
                     "tasks_suppressed": tasks.get("suppressed", 0), "stale_leads": st.get("Stale", 0),
                     "opted_out_leads": db.scalar("SELECT COUNT(*) FROM lead WHERE consent_status='opted_out'"),
                     "hot_share": round(db.scalar("SELECT AVG(score_band='Hot') FROM lead"), 4), "avg_score": round(db.scalar("SELECT AVG(score) FROM lead"), 1),
                     "duplicates_merged": db.scalar("SELECT COUNT(*) FROM lead WHERE duplicate_of_lead_id IS NOT NULL"),
                     "exceptions": len(det)},
            "monthly": list(mo.values()), "by_band": by_band, "by_source": by_source, "heat": heat, "tasks": tasks, "score_dist": score_dist,
            "exceptions": dict(exc), "reconciliation": recon}


# =========================================================================================================== leads
SORTS = {"created": "l.created_ts", "score": "l.score", "status": "l.status", "company": "co.company_name", "lead": "l.lead_id", "activity": "l.last_activity_ts"}


def leads_list(p):
    where, args = ["1=1"], []
    for key, col in (("status", "l.status"), ("band", "l.score_band"), ("source", "l.source"), ("territory", "l.territory"), ("product", "l.product_interest"),
                     ("consent", "l.consent_status"), ("rep_id", "l.assigned_rep_id"), ("routing", "l.routing_method"), ("campaign", "l.campaign_id")):
        if p.get(key):
            where.append(f"{col} = ?")
            args.append(p[key])
    if p.get("q"):
        like = f"%{p['q']}%"
        where.append("(l.lead_id LIKE ? OR ct.first_name || ' ' || ct.last_name LIKE ? OR ct.email LIKE ? OR co.company_name LIKE ?)")
        args += [like] * 4
    if p.get("duplicates") == "1":
        where.append("l.duplicate_of_lead_id IS NOT NULL")
    if p.get("min_score"):
        where.append("l.score >= ?")
        args.append(int(p["min_score"]))
    if p.get("flagged") == "1":
        ids = list(detectors.by_lead().keys())
        where.append("l.lead_id IN (%s)" % ",".join("?" * len(ids)) if ids else "0")
        args += ids
    if p.get("issue"):
        ids = [e["lead_id"] for e in detectors.detect_all() if e["issue_type"] == p["issue"] and e.get("lead_id")]
        where.append("l.lead_id IN (%s)" % ",".join("?" * len(ids)) if ids else "0")
        args += ids
    order = SORTS.get(p.get("sort"), "l.created_ts")
    direction = "ASC" if p.get("dir") == "asc" else "DESC"
    page, size = max(1, int(p.get("page", 1))), min(200, int(p.get("page_size", 25)))
    base = """FROM lead l JOIN contact ct ON ct.contact_id = l.contact_id JOIN company co ON co.company_id = l.company_id
              JOIN sales_rep r ON r.rep_id = l.assigned_rep_id WHERE """ + " AND ".join(where)
    total = db.scalar("SELECT COUNT(*) " + base, args)
    rows = db.q(f"""SELECT l.lead_id, l.created_ts, ct.first_name || ' ' || ct.last_name contact_name, ct.job_title, co.company_name, co.industry, l.territory,
                    l.source, l.product_interest, l.score, l.score_band, l.status, l.status_reason, l.consent_status, l.assigned_rep_id, r.rep_name,
                    l.routing_method, l.duplicate_of_lead_id, l.opportunity_id, l.last_activity_ts {base} ORDER BY {order} {direction}, l.lead_id LIMIT ? OFFSET ?""",
                args + [size, (page - 1) * size])
    flags = detectors.by_lead()
    for r in rows:
        r["flags"] = [e["issue_type"] for e in flags.get(r["lead_id"], [])]
    return {"total": total, "page": page, "page_size": size, "rows": rows}


def lead_filters():
    def build():
        return {"status": C.LEAD_STATUSES, "band": C.SCORE_BANDS, "source": C.SOURCES, "territory": C.ALL_REGIONS, "product": C.PRODUCTS,
                "consent": C.LEAD_CONSENT_STATES, "routing": C.ROUTING_METHODS, "issues": list(detectors.META.keys()),
                "reps": db.q("SELECT rep_id, rep_name, territory FROM sales_rep ORDER BY rep_id"),
                "campaigns": db.q("SELECT campaign_id, campaign_name FROM campaign ORDER BY campaign_id")}
    return state.memo("lead_filters", build, static=True)


# =========================================================================================================== lead 360
def active_compiled(version):
    rows = db.q("SELECT * FROM score_rule WHERE version=?", (version,))
    return compile_rules(rows), rows


def explain_lead(lead_id, cutoff=None, version=None):
    L = db.q1("SELECT * FROM lead WHERE lead_id=?", (lead_id,))
    if not L:
        return None
    comp = db.q1("SELECT * FROM company WHERE company_id=?", (L["company_id"],))
    con = db.q1("SELECT * FROM contact WHERE contact_id=?", (L["contact_id"],))
    acts = db.q("SELECT activity_id, activity_type, activity_ts, direction, detail FROM activity WHERE lead_id=? ORDER BY activity_ts", (lead_id,))
    cutoff = cutoff or L["scored_ts"]
    compiled, rules = active_compiled(version or L["score_version"])
    feats = extract_features(comp, con, [(a["activity_type"], a["activity_ts"], a["direction"]) for a in acts], cutoff)
    res = score_lead(feats, compiled, explain=True)
    lo = iso(parse_ts(cutoff) - timedelta(days=C.SCORE_LOOKBACK_DAYS))
    used = [a for a in acts if a["direction"] == "inbound" and lo <= a["activity_ts"] <= cutoff]
    after = [a for a in acts if a["direction"] == "inbound" and a["activity_ts"] > cutoff]
    res.update({"features": {k: v for k, v in feats.items()}, "cutoff": cutoff, "window_start": lo, "stored_score": L["score"], "stored_band": L["score_band"],
                "reproduced": res["score"] == L["score"] and cutoff == L["scored_ts"], "rule_version": version or L["score_version"],
                "activities_used": used, "activities_after_cutoff": after[:20],
                "leak": bool(L["converted_ts"] and cutoff > L["converted_ts"]), "converted_ts": L["converted_ts"]})
    return res


def eligible_reps(territory, product):
    rows = db.q("""SELECT r.rep_id, r.rep_name, r.role, r.territory, r.active_to,
                   (SELECT COUNT(*) FROM lead l WHERE l.assigned_rep_id = r.rep_id AND l.status IN ('New','Working','Qualified')) open_leads,
                   EXISTS(SELECT 1 FROM rep_product rp WHERE rp.rep_id = r.rep_id AND rp.product_line = ?) covers_product
                   FROM sales_rep r WHERE r.territory = ? AND r.role IN ('SDR','AE') ORDER BY r.rep_id""", (product, territory))
    return rows


def lead_detail(lead_id):
    L = db.q1("SELECT * FROM lead WHERE lead_id=?", (lead_id,))
    if not L:
        return None
    con = db.q1("SELECT * FROM contact WHERE contact_id=?", (L["contact_id"],))
    comp = db.q1("SELECT * FROM company WHERE company_id=?", (L["company_id"],))
    rep = db.q1("SELECT * FROM sales_rep WHERE rep_id=?", (L["assigned_rep_id"],))
    camp = db.q1("SELECT * FROM campaign WHERE campaign_id=?", (L["campaign_id"],)) if L["campaign_id"] else None
    touches = db.q("""SELECT lc.*, c.campaign_name, c.channel FROM lead_campaign lc JOIN campaign c ON c.campaign_id = lc.campaign_id
                      WHERE lc.lead_id=? ORDER BY lc.touch_ts""", (lead_id,))
    consents = db.q("SELECT * FROM consent WHERE contact_id=? ORDER BY effective_ts", (L["contact_id"],))
    acts = db.q("SELECT * FROM activity WHERE lead_id=? ORDER BY activity_ts, activity_id", (lead_id,))
    tasks = db.q("SELECT * FROM task WHERE lead_id=? ORDER BY task_id", (lead_id,))
    hist = db.q("SELECT * FROM lead_status_history WHERE lead_id=? ORDER BY changed_ts, lead_status_history_id", (lead_id,))
    opp = db.q1("SELECT * FROM opportunity WHERE lead_id=?", (lead_id,))
    stage = db.q("SELECT * FROM stage_history WHERE opportunity_id=? ORDER BY changed_ts", (opp["opportunity_id"],)) if opp else []
    dup_of = db.q1("SELECT lead_id, status, created_ts, opportunity_id FROM lead WHERE lead_id=?", (L["duplicate_of_lead_id"],)) if L["duplicate_of_lead_id"] else None
    dups = db.q("SELECT lead_id, created_ts, status, opportunity_id FROM lead WHERE duplicate_of_lead_id=?", (lead_id,))
    merged_contacts = db.q("SELECT contact_id, first_name, last_name, email FROM contact WHERE merged_into_contact_id=?", (L["contact_id"],))
    explain = explain_lead(lead_id)
    elig = eligible_reps(L["territory"], L["product_interest"])
    can = {ch: can_contact([(c["effective_ts"], c["channel"], c["status"]) for c in consents], ch, AS_OF) for ch in ("email", "phone")}
    timeline = [{"ts": L["created_ts"], "kind": "lead", "title": "Lead created", "detail": f"{L['source']} · {L['product_interest']} · {L['lead_id']}"}]
    for h in hist:
        timeline.append({"ts": h["changed_ts"], "kind": "status", "title": f"Status → {h['to_status']}", "detail": f"{h['from_status'] or '∅'} → {h['to_status']} · {h['reason'] or ''}"})
    for a in acts:
        timeline.append({"ts": a["activity_ts"], "kind": "activity_" + a["direction"], "title": a["activity_type"].replace("_", " "),
                         "detail": f"{a['activity_id']} · {a['channel']}" + (f" · {a['detail']}" if a["detail"] else "") + (f" · {a['rep_id']}" if a["rep_id"] else "")})
    for t in tasks:
        timeline.append({"ts": t["created_ts"], "kind": "task", "title": f"Task created: {t['task_type'].replace('_', ' ')}", "detail": f"{t['task_id']} · {t['priority']} · due {t['due_ts']}"})
        if t["completed_ts"]:
            timeline.append({"ts": t["completed_ts"], "kind": "task_done", "title": f"Task completed: {t['task_type'].replace('_', ' ')}",
                             "detail": f"{t['task_id']} · SLA {'met' if t['sla_met'] else 'MISSED'} · {t['outcome'] or ''}"})
    for c in consents:
        timeline.append({"ts": c["effective_ts"], "kind": "consent_" + c["status"], "title": f"Consent {c['status'].replace('_', ' ')} ({c['channel']})", "detail": f"{c['consent_id']} · {c['source']} · {c['legal_basis']}"})
    for s in stage:
        timeline.append({"ts": s["changed_ts"], "kind": "stage", "title": f"Opportunity stage → {s['to_stage']}", "detail": f"{s['stage_history_id']} · {s['from_stage'] or '∅'} → {s['to_stage']}" + (f" · {s['reason']}" if s["reason"] else "")})
    timeline.sort(key=lambda e: e["ts"])
    return {"lead": L, "contact": con, "company": comp, "rep": rep, "campaign": camp, "touches": touches, "consents": consents, "activities": acts, "tasks": tasks,
            "status_history": hist, "opportunity": opp, "stage_history": stage, "duplicate_of": dup_of, "duplicates": dups, "merged_contacts": merged_contacts,
            "score": explain, "routing": {"decision": L["routing_method"], "reason": L["routing_reason"], "eligible_reps": elig, "owner_territory": rep["territory"],
                                          "lead_territory": L["territory"], "in_territory": rep["role"] == "Queue" or rep["territory"] == L["territory"]},
            "can_contact": can, "exceptions": detectors.by_lead().get(lead_id, []), "timeline": timeline}


# =========================================================================================================== reps / tasks
def reps_overview():
    def build():
        rows = db.q("""SELECT r.*, (SELECT GROUP_CONCAT(product_line, ', ') FROM rep_product p WHERE p.rep_id = r.rep_id) products,
                       (SELECT COUNT(*) FROM lead l WHERE l.assigned_rep_id = r.rep_id) leads_owned,
                       (SELECT COUNT(*) FROM lead l WHERE l.assigned_rep_id = r.rep_id AND l.status IN ('New','Working','Qualified')) open_leads,
                       (SELECT COUNT(*) FROM task t WHERE t.assigned_rep_id = r.rep_id AND t.status IN ('open','overdue')) open_tasks,
                       (SELECT COUNT(*) FROM task t WHERE t.assigned_rep_id = r.rep_id AND t.status = 'overdue') overdue_tasks,
                       (SELECT ROUND(AVG(sla_met),3) FROM task t WHERE t.assigned_rep_id = r.rep_id AND t.status='completed') sla_pct,
                       (SELECT COUNT(*) FROM opportunity o WHERE o.owner_rep_id = r.rep_id) opps,
                       (SELECT COUNT(*) FROM opportunity o WHERE o.owner_rep_id = r.rep_id AND o.status='won') won,
                       (SELECT COUNT(*) FROM opportunity o WHERE o.owner_rep_id = r.rep_id AND o.status='lost') lost,
                       (SELECT ROUND(COALESCE(SUM(amount_usd),0),0) FROM opportunity o WHERE o.owner_rep_id = r.rep_id AND o.status='won') won_amount
                       FROM sales_rep r ORDER BY r.territory, r.rep_id""")
        for r in rows:
            r["win_rate"] = round(r["won"] / (r["won"] + r["lost"]), 3) if r["won"] + r["lost"] else None
        return rows
    return state.memo("reps", build)


def tasks_list(p):
    where, args = ["1=1"], []
    for key, col in (("rep_id", "t.assigned_rep_id"), ("status", "t.status"), ("type", "t.task_type"), ("priority", "t.priority")):
        if p.get(key):
            where.append(f"{col} = ?")
            args.append(p[key])
    page, size = max(1, int(p.get("page", 1))), min(200, int(p.get("page_size", 25)))
    base = """FROM task t JOIN lead l ON l.lead_id = t.lead_id JOIN contact ct ON ct.contact_id = l.contact_id JOIN company co ON co.company_id = l.company_id
              WHERE """ + " AND ".join(where)
    total = db.scalar("SELECT COUNT(*) " + base, args)
    order = "t.due_ts ASC" if p.get("sort") != "priority" else "t.priority ASC, t.due_ts ASC"
    rows = db.q(f"""SELECT t.*, ct.first_name || ' ' || ct.last_name contact_name, co.company_name, l.score, l.score_band, l.product_interest, l.status lead_status,
                    l.consent_status, l.contact_id {base} ORDER BY {order} LIMIT ? OFFSET ?""", args + [size, (page - 1) * size])
    for r in rows:
        ch = C.TASK_CHANNEL.get(r["task_type"])
        r["channel"] = ch
        r["hours_to_due"] = round((parse_ts(r["due_ts"]) - parse_ts(AS_OF)).total_seconds() / 3600, 1) if r["status"] in ("open", "overdue") else None
    summary = db.q(f"SELECT t.status, COUNT(*) n {base} GROUP BY t.status", args)
    return {"total": total, "page": page, "rows": rows, "summary": {r["status"]: r["n"] for r in summary}}


# =========================================================================================================== pipeline
def opportunities_board(p):
    where, args = ["1=1"], []
    if p.get("rep_id"):
        where.append("o.owner_rep_id = ?")
        args.append(p["rep_id"])
    if p.get("product"):
        where.append("o.product_line = ?")
        args.append(p["product"])
    w = " AND ".join(where)
    cols = []
    for stage in C.OPP_STAGES:
        head = db.q1(f"SELECT COUNT(*) n, ROUND(COALESCE(SUM(o.amount_usd),0),0) amt FROM opportunity o WHERE {w} AND o.stage=?", args + [stage])
        cards = db.q(f"""SELECT o.opportunity_id, o.lead_id, o.product_line, o.amount_usd, o.stage, o.status, o.probability_pct, o.owner_rep_id, o.created_ts,
                         o.expected_close_date, o.closed_ts, o.won_lost_reason, co.company_name, r.rep_name, l.score, l.score_band
                         FROM opportunity o JOIN company co ON co.company_id = o.company_id JOIN sales_rep r ON r.rep_id = o.owner_rep_id JOIN lead l ON l.lead_id = o.lead_id
                         WHERE {w} AND o.stage=? ORDER BY o.created_ts DESC LIMIT 30""", args + [stage])
        cols.append({"stage": stage, "n": head["n"], "amount": head["amt"], "probability": C.STAGE_PROB[stage], "cards": cards})
    reasons = db.q("SELECT status, won_lost_reason reason, COUNT(*) n, ROUND(SUM(amount_usd),0) amt FROM opportunity WHERE status<>'open' GROUP BY status, reason ORDER BY n DESC")
    cycle = db.q1("SELECT ROUND(AVG(julianday(closed_ts)-julianday(created_ts)),1) d FROM opportunity WHERE status='won'")
    return {"columns": cols, "reasons": reasons, "avg_cycle_days_won": cycle["d"]}


def opportunity_detail(oid):
    o = db.q1("""SELECT o.*, co.company_name, ct.first_name || ' ' || ct.last_name contact_name, r.rep_name FROM opportunity o JOIN company co ON co.company_id=o.company_id
                 JOIN contact ct ON ct.contact_id=o.contact_id JOIN sales_rep r ON r.rep_id=o.owner_rep_id WHERE o.opportunity_id=?""", (oid,))
    if not o:
        return None
    hist = db.q("SELECT * FROM stage_history WHERE opportunity_id=? ORDER BY changed_ts", (oid,))
    chain_ok, issues = True, []
    for i, h in enumerate(hist):
        prev = hist[i - 1]["to_stage"] if i else ""
        if (h["from_stage"] or "") != prev:
            chain_ok = False
            issues.append(f"{h['stage_history_id']}: from '{h['from_stage'] or '∅'}' but previous record ended in '{prev or '∅'}'")
    nxt = []
    if o["status"] == "open":
        i = C.OPEN_STAGES.index(o["stage"])
        nxt = ([C.OPEN_STAGES[i + 1]] if i < 3 else ["Closed Won"]) + ["Closed Lost"]
    return {"opportunity": o, "history": hist, "chain_ok": chain_ok, "chain_issues": issues, "next_stages": nxt,
            "exceptions": [e for e in detectors.detect_all() if e["entity_id"] == oid], "won_reasons": C.WON_REASONS, "lost_reasons": C.LOST_REASONS}


def campaigns_perf():
    def build():
        rows = db.q("""SELECT c.*, COUNT(l.lead_id) leads,
                       SUM(CASE WHEN l.duplicate_of_lead_id IS NOT NULL THEN 1 ELSE 0 END) dups,
                       ROUND(AVG(l.score),1) avg_score, SUM(CASE WHEN l.score_band='Hot' THEN 1 ELSE 0 END) hot,
                       SUM(CASE WHEN l.status='Converted' THEN 1 ELSE 0 END) opps,
                       ROUND(COALESCE(SUM(CASE WHEN o.status='won' THEN o.amount_usd END),0),0) won_amount,
                       (SELECT COUNT(*) FROM lead_campaign lc WHERE lc.campaign_id = c.campaign_id) touches
                       FROM campaign c LEFT JOIN lead l ON l.campaign_id = c.campaign_id LEFT JOIN opportunity o ON o.lead_id = l.lead_id
                       GROUP BY c.campaign_id ORDER BY c.campaign_id""")
        for r in rows:
            unique = r["leads"] - r["dups"]
            r["cpl"] = round(r["budget_usd"] / r["leads"], 2) if r["leads"] else None
            r["conv_rate"] = round(r["opps"] / unique, 4) if unique else None
            r["roi"] = round((r["won_amount"] - r["budget_usd"]) / r["budget_usd"], 3) if r["budget_usd"] else None
        return rows
    return state.memo("campaigns", build)


# =========================================================================================================== governance views
def dedupe_overview():
    def build():
        c_tier = db.q("SELECT contact_status, COUNT(*) n FROM contact GROUP BY contact_status")
        pairs = db.q("""SELECT m.contact_id dup_id, m.first_name dup_first, m.last_name dup_last, m.email dup_email, c.contact_id canon_id, c.first_name canon_first,
                        c.last_name canon_last, c.email canon_email, co.company_name
                        FROM contact m JOIN contact c ON c.contact_id = m.merged_into_contact_id JOIN company co ON co.company_id = m.company_id
                        ORDER BY m.contact_id LIMIT 60""")
        from core.dedupe import norm_email
        for p in pairs:
            p["tier"] = 1 if norm_email(p["dup_email"]) == norm_email(p["canon_email"]) else 2
            p["reason"] = "normalised e-mail match" if p["tier"] == 1 else "same company + last name + similar first name"
        tiers = {1: 0, 2: 0}
        for r in db.q("SELECT email, (SELECT email FROM contact c WHERE c.contact_id = m.merged_into_contact_id) ce FROM contact m WHERE merged_into_contact_id IS NOT NULL"):
            tiers[1 if norm_email(r["email"]) == norm_email(r["ce"]) else 2] += 1
        lead_dups = db.q("""SELECT d.lead_id dup_lead, d.created_ts dup_created, d.status dup_status, d.opportunity_id dup_opp, c.lead_id canon_lead, c.created_ts canon_created,
                            c.opportunity_id canon_opp, d.product_interest product FROM lead d JOIN lead c ON c.lead_id = d.duplicate_of_lead_id ORDER BY d.lead_id LIMIT 60""")
        return {"contacts": {r["contact_status"]: r["n"] for r in c_tier}, "tier_counts": tiers, "merged_leads": db.scalar("SELECT COUNT(*) FROM lead WHERE duplicate_of_lead_id IS NOT NULL"),
                "contact_pairs": pairs, "lead_pairs": lead_dups, "rules": [
                    {"tier": 1, "rule": "Exact match on normalised e-mail (lower-case, trimmed, '+tag' removed)"},
                    {"tier": 2, "rule": "Same company + same normalised last name + similar first name (nickname table, initial, or string ratio ≥ 0.80)"},
                    {"tier": "lead", "rule": f"Same canonical contact + same product within {C.DUP_WINDOW_DAYS} days of an earlier lead → merged into the earlier lead (Disqualified: Duplicate)"}]}
    return state.memo("dedupe", build)


def dedupe_review():
    """ANALYST view: planted duplicates the rules missed (reads ground truth - evaluation only, never used for scoring)."""
    def build():
        g = db.connect_gt()
        miss = [dict(r) for r in g.execute("SELECT entity_id, related_entity_id, detail FROM gt_anomaly WHERE issue_type='duplicate_contact' AND detail LIKE '%detected_by_rules=no%' LIMIT 30")]
        g.close()
        for m in miss:
            a = db.q1("SELECT contact_id, first_name, last_name, email FROM contact WHERE contact_id=?", (m["entity_id"],))
            b = db.q1("SELECT contact_id, first_name, last_name, email FROM contact WHERE contact_id=?", (m["related_entity_id"],))
            m["dup"], m["canonical"] = a, b
        return {"missed_examples": miss, "stats": detectors.evaluate_against_truth()["dedupe"]}
    return state.memo("dedupe_review", build)


def consent_overview():
    def build():
        by_state = db.q("SELECT consent_status s, COUNT(*) n FROM lead GROUP BY consent_status")
        monthly = db.q("SELECT substr(effective_ts,1,7) m, SUM(status='opted_out') opt_out, SUM(status='opted_in') opt_in FROM consent GROUP BY m ORDER BY m")
        suppressed = db.q("SELECT cancel_reason r, COUNT(*) n FROM task WHERE cancel_reason IS NOT NULL GROUP BY r")
        by_source = db.q("SELECT source, COUNT(*) n FROM consent WHERE status='opted_out' GROUP BY source ORDER BY n DESC")
        by_basis = db.q("SELECT legal_basis b, status, COUNT(*) n FROM consent GROUP BY b, status")
        contacts_out = db.scalar("SELECT COUNT(DISTINCT contact_id) FROM consent WHERE status='opted_out'")
        viol = [e for e in detectors.detect_all() if e["issue_type"] == "opted_out_contacted"]
        return {"lead_states": {r["s"]: r["n"] for r in by_state}, "monthly": monthly, "suppressed": suppressed, "optout_sources": by_source,
                "bases": by_basis, "contacts_opted_out": contacts_out, "violations": len(viol), "violation_examples": viol[:10],
                "policy": ["Every contact has ≥ 1 consent event (append-only ledger); the latest applicable event per channel (or 'all') governs outreach",
                           "Tasks that need a channel without valid consent are created as 'suppressed' (no outreach)",
                           "An opt-out after task creation cancels open tasks for that channel and disqualifies the lead on an all-channel opt-out",
                           "Contacts with an all-channel opt-out are ineligible for conversion",
                           "Completing a call/e-mail task re-checks consent at that moment (API returns 409 when blocked)"]}
    return state.memo("consent", build)


def routing_overview():
    def build():
        cover = db.q("""SELECT r.territory, rp.product_line product, COUNT(DISTINCT r.rep_id) reps FROM sales_rep r JOIN rep_product rp ON rp.rep_id = r.rep_id
                        WHERE r.role IN ('SDR','AE') GROUP BY r.territory, rp.product_line""")
        leads = db.q("""SELECT territory, product_interest product, COUNT(*) leads, SUM(routing_method='overflow_territory') overflow,
                        SUM(routing_method='unroutable_queue') unroutable FROM lead WHERE duplicate_of_lead_id IS NULL GROUP BY territory, product_interest""")
        methods = db.q("SELECT routing_method m, COUNT(*) n FROM lead GROUP BY routing_method")
        queue = db.q("""SELECT l.lead_id, l.created_ts, l.score, l.score_band, l.territory, co.company_name, l.product_interest, t.task_id, t.status task_status, t.due_ts
                        FROM lead l JOIN company co ON co.company_id = l.company_id LEFT JOIN task t ON t.lead_id = l.lead_id AND t.task_type='manual_routing'
                        WHERE l.assigned_rep_id = ? AND l.duplicate_of_lead_id IS NULL ORDER BY l.created_ts DESC LIMIT 40""", (C.QUEUE_REP_ID,))
        viol = [e for e in detectors.detect_all() if e["issue_type"] == "lead_outside_territory"]
        loads = db.q("""SELECT r.rep_id, r.rep_name, r.territory, r.role, COUNT(l.lead_id) leads FROM sales_rep r LEFT JOIN lead l ON l.assigned_rep_id = r.rep_id
                        WHERE r.role IN ('SDR','AE') GROUP BY r.rep_id ORDER BY r.territory, r.rep_id""")
        return {"coverage": cover, "leads": leads, "methods": {r["m"]: r["n"] for r in methods}, "queue": queue, "violations": len(viol), "violation_examples": viol[:10],
                "loads": loads, "rules": ["Territory = company region; product = lead's product interest",
                                          "Eligible reps: active SDR/AE in the territory covering the product (RepProduct bridge)",
                                          "Pick the least-loaded eligible rep (ties by rep_id) → method rule_based",
                                          "No product specialist → least-loaded territory rep → method overflow_territory",
                                          "No territory map (region 'Other') → Sales-Ops queue REP-000 + manual_routing task → method unroutable_queue",
                                          "Merged duplicates inherit the canonical lead's owner",
                                          "Manual (re)assignment outside the lead's territory is rejected by the API (422)"]}
    return state.memo("routing", build)


def score_rules_overview():
    rows = db.q("SELECT * FROM score_rule ORDER BY version DESC, rule_id")
    for r in rows:
        r["params"] = json.loads(r["params"])
    versions = db.q("""SELECT version, MIN(effective_from) effective_from, MAX(effective_to) effective_to, MAX(is_active) is_active, COUNT(*) rules,
                       (SELECT COUNT(*) FROM lead l WHERE l.score_version = score_rule.version) leads_scored FROM score_rule GROUP BY version ORDER BY version DESC""")
    return {"rules": rows, "versions": versions, "bands": {"hot": C.HOT_THRESHOLD, "warm": C.WARM_THRESHOLD}, "lookback_days": C.SCORE_LOOKBACK_DAYS,
            "dimension_caps": {"fit": 40, "intent": 35, "engagement": 25}}


def audit_log(limit=100):
    return db.q("SELECT * FROM audit_log ORDER BY audit_id DESC LIMIT ?", (limit,))

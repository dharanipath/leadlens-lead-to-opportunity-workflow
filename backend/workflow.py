"""Write-side workflow: lead intake → de-dup → consent → score → route → follow-up tasks, plus rep/ops actions.

Every state change appends an explicit history row (lead_status_history / stage_history / consent ledger / audit_log); rows are
never silently overwritten. Business rules are *enforced* here: blocked calls return HTTP 409/422 with the rule that fired and are
written to the audit log as outcome='blocked'.
"""
import json
import re
from datetime import timedelta

from core import config as C
from core.dedupe import first_name_similar, norm_email, norm_name
from core.routing import can_contact, rep_can_take, route_lead
from core.scoring import compile_rules, extract_features, score_lead
from core.util import fmt_act, fmt_co, fmt_con, fmt_lead, fmt_opp, fmt_task, iso, parse_ts

from . import analytics, db, state

PERMISSIONS = {
    "intake": {"prospect", "ops", "admin"}, "consent": {"prospect", "ops", "agent", "admin"}, "task_complete": {"agent", "ops", "admin"},
    "convert": {"agent", "ops", "admin"}, "advance": {"agent", "ops", "admin"}, "assign": {"ops", "admin"}, "rescore": {"ops", "admin"},
    "publish_rules": {"admin"}, "sql": {"analyst", "admin"}, "reset": {"admin"}, "log_activity": {"agent", "ops", "admin"},
}


class ApiError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


def require(role, action):
    if role not in PERMISSIONS.get(action, set()):
        raise ApiError(403, f"role '{role}' is not allowed to {action.replace('_', ' ')}", required=sorted(PERMISSIONS[action]))


def _next_num(conn, table, col, prefix_len_regex, width=6):
    row = conn.execute(f"SELECT MAX({col}) FROM {table}").fetchone()[0]
    return int(re.search(r"(\d+)$", row).group(1)) + 1 if row else 1


def _task_n(conn, lead_id):
    row = conn.execute("SELECT MAX(task_id) FROM task WHERE lead_id=?", (lead_id,)).fetchone()[0]
    return int(row.rsplit("-", 1)[1]) + 1 if row else 1


def _act_n(conn, lead_id):
    row = conn.execute("SELECT MAX(activity_id) FROM activity WHERE lead_id=?", (lead_id,)).fetchone()[0]
    return int(row.rsplit("-", 1)[1]) + 1 if row else 1


def _lsh_n(conn, lead_id):
    row = conn.execute("SELECT MAX(lead_status_history_id) FROM lead_status_history WHERE lead_id=?", (lead_id,)).fetchone()[0]
    return int(row.rsplit("-", 1)[1]) + 1 if row else 1


def _cons_events(conn, contact_id):
    return [(r[0], r[1], r[2]) for r in conn.execute("SELECT effective_ts, channel, status FROM consent WHERE contact_id=? ORDER BY effective_ts", (contact_id,))]


def _add_status(conn, lead_id, frm, to, ts, rep_id, reason):
    ok = to in C.LEAD_TRANSITIONS.get(frm, [])
    if not ok:
        raise ApiError(422, f"lifecycle violation: lead status {frm or '∅'} → {to} is not an allowed transition")
    n = _lsh_n(conn, lead_id)
    conn.execute("INSERT INTO lead_status_history VALUES (?,?,?,?,?,?,?)", (f"LSH-{lead_id}-{n:02d}", lead_id, frm, to, iso(ts), rep_id, reason))


def _add_activity(conn, lead, atype, ts, rep_id=None, task_id=None, detail=None):
    chan = {"web_visit": "web", "pricing_page_view": "web", "content_download": "web", "trial_signup": "web", "form_submit": "web", "demo_request": "web",
            "email_open": "email", "email_click": "email", "email_outbound": "email", "webinar_attend": "event", "support_inquiry": "support",
            "call_outbound": "phone", "meeting": "meeting", "demo_delivered": "meeting"}[atype]
    n = _act_n(conn, lead["lead_id"])
    aid = fmt_act(lead["lead_id"], n)
    conn.execute("INSERT INTO activity VALUES (?,?,?,?,?,?,?,?,?,?)", (aid, lead["lead_id"], lead["contact_id"], atype, "inbound" if atype in C.INBOUND_TYPES else "outbound",
                                                                  chan, iso(ts), rep_id, task_id, detail))
    conn.execute("UPDATE lead SET last_activity_ts = MAX(last_activity_ts, ?) WHERE lead_id=?", (iso(ts), lead["lead_id"]))
    return aid


def _active_rules(conn):
    v = db.scalar("SELECT MAX(version) FROM score_rule WHERE is_active=1", conn=conn)
    rows = db.q("SELECT * FROM score_rule WHERE version=?", (v,), conn=conn)
    return v, compile_rules(rows)


# ============================================================================================================= intake
def intake(body, role, dry_run=False):
    require(role, "intake")
    conn = db.connect()
    with db.WRITE_LOCK:
        try:
            conn.execute("BEGIN")
            res = _intake(conn, body, role)
            if dry_run:
                conn.execute("ROLLBACK")
                res["dry_run"] = True
            else:
                conn.execute("COMMIT")
                state.bump()
            return res
        except Exception:
            conn.execute("ROLLBACK")
            raise


def _intake(conn, b, role):
    now = state.now()
    trace = []
    exceptions = []

    def step(key, title, status, detail, data=None):
        trace.append({"step": len(trace) + 1, "key": key, "title": title, "status": status, "detail": detail, "data": data or {}})

    first, last = (b.get("first_name") or "").strip(), (b.get("last_name") or "").strip()
    email = (b.get("email") or "").strip()
    if not first or not last or "@" not in email or " " in email:
        raise ApiError(422, "first_name, last_name and a valid e-mail are required")
    product = b.get("product_interest") or "Analytics"
    if product not in C.PRODUCTS:
        raise ApiError(422, f"product_interest must be one of {C.PRODUCTS}")
    domain = email.split("@")[1].lower()
    free = domain in C.FREE_EMAIL_DOMAINS
    region = b.get("region") or "EMEA"
    if region not in C.ALL_REGIONS:
        raise ApiError(422, f"region must be one of {C.ALL_REGIONS}")
    step("validate", "Validate form submission", "ok", f"{first} {last} <{email}> · product {product} · region {region}",
         {"free_email": free, "corporate_domain": not free})

    # ---- 1 consent capture -----------------------------------------------------------------------------------------------------------
    consent_email = bool(b.get("consent_email", True))
    consent_phone = bool(b.get("consent_phone", False))

    # ---- 2 company / contact resolution (dedupe) -----------------------------------------------------------------------------------
    comp = None
    if not free:
        comp = db.q1("SELECT * FROM company WHERE domain=?", (domain,), conn=conn)
    if comp:
        step("company", "Resolve company", "ok", f"Matched existing {comp['company_id']} · {comp['company_name']} by domain {domain}", {"company_id": comp["company_id"], "created": False})
    else:
        name = (b.get("company_name") or "").strip() or (domain.split(".")[0].title() + " (new)")
        n = _next_num(conn, "company", "company_id", None)
        cid = fmt_co(n)
        emp = int(b.get("employee_count") or 100)
        industry = b.get("industry") or "Software"
        country = b.get("country") or C.REGION_COUNTRIES[region][0]
        rpe = C.REVENUE_PER_EMPLOYEE.get(industry, 150000)
        dom_val = domain if not free else f"{re.sub('[^a-z0-9]', '', name.lower()) or 'company'}{n}.example"
        conn.execute("INSERT INTO company VALUES (?,?,?,?,?,?,?,?,?,?)", (cid, name, dom_val, industry, emp, emp * rpe, region, country, iso(now)[:10], "prospect"))
        comp = db.q1("SELECT * FROM company WHERE company_id=?", (cid,), conn=conn)
        step("company", "Resolve company", "ok", f"No match for domain → created {cid} · {name}", {"company_id": cid, "created": True})

    cand = {"email": email, "first_name": first, "last_name": last, "company_id": comp["company_id"]}
    match, tier, reason = None, None, None
    for row in conn.execute("SELECT * FROM contact WHERE company_id=? OR lower(email)=lower(?)", (comp["company_id"], email)).fetchall():
        row = dict(row)
        if norm_email(row["email"]) == norm_email(email):
            match, tier, reason = row, 1, "normalised e-mail match"
            break
        if (row["company_id"] == comp["company_id"] and norm_name(row["last_name"]) == norm_name(last) and first_name_similar(row["first_name"], first)):
            match, tier, reason = row, 2, "same company + last name + similar first name"
    if match:
        canon = match["merged_into_contact_id"] or match["contact_id"]
        ct = db.q1("SELECT * FROM contact WHERE contact_id=?", (canon,), conn=conn)
        step("contact", "De-duplicate contact", "warn", f"Tier-{tier} match ({reason}) with {match['contact_id']} → using canonical {ct['contact_id']}; no new contact created",
             {"contact_id": ct["contact_id"], "tier": tier, "created": False})
        exceptions.append("duplicate_contact_matched")
    else:
        n = _next_num(conn, "contact", "contact_id", None)
        ct_id = fmt_con(n)
        sen = b.get("seniority") if b.get("seniority") in C.SENIORITIES else "Manager"
        conn.execute("INSERT INTO contact VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (ct_id, comp["company_id"], first, last, email, b.get("phone") or None, b.get("job_title") or "Manager",
                                                                              sen, b.get("department") or "IT", iso(now)[:10], "active", None))
        ct = db.q1("SELECT * FROM contact WHERE contact_id=?", (ct_id,), conn=conn)
        step("contact", "De-duplicate contact", "ok", f"No tier-1/2 match → created {ct_id}", {"contact_id": ct_id, "created": True})

    # consent ledger (append-only) --------------------------------------------------------------------------------------------------------
    cn = _next_num(conn, "consent", "consent_id", None)
    new_consents = []
    for ch, ok in (("email", consent_email), ("phone", consent_phone)):
        if ch == "phone" and not ok and consent_email:
            continue
        status = "opted_in" if ok else "opted_out"
        cid_ = f"CNS-{cn:06d}"
        cn += 1
        conn.execute("INSERT INTO consent VALUES (?,?,?,?,?,?,?)", (cid_, ct["contact_id"], ch, status, "consent", iso(now - timedelta(seconds=30)), "web_form"))
        new_consents.append({"consent_id": cid_, "channel": ch, "status": status})
    events = _cons_events(conn, ct["contact_id"])
    email_ok, phone_ok = can_contact(events, "email", iso(now)), can_contact(events, "phone", iso(now))
    step("consent", "Capture consent", "ok" if email_ok else "warn",
         f"Ledger events {', '.join(c['consent_id'] + ':' + c['channel'] + '=' + c['status'] for c in new_consents)} → e-mail {'allowed' if email_ok else 'BLOCKED'}, phone {'allowed' if phone_ok else 'blocked'}",
         {"email_allowed": email_ok, "phone_allowed": phone_ok, "events": new_consents})
    if not email_ok:
        exceptions.append("no_email_consent")

    # ---- 3 lead creation + dedupe ----------------------------------------------------------------------------------------------------------
    camp = db.q1("SELECT * FROM campaign WHERE campaign_id=?", (b.get("campaign_id"),), conn=conn) if b.get("campaign_id") else None
    source = camp["channel"] if camp else "Direct / Website"
    ln = _next_num(conn, "lead", "lead_id", None)
    lead_id = fmt_lead(ln)
    canon_ids = [r[0] for r in conn.execute("SELECT contact_id FROM contact WHERE contact_id=? OR merged_into_contact_id=?", (ct["contact_id"], ct["contact_id"]))]
    ph = ",".join("?" * len(canon_ids))
    dup = db.q1(f"""SELECT lead_id, created_ts, assigned_rep_id, routing_method FROM lead WHERE contact_id IN ({ph}) AND product_interest=? AND duplicate_of_lead_id IS NULL
                    AND created_ts >= ? ORDER BY created_ts DESC LIMIT 1""", canon_ids + [product, iso(now - timedelta(days=C.DUP_WINDOW_DAYS))], conn=conn)
    t_created = now

    # ---- 4 activity + scoring --------------------------------------------------------------------------------------------------------------------
    sig = b.get("signals") or {}
    lead_row = {"lead_id": lead_id, "contact_id": ct["contact_id"]}
    version, compiled = _active_rules(conn)
    # a provisional lead row is needed for the activity FK ordering
    conn.execute("INSERT INTO lead VALUES (" + ",".join("?" * 22) + ")",
                 (lead_id, ct["contact_id"], comp["company_id"], camp["campaign_id"] if camp else None, source, product, iso(t_created), "opted_in", comp["region"],
                  C.QUEUE_REP_ID, "unroutable_queue", "provisional", 0, "Cold", iso(t_created), version, "New", None, None, None, None, iso(t_created)))
    acts_created = [_add_activity(conn, lead_row, "form_submit", t_created, detail=f"{source} form - {product}")]
    sigmap = {"demo_request": ("demo_request", 1), "trial_signup": ("trial_signup", 1), "pricing_views": ("pricing_page_view", int(sig.get("pricing_views", 0))),
              "downloads": ("content_download", int(sig.get("downloads", 0))), "email_clicks": ("email_click", int(sig.get("email_clicks", 0))),
              "webinar": ("webinar_attend", 1), "web_visits": ("web_visit", int(sig.get("web_visits", 0))), "support": ("support_inquiry", 1)}
    for k, (atype, n) in sigmap.items():
        v = sig.get(k)
        if v:
            for i in range(n if not isinstance(v, bool) else 1):
                acts_created.append(_add_activity(conn, lead_row, atype, t_created - timedelta(hours=1 + i), detail="behavioural signal (portal)"))
    acts = [(r[0], r[1], r[2]) for r in conn.execute("SELECT activity_type, activity_ts, direction FROM activity WHERE lead_id=?", (lead_id,))]
    feats = extract_features(comp, ct, acts, iso(t_created))
    res = score_lead(feats, compiled, explain=True)
    score, band = res["score"], res["band"]
    step("score", "Score the lead (fit + intent + engagement)", "ok",
         f"{score}/100 → {band} · fit {res['dimensions']['fit']['points']} + intent {res['dimensions']['intent']['points']} + engagement {res['dimensions']['engagement']['points']} (rule set v{version}, cut-off = scored_ts, inbound only)",
         {"score": score, "band": band, "dimensions": res["dimensions"], "breakdown": [x for x in res["breakdown"] if x["points"] != 0], "version": version})

    # ---- 5 dedupe decision / routing -------------------------------------------------------------------------------------------------------------------
    rep_id, method, rreason = None, None, None
    status, status_reason, dup_of = "New", None, None
    if dup:
        dup_of = dup["lead_id"]
        rep_id, method = dup["assigned_rep_id"], dup["routing_method"]
        rreason = f"merged duplicate of {dup_of} → inherits owner {rep_id}"
        status, status_reason = "Disqualified", "Duplicate"
        step("dedupe", "De-duplicate lead", "warn", f"Same person + product within {C.DUP_WINDOW_DAYS} days of {dup_of} → merged into the earlier lead; no new opportunity can be created from this lead",
             {"duplicate_of": dup_of})
        exceptions.append("duplicate_lead_merged")
    else:
        step("dedupe", "De-duplicate lead", "ok", "No earlier lead for this person + product inside the duplicate window", {})
        reps = db.q("SELECT * FROM sales_rep WHERE active_to IS NULL AND role IN ('SDR','AE')", conn=conn)
        rp = {}
        for r in conn.execute("SELECT rep_id, product_line FROM rep_product"):
            rp.setdefault(r[0], set()).add(r[1])
        loads = {r[0]: r[1] for r in conn.execute("SELECT assigned_rep_id, COUNT(*) FROM lead WHERE status IN ('New','Working','Qualified') GROUP BY assigned_rep_id")}
        rep_id, method, rreason = route_lead(comp["region"], product, reps, rp, loads)
        rep = db.q1("SELECT * FROM sales_rep WHERE rep_id=?", (rep_id,), conn=conn)
        elig = [r["rep_id"] for r in reps if r["territory"] == comp["region"] and product in rp.get(r["rep_id"], ())]
        step("route", "Route by territory + product", "ok" if method == "rule_based" else "warn",
             f"{rep_id} · {rep['rep_name']} ({rep['territory']}) via {method}: {rreason}",
             {"rep_id": rep_id, "method": method, "reason": rreason, "territory": comp["region"], "eligible": elig, "loads": {k: loads.get(k, 0) for k in elig}})
        if method != "rule_based":
            exceptions.append(method)
    consent_state = "opted_in" if email_ok else "opted_out"
    if not email_ok and not dup:
        status, status_reason = "Disqualified", "Opted out"
    scored_ts = t_created
    conn.execute("""UPDATE lead SET consent_status=?, assigned_rep_id=?, routing_method=?, routing_reason=?, score=?, score_band=?, scored_ts=?, score_version=?, status=?,
                    status_reason=?, duplicate_of_lead_id=? WHERE lead_id=?""",
                 (consent_state, rep_id, method, rreason, score, band, iso(scored_ts), version, status, status_reason, dup_of, lead_id))
    conn.execute("INSERT INTO lead_status_history VALUES (?,?,?,?,?,?,?)", (f"LSH-{lead_id}-01", lead_id, None, "New", iso(t_created), None, "lead created (portal intake)"))
    if status != "New":
        _add_status(conn, lead_id, "New", status, t_created + timedelta(seconds=2), None, "merged by de-duplication" if dup else "contact has not consented to e-mail")
    step("lead", "Create lead record", "ok", f"{lead_id} · status {status}{' (' + status_reason + ')' if status_reason else ''}", {"lead_id": lead_id, "status": status})

    # ---- 6 follow-up tasks ------------------------------------------------------------------------------------------------------------------------------
    tasks = []
    q_rep = C.QUEUE_REP_ID
    if dup:
        sched = [("duplicate_review", "P3", 24, q_rep)]
    elif method == "unroutable_queue":
        sched = [("manual_routing", "P2", 8, q_rep)]
    else:
        base = {"Hot": [("first_response_call", "P1", 4), ("follow_up_email", "P1", 48), ("demo_scheduling", "P1", 120)],
                "Warm": [("follow_up_email", "P2", 24), ("nurture_check", "P2", 168)], "Cold": [("nurture_check", "P3", 72)]}[band]
        sched = [(t, p, h, rep_id) for t, p, h in base]
    tn = 0
    for ttype, prio, hrs, owner in sched:
        ch = C.TASK_CHANNEL[ttype]
        if ttype == "first_response_call" and not phone_ok and email_ok:
            ttype, ch = "follow_up_email", "email"
        tn += 1
        tid = fmt_task(lead_id, tn)
        t0 = t_created + timedelta(minutes=1)
        tstatus, reason_c = "open", None
        if ch and not can_contact(events, ch, iso(t0)):
            tstatus, reason_c = "suppressed", "no_consent_at_creation"
        elif status == "Disqualified" and ttype not in ("duplicate_review",):
            tstatus, reason_c = "suppressed", "no_consent_at_creation"
        conn.execute("INSERT INTO task VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (tid, lead_id, owner, ttype, prio, iso(t0), iso(t0 + timedelta(hours=hrs)), hrs, tstatus, None, None, None, reason_c))
        tasks.append({"task_id": tid, "type": ttype, "priority": prio, "owner": owner, "due": iso(t0 + timedelta(hours=hrs)), "status": tstatus, "sla_hours": hrs, "cancel_reason": reason_c})
    sup = sum(1 for t in tasks if t["status"] == "suppressed")
    step("tasks", "Create follow-up tasks", "warn" if sup else "ok",
         f"{len(tasks)} task(s) · priority {C.BAND_PRIORITY[band] if not dup else 'P3'} · SLA {tasks[0]['sla_hours']}h for the first touch" + (f" · {sup} suppressed by consent rule" if sup else ""), {"tasks": tasks})
    if camp:
        conn.execute("INSERT INTO lead_campaign VALUES (?,?,?,?)", (lead_id, camp["campaign_id"], "first_touch", iso(t_created - timedelta(minutes=5))))
    db.audit(conn, role, "lead_intake", "lead", lead_id, "ok", f"intake → {band} {score} → {rep_id} ({method})", None,
             {"score": score, "rep": rep_id, "status": status, "tasks": [t["task_id"] for t in tasks]}, ts=iso(now))
    step("audit", "Persist & audit", "ok", f"All state changes written as explicit rows; audit entry recorded for {lead_id}", {})
    return {"lead_id": lead_id, "contact_id": ct["contact_id"], "company_id": comp["company_id"], "score": score, "band": band, "rep_id": rep_id, "routing_method": method,
            "status": status, "status_reason": status_reason, "exceptions": exceptions, "trace": trace, "tasks": tasks}


# ============================================================================================================= task completion (consent guard)
def complete_task(task_id, body, role):
    require(role, "task_complete")
    conn = db.connect()
    with db.WRITE_LOCK:
        t = db.q1("SELECT * FROM task WHERE task_id=?", (task_id,), conn=conn)
        if not t:
            raise ApiError(404, "task not found")
        if t["status"] in ("completed", "cancelled", "suppressed"):
            raise ApiError(409, f"task is already {t['status']}")
        lead = db.q1("SELECT * FROM lead WHERE lead_id=?", (t["lead_id"],), conn=conn)
        now = state.now()
        ch = C.TASK_CHANNEL.get(t["task_type"])
        events = _cons_events(conn, lead["contact_id"])
        try:
            conn.execute("BEGIN")
            if ch and not can_contact(events, ch, iso(now)):
                conn.execute("UPDATE task SET status='cancelled', cancel_reason='opted_out_before_completion' WHERE task_id=?", (task_id,))
                db.audit(conn, role, "task_complete", "task", task_id, "blocked", f"consent rule: contact has no valid {ch} consent → outreach blocked, task cancelled",
                         {"status": t["status"]}, {"status": "cancelled"}, ts=iso(now))
                conn.execute("COMMIT")
                state.bump()
                raise ApiError(409, f"Consent rule blocked this {ch} outreach: the contact has no valid {ch} consent. The task was cancelled and the attempt audited.",
                               rule="consent_enforced", channel=ch)
            outcome = body.get("outcome") or "connected"
            if outcome not in C.TASK_OUTCOMES:
                raise ApiError(422, f"outcome must be one of {C.TASK_OUTCOMES}")
            sla_met = 1 if iso(now) <= t["due_ts"] else 0
            conn.execute("UPDATE task SET status='completed', completed_ts=?, outcome=?, sla_met=? WHERE task_id=?", (iso(now), outcome, sla_met, task_id))
            aid = None
            if ch:
                aid = _add_activity(conn, lead, "call_outbound" if ch == "phone" else "email_outbound", now, rep_id=t["assigned_rep_id"], task_id=task_id, detail=t["task_type"])
            moved = None
            if lead["status"] == "New" and ch:
                _add_status(conn, lead["lead_id"], "New", "Working", now, t["assigned_rep_id"], "first outreach")
                conn.execute("UPDATE lead SET status='Working' WHERE lead_id=?", (lead["lead_id"],))
                moved = "New → Working"
            elif lead["status"] == "Stale" and ch:
                _add_status(conn, lead["lead_id"], "Stale", "Working", now, t["assigned_rep_id"], "re-engaged")
                conn.execute("UPDATE lead SET status='Working', status_reason=NULL WHERE lead_id=?", (lead["lead_id"],))
                moved = "Stale → Working"
            db.audit(conn, role, "task_complete", "task", task_id, "ok", f"{t['task_type']} completed · SLA {'met' if sla_met else 'missed'}", {"status": t["status"]},
                     {"status": "completed", "outcome": outcome, "activity": aid}, ts=iso(now))
            conn.execute("COMMIT")
        except ApiError:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        state.bump()
        return {"task_id": task_id, "status": "completed", "sla_met": bool(sla_met), "activity_id": aid, "lead_status_change": moved, "completed_ts": iso(now)}


def log_activity(lead_id, body, role):
    """Agent logs an inbound support inquiry / outbound touch. Outbound e-mail/call re-check consent."""
    require(role, "log_activity")
    conn = db.connect()
    with db.WRITE_LOCK:
        lead = db.q1("SELECT * FROM lead WHERE lead_id=?", (lead_id,), conn=conn)
        if not lead:
            raise ApiError(404, "lead not found")
        atype = body.get("activity_type")
        if atype not in C.ACTIVITY_TYPES:
            raise ApiError(422, f"activity_type must be one of {C.ACTIVITY_TYPES}")
        now = state.now()
        try:
            conn.execute("BEGIN")
            ch = C.CONTACT_TYPES.get(atype)
            if ch and not can_contact(_cons_events(conn, lead["contact_id"]), ch, iso(now)):
                db.audit(conn, role, "log_activity", "lead", lead_id, "blocked", f"consent rule: {atype} blocked (no valid {ch} consent)", None, None, ts=iso(now))
                conn.execute("COMMIT")
                state.bump()
                raise ApiError(409, f"Consent rule blocked this {atype.replace('_', ' ')}: no valid {ch} consent for this contact.", rule="consent_enforced")
            aid = _add_activity(conn, lead, atype, now, rep_id=lead["assigned_rep_id"] if atype in C.OUTBOUND_TYPES else None, detail=body.get("detail"))
            db.audit(conn, role, "log_activity", "activity", aid, "ok", f"{atype} logged on {lead_id}", None, {"activity_id": aid}, ts=iso(now))
            conn.execute("COMMIT")
        except ApiError:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        state.bump()
        return {"activity_id": aid}


# ============================================================================================================= consent ledger
def update_consent(body, role):
    require(role, "consent")
    conn = db.connect()
    with db.WRITE_LOCK:
        cid, ch, st = body.get("contact_id"), body.get("channel", "all"), body.get("status")
        if not db.q1("SELECT 1 x FROM contact WHERE contact_id=?", (cid,), conn=conn):
            raise ApiError(404, "contact not found")
        if ch not in C.CONSENT_CHANNELS or st not in C.CONSENT_STATUSES:
            raise ApiError(422, "channel/status invalid")
        now = state.now()
        impact = {"tasks_cancelled": [], "leads_disqualified": []}
        try:
            conn.execute("BEGIN")
            n = _next_num(conn, "consent", "consent_id", None)
            kid = f"CNS-{n:06d}"
            conn.execute("INSERT INTO consent VALUES (?,?,?,?,?,?,?)", (kid, cid, ch, st, "consent", iso(now), body.get("source") or "preference_center"))
            if st == "opted_out":
                scope = {"all": ("email", "phone"), "email": ("email",), "phone": ("phone",)}[ch]
                for t in db.q("""SELECT t.* FROM task t JOIN lead l ON l.lead_id = t.lead_id WHERE l.contact_id=? AND t.status IN ('open','overdue')""", (cid,), conn=conn):
                    tch = C.TASK_CHANNEL.get(t["task_type"])
                    if tch in scope:
                        conn.execute("UPDATE task SET status='cancelled', cancel_reason='opted_out_before_completion' WHERE task_id=?", (t["task_id"],))
                        impact["tasks_cancelled"].append(t["task_id"])
                if ch in ("all", "email"):
                    for l in db.q("SELECT * FROM lead WHERE contact_id=?", (cid,), conn=conn):
                        conn.execute("UPDATE lead SET consent_status='opted_out' WHERE lead_id=?", (l["lead_id"],))
                        if ch == "all" and l["status"] in ("New", "Working", "Qualified", "Stale"):
                            _add_status(conn, l["lead_id"], l["status"], "Disqualified", now, None, "contact opted out")
                            conn.execute("UPDATE lead SET status='Disqualified', status_reason='Opted out' WHERE lead_id=?", (l["lead_id"],))
                            impact["leads_disqualified"].append(l["lead_id"])
            else:
                for l in db.q("SELECT lead_id FROM lead WHERE contact_id=?", (cid,), conn=conn):
                    ev = _cons_events(conn, cid)
                    conn.execute("UPDATE lead SET consent_status=? WHERE lead_id=?", ("opted_in" if can_contact(ev, "email", iso(now)) else "opted_out", l["lead_id"]))
            db.audit(conn, role, "consent_update", "contact", cid, "ok", f"{ch} → {st}", None, {"consent_id": kid, **{k: len(v) for k, v in impact.items()}}, ts=iso(now))
            conn.execute("COMMIT")
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        state.bump()
        return {"consent_id": kid, "effective_ts": iso(now), **impact}


# ============================================================================================================= conversion + stage transitions
def convert_lead(lead_id, body, role):
    require(role, "convert")
    conn = db.connect()
    with db.WRITE_LOCK:
        lead = db.q1("SELECT * FROM lead WHERE lead_id=?", (lead_id,), conn=conn)
        if not lead:
            raise ApiError(404, "lead not found")
        now = state.now()

        def block(msg, rule, **extra):
            db.audit(conn, role, "convert_lead", "lead", lead_id, "blocked", msg, None, None, ts=iso(now))
            conn.commit()
            state.bump()
            raise ApiError(409, msg, rule=rule, **extra)

        if lead["status"] == "Converted":
            raise ApiError(409, "lead already converted", opportunity_id=lead["opportunity_id"])
        if lead["duplicate_of_lead_id"]:
            canon = db.q1("SELECT lead_id, opportunity_id FROM lead WHERE lead_id=?", (lead["duplicate_of_lead_id"],), conn=conn)
            block(f"Duplicate lead: this lead was merged into {canon['lead_id']}"
                  + (f", which already has {canon['opportunity_id']}" if canon["opportunity_id"] else "") + ". A duplicate may not create its own opportunity.",
                  "duplicate_opportunity_prevented", canonical_lead=canon["lead_id"], canonical_opportunity=canon["opportunity_id"])
        if lead["assigned_rep_id"] == C.QUEUE_REP_ID:
            block("Lead is unrouted (Sales-Ops queue). Route it to a rep before converting.", "routing_enforced")
        events = _cons_events(conn, lead["contact_id"])
        if any(st == "opted_out" and ch == "all" for _, ch, st in events) and not can_contact(events, "email", iso(now)) and not can_contact(events, "phone", iso(now)):
            block("Consent rule: the contact has opted out of all channels and is not eligible for conversion.", "consent_enforced")
        existing = db.q1("""SELECT o.opportunity_id, o.stage, o.created_ts FROM opportunity o WHERE o.company_id=? AND o.product_line=? AND o.status='open'
                            ORDER BY o.created_ts DESC LIMIT 1""", (lead["company_id"], lead["product_interest"]), conn=conn)
        if existing:
            block(f"Duplicate-opportunity guard: {existing['opportunity_id']} (stage {existing['stage']}) is already open for this company and product.", "duplicate_opportunity_prevented",
                  existing_opportunity=existing["opportunity_id"])
        comp = db.q1("SELECT * FROM company WHERE company_id=?", (lead["company_id"],), conn=conn)
        seats = int(body.get("seats") or max(5, min(5000, int(comp["employee_count"] * 0.1))))
        disc = int(body.get("discount_pct") or 0)
        if disc not in C.DISCOUNTS:
            raise ApiError(422, f"discount_pct must be one of {C.DISCOUNTS}")
        unit = C.UNIT_PRICE_USD[lead["product_interest"]]
        amount = round(seats * unit * (100 - disc) / 100.0, 2)
        try:
            conn.execute("BEGIN")
            frm = lead["status"]
            if frm in ("New", "Stale"):
                _add_status(conn, lead_id, frm, "Working", now - timedelta(seconds=2), lead["assigned_rep_id"], "manual conversion path")
                frm = "Working"
            if frm == "Working":
                _add_status(conn, lead_id, "Working", "Qualified", now - timedelta(seconds=1), lead["assigned_rep_id"], "qualified by rep")
                frm = "Qualified"
            _add_status(conn, lead_id, frm, "Converted", now, lead["assigned_rep_id"], "opportunity created")
            n = _next_num(conn, "opportunity", "opportunity_id", None)
            oid = fmt_opp(n)
            conn.execute("INSERT INTO opportunity VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (oid, lead_id, lead["company_id"], lead["contact_id"], lead["assigned_rep_id"], lead["product_interest"],
                                                                                         seats, unit, disc, amount, "Qualified", "open", C.STAGE_PROB["Qualified"], iso(now),
                                                                                         iso(now + timedelta(days=60))[:10], None, None))
            conn.execute("INSERT INTO stage_history VALUES (?,?,?,?,?,?,?)", (f"SH-{oid}-01", oid, None, "Qualified", iso(now), lead["assigned_rep_id"], None))
            conn.execute("UPDATE lead SET status='Converted', status_reason=NULL, converted_ts=?, opportunity_id=? WHERE lead_id=?", (iso(now), oid, lead_id))
            db.audit(conn, role, "convert_lead", "lead", lead_id, "ok", f"converted → {oid} (${amount:,.2f})", {"status": lead["status"]}, {"opportunity_id": oid, "amount": amount}, ts=iso(now))
            conn.execute("COMMIT")
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        state.bump()
        return {"opportunity_id": oid, "amount_usd": amount, "seats": seats, "discount_pct": disc}


def advance_opportunity(oid, body, role):
    require(role, "advance")
    conn = db.connect()
    with db.WRITE_LOCK:
        o = db.q1("SELECT * FROM opportunity WHERE opportunity_id=?", (oid,), conn=conn)
        if not o:
            raise ApiError(404, "opportunity not found")
        to = body.get("to_stage")
        now = state.now()

        def block(msg, rule):
            db.audit(conn, role, "advance_stage", "opportunity", oid, "blocked", msg, {"stage": o["stage"]}, {"requested": to}, ts=iso(now))
            conn.commit()
            state.bump()
            raise ApiError(422, msg, rule=rule)

        if to not in C.OPP_STAGES:
            raise ApiError(422, f"to_stage must be one of {C.OPP_STAGES}")
        if o["status"] != "open":
            block(f"Lifecycle rule: {oid} is already closed ({o['stage']}); closed opportunities cannot move.", "lifecycle_enforced")
        i = C.OPEN_STAGES.index(o["stage"])
        allowed = ([C.OPEN_STAGES[i + 1]] if i < 3 else ["Closed Won"]) + ["Closed Lost"]
        if to not in allowed:
            block(f"Stage-gap rule: {o['stage']} → {to} skips a stage. Allowed next: {', '.join(allowed)}. Every transition must be recorded in StageHistory.", "stage_gap_prevented")
        reason = body.get("reason")
        if to == "Closed Won" and reason not in C.WON_REASONS:
            raise ApiError(422, f"a won reason is required: {C.WON_REASONS}")
        if to == "Closed Lost" and reason not in C.LOST_REASONS:
            raise ApiError(422, f"a lost reason is required: {C.LOST_REASONS}")
        closed = to in ("Closed Won", "Closed Lost")
        try:
            conn.execute("BEGIN")
            n = conn.execute("SELECT COUNT(*) FROM stage_history WHERE opportunity_id=?", (oid,)).fetchone()[0]
            last = conn.execute("SELECT MAX(stage_history_id) FROM stage_history WHERE opportunity_id=?", (oid,)).fetchone()[0]
            seq = int(last.rsplit("-", 1)[1]) + 1 if last else n + 1
            conn.execute("INSERT INTO stage_history VALUES (?,?,?,?,?,?,?)", (f"SH-{oid}-{seq:02d}", oid, o["stage"], to, iso(now), o["owner_rep_id"], reason if closed else None))
            conn.execute("""UPDATE opportunity SET stage=?, status=?, probability_pct=?, closed_ts=?, won_lost_reason=? WHERE opportunity_id=?""",
                         (to, "won" if to == "Closed Won" else "lost" if to == "Closed Lost" else "open", C.STAGE_PROB[to], iso(now) if closed else None, reason if closed else None, oid))
            if to == "Closed Won":
                conn.execute("UPDATE company SET account_status='customer' WHERE company_id=?", (o["company_id"],))
            db.audit(conn, role, "advance_stage", "opportunity", oid, "ok", f"{o['stage']} → {to}" + (f" ({reason})" if closed else ""), {"stage": o["stage"]}, {"stage": to}, ts=iso(now))
            conn.execute("COMMIT")
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        state.bump()
        return {"opportunity_id": oid, "stage": to, "status": "won" if to == "Closed Won" else "lost" if to == "Closed Lost" else "open"}


# ============================================================================================================= assignment + rescoring
def assign_lead(lead_id, body, role):
    require(role, "assign")
    conn = db.connect()
    with db.WRITE_LOCK:
        lead = db.q1("SELECT * FROM lead WHERE lead_id=?", (lead_id,), conn=conn)
        rep = db.q1("SELECT * FROM sales_rep WHERE rep_id=?", (body.get("rep_id"),), conn=conn)
        if not lead or not rep:
            raise ApiError(404, "lead or rep not found")
        now = state.now()
        rp = {}
        for r in conn.execute("SELECT rep_id, product_line FROM rep_product"):
            rp.setdefault(r[0], set()).add(r[1])
        from_queue = lead["territory"] == "Other" or lead["assigned_rep_id"] == C.QUEUE_REP_ID and lead["routing_method"] == "unroutable_queue"
        ok, msg = rep_can_take(rep, lead["territory"], lead["product_interest"], rp)
        if not ok and not (from_queue and body.get("reason")):
            db.audit(conn, role, "assign_lead", "lead", lead_id, "blocked", f"routing rule: {msg}", {"rep": lead["assigned_rep_id"]}, {"requested": rep["rep_id"]}, ts=iso(now))
            conn.commit()
            state.bump()
            raise ApiError(422, f"Routing rule blocked this assignment: {msg}. Leads can only be owned by reps covering their territory.", rule="routing_enforced")
        method = "manual_override" if from_queue else ("rule_based" if "match" in msg else "overflow_territory")
        reason = f"manual assignment by {role}: {body.get('reason') or msg}"
        try:
            conn.execute("BEGIN")
            conn.execute("UPDATE lead SET assigned_rep_id=?, routing_method=?, routing_reason=? WHERE lead_id=?", (rep["rep_id"], method, reason, lead_id))
            conn.execute("UPDATE task SET assigned_rep_id=? WHERE lead_id=? AND status IN ('open','overdue') AND task_type NOT IN ('duplicate_review')", (rep["rep_id"], lead_id))
            created = []
            if from_queue and lead["status"] == "New":
                mr = db.q1("SELECT * FROM task WHERE lead_id=? AND task_type='manual_routing' AND status IN ('open','overdue')", (lead_id,), conn=conn)
                if mr:
                    conn.execute("UPDATE task SET status='completed', completed_ts=?, outcome='resolved', sla_met=?, assigned_rep_id=? WHERE task_id=?",
                                 (iso(now), 1 if iso(now) <= mr["due_ts"] else 0, C.QUEUE_REP_ID, mr["task_id"]))
                band = lead["score_band"]
                for ttype, prio, hrs in {"Hot": [("first_response_call", "P1", 4)], "Warm": [("follow_up_email", "P2", 24)], "Cold": [("nurture_check", "P3", 72)]}[band]:
                    tn = _task_n(conn, lead_id)
                    tid = fmt_task(lead_id, tn)
                    t0 = now + timedelta(minutes=1)
                    conn.execute("INSERT INTO task VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (tid, lead_id, rep["rep_id"], ttype, prio, iso(t0), iso(t0 + timedelta(hours=hrs)), hrs, "open", None, None, None, None))
                    created.append(tid)
            db.audit(conn, role, "assign_lead", "lead", lead_id, "ok", f"{lead['assigned_rep_id']} → {rep['rep_id']} ({method})", {"rep": lead["assigned_rep_id"]}, {"rep": rep["rep_id"], "method": method}, ts=iso(now))
            conn.execute("COMMIT")
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        state.bump()
        return {"lead_id": lead_id, "assigned_rep_id": rep["rep_id"], "routing_method": method, "tasks_created": created}


def rescore_lead(lead_id, role):
    require(role, "rescore")
    conn = db.connect()
    with db.WRITE_LOCK:
        lead = db.q1("SELECT * FROM lead WHERE lead_id=?", (lead_id,), conn=conn)
        if not lead:
            raise ApiError(404, "lead not found")
        now = state.now()
        cutoff = iso(now)
        note = None
        if lead["converted_ts"] and cutoff > lead["converted_ts"]:
            cutoff = lead["converted_ts"]
            note = "leakage guard: cut-off clamped to converted_ts (post-conversion events are excluded from the score)"
        version, compiled = _active_rules(conn)
        comp = db.q1("SELECT * FROM company WHERE company_id=?", (lead["company_id"],), conn=conn)
        ct = db.q1("SELECT * FROM contact WHERE contact_id=?", (lead["contact_id"],), conn=conn)
        acts = [(r[0], r[1], r[2]) for r in conn.execute("SELECT activity_type, activity_ts, direction FROM activity WHERE lead_id=?", (lead_id,))]
        res = score_lead(extract_features(comp, ct, acts, cutoff), compiled, explain=False)
        try:
            conn.execute("BEGIN")
            conn.execute("UPDATE lead SET score=?, score_band=?, scored_ts=?, score_version=? WHERE lead_id=?", (res["score"], res["band"], cutoff, version, lead_id))
            db.audit(conn, role, "rescore_lead", "lead", lead_id, "ok", f"{lead['score']} → {res['score']} (rule set v{version}, cut-off {cutoff})" + (f" · {note}" if note else ""),
                     {"score": lead["score"], "scored_ts": lead["scored_ts"], "version": lead["score_version"]}, {"score": res["score"], "scored_ts": cutoff, "version": version}, ts=iso(now))
            conn.execute("COMMIT")
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        state.bump()
        return {"lead_id": lead_id, "before": lead["score"], "after": res["score"], "band": res["band"], "scored_ts": cutoff, "version": version, "note": note}


def publish_rules(body, role):
    require(role, "publish_rules")
    conn = db.connect()
    with db.WRITE_LOCK:
        patches = body.get("rules") or {}
        cur = db.scalar("SELECT MAX(version) FROM score_rule WHERE is_active=1", conn=conn)
        old = db.q("SELECT * FROM score_rule WHERE version=? ORDER BY rule_id", (cur,), conn=conn)
        now = state.now()
        nv = db.scalar("SELECT MAX(version) FROM score_rule", conn=conn) + 1
        mult = {k: float(v) for k, v in (body.get("multipliers") or {}).items()}
        try:
            conn.execute("BEGIN")
            conn.execute("UPDATE score_rule SET is_active=0, effective_to=? WHERE version=?", (iso(now)[:10], cur))
            for r in old:
                params = json.loads(r["params"])
                m = mult.get(r["rule_id"], 1.0)
                if m != 1.0:
                    if "map" in params:
                        params["map"] = {k: int(round(v * m)) for k, v in params["map"].items()}
                    if "bands" in params:
                        params["bands"] = [[a, int(round(b * m))] for a, b in params["bands"]]
                    for k in ("per", "points"):
                        if k in params:
                            params[k] = int(round(params[k] * m)) or (1 if params[k] > 0 else -1)
                mp = int(round(r["max_points"] * m)) if r["rule_type"] in ("lookup", "band", "per_count", "flag_count") else r["max_points"]
                conn.execute("INSERT INTO score_rule VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                             (r["rule_id"].replace(f"V{cur}", f"V{nv}"), nv, r["dimension"], r["feature"], r["rule_type"],
                              json.dumps(params, separators=(",", ":"), sort_keys=True), mp, r["description"], iso(now)[:10], None, 1))
            db.audit(conn, role, "publish_score_rules", "score_rule", f"v{nv}", "ok", f"published rule set v{nv} (v{cur} closed, history preserved)", {"version": cur},
                     {"version": nv, "multipliers": mult, "note": body.get("note")}, ts=iso(now))
            conn.execute("COMMIT")
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        state.bump()
        return {"version": nv, "previous": cur, "note": "Existing leads keep their stored score_version until re-scored; evaluation store is based on the seeded snapshot."}


# ============================================================================================================= read-only SQL
def run_sql(body, role):
    require(role, "sql")
    sql = (body.get("sql") or "").strip().rstrip(";")
    if not re.match(r"^(select|with)\b", sql, re.I) or ";" in sql:
        raise ApiError(422, "only a single SELECT / WITH statement is allowed")
    import sqlite3
    c = sqlite3.connect(f"file:{db.DB_PATH.as_posix()}?mode=ro", uri=True)
    c.execute("PRAGMA query_only=ON")
    try:
        cur = c.execute(f"SELECT * FROM ({sql}) LIMIT 500")
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    except sqlite3.Error as e:
        raise ApiError(422, f"SQL error: {e}")
    finally:
        c.close()
    return {"columns": cols, "rows": rows, "truncated_at": 500}

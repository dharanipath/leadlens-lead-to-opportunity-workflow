"""Rule-based exception detectors (use ONLY the operational DB) + comparison with the separate ground truth.

Detectors implement the documented rules; the ground-truth DB is opened only inside `evaluate_against_truth`.
"""
from collections import defaultdict

from core import config as C
from core.dedupe import norm_email
from core.routing import can_contact

from . import db, state

META = {
    "opted_out_contacted": ("Opted-out lead contacted", "critical", "Consent",
                            "An outbound e-mail/call was logged after the contact's latest applicable opt-out."),
    "score_post_conversion": ("Score uses post-conversion event", "high", "Scoring",
                              "scored_ts is later than converted_ts, so events after the conversion influenced the score (target leakage)."),
    "lead_outside_territory": ("Lead assigned outside territory", "high", "Routing",
                               "The owning rep's territory differs from the lead's territory (company region)."),
    "duplicate_opportunity": ("Duplicate creates duplicate opportunity", "high", "De-duplication",
                              "A lead already merged as a duplicate of another lead produced its own opportunity while the canonical lead also converted."),
    "stage_history_gap": ("Stage history has gaps", "medium", "Lifecycle",
                          "StageHistory chain is broken: a transition row is missing (from_stage != previous to_stage)."),
}


def detect_all():
    return state.memo("detect_all", _detect_all)


def _detect_all():
    conn = db.connect()
    out = []
    # 1 opted-out contacted ------------------------------------------------------------------------------------------------
    cons = defaultdict(list)
    for r in conn.execute("SELECT contact_id, effective_ts, channel, status FROM consent ORDER BY effective_ts"):
        cons[r[0]].append((r[1], r[2], r[3]))
    for r in conn.execute("""SELECT a.activity_id, a.lead_id, a.contact_id, a.activity_type, a.activity_ts, a.rep_id FROM activity a
                             WHERE a.activity_type IN ('email_outbound','call_outbound')"""):
        ch = C.CONTACT_TYPES[r[3]]
        if not can_contact(cons[r[2]], ch, r[4]):
            out.append({"issue_type": "opted_out_contacted", "entity_type": "activity", "entity_id": r[0], "lead_id": r[1],
                        "message": f"{r[3]} at {r[4]} by {r[5]} without valid {ch} consent"})
    # 2 score leakage ----------------------------------------------------------------------------------------------------------
    for r in conn.execute("SELECT lead_id, scored_ts, converted_ts, score FROM lead WHERE converted_ts IS NOT NULL AND scored_ts > converted_ts"):
        out.append({"issue_type": "score_post_conversion", "entity_type": "lead", "entity_id": r[0], "lead_id": r[0],
                    "message": f"scored {r[1]} but converted {r[2]} (score {r[3]})"})
    # 3 outside territory -----------------------------------------------------------------------------------------------------------
    for r in conn.execute("""SELECT l.lead_id, l.territory, r.rep_id, r.territory FROM lead l JOIN sales_rep r ON r.rep_id = l.assigned_rep_id
                             WHERE r.role <> 'Queue' AND r.territory <> l.territory"""):
        out.append({"issue_type": "lead_outside_territory", "entity_type": "lead", "entity_id": r[0], "lead_id": r[0],
                    "message": f"lead territory {r[1]} but owner {r[2]} covers {r[3]}"})
    # 4 duplicate opportunity --------------------------------------------------------------------------------------------------------
    for r in conn.execute("""SELECT o.opportunity_id, l.lead_id, l.duplicate_of_lead_id, c.opportunity_id FROM opportunity o
                             JOIN lead l ON l.lead_id = o.lead_id JOIN lead c ON c.lead_id = l.duplicate_of_lead_id
                             WHERE c.opportunity_id IS NOT NULL"""):
        out.append({"issue_type": "duplicate_opportunity", "entity_type": "opportunity", "entity_id": r[0], "lead_id": r[1],
                    "message": f"{r[1]} is a duplicate of {r[2]} (opportunity {r[3]}) yet created {r[0]}"})
    # 5 stage gaps ---------------------------------------------------------------------------------------------------------------------
    rows = defaultdict(list)
    for r in conn.execute("SELECT opportunity_id, from_stage, to_stage, changed_ts, stage_history_id FROM stage_history ORDER BY opportunity_id, changed_ts"):
        rows[r[0]].append(r)
    lead_of = dict(conn.execute("SELECT opportunity_id, lead_id FROM opportunity").fetchall())
    for oid, lst in rows.items():
        broken = None
        if lst[0][1] not in (None, "") or lst[0][2] != "Qualified":
            broken = "first record is not a start at 'Qualified'"
        for i in range(1, len(lst)):
            if lst[i][1] != lst[i - 1][2]:
                broken = f"{lst[i - 1][2]} -> {lst[i][1] or 'NULL'} : transition into '{lst[i][1]}' is not recorded"
                break
        if broken:
            out.append({"issue_type": "stage_history_gap", "entity_type": "opportunity", "entity_id": oid, "lead_id": lead_of.get(oid), "message": broken})
    for e in out:
        e["title"], e["severity"], e["area"], e["rule"] = (META[e["issue_type"]][0], META[e["issue_type"]][1], META[e["issue_type"]][2], META[e["issue_type"]][3])
    return out


def by_lead():
    def build():
        m = defaultdict(list)
        for e in detect_all():
            if e.get("lead_id"):
                m[e["lead_id"]].append(e)
        return m
    return state.memo("detect_by_lead", build)


def evaluate_against_truth():
    """Compare detections with the labelled ground truth (the ONLY place the GT DB is read for exceptions)."""
    def build():
        det = defaultdict(set)
        for e in detect_all():
            det[e["issue_type"]].add(e["entity_id"])
        g = db.connect_gt()
        truth = defaultdict(set)
        for r in g.execute("SELECT issue_type, entity_id FROM gt_anomaly WHERE is_injected='1'"):
            truth[r[0]].add(r[1])
        dd = {}
        for r in g.execute("SELECT issue_type, detail FROM gt_anomaly WHERE issue_type IN ('duplicate_contact','duplicate_lead')"):
            dd.setdefault(r[0], []).append(r[1])
        g.close()
        rows = []
        for t in C.ANOMALY_TYPES:
            d, tr = det[t], truth[t]
            tp = len(d & tr)
            rows.append({"issue_type": t, "title": META[t][0], "severity": META[t][1], "area": META[t][2], "rule": META[t][3],
                         "detected": len(d), "labelled": len(tr), "true_positive": tp, "false_positive": len(d - tr), "missed": len(tr - d),
                         "precision": round(tp / len(d), 4) if d else None, "recall": round(tp / len(tr), 4) if tr else None})
        dups = {}
        for k, lst in dd.items():
            hit = sum(1 for x in lst if "detected_by_rules=yes" in x)
            dups[k] = {"planted": len(lst), "detected": hit, "missed": len(lst) - hit, "recall": round(hit / len(lst), 4) if lst else None}
        return {"types": rows, "dedupe": dups}
    return state.memo("eval_truth", build)

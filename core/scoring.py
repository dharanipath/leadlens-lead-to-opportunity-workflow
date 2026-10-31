"""Transparent, rule-table-driven lead scoring (fit + intent + engagement).

The engine only reads ScoreRule rows, so the exact same code reproduces every
stored score in the generator, the validator and the backend.

Anti-leakage contract: only INBOUND activities with  cutoff-30d <= ts <= cutoff
are used. The cutoff is the lead's `scored_ts`; a score whose cutoff lies after
the lead's conversion is a *post-conversion leak* (labelled edge case).
"""
import json
from datetime import timedelta

from .config import (HOT_THRESHOLD, INBOUND_TYPES, SCORE_LOOKBACK_DAYS, WARM_THRESHOLD, FREE_EMAIL_DOMAINS)
from .util import iso, parse_ts

DIMENSIONS = ["fit", "intent", "engagement"]


def _r(rule_id, dim, feature, rtype, params, max_points, desc):
    return {"rule_id": rule_id, "version": 1, "dimension": dim, "feature": feature, "rule_type": rtype,
            "params": json.dumps(params, separators=(",", ":"), sort_keys=True), "max_points": max_points,
            "description": desc, "effective_from": "2026-01-01", "effective_to": "", "is_active": 1}


def default_rules():
    return [
        _r("SR-V1-001", "fit", "industry", "lookup", {"map": {"Software": 12, "FinTech": 12, "Healthcare": 10, "Telecom": 9, "Manufacturing": 8,
                                                                 "Logistics": 7, "Energy": 6, "Media": 5, "Retail": 5, "Education": 3}}, 12,
           "Industry match against ideal-customer-profile (ICP) tiers"),
        _r("SR-V1-002", "fit", "employee_count", "band", {"bands": [[1000, 14], [200, 10], [50, 6], [10, 3], [0, 1]]}, 14,
           "Company size band (employees) - larger accounts have bigger deal potential"),
        _r("SR-V1-003", "fit", "seniority", "lookup", {"map": {"C-level": 10, "VP": 8, "Director": 6, "Manager": 3, "IC": 1}}, 10,
           "Buyer seniority - proxy for decision authority"),
        _r("SR-V1-004", "fit", "region", "lookup", {"map": {"NA-East": 4, "NA-West": 4, "EMEA": 3, "APAC": 2, "LATAM": 1, "Other": 0}}, 4,
           "Strategic region priority"),
        _r("SR-V1-005", "fit", "free_email", "flag", {"points": -10}, 0,
           "Penalty: personal/free e-mail domain instead of a corporate domain"),
        _r("SR-V1-006", "intent", "act:demo_request", "flag_count", {"points": 15}, 15, "Explicit demo request in the last 30 days"),
        _r("SR-V1-007", "intent", "act:pricing_page_view", "per_count", {"per": 4}, 12, "Pricing-page views (4 pts each, capped at 12)"),
        _r("SR-V1-008", "intent", "act:trial_signup", "flag_count", {"points": 10}, 10, "Free-trial sign-up"),
        _r("SR-V1-009", "intent", "act:content_download", "per_count", {"per": 3}, 6, "Bottom-funnel content downloads (3 pts each, capped at 6)"),
        _r("SR-V1-010", "engagement", "act:email_click", "per_count", {"per": 2}, 8, "E-mail link clicks (2 pts each, capped at 8)"),
        _r("SR-V1-011", "engagement", "act:email_open", "per_count", {"per": 1}, 4, "E-mail opens (1 pt each, capped at 4)"),
        _r("SR-V1-012", "engagement", "act:webinar_attend", "per_count", {"per": 6}, 6, "Webinar attendance"),
        _r("SR-V1-013", "engagement", "act:web_visit", "per_count", {"per": 1}, 5, "Website visits (1 pt each, capped at 5)"),
        _r("SR-V1-014", "engagement", "act:support_inquiry", "per_count", {"per": 2}, 4, "Pre-sales support inquiries (2 pts each, capped at 4)"),
        _r("SR-V1-015", "engagement", "days_since_last_inbound", "threshold_gt", {"threshold": 14, "points": -5}, 0,
           "Inactivity penalty: no inbound touch in the 14 days before scoring"),
        _r("SR-V1-020", "fit", "dimension", "dimension_cap", {}, 40, "Dimension cap: FIT <= 40"),
        _r("SR-V1-021", "intent", "dimension", "dimension_cap", {}, 35, "Dimension cap: INTENT <= 35"),
        _r("SR-V1-022", "engagement", "dimension", "dimension_cap", {}, 25, "Dimension cap: ENGAGEMENT <= 25"),
        _r("SR-V1-030", "fit", "score_band", "band_threshold", {"hot": HOT_THRESHOLD, "warm": WARM_THRESHOLD}, 100,
           "Band cut-offs: Hot >= 70, Warm >= 40, else Cold"),
    ]


def extract_features(company, contact, activities, cutoff_iso):
    """company/contact: dict-like. activities: iterable of (activity_type, ts_iso, direction)."""
    cutoff = parse_ts(cutoff_iso)
    lo = iso(cutoff - timedelta(days=SCORE_LOOKBACK_DAYS))
    counts, last = {}, None
    for atype, ts, direction in activities:
        if direction != "inbound" or ts > cutoff_iso or ts < lo:
            continue
        counts[atype] = counts.get(atype, 0) + 1
        if last is None or ts > last:
            last = ts
    days_since = (cutoff - parse_ts(last)).days if last else 999
    domain = contact["email"].lower().strip().split("@")[-1]
    return {"industry": company["industry"], "employee_count": int(company["employee_count"]), "seniority": contact["seniority"],
            "region": company["region"], "free_email": domain in FREE_EMAIL_DOMAINS,
            "counts": counts, "days_since_last_inbound": days_since}


def _rule_points(rule, params, feats):
    """Return (observed_value, raw_points) for a single non-cap rule."""
    f, t = rule["feature"], rule["rule_type"]
    if t == "lookup":
        v = feats[f]
        return v, params["map"].get(v, 0)
    if t == "band":
        v = feats[f]
        for lo, pts in params["bands"]:
            if v >= lo:
                return v, pts
        return v, 0
    if t == "flag":
        v = bool(feats[f])
        return v, params["points"] if v else 0
    if t == "flag_count":
        v = feats["counts"].get(f.split(":", 1)[1], 0)
        return v, params["points"] if v >= 1 else 0
    if t == "per_count":
        v = feats["counts"].get(f.split(":", 1)[1], 0)
        return v, v * params["per"]
    if t == "threshold_gt":
        v = feats[f]
        return v, params["points"] if v > params["threshold"] else 0
    return None, 0


def compile_rules(rules):
    """Pre-parse JSON params once; returns (scoring_rules, caps, thresholds)."""
    scoring, caps, thr = [], {}, {"hot": HOT_THRESHOLD, "warm": WARM_THRESHOLD}
    for r in rules:
        p = json.loads(r["params"]) if isinstance(r["params"], str) else r["params"]
        if r["rule_type"] == "dimension_cap":
            caps[r["dimension"]] = float(r["max_points"])
        elif r["rule_type"] == "band_threshold":
            thr = {"hot": p["hot"], "warm": p["warm"]}
        else:
            scoring.append((r, p))
    return scoring, caps, thr


def band_for(score, thr):
    return "Hot" if score >= thr["hot"] else "Warm" if score >= thr["warm"] else "Cold"


def score_lead(feats, compiled, explain=True):
    """Deterministic score. Returns dict(score, band, dimensions, breakdown)."""
    scoring, caps, thr = compiled
    dims = {d: 0.0 for d in DIMENSIONS}
    breakdown = []
    for rule, p in scoring:
        v, raw = _rule_points(rule, p, feats)
        cap = float(rule["max_points"])
        pts = min(raw, cap) if (cap and raw > 0) else raw
        dims[rule["dimension"]] += pts
        if explain:
            breakdown.append({"rule_id": rule["rule_id"], "dimension": rule["dimension"], "feature": rule["feature"],
                              "description": rule["description"], "observed": v, "raw_points": raw, "points": pts,
                              "rule_cap": cap, "capped": bool(cap and raw > cap)})
    out_dims = {}
    for d in DIMENSIONS:
        cap = caps.get(d, 100)
        val = max(0.0, min(dims[d], cap))
        out_dims[d] = {"raw": dims[d], "points": int(round(val)), "cap": cap, "capped": dims[d] > cap}
    total = max(0, min(100, sum(x["points"] for x in out_dims.values())))
    return {"score": int(total), "band": band_for(total, thr), "dimensions": out_dims, "breakdown": breakdown}

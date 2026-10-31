"""Territory / product routing and consent helpers (single source of truth for the rules)."""
from .config import QUEUE_REP_ID


def route_lead(territory, product, reps, rep_products, loads):
    """Pick a rep. reps: list of dicts (active only). rep_products: {rep_id: set(products)}.
    loads: {rep_id: int} running assignment count (least-loaded wins, ties broken by rep_id).

    Returns (rep_id, method, reason)."""
    in_territory = [r for r in reps if r["territory"] == territory and r["role"] in ("SDR", "AE")]
    if territory not in {r["territory"] for r in reps if r["role"] != "Queue"}:
        return QUEUE_REP_ID, "unroutable_queue", f"territory '{territory}' has no coverage map -> Sales-Ops routing queue"
    eligible = [r for r in in_territory if product in rep_products.get(r["rep_id"], ())]
    if eligible:
        best = min(eligible, key=lambda r: (loads.get(r["rep_id"], 0), r["rep_id"]))
        return (best["rep_id"], "rule_based",
                f"territory={territory}; product={product}; least-loaded of {len(eligible)} eligible reps")
    if in_territory:
        best = min(in_territory, key=lambda r: (loads.get(r["rep_id"], 0), r["rep_id"]))
        return (best["rep_id"], "overflow_territory",
                f"territory={territory}; no rep covers {product} -> overflow to least-loaded territory rep")
    return QUEUE_REP_ID, "unroutable_queue", f"no active rep in territory '{territory}' -> Sales-Ops routing queue"


def rep_can_take(rep, territory, product, rep_products):
    """Routing enforcement check used for manual (re)assignment. Returns (ok, message)."""
    if rep["role"] == "Queue":
        return True, "queue assignment"
    if rep["territory"] != territory:
        return False, f"{rep['rep_id']} covers {rep['territory']}, lead territory is {territory}"
    if product not in rep_products.get(rep["rep_id"], ()):
        return True, f"allowed as overflow: {rep['rep_id']} has no {product} specialty"
    return True, "territory and product match"


def can_contact(events, channel, ts_iso):
    """events: iterable of (effective_ts, channel, status). Returns True when `channel` may be contacted at ts.
    Latest applicable event (channel-specific or 'all') wins; no record => not allowed."""
    best = None
    for eff, ch, st in events:
        if eff <= ts_iso and ch in (channel, "all") and (best is None or eff >= best[0]):
            best = (eff, st)
    return bool(best and best[1] == "opted_in")


def lead_consent_state(events, ts_iso):
    """Summarise e-mail consent: opted_in | implied | opted_out. events: (effective_ts, channel, status, legal_basis)."""
    best = None
    for eff, ch, st, basis in events:
        if eff <= ts_iso and ch in ("email", "all") and (best is None or eff >= best[0]):
            best = (eff, st, basis)
    if not best or best[1] == "opted_out":
        return "opted_out"
    return "implied" if best[2] == "legitimate_interest" else "opted_in"

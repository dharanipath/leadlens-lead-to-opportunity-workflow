"""Model evaluation on HELD-OUT outcomes.

* Features  : the operational DB only (company/contact attributes + inbound activity <= scored_ts) via core.scoring.
* Labels    : separate ground-truth DB (gt_outcome) - read here only to build y; never joined into features.
* Split     : deterministic hash split fixed at generation time (70 % train / 30 % test). Headline metrics use TEST only.
* Population: matured, eligible leads (age >= 45 days, not a merged duplicate, not consent-blocked, routable).
"""
import json
from collections import defaultdict

from core import config as C
from core.scoring import DIMENSIONS, _rule_points, compile_rules, default_rules, extract_features

from . import db, detectors, state


def active_rules(conn=None):
    conn = conn or db.connect()
    v = db.scalar("SELECT MAX(version) FROM score_rule WHERE is_active=1", conn=conn)
    rows = db.q("SELECT * FROM score_rule WHERE version=? ORDER BY rule_id", (v,), conn=conn)
    return v, rows


class Store:
    """Feature store for the seeded population (built once, static)."""

    def __init__(self):
        conn = db.connect()
        self.version, rules = active_rules(conn)
        self.rules = rules
        self.compiled = compile_rules(rules)
        self.scoring_rules = [(r, p) for r, p in self.compiled[0]]
        acts = defaultdict(list)
        for r in conn.execute("SELECT lead_id, activity_type, activity_ts, direction FROM activity WHERE direction='inbound'"):
            acts[r[0]].append((r[1], r[2], r[3]))
        comp = {r["company_id"]: dict(r) for r in conn.execute("SELECT * FROM company")}
        con = {r["contact_id"]: dict(r) for r in conn.execute("SELECT * FROM contact")}
        g = db.connect_gt()
        self.outcome = {r["lead_id"]: dict(r) for r in g.execute("SELECT * FROM gt_outcome")}
        g.close()
        self.leads = []
        self.index = {}
        self.matrix = []
        for r in conn.execute("SELECT lead_id, company_id, contact_id, scored_ts, score, score_band, converted_ts, created_ts FROM lead ORDER BY lead_id"):
            L = dict(r)
            if L["lead_id"] not in self.outcome:      # leads created live after the seed snapshot have no labels
                continue
            feats = extract_features(comp[L["company_id"]], con[L["contact_id"]], acts[L["lead_id"]], L["scored_ts"])
            row = []
            for rule, p in self.scoring_rules:
                _, raw = _rule_points(rule, p, feats)
                cap = float(rule["max_points"])
                row.append(min(raw, cap) if (cap and raw > 0) else raw)
            self.index[L["lead_id"]] = len(self.leads)
            self.leads.append(L)
            self.matrix.append(row)
        self.rule_dim = [DIMENSIONS.index(r["dimension"]) for r, _ in self.scoring_rules]
        self.pop = [i for i, L in enumerate(self.leads) if self.outcome[L["lead_id"]]["matured"] == "1"]
        self.y = {i: int(self.outcome[self.leads[i]["lead_id"]]["converted"]) for i in self.pop}
        self.won = {i: int(self.outcome[self.leads[i]["lead_id"]]["won"]) for i in self.pop}
        self.train = [i for i in self.pop if self.outcome[self.leads[i]["lead_id"]]["split"] == "train"]
        self.test = [i for i in self.pop if self.outcome[self.leads[i]["lead_id"]]["split"] == "test"]

    def rescore(self, mult=None, caps=None, thr=None, idx=None):
        caps = caps or self.compiled[1]
        thr = thr or self.compiled[2]
        mult = mult or {}
        ms = [mult.get(r["rule_id"], 1.0) for r, _ in self.scoring_rules]
        out = {}
        for i in (idx if idx is not None else range(len(self.leads))):
            dims = [0.0, 0.0, 0.0]
            row = self.matrix[i]
            for k, d in enumerate(self.rule_dim):
                v = row[k]
                if v:
                    dims[d] += v * ms[k]
            tot = 0
            for d, name in enumerate(DIMENSIONS):
                tot += int(round(max(0.0, min(dims[d], caps.get(name, 100)))))
            out[i] = max(0, min(100, tot))
        return out


def store():
    return state.memo("eval_store", Store, static=True)


# ---- metrics -------------------------------------------------------------------------------------------------------------------------
def auc(scores, ys):
    pairs = sorted(zip(scores, ys))
    n_pos = sum(ys)
    n_neg = len(ys) - n_pos
    if not n_pos or not n_neg:
        return None
    rank_sum, i = 0.0, 0
    while i < len(pairs):
        j = i
        while j < len(pairs) and pairs[j][0] == pairs[i][0]:
            j += 1
        avg = (i + j + 1) / 2.0
        rank_sum += avg * sum(y for _, y in pairs[i:j])
        i = j
    return (rank_sum - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


def roc_points(scores, ys, n=40):
    pairs = sorted(zip(scores, ys), reverse=True)
    P, N = sum(ys), len(ys) - sum(ys)
    tp = fp = 0
    pts = [(0.0, 0.0)]
    step = max(1, len(pairs) // n)
    for k, (s, y) in enumerate(pairs, 1):
        tp += y
        fp += 1 - y
        if k % step == 0 or k == len(pairs):
            pts.append((round(fp / N, 4), round(tp / P, 4)))
    ks = max(abs(b - a) for a, b in pts)
    return pts, ks


def avg_precision(scores, ys):
    pairs = sorted(zip(scores, ys), key=lambda t: -t[0])
    tp, ap, P = 0, 0.0, sum(ys)
    for k, (_, y) in enumerate(pairs, 1):
        if y:
            tp += 1
            ap += tp / k
    return ap / P if P else None


def lift_table(scores, ys, groups=10):
    pairs = sorted(zip(scores, ys), key=lambda t: -t[0])
    base = sum(ys) / len(ys)
    n, out = len(pairs), []
    cum = 0
    for g in range(groups):
        chunk = pairs[g * n // groups:(g + 1) * n // groups]
        c = sum(y for _, y in chunk)
        cum += c
        rate = c / len(chunk) if chunk else 0
        out.append({"decile": g + 1, "n": len(chunk), "converted": c, "rate": round(rate, 4), "lift": round(rate / base, 3) if base else None,
                    "cum_capture": round(cum / sum(ys), 4) if sum(ys) else None, "min_score": chunk[-1][0] if chunk else None, "max_score": chunk[0][0] if chunk else None})
    return out


def band_table(st, scores, idx):
    rows = []
    for b in C.SCORE_BANDS:
        sel = [i for i in idx if band_of(scores[i], st) == b]
        n = len(sel)
        conv = sum(st.y[i] for i in sel)
        won = sum(st.won[i] for i in sel)
        rows.append({"band": b, "n": n, "converted": conv, "rate": round(conv / n, 4) if n else None, "won": won,
                     "win_rate": round(won / conv, 4) if conv else None, "share": round(n / len(idx), 4) if idx else None})
    return rows


def band_of(score, st, thr=None):
    thr = thr or st.compiled[2]
    return "Hot" if score >= thr["hot"] else "Warm" if score >= thr["warm"] else "Cold"


def calibration(scores, ys):
    bins = defaultdict(lambda: [0, 0])
    for s, y in zip(scores, ys):
        b = min(9, s // 10)
        bins[b][0] += 1
        bins[b][1] += y
    return [{"bin": f"{b * 10}-{b * 10 + 9 if b < 9 else 100}", "n": bins[b][0], "rate": round(bins[b][1] / bins[b][0], 4) if bins[b][0] else None}
            for b in range(10) if bins[b][0]]


def evaluate(mult=None, caps=None, thr=None):
    st = store()
    scores = st.rescore(mult, caps, thr, idx=st.pop)
    thr_used = thr or st.compiled[2]
    res = {}
    for name, idx in (("train", st.train), ("test", st.test)):
        sc = [scores[i] for i in idx]
        ys = [st.y[i] for i in idx]
        roc, ks = roc_points(sc, ys)
        hot = [(scores[i] >= thr_used["hot"], st.y[i]) for i in idx]
        tp = sum(1 for h, y in hot if h and y)
        fp = sum(1 for h, y in hot if h and not y)
        fn = sum(1 for h, y in hot if not h and y)
        tn = len(hot) - tp - fp - fn
        order = sorted(range(len(sc)), key=lambda k: -sc[k])
        pk = {}
        for frac in (0.05, 0.10, 0.20):
            k = max(1, int(len(order) * frac))
            pk[f"top_{int(frac * 100)}pct"] = round(sum(ys[j] for j in order[:k]) / k, 4)
        res[name] = {"n": len(idx), "positives": sum(ys), "base_rate": round(sum(ys) / len(ys), 4), "auc": round(auc(sc, ys), 4),
                     "avg_precision": round(avg_precision(sc, ys), 4), "ks": round(ks, 4), "roc": roc, "precision_at_k": pk,
                     "lift": lift_table(sc, ys), "calibration": calibration(sc, ys), "bands": band_table(st, scores, idx),
                     "confusion_hot": {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": round(tp / (tp + fp), 4) if tp + fp else None,
                                       "recall": round(tp / (tp + fn), 4) if tp + fn else None}}
    return res, scores


def full_report():
    return state.memo("eval_report", _full_report, static=True)


def _full_report():
    st = store()
    res, scores = evaluate()
    # leakage audit ----------------------------------------------------------------------------------------------------------
    leaked = {e["entity_id"] for e in detectors.detect_all() if e["issue_type"] == "score_post_conversion"}
    leak_idx = {st.index[l] for l in leaked if l in st.index}
    pop_test = [i for i in st.test]
    clean_test = [i for i in pop_test if i not in leak_idx]
    a_all = auc([scores[i] for i in pop_test], [st.y[i] for i in pop_test])
    a_clean = auc([scores[i] for i in clean_test], [st.y[i] for i in clean_test])
    pop_all = st.pop
    a_all_pop = auc([scores[i] for i in pop_all], [st.y[i] for i in pop_all])
    a_clean_pop = auc([scores[i] for i in pop_all if i not in leak_idx], [st.y[i] for i in pop_all if i not in leak_idx])
    in_pop = [i for i in leak_idx if i in st.y]
    # rule diagnostics (train only) --------------------------------------------------------------------------------------------------
    diag = []
    for k, (rule, p) in enumerate(st.scoring_rules):
        on = [i for i in st.train if st.matrix[i][k] != 0]
        off = [i for i in st.train if st.matrix[i][k] == 0]
        r_on = sum(st.y[i] for i in on) / len(on) if on else None
        r_off = sum(st.y[i] for i in off) / len(off) if off else None
        diag.append({"rule_id": rule["rule_id"], "dimension": rule["dimension"], "feature": rule["feature"], "description": rule["description"],
                     "max_points": rule["max_points"], "coverage": round(len(on) / len(st.train), 4), "rate_when_active": round(r_on, 4) if r_on is not None else None,
                     "rate_when_inactive": round(r_off, 4) if r_off is not None else None,
                     "lift": round(r_on / r_off, 3) if r_on and r_off else None})
    # high-score non-converters (matured) ----------------------------------------------------------------------------------------------
    g = db.connect_gt()
    drivers = [dict(r) for r in g.execute("SELECT loss_driver AS driver, COUNT(*) AS n FROM gt_outcome WHERE loss_driver <> '' GROUP BY loss_driver ORDER BY n DESC")]
    g.close()
    hot_pop = [i for i in st.pop if scores[i] >= st.compiled[2]["hot"]]
    return {"rule_version": st.version, "population": {"matured_eligible": len(st.pop), "train": len(st.train), "test": len(st.test),
                                                     "excluded_note": "excludes merged duplicates, consent-blocked (all-channel opt-out), unroutable leads and leads younger than 45 days"},
            "split": {"method": "sha256(seed|split|lead_id) % 100 < 30 -> test", "test_pct": C.HOLDOUT_TEST_PCT},
            "metrics": res,
            "leakage": {"leaked_leads": len(leaked), "leaked_in_population": len(in_pop),
                        "auc_test_all": round(a_all, 4), "auc_test_excluding_leaked": round(a_clean, 4),
                        "auc_population_all": round(a_all_pop, 4), "auc_population_excluding_leaked": round(a_clean_pop, 4),
                        "feature_audit": [
                            "features = company/contact attributes + INBOUND activity in [scored_ts-30d, scored_ts] (core/scoring.py)",
                            "labels (converted / won / split) are read from the separate ground_truth.db; they are never joined into features",
                            "scored_ts must be <= converted_ts - violations are the labelled score_post_conversion edge case",
                            f"{len(leaked)} leads break the cut-off rule; AUC is {'inflated' if a_all > a_clean else 'unchanged'} when they are included"]},
            "rule_diagnostics": diag, "high_score_non_converters": {"n_hot_matured": len(hot_pop), "drivers": drivers}}


def simulate(payload):
    """What-if: payload = {multipliers:{rule_id:x}, caps:{fit,intent,engagement}, thresholds:{hot,warm}}."""
    st = store()
    mult = {k: float(v) for k, v in (payload.get("multipliers") or {}).items()}
    caps = dict(st.compiled[1])
    caps.update({k: float(v) for k, v in (payload.get("caps") or {}).items()})
    thr = dict(st.compiled[2])
    thr.update({k: int(v) for k, v in (payload.get("thresholds") or {}).items()})
    base, bscores = evaluate()
    res, scores = evaluate(mult, caps, thr)
    moved = defaultdict(int)
    for i in st.pop:
        a, b = band_of(bscores[i], st), band_of(scores[i], st, thr)
        if a != b:
            moved[f"{a}->{b}"] += 1
    return {"baseline": {k: {m: base[k][m] for m in ("auc", "avg_precision", "ks", "bands", "precision_at_k")} for k in ("train", "test")},
            "scenario": {k: {m: res[k][m] for m in ("auc", "avg_precision", "ks", "bands", "precision_at_k", "lift", "roc")} for k in ("train", "test")},
            "band_moves": dict(moved)}


def tune():
    return state.memo("eval_tune", _tune, static=True)


def _tune():
    """Coordinate ascent of per-rule multipliers on TRAIN AUC only; test AUC reported honestly as held-out."""
    st = store()
    grid = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
    mult = {r["rule_id"]: 1.0 for r, _ in st.scoring_rules}
    ys = [st.y[i] for i in st.train]

    def train_auc(m):
        sc = st.rescore(m, idx=st.train)
        return auc([sc[i] for i in st.train], ys)

    best = train_auc(mult)
    start_train = best
    for _ in range(2):
        for r, _p in st.scoring_rules:
            rid = r["rule_id"]
            keep = mult[rid]
            for g in grid:
                if g == keep:
                    continue
                mult[rid] = g
                a = train_auc(mult)
                if a > best + 1e-5:
                    best, keep = a, g
            mult[rid] = keep
    base, _ = evaluate()
    tuned, _ = evaluate(mult)
    return {"multipliers": {k: v for k, v in mult.items()}, "grid": grid,
            "train_auc": {"before": round(start_train, 4), "after": round(best, 4)},
            "test_auc": {"before": base["test"]["auc"], "after": tuned["test"]["auc"]},
            "note": "Weights were tuned on the TRAIN split only. The reported TEST (held-out) AUC is the honest estimate of the gain; "
                    "the shipped ScoreRule v1 weights were fixed a-priori and are not changed by this analysis."}

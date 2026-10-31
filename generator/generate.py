"""Deterministic synthetic CRM / lead-to-opportunity data generator.

    python generator/generate.py --out data/full                 # 20k leads / 10k contacts / 5k companies / 3k opps
    python generator/generate.py --scale starter --out data/starter

Same generator, same seed => byte-identical files (see generator/reproduce.py).

Pipeline (documented in README):
  1 master data (company, rep, campaign, contact)   2 leads + consent       3 de-duplication (core.dedupe)
  4 scoring + routing + tasks (pass 1)               5 outcome selection from the documented propensity rule
  6 activity / status / opportunity / stage history (pass 2)
  7 labelled edge-case injection                     8 derived values + deterministic IDs
  9 ground truth, evaluation labels, export
"""
import argparse
import bisect
import csv
import hashlib
import json
import math
import random
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core import config as C  # noqa: E402
from core.dedupe import cluster_contacts, norm_email  # noqa: E402
from core.routing import can_contact, lead_consent_state, route_lead  # noqa: E402
from core.scoring import compile_rules, default_rules, extract_features, score_lead  # noqa: E402
from core.util import (fmt_act, fmt_co, fmt_con, fmt_lead, fmt_opp, fmt_task, hash_uniform, holdout_split, iso, iso_date, parse_ts,  # noqa: E402
                       sigmoid)
from generator import schema as S  # noqa: E402

SCALES = {"full": dict(leads=20000, contacts=10000, companies=5000, opps=3000),
          "starter": dict(leads=2000, contacts=1000, companies=500, opps=300)}

FIRST = ["Robert", "William", "Richard", "James", "Michael", "Elizabeth", "Katherine", "Jennifer", "Christopher", "Alexander", "Daniel",
         "Matthew", "Thomas", "Margaret", "Patricia", "Joseph", "Andrew", "Stephanie", "Nicholas", "Priya", "Wei", "Aisha", "Carlos",
         "Sofia", "Liam", "Noah", "Emma", "Olivia", "Ava", "Mateo", "Yuki", "Chen", "Fatima", "Omar", "Ingrid", "Lars", "Mei", "Raj",
         "Anika", "Diego", "Lucia", "Hannah", "Felix", "Zoe", "Ethan", "Maya", "Arjun", "Nora", "Leo", "Isla", "Hugo", "Amara", "Kenji",
         "Sara", "Tariq", "Elena", "Marco", "Ines", "Jonas", "Leila"]
LAST = ["Anderson", "Brooks", "Chen", "Dubois", "Evans", "Fischer", "Garcia", "Hughes", "Ivanov", "Jensen", "Khan", "Lopez", "Meyer",
        "Nakamura", "Okafor", "Patel", "Quinn", "Rossi", "Silva", "Tanaka", "Underwood", "Vargas", "Walker", "Xu", "Yilmaz", "Zhang",
        "Abbott", "Barnes", "Castro", "Dawson", "Ellis", "Foster", "Grant", "Hayes", "Ibrahim", "Jordan", "Kim", "Lambert", "Morales",
        "Nguyen", "Owens", "Price", "Reyes", "Singh", "Turner", "Vaughn", "Wong", "Young", "Zimmer", "Bauer", "Costa", "Delgado",
        "Eriksson", "Fontaine", "Gupta", "Hoffman", "Iqbal", "Johansson", "Kowalski", "Larsen"]
CO_A = ["Apex", "Blue", "Cedar", "Delta", "Ember", "Falcon", "Granite", "Harbor", "Iron", "Juniper", "Keystone", "Lumen", "Meridian",
        "Nimbus", "Orbit", "Pioneer", "Quartz", "Redwood", "Summit", "Titan", "Union", "Vertex", "Willow", "Xenon", "Yonder", "Zenith",
        "Atlas", "Beacon", "Cobalt", "Dune", "Echo", "Forge", "Glacier", "Horizon", "Indigo", "Jade", "Kite", "Lattice", "Mosaic",
        "Northwind", "Onyx", "Prism", "Quill", "Ridge", "Sable", "Tundra", "Umber", "Vector", "Wren", "Argent", "Brightly", "Clarion",
        "Driftwood", "Evergreen", "Fathom", "Gable", "Halcyon", "Ironclad", "Jetstream", "Kindred"]
CO_B = ["Systems", "Labs", "Dynamics", "Group", "Holdings", "Works", "Partners", "Networks", "Logistics", "Analytics", "Industries",
        "Solutions", "Technologies", "Ventures", "Digital", "Health", "Energy", "Media", "Robotics", "Capital", "Software", "Cloud",
        "Materials", "Foods", "Mobility", "Institute", "Studios", "Telecom", "Retail", "Learning"]
HOUR_W = [1, 1, 1, 1, 1, 2, 3, 5, 8, 10, 10, 9, 8, 9, 10, 10, 9, 7, 5, 4, 3, 2, 2, 1]
ACT_CHANNEL = {"web_visit": "web", "pricing_page_view": "web", "content_download": "web", "trial_signup": "web", "form_submit": "web",
               "demo_request": "web", "email_open": "email", "email_click": "email", "email_outbound": "email", "webinar_attend": "event",
               "support_inquiry": "support", "call_outbound": "phone", "meeting": "meeting", "demo_delivered": "meeting"}
PAGES = {"web_visit": ["/home", "/product", "/blog/automation-trends", "/customers", "/docs"], "pricing_page_view": ["/pricing", "/pricing/enterprise"],
         "content_download": ["Buyer's guide", "ROI calculator", "Case study", "Security whitepaper", "Benchmark report"]}


class RNG(random.Random):
    def poisson(self, lam):
        L, k, p = math.exp(-lam), 0, 1.0
        while True:
            p *= self.random()
            if p <= L:
                return k
            k += 1

    def wchoice(self, items, weights):
        tot = sum(weights)
        r = self.random() * tot
        acc = 0.0
        for it, w in zip(items, weights):
            acc += w
            if r <= acc:
                return it
        return items[-1]


def rand_ts(rng, start, end):
    """Random timestamp in [start, end], business-hours biased, weekends thinned."""
    span = max(1, (end - start).days + 1)
    for _ in range(6):
        d = start + timedelta(days=rng.randrange(span))
        if d.weekday() < 5 or rng.random() > 0.7:
            break
    h = rng.wchoice(list(range(24)), HOUR_W)
    ts = datetime(d.year, d.month, d.day, h, rng.randrange(60), rng.randrange(60))
    return min(max(ts, start), end)


def slug(s):
    return "".join(ch for ch in s.lower() if ch.isalnum())


# ---------------------------------------------------------------------------------------------------------------------
def build(P, log=print):
    seed = P["seed"]
    rng = RNG(seed)
    AS_OF = C.AS_OF
    T0 = datetime(2026, 1, 1)
    n_leads, n_contacts, n_comp, n_opps = P["leads"], P["contacts"], P["companies"], P["opps"]
    n_dupc = round(n_contacts * P["dup_contact_rate"])
    n_dupl = round(n_leads * P["dup_lead_rate"])
    n_unique = n_contacts - n_dupc
    rules = default_rules()
    compiled = compile_rules(rules)

    # ---- 1. companies --------------------------------------------------------------------------------------------
    log("1/9 master data ...")
    names = [f"{a} {b}" for a in CO_A for b in CO_B]
    rng.shuffle(names)
    companies = []
    used_domains = set()
    for i in range(n_comp):
        nm = names[i] if i < len(names) else f"{names[i % len(names)]} {i // len(names) + 1}"
        region = "Other" if rng.random() < P["other_region_rate"] else rng.wchoice(C.REGIONS, C.REGION_WEIGHTS)
        industry = rng.wchoice(C.INDUSTRIES, C.INDUSTRY_WEIGHTS)
        emp = int(min(60000, max(5, rng.lognormvariate(math.log(150), 1.3))))
        dom = slug(nm) + ".example"
        k = 2
        while dom in used_domains:
            dom, k = f"{slug(nm)}{k}.example", k + 1
        used_domains.add(dom)
        companies.append({"company_name": nm, "domain": dom, "industry": industry, "employee_count": emp,
                          "annual_revenue_usd": int(emp * C.REVENUE_PER_EMPLOYEE[industry] * rng.uniform(0.6, 1.4)), "region": region,
                          "country": rng.choice(C.REGION_COUNTRIES[region]), "_idx": i})
    comp_w, acc = [], 0.0
    for c in companies:
        acc += c["employee_count"] ** 0.35
        comp_w.append(acc)

    # ---- reps / campaigns -----------------------------------------------------------------------------------------
    per_territory = {"NA-East": 8, "NA-West": 7, "EMEA": 10, "APAC": 6, "LATAM": 3}
    scale_f = max(0.3, n_leads / 20000.0)
    reps, rep_products, diligence = [], {}, {}
    reps.append({"rep_id": C.QUEUE_REP_ID, "rep_name": "Sales-Ops Routing Queue", "email": "routing.queue@spire-sales.example", "role": "Queue",
                 "territory": "Global", "team": "Sales Operations", "hire_date": "2018-01-01", "active_from": "2018-01-01", "active_to": "",
                 "max_open_leads": 9999})
    pairs = [("Analytics", "Security"), ("Automation", "Collaboration"), ("Analytics", "Automation"), ("Security", "Collaboration"),
             ("Analytics", "Collaboration"), ("Security", "Automation")]
    latam_pairs = [("Analytics", "Security"), ("Automation", "Analytics"), ("Security", "Automation")]   # nobody covers Collaboration -> overflow path
    rn = 1
    used_rep_names = set()
    for terr in C.REGIONS:
        cnt = max(4, round(per_territory[terr] * scale_f)) if terr != "LATAM" else max(3, round(3 * scale_f))
        for j in range(cnt):
            role = "Manager" if j == 0 else ("SDR" if j % 2 else "AE")
            while True:
                nm = f"{rng.choice(FIRST)} {rng.choice(LAST)}"
                if nm not in used_rep_names:
                    used_rep_names.add(nm)
                    break
            rid = f"REP-{rn:03d}"
            hd = datetime(2018, 1, 1) + timedelta(days=rng.randrange(0, 2600))
            reps.append({"rep_id": rid, "rep_name": nm, "email": f"{slug(nm)}{rn}@spire-sales.example", "role": role, "territory": terr,
                         "team": f"{terr} {'Inside Sales' if role != 'AE' else 'Field Sales'}", "hire_date": iso_date(hd),
                         "active_from": iso_date(hd), "active_to": "", "max_open_leads": rng.randrange(150, 260)})
            if role != "Manager":
                src = latam_pairs if terr == "LATAM" else pairs
                rep_products[rid] = set(src[(j - 1) % len(src)])
            diligence[rid] = rng.uniform(0.62, 0.98)
            rn += 1
    diligence[C.QUEUE_REP_ID] = 0.9
    routable_reps = [r for r in reps if r["role"] in ("SDR", "AE")]

    n_camp = max(10, round(n_leads / 500))
    campaigns = []
    for i in range(n_camp):
        ch = C.CAMPAIGN_CHANNELS[i % len(C.CAMPAIGN_CHANNELS)]
        prod = rng.wchoice(C.PRODUCTS, C.PRODUCT_WEIGHTS)
        tr = "Global" if rng.random() < 0.35 else rng.choice(C.REGIONS)
        st = T0 + timedelta(days=rng.randrange(0, 285))
        en = st + timedelta(days=rng.randrange(14, 76))
        campaigns.append({"campaign_id": f"CMP-{i + 1:04d}", "campaign_name": f"{prod} {ch} {['Spring', 'Summer', 'Fall', 'Q1', 'Q2', 'Q3', 'Q4', 'Launch'][i % 8]} {i + 1}",
                          "channel": ch, "product_line": prod, "target_region": tr, "start_date": iso_date(st), "end_date": iso_date(en),
                          "budget_usd": int(rng.lognormvariate(math.log(210000), 0.7) // 1000 * 1000),
                          "status": "completed" if en < AS_OF else "planned" if st > AS_OF else "active", "_st": st, "_en": en})
    camp_by_region = {}
    for reg in C.ALL_REGIONS:
        cl = [c for c in campaigns if c["target_region"] in (reg, "Global")] or campaigns
        cum, a = [], 0.0
        for c in cl:
            a += c["budget_usd"]
            cum.append(a)
        camp_by_region[reg] = (cl, cum)

    def pick_campaign(region):
        cl, cum = camp_by_region[region]
        return cl[min(bisect.bisect_left(cum, rng.random() * cum[-1]), len(cl) - 1)]

    # ---- persons ---------------------------------------------------------------------------------------------------
    persons = []
    for i in range(n_unique):
        ci = i if i < n_comp else min(bisect.bisect_left(comp_w, rng.random() * comp_w[-1]), n_comp - 1)
        sen = rng.wchoice(C.SENIORITIES, C.SENIORITY_WEIGHTS)
        persons.append({"company_idx": ci, "first": rng.choice(FIRST), "last": rng.choice(LAST), "seniority": sen,
                        "dept": rng.choice(C.DEPARTMENTS), "title": rng.choice(C.TITLES[sen]), "free": rng.random() < P["free_email_rate"],
                        "kind": "canonical", "of": None})

    # ---- 2. lead plans ---------------------------------------------------------------------------------------------
    log("2/9 leads, consent ...")
    plans = []
    by_person = defaultdict(list)

    def new_plan(pidx, ts, camp, product, kind, canon=None):
        p = {"pidx": pidx, "ts": ts, "camp": camp, "product": product, "kind": kind, "canon": canon,
             "src": camp["channel"] if camp else "Direct / Website"}
        plans.append(p)
        by_person[pidx].append(p)
        return p

    def sample_lead(pidx, force_diff_from=None):
        reg = companies[persons[pidx]["company_idx"]]["region"]
        for attempt in range(8):
            if rng.random() < P["direct_rate"]:
                camp, ts = None, rand_ts(rng, T0, AS_OF)
                prod = rng.wchoice(C.PRODUCTS, C.PRODUCT_WEIGHTS)
            else:
                camp = pick_campaign(reg)
                ts = rand_ts(rng, camp["_st"], min(camp["_en"], AS_OF).replace(hour=23, minute=59, second=59))
                prod = camp["product_line"] if rng.random() < 0.75 else rng.wchoice(C.PRODUCTS, C.PRODUCT_WEIGHTS)
            ok = all(abs((ts - q["ts"]).days) >= 40 or q["product"] != prod for q in by_person[pidx])
            if ok:
                return ts, camp, prod
        return ts, camp, prod if all(q["product"] != prod for q in by_person[pidx]) else rng.choice([x for x in C.PRODUCTS if all(x != q["product"] for q in by_person[pidx])] or C.PRODUCTS)

    n_canon = n_leads - n_dupl
    order = list(range(n_unique))
    for pidx in order:
        ts, camp, prod = sample_lead(pidx)
        new_plan(pidx, ts, camp, prod, "canonical")
    for _ in range(n_canon - n_unique):
        pidx = rng.randrange(n_unique)
        ts, camp, prod = sample_lead(pidx)
        new_plan(pidx, ts, camp, prod, "canonical")
    pool = [p for p in plans if p["kind"] == "canonical" and p["ts"] <= AS_OF - timedelta(days=27)]
    rng.shuffle(pool)
    dupc_pool = [p for p in pool if sum(1 for q in by_person[p["pidx"]] if q["kind"] == "canonical") >= 1]
    seen_p, dupc_sources = set(), []
    for p in dupc_pool:
        if p["pidx"] not in seen_p and len(dupc_sources) < n_dupc:
            seen_p.add(p["pidx"])
            dupc_sources.append(p)
    n_dupc = len(dupc_sources)                       # may shrink on tiny scales
    kinds = ["email_variant"] * 55 + ["name_variant"] * 33 + ["hard"] * 12
    for cp in dupc_sources:
        src_p = persons[cp["pidx"]]
        kind = rng.choice(kinds)
        persons.append({"company_idx": src_p["company_idx"], "first": src_p["first"], "last": src_p["last"], "seniority": src_p["seniority"],
                        "dept": src_p["dept"], "title": src_p["title"], "free": src_p["free"], "kind": "dup_contact", "of": cp["pidx"],
                        "variant": kind})
        pidx = len(persons) - 1
        ts = cp["ts"] + timedelta(hours=rng.uniform(1, 25 * 24))
        camp = cp["camp"] if rng.random() < 0.6 else (pick_campaign(companies[src_p["company_idx"]]["region"]) if rng.random() < 0.7 else None)
        new_plan(pidx, min(ts, AS_OF - timedelta(days=1)), camp, cp["product"], "dup_contact_lead", canon=cp)
    n_resub = n_leads - len(plans)
    resub_pool = [p for p in pool if p not in dupc_sources]
    for p in resub_pool[:n_resub]:
        ts = p["ts"] + timedelta(hours=rng.uniform(1, 28 * 24))
        camp = p["camp"] if rng.random() < 0.5 else None
        new_plan(p["pidx"], min(ts, AS_OF - timedelta(days=1)), camp, p["product"], "resubmit", canon=p)
    while len(plans) < n_leads:                      # tiny-scale safety net
        pidx = rng.randrange(n_unique)
        ts, camp, prod = sample_lead(pidx)
        new_plan(pidx, ts, camp, prod, "canonical")

    # contact / company dates
    for pidx, p in enumerate(persons):
        first = min(q["ts"] for q in by_person[pidx])
        p["created"] = (first - timedelta(days=rng.uniform(0, 400) if p["kind"] == "canonical" else rng.uniform(0, 2))).replace(hour=0, minute=0, second=0)
    comp_first = {}
    for p in persons:
        comp_first[p["company_idx"]] = min(comp_first.get(p["company_idx"], p["created"]), p["created"])
    for c in companies:
        base = comp_first.get(c["_idx"], T0)
        c["created_date"] = iso_date(base - timedelta(days=rng.uniform(0, 900)))
    companies.sort(key=lambda c: (c["created_date"], c["_idx"]))
    comp_id = {}
    for n, c in enumerate(companies, 1):
        c["company_id"] = fmt_co(n)
        comp_id[c["_idx"]] = c["company_id"]
    comp_by_id = {c["company_id"]: c for c in companies}

    # contacts (canonical persons first so variant e-mails can reference them)
    used_emails = set()
    free_n = [0]

    def make_email(first, last, domain, free):
        loc = f"{slug(first)}.{slug(last)}"
        if free:
            free_n[0] += 1
            return f"{loc}{rng.randrange(10, 9999)}@{rng.choice(C.FREE_EMAIL_DOMAINS)}"
        e, k = f"{loc}@{domain}", 2
        while e in used_emails:
            e, k = f"{loc}{k}@{domain}", k + 1
        return e

    comp_idx_map = {c["_idx"]: c for c in companies}
    for pidx, p in enumerate(persons):
        if p["kind"] != "canonical":
            continue
        co = comp_idx_map[p["company_idx"]]
        p["email"] = make_email(p["first"], p["last"], co["domain"], p["free"])
        used_emails.add(p["email"])
    for pidx, p in enumerate(persons):
        if p["kind"] != "dup_contact":
            continue
        src = persons[p["of"]]
        co = comp_idx_map[p["company_idx"]]
        dom = src["email"].split("@")[1]
        v = p["variant"]
        for attempt in range(20):
            if v == "email_variant":
                loc = src["email"].split("@")[0]
                cand = rng.choice([f"{loc.capitalize()}@{dom}", f"{loc}+{rng.choice(['promo', 'web', 'demo', 'news'])}@{dom}",
                                   f"{loc.upper()}@{dom}"])
                p["first"], p["last"] = src["first"], src["last"]
            elif v == "name_variant":
                f = src["first"]
                nick = C.NICKNAMES.get(f.lower())
                if nick:
                    p["first"] = nick.capitalize()
                elif len(f) > 4 and rng.random() < 0.6:
                    p["first"] = f[:-1]
                else:
                    p["first"] = f[0] + "."
                loc = rng.choice([f"{slug(p['first'])[:1]}.{slug(p['last'])}", f"{slug(p['first'])[:1]}{slug(p['last'])}", f"{slug(p['first'])}.{slug(p['last'])}"])
                cand = f"{loc}@{dom}"
            else:
                other = rng.choice(LAST)
                p["last"] = f"{src['last']}-{other}"
                cand = f"{slug(src['first'])}.{slug(src['last'])}-{slug(other)}@{dom}"
            if cand not in used_emails and cand.lower() != src["email"].lower():
                break
            v = "email_variant" if attempt > 3 and v != "email_variant" else v
            if attempt > 8:
                cand = f"{slug(src['first'])}.{slug(src['last'])}{attempt}+x@{dom}"
        p["email"] = cand
        used_emails.add(cand)

    persons_sorted = sorted(range(len(persons)), key=lambda i: (persons[i]["created"], i))
    contacts, con_id_of = [], {}
    for n, pidx in enumerate(persons_sorted, 1):
        p = persons[pidx]
        co = comp_idx_map[p["company_idx"]]
        cc = C.PHONE_CC[co["country"]]
        cid = fmt_con(n)
        con_id_of[pidx] = cid
        contacts.append({"contact_id": cid, "company_id": co["company_id"], "first_name": p["first"], "last_name": p["last"], "email": p["email"],
                         "phone": f"+{cc}-{rng.randrange(200, 999)}-555-{rng.randrange(1000, 9999)}", "job_title": p["title"],
                         "seniority": p["seniority"], "department": p["dept"], "created_date": iso_date(p["created"]),
                         "contact_status": "active", "merged_into_contact_id": "", "_pidx": pidx, "_kind": p["kind"], "_variant": p.get("variant", "")})
    con_by_id = {c["contact_id"]: c for c in contacts}

    # ---- leads (IDs by created_ts) -------------------------------------------------------------------------------
    plans.sort(key=lambda p: (p["ts"], p["pidx"], p["kind"]))
    leads = []
    for n, p in enumerate(plans, 1):
        cid = con_id_of[p["pidx"]]
        leads.append({"lead_id": fmt_lead(n), "contact_id": cid, "company_id": con_by_id[cid]["company_id"],
                      "campaign_id": p["camp"]["campaign_id"] if p["camp"] else "", "source": p["src"], "product_interest": p["product"],
                      "created_ts": p["ts"], "_plan": p, "_kind": p["kind"]})
    lead_by_id = {l["lead_id"]: l for l in leads}
    plan_to_lead = {id(l["_plan"]): l for l in leads}
    for l in leads:
        if l["_plan"]["canon"] is not None:
            l["_planted_dup_of"] = plan_to_lead[id(l["_plan"]["canon"])]["lead_id"]

    # ---- consent ledger ----------------------------------------------------------------------------------------------
    consents = []
    first_lead_ts = {}
    for l in leads:
        first_lead_ts[l["contact_id"]] = min(first_lead_ts.get(l["contact_id"], l["created_ts"]), l["created_ts"])
    for c in contacts:
        t_first = first_lead_ts[c["contact_id"]]
        eff0 = min(datetime.fromisoformat(c["created_date"]) + timedelta(hours=8, minutes=rng.randrange(300)), t_first - timedelta(minutes=5))
        if rng.random() < P["initial_optout_rate"]:
            consents.append({"contact_id": c["contact_id"], "channel": "email" if rng.random() < 0.7 else "all", "status": "opted_out",
                             "legal_basis": "consent", "effective_ts": eff0, "source": "web_form"})
        else:
            basis = rng.wchoice(["consent", "legitimate_interest", "contract"], [75, 20, 5])
            consents.append({"contact_id": c["contact_id"], "channel": "email" if rng.random() < 0.15 else "all", "status": "opted_in",
                             "legal_basis": basis, "effective_ts": eff0, "source": rng.choice(["web_form", "web_form", "list_import", "sales_call"])})
            if rng.random() < P["later_optout_rate"]:
                t = t_first + timedelta(days=rng.expovariate(1 / 40.0), hours=rng.uniform(0, 12))
                if t < AS_OF - timedelta(days=1):
                    scope = rng.wchoice(["all", "email", "phone"], [55, 30, 15])
                    consents.append({"contact_id": c["contact_id"], "channel": scope, "status": "opted_out", "legal_basis": "consent", "effective_ts": t,
                                     "source": rng.wchoice(["email_unsubscribe", "preference_center", "support_request"], [60, 30, 10])})
                    if rng.random() < 0.12:
                        t2 = t + timedelta(days=rng.uniform(10, 90))
                        if t2 < AS_OF:
                            consents.append({"contact_id": c["contact_id"], "channel": scope, "status": "opted_in", "legal_basis": "consent",
                                             "effective_ts": t2, "source": "preference_center"})
    consents.sort(key=lambda r: (r["effective_ts"], r["contact_id"], r["channel"]))
    for n, r in enumerate(consents, 1):
        r["consent_id"] = f"CNS-{n:06d}"
    cons_events = defaultdict(list)
    for r in consents:
        cons_events[r["contact_id"]].append((iso(r["effective_ts"]), r["channel"], r["status"], r["legal_basis"]))

    def ev3(cid):
        return [(e, ch, st) for e, ch, st, _ in cons_events[cid]]

    # ---- 3. de-duplication -------------------------------------------------------------------------------------------
    log("3/9 de-duplication ...")
    merges = cluster_contacts(sorted(contacts, key=lambda c: (c["created_date"], c["contact_id"])))
    for cid, (canon, tier, reason) in merges.items():
        con_by_id[cid]["contact_status"] = "merged"
        con_by_id[cid]["merged_into_contact_id"] = canon
    canon_of = lambda cid: merges[cid][0] if cid in merges else cid  # noqa: E731
    recent = defaultdict(list)                                         # (canonical contact, product) -> [(created, lead)]
    for l in leads:
        key = (canon_of(l["contact_id"]), l["product_interest"])
        l["duplicate_of_lead_id"] = ""
        for ts, other in reversed(recent[key]):
            if (l["created_ts"] - ts).days < C.DUP_WINDOW_DAYS:
                l["duplicate_of_lead_id"] = other["lead_id"]
                break
        if not l["duplicate_of_lead_id"]:
            recent[key].append((l["created_ts"], l))

    # ---- 4. pass 1: activity history, score, routing, tasks, propensity ------------------------------------------------
    log("4/9 scoring, routing, tasks ...")
    loads = defaultdict(int)
    acts_of = defaultdict(list)
    tasks_of = defaultdict(list)
    task_n = defaultdict(int)
    rep_by_id = {r["rep_id"]: r for r in reps}

    def add_act(lead, atype, ts, rep_id="", task_id="", detail=""):
        a = {"lead_id": lead["lead_id"], "contact_id": lead["contact_id"], "activity_type": atype,
             "direction": "inbound" if atype in C.INBOUND_TYPES else "outbound", "channel": ACT_CHANNEL[atype], "activity_ts": ts,
             "rep_id": rep_id, "task_id": task_id, "detail": detail}
        acts_of[lead["lead_id"]].append(a)
        return a

    def pick_type(w):
        return rng.wchoice(list(w.keys()), list(w.values()))

    for l in leads:
        co, ct = comp_by_id[l["company_id"]], con_by_id[l["contact_id"]]
        created = l["created_ts"]
        l["territory"] = co["region"]
        mean = C.SOURCE_INTEREST[l["source"]]
        k = 4.0
        interest = rng.betavariate(mean * k, (1 - mean) * k)
        budget = rng.gauss(0, 1)
        l["_interest"], l["_budget"] = interest, budget
        # inbound history (pre-lead, identity resolved) ---------------------------------------------------------------
        n_pre = rng.poisson(1.5 + 19.0 * interest ** 1.15)
        wts = {"web_visit": 30, "email_open": 20, "email_click": 11, "content_download": 9, "pricing_page_view": 3 + 40 * interest ** 1.5,
               "webinar_attend": (2 + 8 * interest) * (3 if l["source"] == "Webinar" else 1), "support_inquiry": 1.5 + 4 * interest,
               "trial_signup": 0.4 + 14 * interest ** 2.5, "demo_request": 0.2 + 16 * interest ** 2.5}
        once, floor = set(), datetime.fromisoformat(ct["created_date"])
        for _ in range(n_pre):
            t = pick_type(wts)
            if t in ("trial_signup", "demo_request"):
                if t in once:
                    continue
                once.add(t)
                off = rng.uniform(0, 2.5)
            else:
                off = min(29.5, rng.expovariate(1 / 6.0))
            ts = max(created - timedelta(days=off, hours=rng.uniform(0, 8)), floor)
            detail = rng.choice(PAGES[t]) if t in PAGES else (f"{l['product_interest']} webinar" if t == "webinar_attend" else "")
            add_act(l, t, ts, detail=detail)
        add_act(l, "form_submit", created, detail=f"{l['source']} form - {l['product_interest']}")
        l["scored_ts"] = created + timedelta(minutes=C.SCORE_DELAY_MINUTES)
        feats = extract_features(co, ct, [(a["activity_type"], iso(a["activity_ts"]), a["direction"]) for a in acts_of[l["lead_id"]]], iso(l["scored_ts"]))
        res = score_lead(feats, compiled, explain=False)
        l["score"], l["score_band"], l["score_version"] = res["score"], res["band"], 1
        l["_fit_t"] = res["dimensions"]["fit"]["points"] / 40.0
        # routing -------------------------------------------------------------------------------------------------------
        if l["duplicate_of_lead_id"]:
            canon = lead_by_id[l["duplicate_of_lead_id"]]
            l["assigned_rep_id"], l["routing_method"] = canon["assigned_rep_id"], canon["routing_method"]
            l["routing_reason"] = f"merged duplicate of {canon['lead_id']} -> inherits owner {canon['assigned_rep_id']}"
        else:
            rid, method, reason = route_lead(l["territory"], l["product_interest"], routable_reps, rep_products, loads)
            l["assigned_rep_id"], l["routing_method"], l["routing_reason"] = rid, method, reason
            loads[rid] += 1
        rep = rep_by_id[l["assigned_rep_id"]]
        # tasks ---------------------------------------------------------------------------------------------------------
        l["_sla1"] = False
        l["_tasks_done"] = 0
        t_created = created + timedelta(minutes=1)
        if l["duplicate_of_lead_id"]:
            sched = [("duplicate_review", "P3", 24)]
            rep = rep_by_id[C.QUEUE_REP_ID]
        elif l["assigned_rep_id"] == C.QUEUE_REP_ID:
            sched = [("manual_routing", "P2", 8)]
        else:
            b = l["score_band"]
            sched = {"Hot": [("first_response_call", "P1", 4), ("follow_up_email", "P1", 48), ("demo_scheduling", "P1", 120)],
                     "Warm": [("follow_up_email", "P2", 24), ("nurture_check", "P2", 168)],
                     "Cold": [("nurture_check", "P3", 72)]}[b]
        d = diligence[rep["rep_id"]]
        events = ev3(l["contact_id"])
        for ti, (ttype, prio, hrs) in enumerate(sched):
            ch = C.TASK_CHANNEL[ttype]
            if ttype == "first_response_call" and not can_contact(events, "phone", iso(t_created)) and can_contact(events, "email", iso(t_created)):
                ttype, ch = "follow_up_email", "email"        # channel fallback when phone consent is missing
            task_n[l["lead_id"]] += 1
            tid = fmt_task(l["lead_id"], task_n[l["lead_id"]])
            tk = {"task_id": tid, "lead_id": l["lead_id"], "assigned_rep_id": rep["rep_id"], "task_type": ttype, "priority": prio,
                  "created_ts": t_created, "due_ts": t_created + timedelta(hours=hrs), "sla_hours": hrs, "status": "open", "completed_ts": None,
                  "outcome": "", "sla_met": "", "cancel_reason": ""}
            tasks_of[l["lead_id"]].append(tk)
            if ch and not can_contact(events, ch, iso(t_created)):
                tk["status"], tk["cancel_reason"] = "suppressed", "no_consent_at_creation"
                continue
            eff_d = d * (0.75 if (ti > 0 and not l["_tasks_done"]) else 1.0)
            u = rng.random()
            if u < eff_d:
                if rng.random() < 0.75 * d + 0.12:
                    delay = hrs * rng.uniform(0.04, 0.97)
                else:
                    delay = hrs * (1 + min(8.0, rng.expovariate(1 / 1.2)))
                done = t_created + timedelta(hours=max(delay, 0.1))
            else:
                done = None
            opt_ts = None
            if ch:
                for e, ech, st, _ in cons_events[l["contact_id"]]:
                    if st == "opted_out" and ech in (ch, "all") and e > iso(t_created):
                        opt_ts = e
                        break
            if done is not None and opt_ts and iso(done) >= opt_ts:
                done = None
                tk["status"], tk["cancel_reason"] = "cancelled", "opted_out_before_completion"
                continue
            if done is not None and done > AS_OF:
                done = None
            if done is not None:
                tk["status"], tk["completed_ts"] = "completed", done
                tk["sla_met"] = 1 if done <= tk["due_ts"] else 0
                l["_tasks_done"] += 1
                if ti == 0:
                    l["_sla1"] = bool(tk["sla_met"])
                score_g = l["_interest"]
                if ttype in ("duplicate_review", "manual_routing"):
                    tk["outcome"] = "resolved"
                elif ttype == "first_response_call":
                    tk["outcome"] = rng.wchoice(["connected", "no_answer", "meeting_booked"], [30 + 40 * score_g, 45 - 30 * score_g, 5 + 25 * score_g])
                elif ttype == "demo_scheduling":
                    tk["outcome"] = rng.wchoice(["meeting_booked", "replied", "no_answer"], [20 + 40 * score_g, 30, 30])
                else:
                    tk["outcome"] = rng.wchoice(["replied", "no_answer", "not_interested"], [20 + 40 * score_g, 55 - 30 * score_g, 10])
                if ch:
                    add_act(l, "call_outbound" if ch == "phone" else "email_outbound", done, rep_id=rep["rep_id"], task_id=tid, detail=ttype)
            elif tk["status"] == "open" and tk["due_ts"] < AS_OF:
                tk["status"] = "overdue"
            if opt_ts and tk["status"] in ("open", "overdue"):
                tk["status"], tk["cancel_reason"] = "cancelled", "opted_out_before_completion"
        # propensity (documented rule) ----------------------------------------------------------------------------------
        age = (AS_OF - created).days
        l["_age"] = age
        allopt = any(st == "opted_out" and ch == "all" for _, ch, st, _ in cons_events[l["contact_id"]])
        l["_allopt"] = allopt
        z = P["z0"] + 4.2 * interest + 1.7 * l["_fit_t"] + 0.8 * (1 if l["_sla1"] else 0) + 0.5 * budget
        l["_p"] = sigmoid(z) * min(1.0, 0.4 + 0.6 * age / 90.0)
        l["_u"] = hash_uniform(seed, "conv|" + l["lead_id"])
        l["_elig"] = (age >= 14 and not l["duplicate_of_lead_id"] and not allopt and l["assigned_rep_id"] != C.QUEUE_REP_ID)

    # ---- 5. outcome selection ---------------------------------------------------------------------------------------------
    log("5/9 outcome selection ...")
    ranked = sorted([l for l in leads if l["_elig"]], key=lambda l: (-(l["_p"] - l["_u"]), l["lead_id"]))
    planned_dupopp = min(round(n_opps * P["dup_opp_rate"]), n_opps)

    def dup_candidates(selected_ids):
        out = []
        for l in leads:
            if (l["duplicate_of_lead_id"] and l["duplicate_of_lead_id"] in selected_ids and not l["_allopt"] and l["_age"] >= 14
                    and l["assigned_rep_id"] != C.QUEUE_REP_ID):
                out.append(l)
        return out

    n_base = min(len(ranked), n_opps - planned_dupopp)
    sel = {l["lead_id"] for l in ranked[:n_base]}
    cands = dup_candidates(sel)
    n_dupopp = min(planned_dupopp, len(cands))
    if n_dupopp < planned_dupopp:
        n_base = min(len(ranked), n_opps - n_dupopp)
        sel = {l["lead_id"] for l in ranked[:n_base]}
        cands = dup_candidates(sel)
    dup_opp_leads = rng.sample(cands, n_dupopp) if n_dupopp else []
    converted = set(sel) | {l["lead_id"] for l in dup_opp_leads}
    dup_opp_ids = {l["lead_id"] for l in dup_opp_leads}

    # ---- 6. pass 2 ---------------------------------------------------------------------------------------------------------
    log("6/9 activities, status history, opportunities ...")
    opps, stage_hist, lead_hist = [], [], []
    opp_of_lead = {}
    for l in leads:
        lid, created = l["lead_id"], l["created_ts"]
        co = comp_by_id[l["company_id"]]
        rep_id = l["assigned_rep_id"]
        outs = sorted(a["activity_ts"] for a in acts_of[lid] if a["direction"] == "outbound")
        first_out = outs[0] if outs else None
        l["_converted"] = lid in converted
        conv_ts = None
        # nurture / progress inbound activity after lead creation
        interest = l["_interest"]
        horizon_days = None
        if l["_converted"]:
            if lid in dup_opp_ids:
                delay = rng.uniform(2, 15)
            else:
                delay = min(120.0, max(1.2, rng.lognormvariate(math.log(9), 0.8)))
            conv_ts = created + timedelta(days=delay)
            cap = AS_OF - timedelta(hours=2)
            if conv_ts > cap:
                conv_ts = created + (cap - created) * rng.uniform(0.35, 0.95)
            conv_ts = max(conv_ts, created + timedelta(days=1))
            horizon_days = (conv_ts - created).total_seconds() / 86400.0
            lam = 1.5 + 6.0 * interest
        else:
            u_live = hash_uniform(seed, "live|" + lid)
            if l["_age"] > 76 and u_live < 0.3:
                horizon_days, lam = rng.uniform(1, 14), 0.5 + 2.0 * interest
            else:
                horizon_days = max(rng.uniform(15, 90), l["_age"] - 50.0)
                lam = 0.8 + 3.5 * interest
        end = min(AS_OF - timedelta(minutes=1), created + timedelta(days=horizon_days))
        if not l["duplicate_of_lead_id"] and l["assigned_rep_id"] != C.QUEUE_REP_ID:
            n_post = rng.poisson(lam)
            pw = {"web_visit": 30, "email_open": 20, "email_click": 12, "content_download": 6, "pricing_page_view": 6 + 18 * interest,
                  "webinar_attend": 2 + 3 * interest, "support_inquiry": 1.5 + 2 * interest, "demo_request": 0.5 + 3 * interest ** 2}
            if l["_converted"]:
                pw["pricing_page_view"] += 8
                pw["demo_request"] += 4
            ev_list = ev3(l["contact_id"])
            for _ in range(n_post):
                t = pick_type(pw)
                span = (end - created).total_seconds()
                if span <= 3600:
                    break
                ts = created + timedelta(seconds=rng.uniform(1800, span))
                if t in ("email_open", "email_click") and not can_contact(ev_list, "email", iso(ts)):
                    continue
                add_act(l, t, ts, detail=rng.choice(PAGES[t]) if t in PAGES else "")
            if not l["_converted"] and horizon_days > 20:       # live leads keep a recent touch (so they are not mis-labelled stale)
                add_act(l, "web_visit", max(created + timedelta(hours=1), end - timedelta(days=rng.uniform(0, 5))), detail="/product")
        # disposition ------------------------------------------------------------------------------------------------------
        milestones = [(None, "New", created, None, "lead created")]
        status, reason, final_ts = "New", "", None
        if l["_converted"]:
            qual_ts = max(created + timedelta(hours=1), conv_ts - timedelta(hours=rng.uniform(2, 48)))
            work_ts = min(first_out or created + timedelta(hours=1), qual_ts - timedelta(minutes=30))
            work_ts = max(work_ts, created + timedelta(minutes=5))
            milestones += [("New", "Working", work_ts, rep_id, "first outreach"), ("Working", "Qualified", qual_ts, rep_id, "qualified by rep")]
            for _ in range(rng.randrange(1, 3)):
                mts = min(qual_ts + timedelta(hours=rng.uniform(1, 40)), conv_ts - timedelta(minutes=1))
                add_act(l, rng.choice(["meeting", "demo_delivered"]), mts, rep_id=rep_id, detail="discovery / demo")
            milestones.append(("Qualified", "Converted", conv_ts, rep_id, "opportunity created"))
            status, final_ts = "Converted", conv_ts
        elif l["duplicate_of_lead_id"]:
            canon = lead_by_id[l["duplicate_of_lead_id"]]
            ts = created + timedelta(hours=rng.uniform(1, 24))
            milestones.append(("New", "Disqualified", ts, None, "merged by de-duplication"))
            status, reason, final_ts = "Disqualified", "Duplicate", ts
        elif l["_allopt"]:
            ts = created + timedelta(minutes=2)
            for e, ch, st, _ in cons_events[l["contact_id"]]:
                if st == "opted_out" and ch == "all":
                    ts = max(ts, parse_ts(e) + timedelta(minutes=1))
                    break
            ts = min(ts, AS_OF - timedelta(seconds=1))
            if first_out and first_out < ts:
                milestones.append(("New", "Working", max(first_out, created + timedelta(minutes=5)), rep_id, "first outreach"))
            milestones.append((milestones[-1][1], "Disqualified", ts, None, "contact opted out"))
            status, reason, final_ts = "Disqualified", "Opted out", ts
        elif l["assigned_rep_id"] == C.QUEUE_REP_ID:
            status = "New"
        else:
            disq = False
            if l["_age"] >= 30:
                pd = 0.10 + 0.40 * (1 - l["_fit_t"]) + (0.15 if not l["_sla1"] and l["_tasks_done"] == 0 else 0)
                if hash_uniform(seed, "disq|" + lid) < pd * (0.5 if l["score_band"] == "Hot" else 1.0):
                    disq = True
            if disq:
                if l["_fit_t"] < 0.4:
                    reason = "Not a fit"
                elif l["_tasks_done"] == 0:
                    reason = "Unresponsive"
                elif l["_budget"] < -0.6:
                    reason = "No budget"
                else:
                    reason = "Competitor"
                ts = created + timedelta(days=rng.uniform(7, 50))
                ts = min(ts, AS_OF - timedelta(hours=1))
                if first_out and first_out < ts - timedelta(minutes=10):
                    milestones.append(("New", "Working", max(first_out, created + timedelta(minutes=5)), rep_id, "first outreach"))
                milestones.append((milestones[-1][1], "Disqualified", ts, None, f"disqualified: {reason}"))
                status, final_ts = "Disqualified", ts
            else:
                if first_out:
                    milestones.append(("New", "Working", max(first_out, created + timedelta(minutes=5)), rep_id, "first outreach"))
                    status = "Working"
                    if l["score"] >= 45 and l["_tasks_done"] >= 1 and hash_uniform(seed, "qual|" + lid) < 0.45:
                        qts = first_out + timedelta(days=rng.uniform(1, 6))
                        if qts < AS_OF:
                            milestones.append(("Working", "Qualified", qts, rep_id, "qualified by rep"))
                            status = "Qualified"
        l["_milestones"], l["_status"], l["_reason"], l["_conv_ts"] = milestones, status, reason, conv_ts

        # opportunity ---------------------------------------------------------------------------------------------------
        if l["_converted"]:
            opps.append(_make_opp(rng, P, l, co, conv_ts, seed, AS_OF, rep_by_id))
    log(f"   opportunities: {len(opps)}")

    # ---- last-activity based stale rule (derived) ------------------------------------------------------------------------
    for l in leads:
        lid = l["lead_id"]
        last = max(a["activity_ts"] for a in acts_of[lid])
        l["_last_act"] = last
        if l["_status"] in ("New", "Working", "Qualified") and l["assigned_rep_id"] != C.QUEUE_REP_ID and (AS_OF - last).days > C.STALE_DAYS:
            st_ts = last + timedelta(days=C.STALE_DAYS, hours=1)
            l["_milestones"].append((l["_milestones"][-1][1], "Stale", st_ts, None, "no activity > 60 days"))
            l["_status"], l["_reason"] = "Stale", "No activity > 60 days"

    # ---- 7. injection of labelled edge cases ---------------------------------------------------------------------------------
    log("7/9 injecting labelled edge cases ...")
    gt_pending = []
    touched = set()
    opp_by_lead = {o["lead_id"]: o for o in opps}

    # (a) opted-out lead contacted ------------------------------------------------------------------------------------------
    n_a = max(3, round(n_leads * P["inject_optout_contacted"]))
    cand = []
    for l in leads:
        if l["_status"] == "Converted" or l["duplicate_of_lead_id"] or l["assigned_rep_id"] == C.QUEUE_REP_ID:
            continue
        evs = cons_events[l["contact_id"]]
        alls = [(e, st) for e, ch, st, _ in evs if ch == "all"]
        if alls and alls[-1][1] == "opted_out":
            t_opt = parse_ts(alls[-1][0])
            t = max(t_opt, l["created_ts"]) + timedelta(hours=rng.uniform(2, 240))
            if t < AS_OF - timedelta(hours=1):
                cand.append((l, t))
    rng.shuffle(cand)
    for l, t in cand[:n_a]:
        atype = rng.choice(["email_outbound", "email_outbound", "call_outbound"])
        a = add_act(l, atype, t, rep_id=l["assigned_rep_id"], detail="manual outreach (after opt-out)")
        l["_last_act"] = max(l["_last_act"], t)
        touched.add(l["lead_id"])
        gt_pending.append(("opted_out_contacted", "activity", a, l["lead_id"], "high",
                           "block outreach: contact had opted out before this touch", f"{atype} sent after opt-out"))

    # (b) score uses post-conversion event -----------------------------------------------------------------------------------
    n_b = max(3, round(n_leads * P["inject_score_leak"]))
    conv_leads = [l for l in leads if l["_status"] == "Converted" and l["_conv_ts"] <= AS_OF - timedelta(days=3) and l["lead_id"] not in touched
                  and l["lead_id"] not in dup_opp_ids]
    rng.shuffle(conv_leads)
    done_b = 0
    for l in conv_leads:
        if done_b >= n_b:
            break
        co, ct = comp_by_id[l["company_id"]], con_by_id[l["contact_id"]]
        clean = l["score"]
        new_ts = min(l["_conv_ts"] + timedelta(days=rng.uniform(1, 3)), AS_OF - timedelta(minutes=5))
        extra = []
        for k in range(rng.randrange(2, 4)):
            t = rng.choice(["pricing_page_view", "pricing_page_view", "demo_request", "trial_signup", "content_download"])
            ts = l["_conv_ts"] + (new_ts - l["_conv_ts"]) * rng.uniform(0.1, 0.9)
            extra.append((t, ts))
        base = [(a["activity_type"], iso(a["activity_ts"]), a["direction"]) for a in acts_of[l["lead_id"]]]
        res = score_lead(extract_features(co, ct, base + [(t, iso(ts), "inbound") for t, ts in extra], iso(new_ts)), compiled, explain=False)
        if res["score"] <= clean:
            continue
        for t, ts in extra:
            add_act(l, t, ts, detail="post-conversion activity")
        l["scored_ts"], l["score"], l["score_band"] = new_ts, res["score"], res["band"]
        l["_last_act"] = max(l["_last_act"], new_ts)
        touched.add(l["lead_id"])
        done_b += 1
        gt_pending.append(("score_post_conversion", "lead", l, "", "high", "recompute score with cut-off <= converted_ts",
                           f"stored score {res['score']} vs clean {clean}; scored {l['scored_ts'].isoformat()} after conversion {l['_conv_ts'].isoformat()}"))

    # (c) lead assigned outside territory --------------------------------------------------------------------------------------
    n_c = max(3, round(n_leads * P["inject_outside_territory"]))
    cand = [l for l in leads if l["routing_method"] in ("rule_based", "overflow_territory") and l["lead_id"] not in touched
            and not l["duplicate_of_lead_id"] and l["territory"] != "Other"]
    rng.shuffle(cand)
    for l in cand[:n_c]:
        wrong = [r for r in routable_reps if r["territory"] != l["territory"]]
        new_rep = rng.choice(wrong)
        old = l["assigned_rep_id"]
        l["assigned_rep_id"] = new_rep["rep_id"]
        for tk in tasks_of[l["lead_id"]]:
            tk["assigned_rep_id"] = new_rep["rep_id"]
        for a in acts_of[l["lead_id"]]:
            if a["rep_id"] == old:
                a["rep_id"] = new_rep["rep_id"]
        if l["lead_id"] in opp_by_lead:
            opp_by_lead[l["lead_id"]]["owner_rep_id"] = new_rep["rep_id"]
        touched.add(l["lead_id"])
        gt_pending.append(("lead_outside_territory", "lead", l, old, "medium", f"re-route to a {l['territory']} rep covering {l['product_interest']}",
                           f"assigned to {new_rep['rep_id']} ({new_rep['territory']}), lead territory {l['territory']}"))

    # (d) duplicate creates duplicate opportunity (planted during selection) ---------------------------------------------------------
    for l in dup_opp_leads:
        gt_pending.append(("duplicate_opportunity", "opportunity", opp_by_lead[l["lead_id"]], l["duplicate_of_lead_id"], "high",
                           "merge into canonical opportunity / block second opportunity",
                           f"duplicate lead {l['lead_id']} of {l['duplicate_of_lead_id']} converted to a second opportunity"))
        touched.add(l["lead_id"])

    # --- ids for opportunities / stage history ---------------------------------------------------------------------------------------
    opps.sort(key=lambda o: (o["created_ts"], o["lead_id"]))
    for n, o in enumerate(opps, 1):
        o["opportunity_id"] = fmt_opp(n)
        lead_by_id[o["lead_id"]]["opportunity_id"] = o["opportunity_id"]
        for k, ev in enumerate(o["_events"], 1):
            stage_hist.append({"stage_history_id": f"SH-{o['opportunity_id']}-{k:02d}", "opportunity_id": o["opportunity_id"], "from_stage": ev["from"],
                               "to_stage": ev["to"], "changed_ts": ev["ts"], "changed_by_rep_id": o["owner_rep_id"], "reason": ev["reason"]})

    # (e) stage-history gaps ---------------------------------------------------------------------------------------------------------
    n_e = max(3, round(n_opps * P["inject_stage_gap"]))
    by_opp = defaultdict(list)
    for s in stage_hist:
        by_opp[s["opportunity_id"]].append(s)
    cand = [o for o in opps if len(by_opp[o["opportunity_id"]]) >= 4 and o["lead_id"] not in dup_opp_ids]
    rng.shuffle(cand)
    drop = set()
    for o in cand[:n_e]:
        rows = by_opp[o["opportunity_id"]]
        gone = rows[rng.randrange(1, len(rows) - 1)]
        drop.add(gone["stage_history_id"])
        gt_pending.append(("stage_history_gap", "opportunity", o, gone["stage_history_id"], "medium",
                           f"restore missing transition {gone['from_stage']} -> {gone['to_stage']}", f"history row {gone['stage_history_id']} missing: chain is broken"))
    stage_hist = [s for s in stage_hist if s["stage_history_id"] not in drop]

    # ---- 8. derived values + final IDs -------------------------------------------------------------------------------------------------
    log("8/9 derived values, ids ...")
    activities = []
    for l in leads:
        lst = sorted(acts_of[l["lead_id"]], key=lambda a: (a["activity_ts"], a["activity_type"], a["direction"]))
        for n, a in enumerate(lst, 1):
            a["activity_id"] = fmt_act(l["lead_id"], n)
        activities.extend(lst)
        l["last_activity_ts"] = max(a["activity_ts"] for a in lst)
    tasks = [tk for l in leads for tk in tasks_of[l["lead_id"]]]
    for l in leads:
        l["status"], l["status_reason"] = l["_status"], l["_reason"]
        l["converted_ts"] = l["_conv_ts"]
        l.setdefault("opportunity_id", "")
        l["consent_status"] = lead_consent_state(cons_events[l["contact_id"]], iso(AS_OF))
        ms = l["_milestones"]
        ms.sort(key=lambda m: m[2])
        for k, (frm, to, ts, who, why) in enumerate(ms, 1):
            lead_hist.append({"lead_status_history_id": f"LSH-{l['lead_id']}-{k:02d}", "lead_id": l["lead_id"], "from_status": frm or "",
                              "to_status": to, "changed_ts": ts, "changed_by_rep_id": who or "", "reason": why})
        l["status"] = ms[-1][1]
    won_cos = {o["company_id"] for o in opps if o["status"] == "won"}
    for c in companies:
        c["account_status"] = "customer" if c["company_id"] in won_cos else "prospect"

    # lead_campaign bridge
    lead_campaign = []
    camp_by_id = {c["campaign_id"]: c for c in campaigns}
    for l in leads:
        created = l["created_ts"]
        used = set()
        if l["campaign_id"]:
            lead_campaign.append({"lead_id": l["lead_id"], "campaign_id": l["campaign_id"], "touch_type": "first_touch",
                                  "touch_ts": created - timedelta(hours=rng.uniform(0.2, 240))})
            used.add(l["campaign_id"])
        extra = rng.wchoice([0, 1, 2], [60, 30, 10]) if l["campaign_id"] else rng.wchoice([0, 1], [85, 15])
        for _ in range(extra):
            ov = [c for c in campaigns if c["_st"] <= created and c["_en"] >= created - timedelta(days=60) and c["campaign_id"] not in used
                  and c["target_region"] in (l["territory"], "Global")]
            if not ov:
                break
            c = rng.choice(ov)
            lo, hi = max(c["_st"], created - timedelta(days=60)), min(c["_en"] + timedelta(hours=23), created - timedelta(hours=1))
            if hi <= lo:
                continue
            used.add(c["campaign_id"])
            lead_campaign.append({"lead_id": l["lead_id"], "campaign_id": c["campaign_id"], "touch_type": "influence",
                                  "touch_ts": lo + (hi - lo) * rng.random()})

    # ---- 9. ground truth + outcomes ---------------------------------------------------------------------------------------------------------
    log("9/9 ground truth ...")
    gt = []

    def add_gt(etype, eid, issue, injected, sev, decision, related, detail):
        gt.append({"gt_id": "", "entity_type": etype, "entity_id": eid, "issue_type": issue, "is_injected": injected, "severity": sev,
                   "expected_decision": decision, "related_entity_id": related, "detail": detail})

    for issue, etype, obj, rel, sev, decision, detail in gt_pending:
        eid = obj["activity_id"] if etype == "activity" else obj["lead_id"] if etype == "lead" else obj["opportunity_id"]
        if issue == "duplicate_opportunity":
            rel = opp_by_lead[rel]["opportunity_id"]
        elif issue == "opted_out_contacted":
            rel = rel
        add_gt(etype, eid, issue, 1, sev, decision, rel, detail)
    merged_pairs = {cid: v[0] for cid, v in merges.items()}
    for c in contacts:
        if c["_kind"] == "dup_contact":
            src_pidx = persons[c["_pidx"]]["of"]
            canon = con_id_of[src_pidx]
            found = merged_pairs.get(c["contact_id"])
            add_gt("contact", c["contact_id"], "duplicate_contact", 1, "low", f"merge into {canon}", canon,
                   f"variant={c['_variant']}; detected_by_rules={'yes' if found else 'no'}")
    for l in leads:
        if "_planted_dup_of" in l:
            add_gt("lead", l["lead_id"], "duplicate_lead", 1, "low", f"merge into {l['_planted_dup_of']}", l["_planted_dup_of"],
                   f"planted {l['_kind']}; detected_by_rules={'yes' if l['duplicate_of_lead_id'] else 'no'}")
    outcomes = []
    for l in leads:
        o = opp_by_lead.get(l["lead_id"])
        converted = 1 if o else 0
        won = 1 if o and o["status"] == "won" else 0
        eligible = l["_elig"]
        matured = 1 if (eligible and l["_age"] >= C.MATURITY_DAYS) else 0
        if o:
            outcome = {"won": "converted_won", "lost": "converted_lost", "open": "converted_open"}[o["status"]]
        elif l["duplicate_of_lead_id"]:
            outcome = "merged_duplicate"
        else:
            outcome = {"Disqualified": "disqualified", "Stale": "stale"}.get(l["status"], "open")
        driver = ""
        if not converted and l["score"] >= C.HOT_THRESHOLD and l["_age"] >= C.MATURITY_DAYS:
            if l["_allopt"]:
                driver = "consent_blocked"
            elif l["assigned_rep_id"] == C.QUEUE_REP_ID:
                driver = "unroutable"
            elif l["duplicate_of_lead_id"]:
                driver = "merged_duplicate"
            elif not l["_sla1"]:
                driver = "slow_first_response"
            elif l["status"] == "Disqualified":
                driver = "disqualified_" + l["status_reason"].lower().replace(" ", "_")
            elif l["status"] == "Stale":
                driver = "went_cold"
            else:
                driver = "still_open"
            add_gt("lead", l["lead_id"], "high_score_non_converter", 0, "info", f"investigate: {driver}", "",
                   f"score {l['score']} (Hot) did not convert after {l['_age']} days; driver={driver}")
        if l["status"] == "Stale":
            add_gt("lead", l["lead_id"], "stale_lead", 0, "info", "re-engage or close", "",
                   f"no activity since {iso(l['last_activity_ts'])} (> {C.STALE_DAYS} days)")
        outcomes.append({"lead_id": l["lead_id"], "outcome": outcome, "converted": converted, "won": won,
                         "split": holdout_split(seed, l["lead_id"], C.HOLDOUT_TEST_PCT), "matured": matured, "loss_driver": driver})
    gt.sort(key=lambda r: (r["issue_type"], r["entity_id"]))
    for n, r in enumerate(gt, 1):
        r["gt_id"] = f"GT-{n:06d}"

    # final lead field cleanup -------------------------------------------------------------------------------------------------------------
    for l in leads:
        l["converted_ts"] = l["converted_ts"] if l["status"] == "Converted" else None
    tables = {
        "company": companies, "contact": contacts, "campaign": campaigns, "sales_rep": reps,
        "rep_product": [{"rep_id": rid, "product_line": p, "effective_from": next(r["hire_date"] for r in reps if r["rep_id"] == rid)}
                        for rid in sorted(rep_products) for p in sorted(rep_products[rid])],
        "score_rule": rules, "lead": leads, "lead_campaign": sorted(lead_campaign, key=lambda r: (r["lead_id"], r["touch_type"] != "first_touch", r["campaign_id"])),
        "consent": consents, "opportunity": opps, "activity": activities, "task": tasks, "stage_history": stage_hist, "lead_status_history": lead_hist,
    }
    return tables, gt, outcomes


def _make_opp(rng, P, l, co, conv_ts, seed, AS_OF, rep_by_id):
    lid = l["lead_id"]
    seats = int(min(5000, max(5, co["employee_count"] * rng.uniform(0.03, 0.25))))
    unit = C.UNIT_PRICE_USD[l["product_interest"]]
    disc = rng.wchoice(C.DISCOUNTS, [40, 25, 20, 10, 5])
    amount = round(seats * unit * (100 - disc) / 100.0, 2)
    logit = -1.0 + 0.03 * (l["score"] - 50) + 0.5 * l["_budget"] + 0.8 * (l["_interest"] - 0.4) + 0.025 * disc
    will_win = hash_uniform(seed, "win|" + lid) < sigmoid(logit)
    u_stage = hash_uniform(seed, "lost_at|" + lid)
    lost_at = 1 if u_stage < 0.15 else 2 if u_stage < 0.40 else 3 if u_stage < 0.70 else 4   # index of last open stage reached
    chain = C.OPEN_STAGES[:4] if will_win else C.OPEN_STAGES[:lost_at]
    durs = {"Discovery": rng.uniform(6, 28), "Proposal": rng.uniform(12, 40), "Negotiation": rng.uniform(12, 45)}
    ts = conv_ts
    events = [{"from": "", "to": "Qualified", "ts": ts, "reason": ""}]
    prev = "Qualified"
    for st in chain[1:]:
        ts = ts + timedelta(days=durs[st], hours=rng.uniform(0, 8))
        events.append({"from": prev, "to": st, "ts": ts, "reason": ""})
        prev = st
    final_stage = "Closed Won" if will_win else "Closed Lost"
    close_ts = ts + timedelta(days=rng.uniform(8, 45), hours=rng.uniform(0, 8))
    if will_win:
        reason = rng.wchoice(C.WON_REASONS, [35, 20, 20, 15, 10])
    elif lost_at <= 2:
        reason = rng.wchoice(["No budget", "Not a fit", "No decision", "Bad timing"], [30, 25, 25, 20])
    else:
        reason = rng.wchoice(["Lost to competitor", "Price too high", "Bad timing", "No decision"], [38, 30, 17, 15])
    events.append({"from": prev, "to": final_stage, "ts": close_ts, "reason": reason})
    kept = [e for e in events if e["ts"] <= AS_OF]
    stage = kept[-1]["to"]
    closed = stage in ("Closed Won", "Closed Lost")
    status = "won" if stage == "Closed Won" else "lost" if stage == "Closed Lost" else "open"
    for e in kept:
        if e["to"] not in ("Closed Won", "Closed Lost"):
            e["reason"] = ""
    return {"lead_id": lid, "company_id": l["company_id"], "contact_id": l["contact_id"], "owner_rep_id": l["assigned_rep_id"],
            "product_line": l["product_interest"], "seats": seats, "unit_price_usd": unit, "discount_pct": disc, "amount_usd": amount,
            "stage": stage, "status": status, "probability_pct": C.STAGE_PROB[stage], "created_ts": conv_ts,
            "expected_close_date": iso_date(conv_ts + timedelta(days=rng.uniform(30, 120))),
            "closed_ts": kept[-1]["ts"] if closed else None, "won_lost_reason": reason if closed else "", "_events": kept}


# ---------------------------------------------------------------------------------------------------------------------
def fmt(v, ftype):
    if v is None:
        return ""
    if isinstance(v, datetime):
        return iso(v)
    if ftype == "decimal":
        return f"{float(v):.2f}"
    if isinstance(v, bool):
        return int(v)
    return v


def export(tables, gt, outcomes, out, P, formats, log=print):
    out = Path(out)
    for sub in ("csv", "json", "sql"):
        (out / sub).mkdir(parents=True, exist_ok=True)
    rows_by_table, files = {}, {}
    for tname in S.LOAD_ORDER:
        fields = S.TABLES[tname]["fields"]
        rows = [[fmt(r.get(f["name"]), f["type"]) for f in fields] for r in tables[tname]]
        rows_by_table[tname] = rows
        if "csv" in formats:
            p = out / "csv" / f"{tname}.csv"
            with open(p, "w", newline="", encoding="utf-8") as fh:
                w = csv.writer(fh, lineterminator="\n")
                w.writerow([f["name"] for f in fields])
                w.writerows(rows)
            files[f"csv/{tname}.csv"] = (p, len(rows))
        if "json" in formats:
            p = out / "json" / f"{tname}.json"
            names = [f["name"] for f in fields]
            with open(p, "w", encoding="utf-8") as fh:
                json.dump([dict(zip(names, r)) for r in rows], fh, separators=(",", ":"))
            files[f"json/{tname}.json"] = (p, len(rows))
    # ground truth is ALWAYS written to its own folder
    (out / "ground_truth").mkdir(exist_ok=True)
    for name, fields, rows in (("ground_truth", S.GROUND_TRUTH_FIELDS, gt), ("ground_truth_outcomes", S.OUTCOME_FIELDS, outcomes)):
        p = out / "ground_truth" / f"{name}.csv"
        with open(p, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh, lineterminator="\n")
            w.writerow(fields)
            w.writerows([[r.get(f, "") for f in fields] for r in rows])
        files[f"ground_truth/{name}.csv"] = (p, len(rows))
    p = out / "ground_truth" / "ground_truth.json"
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(gt, fh, separators=(",", ":"))
    files["ground_truth/ground_truth.json"] = (p, len(gt))
    if "sql" in formats:
        p = out / "sql" / "seed.sql"
        with open(p, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("-- Synthetic seed data (seed=%s). Generated by generator/generate.py\nPRAGMA foreign_keys=OFF;\nBEGIN;\n" % P["seed"])
            for tname in S.LOAD_ORDER:
                fh.write(S.ddl(tname) + "\n")
            for tname in S.LOAD_ORDER:
                fields = S.TABLES[tname]["fields"]
                cols = ", ".join(f["name"] for f in fields)
                rows = rows_by_table[tname]
                for i in range(0, len(rows), 400):
                    vals = []
                    for r in rows[i:i + 400]:
                        vals.append("(" + ",".join("NULL" if (v == "" and not f["required"]) else (str(v) if isinstance(v, (int, float)) else "'" + str(v).replace("'", "''") + "'")
                                                   for v, f in zip(r, fields)) + ")")
                    fh.write(f"INSERT INTO {tname} ({cols}) VALUES\n" + ",\n".join(vals) + ";\n")
            fh.write("COMMIT;\n")
        files["sql/seed.sql"] = (p, sum(len(r) for r in rows_by_table.values()))
    return files


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def default_params(scale="full", **over):
    P = dict(SCALES[scale])
    P.update(seed=C.SEED, dup_contact_rate=0.05, dup_lead_rate=0.06, other_region_rate=0.012, free_email_rate=0.07, direct_rate=0.12,
             initial_optout_rate=0.025, later_optout_rate=0.05, z0=-4.4, dup_opp_rate=40 / 3000, inject_optout_contacted=0.006,
             inject_score_leak=0.003, inject_outside_territory=0.005, inject_stage_gap=50 / 3000)
    P.update({k: v for k, v in over.items() if v is not None})
    return P


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scale", choices=list(SCALES), default="full")
    ap.add_argument("--leads", type=int)
    ap.add_argument("--contacts", type=int)
    ap.add_argument("--companies", type=int)
    ap.add_argument("--opps", type=int)
    ap.add_argument("--seed", type=int, default=C.SEED)
    ap.add_argument("--out", default=str(ROOT / "data" / "full"))
    ap.add_argument("--formats", default="csv,json,sql")
    ap.add_argument("--no-validate", action="store_true")
    a = ap.parse_args(argv)
    P = default_params(a.scale, leads=a.leads, contacts=a.contacts, companies=a.companies, opps=a.opps, seed=a.seed)
    t0 = time.time()
    tables, gt, outcomes = build(P)
    files = export(tables, gt, outcomes, a.out, P, set(a.formats.split(",")))
    manifest = {
        "generator": "generator/generate.py", "command": "python generator/generate.py " + " ".join(argv if argv is not None else sys.argv[1:]),
        "seed": P["seed"], "as_of": iso(C.AS_OF), "parameters": {k: v for k, v in P.items()}, "python": sys.version.split()[0],
        "external_data_used": False,
        "sources": [{"name": "Synthetic generation", "url": None, "dataset_version": "generator v1.0", "retrieval_date": None,
                     "license": "Generated by this project; no third-party data; free to redistribute",
                     "attribution": "n/a", "transformations": "n/a", "fields_discarded": "n/a",
                     "notes": "All names, companies, e-mails (reserved .example domains) and phone numbers are fabricated. No personal or confidential data. "
                              "Public CRM/lead-scoring schemas (e.g. Salesforce Lead/Opportunity objects) were consulted for schema inspiration only; nothing was copied."}],
        "files": {k: {"rows": n, "sha256": sha256(p), "bytes": p.stat().st_size} for k, (p, n) in sorted(files.items())},
    }
    with open(Path(a.out) / "manifest.json", "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    from generator.docs import write_docs
    write_docs(Path(a.out) / "docs")
    print(f"done in {time.time() - t0:.1f}s -> {a.out}")
    for t in S.LOAD_ORDER:
        print(f"  {t:22s}{len(tables[t]):>9,}")
    print(f"  {'ground_truth':22s}{len(gt):>9,}")
    if not a.no_validate:
        from generator.validate import validate_dir
        summ = validate_dir(a.out, P["seed"])
        print(f"validation: {summ['passed']}/{summ['total']} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Zero-dependency JSON API + static file server (Python stdlib only).

    python -m backend.server --dataset data/full --port 8000
"""
import argparse
import json
import mimetypes
import re
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core import config as C  # noqa: E402
from generator import schema as S  # noqa: E402

from . import analytics, db, detectors, evaluation, state, workflow  # noqa: E402
from .workflow import ApiError  # noqa: E402

FRONTEND = ROOT / "frontend"
DATASET = {"dir": ROOT / "data" / "full"}
ROUTES = []


def route(method, pattern):
    rx = re.compile("^" + pattern + "$")

    def deco(fn):
        ROUTES.append((method, rx, fn))
        return fn
    return deco


def need(ctx, *roles):
    if ctx["role"] not in roles:
        raise ApiError(403, f"role '{ctx['role']}' cannot view this resource", required=list(roles))


# ----------------------------------------------------------------------------------------------------------------- reads
@route("GET", r"/api/health")
def health(ctx):
    return {"ok": True, "dataset": str(DATASET["dir"]), "clock": state.now().isoformat()}


@route("GET", r"/api/overview")
def overview(ctx):
    return analytics.overview()


@route("GET", r"/api/leads/filters")
def lead_filters(ctx):
    return analytics.lead_filters()


@route("GET", r"/api/leads")
def leads(ctx):
    return analytics.leads_list(ctx["q"])


@route("GET", r"/api/leads/(LEAD-\d{4}-\d{6})")
def lead_detail(ctx, lid):
    d = analytics.lead_detail(lid)
    if not d:
        raise ApiError(404, "lead not found")
    return d


@route("GET", r"/api/leads/(LEAD-\d{4}-\d{6})/score")
def lead_score(ctx, lid):
    r = analytics.explain_lead(lid, cutoff=ctx["q"].get("cutoff"), version=int(ctx["q"]["version"]) if ctx["q"].get("version") else None)
    if not r:
        raise ApiError(404, "lead not found")
    return r


@route("GET", r"/api/tasks")
def tasks(ctx):
    return analytics.tasks_list(ctx["q"])


@route("GET", r"/api/reps")
def reps(ctx):
    return analytics.reps_overview()


@route("GET", r"/api/opportunities/board")
def board(ctx):
    return analytics.opportunities_board(ctx["q"])


@route("GET", r"/api/opportunities/(OPP-\d{4}-\d{6})")
def opp_detail(ctx, oid):
    d = analytics.opportunity_detail(oid)
    if not d:
        raise ApiError(404, "opportunity not found")
    return d


@route("GET", r"/api/campaigns")
def campaigns(ctx):
    return analytics.campaigns_perf()


@route("GET", r"/api/dedupe")
def dedupe(ctx):
    return analytics.dedupe_overview()


@route("GET", r"/api/dedupe/review")
def dedupe_review(ctx):
    need(ctx, "analyst", "admin", "ops")
    return analytics.dedupe_review()


@route("GET", r"/api/consent")
def consent(ctx):
    return analytics.consent_overview()


@route("GET", r"/api/contacts/search")
def contact_search(ctx):
    qq = f"%{ctx['q'].get('q', '')}%"
    rows = db.q("""SELECT c.contact_id, c.first_name || ' ' || c.last_name name, c.email, c.job_title, co.company_name, c.contact_status
                   FROM contact c JOIN company co ON co.company_id = c.company_id
                   WHERE c.contact_id LIKE ? OR c.email LIKE ? OR c.first_name || ' ' || c.last_name LIKE ? ORDER BY c.contact_id LIMIT 15""", (qq, qq, qq))
    return {"rows": rows}


@route("GET", r"/api/contacts/(CON-\d{6})")
def contact_detail(ctx, cid):
    c = db.q1("SELECT c.*, co.company_name, co.region FROM contact c JOIN company co ON co.company_id = c.company_id WHERE c.contact_id=?", (cid,))
    if not c:
        raise ApiError(404, "contact not found")
    from core.routing import can_contact
    cons = db.q("SELECT * FROM consent WHERE contact_id=? ORDER BY effective_ts", (cid,))
    ev = [(x["effective_ts"], x["channel"], x["status"]) for x in cons]
    now = state.now().strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"contact": c, "consents": cons, "can_contact": {"email": can_contact(ev, "email", now), "phone": can_contact(ev, "phone", now)},
            "leads": db.q("SELECT lead_id, status, score, score_band, product_interest FROM lead WHERE contact_id=?", (cid,))}


@route("GET", r"/api/routing")
def routing(ctx):
    return analytics.routing_overview()


@route("GET", r"/api/score-rules")
def score_rules(ctx):
    return analytics.score_rules_overview()


@route("GET", r"/api/exceptions")
def exceptions(ctx):
    need(ctx, "analyst", "admin", "ops", "agent")
    out = detectors.evaluate_against_truth() if ctx["role"] in ("analyst", "admin", "ops") else {"types": [], "dedupe": {}}
    det = detectors.detect_all()
    cnt = {}
    for e in det:
        cnt[e["issue_type"]] = cnt.get(e["issue_type"], 0) + 1
    meta = [{"issue_type": k, "title": v[0], "severity": v[1], "area": v[2], "rule": v[3], "detected": cnt.get(k, 0)} for k, v in detectors.META.items()]
    return {"summary": meta, "evaluation": out, "total": len(det)}


@route("GET", r"/api/exceptions/list")
def exceptions_list(ctx):
    t = ctx["q"].get("type")
    rows = [e for e in detectors.detect_all() if not t or e["issue_type"] == t]
    page, size = max(1, int(ctx["q"].get("page", 1))), min(100, int(ctx["q"].get("page_size", 20)))
    return {"total": len(rows), "page": page, "rows": rows[(page - 1) * size: page * size]}


@route("GET", r"/api/evaluation")
def evaluation_report(ctx):
    need(ctx, "analyst", "admin", "ops")
    return evaluation.full_report()


@route("GET", r"/api/audit")
def audit(ctx):
    return {"rows": analytics.audit_log(int(ctx["q"].get("limit", 100)))}


@route("GET", r"/api/meta")
def meta(ctx):
    d = DATASET["dir"]
    manifest = json.loads((d / "manifest.json").read_text()) if (d / "manifest.json").exists() else {}
    return {"as_of": C.AS_OF.isoformat(), "clock": state.now().isoformat(), "seed": manifest.get("seed"), "parameters": manifest.get("parameters"),
            "command": manifest.get("command"), "sources": manifest.get("sources"), "files": manifest.get("files"), "tables": {
                t: {"entity": s["entity"], "pk": s["pk"], "description": s["description"], "lifecycle": s["lifecycle"], "fields": s["fields"]} for t, s in S.TABLES.items()},
            "relationships": S.RELATIONSHIPS, "load_order": S.LOAD_ORDER, "roles": workflow.PERMISSIONS,
            "ground_truth_fields": S.GROUND_TRUTH_FIELDS, "outcome_fields": S.OUTCOME_FIELDS}


@route("GET", r"/api/validation")
def validation(ctx):
    p = DATASET["dir"] / "validation_summary.json"
    return json.loads(p.read_text()) if p.exists() else {"total": 0, "passed": 0, "failed": 0, "checks": []}


@route("GET", r"/api/reproducibility")
def reproducibility(ctx):
    p = DATASET["dir"] / "reproducibility_report.json"
    return json.loads(p.read_text()) if p.exists() else {"all_identical": None, "files": [], "note": "run: python generator/reproduce.py"}


# ----------------------------------------------------------------------------------------------------------------- writes
@route("POST", r"/api/leads/intake")
def intake(ctx):
    return workflow.intake(ctx["body"], ctx["role"], dry_run=ctx["q"].get("dry_run") == "1")


@route("POST", r"/api/leads/(LEAD-\d{4}-\d{6})/convert")
def convert(ctx, lid):
    return workflow.convert_lead(lid, ctx["body"], ctx["role"])


@route("POST", r"/api/leads/(LEAD-\d{4}-\d{6})/assign")
def assign(ctx, lid):
    return workflow.assign_lead(lid, ctx["body"], ctx["role"])


@route("POST", r"/api/leads/(LEAD-\d{4}-\d{6})/rescore")
def rescore(ctx, lid):
    return workflow.rescore_lead(lid, ctx["role"])


@route("POST", r"/api/leads/(LEAD-\d{4}-\d{6})/activity")
def log_activity(ctx, lid):
    return workflow.log_activity(lid, ctx["body"], ctx["role"])


@route("POST", r"/api/tasks/(TASK-LEAD-\d{4}-\d{6}-\d{3})/complete")
def complete(ctx, tid):
    return workflow.complete_task(tid, ctx["body"], ctx["role"])


@route("POST", r"/api/consent")
def consent_update(ctx):
    return workflow.update_consent(ctx["body"], ctx["role"])


@route("POST", r"/api/opportunities/(OPP-\d{4}-\d{6})/advance")
def advance(ctx, oid):
    return workflow.advance_opportunity(oid, ctx["body"], ctx["role"])


@route("POST", r"/api/score-rules/publish")
def publish(ctx):
    return workflow.publish_rules(ctx["body"], ctx["role"])


@route("POST", r"/api/evaluation/simulate")
def simulate(ctx):
    need(ctx, "analyst", "admin", "ops")
    return evaluation.simulate(ctx["body"])


@route("POST", r"/api/evaluation/tune")
def tune(ctx):
    need(ctx, "analyst", "admin")
    return evaluation.tune()


@route("POST", r"/api/validation/run")
def validation_run(ctx):
    need(ctx, "analyst", "admin")
    from generator.validate import validate_dir
    return validate_dir(DATASET["dir"])


@route("POST", r"/api/sql")
def sql(ctx):
    return workflow.run_sql(ctx["body"], ctx["role"])


@route("POST", r"/api/reset")
def reset(ctx):
    workflow.require(ctx["role"], "reset")
    with db.WRITE_LOCK:
        db.begin_reset()
        try:
            db.build_db(DATASET["dir"], force=True)
        finally:
            db.end_reset()
        state.bump()
    return {"ok": True, "message": "runtime database rebuilt from the seed CSVs"}


# ----------------------------------------------------------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LeadFlow/1.0"

    def log_message(self, fmt, *args):
        if "--quiet" not in sys.argv:
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    def _send(self, code, payload, ctype="application/json", extra=None):
        body = payload if isinstance(payload, (bytes, bytearray)) else json.dumps(payload, default=str, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _api(self, method):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            return self._send(400, {"error": "invalid JSON body"})
        role = (self.headers.get("X-Role") or "analyst").lower()
        ctx = {"q": q, "body": body, "role": role}
        t0 = time.time()
        for m, rx, fn in ROUTES:
            if m != method:
                continue
            mt = rx.match(u.path)
            if mt:
                try:
                    out = fn(ctx, *mt.groups())
                    return self._send(200, out, extra={"X-Elapsed-Ms": str(int((time.time() - t0) * 1000))})
                except ApiError as e:
                    return self._send(e.status, {"error": e.message, **e.extra})
                except Exception as e:  # noqa: BLE001
                    traceback.print_exc()
                    return self._send(500, {"error": f"{type(e).__name__}: {e}"})
        return self._send(404, {"error": f"no route for {method} {u.path}"})

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._api("GET")
        p = urlparse(self.path).path
        rel = p.lstrip("/") or "index.html"
        f = (FRONTEND / rel).resolve()
        if not str(f).startswith(str(FRONTEND.resolve())) or not f.is_file():
            f = FRONTEND / "index.html"
        ctype = {".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".json": "application/json"}.get(
            f.suffix) or mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        if f.suffix in (".js", ".css", ".html", ".svg"):
            ctype += "; charset=utf-8"
        self._send(200, f.read_bytes(), ctype)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self._api("POST")
        self._send(404, {"error": "not found"})


def warm():
    t0 = time.time()
    analytics.overview()
    detectors.detect_all()
    detectors.evaluate_against_truth()
    evaluation.store()
    print(f"caches warm in {time.time() - t0:.1f}s")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(ROOT / "data" / "full"))
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    DATASET["dir"] = Path(a.dataset).resolve()
    if not (DATASET["dir"] / "manifest.json").exists():
        sys.exit(f"dataset not found at {DATASET['dir']} - run: python generator/generate.py --out {a.dataset}")
    db.build_db(DATASET["dir"], force=a.rebuild)
    warm()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    print(f"LeadFlow listening on http://{a.host}:{a.port}  (dataset: {DATASET['dir']})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

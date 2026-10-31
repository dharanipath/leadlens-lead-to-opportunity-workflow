"""SQLite runtime store.

* main DB (data/runtime.db)  - the 14 entity tables + audit_log. This is the only DB scoring / routing / workflow code opens.
* ground-truth DB (data/ground_truth.db) - labels & anomaly truth. Opened *only* by backend.evaluation / backend.detectors
  compare functions, so labels can never leak into input features.
"""
import csv
import json
import sqlite3
import sys
import threading
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core import config as C  # noqa: E402
from core.util import iso  # noqa: E402
from generator import schema as S  # noqa: E402

DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "runtime.db"
GT_PATH = DATA_DIR / "ground_truth.db"
_local = threading.local()
WRITE_LOCK = threading.RLock()

INDEXES = [
    "lead(contact_id)", "lead(company_id)", "lead(assigned_rep_id)", "lead(status)", "lead(created_ts)", "lead(campaign_id)",
    "lead(score_band)", "lead(duplicate_of_lead_id)", "lead(opportunity_id)", "activity(lead_id)", "activity(activity_ts)",
    "activity(activity_type)", "task(lead_id)", "task(assigned_rep_id, status)", "task(status)", "opportunity(stage)",
    "opportunity(owner_rep_id)", "opportunity(company_id)", "stage_history(opportunity_id)", "lead_status_history(lead_id)",
    "consent(contact_id)", "contact(company_id)", "lead_campaign(lead_id)", "lead_campaign(campaign_id)", "contact(email)",
    "opportunity(lead_id)", "opportunity(status)", "task(task_type, status)", "lead(source)", "lead(territory, product_interest)", "consent(status)",
]

AUDIT_DDL = """CREATE TABLE IF NOT EXISTS audit_log (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL,
  entity_type TEXT, entity_id TEXT, outcome TEXT NOT NULL, message TEXT, before_json TEXT, after_json TEXT);"""


def conv(v, f):
    if v == "":
        return None
    t = f["type"]
    if t in ("int", "bool"):
        return int(v)
    if t == "decimal":
        return float(v)
    return v


def build_db(dataset_dir, force=False, log=print):
    dataset_dir = Path(dataset_dir)
    manifest = json.loads((dataset_dir / "manifest.json").read_text())
    sig = json.dumps({k: v["sha256"] for k, v in manifest["files"].items() if k.startswith("csv/") or k.startswith("ground_truth/")}, sort_keys=True)
    if DB_PATH.exists() and not force:
        try:
            c = sqlite3.connect(DB_PATH)
            row = c.execute("SELECT value FROM meta WHERE key='signature'").fetchone()
            c.close()
            if row and row[0] == sig and GT_PATH.exists():
                return False
        except sqlite3.Error:
            pass
    log(f"building runtime database from {dataset_dir} ...")
    for p in (DB_PATH, GT_PATH, Path(str(DB_PATH) + "-wal"), Path(str(DB_PATH) + "-shm")):
        if p.exists():
            p.unlink()
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=OFF")
    for t in S.LOAD_ORDER:
        conn.execute(S.ddl(t))
    conn.execute(AUDIT_DDL)
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    for t in S.LOAD_ORDER:
        fields = S.TABLES[t]["fields"]
        with open(dataset_dir / "csv" / f"{t}.csv", newline="", encoding="utf-8") as fh:
            rd = csv.reader(fh)
            next(rd)
            rows = [[conv(v, f) for v, f in zip(r, fields)] for r in rd]
        conn.executemany(f"INSERT INTO {t} VALUES ({','.join('?' * len(fields))})", rows)
    for i, ix in enumerate(INDEXES):
        conn.execute(f"CREATE INDEX ix_{i} ON {ix}")
    conn.execute("ANALYZE")
    conn.execute("INSERT INTO meta VALUES ('signature', ?)", (sig,))
    conn.execute("INSERT INTO meta VALUES ('dataset_dir', ?)", (str(dataset_dir),))
    conn.commit()
    conn.close()
    # ground truth in its OWN database file
    g = sqlite3.connect(GT_PATH)
    gdir = dataset_dir / "ground_truth"
    g.execute("CREATE TABLE gt_anomaly (" + ",".join(f"{c} TEXT" for c in S.GROUND_TRUTH_FIELDS) + ", PRIMARY KEY (gt_id))")
    g.execute("CREATE TABLE gt_outcome (" + ",".join(f"{c} TEXT" for c in S.OUTCOME_FIELDS) + ", PRIMARY KEY (lead_id))")
    for tname, fields, file in (("gt_anomaly", S.GROUND_TRUTH_FIELDS, "ground_truth.csv"), ("gt_outcome", S.OUTCOME_FIELDS, "ground_truth_outcomes.csv")):
        with open(gdir / file, newline="", encoding="utf-8") as fh:
            rd = csv.reader(fh)
            next(rd)
            g.executemany(f"INSERT INTO {tname} VALUES ({','.join('?' * len(fields))})", list(rd))
    g.execute("CREATE INDEX gx1 ON gt_anomaly(issue_type)")
    g.commit()
    g.close()
    return True


_registry = []            # every open per-thread connection, so a reset can close them all (Windows cannot delete open files)
_reg_lock = threading.Lock()
_gen = 0
_ready = threading.Event()   # cleared while the runtime database is being rebuilt
_ready.set()


def begin_reset():
    _ready.clear()
    close_all()


def end_reset():
    _ready.set()


def connect():
    _ready.wait(180)
    c = getattr(_local, "conn", None)
    if c is None or getattr(_local, "gen", -1) != _gen:
        c = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=OFF")
        _local.conn, _local.gen = c, _gen
        with _reg_lock:
            _registry.append(c)
    return c


def close_all():
    """Close every thread's connection (called by the reset endpoint before the database file is replaced)."""
    global _gen
    with _reg_lock:
        _gen += 1
        for c in _registry:
            try:
                c.close()
            except sqlite3.Error:
                pass
        _registry.clear()
    _local.conn = None


def connect_gt():
    c = sqlite3.connect(f"file:{GT_PATH.as_posix()}?mode=ro", uri=True, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def q(sql, params=(), conn=None):
    c = conn or connect()
    return [dict(r) for r in c.execute(sql, params).fetchall()]


def q1(sql, params=(), conn=None):
    c = conn or connect()
    r = c.execute(sql, params).fetchone()
    return dict(r) if r else None


def scalar(sql, params=(), conn=None):
    c = conn or connect()
    r = c.execute(sql, params).fetchone()
    return r[0] if r else None


def audit(conn, role, action, etype, eid, outcome, message, before=None, after=None, ts=None):
    conn.execute("INSERT INTO audit_log (ts, actor_role, action, entity_type, entity_id, outcome, message, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?)",
                 (ts or iso(C.AS_OF), role, action, etype, eid, outcome, message,
                  json.dumps(before, default=str) if before is not None else None, json.dumps(after, default=str) if after is not None else None))

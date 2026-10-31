"""Small deterministic helpers (time formatting, IDs, hash-based uniform draws)."""
import hashlib
import math
from datetime import datetime, timedelta

TS_FMT = "%Y-%m-%dT%H:%M:%SZ"


def iso(dt):
    return dt.strftime(TS_FMT) if dt else ""


def parse_ts(s):
    return datetime.fromisoformat(s[:19]) if s else None


def iso_date(dt):
    return dt.strftime("%Y-%m-%d") if dt else ""


def parse_date(s):
    return datetime.fromisoformat(s[:10]) if s else None


def hash_uniform(seed, key):
    """Deterministic U(0,1) draw keyed by (seed, key) - independent of RNG consumption order."""
    h = hashlib.sha256(f"{seed}|{key}".encode()).hexdigest()[:13]
    return int(h, 16) / float(16 ** 13)


def sigmoid(z):
    return 1.0 / (1.0 + math.exp(-z))


def fmt_co(n):
    return f"CO-{n:06d}"


def fmt_con(n):
    return f"CON-{n:06d}"


def fmt_lead(n, year=2026):
    return f"LEAD-{year}-{n:06d}"


def fmt_opp(n, year=2026):
    return f"OPP-{year}-{n:06d}"


def fmt_act(lead_id, n):
    return f"ACT-{lead_id}-{n:03d}"


def fmt_task(lead_id, n):
    return f"TASK-{lead_id}-{n:03d}"


def holdout_split(seed, lead_id, test_pct=30):
    """Deterministic train/test assignment (held-out outcomes for evaluation)."""
    return "test" if hash_uniform(seed, "split|" + lead_id) * 100 < test_pct else "train"

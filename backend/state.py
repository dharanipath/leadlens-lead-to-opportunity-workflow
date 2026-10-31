"""Tiny in-process cache + simulation clock shared by all backend modules."""
import threading
import time
from datetime import timedelta

from core import config as C

_lock = threading.RLock()
_version = 0
_cache = {}
_START = time.time()


def bump():
    """Call after every committed write: invalidates cached analytics."""
    global _version
    with _lock:
        _version += 1
        _cache.clear()


def version():
    return _version


def memo(key, fn, static=False):
    """Cache fn() under key until the next write (static=True survives writes)."""
    with _lock:
        k = (key, 0 if static else _version)
        if k in _cache:
            return _cache[k]
    val = fn()
    with _lock:
        _cache[(key, 0 if static else _version)] = val
    return val


def now():
    """Simulation clock: starts one day after the dataset as-of date and advances in real time."""
    return C.AS_OF + timedelta(days=1) + timedelta(seconds=time.time() - _START)

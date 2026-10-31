"""Deterministic contact de-duplication (two documented tiers).

Tier 1  exact match on normalised e-mail (lower-case, '+tag' removed, trimmed).
Tier 2  same company + same normalised last name + similar first name
        (nickname table, initial match, or SequenceMatcher ratio >= 0.80).

The canonical record of a cluster is the earliest-created contact. Planted
duplicates that neither tier can see (e.g. hyphenated last-name change with a
different mailbox) are *missed on purpose*; the ground truth records them so
recall can be measured.
"""
import re
from difflib import SequenceMatcher

from .config import NICKNAMES

_NICK_CANON = {}
for full, nick in NICKNAMES.items():
    _NICK_CANON[full] = full
    _NICK_CANON[nick] = full


def norm_email(email):
    e = (email or "").strip().lower()
    if "@" not in e:
        return e
    local, domain = e.split("@", 1)
    local = local.split("+", 1)[0]
    return f"{local}@{domain}"


def norm_name(s):
    return re.sub(r"[^a-z]", "", (s or "").lower())


def first_name_similar(a, b):
    a, b = norm_name(a), norm_name(b)
    if not a or not b:
        return False
    if a == b or _NICK_CANON.get(a, a) == _NICK_CANON.get(b, b):
        return True
    if (len(a) == 1 or len(b) == 1) and a[0] == b[0]:
        return True
    return SequenceMatcher(None, a, b).ratio() >= 0.80


def match_pair(c1, c2):
    """Return (tier, reason) if the two contact dicts look like the same person, else None."""
    if norm_email(c1["email"]) == norm_email(c2["email"]):
        return 1, "normalised e-mail match"
    if (c1["company_id"] == c2["company_id"] and norm_name(c1["last_name"]) == norm_name(c2["last_name"])
            and first_name_similar(c1["first_name"], c2["first_name"])):
        return 2, "same company + last name + similar first name"
    return None


def cluster_contacts(contacts):
    """contacts: list of dicts ordered by (created_date, contact_id).
    Returns {contact_id: (canonical_id, tier, reason)} only for merged (non-canonical) contacts."""
    by_email, by_company_last = {}, {}
    merged = {}
    for c in contacts:
        cid = c["contact_id"]
        ek = norm_email(c["email"])
        canon, tier, reason = None, None, None
        if ek in by_email:
            canon, tier, reason = by_email[ek], 1, "normalised e-mail match"
        else:
            key = (c["company_id"], norm_name(c["last_name"]))
            for other in by_company_last.get(key, []):
                if first_name_similar(c["first_name"], other["first_name"]):
                    canon, tier, reason = other["contact_id"], 2, "same company + last name + similar first name"
                    break
        if canon:
            merged[cid] = (canon, tier, reason)
        else:
            by_email[ek] = cid
            by_company_last.setdefault((c["company_id"], norm_name(c["last_name"])), []).append(c)
    return merged

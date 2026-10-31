"""Unit + integration tests (stdlib unittest):  python -m unittest discover -s tests -v"""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core import config as C  # noqa: E402
from core.dedupe import cluster_contacts, norm_email  # noqa: E402
from core.routing import can_contact, route_lead  # noqa: E402
from core.scoring import compile_rules, default_rules, extract_features, score_lead  # noqa: E402
from generator import generate as G  # noqa: E402
from generator.validate import validate_dir  # noqa: E402


class ScoringTests(unittest.TestCase):
    comp = {"industry": "FinTech", "employee_count": 2400, "region": "NA-East"}
    con = {"seniority": "C-level", "email": "a@corp.example"}

    def test_score_is_deterministic_and_bounded(self):
        c = compile_rules(default_rules())
        acts = [("demo_request", "2026-05-01T10:00:00Z", "inbound")] * 1 + [("pricing_page_view", "2026-05-02T10:00:00Z", "inbound")] * 5
        f = extract_features(self.comp, self.con, acts, "2026-05-03T00:00:00Z")
        a, b = score_lead(f, c), score_lead(f, c)
        self.assertEqual(a["score"], b["score"])
        self.assertTrue(0 <= a["score"] <= 100)
        self.assertLessEqual(a["dimensions"]["intent"]["points"], 35)

    def test_future_and_outbound_events_are_ignored(self):
        f = extract_features(self.comp, self.con, [("demo_request", "2026-05-04T00:00:00Z", "inbound"), ("email_outbound", "2026-05-01T00:00:00Z", "outbound")],
                             "2026-05-03T00:00:00Z")
        self.assertEqual(f["counts"], {})

    def test_free_email_penalty(self):
        c = compile_rules(default_rules())
        a = score_lead(extract_features(self.comp, self.con, [], "2026-05-03T00:00:00Z"), c)["score"]
        b = score_lead(extract_features(self.comp, {**self.con, "email": "x@freemail.example"}, [], "2026-05-03T00:00:00Z"), c)["score"]
        self.assertEqual(a - b, 10)


class RuleTests(unittest.TestCase):
    def test_latest_consent_event_wins(self):
        ev = [("2026-01-01T00:00:00Z", "all", "opted_in"), ("2026-02-01T00:00:00Z", "email", "opted_out")]
        self.assertTrue(can_contact(ev, "email", "2026-01-15T00:00:00Z"))
        self.assertFalse(can_contact(ev, "email", "2026-02-02T00:00:00Z"))
        self.assertTrue(can_contact(ev, "phone", "2026-02-02T00:00:00Z"))
        self.assertFalse(can_contact([], "email", "2026-02-02T00:00:00Z"))

    def test_routing_paths(self):
        reps = [{"rep_id": "R1", "territory": "EMEA", "role": "SDR"}, {"rep_id": "R2", "territory": "EMEA", "role": "AE"}]
        rp = {"R1": {"Security"}, "R2": {"Analytics"}}
        self.assertEqual(route_lead("EMEA", "Security", reps, rp, {})[:2], ("R1", "rule_based"))
        self.assertEqual(route_lead("EMEA", "Automation", reps, rp, {"R1": 5})[:2], ("R2", "overflow_territory"))
        self.assertEqual(route_lead("Other", "Security", reps, rp, {})[:2], (C.QUEUE_REP_ID, "unroutable_queue"))

    def test_dedupe_tiers(self):
        base = {"company_id": "CO-1", "first_name": "Robert", "last_name": "Smith", "email": "robert.smith@x.example", "contact_id": "CON-1", "created_date": "2026-01-01"}
        v1 = {**base, "contact_id": "CON-2", "email": "Robert.Smith+promo@x.example"}
        v2 = {**base, "contact_id": "CON-3", "first_name": "Bob", "email": "r.smith@x.example"}
        hard = {**base, "contact_id": "CON-4", "last_name": "Smith-Jones", "email": "robert.smith-jones@x.example"}
        m = cluster_contacts([base, v1, v2, hard])
        self.assertEqual(m["CON-2"][:2], ("CON-1", 1))
        self.assertEqual(m["CON-3"][:2], ("CON-1", 2))
        self.assertNotIn("CON-4", m)
        self.assertEqual(norm_email(" A+b@X.com "), "a@x.com")


class GeneratorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.paths = []
        for i in (1, 2):
            out = Path(cls.tmp.name) / f"run{i}"
            G.main(["--scale", "starter", "--out", str(out), "--formats", "csv", "--no-validate"])
            cls.paths.append(out)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_validation_passes_with_exact_ground_truth_match(self):
        s = validate_dir(self.paths[0], write=False)
        failed = [c["name"] for c in s["checks"] if c["status"] != "pass"]
        self.assertEqual(failed, [])
        self.assertGreater(s["total"], 150)

    def test_same_seed_is_byte_identical(self):
        for f in sorted((self.paths[0] / "csv").glob("*.csv")) + sorted((self.paths[0] / "ground_truth").glob("*.csv")):
            rel = f.relative_to(self.paths[0])
            self.assertEqual(hashlib.sha256(f.read_bytes()).hexdigest(), hashlib.sha256((self.paths[1] / rel).read_bytes()).hexdigest(), rel)

    def test_ids_follow_conventions(self):
        import csv
        rows = list(csv.DictReader(open(self.paths[0] / "csv" / "activity.csv", encoding="utf-8")))
        self.assertTrue(rows[0]["activity_id"].startswith("ACT-LEAD-2026-"))
        self.assertTrue(rows[0]["activity_id"].endswith("-001"))
        lead = list(csv.DictReader(open(self.paths[0] / "csv" / "lead.csv", encoding="utf-8")))
        self.assertEqual(lead[0]["lead_id"], "LEAD-2026-000001")


if __name__ == "__main__":
    unittest.main()

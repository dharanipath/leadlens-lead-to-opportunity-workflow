"""Step 10: regenerate twice with the same seed (fresh interpreter processes, different PYTHONHASHSEED) and compare
row counts + SHA-256 checksums of every exported file. Also proves a different seed changes the data.

    python generator/reproduce.py --scale full --reference data/full
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from core import config as C  # noqa: E402


def run(scale, seed, out, hashseed):
    env = dict(os.environ, PYTHONHASHSEED=str(hashseed))
    subprocess.run([sys.executable, str(ROOT / "generator" / "generate.py"), "--scale", scale, "--seed", str(seed), "--out", str(out),
                    "--formats", "csv,json,sql", "--no-validate"], check=True, env=env, stdout=subprocess.DEVNULL)
    return json.loads((Path(out) / "manifest.json").read_text())["files"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scale", default="full")
    ap.add_argument("--seed", type=int, default=C.SEED)
    ap.add_argument("--reference", default=str(ROOT / "data" / "full"))
    a = ap.parse_args()
    tmp = ROOT / "data" / "_repro"
    shutil.rmtree(tmp, ignore_errors=True)
    runs = {}
    for name, hs, seed in (("run_1", 1, a.seed), ("run_2", 12345, a.seed), ("different_seed", 7, a.seed + 1)):
        print("running", name, "...", flush=True)
        runs[name] = run(a.scale, seed, tmp / name, hs)
    ref_manifest = Path(a.reference) / "manifest.json"
    ref = json.loads(ref_manifest.read_text())["files"] if ref_manifest.exists() else None
    rows = []
    all_ok = True
    for f in sorted(runs["run_1"]):
        r1, r2, r3 = runs["run_1"][f], runs["run_2"][f], runs["different_seed"][f]
        same = r1["sha256"] == r2["sha256"] and r1["rows"] == r2["rows"]
        vs_ref = (ref[f]["sha256"] == r1["sha256"]) if ref and f in ref else None
        all_ok &= same and vs_ref is not False
        rows.append({"file": f, "rows_run1": r1["rows"], "rows_run2": r2["rows"], "sha256_run1": r1["sha256"], "sha256_run2": r2["sha256"],
                     "identical": same, "matches_published_dataset": vs_ref, "differs_with_other_seed": r1["sha256"] != r3["sha256"]})
    report = {"seed": a.seed, "scale": a.scale, "command": f"python generator/reproduce.py --scale {a.scale}", "all_identical": all_ok,
              "files_compared": len(rows), "note": "run_1 and run_2 used different PYTHONHASHSEED values to expose any hash-order nondeterminism",
              "files": rows}
    out = Path(a.reference) / "reproducibility_report.json"
    out.write_text(json.dumps(report, indent=2))
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"{'REPRODUCIBLE' if all_ok else 'MISMATCH'}: {len(rows)} files, wrote {out}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())

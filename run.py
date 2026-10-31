"""One-command launcher:  python run.py [--scale full|starter] [--port 8000] [--rebuild] [--no-browser]

1. generates the dataset if it does not exist yet (deterministic, seed 20261022)
2. builds the SQLite runtime store (data/runtime.db + separate data/ground_truth.db)
3. serves the API + web UI on http://127.0.0.1:<port>
"""
import argparse
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scale", choices=["full", "starter"], default="full")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--rebuild", action="store_true", help="rebuild the runtime database from the seed CSVs (discards demo edits)")
    ap.add_argument("--regenerate", action="store_true", help="re-run the generator even if the dataset exists")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    ds = ROOT / "data" / a.scale
    if a.regenerate or not (ds / "manifest.json").exists():
        print(f"generating {a.scale} dataset -> {ds} (takes ~30 s) ...")
        subprocess.run([sys.executable, str(ROOT / "generator" / "generate.py"), "--scale", a.scale, "--out", str(ds)], check=True)
    if not a.no_browser:
        threading.Timer(4.0, lambda: webbrowser.open(f"http://127.0.0.1:{a.port}/")).start()
    argv = ["--dataset", str(ds), "--port", str(a.port)] + (["--rebuild"] if a.rebuild else [])
    sys.path.insert(0, str(ROOT))
    from backend.server import main as serve
    serve(argv)


if __name__ == "__main__":
    main()

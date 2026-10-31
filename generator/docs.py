"""Step 9: schema / data-dictionary export (Markdown + JSON + SQL DDL + Mermaid ERD) generated from generator/schema.py."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from generator import schema as S  # noqa: E402

PIPE = "\\|"


def _cell(v):
    if v is None or v == "":
        return "—"
    if isinstance(v, list):
        s = ", ".join(map(str, v))
        return s if len(s) < 90 else s[:87] + "…"
    return str(v).replace("|", PIPE)


def data_dictionary_md():
    out = ["# Data dictionary", "", "Generated from `generator/schema.py` (single source of truth). Timestamps are ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`), dates `YYYY-MM-DD`, money in USD.", ""]
    out += ["## Entities", "", "| Table | Entity | Primary key | Lifecycle |", "|---|---|---|---|"]
    for t, s in S.TABLES.items():
        out.append(f"| `{t}` | {s['entity']} | {', '.join(s['pk'])} | {_cell(s['lifecycle'])} |")
    out += ["", "## Relationships and cardinality", "", "| Parent | Child | Cardinality | Key | Optionality |", "|---|---|---|---|---|"]
    out += [f"| {a} | {b} | {c} | `{d}` | {e} |" for a, b, c, d, e in S.RELATIONSHIPS]
    for t, s in S.TABLES.items():
        out += ["", f"## {s['entity']} (`{t}`)", "", s["description"], "",
                f"**Primary key:** `{', '.join(s['pk'])}`" + (f" · **Lifecycle:** {s['lifecycle']}" if s["lifecycle"] else ""), "",
                "| Field | Type | Req. | Allowed values | Units | Unique | FK | Validation rule / description |", "|---|---|---|---|---|---|---|---|"]
        for f in s["fields"]:
            rule = "; ".join(x for x in (f["description"], f["rule"], f"pattern {f['pattern']}" if f["pattern"] else None,
                                         f"min {f['min']}" if f["min"] is not None else None, f"max {f['max']}" if f["max"] is not None else None) if x)
            out.append(f"| `{f['name']}` | {f['type']} | {'yes' if f['required'] else 'no'} | {_cell(f['allowed'])} | {_cell(f['units'])} | "
                       f"{'yes' if f['unique'] else ''} | {_cell(f['fk'])} | {_cell(rule)} |")
    out += ["", "## Ground-truth files (kept separate, never joined into input features)", "",
            "`ground_truth/ground_truth.csv|json` — " + ", ".join(f"`{c}`" for c in S.GROUND_TRUTH_FIELDS), "",
            "`ground_truth/ground_truth_outcomes.csv` — " + ", ".join(f"`{c}`" for c in S.OUTCOME_FIELDS), ""]
    return "\n".join(out)


def erd_md():
    out = ["# Entity-relationship diagram", "", "```mermaid", "erDiagram"]
    rel = {"1:N": "||--o{", "1:0..1": "||--o|", "N:M": "}o--o{", "1:N (self)": "||--o{"}
    for a, b, c, key, opt in S.RELATIONSHIPS:
        ea, eb = a.upper().replace(" ", "_"), b.upper().replace(" ", "_")
        out.append(f'  {ea} {rel.get(c, "||--o{")} {eb} : "{key} ({opt})"')
    for t, s in S.TABLES.items():
        out.append(f"  {t.upper()} {{")
        for f in s["fields"][:8]:
            tag = "PK" if f["name"] in s["pk"] else "FK" if f["fk"] else ""
            out.append(f"    {f['type']} {f['name']} {tag}".rstrip())
        out.append("  }")
    out += ["```", ""]
    return "\n".join(out)


def write_docs(out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "data_dictionary.md").write_text(data_dictionary_md(), encoding="utf-8")
    (out / "erd.md").write_text(erd_md(), encoding="utf-8")
    (out / "schema.sql").write_text("-- DDL generated from generator/schema.py\n" + "\n".join(S.ddl(t) for t in S.LOAD_ORDER) + "\n", encoding="utf-8")
    payload = {"tables": {t: {"entity": s["entity"], "primary_key": s["pk"], "description": s["description"], "lifecycle": s["lifecycle"], "fields": s["fields"]}
                          for t, s in S.TABLES.items()},
               "relationships": [dict(zip(("parent", "child", "cardinality", "key", "optionality"), r)) for r in S.RELATIONSHIPS],
               "ground_truth_fields": S.GROUND_TRUTH_FIELDS, "outcome_fields": S.OUTCOME_FIELDS}
    (out / "data_dictionary.json").write_text(json.dumps(payload, indent=1), encoding="utf-8")


if __name__ == "__main__":
    write_docs(sys.argv[1] if len(sys.argv) > 1 else ROOT / "docs")
    print("docs written")

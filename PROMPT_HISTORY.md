# Prompt history

Complete record of the prompts the author gave the LLM while building this project, in order, **verbatim (typos kept)**, followed by the delegation prompts the
LLM itself wrote for parallel sub-agents. Tool: **Claude Code** (VS Code extension) running **Claude Sonnet 5.5**; at the very start the model was switched to Opus 5.5 and
straight back to Sonnet 5.5 with the `/model` command (no work was done on Opus). Everything was done in a single Claude Code session.

## A. Author prompts

| # | Prompt (verbatim) | What it led to |
|---|---|---|
| 1 | The full problem statement ([`docs/problem_statement.md`](docs/problem_statement.md)) followed by: **"goal : build a complete fullstack working solution with frontend and backend to show end to end workflow with impressive UI based on the problem statement. make sure that every aspect given in the problem should fulfills its requirements."** (sent twice — the first send was interrupted while the LLM was checking installed runtimes) | The whole build: shared rule engine, schema, seeded generator, validator, reproducibility script, SQLite backend + API, SPA frontend, docs |
| 2 | "will this end to end workflow should fulfills the each and every aspect from the problem statement???" | A requirement-by-requirement self-audit; found one thing never tested (the exported `seed.sql`) and verified it loads with zero FK violations; listed the untested UI actions |
| 3 | "check only where it falls short and fixes it make sure everything gonna work properly as mentioned in teh problem statement" | A dependency-free browser test harness (Chrome DevTools protocol), a 110-screen scan, 26 click-through write-path tests; found and fixed three real bugs (see `AI_USAGE.md` §4) and unrealistic campaign budgets; regenerated + re-validated + re-proved reproducibility |
| 4 | "if someone run this project what they need to do??" | Run instructions (`python run.py`) |
| 5 | "push everything into my github by creating new  meaningful repository name and give me the public github repository url here" | Git repo, `.gitignore`/`.gitattributes`, public repo `leadlens-lead-to-opportunity-workflow` |
| 6 | "whatever you ignored file pushing into my github whether it is required or not to run in another system by taking pull of my project in their systems / any any ignored file is required to this project change their name to bypass git ignore and commit those files. / make sure everything is aviable on my public github repository to run this project in different systems" | Instead of renaming files, a fresh `git clone` of the public repo was run end-to-end (checksums, startup, API, validation) to prove nothing ignored is needed |
| 7 | "if i want to share my public github repository of this project which link i should share to pull this project from  my profile into their own systems" | Clone URL and instructions |
| 8 | The submission guidelines ("USE LLMs TRANSPARENTLY … PROMPT HISTORY REQUIRED … MAKE YOUR REASONING VISIBLE …") plus: "have you included this on my github repository … if not make sure this should be added" | This file, [`AI_USAGE.md`](AI_USAGE.md) and [`REASONING.md`](REASONING.md) |

Automated (not typed by the author): two scheduled "check on the agents / reproducibility run" wake-ups that the LLM set for itself while background work ran.

## B. Delegation prompts written by the LLM (parallel sub-agents)

After the shared UI toolkit (`frontend/css/app.css`, `frontend/js/lib.js`, `charts.js`, `app.js`) and two reference pages (Overview, Prospect Portal) existed, the LLM split the
remaining 13 pages across three sub-agents, each given a self-contained brief (the briefs were not saved to disk; their content is summarised here).
Every brief contained the same preamble: the running backend URL, "do not edit backend/core/generator or shared frontend files", pointers to the files to read first
(`lib.js`, `charts.js`, `app.css`, `overview.js`, `server.py`, `analytics.py`, `workflow.py`, `schema.py`), the domain rules, the quality bar (dark+light themes, charts
with legends and hover tooltips, explain the business rule on screen, role-aware actions, verify with headless-Edge screenshots and `node --check`), and a per-page spec.

| Sub-agent | Pages | Notable requirements in the brief |
|---|---|---|
| A | `leads`, `lead` (Lead 360, 8 tabs), `workbench` | server-side filters; score explainability with reproducibility badge and leakage panel; consent-guarded task completion; convert / reassign / rescore / log-activity actions surfacing 409/422 rule messages |
| B | `pipeline`, `scoring`, `evaluation`, `exceptions` | Kanban + stage-history gap flag; what-if simulator, train-only auto-tune, publish rule version; held-out metrics with leakage audit; detector-vs-ground-truth grading and live prevention demos |
| C | `routing`, `consent`, `dedupe`, `campaigns`, `data`, `audit` | coverage matrix and Sales-Ops queue; consent ledger + preference centre; match tiers and recall; dictionary/ERD/validation/reproducibility/SQL/ground-truth tabs; audit trail with before/after |

Each sub-agent returned a short report (files, backend quirks noticed, what it did not verify); the LLM reviewed the screenshots and later ran its own browser tests
(see `tests/`), which found issues the sub-agents had not.

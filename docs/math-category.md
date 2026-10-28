# Mathematics category reset

Reset on 2026-10-28 so textbook storage, the data read by the LLM during tests,
and the test design can be rebuilt from scratch.

The Mathematics card, `/math/*` route, category navigation and English/Japanese/
Korean placeholder remain. The page makes no math API requests and shows that
mathematics tests are unavailable during redesign. Old subject/test links show
that same placeholder.

Removed: textbook JSON/catalogs; all files in the root `prompt/` directory;
chapter/subject schemas; authoring and OCR tools; prerequisite/scope contracts;
LLM generation/validation/grading; test histories, drafts and learning evidence
implementation; math APIs/workers, fixtures, indexes and publication scripts.
Untracked original PDFs are retained. Other study categories and their prompts
under `backend/DB/` are unaffected.

Production cleanup targets only the `math_*` Firestore namespace (including nested
source chunks and snapshots), math LLM feature assignments, and the dedicated
`math` Cloud Tasks queue / `math-reconcile` scheduler. No textbook objects were
found in Cloud Storage: the project has no storage buckets. Deployment and data
deletion are separate operations; redeploying cannot republish the deleted data.

The [original verification](math-verification.md) and
[v2 verification](math-v2-verification.md) records remain historical. Their
commands, links and contracts describe the removed implementation and must not
be used as current operating instructions. No replacement JSON or LLM input
format is defined yet.

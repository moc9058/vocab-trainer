---
name: update-docs
description: Review git changes on the current branch and update CLAUDE.md and README.md to reflect them. Invoke whenever the user asks to "update docs", "update CLAUDE.md", "update README", or "reflect changes in docs". Only edits sections that are stale — never rewrites unrelated content.
---

# Update CLAUDE.md and README.md

Keep both files accurate after code changes. **Surgical edits only** — touch only stale content.

## Workflow

1. **Find what changed**
   ```bash
   git diff main...HEAD --stat
   git diff main...HEAD -- '*.ts' '*.tsx'
   # If on main: git diff HEAD~1 HEAD -- '*.ts' '*.tsx'
   ```

2. **Read current files**, then cross-check each changed area:
   - `backend/scripts/` → CLAUDE.md `Commands > Backend`; README.md `Project Structure`
   - `backend/src/routes/` → CLAUDE.md `Routes` + `Key API Endpoints`; README.md `Backend API Reference`
   - `backend/src/firestore.ts`, `llm.ts`, `types.ts` → CLAUDE.md matching subsection
   - `frontend/src/components/`, `hooks/`, `api/`, `settings/` → CLAUDE.md `Frontend` + README.md `Frontend`
   - Deploy script flags → CLAUDE.md `Commands > Deploy`
   - Firestore collections → CLAUDE.md `Data Storage`

3. **Edit** — add new items, remove deleted ones, update changed props/flags/shapes. Match existing style (bullets in CLAUDE.md, tables/prose in README.md). Don't add marketing copy or speculate about future features.

4. **Verify** — confirm all top-level sections still exist and line counts are plausible:
   ```bash
   wc -l CLAUDE.md README.md
   ```

## Rules

- Read before writing — never edit from memory.
- Both files every time; CLAUDE.md is dev reference, README.md is user-facing.
- Skip: internal refactors with no exported-symbol change, style-only diffs, comment-only edits.

## Response template

```
**Changed files:**
- CLAUDE.md: <what was updated>
- README.md: <what was updated>
**Sections untouched:** <sections verified accurate and left alone>
```

---
name: update-docs
description: Review git changes on the current branch and update CLAUDE.md and README.md to reflect them. Invoke whenever the user asks to "update docs", "update CLAUDE.md", "update README", or "reflect changes in docs". Only edits sections that are stale — never rewrites unrelated content.
---

# Update CLAUDE.md and README.md

Surgical edits only — touch only stale content, skip files that are already accurate.

## Workflow

1. **Find what changed**
   ```bash
   git diff main...HEAD --stat
   git diff main...HEAD -- '*.ts' '*.tsx'
   # If on main: git diff HEAD~1 HEAD -- '*.ts' '*.tsx'
   ```

2. **Read both files**, then map each changed area to affected sections:
   - `backend/scripts/` → CLAUDE.md `Commands > Backend`; README `Project Structure`
   - `backend/src/routes/` → CLAUDE.md `Routes` + `Key API Endpoints`; README `Backend API Reference`
   - `backend/src/firestore.ts`, `llm.ts`, `types.ts` → CLAUDE.md matching subsection
   - `frontend/src/` (components/hooks/api/settings) → CLAUDE.md `Frontend`; README `Frontend`
   - Deploy script flags → CLAUDE.md `Commands > Deploy`
   - Firestore collections → CLAUDE.md `Data Storage`

3. **Decide** — for each file, ask: does any mapped section contain stale, missing, or incorrect information? If no section is stale, **skip that file** and note it in the response.

4. **Edit** — only for files that need changes: add new items, remove deleted ones, update changed props/flags/shapes. Match existing style. No marketing copy or speculation.

## Rules

- Read before writing — never edit from memory.
- Skip internal refactors with no exported-symbol change, style-only diffs, and comment-only edits.

## Response template

```
**CLAUDE.md:** <updated — what changed> | <no changes needed — already accurate>
**README.md:** <updated — what changed> | <no changes needed — already accurate>
```

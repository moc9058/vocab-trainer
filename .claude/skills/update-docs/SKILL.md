---
name: update-docs
description: Review git changes on the current branch and update CLAUDE.md and README.md to reflect them. Invoke whenever the user asks to "update docs", "update CLAUDE.md", "update README", or "reflect changes in docs". Only edits sections that are stale — never rewrites unrelated content.
---

# Update CLAUDE.md and README.md

Keep `CLAUDE.md` and `README.md` in sync with the actual state of the codebase after code changes. Edits must be surgical — touch only the parts that are stale.

## When to run

- User asks to update docs, sync documentation, or reflect code changes.
- After merging or implementing a feature that adds/removes/renames files, components, hooks, API endpoints, CLI scripts, or props.
- Before cutting a release to ensure docs are accurate.

## Workflow

### 1. Identify what changed

```bash
git diff main...HEAD --stat
git diff main...HEAD -- '*.ts' '*.tsx' '*.md' 'CLAUDE.md' 'README.md'
```

If on `main` with no separate branch, compare against the last commit:

```bash
git show --stat HEAD
git diff HEAD~1 HEAD -- '*.ts' '*.tsx'
```

Focus on:
- New or deleted files (especially in `frontend/src/`, `backend/src/`, `backend/scripts/`)
- Changed component props, hook signatures, or API endpoint shapes
- New npm commands or deploy flags
- Renamed or moved files

### 2. Audit CLAUDE.md against the diff

Read the current CLAUDE.md:

```bash
cat CLAUDE.md
```

Check each changed area against the matching section in CLAUDE.md:

| Code area | CLAUDE.md section |
|-----------|-------------------|
| `backend/scripts/` | `## Commands → Backend` |
| `backend/src/routes/` | `### Backend → Routes` |
| `backend/src/firestore.ts`, `llm.ts` | `### Backend → Database / LLM` |
| `backend/src/types.ts` | `### Backend → Types` |
| `frontend/src/components/` | `### Frontend → Components` |
| `frontend/src/hooks/` | `### Frontend → Hooks` |
| `frontend/src/api/` | `### Frontend → API layer` |
| `frontend/src/settings/` | `### Frontend → Settings` |
| Deploy script flags | `## Commands → Deploy` |
| Firestore collections | `### Data Storage` |

### 3. Audit README.md against the diff

Read README.md and cross-check:

| Code area | README.md section |
|-----------|-------------------|
| `frontend/src/` directory structure | `## Project Structure` |
| `backend/scripts/` | `## Project Structure` |
| New API endpoints or changed request/response shapes | `## Backend API Reference` |
| New or changed views/components | `## Frontend → Screens / Views` |
| New or changed API wrapper functions | `## Frontend → API Integration` |

### 4. Edit only stale content

Make the minimum edits needed to make both files accurate. Rules:
- **Do not rewrite** sections that are still correct.
- **Do not add** marketing copy, motivation, or prose not already present in the files.
- **Match the existing style** of each file — bullet lists in CLAUDE.md, tables and prose in README.md.
- For component/hook entries: update prop descriptions, add new props, remove deleted props.
- For script commands: add new flags, remove deleted scripts.
- For API endpoints: update request/response shape descriptions.
- For project structure trees: add new files/directories, remove deleted ones.

### 5. Verify no accidental deletions

After editing, skim both files to confirm:
- All existing top-level sections are still present.
- No paragraph or list entry was accidentally removed.
- File line counts are plausible (CLAUDE.md is typically 200–300 lines; README.md is typically 800–1100 lines).

```bash
wc -l CLAUDE.md README.md
```

## Key rules

1. **Surgical edits only.** Change the minimum to make docs accurate. Do not touch correct content.
2. **Read before writing.** Always read the current file content before editing — never edit from memory.
3. **Match the diff, not guesses.** Only document things that are actually in the changed code. Do not speculate about future features.
4. **Props and signatures matter.** When a component or hook gains/loses/renames a prop, update the corresponding bullet in CLAUDE.md and the table row in README.md.
5. **Both files, every time.** CLAUDE.md is the developer reference; README.md is the user-facing project overview. Both must be updated together.
6. **Do not update version numbers, dates, or deployment URLs** unless they are explicitly part of the code changes.

## What to skip

- Comments inside files that don't affect the public interface.
- Internal refactors that don't change the external shape (e.g., extracting a helper function with no new exported symbol).
- Style-only changes (CSS class renames, formatting).
- Test file changes (there are no test files in this project).

## Response template

After updating, report:

```
**Changed files:**
- CLAUDE.md: <brief description of what was updated>
- README.md: <brief description of what was updated>

**Sections untouched:** <list any major sections you verified were still accurate and left alone>
```

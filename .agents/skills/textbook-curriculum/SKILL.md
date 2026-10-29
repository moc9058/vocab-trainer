---
name: textbook-curriculum
description: Create or refresh source-grounded learning objectives when adding or editing this repository's textbook Markdown, without a separate curriculum request.
---

Read AGENTS.md and [the schema](references/curriculum-schema.md).
Inspect the actual changed chapters, manifest and existing catalog. New sources belong
in lowercase md/. Preserve book, chapter and objective IDs when meaning is unchanged.
For semantic changes allocate a new objective ID and record supersedes; retain retired IDs.

Run `npm run textbook:prepare --prefix backend` to identify missing or changed sources.
Use [the authoring prompt](references/authoring-prompt.md) to author operational English
objectives with exact source sections, observable criteria, allowed task kinds,
prerequisites, external background, constraints and source hashes. Preserve intentional
manual edits and original quotations. Do not infer proof availability from theorem presence.

Update curriculum/learning-objectives.json, then run
`npm run textbook:validate --prefix backend -- --write` to compute revisions and regenerate
the reading views. Run again without --write to verify the result. Review the goals
against the source, including field, units, model assumptions and prerequisite availability.
Report unresolved source ambiguities instead of inventing assumptions.

Validation and preparation are local and never call an LLM. This workflow runs while an
agent handles textbook changes; it is not a watcher. Curriculum authoring does not publish
it. Follow the task's authorized math:sync publication workflow separately from deployment.

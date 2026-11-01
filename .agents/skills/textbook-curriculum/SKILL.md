---
name: textbook-curriculum
description: Create or refresh a textbook curriculum on request or when adding or editing this repository's chapter Markdown, including newly added textbooks.
---

Read AGENTS.md and [the schema](references/curriculum-schema.md).
Inspect the actual changed chapters, manifest and existing catalog. New sources belong
in textbook/<book>/md/, using the same layout for all subjects. This directory
contains only chapter files named <positive number>. <title>.md, with unique numbers
and no nested directories. Keep curriculum, README files, PDFs and images outside md/.
Ignore .DS_Store. Preserve book, chapter and objective IDs when meaning is unchanged.
For semantic changes allocate a new objective ID and record supersedes; retain retired IDs.

Run `npm run textbook:prepare --prefix backend` to discover unregistered textbooks,
new chapters, missing sources and missing or changed curricula. This read-only report
includes source headings and hashes even before a new book is registered.
When asked to create a curriculum, register the new book and all chapter files in
textbook/manifest.json, with stable IDs, language, subject metadata, subjectProfile
and curriculumFile=<book>/curriculum/learning-objectives.json. Reuse existing IDs.
Infer metadata from the actual text when clear; ask only for essential missing facts.
The current subjectProfile supports mathematics, physics and economics; do not label
another subject incorrectly to bypass validation. Report a needed profile extension.
Do not silently rename supplied chapter files or rewrite their contents; report naming
issues or fix them within the user's authorized textbook-preparation task.
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

# Curriculum v2

The maintained TypeScript contract is `backend/src/math-types.ts` (Curriculum and
CurriculumObjective); validation is `backend/src/math-curriculum.ts`.
Each manifest book declares curriculumFile and an explicit subjectProfile with version,
subject (mathematics, physics or economics) and source-specific constraints.

The catalog contains schemaVersion=2, bookId, content-addressed revision,
sourceLanguage, instructionLanguage=en, sources and objectives. Each source records
chapterId, manifest-relative file and SHA-256 of the exact Markdown bytes.
Each objective has a stable ID, chapterId, English statement, ability
(concept/application/reasoning/modeling), supportedTaskKinds (prove/determine/compute/derive),
exact sourceRefs (chapterId, section, heading without Markdown #),
prerequisiteObjectiveIds, requiredBackground, successCriteria (id, criterion),
scopeConstraints, commonErrors and status (active/retired). localizedStatements and
supersedes are optional. An empty requiredBackground means no external prerequisite.
Do not leave unknown background requirements unresolved.

References must exist verbatim. Prerequisites may be in the same or earlier chapters,
with no cycles. Split or retire objectives explicitly instead of reusing an ID for a
different capability. Source hashes enter the catalog revision; source-path case changes
therefore change the publication, while chapter version IDs remain based on content.

## Common source layout

Every subject uses textbook/<book>/md/<positive number>. <title>.md. Only chapter
Markdown files belong in md/, without nested directories; .DS_Store is ignored.
Keep learning-objectives.json and its authored English README in the sibling curriculum/.
All local chapters must be registered before publication. Section numbers identify
headings inside the referenced chapter, not the book's chapter number.

## Authored assessment reference

README.md is an English LLM reference containing assumed knowledge and its limits,
representative exercises, scope and expected evidence. `textbook:validate --write`
copies its exact contents into optional `guidance` (32KB maximum), included in the
catalog revision. Sync rejects disagreement between the README and frozen guidance.
Old catalogs without guidance remain readable. The frozen reference is published
with the catalog and supplied during generation, independent solving, validation
and grading; examples do not expand the selected textbook scope.

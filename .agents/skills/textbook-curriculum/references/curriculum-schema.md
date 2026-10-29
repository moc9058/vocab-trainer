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

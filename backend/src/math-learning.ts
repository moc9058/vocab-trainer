import type { Transaction } from "@google-cloud/firestore";
import type { Assessment, Attempt, Catalog, MathTest } from "./math-types.js";
import { collection, bounded } from "./math-store.js";
/** One receipt per attempt/objective/concept. Corrections replace evidence, never add a second score. */
export function writeLearningEvidence(
  tx: Transaction,
  test: MathTest,
  attempt: Attempt,
  catalog: Catalog,
) {
  const evidence = attempt.assessment?.objectiveEvidence ?? [];
  const objectiveIds = new Set(
    [...evidence, ...attempt.history.flatMap((a) => a.objectiveEvidence)].map(
      (e) => e.objectiveId,
    ),
  );
  for (const objectiveId of objectiveIds) {
    const objective = catalog.objectives.find((o) => o.id === objectiveId);
    if (!objective) continue;
    for (const ref of objective.assessedCapabilities) {
      const concept = catalog.concepts.find((c) => c.id === ref.conceptId);
      if (!concept) continue;
      const current = evidence.find((e) => e.objectiveId === objectiveId);
      tx.set(
        collection("learning_states")
          .doc(concept.id)
          .collection("evidence")
          .doc(`${attempt.id}-${objectiveId}`),
        bounded({
          testId: test.id,
          attemptId: attempt.id,
          questionId: attempt.questionId,
          objectiveId,
          capability: ref.capability,
          conceptRevisionId: concept.revisionId,
          catalogId: test.catalogId,
          demonstrated: current?.demonstrated ?? false,
          unassisted: !attempt.assistanceUsed,
          gradeSource: attempt.assessment?.gradeSource ?? null,
          gradeVersion: attempt.gradeVersion,
          valid:
            test.purpose !== "verification" &&
            !!current &&
            !test.invalidQuestionIds.includes(attempt.questionId),
          difficulty: test.config.difficulty,
          updatedAt: Date.now(),
        }),
      );
    }
  }
}

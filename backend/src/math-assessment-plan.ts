import { mathHash } from "./math-core.js";
import type {
  AssessmentPlan,
  Curriculum,
  MathTest,
  ObjectiveProgress,
  TaskKind,
} from "./math-types.js";
export const taskWeights: Record<TaskKind, number> = {
  prove: 40,
  determine: 25,
  compute: 20,
  derive: 15,
};
export function selectAssessmentPlan(
  test: MathTest,
  curriculum: Curriculum,
  evidence: ObjectiveProgress[],
  seed: string,
  excluded: string[] = [],
): AssessmentPlan {
  let step = 0;
  const random = () =>
    parseInt(mathHash(`${seed}:${step++}`).slice(0, 8), 16) / 0x100000000;
  const number = (test.generatedCount ?? 0) + 1;
  const allowedChapters = new Set(
    test.book.chapters
      .filter((c) => test.sourceVersionIds.includes(c.versionId))
      .map((c) => c.id),
  );
  let candidates = curriculum.objectives.filter(
    (o) =>
      o.status === "active" &&
      test.chapterIds.includes(o.chapterId) &&
      !excluded.includes(o.id) &&
      o.supportedTaskKinds.some((k) => test.taskKinds!.includes(k)) &&
      o.prerequisiteObjectiveIds.every((id) =>
        allowedChapters.has(
          curriculum.objectives.find((o) => o.id === id)!.chapterId,
        ),
      ),
  );
  if (!candidates.length)
    throw Object.assign(new Error("MATH_NO_FEASIBLE_OBJECTIVE"), {
      statusCode: 422,
    });
  const progress = (id: string) => evidence.find((e) => e.objectiveId === id);
  const chapterCount = (chapterId: string) =>
    evidence
      .filter((e) =>
        curriculum.objectives.some(
          (o) => o.id === e.objectiveId && o.chapterId === chapterId,
        ),
      )
      .reduce((n, e) => n + e.presented, 0);
  const cooled = candidates.filter((o) => {
    const e = progress(o.id);
    return (
      !e ||
      !["partial", "incorrect"].includes(e.lastVerdict ?? "") ||
      e.lastTestId !== test.id ||
      number - (e.lastNumber ?? 0) > 3
    );
  });
  if (cooled.length) candidates = cooled;
  else if (candidates.length > 1)
    throw Object.assign(new Error("MATH_NO_FEASIBLE_OBJECTIVE"), {
      statusCode: 422,
    });
  const min = Math.min(...candidates.map((o) => chapterCount(o.chapterId)));
  let balanced = candidates.filter((o) => chapterCount(o.chapterId) === min);
  const notRecent = balanced.filter((o) => {
    const e = progress(o.id);
    return !e || e.lastTestId !== test.id || (e.lastNumber ?? 0) < number - 1;
  });
  if (notRecent.length) balanced = notRecent;
  const pools = {
    unseen: balanced.filter((o) => !progress(o.id)?.presented),
    review: balanced.filter((o) => {
      const e = progress(o.id);
      return (
        e &&
        ["partial", "incorrect"].includes(e.lastVerdict ?? "") &&
        (e.lastTestId !== test.id || number - (e.lastNumber ?? 0) > 3)
      );
    }),
    practice: balanced.filter((o) => {
      const e = progress(o.id);
      return (
        !!e?.presented &&
        !["partial", "incorrect"].includes(e.lastVerdict ?? "")
      );
    }),
  };
  // A single-objective scope may practice a distinct question during review cooldown.
  if (!pools.unseen.length && !pools.review.length && !pools.practice.length)
    pools.practice = balanced;
  const weights = { unseen: 50, review: 30, practice: 20 };
  const slots = (Object.keys(pools) as (keyof typeof pools)[]).filter(
    (k) => pools[k].length,
  );
  let roll = random() * slots.reduce((n, k) => n + weights[k], 0);
  const slot = slots.find((k) => (roll -= weights[k]) < 0) ?? slots.at(-1)!;
  const objective = pools[slot][Math.floor(random() * pools[slot].length)];
  const kinds = objective.supportedTaskKinds.filter((k) =>
    test.taskKinds!.includes(k),
  );
  let draw = random() * kinds.reduce((n, k) => n + taskWeights[k], 0);
  const taskKind =
    kinds.find((k) => (draw -= taskWeights[k]) < 0) ?? kinds.at(-1)!;
  return {
    primaryObjectiveId: objective.id,
    chapterId: objective.chapterId,
    taskKind,
    seed,
    slot,
  };
}

import { mathText, sourceHeadings } from "./math-core.js";
import type {
  Curriculum,
  MathTest,
  MathSource,
  MathQuestion,
  MathGrade,
} from "./math-types.js";
export function sourceReferenceCatalog(sources: MathSource[]) {
  return sources.flatMap((s) =>
    sourceHeadings(s.markdown).map((heading, i) => ({
      id: `${s.id}-h${i + 1}`,
      chapterId: s.id,
      heading,
    })),
  );
}
export function validateAssessmentQuestions(
  raw: unknown,
  test: MathTest,
  sources: MathSource[],
  curriculum: Curriculum,
): MathQuestion[] {
  const value = raw as {
    questions: (MathQuestion & { sourceRefIds?: string[] })[];
  };
  const fail = (code: string): never => {
    throw Object.assign(new Error("INVALID_OUTPUT"), {
      repairCode: code,
      repair: `Correct the ${code} contract. Use the exact planned IDs, source headings and answer modes; supporting objectives must be allowed prerequisites.`,
    });
  };
  if (
    !value ||
    !Array.isArray(value.questions) ||
    value.questions.length !== test.pendingPlans?.length ||
    Buffer.byteLength(JSON.stringify(value)) > 80000
  )
    return fail("question_count_or_size");
  const prompts = new Set<string>();
  return value.questions.map((q, i) => {
    const plan = test.pendingPlans![i],
      objective = curriculum.objectives.find(
        (o) => o.id === plan.primaryObjectiveId,
      )!;
    if (
      !q ||
      q.chapterId !== plan.chapterId ||
      q.primaryObjectiveId !== plan.primaryObjectiveId ||
      q.taskKind !== plan.taskKind ||
      q.ability !== objective.ability ||
      q.responseFormat !== "written" ||
      !mathText(q.prompt, 8000) ||
      !mathText(q.solution, 12000) ||
      prompts.has(q.prompt.trim())
    )
      return fail("planned_identity_or_text");
    prompts.add(q.prompt.trim());
    const permitted = new Set<string>();
    const collect = (id: string) => {
      if (permitted.has(id)) return;
      permitted.add(id);
      curriculum.objectives
        .find((o) => o.id === id)
        ?.prerequisiteObjectiveIds.forEach(collect);
    };
    objective.prerequisiteObjectiveIds.forEach(collect);
    if (
      !Array.isArray(q.supportingObjectiveIds) ||
      new Set(q.supportingObjectiveIds).size !==
        q.supportingObjectiveIds.length ||
      q.supportingObjectiveIds.some((id) => !permitted.has(id))
    )
      return fail("supporting_objectives");
    if (q.sourceRefIds !== undefined) {
      const refs = sourceReferenceCatalog(sources);
      if (
        !Array.isArray(q.sourceRefIds) ||
        !q.sourceRefIds.length ||
        q.sourceRefIds.length > 20 ||
        new Set(q.sourceRefIds).size !== q.sourceRefIds.length ||
        q.sourceRefIds.some((id) => !refs.some((r) => r.id === id))
      )
        return fail("source_reference_ids");
      q = {
        ...q,
        sourceRefs: q.sourceRefIds.map((id) => {
          const { chapterId, heading } = refs.find((r) => r.id === id)!;
          return { chapterId, heading };
        }),
      };
    }
    if (
      !Array.isArray(q.sourceRefs) ||
      !q.sourceRefs.length ||
      !q.sourceRefs.some((r) => r.chapterId === plan.chapterId) ||
      q.sourceRefs.some(
        (r) =>
          !sources.some(
            (s) =>
              s.id === r.chapterId &&
              sourceHeadings(s.markdown).includes(r.heading),
          ),
      )
    )
      return fail("source_references");
    if (
      !Array.isArray(q.rubricItems) ||
      !q.rubricItems.length ||
      q.rubricItems.length > 20 ||
      new Set(q.rubricItems.map((r) => r.id)).size !== q.rubricItems.length ||
      q.rubricItems.some(
        (r) =>
          !mathText(r.id, 100) ||
          !mathText(r.criterion, 4000) ||
          !Number.isFinite(r.weight) ||
          r.weight <= 0,
      )
    )
      return fail("rubric_items");
    const spec = q.answerSpec;
    if (
      !spec ||
      !["proof", "decision", "exact", "approximate", "expression"].includes(
        spec.mode,
      ) ||
      !mathText(spec.domain, 2000) ||
      (q.taskKind === "prove" && spec.mode !== "proof") ||
      (q.taskKind === "determine" && spec.mode !== "decision") ||
      (q.taskKind === "derive" && spec.mode !== "expression")
    )
      return fail("answer_mode_or_domain");
    if (spec.units !== undefined && !mathText(spec.units, 200))
      return fail("units");
    if (
      (spec.mode === "approximate" || spec.tolerance !== undefined) &&
      (!spec.tolerance ||
        !Object.values(spec.tolerance).length ||
        Object.entries(spec.tolerance).some(
          ([k, v]) =>
            !["absolute", "relative"].includes(k) ||
            !Number.isFinite(v) ||
            v < 0,
        ))
    )
      return fail("tolerance");
    if (
      !q.demandProfile ||
      ["methodChoice", "transfer", "scaffolding", "synthesis"].some(
        (k) => !mathText(q.demandProfile![k], 2000),
      )
    )
      return fail("demand_profile");
    const total = q.rubricItems.reduce((n, r) => n + r.weight, 0);
    if (!Number.isFinite(total)) return fail("rubric_weight_total");
    return {
      id: `q${i + 1}`,
      schemaVersion: 2,
      chapterId: q.chapterId,
      primaryObjectiveId: objective.id,
      objectiveStatement: objective.statement,
      supportingObjectiveIds: q.supportingObjectiveIds,
      publicationId: test.publicationId!,
      curriculumRevision: test.curriculumRevision!,
      difficulty: test.difficulty,
      difficultyPolicyVersion: test.difficultyPolicyVersion!,
      promptVersion: test.promptVersion!,
      taskKind: plan.taskKind,
      ability: objective.ability,
      responseFormat: "written",
      prompt: q.prompt,
      solution: q.solution,
      sourceRefs: q.sourceRefs.map(({ chapterId, heading }) => ({
        chapterId,
        heading,
      })),
      heading: q.sourceRefs.find((r) => r.chapterId === q.chapterId)!.heading,
      kind:
        plan.taskKind === "prove"
          ? "proof"
          : plan.taskKind === "determine"
            ? "definition"
            : "calculation",
      rubric: q.rubricItems.map((r) => r.criterion).join("\n"),
      rubricItems: q.rubricItems.map(({ id, criterion, weight }) => ({
        id,
        criterion,
        weight: weight / total,
      })),
      answerSpec: {
        mode: spec.mode,
        domain: spec.domain,
        ...(spec.units ? { units: spec.units } : {}),
        ...(spec.tolerance ? { tolerance: spec.tolerance } : {}),
      },
      demandProfile: Object.fromEntries(
        ["methodChoice", "transfer", "scaffolding", "synthesis"].map((k) => [
          k,
          q.demandProfile![k],
        ]),
      ),
      assistanceStatus:
        test.assistanceReporting === false ? "unknown" : "notReported",
    };
  });
}
export function validateAssessmentGrade(
  raw: unknown,
  q: MathQuestion,
): MathGrade {
  const g = raw as { items: NonNullable<MathGrade["items"]>; feedback: string };
  if (
    !g ||
    !Array.isArray(g.items) ||
    g.items.length !== q.rubricItems!.length ||
    new Set(g.items.map((i) => i.id)).size !== g.items.length ||
    !mathText(g.feedback, 12000) ||
    g.items.some(
      (i) =>
        !q.rubricItems!.some((r) => r.id === i.id) ||
        !["met", "partial", "unmet"].includes(i.status) ||
        typeof i.evidence !== "string" ||
        Buffer.byteLength(i.evidence) > 8000 ||
        !mathText(i.feedback, 4000),
    )
  )
    throw new Error("INVALID_GRADE");
  const fraction = { met: 1, partial: 0.5, unmet: 0 };
  const score = q.rubricItems!.reduce(
    (n, r) =>
      n + r.weight * fraction[g.items.find((i) => i.id === r.id)!.status],
    0,
  );
  return {
    verdict: g.items.every((i) => i.status === "met")
      ? "correct"
      : g.items.every((i) => i.status === "unmet")
        ? "incorrect"
        : "partial",
    score,
    feedback: g.feedback,
    items: g.items.map(({ id, status, evidence, feedback }) => ({
      id,
      status,
      evidence,
      feedback,
    })),
  };
}

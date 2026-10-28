import type {
  CapabilityRef,
  Catalog,
  FoundationProfile,
  Objective,
  Scope,
  ScopePreview,
  ScopeRequest,
} from "./math-types.js";
import {
  contentHash,
  invariant,
  MATH_LIMITS,
  scopeRequestSchema,
  scopeRequestV2Schema,
} from "./math-schema.js";
import { refKey, resolveDependencies, uniqueRefs } from "./math-graph.js";
/** Consent is bound to semantic concept revisions, not just stable capability IDs. */
export function foundationAcceptanceHash(
  catalog: Catalog,
  profile: FoundationProfile,
): string {
  return contentHash({
    revision: profile.revision,
    capabilities: profile.acceptedCapabilities
      .map((ref) => {
        const concept = catalog.concepts.find((c) => c.id === ref.conceptId);
        invariant(
          concept?.capabilities[ref.capability],
          "MATH_PROFILE_INVALID",
          503,
        );
        return { ...ref, revisionId: concept.revisionId };
      })
      .sort((a, b) => refKey(a).localeCompare(refKey(b))),
  });
}
export function resolveScope(
  input: ScopeRequest,
  catalog: Catalog,
  acceptedProfiles: Record<string, string> = {},
): Scope {
  const request = scopeRequestSchema.parse(input);
  for (const values of [
    request.selectedNodeIds,
    request.excludedConceptIds,
    request.excludedObjectiveIds,
    request.profileIds,
    request.objectiveCapabilities,
    request.answerFormats,
  ])
    invariant(
      new Set(values).size === values.length,
      "MATH_DUPLICATE_SELECTION",
    );
  invariant(
    request.excludedConceptIds.every((id) =>
      catalog.concepts.some(
        (c) => c.id === id && c.subjectId === request.subjectId,
      ),
    ),
    "MATH_CONCEPT_NOT_FOUND",
    404,
  );
  invariant(
    request.excludedObjectiveIds.every((id) =>
      catalog.objectives.some((o) => o.id === id),
    ),
    "MATH_OBJECTIVE_NOT_FOUND",
    404,
  );
  invariant(
    catalog.subjects.some((s) => s.id === request.subjectId),
    "MATH_SUBJECT_NOT_FOUND",
    404,
  );
  const selected = new Set(request.selectedNodeIds);
  for (const id of selected)
    invariant(
      catalog.nodes.some(
        (n) => n.id === id && n.subjectId === request.subjectId,
      ),
      "MATH_NODE_NOT_FOUND",
      404,
    );
  const units = new Set(
    catalog.nodes
      .filter(
        (n) =>
          n.subjectId === request.subjectId &&
          (selected.has(n.id) || n.ancestorIds.some((id) => selected.has(id))),
      )
      .flatMap((n) => n.unitIds),
  );
  const excludedConcepts = new Set(request.excludedConceptIds);
  const chosenProfiles = request.profileIds.map((id) => {
    const p = catalog.profiles.find((p) => p.id === id);
    invariant(
      p &&
        catalog.subjects
          .find((s) => s.id === request.subjectId)
          ?.foundationProfileIds.includes(id),
      "MATH_PROFILE_NOT_FOUND",
      404,
    );
    return p;
  });
  const baselineSeeds = uniqueRefs(
    chosenProfiles.flatMap((p) => p.acceptedCapabilities),
  );
  const baselineClosure = resolveDependencies(
    catalog,
    baselineSeeds,
    [],
    new Set(baselineSeeds.map(refKey)),
  );
  let objectives = catalog.objectives.filter(
    (o) =>
      units.has(o.unitId) &&
      o.readiness === "ready" &&
      !request.excludedObjectiveIds.includes(o.id) &&
      !o.assessedCapabilities.some((r) => excludedConcepts.has(r.conceptId)) &&
      o.assessedCapabilities.every((r) =>
        request.objectiveCapabilities.includes(r.capability),
      ),
  );
  invariant(
    objectives.length <= MATH_LIMITS.objectives,
    "MATH_SCOPE_TOO_LARGE",
    413,
  );
  const excluded: Scope["excluded"] = [];
  const eligible = (o: Objective) => {
    if (
      request.difficulty < o.difficultyRange[0] ||
      request.difficulty > o.difficultyRange[1]
    ) {
      excluded.push({
        objectiveId: o.id,
        reason: "MATH_DIFFICULTY_UNAVAILABLE",
        missing: [],
      });
      return false;
    }
    if (
      o.assessedCapabilities.some((r) => r.capability === "prove") &&
      (o.proofSupport.coverage === "none" ||
        (o.proofRequirement === "complete" &&
          o.proofSupport.coverage !== "complete"))
    ) {
      excluded.push({
        objectiveId: o.id,
        reason: "MATH_PROOF_UNSUPPORTED",
        missing: [],
      });
      return false;
    }
    return true;
  };
  objectives = objectives.filter(eligible);
  // Recompute after each removal; an excluded target cannot grant a prerequisite permission.
  let targets: CapabilityRef[] = [],
    resolved = baselineClosure;
  while (true) {
    targets = uniqueRefs(objectives.flatMap((o) => o.assessedCapabilities));
    const known = new Set([...targets, ...baselineSeeds].map(refKey));
    resolved = resolveDependencies(
      catalog,
      [...targets, ...baselineSeeds],
      objectives.map((o) => ({
        owner: o.id,
        dependencies: o.additionalPrerequisites,
      })),
      known,
      {
        provided: request.mode === "provided",
        mustEstablish: new Set(
          targets.filter((r) => r.capability === "prove").map(refKey),
        ),
      },
    );
    let changed = false;
    objectives = objectives.filter((o) => {
      const own = resolveDependencies(
        catalog,
        o.assessedCapabilities,
        [{ owner: o.id, dependencies: o.additionalPrerequisites }],
        known,
        {
          provided: request.mode === "provided",
          mustEstablish: new Set(
            o.assessedCapabilities
              .filter((r) => r.capability === "prove")
              .map(refKey),
          ),
        },
      );
      const missing = own.refs.filter(
        (r) =>
          !known.has(refKey(r)) &&
          !own.givens.some((g) => refKey(g) === refKey(r)),
      );
      const blocked = own.refs.filter((r) => excludedConcepts.has(r.conceptId));
      if (
        blocked.length ||
        ((request.mode === "strict" || request.mode === "provided") &&
          missing.length)
      ) {
        excluded.push({
          objectiveId: o.id,
          reason: "MATH_PREREQUISITES_MISSING",
          missing: blocked.length ? blocked : missing,
        });
        changed = true;
        return false;
      }
      return true;
    });
    if (!changed) break;
  }
  invariant(
    resolved.refs.length <= MATH_LIMITS.capabilities,
    "MATH_SCOPE_TOO_LARGE",
    413,
  );
  const targetKeys = new Set(targets.map(refKey)),
    baselineKeys = new Set(baselineSeeds.map(refKey)),
    givenKeys = new Set(resolved.givens.map(refKey));
  const prerequisites = resolved.refs.filter(
    (r) =>
      !targetKeys.has(refKey(r)) &&
      !baselineKeys.has(refKey(r)) &&
      !givenKeys.has(refKey(r)),
  );
  const acceptedBaseline = new Set(
    chosenProfiles
      .filter(
        (p) => acceptedProfiles[p.id] === foundationAcceptanceHash(catalog, p),
      )
      .flatMap((p) => p.acceptedCapabilities)
      .map(refKey),
  );
  const requiredAcceptance = [
    ...new Set([
      ...prerequisites.map((r) => `prerequisite:${refKey(r)}`),
      ...resolved.givens.map((r) => `given:${refKey(r)}`),
      ...baselineSeeds
        .filter((r) => !acceptedBaseline.has(refKey(r)))
        .map((r) => `baseline:${refKey(r)}`),
    ]),
  ].sort();
  const plans: Scope["plans"] = [];
  for (let i = 0; objectives.length && i < request.questionCount; i++) {
    const primary = objectives[i % objectives.length];
    const candidates =
      request.difficulty >= 3
        ? objectives
            .filter(
              (o) =>
                o.id !== primary.id &&
                Math.floor(i / objectives.length) % 2 === 1,
            )
            .slice(0, Math.min(request.difficulty - 2, 3))
        : [];
    const planned = [primary, ...candidates];
    const mustEstablish = uniqueRefs(
      planned.flatMap((o) =>
        o.assessedCapabilities.filter((r) => r.capability === "prove"),
      ),
    );
    const allowed = uniqueRefs([...targets, ...resolved.refs]);
    const proof = mustEstablish.length > 0;
    const formats = request.answerFormats.filter((f) =>
      proof ? f === "proof" : f !== "proof",
    );
    invariant(formats.length, "MATH_FORMAT_UNAVAILABLE", 422);
    plans.push({
      id: `plan-${i + 1}`,
      seed: contentHash({ catalogId: catalog.id, request, ordinal: i }),
      targetObjectiveIds: planned.map((o) => o.id),
      allowedCapabilities: allowed,
      providedCapabilities: resolved.givens,
      mustEstablish,
      mayAssume: allowed.filter(
        (r) => !mustEstablish.some((p) => p.conceptId === r.conceptId),
      ),
      difficulty: request.difficulty,
      answerFormat: formats[i % formats.length],
    });
  }
  return {
    catalogId: catalog.id,
    request,
    targetObjectiveIds: objectives.map((o) => o.id),
    targets,
    prerequisites,
    baseline: baselineSeeds,
    givens: resolved.givens,
    requiredAcceptance,
    branches: resolved.branches,
    excluded,
    paths: resolved.paths,
    plans,
    coverage: objectives.map((o) => ({
      objectiveId: o.id,
      plannedQuestions: plans.filter((p) => p.targetObjectiveIds.includes(o.id))
        .length,
    })),
  };
}
export function makePreview(
  scope: Scope,
  id: string,
  now = Date.now(),
): ScopePreview {
  return {
    ...scope,
    id,
    scopeHash: contentHash(scope),
    expiresAt: now + 30 * 60_000,
  };
}

/** V2 fixes targets independently of the server-owned chapter prerequisite DAG. */
export function resolveScopeV2(
  input: import("./math-types.js").ScopeRequestV2,
  catalog: Catalog,
): Scope {
  const request = scopeRequestV2Schema.parse(input);
  const legacy = {
    subjectId: request.subjectId,
    selectedNodeIds: request.selectedNodeIds,
    excludedConceptIds: [],
    excludedObjectiveIds: [],
    objectiveCapabilities: ["recognize", "apply", "prove"] as const,
    mode: "prerequisites" as const,
    profileIds: [],
    difficulty: request.difficulty,
    questionCount: 1,
    responseLanguage: request.responseLanguage,
    answerFormats: ["text", "proof"] as const,
  };
  const scope = resolveScope(legacy as unknown as ScopeRequest, catalog);
  const chapterIds = new Set(
    scope.targets
      .map((r) => catalog.conceptChapterIds?.[r.conceptId])
      .filter((v): v is string => !!v),
  );
  const required = new Set<string>();
  const visit = (id: string, stack = new Set<string>()) => {
    invariant(!stack.has(id), "MATH_CHAPTER_DEPENDENCY_CYCLE");
    for (const dep of catalog.chapterDependencies?.[id] ?? []) {
      invariant(
        catalog.nodes.some(
          (n) => n.id === dep && n.subjectId === request.subjectId,
        ),
        "MATH_CHAPTER_NOT_FOUND",
      );
      invariant(!stack.has(dep) && dep !== id, "MATH_CHAPTER_DEPENDENCY_CYCLE");
      if (!required.has(dep)) {
        required.add(dep);
        visit(dep, new Set([...stack, id]));
      }
    }
  };
  for (const id of chapterIds) visit(id);
  const chapterRefs = catalog.concepts
    .filter(
      (c) =>
        c.subjectId === request.subjectId &&
        required.has(catalog.conceptChapterIds?.[c.id] ?? ""),
    )
    .flatMap((c) =>
      (["recognize", "apply"] as const)
        .filter((cap) => !!c.capabilities[cap])
        .map((capability) => ({ conceptId: c.id, capability })),
    );
  const foundations = (catalog.foundationRefs ?? []).map((ref) => {
    const concept = catalog.concepts.find((c) => c.id === ref.conceptId);
    invariant(
      concept?.revisionId === ref.revisionId &&
        concept.capabilities[ref.capability],
      "MATH_FOUNDATION_REVISION_MISMATCH",
    );
    return { conceptId: ref.conceptId, capability: ref.capability };
  });
  return {
    ...scope,
    schemaVersion: 2,
    curriculumHash: catalog.curriculumHash ?? catalog.id,
    prerequisiteChapterIds: [...required].sort(),
    request: {
      ...scope.request,
      schemaVersion: 2,
      questionLimit: request.questionCount ?? null,
    },
    prerequisites: uniqueRefs([...scope.prerequisites, ...chapterRefs]),
    baseline: foundations,
    requiredAcceptance: [],
    plans: [],
    coverage: scope.coverage.map((c) => ({ ...c, plannedQuestions: 0 })),
  };
}

/** Each immutable plan includes only the objective's required source context. */
export function planNextQuestion(
  scope: Scope,
  catalog: Catalog,
  ordinal: number,
  counts: Record<string, number> = {},
): import("./math-types.js").QuestionPlan {
  const objectiveIds = [...scope.targetObjectiveIds].sort(
    (a, b) =>
      (counts[a] ?? 0) - (counts[b] ?? 0) ||
      contentHash({ seed: scope.curriculumHash, ordinal, id: a }).localeCompare(
        contentHash({ seed: scope.curriculumHash, ordinal, id: b }),
      ),
  );
  const objective = catalog.objectives.find((o) => o.id === objectiveIds[0]);
  invariant(objective, "MATH_SCOPE_BLOCKED", 422);
  const refs = resolveDependencies(
    catalog,
    objective.assessedCapabilities,
    [{ owner: objective.id, dependencies: objective.additionalPrerequisites }],
    new Set(objective.assessedCapabilities.map(refKey)),
  );
  const mustEstablish = objective.assessedCapabilities.filter(
    (r) => r.capability === "prove",
  );
  const allowed = uniqueRefs([...objective.assessedCapabilities, ...refs.refs]);
  return {
    id: `plan-${ordinal}`,
    seed: contentHash({ catalogId: scope.catalogId, scope, ordinal }),
    targetObjectiveIds: [objective.id],
    allowedCapabilities: allowed,
    providedCapabilities: [],
    mustEstablish,
    mayAssume: allowed.filter(
      (r) => !mustEstablish.some((p) => p.conceptId === r.conceptId),
    ),
    difficulty: scope.request.difficulty,
    answerFormat: mustEstablish.length ? "proof" : "text",
  };
}

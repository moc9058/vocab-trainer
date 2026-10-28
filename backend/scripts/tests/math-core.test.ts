import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  linearAlgebraFixture,
  request,
  validCandidate,
} from "./math-fixtures.js";
import {
  buildCatalog,
  compileUnit,
  parseUnit,
  parseYaml,
  validateMathMarkdown,
  safePath,
} from "../../src/math-content.js";
import { validateGraph, resolveDependencies } from "../../src/math-graph.js";
import {
  resolveScope,
  makePreview,
  foundationAcceptanceHash,
} from "../../src/math-scope.js";
import {
  jsonSchema,
  contentHash,
  MathError,
  MATH_LIMITS,
} from "../../src/math-schema.js";
import {
  contextPack,
  gradeAttempt,
  generationResultSchema,
  validateCandidate,
  solveIndependently,
  compareSolutions,
  validateAssessment,
} from "../../src/math-generation.js";
import {
  importAuthorPackage,
  reviewAuthorRun,
  acceptAuthorRun,
} from "../../src/math-authoring.js";
import { newSitting, completeIfExhausted } from "../../src/math-operations.js";
const fixture = await linearAlgebraFixture();
test("Linear Algebra scope separates selected target from only necessary earlier definitions", () => {
  const scope = resolveScope(request(), fixture.catalog);
  assert.deepEqual(scope.targetObjectiveIds, ["apply-subspace-test"]);
  assert.deepEqual(
    scope.prerequisites.map((r) => r.conceptId),
    ["subspace", "vector-space"],
  );
  assert.equal(scope.requiredAcceptance.length, 2);
  assert.equal(scope.baseline.length, 0);
  assert.equal(
    resolveScope({ ...request(), mode: "strict" }, fixture.catalog).plans
      .length,
    0,
  );
  assert.equal(
    resolveScope(
      { ...request(), selectedNodeIds: ["chapter-1", "section-subspaces"] },
      fixture.catalog,
    ).targetObjectiveIds.length,
    1,
  );
});
test("hash is stable across key order; snapshots change with scope or release", () => {
  assert.equal(contentHash({ z: 1, a: 2 }), contentHash({ a: 2, z: 1 }));
  const scope = resolveScope(request(), fixture.catalog);
  assert.notEqual(
    makePreview(scope, "a").scopeHash,
    makePreview({ ...scope, request: { ...scope.request, difficulty: 3 } }, "a")
      .scopeHash,
  );
});
test("capabilities are separate, required edges form a DAG, recommended edges do not authorize", () => {
  const c = structuredClone(fixture.catalog);
  c.concepts.find((c) => c.id === "vector-space")!.recommended = [
    { conceptId: "subspace-test", capability: "apply" },
  ];
  validateGraph(c);
  c.concepts.find(
    (c) => c.id === "vector-space",
  )!.capabilities.apply!.prerequisites.allOf = [
    { conceptId: "subspace-test", capability: "apply" },
  ];
  assert.throws(() => validateGraph(c), /E_DEPENDENCY_CYCLE/);
  c.concepts[0].capabilities.apply!.prerequisites.allOf = [
    { conceptId: "missing", capability: "apply" },
  ];
  assert.throws(() => validateGraph(c), /E_UNKNOWN_PREREQUISITE/);
});
test("OR alternatives choose confirmed closure deterministically and enforce bounded search", () => {
  const c = structuredClone(fixture.catalog),
    target = c.concepts.find((c) => c.id === "subspace-test")!;
  target.capabilities.apply!.prerequisites = {
    allOf: [],
    anyOf: [
      {
        id: "first",
        priority: 0,
        requires: [{ conceptId: "subspace", capability: "recognize" }],
      },
      {
        id: "known",
        priority: 3,
        requires: [{ conceptId: "vector-space", capability: "recognize" }],
      },
    ],
  };
  const resolved = resolveDependencies(
    c,
    [{ conceptId: target.id, capability: "apply" }],
    [],
    new Set(["vector-space:recognize"]),
  );
  assert.equal(resolved.branches[0].alternativeId, "known");
  assert(!resolved.refs.some((r) => r.conceptId === "subspace"));
});
test("provided mode gives only explicitly provideable knowledge, never target answer", () => {
  const scope = resolveScope(
    { ...request(), mode: "provided" },
    fixture.catalog,
  );
  assert(scope.givens.some((r) => r.conceptId === "subspace"));
  assert(!scope.givens.some((r) => r.conceptId === "subspace-test"));
  assert.equal(scope.plans.length, 1);
  const candidate = validCandidate(fixture.catalog, scope, scope.plans[0]);
  assert.throws(
    () => validateCandidate(candidate, fixture.catalog, scope, scope.plans[0]),
    /MATH_GIVEN_MISSING|MATH_OUTSIDE_SCOPE/,
  );
});
test("proof support and blocked source concepts cannot be inferred from another objective", () => {
  const c = structuredClone(fixture.catalog);
  c.objectives[0].assessedCapabilities = [
    { conceptId: "subspace-test", capability: "prove" },
  ];
  c.concepts.find((c) => c.id === "subspace-test")!.capabilities.prove = {
    prerequisites: { allOf: [], anyOf: [] },
  };
  assert.equal(
    resolveScope({ ...request(), objectiveCapabilities: ["prove"] }, c).plans
      .length,
    0,
  );
  c.objectives[0].assessedCapabilities = [
    { conceptId: "subspace-test", capability: "apply" },
  ];
  c.concepts.find((c) => c.id === "subspace")!.readiness = "blocked";
  assert.throws(() => resolveScope(request(), c), /MATH_CONCEPT_NOT_READY/);
});
test("candidate rejects outside methods, invented citations, missing conditions and rubric errors", () => {
  const scope = resolveScope(request(), fixture.catalog),
    plan = scope.plans[0],
    valid = validCandidate(fixture.catalog, scope, plan);
  validateCandidate(valid, fixture.catalog, scope, plan);
  const outside = structuredClone(valid);
  outside.solution.steps[0].uses.push({
    conceptId: "eigenvalue",
    capability: "apply",
  });
  assert.throws(
    () => validateCandidate(outside, fixture.catalog, scope, plan),
    /MATH_OUTSIDE_SCOPE/,
  );
  const citation = structuredClone(valid);
  citation.solution.steps[0].citationIds.push("invented");
  assert.throws(
    () => validateCandidate(citation, fixture.catalog, scope, plan),
    /MATH_INVALID_CITATION/,
  );
  const rubric = structuredClone(valid);
  rubric.rubric[0].points = 50;
  assert.throws(
    () => validateCandidate(rubric, fixture.catalog, scope, plan),
    /MATH_INVALID_RUBRIC/,
  );
});
test("independent solver does not see generator answer and bad known fixtures fail gates", async () => {
  const scope = resolveScope(request(), fixture.catalog),
    plan = scope.plans[0],
    candidate = validCandidate(fixture.catalog, scope, plan);
  await assert.rejects(
    () =>
      solveIndependently(
        async (_f, _s, input) => {
          assert(!JSON.stringify(input).includes("strategyMarkdown"));
          return {
            answerMarkdown: "wrong",
            usedCapabilities: [
              { conceptId: "eigenvalue", capability: "apply" },
            ],
            sufficientConditions: true,
            circular: false,
            explanation: "",
          };
        },
        fixture.catalog,
        scope,
        plan,
        candidate,
      ),
    /MATH_SOLVER_REJECTED/,
  );
  for (const bad of [
    "valid",
    "matchesIndependentSolution",
    "conditionsComplete",
    "withinScope",
    "nonCircular",
    "difficultyMatches",
  ])
    await assert.rejects(
      () =>
        compareSolutions(
          async () => ({
            ...Object.fromEntries(
              [
                "valid",
                "matchesIndependentSolution",
                "conditionsComplete",
                "withinScope",
                "nonCircular",
                "difficultyMatches",
              ].map((k) => [k, k !== bad]),
            ),
            reason: "known bad fixture",
          }),
          fixture.catalog,
          scope,
          plan,
          candidate,
          { answerMarkdown: "different" },
        ),
      /MATH_VALIDATOR_REJECTED/,
    );
});
test("YAML duplicates, code-fence headings, unsafe LaTeX and source/review changes are checked", () => {
  assert.throws(() => parseYaml("id: a\nid: b"), /E_INVALID_YAML/);
  const parsed = parseUnit(fixture.markdown);
  assert(
    parsed.blocks
      .find((b) => b.id === "vector-space-statement")
      ?.markdown.includes("Properties"),
  );
  const extended = fixture.markdown.replace(
    "Determine whether",
    "```md\n## fake {#not-real}\n---\nid: fake\n---\n```\nDetermine whether",
  );
  assert(!parseUnit(extended).blocks.some((b) => b.anchor === "not-real"));
  assert.throws(
    () =>
      compileUnit(
        extended,
        fixture.provenance,
        fixture.receipt,
        "linear-algebra",
        "Linear Algebra",
      ),
    /E_REVIEW_HASH_MISMATCH/,
  );
  assert.throws(
    () => validateMathMarkdown("$\\href{javascript:alert(1)}{x}$"),
    /E_UNSAFE_LATEX/,
  );
  assert.throws(
    () => validateMathMarkdown("$\\notacommand{x}$"),
    /E_INVALID_LATEX/,
  );
  validateMathMarkdown("$$\n\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}\n$$");
  assert.equal(
    JSON.parse(JSON.stringify({ md: fixture.markdown })).md,
    fixture.markdown,
  );
});
test("legacy authoring compiler remains readable while acceptance is explicitly read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "vocab-math-")),
    run = await mkdtemp(join(tmpdir(), "vocab-review-"));
  try {
    const f = await linearAlgebraFixture(root);
    const built = await buildCatalog(root);
    assert.equal(built.catalog.concepts.length, 3);
    assert.equal(built.catalog.concepts[0].citations[0].sourcePath.length, 3);
    assert.equal(built.catalog.id, (await buildCatalog(root)).catalog.id);
    const pkg = {
      schemaVersion: 1,
      subject: { id: "linear-algebra", title: "Linear Algebra" },
      units: [{ markdown: f.markdown, provenance: f.provenance }],
      sources: [f.source],
      coverage: [],
      unresolved: [],
    };
    const imported = await importAuthorPackage(pkg, root, run);
    assert.equal((await reviewAuthorRun(run)).reviewHash, imported.reviewHash);
    await assert.rejects(
      () => acceptAuthorRun(run, ["vector-subspaces"], "0".repeat(64), "test"),
      /E_LEGACY_AUTHORING_READ_ONLY/,
    );
    await writeFile(
      join(root, "linear-algebra/units/unit-vector-subspaces.md"),
      f.markdown + "\n",
    );
    await assert.rejects(
      () =>
        acceptAuthorRun(run, ["vector-subspaces"], imported.reviewHash, "test"),
      /E_LEGACY_AUTHORING_READ_ONLY/,
    );
    await assert.rejects(() => safePath(root, "../escape"), /E_UNSAFE_PATH/);
    await symlink("/tmp", join(root, "escape"));
    await assert.rejects(() => safePath(root, "escape"), /E_SYMLINK/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(run, { recursive: true, force: true });
  }
});

test("strict model schema uses a supported anyOf with mutually exclusive status constants", () => {
  const schema = jsonSchema(generationResultSchema) as any;
  assert.equal(schema.properties.result.anyOf.length, 3);
  assert(!JSON.stringify(schema).includes("oneOf"));
  for (const status of ["NEEDS_CONTEXT", "IMPOSSIBLE_WITH_SCOPE"])
    assert(
      generationResultSchema.safeParse({
        result:
          status === "NEEDS_CONTEXT"
            ? { status, requiredCapabilities: [], reason: "scope" }
            : { status, reason: "scope" },
      }).success,
    );
});

test("grade evidence is grounded to unique answer excerpts; fabricated evidence stays unconfirmed", async () => {
  const scope = resolveScope(request(), fixture.catalog),
    candidate = validCandidate(fixture.catalog, scope, scope.plans[0]),
    solution = {
      candidate,
      citations: fixture.catalog.concepts.flatMap((c) => c.citations),
      validation: {},
    };
  const attempt: any = { answerText: "yes, all three conditions hold" };
  const response = {
    state: "graded",
    criteria: [
      {
        criterionId: "all-conditions",
        awardedPoints: 100,
        maxPoints: 100,
        feedback: "Verified",
        evidenceRanges: [{ start: 99, end: 102, quote: "yes" }],
        citationIds: [],
      },
    ],
    outsideMethodUsed: false,
    objectiveEvidence: [
      { objectiveId: "apply-subspace-test", demonstrated: true },
    ],
    correctnessScore: 100,
    gradeSource: "ai",
    feedback: "Correct",
  };
  const grade = await gradeAttempt(async () => response, attempt, solution);
  assert.deepEqual(grade.criteria[0].evidenceRanges, [
    { start: 0, end: 3, quote: "yes" },
  ]);
  const bad = structuredClone(response);
  bad.criteria[0].evidenceRanges[0].quote = "not in the answer";
  const uncertain = await gradeAttempt(async () => bad, attempt, solution);
  assert.equal(uncertain.state, "needs_review");
  assert.equal(uncertain.objectiveEvidence.length, 0);
  assert.equal(uncertain.criteria[0].evidenceRanges.length, 0);
});

test("generator context carries server-owned target and prerequisite roles instead of asking the model to infer foundations", () => {
  const scope = resolveScope(request(), fixture.catalog),
    pack = contextPack(fixture.catalog, scope, scope.plans[0]);
  assert.equal(
    pack.concepts.find((c) => c.id === "vector-space")!.role,
    "prerequisite",
  );
  assert.equal(
    pack.concepts.find((c) => c.id === "subspace-test")!.role,
    "target",
  );
  assert(!pack.concepts.some((c) => c.role === "foundation"));
});

test("target-aware baseline resolution cannot retain an unchosen prerequisite branch", () => {
  const c = structuredClone(fixture.catalog);
  const target = { conceptId: "subspace-test", capability: "apply" as const };
  const baseline = {
    conceptId: "vector-space",
    capability: "recognize" as const,
  };
  c.subjects[0].foundationProfileIds = ["foundation"];
  c.profiles = [
    {
      id: "foundation",
      title: "Foundation",
      revision: "1",
      acceptedCapabilities: [baseline],
      sourceDescription: "Fixture",
    },
  ];
  c.concepts.find(
    (x) => x.id === target.conceptId,
  )!.capabilities.apply!.prerequisites = { allOf: [], anyOf: [] };
  c.concepts.find(
    (x) => x.id === "subspace",
  )!.capabilities.recognize!.prerequisites = { allOf: [], anyOf: [] };
  c.concepts.find(
    (x) => x.id === baseline.conceptId,
  )!.capabilities.recognize!.prerequisites = {
    allOf: [],
    anyOf: [
      {
        id: "initial",
        priority: 0,
        requires: [{ conceptId: "subspace", capability: "recognize" }],
      },
      { id: "target-known", priority: 1, requires: [target] },
    ],
  };
  assert.equal(
    resolveDependencies(c, [baseline], [], new Set(["vector-space:recognize"]))
      .branches[0].alternativeId,
    "initial",
  );
  const scope = resolveScope({ ...request(), profileIds: ["foundation"] }, c);
  assert.equal(scope.branches[0].alternativeId, "target-known");
  assert(
    !scope.plans[0].allowedCapabilities.some((r) => r.conceptId === "subspace"),
  );
});
test("foundation consent expires when an accepted concept changes without renaming capability IDs", () => {
  const c = structuredClone(fixture.catalog);
  c.subjects[0].foundationProfileIds = ["foundation"];
  c.profiles = [
    {
      id: "foundation",
      title: "Foundation",
      revision: "1",
      acceptedCapabilities: [
        { conceptId: "vector-space", capability: "apply" },
      ],
      sourceDescription: "Fixture",
    },
  ];
  const hash = foundationAcceptanceHash(c, c.profiles[0]);
  const input = { ...request(), profileIds: ["foundation"] };
  assert(
    !resolveScope(input, c, { foundation: hash }).requiredAcceptance.some((x) =>
      x.startsWith("baseline:"),
    ),
  );
  c.concepts.find((x) => x.id === "vector-space")!.revisionId =
    contentHash("changed definition");
  assert.notEqual(foundationAcceptanceHash(c, c.profiles[0]), hash);
  assert(
    resolveScope(input, c, { foundation: hash }).requiredAcceptance.includes(
      "baseline:vector-space:apply",
    ),
  );
});

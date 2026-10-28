import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeRequestV2Schema, contentHash } from "../../src/math-schema.js";
import { resolveScopeV2, planNextQuestion } from "../../src/math-scope.js";
import { linearAlgebraFixture } from "./math-fixtures.js";
const fixture = await linearAlgebraFixture();
const request = {
  schemaVersion: 2 as const,
  subjectId: "linear-algebra",
  selectedNodeIds: ["chapter-1"],
  difficulty: 2,
  responseLanguage: "en" as const,
};
test("v2 request has no policy and finite count is optional and strict", () => {
  assert.equal(scopeRequestV2Schema.parse(request).questionCount, undefined);
  for (const questionCount of [0, -1, 1.5, 21, null])
    assert.equal(
      scopeRequestV2Schema.safeParse({ ...request, questionCount }).success,
      false,
    );
  for (const field of [
    "mode",
    "profileIds",
    "answerFormats",
    "excludedConceptIds",
    "objectiveCapabilities",
  ])
    assert.equal(
      scopeRequestV2Schema.safeParse({ ...request, [field]: [] }).success,
      false,
    );
});
test("v2 freezes target objectives separately from chapter prerequisites and conservatively grants apply only", () => {
  const catalog = structuredClone(fixture.catalog);
  catalog.nodes.push({
    id: "chapter-2",
    subjectId: "linear-algebra",
    parentId: "linear-algebra-root",
    ancestorIds: ["linear-algebra-root"],
    kind: "chapter",
    title: "Earlier",
    order: 0,
    unitIds: [],
  });
  catalog.chapterDependencies = { "chapter-1": ["chapter-2"] };
  catalog.conceptChapterIds = Object.fromEntries(
    catalog.concepts.map((c) => [
      c.id,
      c.id === "subspace-test" ? "chapter-1" : "chapter-2",
    ]),
  );
  const scope = resolveScopeV2(request, catalog);
  assert.equal(scope.request.questionLimit, null);
  assert.deepEqual(scope.targetObjectiveIds, ["apply-subspace-test"]);
  assert.deepEqual(scope.prerequisiteChapterIds, ["chapter-2"]);
  assert.deepEqual(scope.plans, []);
  assert.deepEqual(scope.requiredAcceptance, []);
  assert.equal(
    scope.prerequisites.some((r) => r.capability === "prove"),
    false,
  );
  const plan = planNextQuestion(scope, catalog, 10001);
  assert.equal(plan.id, "plan-10001");
  assert.deepEqual(plan.targetObjectiveIds, ["apply-subspace-test"]);
  assert.equal(plan.answerFormat, "text");
  assert.equal(
    contentHash(plan),
    contentHash(planNextQuestion(scope, catalog, 10001)),
  );
});
test("v2 rejects cyclic chapter closure", () => {
  const catalog = structuredClone(fixture.catalog);
  catalog.chapterDependencies = { "chapter-1": ["chapter-1"] };
  catalog.conceptChapterIds = { "subspace-test": "chapter-1" };
  assert.throws(
    () => resolveScopeV2(request, catalog),
    /MATH_CHAPTER_DEPENDENCY_CYCLE/,
  );
});

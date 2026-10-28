import { test } from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import {
  gradingSchemaForRubric,
  gradeAttempt,
  validateAssessment,
} from "../../src/math-generation.js";
import { jsonSchema } from "../../src/math-schema.js";
import {
  linearAlgebraFixture,
  request,
  validCandidate,
} from "./math-fixtures.js";
import { resolveScope } from "../../src/math-scope.js";
const fixture = await linearAlgebraFixture();
const scope = resolveScope(request(), fixture.catalog),
  candidate = validCandidate(fixture.catalog, scope, scope.plans[0]);
candidate.rubric = [30, 50, 20].map((points, i) => ({
  ...candidate.rubric[0],
  criterionId: `criterion-${i + 1}`,
  points,
}));
const solution = {
  candidate,
  citations: fixture.catalog.concepts.flatMap((c) => c.citations),
  validation: {},
};
const attempt: any = {
  answerText: "The subset contains zero and is closed under both operations.",
};
const response = {
  state: "graded",
  criteria: candidate.rubric.map((r) => ({
    criterionId: r.criterionId,
    awardedPoints: r.points,
    maxPoints: r.points,
    feedback: "Checked",
    evidenceRanges: [],
    citationIds: [],
  })),
  outsideMethodUsed: false,
  objectiveEvidence: [],
  correctnessScore: 100,
  gradeSource: "ai",
  feedback: "All conditions checked.",
};
test("grading model contract fixes each criterion ID, maximum, exact count and AI source", () => {
  const schema = jsonSchema(gradingSchemaForRubric(candidate.rubric)) as any;
  assert.equal(schema.properties.criteria.minItems, 3);
  assert.equal(schema.properties.criteria.maxItems, 3);
  assert.equal(schema.properties.gradeSource.const, "ai");
  assert.equal(schema.properties.criteria.items.anyOf.length, 3);
  assert(!JSON.stringify(schema).includes('"oneOf"'));
  const validate = new Ajv({ strict: false }).compile(schema);
  assert(validate(response));
  for (const mutate of [
    (r: any) => (r.criteria[0].criterionId = "invented"),
    (r: any) => (r.criteria[0].maxPoints = 100),
    (r: any) => (r.criteria[0].awardedPoints = 31),
    (r: any) => r.criteria.pop(),
    (r: any) => (r.gradeSource = "self"),
  ]) {
    const bad = structuredClone(response);
    mutate(bad);
    assert.equal(validate(bad), false);
  }
});
test("multi-criterion grading retains immutable metadata and rejects fabricated IDs, maxima and arithmetic", async () => {
  let observed = false;
  const grade = await gradeAttempt(
    async (feature, prompt, input, schema) => {
      assert.equal(feature, "grade");
      assert(prompt.includes("arithmetic sum"));
      assert.equal(schema.safeParse(response).success, true);
      observed = true;
      return structuredClone(response);
    },
    attempt,
    solution,
  );
  assert(observed);
  assert.equal(grade.correctnessScore, 100);
  assert.deepEqual(
    grade.criteria.map((c) => c.maxPoints),
    [30, 50, 20],
  );
  for (const mutate of [
    (r: any) => (r.criteria[0].criterionId = "invented"),
    (r: any) => (r.criteria[0].maxPoints = 100),
    (r: any) => (r.criteria[0].awardedPoints = 31),
    (r: any) => (r.criteria[1].criterionId = r.criteria[0].criterionId),
    (r: any) => (r.correctnessScore = 99),
  ]) {
    const bad = structuredClone(response);
    mutate(bad);
    assert.throws(
      () => validateAssessment(bad, attempt, solution),
      /MATH_INVALID_GRADE/,
    );
    await assert.rejects(() =>
      gradeAttempt(async () => bad, attempt, solution),
    );
  }
});
test("one-criterion grading uses the same literal contract without a one-member union", () => {
  const single = candidate.rubric.slice(0, 1),
    schema = jsonSchema(gradingSchemaForRubric(single)) as any;
  assert.equal(
    schema.properties.criteria.items.properties.criterionId.const,
    "criterion-1",
  );
  assert.equal(schema.properties.criteria.items.properties.maxPoints.const, 30);
  assert.equal(schema.properties.criteria.minItems, 1);
});

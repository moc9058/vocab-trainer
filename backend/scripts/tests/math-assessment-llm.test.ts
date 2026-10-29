import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Curriculum, MathTest } from "../../src/math-types.js";
const calls: { route: string; user: string; system: string }[] = [];
let rejectOnce = false,
  invalidGrade = false,
  infeasible = false;
const objective = {
  id: "o1",
  chapterId: "c1",
  statement: "Determine subspace membership.",
  ability: "concept" as const,
  supportedTaskKinds: ["determine" as const],
  sourceRefs: [{ chapterId: "c1", section: "1.1", heading: "1.1 Subspace" }],
  prerequisiteObjectiveIds: [],
  requiredBackground: [],
  successCriteria: [
    { id: "c", criterion: "Prove closure or give a counterexample." },
  ],
  scopeConstraints: [],
  commonErrors: [],
  status: "active" as const,
};
const raw = {
  chapterId: "c1",
  primaryObjectiveId: "o1",
  supportingObjectiveIds: [],
  ability: "concept",
  taskKind: "determine",
  responseFormat: "written",
  prompt:
    "Determine whether x+y=0 in R^2 is a subspace and justify the conclusion.",
  solution: "Yes, zero and both closure properties hold.",
  sourceRefs: [{ chapterId: "c1", heading: "1.1 Subspace" }],
  rubricItems: [
    {
      id: "closure",
      criterion: "Show zero membership and both closure properties.",
      weight: 1,
    },
  ],
  answerSpec: { mode: "decision", domain: "R^2" },
  demandProfile: {
    methodChoice: "Choose the subspace test",
    transfer: "A homogeneous relation",
    scaffolding: "No decisive hint",
    synthesis: "All three conditions",
  },
};
mock.module("../../src/llm.ts", {
  namedExports: {
    callLLM: async (opts: { route: string; user: string; system: string }) => {
      assert.match(opts.system, /json/i);
      calls.push(opts);
      const data = JSON.parse(opts.user);
      if (opts.route === "math/generate")
        return JSON.stringify(
          infeasible
            ? { status: "infeasible", reason: "No permitted task." }
            : { questions: [raw] },
        );
      if (opts.route === "math/grade")
        return JSON.stringify({
          items: invalidGrade
            ? []
            : [
                {
                  id: "closure",
                  status: "met",
                  evidence: "Closure",
                  feedback: "Equivalent proof accepted.",
                },
              ],
          feedback: "Correct.",
        });
      if (data.stage === "V1") {
        assert.equal("solution" in data.questions[0], false);
        assert.equal("rubricItems" in data.questions[0], false);
        return JSON.stringify({
          status: "solved",
          solutions: [
            {
              primaryObjectiveId: "o1",
              solution: "Closed by linearity.",
              usedSourceRefs: raw.sourceRefs,
              missingAssumptions: [],
            },
          ],
        });
      }
      const valid = !rejectOnce;
      rejectOnce = false;
      return JSON.stringify({
        valid,
        checks: Object.fromEntries(
          [
            "wellPosed",
            "correct",
            "scope",
            "objective",
            "difficulty",
            "taskKind",
            "rubric",
          ].map((k) => [k, valid]),
        ),
        issues: valid
          ? []
          : [
              {
                code: "MISSING_CASE",
                repair: "Handle zero coefficients explicitly.",
              },
            ],
      });
    },
  },
});
const { generateMathQuestions, gradeMathAnswer } = await import(
  "../../src/math-llm.js"
);
const { mathPromptVersion } = await import("../../src/math-prompt-loader.js");
const curriculum: Curriculum = {
  schemaVersion: 2,
  bookId: "book",
  revision: "rev",
  sourceLanguage: "en",
  instructionLanguage: "en",
  sources: [],
  objectives: [objective],
};
const source = {
  id: "c1",
  number: 1,
  title: "Subspaces",
  versionId: "v1",
  bookId: "book",
  markdown: "# 1.1 Subspace\nZero and closure.",
};
const fixture: MathTest = {
  id: "test",
  assessmentVersion: 2,
  taskKinds: ["determine"],
  publicationId: "pub",
  curriculumRevision: "rev",
  difficultyPolicyVersion: "assessment-v1",
  promptVersion: mathPromptVersion,
  pendingPlans: [
    {
      primaryObjectiveId: "o1",
      chapterId: "c1",
      taskKind: "determine",
      seed: "seed",
      slot: "unseen",
    },
  ],
  book: {
    id: "book",
    title: "Book",
    subjectId: "math",
    subjectTitle: "Math",
    language: "en",
    revision: "r",
    subjectProfile: {
      version: "math-v1",
      subject: "mathematics",
      constraints: [],
    },
    chapters: [source],
  },
  chapterIds: ["c1"],
  sourceVersionIds: ["v1"],
  count: 1,
  kinds: ["definition"],
  difficulty: "standard",
  status: "active",
  questions: [],
  answers: {},
  draft: "",
  version: 0,
  createdAt: "now",
  updatedAt: "now",
};
const options = { curriculum, recent: [], isDuplicate: async () => false };
test("v2 uses frozen objective and policy, independently solves then compares and forwards repair issues", async () => {
  calls.length = 0;
  rejectOnce = true;
  const [q] = await generateMathQuestions(
    structuredClone(fixture),
    [source],
    options,
  );
  assert.equal(q.primaryObjectiveId, "o1");
  assert.equal(q.publicationId, "pub");
  assert.equal(q.schemaVersion, 2);
  assert.deepEqual(
    calls.map((c) => c.route),
    [
      "math/generate",
      "math/validate",
      "math/validate",
      "math/generate",
      "math/validate",
      "math/validate",
    ],
  );
  const context = JSON.parse(calls[0].user);
  assert.equal(context.objective[0].id, "o1");
  assert.equal(context.difficultyPolicy.version, "assessment-v1");
  assert.equal(JSON.parse(calls[3].user).repair[0].code, "MISSING_CASE");
  assert.equal(
    (await gradeMathAnswer(fixture, q, "Alternative proof", [source])).verdict,
    "correct",
  );
  invalidGrade = true;
  await assert.rejects(
    () => gradeMathAnswer(fixture, q, "text", [source]),
    /INVALID_GRADE/,
  );
  invalidGrade = false;
});
test("infeasible plan is replaced at most once without broadening user settings", async () => {
  infeasible = true;
  let changes = 0;
  await assert.rejects(
    () =>
      generateMathQuestions(structuredClone(fixture), [source], {
        ...options,
        replan: async (ids) => {
          assert.deepEqual(ids, ["o1"]);
          changes++;
        },
      }),
    /MATH_NO_FEASIBLE_OBJECTIVE/,
  );
  assert.equal(changes, 1);
  infeasible = false;
});

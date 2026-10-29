import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMathBooks } from "./math-sync.js";
import { curriculumRevision, validateCurriculum } from "./math-curriculum.js";
import { mathHash, publicMathTest } from "./math-core.js";
import { selectAssessmentPlan } from "./math-assessment-plan.js";
import {
  validateAssessmentQuestions,
  validateAssessmentGrade,
} from "./math-assessment-validation.js";
import type { Curriculum, MathTest, ObjectiveProgress } from "./math-types.js";
import { mathPromptVersion } from "./math-prompt-loader.js";
export const objective = {
  id: "position",
  chapterId: "c1",
  statement: "Derive position under constant acceleration.",
  ability: "modeling" as const,
  supportedTaskKinds: ["derive" as const, "compute" as const],
  sourceRefs: [{ chapterId: "c1", section: "1.1", heading: "1.1 Motion" }],
  prerequisiteObjectiveIds: [],
  requiredBackground: ["Elementary algebra."],
  successCriteria: [
    {
      id: "equation",
      criterion:
        "Use the constant acceleration assumption and initial position.",
    },
  ],
  scopeConstraints: ["One-dimensional constant acceleration, SI units."],
  commonErrors: [],
  status: "active" as const,
};
const source = {
  id: "c1",
  number: 1,
  title: "Motion",
  versionId: "v1",
  bookId: "physics",
  markdown:
    "# 1.1 Motion\nFor constant acceleration a, x=x0+v0*t+a*t^2/2, where positions are in meters and time is in seconds.",
};
const curriculum: Curriculum = {
  schemaVersion: 2,
  bookId: "physics",
  sourceLanguage: "en",
  instructionLanguage: "en",
  sources: [
    {
      chapterId: "c1",
      file: "Physics/md/1. Motion.md",
      sha256: mathHash(source.markdown),
    },
  ],
  objectives: [objective],
  revision: "",
};
curriculum.revision = curriculumRevision(curriculum);
const fixture: MathTest = {
  id: "test",
  assessmentVersion: 2,
  taskKinds: ["derive"],
  publicationId: "pub",
  curriculumRevision: curriculum.revision,
  promptVersion: mathPromptVersion,
  difficultyPolicyVersion: "assessment-v1",
  book: {
    id: "physics",
    subjectId: "physics",
    subjectTitle: "Physics",
    title: "Physics",
    language: "en",
    revision: "pub",
    publicationId: "pub",
    curriculumRevision: curriculum.revision,
    subjectProfile: {
      version: "physics-v1",
      subject: "physics",
      constraints: ["SI units; constant acceleration."],
    },
    chapters: [source],
  },
  chapterIds: ["c1"],
  sourceVersionIds: ["v1"],
  count: 1,
  kinds: ["calculation"],
  difficulty: "standard",
  status: "active",
  questions: [],
  answers: {},
  draft: "",
  version: 0,
  createdAt: "now",
  updatedAt: "now",
};
test("curriculum rejects stale hashes, phantom headings, duplicate IDs, cycles and later prerequisites", () => {
  const validate = (c: Curriculum) =>
    validateCurriculum(
      { ...c, revision: curriculumRevision(c) },
      "physics",
      [source],
      [{ id: "c1", file: curriculum.sources[0].file }],
      "en",
    );
  assert.equal(validate(curriculum).objectives[0].id, "position");
  const variants = [
    { ...curriculum, sources: [{ ...curriculum.sources[0], sha256: "bad" }] },
    { ...curriculum, objectives: [objective, objective] },
    {
      ...curriculum,
      objectives: [
        {
          ...objective,
          sourceRefs: [{ ...objective.sourceRefs[0], heading: "1.1 Invented" }],
        },
      ],
    },
    {
      ...curriculum,
      objectives: [{ ...objective, prerequisiteObjectiveIds: [objective.id] }],
    },
  ];
  for (const c of variants) assert.throws(() => validate(c));
  const later = { ...source, id: "c2", number: 2 };
  const c = {
    ...curriculum,
    sources: [
      ...curriculum.sources,
      {
        ...curriculum.sources[0],
        chapterId: "c2",
        file: "Physics/md/2. Later.md",
      },
    ],
    objectives: [
      { ...objective, prerequisiteObjectiveIds: ["later"] },
      { ...objective, id: "later", chapterId: "c2" },
    ],
  };
  assert.throws(
    () =>
      validateCurriculum(
        { ...c, revision: curriculumRevision(c) },
        "physics",
        [source, later],
        [
          { id: "c1", file: c.sources[0].file },
          { id: "c2", file: c.sources[1].file },
        ],
        "en",
      ),
    /later prerequisite/,
  );
});
test("physics and economics authoring fixtures publish deterministically and detect source edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "curriculum-"));
  try {
    for (const subject of ["physics", "economics"] as const) {
      await mkdir(join(root, "Physics/md"), { recursive: true });
      await mkdir(join(root, "Physics/curriculum"), { recursive: true });
      await writeFile(join(root, curriculum.sources[0].file), source.markdown);
      await writeFile(
        join(root, "Physics/curriculum/catalog.json"),
        JSON.stringify(curriculum),
      );
      const manifest = {
        books: [
          {
            id: "physics",
            subjectId: subject,
            subjectTitle: subject,
            title: "Book",
            language: "en",
            chapters: [{ id: "c1", file: curriculum.sources[0].file }],
            curriculumFile: "Physics/curriculum/catalog.json",
            subjectProfile: {
              version: `${subject}-v1`,
              subject,
              constraints: ["Use explicit model assumptions."],
            },
          },
        ],
      };
      const a = await prepareMathBooks(root, manifest),
        b = await prepareMathBooks(root, manifest);
      assert.deepEqual(a, b);
      const changed = {
        ...curriculum,
        objectives: [
          { ...objective, commonErrors: ["Missing initial condition."] },
        ],
      };
      changed.revision = curriculumRevision(changed);
      await writeFile(
        join(root, "Physics/curriculum/catalog.json"),
        JSON.stringify(changed),
      );
      assert.notEqual(
        (await prepareMathBooks(root, manifest))[0].book.publicationId,
        a[0].book.publicationId,
      );
      await writeFile(
        join(root, curriculum.sources[0].file),
        source.markdown + "\nChanged",
      );
      await assert.rejects(
        () => prepareMathBooks(root, manifest),
        /stale source/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("planner preserves seed and scope, rejects impossible task kinds and spaces incorrect review", () => {
  const plan = selectAssessmentPlan(fixture, curriculum, [], "seed");
  assert.deepEqual(plan, selectAssessmentPlan(fixture, curriculum, [], "seed"));
  assert.equal(plan.taskKind, "derive");
  assert.throws(
    () =>
      selectAssessmentPlan(
        { ...fixture, taskKinds: ["prove"] },
        curriculum,
        [],
        "seed",
      ),
    /MATH_NO_FEASIBLE_OBJECTIVE/,
  );
  const second = { ...objective, id: "other" };
  const c = { ...curriculum, objectives: [objective, second] };
  const e: ObjectiveProgress = {
    schemaVersion: 2,
    objectiveId: "position",
    presented: 1,
    submitted: 1,
    correct: 0,
    partial: 0,
    incorrect: 1,
    skipped: 0,
    lastVerdict: "incorrect",
    lastTestId: "test",
    lastNumber: 1,
    assistanceStatus: "unknown",
  };
  for (let n = 1; n <= 3; n++)
    assert.equal(
      selectAssessmentPlan({ ...fixture, generatedCount: n }, c, [e], "seed")
        .primaryObjectiveId,
      "other",
    );
  assert.equal(
    selectAssessmentPlan(fixture, curriculum, [e], "seed").slot,
    "practice",
  );
});
test("v2 questions enforce planned IDs, references, weighted grading and private serialization", () => {
  const t = {
    ...fixture,
    pendingPlans: [selectAssessmentPlan(fixture, curriculum, [], "seed")],
  };
  const raw = {
    chapterId: "c1",
    primaryObjectiveId: "position",
    supportingObjectiveIds: [],
    taskKind: "derive",
    ability: "modeling",
    responseFormat: "written",
    prompt: "Derive x(t) under constant acceleration with given x0 and v0.",
    solution: "x=x0+v0*t+a*t^2/2",
    sourceRefs: [{ chapterId: "c1", heading: "1.1 Motion" }],
    rubricItems: [
      {
        id: "equation",
        criterion: "Obtain the position expression.",
        weight: 2,
      },
      { id: "initial", criterion: "Satisfy initial conditions.", weight: 1 },
    ],
    answerSpec: { mode: "expression", domain: "t>=0, SI units", units: "m" },
    demandProfile: {
      methodChoice: "Choose a known relation",
      transfer: "Initial conditions",
      scaffolding: "None",
      synthesis: "Position and acceleration",
    },
  };
  const q = validateAssessmentQuestions(
    { questions: [raw] },
    t,
    [source],
    curriculum,
  )[0];
  for (const patch of [
    { primaryObjectiveId: "phantom" },
    { chapterId: "c2" },
    { taskKind: "prove" },
    { sourceRefs: [{ chapterId: "c1", heading: "Invented" }] },
    { rubricItems: [raw.rubricItems[0], raw.rubricItems[0]] },
  ])
    assert.throws(() =>
      validateAssessmentQuestions(
        { questions: [{ ...raw, ...patch }] },
        t,
        [source],
        curriculum,
      ),
    );
  const grade = validateAssessmentGrade(
    {
      items: [
        {
          id: "equation",
          status: "met",
          evidence: "x=...",
          feedback: "Equivalent expression accepted.",
        },
        {
          id: "initial",
          status: "unmet",
          evidence: "",
          feedback: "Missing initial position.",
        },
      ],
      feedback: "Partially correct.",
    },
    q,
  );
  assert.equal(grade.verdict, "partial");
  assert.equal(grade.score, 2 / 3);
  assert.throws(
    () => validateAssessmentGrade({ items: [], feedback: "Wrong" }, q),
    /INVALID_GRADE/,
  );
  const publicQ = publicMathTest({ ...t, questions: [q] }).questions[0];
  for (const key of ["rubric", "rubricItems", "demandProfile"])
    assert.equal(key in publicQ, false);
  assert.equal("pendingPlans" in publicMathTest(t), false);
});
test("built prompt assets are available without source files", async () => {
  const dist = new URL("../dist/math-prompts/generate.md", import.meta.url);
  assert.ok((await readFile(dist, "utf8")).includes("primary objective"));
});

test("new physics and economics source fixtures produce source-grounded v2 curricula without modifying existing IDs", async () => {
  const { prepareSubjectFixtures } = await import(
    "../scripts/fixtures/math-subjects.js"
  );
  const root = await mkdtemp(join(tmpdir(), "new-subjects-"));
  try {
    const first = await prepareSubjectFixtures(root),
      next = await prepareSubjectFixtures(root);
    assert.deepEqual(first, next);
    assert.equal(first[0].book.subjectProfile!.subject, "physics");
    assert.equal(first[1].book.subjectProfile!.subject, "economics");
    assert.match(first[0].sources[0].markdown, /SI units/);
    assert.match(first[1].sources[0].markdown, /exogenous/);
    for (const f of first) {
      assert.equal(f.curriculum!.objectives[0].ability, "modeling");
      assert.deepEqual(f.curriculum!.objectives[0].supportedTaskKinds, [
        "derive",
        "compute",
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supporting objective IDs may use the transitive prerequisite closure but never a phantom ID", () => {
  const prerequisite = {
    ...objective,
    id: "prerequisite",
    prerequisiteObjectiveIds: ["foundation"],
  };
  const foundation = { ...objective, id: "foundation" };
  const primary = { ...objective, prerequisiteObjectiveIds: ["prerequisite"] };
  const c = { ...curriculum, objectives: [primary, prerequisite, foundation] };
  const t = {
    ...fixture,
    pendingPlans: [selectAssessmentPlan(fixture, c, [], "seed")],
  };
  t.pendingPlans[0].primaryObjectiveId = primary.id;
  const q = {
    chapterId: "c1",
    primaryObjectiveId: primary.id,
    supportingObjectiveIds: ["foundation"],
    taskKind: "derive",
    ability: "modeling",
    responseFormat: "written",
    prompt: "Derive position.",
    solution: "x=x0+v0*t+a*t^2/2",
    sourceRefs: [{ chapterId: "c1", heading: "1.1 Motion" }],
    rubricItems: [{ id: "r", criterion: "Derive the expression", weight: 1 }],
    answerSpec: { mode: "expression", domain: "t>=0" },
    demandProfile: {
      methodChoice: "Known relation",
      transfer: "Initial conditions",
      scaffolding: "None",
      synthesis: "Substitution",
    },
  };
  assert.equal(
    validateAssessmentQuestions({ questions: [q] }, t, [source], c)[0]
      .supportingObjectiveIds![0],
    "foundation",
  );
  assert.throws(() =>
    validateAssessmentQuestions(
      { questions: [{ ...q, supportingObjectiveIds: ["phantom"] }] },
      t,
      [source],
      c,
    ),
  );
});

test("server-issued source references resolve exact headings and reject unknown IDs", () => {
  const t = {
    ...fixture,
    pendingPlans: [selectAssessmentPlan(fixture, curriculum, [], "seed")],
  };
  const raw = {
    chapterId: "c1",
    primaryObjectiveId: "position",
    supportingObjectiveIds: [],
    taskKind: "derive",
    ability: "modeling",
    responseFormat: "written",
    prompt: "Derive position.",
    solution: "x=x0+v0*t+a*t^2/2",
    sourceRefIds: ["c1-h1"],
    rubricItems: [{ id: "r", criterion: "Derive position", weight: 1 }],
    answerSpec: { mode: "expression", domain: "t>=0" },
    demandProfile: {
      methodChoice: "Known relation",
      transfer: "Initial conditions",
      scaffolding: "None",
      synthesis: "Substitution",
    },
  };
  const [q] = validateAssessmentQuestions(
    { questions: [raw] },
    t,
    [source],
    curriculum,
  );
  assert.deepEqual(q.sourceRefs, [{ chapterId: "c1", heading: "1.1 Motion" }]);
  assert.throws(() =>
    validateAssessmentQuestions(
      { questions: [{ ...raw, sourceRefIds: ["phantom"] }] },
      t,
      [source],
      curriculum,
    ),
  );
});

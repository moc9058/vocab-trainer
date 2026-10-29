import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sourceScope,
  questionPlan,
  validateQuestions,
  validateGrade,
  publicMathTest,
} from "./math-core.js";
import { prepareMathBooks } from "./math-sync.js";
import type { MathBook, MathSource, MathTest } from "./math-types.js";
import { readFile } from "node:fs/promises";
const book: MathBook = {
  id: "book",
  subjectId: "subject",
  subjectTitle: "Subject",
  title: "Book",
  language: "en",
  revision: "rev",
  chapters: [1, 2, 3].map((n) => ({
    id: `c${n}`,
    number: n,
    title: `Chapter ${n}`,
    versionId: `v${n}`,
  })),
};
const source: MathSource = {
  ...book.chapters[1],
  bookId: "book",
  markdown: "# Definitions\n## Subspace\nA subset...",
};
const fixture: MathTest = {
  id: "test",
  book,
  chapterIds: ["c2"],
  sourceVersionIds: ["v1", "v2"],
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
const question = {
  chapterId: "c2",
  heading: "Subspace",
  kind: "definition",
  prompt: "Define a subspace.",
  solution: "A subset closed under the vector operations including zero.",
  rubric: "Require zero and both closure properties.",
};
test("scope contains prior chapters but rejects missing and duplicate selected chapters", () => {
  assert.deepEqual(sourceScope(book, ["c2"]), ["v1", "v2"]);
  assert.throws(() => sourceScope(book, ["c4"]));
  assert.throws(() => sourceScope(book, ["c1", "c1"]));
});
test("question plan balances chapter and question kinds", () => {
  const plan = questionPlan(
    ["c1", "c2"],
    ["definition", "calculation", "proof"],
    6,
  );
  for (const kind of ["definition", "calculation", "proof"])
    assert.equal(plan.filter((p) => p.kind === kind).length, 2);
  assert.equal(plan.filter((p) => p.chapterId === "c1").length, 3);
});
test("question validation rejects invented sources, prerequisite-only scope, wrong count, duplicate prompts and missing solutions", () => {
  assert.equal(
    validateQuestions({ questions: [question] }, fixture, [source])[0].id,
    "q1",
  );
  for (const patch of [
    { heading: "Invented" },
    { chapterId: "c1" },
    { solution: "" },
    { kind: "proof" },
  ])
    assert.throws(() =>
      validateQuestions({ questions: [{ ...question, ...patch }] }, fixture, [
        source,
      ]),
    );
  assert.throws(() => validateQuestions({ questions: [] }, fixture, [source]));
  assert.throws(() =>
    validateQuestions(
      { questions: [question, question] },
      { ...fixture, count: 2 },
      [source],
    ),
  );
});
test("answers never expose solution or rubric before grading; completion exposes unanswered solutions", () => {
  const test = {
    ...fixture,
    questions: validateQuestions({ questions: [question] }, fixture, [source]),
    requestHash: "private",
  };
  assert.equal(publicMathTest(test).questions[0].solution, undefined);
  assert.equal("requestHash" in publicMathTest(test), false);
  test.answers.q1 = { operationId: "op", text: "answer" };
  assert.equal(publicMathTest(test).questions[0].rubric, undefined);
  test.answers.q1.grade = { verdict: "correct", feedback: "Correct" };
  assert.ok(publicMathTest(test).questions[0].solution);
  assert.ok(
    publicMathTest({ ...test, answers: {}, status: "completed" }).questions[0]
      .solution,
  );
});
test("invalid or empty grading response is not converted into an incorrect answer", () => {
  assert.throws(() => validateGrade({ verdict: "incorrect", feedback: "" }));
  assert.throws(() => validateGrade({ verdict: "unknown", feedback: "x" }));
  assert.deepEqual(
    validateGrade({ verdict: "partial", feedback: "Missing closure." }),
    { verdict: "partial", feedback: "Missing closure." },
  );
});
test("real textbook import preserves stable IDs, numeric order and deterministic versions", async () => {
  const root = new URL("../../textbook/", import.meta.url).pathname;
  const manifest = JSON.parse(
    await readFile(
      new URL("../../textbook/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const first = await prepareMathBooks(root, manifest);
  const next = await prepareMathBooks(root, manifest);
  assert.equal(first[0].sources.length, 9);
  assert.deepEqual(first, next);
  assert.deepEqual(
    first[0].book.chapters.map((c) => c.number),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  const invalid = structuredClone(manifest);
  invalid.books[0].chapters[0].file = "../README.md";
  await assert.rejects(() => prepareMathBooks(root, invalid));
});

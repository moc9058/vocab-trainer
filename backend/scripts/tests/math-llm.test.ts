import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { MathSource, MathTest } from "../../src/math-types.js";
const calls: { route: string; user: string }[] = [];
let invalid = false;
let failGrade = false;
const question = {
  chapterId: "c2",
  heading: "Subspace",
  kind: "definition",
  prompt: "Define a subspace.",
  solution: "Zero and closure.",
  rubric: "Check zero and closure.",
};
mock.module("../../src/llm.ts", {
  namedExports: {
    callLLM: async (opts: { route: string; user: string }) => {
      calls.push(opts);
      if (opts.route === "math/generate")
        return JSON.stringify({ questions: [question] });
      if (opts.route === "math/validate")
        return JSON.stringify({ valid: !invalid, reason: "checked" });
      return failGrade
        ? "{}"
        : JSON.stringify({
            verdict: "correct",
            feedback: "All conditions are present.",
          });
    },
  },
});
const { generateMathQuestions, gradeMathAnswer } = await import(
  "../../src/math-llm.js"
);
const sources: MathSource[] = [1, 2].map((n) => ({
  id: `c${n}`,
  number: n,
  title: "Chapter",
  versionId: `v${n}`,
  markdown: "# Subspace\nZero and closure.",
  bookId: "book",
}));
const fixture: MathTest = {
  id: "test",
  book: {
    id: "book",
    subjectId: "s",
    subjectTitle: "S",
    title: "Book",
    language: "en",
    revision: "r1",
    chapters: sources.map(({ markdown: _markdown, bookId: _book, ...c }) => c),
  },
  chapterIds: ["c2"],
  sourceVersionIds: ["v1", "v2"],
  count: 1,
  kinds: ["definition"],
  difficulty: "standard",
  status: "created",
  questions: [],
  answers: {},
  draft: "",
  version: 0,
  createdAt: "now",
  updatedAt: "now",
};
test("generation passes language and exclusive selected scope, then independently verifies", async () => {
  calls.length = 0;
  const result = await generateMathQuestions(fixture, sources);
  assert.equal(result[0].id, "q1");
  assert.deepEqual(
    calls.map((c) => c.route),
    ["math/generate", "math/validate"],
  );
  const context = JSON.parse(calls[0].user);
  assert.equal(context.language, "en");
  assert.deepEqual(
    context.sources.map((s: { selected: boolean }) => s.selected),
    [false, true],
  );
});
test("invalid mathematics is regenerated once then fails without admitting questions", async () => {
  calls.length = 0;
  invalid = true;
  await assert.rejects(
    () => generateMathQuestions(fixture, sources),
    /MATH_GENERATION_INVALID/,
  );
  invalid = false;
  assert.equal(calls.filter((c) => c.route === "math/generate").length, 2);
});
test("oversize source is rejected before any model request", async () => {
  calls.length = 0;
  await assert.rejects(
    () =>
      generateMathQuestions(fixture, [
        { ...sources[0], markdown: "x".repeat(210000) },
      ]),
    /MATH_SCOPE_TOO_LARGE/,
  );
  assert.equal(calls.length, 0);
});
test("grading passes source, accepts valid result and rejects malformed grading", async () => {
  const q = { ...question, id: "q1", kind: "definition" as const };
  assert.equal(
    (await gradeMathAnswer(fixture, q, "answer", sources)).verdict,
    "correct",
  );
  failGrade = true;
  await assert.rejects(
    () => gradeMathAnswer(fixture, q, "answer", sources),
    /INVALID_GRADE/,
  );
  failGrade = false;
});

test("continuous generation supplies recent history and rejects repeats before validation", async () => {
  calls.length = 0;
  let checks = 0;
  await assert.rejects(
    () =>
      generateMathQuestions(
        { ...fixture, mode: "continuous", generatedCount: 3 },
        sources,
        {
          recent: ["An older problem"],
          isDuplicate: async () => {
            checks++;
            return true;
          },
        },
      ),
    /MATH_GENERATION_INVALID/,
  );
  assert.equal(checks, 2);
  assert.equal(calls.filter((c) => c.route === "math/validate").length, 0);
  assert.deepEqual(JSON.parse(calls[0].user).recentQuestionsToAvoid, [
    "An older problem",
  ]);
});

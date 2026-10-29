import { createHash } from "node:crypto";
import type {
  MathBook,
  MathGrade,
  MathKind,
  MathQuestion,
  MathSource,
  MathTest,
  MathPublicTest,
} from "./math-types.js";
export const MATH_INPUT_BYTES = 200_000;
export function mathHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function mathText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= max
  );
}
export function sourceHeadings(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim());
}
export function sourceScope(book: MathBook, ids: string[]): string[] {
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !book.chapters.some((c) => c.id === id))
  )
    throw new Error("INVALID_SCOPE");
  const last = Math.max(
    ...book.chapters.filter((c) => ids.includes(c.id)).map((c) => c.number),
  );
  return book.chapters.filter((c) => c.number <= last).map((c) => c.versionId);
}
export function questionPlan(
  ids: string[],
  kinds: MathKind[],
  count: number,
  offset = 0,
): { chapterId: string; kind: MathKind }[] {
  return Array.from({ length: count }, (_, index) => {
    const i = index + offset;
    return {
      chapterId: ids[i % ids.length],
      kind: kinds[
        (Math.floor(i / ids.length) + (i % ids.length)) % kinds.length
      ],
    };
  });
}
export function validateQuestions(
  raw: unknown,
  test: MathTest,
  sources: MathSource[],
): MathQuestion[] {
  const value = raw as { questions?: unknown[] };
  if (
    !value ||
    !Array.isArray(value.questions) ||
    value.questions.length !== test.count ||
    Buffer.byteLength(JSON.stringify(value)) > 80_000
  )
    throw new Error("INVALID_QUESTIONS");
  const plan = questionPlan(
    test.chapterIds,
    test.kinds,
    test.count,
    test.mode === "continuous" ? (test.generatedCount ?? 0) : 0,
  );
  const seen = new Set<string>();
  return value.questions.map((item, i) => {
    const q = item as MathQuestion;
    const expected = plan[i];
    const source = sources.find((s) => s.id === expected.chapterId);
    if (
      !q ||
      q.chapterId !== expected.chapterId ||
      q.kind !== expected.kind ||
      !mathText(q.heading, 3000) ||
      !source ||
      !sourceHeadings(source.markdown).includes(q.heading) ||
      !mathText(q.prompt, 8000) ||
      !mathText(q.solution, 12000) ||
      !mathText(q.rubric, 4000) ||
      seen.has(q.prompt.trim())
    )
      throw new Error("INVALID_QUESTIONS");
    seen.add(q.prompt.trim());
    return {
      id: `q${i + 1}`,
      chapterId: q.chapterId,
      kind: q.kind,
      heading: q.heading,
      prompt: q.prompt,
      solution: q.solution,
      rubric: q.rubric,
    };
  });
}
export function validateGrade(raw: unknown): MathGrade {
  const g = raw as MathGrade;
  if (
    !g ||
    !["correct", "partial", "incorrect"].includes(g.verdict) ||
    !mathText(g.feedback, 12000)
  )
    throw new Error("INVALID_GRADE");
  return { verdict: g.verdict, feedback: g.feedback };
}
export function publicMathTest(test: MathTest): MathPublicTest {
  const {
    lock: _lock,
    questions,
    requestHash: _requestHash,
    ...rest
  } = test as MathTest & { requestHash?: string };
  return {
    ...rest,
    questions: questions.map((q) => {
      // The learner may reveal the example solution at any time. Keep the
      // grading rubric private until grading has completed.
      const { rubric: _rubric, ...visible } = q;
      if (test.answers[q.id]?.grade || test.status === "completed") return visible;
      return visible;
    }),
  };
}

export function mathPromptHash(prompt: string): string {
  return mathHash(
    prompt.trim().normalize("NFKC").replace(/\s+/g, " ").toLowerCase(),
  );
}

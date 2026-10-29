import "./math-evaluation-target.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareSubjectFixtures } from "./fixtures/math-subjects.js";
import { generateMathQuestions, gradeMathAnswer } from "../src/math-llm.js";
import { selectAssessmentPlan } from "../src/math-assessment-plan.js";
import { mathPromptVersion } from "../src/math-prompt-loader.js";
import { resolveModel } from "../src/llm.js";
import { db } from "../src/firestore.js";
import type { MathTest, TaskKind } from "../src/math-types.js";
const args = process.argv.slice(2),
  target = args[0];
if (
  args.length !== 1 ||
  !["--target=emulator", "--target=production"].includes(target) ||
  (target === "--target=emulator") !== !!process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error("Explicit matching --target=emulator|production required");
const root = await mkdtemp(join(tmpdir(), "assessment-subjects-"));
const results: Record<string, unknown>[] = [];
try {
  const fixtures = await prepareSubjectFixtures(root);
  const selections = Object.fromEntries(
    await Promise.all(
      ["math/generate", "math/validate", "math/grade"].map(async (route) => [
        route,
        await resolveModel("full", route),
      ]),
    ),
  );
  for (const { book, sources, curriculum } of fixtures)
    for (const kind of ["derive", "compute"] as TaskKind[]) {
      const test: MathTest = {
        id: `${book.id}-${kind}`,
        assessmentVersion: 2,
        taskKinds: [kind],
        publicationId: book.publicationId!,
        curriculumRevision: book.curriculumRevision!,
        difficultyPolicyVersion: "assessment-v1",
        promptVersion: mathPromptVersion,
        modelSelections: selections,
        book,
        chapterIds: book.chapters.map((c) => c.id),
        sourceVersionIds: sources.map((s) => s.versionId),
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
      test.pendingPlans = [
        selectAssessmentPlan(test, curriculum!, [], test.id),
      ];
      try {
        const [question] = await generateMathQuestions(test, sources, {
          curriculum,
          recent: [],
          isDuplicate: async () => false,
        });
        const grade = await gradeMathAnswer(
          test,
          question,
          question.solution,
          sources,
        );
        results.push({
          subject: book.subjectProfile!.subject,
          kind,
          valid: grade.verdict === "correct",
          question,
          grade,
        });
        console.log(`${book.id} ${kind}: ${grade.verdict}`);
      } catch (error) {
        results.push({
          subject: book.subjectProfile!.subject,
          kind,
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        });
        console.log(`${book.id} ${kind}: failed`);
      }
    }
} finally {
  const dir = resolve("data", `assessment-subjects-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "private-results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(
    `Subject evaluation artifacts: ${dir}; ${results.filter((r) => r.valid).length}/${results.length} passed`,
  );
  await rm(root, { recursive: true, force: true });
  await db.terminate();
}
if (results.some((r) => !r.valid)) process.exitCode = 1;

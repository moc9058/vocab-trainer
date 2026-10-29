// Explicitly invoked, paid live-model evaluation. Never part of build, deploy or dry-run.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { installLLMBudgets } from "../src/llm-budget.js";
import { db, getTokenCostConfig } from "../src/firestore.js";
import mathRoutes from "../src/routes/math.js";
import type {
  MathBook,
  MathTest,
  TaskKind,
  MathDifficulty,
  AssessmentCallMetric,
} from "../src/math-types.js";
const args = process.argv.slice(2);
const target = args.find((a) => a.startsWith("--target="))?.slice(9);
if (
  !["production", "emulator"].includes(target ?? "") ||
  args.some(
    (a) =>
      ![
        "--target=production",
        "--target=emulator",
        "--full",
        "--all-chapters",
      ].includes(a),
  )
)
  throw new Error(
    "Usage: math:evaluate -- --target=emulator|production [--full|--all-chapters]",
  );
if ((target === "emulator") !== !!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("Explicit target conflicts with emulator configuration");
const app = Fastify();
app.addHook("onError", async (_req, _reply, error) => {
  const e = error as Error & { status?: number; code?: string; param?: string };
  console.log(
    JSON.stringify({
      errorType: e.name,
      status: e.status,
      code: e.code,
      param: e.param,
      assessmentError: /^(MATH_|INVALID_)/.test(e.message)
        ? e.message
        : undefined,
    }),
  );
});
installLLMBudgets(app);
await app.register(mathRoutes, { prefix: "/api/math" });
const runId = `assessment-eval-${randomUUID()}`;
const ids: string[] = [];
const records: unknown[] = [];
let cancelled = false;
process.once("SIGINT", () => {
  cancelled = true;
});
const post = async (path: string, payload: unknown) => {
  const r = await app.inject({
    method: "POST",
    url: `/api/math${path}`,
    payload,
  });
  if (r.statusCode !== 200)
    throw new Error(`${path}: ${r.statusCode} ${JSON.stringify(r.json())}`);
  return r.json();
};
const summary: {
  runId: string;
  target: string;
  publicationId?: string;
  startedAt: string;
  cases: Record<string, unknown>[];
  finishedAt?: string;
} = { runId, target: target!, startedAt: new Date().toISOString(), cases: [] };
try {
  const book = (
    await db.collection("math_books").doc("linear-algebra").get()
  ).data() as MathBook;
  if (!book?.publicationId) throw new Error("Publish v2 Linear Algebra first");
  summary.publicationId = book.publicationId;
  const tasks: TaskKind[] = ["prove", "determine", "compute", "derive"];
  const cases = args.includes("--full")
    ? book.chapters.flatMap((chapter, i) =>
        (["easy", "standard", "hard"] as MathDifficulty[]).flatMap(
          (difficulty, j) =>
            [0, 1].map((k) => ({
              chapterId: chapter.id,
              difficulty,
              taskKind: tasks[(i * 6 + j * 2 + k) % 4],
            })),
        ),
      )
    : args.includes("--all-chapters")
      ? book.chapters.map((chapter, i) => ({
          chapterId: chapter.id,
          difficulty: "standard" as const,
          taskKind: tasks[i % tasks.length],
        }))
      : [
          {
            chapterId: book.chapters[0].id,
            difficulty: "standard" as const,
            taskKind: "determine" as const,
          },
        ];
  const costs = await getTokenCostConfig();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, cases.length) }, async () => {
      while (!cancelled && cursor < cases.length) {
        const index = cursor++,
          c = cases[index],
          id = `${runId}-${index}`;
        ids.push(id);
        const started = Date.now();
        try {
          let state = await post("/tests", {
            operationId: id,
            bookId: book.id,
            chapterIds: [c.chapterId],
            assessmentVersion: 2,
            taskKinds: [c.taskKind],
            difficulty: c.difficulty,
            mode: "continuous",
          });
          // Server-owned isolation; this field is never accepted from public clients.
          await db
            .collection("math_tests")
            .doc(id)
            .update({ evidenceNamespace: runId });
          state = await post(`/tests/${id}/next`, {
            operationId: randomUUID(),
            version: state.version,
          });
          const snapshot = (
            await db
              .collection("math_tests")
              .doc(id)
              .collection("questions")
              .doc(state.currentQuestionId)
              .get()
          ).data()!;
          const q = snapshot.question;
          // Grade a valid alternative notation of the model solution, never a string-match assertion.
          const answer =
            c.taskKind === "compute"
              ? q.solution.replace(/\\frac\{1\}\{2\}/g, "(1/2)")
              : q.solution;
          state = await post(`/tests/${id}/answer`, {
            operationId: randomUUID(),
            version: state.version,
            questionId: q.id,
            text: answer.slice(0, 5000),
          });
          const graded = (
            await db
              .collection("math_tests")
              .doc(id)
              .collection("questions")
              .doc(q.id)
              .get()
          ).data()!;
          const metrics: AssessmentCallMetric[] = [
            ...(q.generationMetrics ?? []),
            ...(graded.answer.grade.gradingMetrics ?? []),
          ];
          const estimatedCost = metrics.reduce((n, m) => {
            const r = costs?.models[m.model ?? ""];
            return (
              n +
              (r
                ? (((m.promptTokens ?? 0) - (m.cachedTokens ?? 0)) * r.input +
                    (m.cachedTokens ?? 0) * r.cachedInput +
                    (m.completionTokens ?? 0) * r.output) /
                  1e6
                : 0)
            );
          }, 0);
          const row = {
            ...c,
            index,
            questionId: q.id,
            primaryObjectiveId: q.primaryObjectiveId,
            publicationId: q.publicationId,
            elapsedMs: Date.now() - started,
            calls: metrics.length,
            regenerated:
              metrics.filter((m) => m.stage === "generate").length > 1,
            estimatedCost: metrics.every((m) => {
              const r = costs?.models[m.model ?? ""];
              return r && r.input > 0 && r.output > 0;
            })
              ? estimatedCost
              : null,
            grade: graded.answer.grade.verdict,
            metrics,
            valid: graded.answer.grade.verdict === "correct",
          };
          summary.cases.push(row);
          records.push({ index, question: q, grade: graded.answer.grade });
          // Exercise pause/resume and receipt replay against the frozen publication.
          const pause = {
            operationId: randomUUID(),
            version: state.version,
            action: "pause",
          };
          state = await post(`/tests/${id}/state`, pause);
          const replay = await post(`/tests/${id}/state`, pause);
          if (replay.version !== state.version)
            throw new Error("Receipt replay changed version");
          state = await post(`/tests/${id}/state`, {
            operationId: randomUUID(),
            version: state.version,
            action: "resume",
          });
          if (
            state.publicationId !== book.publicationId ||
            state.phase !== "feedback"
          )
            throw new Error("Resume changed frozen publication or phase");
          await post(`/tests/${id}/state`, {
            operationId: randomUUID(),
            version: state.version,
            action: "finish",
          });
          console.log(
            `${index + 1}/${cases.length} ${c.chapterId} ${c.difficulty} ${c.taskKind}: ${row.valid ? "pass" : row.grade}, ${row.elapsedMs}ms, ${metrics.length} calls`,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const failed = (
            await db.collection("math_tests").doc(id).get()
          ).data();
          const diagnostics = failed?.assessmentFailure;
          if (diagnostics) records.push({ index, failure: diagnostics });
          summary.cases.push({
            ...c,
            index,
            ...(diagnostics
              ? {
                  metrics: diagnostics.metrics,
                  calls: diagnostics.metrics.length,
                }
              : {}),
            error: message,
            elapsedMs: Date.now() - started,
            valid: false,
          });
          console.log(`${index + 1}/${cases.length}: failed: ${message}`);
        }
      }
    }),
  );
} finally {
  summary.finishedAt = new Date().toISOString();
  const dir = resolve("data", runId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  await writeFile(
    resolve(dir, "private-questions.json"),
    JSON.stringify(records, null, 2) + "\n",
  );
  for (const id of ids)
    await db.recursiveDelete(db.collection("math_tests").doc(id));
  await db.recursiveDelete(db.collection("math_learning_evidence").doc(runId));
  console.log(
    `Evaluation artifacts: ${dir}; ${summary.cases.filter((c) => c.valid).length}/${summary.cases.length} passed`,
  );
  await app.close();
  await db.terminate();
}
if (cancelled || summary.cases.some((c) => !c.valid)) process.exitCode = 1;

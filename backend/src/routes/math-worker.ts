import type { FastifyPluginAsync } from "fastify";
import { installMathValidator } from "../math-schema.js";
import { verifyMathWorker } from "../math-task-dispatch.js";
import {
  runMathTask,
  reconcileMathJobs,
  type MathTaskPayload,
} from "../math-jobs.js";
export const mathWorkerRoutes: FastifyPluginAsync = async (app) => {
  installMathValidator(app);
  app.addHook("onRequest", async (request, reply) => {
    if (!(await verifyMathWorker(request)))
      return reply.code(401).send({ error: "Unauthorized" });
  });
  app.post<{ Body: MathTaskPayload }>(
    "/run",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["jobId", "generation", "sequence"],
          properties: {
            jobId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
            generation: { type: "integer", minimum: 1 },
            sequence: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (r) => {
      await runMathTask(r.body);
      return { ok: true };
    },
  );
  app.post("/reconcile", async () => ({ checked: await reconcileMathJobs() }));
};

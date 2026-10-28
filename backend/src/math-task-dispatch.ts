import { CloudTasksClient } from "@google-cloud/tasks";
import { OAuth2Client } from "google-auth-library";
import type { FastifyRequest } from "fastify";
import type { MathJob } from "./math-types.js";
let client: CloudTasksClient | undefined;
const verifier = new OAuth2Client();
export const localMathJobs = () => !!process.env.FIRESTORE_EMULATOR_HOST;
export function mathJobsConfigured() {
  return (
    localMathJobs() ||
    [
      "MATH_TASK_PROJECT",
      "MATH_TASK_REGION",
      "MATH_TASK_QUEUE",
      "MATH_WORKER_URL",
      "MATH_TASK_ACCOUNT",
    ].every((k) => !!process.env[k])
  );
}
export async function verifyMathWorker(request: FastifyRequest) {
  if (localMathJobs()) return false;
  const audience = process.env.MATH_WORKER_URL,
    account = process.env.MATH_TASK_ACCOUNT,
    token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!audience || !account || !token) return false;
  try {
    const data = (
      await verifier.verifyIdToken({ idToken: token, audience })
    ).getPayload();
    return (
      !!data &&
      ["accounts.google.com", "https://accounts.google.com"].includes(
        data.iss,
      ) &&
      data.email === account &&
      data.email_verified === true
    );
  } catch {
    return false;
  }
}
export async function enqueueMathJob(job: MathJob) {
  if (localMathJobs()) return;
  if (!mathJobsConfigured()) throw new Error("MATH_WORKER_UNAVAILABLE");
  client ??= new CloudTasksClient();
  const parent = client.queuePath(
    process.env.MATH_TASK_PROJECT!,
    process.env.MATH_TASK_REGION!,
    process.env.MATH_TASK_QUEUE!,
  );
  try {
    await client.createTask(
      {
        parent,
        task: {
          name: `${parent}/tasks/math-${job.id}-${job.generation}-${job.sequence}`,
          dispatchDeadline: { seconds: 600 },
          scheduleTime: {
            seconds: Math.floor(Math.max(Date.now(), job.nextWakeAt) / 1000),
          },
          httpRequest: {
            httpMethod: "POST",
            url: `${process.env.MATH_WORKER_URL}/internal/math/run`,
            headers: { "Content-Type": "application/json" },
            body: Buffer.from(
              JSON.stringify({
                jobId: job.id,
                generation: job.generation,
                sequence: job.sequence,
              }),
            ).toString("base64"),
            oidcToken: {
              serviceAccountEmail: process.env.MATH_TASK_ACCOUNT!,
              audience: process.env.MATH_WORKER_URL!,
            },
          },
        },
      },
      { timeout: 3000, retry: null },
    );
  } catch (err) {
    if ((err as any).code !== 6) throw err;
  }
}

import { execFileSync } from "node:child_process";
const project = process.argv[2],
  region = process.argv[3];
if (!project || !region || !/^[a-z0-9-]+$/.test(project + region))
  throw new Error("Project and region are required");
const windows = process.platform === "win32";
function run(args) {
  const safe = [...args, `--project=${project}`, "--quiet"];
  if (safe.some((a) => /["&|<>^%!]/.test(a)))
    throw new Error("Unsafe gcloud argument");
  return execFileSync(
    windows ? "gcloud.cmd" : "gcloud",
    windows ? safe.map((a) => `"${a}"`) : safe,
    { encoding: "utf8", shell: windows, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}
const service = JSON.parse(
  run([
    "run",
    "services",
    "describe",
    "vocab-trainer-backend",
    `--region=${region}`,
    "--format=json",
  ]),
);
const env = Object.fromEntries(
  (service.spec.template.spec.containers[0].env ?? [])
    .filter((e) => e.name.startsWith("MATH_"))
    .map((e) => [e.name, e.value]),
);
if (!Object.keys(env).length) {
  console.log("Mathematics worker not enabled; browse remains available.");
  process.exit(0);
}
if (
  ![
    "MATH_TASK_PROJECT",
    "MATH_TASK_QUEUE",
    "MATH_TASK_REGION",
    "MATH_TASK_ACCOUNT",
    "MATH_WORKER_URL",
  ].every((k) => env[k])
)
  throw new Error(
    "Durable math infrastructure is missing. Run: npx --prefix backend tsx backend/scripts/setup-math-jobs.ts PROJECT REGION",
  );
if (
  env.MATH_TASK_PROJECT !== project ||
  env.MATH_TASK_REGION !== region ||
  env.MATH_WORKER_URL !== service.status.url
)
  throw new Error("Math worker configuration does not match the deployment");
const queue = JSON.parse(
  run([
    "tasks",
    "queues",
    "describe",
    env.MATH_TASK_QUEUE,
    `--location=${region}`,
    "--format=json",
  ]),
);
if (queue.state !== "RUNNING" || queue.rateLimits.maxConcurrentDispatches !== 1)
  throw new Error("Math queue must be running with concurrency 1");
const scheduler = JSON.parse(
  run([
    "scheduler",
    "jobs",
    "describe",
    "math-reconcile",
    `--location=${region}`,
    "--format=json",
  ]),
);
if (
  scheduler.state !== "ENABLED" ||
  scheduler.httpTarget?.oidcToken?.serviceAccountEmail !==
    env.MATH_TASK_ACCOUNT ||
  scheduler.httpTarget?.oidcToken?.audience !== env.MATH_WORKER_URL ||
  scheduler.httpTarget?.uri !== env.MATH_WORKER_URL + "/internal/math/reconcile"
)
  throw new Error("Import recovery scheduler/OIDC configuration is invalid");
console.log("Durable mathematics deployment prerequisites verified.");

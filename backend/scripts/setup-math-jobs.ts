// Explicit infrastructure setup; normal deploys only preserve/validate this configuration.
import { execFileSync, spawnSync } from "node:child_process";
const project = process.argv[2] ?? "vocab-trainer-490014";
const region = process.argv[3] ?? "asia-northeast1";
const windows = process.platform === "win32";
const gcloud = windows ? "gcloud.cmd" : "gcloud";
function cliArgs(args: string[]): string[] {
  if (args.some((a) => /["&|<>^%!]/.test(a)))
    throw new Error("Unsafe gcloud argument");
  return windows ? args.map((a) => `"${a}"`) : args;
}
function run(args: string[]): string {
  return execFileSync(
    gcloud,
    cliArgs([...args, `--project=${project}`, "--quiet"]),
    { encoding: "utf8", shell: windows, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}
function exists(args: string[]): boolean {
  const p = spawnSync(
    gcloud,
    cliArgs([...args, `--project=${project}`, "--quiet"]),
    { encoding: "utf8", shell: windows },
  );
  if (p.status === 0) return true;
  if (/NOT_FOUND|does not exist|not found/i.test(p.stderr)) return false;
  throw new Error(p.stderr);
}
console.log("Enabling durable math infrastructure…");
run([
  "services",
  "enable",
  "cloudtasks.googleapis.com",
  "cloudscheduler.googleapis.com",
]);
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
const url = service.status.url as string;
const backendAccount = service.spec.template.spec.serviceAccountName as string;
const account = `math-task-invoker@${project}.iam.gserviceaccount.com`;
if (!exists(["iam", "service-accounts", "describe", account]))
  run([
    "iam",
    "service-accounts",
    "create",
    "math-task-invoker",
    "--display-name=Math task invoker",
  ]);
run([
  "iam",
  "service-accounts",
  "add-iam-policy-binding",
  account,
  `--member=serviceAccount:${backendAccount}`,
  "--role=roles/iam.serviceAccountUser",
]);
run([
  "projects",
  "add-iam-policy-binding",
  project,
  `--member=serviceAccount:${backendAccount}`,
  "--role=roles/cloudtasks.enqueuer",
  "--condition=None",
]);
run([
  "run",
  "services",
  "add-iam-policy-binding",
  "vocab-trainer-backend",
  `--region=${region}`,
  `--member=serviceAccount:${account}`,
  "--role=roles/run.invoker",
]);
const queue = "math";
const queueArgs = [
  `--location=${region}`,
  "--max-concurrent-dispatches=1",
  "--max-dispatches-per-second=1",
  "--max-attempts=10",
  "--min-backoff=30s",
  "--max-backoff=300s",
];
run([
  "tasks",
  "queues",
  exists(["tasks", "queues", "describe", queue, `--location=${region}`])
    ? "update"
    : "create",
  queue,
  ...queueArgs,
]);
const scheduler = "math-reconcile";
run([
  "scheduler",
  "jobs",
  exists(["scheduler", "jobs", "describe", scheduler, `--location=${region}`])
    ? "update"
    : "create",
  "http",
  scheduler,
  `--location=${region}`,
  "--schedule=* * * * *",
  "--time-zone=Etc/UTC",
  `--uri=${url}/internal/math/reconcile`,
  "--http-method=POST",
  `--oidc-service-account-email=${account}`,
  `--oidc-token-audience=${url}`,
  "--attempt-deadline=120s",
]);
run([
  "run",
  "services",
  "update",
  "vocab-trainer-backend",
  `--region=${region}`,
  `--update-env-vars=MATH_TASK_PROJECT=${project},MATH_TASK_REGION=${region},MATH_TASK_QUEUE=${queue},MATH_WORKER_URL=${url},MATH_TASK_ACCOUNT=${account}`,
]);
console.log(
  "Math queue, OIDC account, recovery scheduler and backend configuration are ready.",
);

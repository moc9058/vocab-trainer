import { spawnSync } from "node:child_process";
const project = "demo-vocab-math",
  host = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
if (process.env.FIRESTORE_PROJECT && process.env.FIRESTORE_PROJECT !== project)
  throw new Error("Mathematics tests refuse non-demo projects");
if (
  process.env.FIRESTORE_DATABASE_ID &&
  process.env.FIRESTORE_DATABASE_ID !== "(default)"
)
  throw new Error("Mathematics tests require (default) database");
if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host))
  throw new Error("Mathematics tests require a local emulator");
try {
  const r = await fetch(`http://${host}`);
  if (!r.ok) throw new Error("unreachable");
} catch {
  throw new Error("Start the emulator: docker compose up -d firestore");
}
const result = spawnSync(
  process.execPath,
  [
    "--experimental-test-module-mocks",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "scripts/tests/emulator/math.test.ts",
    "scripts/tests/emulator/math-source.test.ts",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      FIRESTORE_EMULATOR_HOST: host,
      FIRESTORE_PROJECT: project,
      FIRESTORE_DATABASE_ID: "(default)",
    },
  },
);
process.exit(result.status ?? 1);

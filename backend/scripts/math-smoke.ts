import assert from "node:assert/strict";
import { resolve } from "node:path";
if (!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("Smoke test requires emulator");
process.env.FIRESTORE_PROJECT ||= "vocab-trainer-490014";
process.env.FIRESTORE_DATABASE_ID ||= "vocab-database";
const origin = new URL(process.argv[2] ?? "http://127.0.0.1:5173");
if (!["127.0.0.1", "localhost"].includes(origin.hostname))
  throw new Error("Local smoke refuses remote origins");
const { buildCatalog } = await import("../src/math-content.js");
const { publishCatalog, activeCatalogId, mathDb } =
  await import("../src/math-store.js");
const { loadAuthConfig, signSession } = await import("../src/auth-config.js");
const fixture = await buildCatalog(resolve("data/math-verification"));
await publishCatalog(
  fixture.catalog,
  fixture.sources,
  fixture.provenances,
  await activeCatalogId(),
);
const auth = await loadAuthConfig();
const headers: Record<string, string> = auth
  ? {
      cookie: `vt_session=${signSession({ email: auth.allowedEmails[0] }, auth.sessionSecret)}`,
    }
  : {};
const html = await fetch(origin);
assert.equal(html.status, 200);
assert((await html.text()).includes("/assets/"));
const catalog = await fetch(new URL("/api/math/catalog", origin), { headers });
assert.equal(catalog.status, 200);
assert(
  ((await catalog.json()) as any).subjects.some(
    (s: any) => s.id === "linear-algebra",
  ),
);
const worker = await fetch(new URL("/internal/math/run", origin), {
  method: "POST",
  headers,
});
// nginx exposes only /api; worker is also checked directly on the backend below.
const denied = await fetch("http://127.0.0.1:3000/internal/math/run", {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({ jobId: "fake-job", generation: 1, sequence: 0 }),
});
assert.equal(denied.status, 401);
const preview = await fetch(new URL("/api/math/scope-previews", origin), {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({
    subjectId: "linear-algebra",
    selectedNodeIds: ["chapter-1"],
    difficulty: 2,
    questionCount: 1,
    responseLanguage: "en",
    answerFormats: ["text"],
  }),
});
assert.equal(preview.status, 200);
const scope = (await preview.json()) as any;
assert.equal(scope.targetObjectiveIds.length, 1);
assert.equal(scope.prerequisites.length, 2);
console.log(
  "Docker smoke passed: frontend assets, catalog with existing auth posture, Linear Algebra scope, worker cookie refusal. No real LLM calls.",
);
await mathDb.terminate();

/** Adds mathematics indexes/exemptions; never replaces a database index file. */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
const project = process.argv[2],
  database = process.argv[3];
if (
  !project ||
  !database ||
  !/^[a-z0-9-]+$/.test(project) ||
  !/^[a-z0-9()-]+$/.test(database) ||
  process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error("Specify the cloud project and database explicitly");
const windows = process.platform === "win32";
function run(args: string[]) {
  const complete = [
    ...args,
    `--project=${project}`,
    `--database=${database}`,
    "--quiet",
  ];
  if (complete.some((a) => /["&|<>^%!]/.test(a)))
    throw new Error("Unsafe CLI argument");
  return execFileSync(
    windows ? "gcloud.cmd" : "gcloud",
    windows ? complete.map((a) => `"${a}"`) : complete,
    { shell: windows, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}
const desired = JSON.parse(
  await readFile(
    new URL("../firestore.math.indexes.json", import.meta.url),
    "utf8",
  ),
);
const current = JSON.parse(
  run(["firestore", "indexes", "composite", "list", "--format=json"]),
);
for (const index of desired.indexes) {
  const match = current.some(
    (actual: any) =>
      actual.name.includes(`/collectionGroups/${index.collectionGroup}/`) &&
      actual.queryScope === index.queryScope &&
      JSON.stringify(
        actual.fields.filter((f: any) => f.fieldPath !== "__name__"),
      ) === JSON.stringify(index.fields),
  );
  if (match) {
    console.log(
      `Present: ${index.collectionGroup} ${index.fields.map((f: any) => f.fieldPath).join(", ")}`,
    );
    continue;
  }
  console.log(`Adding: ${index.collectionGroup}`);
  run([
    "firestore",
    "indexes",
    "composite",
    "create",
    `--collection-group=${index.collectionGroup}`,
    "--query-scope=COLLECTION",
    ...index.fields.map(
      (f: any) =>
        `--field-config=field-path=${f.fieldPath},order=${f.order.toLowerCase()}`,
    ),
    "--async",
  ]);
}
for (const field of desired.fieldOverrides) {
  console.log(`Exempting: ${field.collectionGroup}.${field.fieldPath}`);
  run([
    "firestore",
    "indexes",
    "fields",
    "update",
    field.fieldPath,
    `--collection-group=${field.collectionGroup}`,
    "--disable-indexes",
    "--async",
  ]);
}
console.log(
  "Mathematics index operations submitted. Wait for READY before cloud verification.",
);

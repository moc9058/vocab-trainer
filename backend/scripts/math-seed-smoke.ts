/** Adds only minimal boot config to an existing emulator; never wipes it or reads production. */
import { Firestore } from "@google-cloud/firestore";
import { readFile } from "node:fs/promises";
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Emulator required");
const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT ?? "vocab-trainer-490014",
  databaseId: process.env.FIRESTORE_DATABASE_ID ?? "vocab-database",
});
const docs = JSON.parse(
  await readFile("data/local-seed/config.json", "utf8"),
) as { id: string; data: Record<string, unknown> }[];
for (const id of [
  "vocabulary",
  "grammar",
  "import",
  "translation",
  "speaking_writing",
]) {
  const ref = db.collection("config").doc(id),
    existing = await ref.get();
  if (!existing.exists) {
    const source = docs.find((d) => d.id === id);
    if (!source) throw new Error(`Missing local config ${id}`);
    await ref.set(source.data);
  }
}
await db.terminate();
console.log(
  "Emulator boot configuration ready; existing learning data preserved.",
);

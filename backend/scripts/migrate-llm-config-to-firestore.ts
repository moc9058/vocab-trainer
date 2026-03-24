/**
 * Migration script: uploads LLM config from local .env to Firestore.
 *
 * Usage:
 *   cd backend && npx tsx scripts/migrate-llm-config-to-firestore.ts
 *
 * Reads AZURE_OPENAI_* vars from ../.env and writes them to
 * Firestore document `config/llm` in the vocab-database.
 */

import { Firestore } from "@google-cloud/firestore";
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root
config({ path: resolve(__dirname, "../../.env") });

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
});

const KEYS = [
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME",
] as const;

async function main() {
  const data: Record<string, string> = {};
  const missing: string[] = [];

  for (const key of KEYS) {
    const val = process.env[key];
    if (val) {
      data[key] = val;
    } else {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    console.error("Set them in .env or as environment variables.");
    process.exit(1);
  }

  console.log("Writing LLM config to Firestore config/llm...");
  await db.collection("config").doc("llm").set(data);
  console.log("Done. Keys stored:", Object.keys(data).join(", "));
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

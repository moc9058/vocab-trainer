import { readFile, writeFile, readdir, rename, unlink, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { VocabFile, ProgressFile } from "./types.js";

const DB_DIR = resolve(import.meta.dirname, "..", "DB");
const DATA_DIR = resolve(import.meta.dirname, "..", "data");
const PROGRESS_DIR = join(DATA_DIR, "progress");


async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const data = await readFile(path, "utf-8");
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

async function writeJson<T>(path: string, data: T): Promise<void> {
  const dir = join(path, "..");
  await ensureDir(dir);
  const tmp = path + "." + randomBytes(6).toString("hex") + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, path);
}

// --- Vocab files ---

export async function listVocabFiles(): Promise<string[]> {
  try {
    const files = await readdir(DB_DIR);
    return files.filter((f) => f.endsWith(".json") && !f.startsWith("id_map_")).sort();
  } catch {
    return [];
  }
}

export async function readVocabFile(language: string): Promise<VocabFile | null> {
  return readJson<VocabFile>(join(DB_DIR, `${language}.json`));
}

export async function writeVocabFile(language: string, data: VocabFile): Promise<void> {
  await ensureDir(DB_DIR);
  await writeJson(join(DB_DIR, `${language}.json`), data);
}

export async function deleteVocabFile(language: string): Promise<boolean> {
  const path = join(DB_DIR, `${language}.json`);
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

// --- Progress files ---

export async function readProgressFile(language: string): Promise<ProgressFile> {
  const data = await readJson<ProgressFile>(join(PROGRESS_DIR, `${language}.json`));
  return data ?? { language, words: {} };
}

export async function writeProgressFile(language: string, data: ProgressFile): Promise<void> {
  await writeJson(join(PROGRESS_DIR, `${language}.json`), data);
}

export async function deleteProgressFile(language: string): Promise<boolean> {
  const path = join(PROGRESS_DIR, `${language}.json`);
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}


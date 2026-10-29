import {
  mathPromptFiles,
  mathPromptVersion,
  parseMathPromptFiles,
} from "./math-prompt-loader.js";
import { canonical } from "./math-curriculum.js";
const cache = new Map<string, ReturnType<typeof parseMathPromptFiles>>();
export async function ensureMathPromptVersion(): Promise<void> {
  const { db } = await import("./firestore.js");
  const ref = db.collection("math_prompt_versions").doc(mathPromptVersion);
  const data = { version: mathPromptVersion, files: mathPromptFiles };
  if (Buffer.byteLength(JSON.stringify(data)) > 64000)
    throw new Error("MATH_PROMPTS_TOO_LARGE");
  await db.runTransaction(async (tx) => {
    const old = await tx.get(ref);
    if (old.exists) {
      if (canonical(old.data()) !== canonical(data))
        throw new Error("MATH_PROMPT_VERSION_CONFLICT");
    } else tx.create(ref, data);
  });
}
export async function loadMathPromptVersion(version: string | undefined) {
  if (version === mathPromptVersion)
    return parseMathPromptFiles(mathPromptFiles);
  const fail = (): never => {
    throw Object.assign(new Error("MATH_PROMPT_VERSION_UNAVAILABLE"), {
      statusCode: 409,
    });
  };
  if (!version || !/^[a-f0-9]{64}$/.test(version)) return fail();
  const saved = cache.get(version);
  if (saved) return saved;
  const { db } = await import("./firestore.js");
  const doc = await db.collection("math_prompt_versions").doc(version).get();
  if (!doc.exists) return fail();
  try {
    const parsed = parseMathPromptFiles(doc.get("files"));
    if (parsed.version !== version) return fail();
    cache.set(version, parsed);
    return parsed;
  } catch {
    return fail();
  }
}

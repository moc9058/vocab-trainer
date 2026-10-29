import { readFileSync } from "node:fs";
import { mathHash } from "./math-core.js";
const names = [
  "generate.md",
  "solve.md",
  "validate.md",
  "grade.md",
  "difficulty-policy.json",
  "anchors.json",
  "subject-profiles.json",
] as const;
const files = Object.fromEntries(
  names.map((name) => [
    name,
    readFileSync(new URL(`./math-prompts/${name}`, import.meta.url), "utf8"),
  ]),
);
export const mathPromptVersion = mathHash(
  names.map((n) => files[n]).join("\n"),
);
export const mathPrompts = {
  generate: files["generate.md"],
  solve: files["solve.md"],
  validate: files["validate.md"],
  grade: files["grade.md"],
};
export const difficultyPolicy = JSON.parse(files["difficulty-policy.json"]);
export const anchors = JSON.parse(files["anchors.json"]).anchors as {
  objectiveId: string;
  difficulty: string;
  prompt: string;
}[];
export const subjectProfiles = JSON.parse(files["subject-profiles.json"]);

export const mathPromptFiles = files;
export function parseMathPromptFiles(raw: Record<string, string>) {
  if (names.some((n) => typeof raw[n] !== "string" || !raw[n].trim()))
    throw new Error("MATH_PROMPT_VERSION_UNAVAILABLE");
  return {
    version: mathHash(names.map((n) => raw[n]).join("\n")),
    prompts: {
      generate: raw["generate.md"],
      solve: raw["solve.md"],
      validate: raw["validate.md"],
      grade: raw["grade.md"],
    },
    difficultyPolicy: JSON.parse(raw["difficulty-policy.json"]),
    anchors: JSON.parse(raw["anchors.json"]).anchors as typeof anchors,
    subjectProfiles: JSON.parse(raw["subject-profiles.json"]),
  };
}

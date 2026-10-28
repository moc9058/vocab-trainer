/** Local authoring only: packages are untrusted data, never executable paths or commands. */
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  lstat,
  readdir,
  copyFile,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { z } from "zod";
import { stringify as yamlStringify } from "yaml";
const stringify = (value: unknown) =>
  yamlStringify(value, { aliasDuplicateObjects: false });
import {
  parseUnit,
  sourceDocumentSchema,
  provenanceSchema,
  compileUnit,
  safePath,
  parseYaml,
  readSafe,
  buildCatalog,
} from "./math-content.js";
import {
  contentHash,
  idSchema,
  invariant,
  checkBytes,
  MATH_LIMITS,
} from "./math-schema.js";
export const packageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  subject: z.strictObject({ id: idSchema, title: z.string().min(1) }),
  units: z
    .array(
      z.strictObject({
        markdown: z.string().max(524288),
        provenance: provenanceSchema,
      }),
    )
    .min(1)
    .max(100),
  sources: z.array(sourceDocumentSchema).default([]),
  coverage: z.array(
    z.strictObject({
      page: z.number().int().positive(),
      status: z.enum(["processed", "partial", "unreadable"]),
      omissions: z.array(z.string()),
    }),
  ),
  unresolved: z.array(z.string()),
});
export interface AuthoringRun {
  schemaVersion: 1;
  root: string;
  packageHash: string;
  package: z.infer<typeof packageSchema>;
  baseHashes: Record<string, string | null>;
  reviewHash: string;
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as any).code === "ENOENT") return false;
    throw error;
  }
}
async function existingHash(root: string, path: string) {
  return (await exists(resolve(root, path)))
    ? contentHash(await readSafe(root, path))
    : null;
}
export function receiptFor(
  markdown: string,
  provenance: unknown,
  reviewedBy: string,
) {
  const { meta, normalized } = parseUnit(markdown);
  return {
    schemaVersion: 1 as const,
    unitId: meta.unitId,
    contentHash: contentHash(normalized),
    provenanceHash: contentHash(provenanceSchema.parse(provenance)),
    policyVersion: "math-review-1" as const,
    acceptedAt: Date.now(),
    reviewedBy,
    acceptedObjectiveIds: meta.objectives
      .filter(
        (o) => !meta.unresolved.some((u) => u.objectiveIds.includes(o.id)),
      )
      .map((o) => o.id),
    acceptedConceptIds: meta.knowledgeItems
      .filter((k) => !meta.unresolved.some((u) => u.conceptIds.includes(k.id)))
      .map((k) => k.id),
  };
}
function unitFiles(subjectId: string, unitId: string) {
  return {
    markdown: `${subjectId}/units/unit-${unitId}.md`,
    provenance: `${subjectId}/provenance/${unitId}.yaml`,
    review: `${subjectId}/reviews/${unitId}.yaml`,
  };
}
export async function importAuthorPackage(
  input: unknown,
  root: string,
  runDirectory: string,
) {
  if ((input as any)?.schemaVersion === 2) {
    const { importJsonAuthorPackage } = await import("./math-json-authoring.js");
    return importJsonAuthorPackage(input, root, runDirectory);
  }
  // Legacy package adapter is retained for explicit migration of existing authoring runs.
  checkBytes(input, 20 * MATH_LIMITS.markdownBytes);
  const pkg = packageSchema.parse(input),
    baseHashes: Record<string, string | null> = {};
  invariant(
    new Set(pkg.units.map((u) => parseUnit(u.markdown).meta.unitId)).size ===
      pkg.units.length,
    "E_DUPLICATE_UNIT_ID",
  );
  for (const u of pkg.units) {
    const { meta } = parseUnit(u.markdown);
    compileUnit(
      u.markdown,
      u.provenance,
      receiptFor(u.markdown, u.provenance, "validation-only"),
      pkg.subject.id,
      pkg.subject.title,
    );
    for (const file of Object.values(unitFiles(pkg.subject.id, meta.unitId)))
      baseHashes[file] = await existingHash(root, file);
  }
  for (const source of pkg.sources)
    baseHashes[`${pkg.subject.id}/sources/source-${source.sourceId}.yaml`] =
      await existingHash(
        root,
        `${pkg.subject.id}/sources/source-${source.sourceId}.yaml`,
      );
  for (const file of [
    "math.catalog.yaml",
    `${pkg.subject.id}/subject.yaml`,
    `${pkg.subject.id}/curriculum.yaml`,
  ])
    baseHashes[file] = await existingHash(root, file);
  const body = {
    schemaVersion: 1 as const,
    root: await safePath(root, "."),
    packageHash: contentHash(pkg),
    package: pkg,
    baseHashes,
  };
  const run: AuthoringRun = { ...body, reviewHash: contentHash(body) };
  await mkdir(runDirectory, { recursive: true });
  invariant(
    !(await exists(join(runDirectory, "run.json"))),
    "E_RUN_EXISTS",
    409,
  );
  await writeFile(join(runDirectory, "run.json"), JSON.stringify(run, null, 2));
  return run;
}
export async function reviewAuthorRun(runDirectory: string) {
  if (JSON.parse(await readFile(join(runDirectory, "run.json"), "utf8")).schemaVersion === 2) {
    const { reviewJsonAuthorRun } = await import("./math-json-authoring.js");
    return reviewJsonAuthorRun(runDirectory);
  }
  const run = JSON.parse(
    await readFile(join(runDirectory, "run.json"), "utf8"),
  ) as AuthoringRun;
  const { reviewHash, ...body } = run;
  invariant(
    contentHash(body) === reviewHash &&
      contentHash(packageSchema.parse(run.package)) === run.packageHash,
    "E_REVIEW_HASH_MISMATCH",
  );
  return {
    reviewHash,
    root: run.root,
    units: run.package.units.map((u) => {
      const { meta, blocks } = parseUnit(u.markdown);
      return {
        id: meta.unitId,
        title: meta.title,
        objectives: meta.objectives,
        knowledge: meta.knowledgeItems,
        blocks,
        provenance: u.provenance,
        unresolved: meta.unresolved,
        change: run.baseHashes[
          unitFiles(run.package.subject.id, meta.unitId).markdown
        ]
          ? "modified"
          : "new",
      };
    }),
    unresolved: run.package.unresolved,
    coverage: run.package.coverage,
  };
}
export async function acceptAuthorRun(
  runDirectory: string,
  unitIds: string[],
  expectedHash: string,
  reviewedBy: string,
) {
  if (JSON.parse(await readFile(join(runDirectory, "run.json"), "utf8")).schemaVersion === 2) {
    const { acceptJsonAuthorRun } = await import("./math-json-authoring.js");
    return acceptJsonAuthorRun(runDirectory, unitIds, expectedHash, reviewedBy);
  }
  invariant(false, "E_LEGACY_AUTHORING_READ_ONLY", 409, {
    nextStep: "Export a schemaVersion:2 JSON chapter package and review it before accepting.",
  });
}

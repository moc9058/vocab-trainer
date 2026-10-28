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
  const review = await reviewAuthorRun(runDirectory),
    run = JSON.parse(
      await readFile(join(runDirectory, "run.json"), "utf8"),
    ) as AuthoringRun;
  invariant(review.reviewHash === expectedHash, "E_REVIEW_HASH_MISMATCH", 409);
  invariant(
    unitIds.length > 0 &&
      new Set(unitIds).size === unitIds.length &&
      unitIds.every((id) => review.units.some((u: { id: string }) => u.id === id)),
    "E_UNKNOWN_UNIT",
  );
  invariant(!run.package.unresolved.length, "E_UNRESOLVED_PACKAGE");
  const journalPath = join(runDirectory, "accept-journal.json");
  if (await exists(journalPath)) {
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    invariant(
      journal.reviewHash === expectedHash &&
        contentHash(journal.unitIds) === contentHash(unitIds),
      "E_ACCEPT_IN_PROGRESS",
      409,
    );
    await finishJournal(run, journal, journalPath);
    return;
  }
  const writes: Record<string, string> = {},
    subjectId = run.package.subject.id,
    prefix = `${subjectId}/`;
  const manifest = run.baseHashes["math.catalog.yaml"]
    ? (parseYaml(await readSafe(run.root, "math.catalog.yaml")) as any)
    : { schemaVersion: 1, subjects: [] };
  const entry = manifest.subjects.find((s: any) => s.id === subjectId);
  invariant(!entry || entry.path === subjectId, "E_SUBJECT_PATH_CONFLICT", 409);
  if (!entry) manifest.subjects.push({ id: subjectId, path: subjectId });
  const subject = run.baseHashes[prefix + "subject.yaml"]
    ? (parseYaml(await readSafe(run.root, prefix + "subject.yaml")) as any)
    : {
        schemaVersion: 1,
        id: subjectId,
        title: run.package.subject.title,
        rootNodeId: `${subjectId}-root`,
        order: 0,
        foundationProfileIds: [],
        units: [],
        profiles: [],
        sources: [],
      };
  const curriculum = run.baseHashes[prefix + "curriculum.yaml"]
    ? (parseYaml(await readSafe(run.root, prefix + "curriculum.yaml")) as any)
    : {
        schemaVersion: 1,
        subjectId,
        nodes: [
          {
            id: subject.rootNodeId,
            parentId: null,
            kind: "subject",
            title: subject.title,
            order: 0,
            unitIds: [],
          },
        ],
      };
  for (const u of run.package.units) {
    const { meta } = parseUnit(u.markdown);
    if (!unitIds.includes(meta.unitId)) continue;
    const receipt = receiptFor(u.markdown, u.provenance, reviewedBy);
    const result = compileUnit(
      u.markdown,
      u.provenance,
      receipt,
      subjectId,
      subject.title,
    );
    invariant(
      result.objectives.some((o) => o.readiness === "ready") ||
        !result.objectives.length,
      "E_UNIT_BLOCKED",
      409,
    );
    const files = unitFiles(subjectId, meta.unitId);
    writes[files.markdown] = u.markdown.replace(/\r\n?/g, "\n");
    writes[files.provenance] = stringify(u.provenance);
    writes[files.review] = stringify(receipt);
    const ref = {
      id: meta.unitId,
      path: `units/unit-${meta.unitId}.md`,
      provenance: `provenance/${meta.unitId}.yaml`,
      review: `reviews/${meta.unitId}.yaml`,
    };
    const index = subject.units.findIndex((v: any) => v.id === meta.unitId);
    if (index >= 0) subject.units[index] = ref;
    else subject.units.push(ref);
    if (!curriculum.nodes.some((n: any) => n.unitIds.includes(meta.unitId)))
      curriculum.nodes[0].unitIds.push(meta.unitId);
  }
  for (const source of run.package.sources) {
    const file = `sources/source-${source.sourceId}.yaml`;
    writes[prefix + file] = stringify(source);
    if (!subject.sources.includes(file)) subject.sources.push(file);
  }
  writes["math.catalog.yaml"] = stringify(manifest);
  writes[prefix + "subject.yaml"] = stringify(subject);
  writes[prefix + "curriculum.yaml"] = stringify(curriculum);
  for (const path of Object.keys(writes))
    invariant(
      (await existingHash(run.root, path)) === (run.baseHashes[path] ?? null),
      "E_AUTHORING_CONFLICT",
      409,
      { path },
    );
  // Compile the full proposed tree before touching an authoring original.
  const stage = join(runDirectory, "staged-root");
  await mkdir(stage, { recursive: true });
  await copyTree(run.root, stage);
  for (const [path, text] of Object.entries(writes)) {
    const target = join(stage, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  await buildCatalog(stage);
  const journal = {
    reviewHash: expectedHash,
    unitIds,
    writes,
    baseHashes: run.baseHashes,
    state: "prepared",
  };
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  await finishJournal(run, journal, journalPath);
}
async function copyTree(root: string, destination: string) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    invariant(!entry.isSymbolicLink(), "E_SYMLINK");
    const from = join(root, entry.name),
      to = join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyTree(from, to);
    } else if (/\.(md|yaml)$/.test(entry.name)) await copyFile(from, to);
  }
}
async function finishJournal(
  run: AuthoringRun,
  journal: any,
  journalPath: string,
) {
  for (const [path, text] of Object.entries(journal.writes) as [
    string,
    string,
  ][]) {
    const current = await existingHash(run.root, path);
    invariant(
      current === (journal.baseHashes[path] ?? null) ||
        current === contentHash(text),
      "E_AUTHORING_CONFLICT",
      409,
      { path },
    );
    const target = resolve(run.root, path);
    await mkdir(dirname(target), { recursive: true });
    await safePath(run.root, dirname(path));
    if (current !== contentHash(text)) {
      await writeFile(`${target}.math-tmp`, text, { flag: "wx" }).catch(
        async (e) => {
          if (e.code !== "EEXIST") throw e;
          invariant(
            contentHash(await readFile(`${target}.math-tmp`, "utf8")) ===
              contentHash(text),
            "E_AUTHORING_CONFLICT",
            409,
          );
        },
      );
      await rename(`${target}.math-tmp`, target);
    }
  }
  journal.state = "completed";
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
}

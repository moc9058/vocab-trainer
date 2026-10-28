import { resolve, join, basename } from "node:path";
import { readFile, mkdir, readdir, writeFile, lstat } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  buildCatalog,
  parseUnit,
  parseYaml,
  safePath,
  markdownAst,
} from "../src/math-content.js";
import { contentHash, invariant } from "../src/math-schema.js";
import {
  importAuthorPackage,
  reviewAuthorRun,
  acceptAuthorRun,
} from "../src/math-authoring.js";
import { parseStrictJson } from "../src/math-json-content.js";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string" },
    run: { type: "string" },
    package: { type: "string" },
    units: { type: "string" },
    "expected-review-hash": { type: "string" },
    "reviewed-by": { type: "string" },
    "dry-run": { type: "boolean" },
    publish: { type: "boolean" },
    production: { type: "boolean" },
    project: { type: "string" },
    database: { type: "string" },
    "manifest-hash": { type: "string" },
    "expected-active-catalog-id": { type: "string" },
    rollback: { type: "string" },
    subject: { type: "string" },
    "source-id": { type: "string" },
    pdf: { type: "string" },
    pages: { type: "string" },
    "plan-only": { type: "boolean" },
    "export-request": { type: "boolean" },
    adapter: { type: "string" },
    "semantic-policy": { type: "string" },
    output: { type: "string" },
    "local-endpoint": { type: "string" },
    "local-model": { type: "string" },
    resume: { type: "boolean" },
  },
});
const command = positionals[0],
  root = resolve(values.root ?? "../textbook");
console.log(
  JSON.stringify({
    command,
    root,
    project: values.project ?? "demo-vocab-math",
    database: values.database ?? "(default)",
    emulator: process.env.FIRESTORE_EMULATOR_HOST ?? null,
  }),
);
if (command === "validate") {
  const result = await buildCatalog(root);
  console.log(
    JSON.stringify(
      {
        id: result.catalog.id,
        counts: Object.fromEntries(
          ["subjects", "nodes", "units", "concepts", "objectives"].map((k) => [
            k,
            (result.catalog as any)[k].length,
          ]),
        ),
        warnings: result.warnings,
      },
      null,
      2,
    ),
  );
} else if (command === "manifest") {
  const subjects = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    invariant(!entry.isSymbolicLink(), "E_SYMLINK");
    if (entry.isDirectory())
      subjects.push({
        title: entry.name,
        path: entry.name,
        proposedId: entry.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, ""),
        files: (await readdir(join(root, entry.name))).filter((name) =>
          /\.(pdf|md)$/i.test(name),
        ),
      });
  }
  console.log(JSON.stringify({ proposalOnly: true, subjects }, null, 2));
} else if (command === "sync") {
  if (values.production) {
    invariant(
      !process.env.FIRESTORE_EMULATOR_HOST &&
        values.project === "vocab-trainer-490014" &&
        values.database === "vocab-database",
      "E_PRODUCTION_TARGET_REQUIRED",
    );
  } else
    invariant(
      process.env.FIRESTORE_EMULATOR_HOST &&
        (!values.project || values.project === "demo-vocab-math") &&
        (!values.database || values.database === "(default)"),
      "E_EMULATOR_REQUIRED",
    );
  process.env.FIRESTORE_PROJECT = values.project ?? "demo-vocab-math";
  process.env.FIRESTORE_DATABASE_ID = values.database ?? "(default)";
  const { activeCatalogId, publishCatalog, rollbackCatalog, loadCatalog } =
    await import("../src/math-store.js");
  const current = await activeCatalogId();
  if (values.rollback) {
    invariant(
      values["expected-active-catalog-id"] !== undefined,
      "E_EXPECTED_CATALOG_REQUIRED",
    );
    await rollbackCatalog(
      values.rollback,
      values["expected-active-catalog-id"] === "none"
        ? null
        : values["expected-active-catalog-id"]!,
    );
    console.log("Catalog pointer rolled back");
  } else {
    const result = await buildCatalog(root);
    const previous = current ? await loadCatalog(current) : null;
    console.log(
      JSON.stringify(
        {
          manifestHash: result.catalog.id,
          expectedActiveCatalogId: current,
          addedObjectives: result.catalog.objectives
            .filter((o) => !previous?.objectives.some((p) => p.id === o.id))
            .map((o) => o.id),
          removedObjectives:
            previous?.objectives
              .filter(
                (o) => !result.catalog.objectives.some((p) => p.id === o.id),
              )
              .map((o) => o.id) ?? [],
          warnings: result.warnings,
        },
        null,
        2,
      ),
    );
    if (values.publish) {
      if (values.production)
        invariant(
          values["manifest-hash"] === result.catalog.id &&
            values["expected-active-catalog-id"] !== undefined,
          "E_DRY_RUN_CONFIRMATION_REQUIRED",
        );
      const expected =
        values["expected-active-catalog-id"] === undefined
          ? current
          : values["expected-active-catalog-id"] === "none"
            ? null
            : values["expected-active-catalog-id"];
      await publishCatalog(
        result.catalog,
        result.sources,
        result.provenances,
        expected!,
      );
      console.log(`Published ${result.catalog.id}`);
    } else invariant(values["dry-run"], "E_DRY_RUN_OR_PUBLISH_REQUIRED");
  }
} else if (command === "extract-import") {
  invariant(values.package, "E_PACKAGE_REQUIRED");
  const output = resolve(values.output ?? `data/math-authoring/${Date.now()}`);
  const run = await importAuthorPackage(
    parseStrictJson(await readFile(resolve(values.package), "utf8")),
    root,
    output,
  );
  console.log(JSON.stringify({ run: output, reviewHash: run.reviewHash }));
} else if (command === "author-review") {
  invariant(values.run, "E_RUN_REQUIRED");
  console.log(
    JSON.stringify(await reviewAuthorRun(resolve(values.run)), null, 2),
  );
} else if (command === "author-accept") {
  invariant(
    values.run &&
      values.units &&
      values["expected-review-hash"] &&
      values["reviewed-by"],
    "E_REVIEW_CONFIRMATION_REQUIRED",
  );
  await acceptAuthorRun(
    resolve(values.run),
    values.units.split(","),
    values["expected-review-hash"],
    values["reviewed-by"],
  );
  console.log("Accepted reviewed units");
} else if (command === "extract") {
  const { extractPdf } = await import("./math-authoring/pdf-source.js");
  await extractPdf(root, values);
} else throw new Error("Unknown mathematics command");

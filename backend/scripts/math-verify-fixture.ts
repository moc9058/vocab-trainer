/** Prepare a small verified Linear Algebra catalog outside textbook; never uploads it. */
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { linearAlgebraFixture } from "./tests/math-fixtures.js";
import { buildCatalog } from "../src/math-content.js";
const root = resolve(process.argv[2] ?? "data/math-verification");
await mkdir(root, { recursive: true });
await linearAlgebraFixture(root);
const result = await buildCatalog(root);
console.log(
  JSON.stringify(
    {
      root,
      catalogId: result.catalog.id,
      subjects: result.catalog.subjects.length,
      units: result.catalog.units.length,
      concepts: result.catalog.concepts.length,
      objectives: result.catalog.objectives.length,
      warnings: result.warnings,
    },
    null,
    2,
  ),
);

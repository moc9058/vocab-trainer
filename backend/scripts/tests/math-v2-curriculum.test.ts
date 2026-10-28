import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildJsonCatalog } from "../../src/math-json-content.js";
import { resolveScopeV2, planNextQuestion } from "../../src/math-scope.js";
const { catalog } = await buildJsonCatalog(
  fileURLToPath(new URL("../../../textbook", import.meta.url)),
);
const request = (ids: string[]) => ({
  schemaVersion: 2 as const,
  subjectId: "linear-algebra",
  selectedNodeIds: ids,
  difficulty: 2,
  responseLanguage: "en" as const,
});
test("all reviewed algebra leaves fit a v2 scope and chapter5 only assesses chapter5", () => {
  const leaves = catalog.nodes.filter((n) => n.unitIds.length);
  assert.equal(leaves.length, 229);
  const all = resolveScopeV2(request(leaves.map((n) => n.id)), catalog);
  assert.equal(all.targetObjectiveIds.length, 458);
  const chapter = resolveScopeV2(request(["la-ch05"]), catalog);
  assert.deepEqual(chapter.prerequisiteChapterIds, [
    "la-ch01",
    "la-ch02",
    "la-ch03",
    "la-ch04",
  ]);
  assert(
    chapter.targets.every(
      (r) => catalog.conceptChapterIds![r.conceptId] === "la-ch05",
    ),
  );
  assert(
    chapter.prerequisites.every((r) =>
      ["la-ch01", "la-ch02", "la-ch03", "la-ch04"].includes(
        catalog.conceptChapterIds![r.conceptId],
      ),
    ),
  );
  const plan = planNextQuestion(chapter, catalog, 1);
  assert.equal(plan.targetObjectiveIds.length, 1);
  assert(
    plan.allowedCapabilities.length < chapter.prerequisites.length,
    "per-question source context must not expand all prerequisite chapters",
  );
});
test("v2 selected item does not authorize unselected siblings except explicit same-chapter dependencies", () => {
  const leaves = catalog.nodes.filter(
    (n) => n.unitIds.length > 0 && n.ancestorIds.includes("la-ch05"),
  );
  const scope = resolveScopeV2(request([leaves[0].id]), catalog);
  assert.equal(scope.targetObjectiveIds.length, 2);
  assert.equal(
    scope.prerequisites.filter(
      (r) => catalog.conceptChapterIds![r.conceptId] === "la-ch05",
    ).length,
    0,
  );
  const changed = structuredClone(catalog),
    concept = changed.concepts.find(
      (c) => c.ownerUnitId === leaves[0].unitIds[0],
    )!,
    sibling = changed.concepts.find(
      (c) => c.ownerUnitId === leaves[1].unitIds[0],
    )!;
  for (const capability of Object.values(concept.capabilities))
    capability!.prerequisites.allOf.push({
      conceptId: sibling.id,
      capability: "apply",
    });
  const explicit = resolveScopeV2(request([leaves[0].id]), changed);
  assert.deepEqual(
    explicit.prerequisites.filter(
      (r) => changed.conceptChapterIds![r.conceptId] === "la-ch05",
    ),
    [{ conceptId: sibling.id, capability: "apply" }],
  );
  assert(!explicit.targets.some((r) => r.conceptId === sibling.id));
});
test("independent chapter8 series includes7 and never infers an edge to1–6", () => {
  const independent = structuredClone(catalog);
  independent.chapterDependencies = {
    "la-ch02": ["la-ch01"],
    "la-ch03": ["la-ch02"],
    "la-ch04": ["la-ch03"],
    "la-ch05": ["la-ch04"],
    "la-ch06": ["la-ch05"],
    "la-ch08": ["la-ch07"],
    "la-ch09": ["la-ch08"],
  };
  const scope = resolveScopeV2(request(["la-ch08"]), independent);
  assert.deepEqual(scope.prerequisiteChapterIds, ["la-ch07"]);
  assert(
    scope.prerequisites.every(
      (r) => independent.conceptChapterIds![r.conceptId] === "la-ch07",
    ),
  );
});

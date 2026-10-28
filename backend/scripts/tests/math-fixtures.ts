import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { stringify as yamlStringify } from "yaml";
const stringify = (value: unknown) =>
  yamlStringify(value, { aliasDuplicateObjects: false });
import { contentHash, PARSER_VERSION } from "../../src/math-schema.js";
import { parseUnit, compileUnit, markdownAst } from "../../src/math-content.js";
import { receiptFor } from "../../src/math-authoring.js";
import type {
  Catalog,
  Candidate,
  Scope,
  QuestionPlan,
} from "../../src/math-types.js";
const repository = resolve(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
export const linearAlgebraPath = join(
  repository,
  "backend/scripts/tests/fixtures/legacy-vector-spaces.md",
);
/** Small historical Markdown fixture exercises the migration-only v1 compiler. */
export async function linearAlgebraFixture(root?: string) {
  const sourceBytes = await readFile(linearAlgebraPath);
  const notes = sourceBytes.toString("utf8").replace(/\r\n?/g, "\n");
  const sourceRevisionId = createHash("sha256")
    .update(sourceBytes)
    .digest("hex");
  const tree = markdownAst(notes),
    headings = tree.children.filter((n) => n.type === "heading");
  const select = (prefix: string) => {
    const index = headings.findIndex((n: any) =>
      notes
        .slice(n.position.start.offset, n.position.end.offset)
        .replace(/^#+\s*/, "")
        .startsWith(prefix),
    );
    if (index < 0) throw new Error("Linear Algebra source heading changed");
    const node: any = headings[index];
    let next: any = headings
      .slice(index + 1)
      .find((n: any) => n.depth <= node.depth);
    return {
      title: notes
        .slice(node.position.start.offset, node.position.end.offset)
        .replace(/^#+\s*/, ""),
      body: notes
        .slice(
          node.position.end.offset,
          next?.position.start.offset ?? notes.length,
        )
        .trim(),
    };
  };
  const vector = select("1.1. Vector space"),
    subspace = select("1.2. Subspace"),
    test = select("2.1. A subset");
  const subjectId = "linear-algebra",
    unitId = "vector-subspaces",
    sourceTitle = "Linear Algebra — local notes";
  const sourceRoot = {
    sourceNodeId: "notes-chapter-1",
    parentId: null,
    kind: "chapter",
    printedLabel: "1",
    title: "Vector Spaces",
  };
  const outline: any[] = [
    sourceRoot,
    {
      sourceNodeId: "notes-definitions",
      parentId: sourceRoot.sourceNodeId,
      kind: "section",
      printedLabel: "1",
      title: "Definitions",
    },
    {
      sourceNodeId: "notes-theorems",
      parentId: sourceRoot.sourceNodeId,
      kind: "section",
      printedLabel: "2",
      title: "Theorems",
    },
  ];
  const empty = { allOf: [], anyOf: [] };
  const ref = (conceptId: string, capability: "recognize" | "apply") => ({
    conceptId,
    capability,
  });
  const items = [
    {
      id: "vector-space",
      title: "Vector space",
      kind: "definition",
      data: vector,
      parent: "notes-definitions",
      label: "1.1",
      requires: [],
    },
    {
      id: "subspace",
      title: "Subspace",
      kind: "definition",
      data: subspace,
      parent: "notes-definitions",
      label: "1.2",
      requires: [ref("vector-space", "apply")],
    },
    {
      id: "subspace-test",
      title: "Subspace criterion",
      kind: "theorem",
      data: test,
      parent: "notes-theorems",
      label: "2.1",
      requires: [
        ref("vector-space", "apply"),
        ref("subspace", "recognize"),
      ],
    },
  ];
  const blocks: any[] = [
    {
      id: "overview",
      kind: "overview",
      anchor: "overview",
      provenanceId: "author-overview",
    },
    {
      id: "example",
      kind: "example",
      anchor: "example",
      provenanceId: "author-example",
    },
    {
      id: "pitfall",
      kind: "pitfall",
      anchor: "pitfall",
      provenanceId: "author-pitfall",
    },
    {
      id: "assessment",
      kind: "assessment",
      anchor: "assessment",
      provenanceId: "author-assessment",
    },
    {
      id: "limits",
      kind: "limits",
      anchor: "limits",
      provenanceId: "author-limits",
    },
  ];
  const sections: string[] = [
    "## Overview {#overview}\nDetermine whether a subset is a vector subspace by checking the required conditions.",
    "## Example {#example}\nThe zero subset $\\{0\\}$ contains zero and is closed under addition and scalar multiplication.",
    "## Pitfall {#pitfall}\nClosure alone does not replace the requirement that zero belongs to the subset.",
    "## Assessment {#assessment}\nIdentify and check each subspace condition; do not infer results about dimension or bases.",
    "## Limits {#limits}\nOnly recognition of the definitions and direct application of the subspace criterion. No dimension, basis, independence, or matrix methods.",
  ];
  const records: any[] = blocks.map((b) => ({
    id: b.provenanceId,
    blockIds: [b.id],
    origin: "author",
    observationIds: [],
    evidence: [],
    supportingClaimIds: [],
    derivation: "Independent explanatory text for verification.",
    verified: true,
    formulaVerified: true,
    occurrenceId: `occ-${b.id}`,
  }));
  const knowledgeItems = items.map((item) => {
    const statementId = `${item.id}-statement`,
      conditionId = `${item.id}-conditions`,
      provenanceId = `source-${item.id}`,
      sourceNodeId = `notes-${item.id}`;
    outline.push({
      sourceNodeId,
      parentId: item.parent,
      kind: item.kind,
      printedLabel: item.label,
      title: item.title,
    });
    blocks.push(
      { id: statementId, kind: "knowledge", anchor: statementId, provenanceId },
      {
        id: conditionId,
        kind: "conditions",
        anchor: conditionId,
        provenanceId,
      },
    );
    const statement =
      item.id === "subspace-test"
        ? `${item.data.title}\n\n${item.data.body}`
        : item.data.body;
    sections.push(
      `## ${item.title} {#${statementId}}\n${statement}`,
      `## Conditions {#${conditionId}}\nThroughout this chapter, $F=\\mathbb R$ or $\\mathbb C$, and all subspaces use the same scalar field. All vector-space identities hold for all vectors and scalars stated in the definition. For the subspace criterion, $U$ is a subset of a vector space $V$.`,
    );
    const path = [
      sourceRoot,
      outline.find((n) => n.sourceNodeId === item.parent),
      outline.find((n) => n.sourceNodeId === sourceNodeId),
    ].map(({ parentId, ...node }: any) => node);
    records.push({
      id: provenanceId,
      blockIds: [statementId, conditionId],
      origin: "source",
      observationIds: [`obs-${item.id}`],
      evidence: [
        {
          sourceRevisionId,
          sourcePath: path,
          hierarchyStatus: "verified",
          itemKind: item.kind,
          printedItemLabel: item.label,
          itemTitle: item.title,
          bookTitle: sourceTitle,
        },
      ],
      supportingClaimIds: [],
      derivation:
        "Verified against the named local Markdown headings; no book edition or PDF page inferred.",
      verified: true,
      formulaVerified: true,
      occurrenceId: `occ-${item.id}`,
    });
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      statementBlockIds: [statementId],
      conditionBlockIds: [conditionId],
      sourceOccurrenceIds: [`occ-${item.id}`],
      capabilities: {
        recognize: { prerequisites: { allOf: item.requires, anyOf: [] } },
        ...(item.id === "subspace-test" || item.id === "vector-space"
          ? { apply: { prerequisites: { allOf: item.requires, anyOf: [] } } }
          : {}),
      },
      provideable: item.id !== "subspace-test",
      requiredToUseWhenGiven: item.requires,
      related: [],
      recommended: [],
    };
  });
  const objectives = [
    {
      id: "apply-subspace-test",
      description: "Check all three conditions of the subspace criterion.",
      assessedCapabilities: [ref("subspace-test", "apply")],
      additionalPrerequisites: empty,
      assessmentBlockIds: ["assessment"],
      difficultyRange: [1, 5],
      proofRequirement: "none",
      proofSupport: { coverage: "none", blockIds: [] },
    },
  ];
  const meta = {
    format: "math-learning-unit",
    schemaVersion: 1,
    unitId,
    title: "Recognizing vector subspaces",
    contentLanguage: "en",
    status: "draft",
    sourceRevisionIds: [sourceRevisionId],
    proofCoverage: "none",
    blocks,
    knowledgeItems,
    knowledgeRefs: [],
    objectives,
    problemFamilies: [
      {
        id: "subspace-check",
        objectiveIds: ["apply-subspace-test"],
        specificationBlockId: "assessment",
      },
    ],
    unresolved: [],
  };
  const markdown = `---\n${stringify(meta)}---\n${sections.join("\n\n")}\n`,
    provenance = { schemaVersion: 1, unitId, records },
    receipt = receiptFor(
      markdown,
      provenance,
      "Codex: local Markdown verification",
    );
  const compiled = compileUnit(
    markdown,
    provenance,
    receipt,
    subjectId,
    "Linear Algebra",
  );
  const nodes = [
    {
      id: "linear-algebra-root",
      subjectId,
      parentId: null,
      ancestorIds: [],
      kind: "subject",
      title: "Linear Algebra",
      order: 0,
      unitIds: [],
    },
    {
      id: "chapter-1",
      subjectId,
      parentId: "linear-algebra-root",
      ancestorIds: ["linear-algebra-root"],
      kind: "chapter",
      title: "1. Vector Spaces",
      order: 1,
      unitIds: [],
    },
    {
      id: "section-subspaces",
      subjectId,
      parentId: "chapter-1",
      ancestorIds: ["linear-algebra-root", "chapter-1"],
      kind: "section",
      title: "Subspaces",
      order: 1,
      unitIds: [unitId],
    },
  ];
  const catalog: Catalog = {
    id: "",
    schemaVersion: 1,
    parserVersion: PARSER_VERSION,
    subjects: [
      {
        id: subjectId,
        title: "Linear Algebra",
        rootNodeId: "linear-algebra-root",
        order: 0,
        foundationProfileIds: [],
      },
    ],
    nodes,
    units: [compiled.unit],
    concepts: compiled.concepts,
    objectives: compiled.objectives,
    profiles: [],
  };
  const { id, ...body } = catalog;
  catalog.id = contentHash(body);
  const source = {
    sourceId: "linear-algebra-notes",
    sourceRevisionId,
    title: sourceTitle,
    edition: "Local Markdown revision",
    fileHash: sourceRevisionId,
    pageCount: 0,
    outline,
  };
  if (root) {
    await mkdir(join(root, subjectId, "units"), { recursive: true });
    await mkdir(join(root, subjectId, "provenance"), { recursive: true });
    await mkdir(join(root, subjectId, "reviews"), { recursive: true });
    await writeFile(
      join(root, "math.catalog.yaml"),
      stringify({
        schemaVersion: 1,
        subjects: [{ id: subjectId, path: subjectId }],
      }),
    );
    await writeFile(
      join(root, subjectId, "subject.yaml"),
      stringify({
        schemaVersion: 1,
        id: subjectId,
        title: "Linear Algebra",
        rootNodeId: "linear-algebra-root",
        order: 0,
        foundationProfileIds: [],
        units: [
          {
            id: unitId,
            path: `units/unit-${unitId}.md`,
            provenance: `provenance/${unitId}.yaml`,
            review: `reviews/${unitId}.yaml`,
          },
        ],
        profiles: [],
        sources: ["source.yaml"],
      }),
    );
    await writeFile(
      join(root, subjectId, "curriculum.yaml"),
      stringify({
        schemaVersion: 1,
        subjectId,
        nodes: nodes.map(({ subjectId, ancestorIds, ...n }) => n),
      }),
    );
    await writeFile(join(root, subjectId, "source.yaml"), stringify(source));
    await writeFile(
      join(root, subjectId, "units", `unit-${unitId}.md`),
      markdown,
    );
    await writeFile(
      join(root, subjectId, "provenance", `${unitId}.yaml`),
      stringify(provenance),
    );
    await writeFile(
      join(root, subjectId, "reviews", `${unitId}.yaml`),
      stringify(receipt),
    );
  }
  return {
    catalog,
    compiled,
    markdown,
    provenance,
    receipt,
    source,
    sourceRevisionId,
    artifacts: { [compiled.artifactHash]: compiled.normalized },
    provenances: {
      [compiled.provenanceHash]: { ...provenance, review: receipt },
      [sourceRevisionId]: source,
    },
  };
}
export function request() {
  return {
    subjectId: "linear-algebra",
    selectedNodeIds: ["chapter-1"],
    excludedConceptIds: [],
    excludedObjectiveIds: [],
    objectiveCapabilities: ["apply"] as "apply"[],
    mode: "prerequisites" as const,
    profileIds: [],
    difficulty: 2,
    questionCount: 1,
    responseLanguage: "en" as const,
    answerFormats: ["text"] as "text"[],
  };
}
export function validCandidate(
  catalog: Catalog,
  scope: Scope,
  plan: QuestionPlan,
): Candidate {
  const used = scope.targets.concat(scope.prerequisites),
    concepts = catalog.concepts.filter((c) =>
      used.some((r) => r.conceptId === c.id),
    );
  const citationIds = concepts.flatMap((c) =>
    c.citations.map((c) => c.citationId),
  );
  return {
    status: "candidate",
    promptMarkdown:
      "Let $V$ be a vector space over $F$. Is $U=\\{0\\}$ a subspace of $V$? Check all three conditions.",
    answerFormat: plan.answerFormat,
    targetObjectiveIds: plan.targetObjectiveIds,
    prerequisitesUsed: scope.prerequisites,
    foundationUsed: [],
    givens: [],
    solution: {
      usedKnowledge: concepts.map((c) => ({
        conceptId: c.id,
        revisionId: c.revisionId,
        citationIds: c.citations.map((c) => c.citationId),
        role: scope.targets.some((r) => r.conceptId === c.id)
          ? "target"
          : "prerequisite",
      })),
      strategyMarkdown: "Apply the subspace criterion.",
      steps: [
        {
          id: "step-check",
          citationIds,
          uses: used,
          applicabilityMarkdown:
            "$U$ is a subset of the vector space $V$ over the same field.",
          explanationMarkdown:
            "Zero belongs to $U$; $0+0=0$ and $a0=0$ for all $a\\in F$. All three conditions hold.",
        },
      ],
      finalAnswerMarkdown: "Yes, $U$ is a subspace.",
      checksMarkdown:
        "All three conditions, including nonemptiness, have been checked.",
    },
    rubric: [
      {
        criterionId: "all-conditions",
        objectiveId: plan.targetObjectiveIds[0],
        points: 100,
        description: "Checks zero, addition and scalar closure.",
        requiredStepIds: ["step-check"],
      },
    ],
    estimatedDifficulty: {
      level: plan.difficulty,
      reasoningDepth: 1,
      algebraLoad: 0,
      abstraction: 1,
      proofDemand: 0,
      integrationCount: 1,
    },
    expectedMinutes: 3,
    numericCheck: null,
  };
}

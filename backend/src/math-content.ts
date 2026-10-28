import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { resolve, relative, sep, isAbsolute, dirname } from "node:path";
import { parseDocument } from "yaml";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import katex from "katex";
import { z } from "zod";
import type {
  Catalog,
  Citation,
  Concept,
  Unit,
  Objective,
} from "./math-types.js";
import {
  contentHash,
  checkBytes,
  invariant,
  idSchema,
  hashSchema,
  refSchema,
  dependencySchema,
  MATH_LIMITS,
  PARSER_VERSION,
} from "./math-schema.js";
import { validateGraph } from "./math-graph.js";

export function parseYaml(text: string): unknown {
  const doc = parseDocument(text, {
    uniqueKeys: true,
    version: "1.2",
    schema: "core",
  });
  invariant(!doc.errors.length, "E_INVALID_YAML", 400, {
    errors: doc.errors.map((e) => e.message),
  });
  return doc.toJS({ maxAliasCount: 0 });
}
export async function safePath(root: string, path: string): Promise<string> {
  invariant(
    !isAbsolute(path) &&
      !path.includes("\\") &&
      !path.split("/").includes(".."),
    "E_UNSAFE_PATH",
  );
  const base = await realpath(root);
  let at = base;
  for (const segment of path.split("/").filter(Boolean)) {
    at = resolve(at, segment);
    const stat = await lstat(at);
    invariant(!stat.isSymbolicLink(), "E_SYMLINK");
  }
  invariant(
    !relative(base, at).startsWith(`..${sep}`) && relative(base, at) !== "..",
    "E_UNSAFE_PATH",
  );
  return at;
}
export async function readSafe(root: string, path: string): Promise<string> {
  const at = await safePath(root, path);
  const text = await readFile(at, "utf8");
  checkBytes(text, MATH_LIMITS.markdownBytes);
  return text.replace(/\r\n?/g, "\n");
}
export function markdownAst(text: string) {
  return unified().use(remarkParse).use(remarkMath).parse(text);
}
export function validateMathMarkdown(text: string): void {
  invariant(
    !/\\(?:href|url|includegraphics|htmlClass|htmlStyle|htmlId|htmlData|gdef|def|newcommand|renewcommand)\b/.test(
      text,
    ),
    "E_UNSAFE_LATEX",
  );
  const tree = markdownAst(text);
  function visit(node: any) {
    if (node.type === "math" || node.type === "inlineMath") {
      try {
        katex.renderToString(node.value, {
          trust: false,
          maxExpand: 200,
          maxSize: 20,
          throwOnError: true,
          strict: "error",
          macros: {},
        });
      } catch {
        invariant(false, "E_INVALID_LATEX", 400, {
          formula: node.value.slice(0, 120),
        });
      }
    }
    if (node.children) node.children.forEach(visit);
  }
  visit(tree);
}
const emptyDeps = () => ({ allOf: [], anyOf: [] });
const blockSchema = z.strictObject({
  id: idSchema,
  kind: z.enum([
    "overview",
    "intuition",
    "knowledge",
    "conditions",
    "method",
    "connections",
    "example",
    "pitfall",
    "proof",
    "assessment",
    "limits",
  ]),
  anchor: idSchema,
  provenanceId: idSchema,
});
export const unitMetadataSchema = z.strictObject({
  format: z.literal("math-learning-unit"),
  schemaVersion: z.literal(1),
  unitId: idSchema,
  title: z.string().min(1),
  contentLanguage: z.string().min(2).max(12),
  status: z.enum(["draft", "approved", "reference"]),
  sourceRevisionIds: z.array(hashSchema),
  proofCoverage: z.enum(["none", "sketch", "complete"]),
  blocks: z.array(blockSchema).min(1).max(150),
  knowledgeItems: z
    .array(
      z.strictObject({
        id: idSchema,
        title: z.string().min(1),
        kind: z.enum([
          "definition",
          "theorem",
          "lemma",
          "proposition",
          "corollary",
          "identity",
          "notation",
          "method",
        ]),
        statementBlockIds: z.array(idSchema).min(1),
        conditionBlockIds: z.array(idSchema).min(1),
        sourceOccurrenceIds: z.array(idSchema).min(1),
        capabilities: z.strictObject({
          recognize: z
            .strictObject({ prerequisites: dependencySchema })
            .optional(),
          apply: z.strictObject({ prerequisites: dependencySchema }).optional(),
          prove: z.strictObject({ prerequisites: dependencySchema }).optional(),
        }),
        provideable: z.boolean(),
        requiredToUseWhenGiven: z.array(refSchema).default([]),
        related: z.array(refSchema).default([]),
        recommended: z.array(refSchema).default([]),
      }),
    )
    .max(100),
  knowledgeRefs: z.array(z.strictObject({ conceptId: idSchema })),
  objectives: z
    .array(
      z.strictObject({
        id: idSchema,
        description: z.string().min(1),
        assessedCapabilities: z.array(refSchema).min(1),
        additionalPrerequisites: dependencySchema,
        assessmentBlockIds: z.array(idSchema).min(1),
        difficultyRange: z.tuple([
          z.number().int().min(1).max(5),
          z.number().int().min(1).max(5),
        ]),
        proofRequirement: z
          .enum(["none", "sketch", "complete"])
          .default("none"),
        proofSupport: z
          .strictObject({
            coverage: z.enum(["none", "sketch", "complete"]),
            blockIds: z.array(idSchema),
          })
          .default({ coverage: "none", blockIds: [] }),
      }),
    )
    .max(200),
  problemFamilies: z.array(
    z.strictObject({
      id: idSchema,
      objectiveIds: z.array(idSchema).min(1),
      specificationBlockId: idSchema,
    }),
  ),
  unresolved: z.array(
    z.strictObject({
      code: z.string(),
      detail: z.string(),
      conceptIds: z.array(idSchema),
      objectiveIds: z.array(idSchema),
    }),
  ),
  exampleNotApplicableReason: z.string().optional(),
  pitfallNotApplicableReason: z.string().optional(),
});
export const spanSchema = z.strictObject({
  sourceRevisionId: hashSchema,
  pdfPageStart: z.number().int().positive().optional(),
  pdfPageEnd: z.number().int().positive().optional(),
  printedPageLabel: z.string().optional(),
  sourcePath: z
    .array(
      z.strictObject({
        sourceNodeId: idSchema,
        kind: z.string(),
        printedLabel: z.string().optional(),
        title: z.string().min(1),
      }),
    )
    .max(100),
  hierarchyStatus: z.enum(["verified", "unresolved", "not-applicable"]),
  itemKind: z.string(),
  printedItemLabel: z.string().optional(),
  itemTitle: z.string(),
  bookTitle: z.string().optional(),
  edition: z.string().optional(),
  bbox: z
    .tuple([
      z.number().min(0).max(1),
      z.number().min(0).max(1),
      z.number().min(0).max(1),
      z.number().min(0).max(1),
    ])
    .optional(),
});
export const provenanceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  unitId: idSchema,
  records: z
    .array(
      z.strictObject({
        id: idSchema,
        blockIds: z.array(idSchema).min(1),
        origin: z.enum(["source", "derived", "pedagogical", "author"]),
        observationIds: z.array(idSchema),
        evidence: z.array(spanSchema),
        supportingClaimIds: z.array(idSchema),
        derivation: z.string(),
        verified: z.boolean(),
        formulaVerified: z.boolean(),
        occurrenceId: idSchema,
      }),
    )
    .min(1),
});
export const reviewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  unitId: idSchema,
  contentHash: hashSchema,
  provenanceHash: hashSchema,
  policyVersion: z.literal("math-review-1"),
  acceptedAt: z.number().positive(),
  reviewedBy: z.string().min(1),
  acceptedObjectiveIds: z.array(idSchema),
  acceptedConceptIds: z.array(idSchema),
});
export function parseUnit(markdown: string) {
  checkBytes(markdown, MATH_LIMITS.markdownBytes);
  const normalized = markdown.replace(/\r\n?/g, "\n");
  invariant(normalized.startsWith("---\n"), "E_MISSING_FRONT_MATTER");
  const end = normalized.indexOf("\n---\n", 4);
  invariant(end > 0, "E_MISSING_FRONT_MATTER");
  const meta = unitMetadataSchema.parse(parseYaml(normalized.slice(4, end))),
    body = normalized.slice(end + 5),
    tree = markdownAst(body);
  const sections = new Map<string, string>();
  const headings = tree.children.filter(
    (n: any) =>
      n.type === "heading" &&
      /\{#[a-z0-9_-]+\}\s*$/.test(
        body.slice(n.position.start.offset, n.position.end.offset),
      ),
  ) as any[];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const raw = body.slice(
        heading.position.start.offset,
        heading.position.end.offset,
      ),
      match = raw.match(/\{#([a-z0-9_-]+)\}\s*$/);
    if (!match) continue;
    invariant(!sections.has(match[1]), "E_DUPLICATE_ANCHOR");
    sections.set(
      match[1],
      body
        .slice(
          heading.position.end.offset,
          headings[i + 1]?.position.start.offset ?? body.length,
        )
        .trim(),
    );
  }
  const blocks = meta.blocks.map((b) => {
    const markdown = sections.get(b.anchor);
    invariant(markdown, "E_MISSING_BLOCK", 400, { blockId: b.id });
    validateMathMarkdown(markdown);
    return { ...b, markdown };
  });
  invariant(
    new Set(blocks.map((b) => b.id)).size === blocks.length &&
      new Set(blocks.map((b) => b.anchor)).size === blocks.length,
    "E_DUPLICATE_BLOCK",
  );
  for (const required of ["overview", "limits"])
    invariant(
      blocks.some((b) => b.kind === required),
      "E_MISSING_BLOCK",
      400,
      { kind: required },
    );
  invariant(
    blocks.some((b) => b.kind === "example") || meta.exampleNotApplicableReason,
    "E_MISSING_EXAMPLE",
  );
  invariant(
    blocks.some((b) => b.kind === "pitfall") || meta.pitfallNotApplicableReason,
    "E_MISSING_PITFALL",
  );
  return { meta, blocks, normalized };
}
export function compileUnit(
  markdown: string,
  provenanceInput: unknown,
  receiptInput: unknown,
  subjectId: string,
  subjectTitle: string,
) {
  const { meta, blocks, normalized } = parseUnit(markdown),
    provenance = provenanceSchema.parse(provenanceInput),
    receipt = reviewSchema.parse(receiptInput);
  const artifactHash = contentHash(normalized),
    provenanceHash = contentHash(provenance);
  invariant(
    provenance.unitId === meta.unitId &&
      receipt.unitId === meta.unitId &&
      receipt.contentHash === artifactHash &&
      receipt.provenanceHash === provenanceHash,
    "E_REVIEW_HASH_MISMATCH",
  );
  const blockMap = new Map(blocks.map((b) => [b.id, b]));
  invariant(
    new Set(provenance.records.map((p) => p.id)).size ===
      provenance.records.length &&
      new Set(provenance.records.map((p) => p.occurrenceId)).size ===
        provenance.records.length,
    "E_DUPLICATE_PROVENANCE",
  );
  const readBlocks = (ids: string[]) =>
    ids
      .map((id) => {
        const b = blockMap.get(id);
        invariant(b, "E_MISSING_BLOCK", 400, { blockId: id });
        return b.markdown;
      })
      .join("\n\n");
  for (const b of blocks) {
    const p = provenance.records.find((p) => p.id === b.provenanceId);
    invariant(p?.blockIds.includes(b.id), "E_MISSING_PROVENANCE");
  }
  for (const record of provenance.records)
    if (record.origin === "derived")
      invariant(
        record.supportingClaimIds.length > 0 && record.derivation.trim(),
        "E_DERIVATION_EVIDENCE_REQUIRED",
      );
  const concepts: Concept[] = meta.knowledgeItems.map((k) => {
    const blockIds = [...k.statementBlockIds, ...k.conditionBlockIds],
      statement = readBlocks(k.statementBlockIds),
      conditions = readBlocks(k.conditionBlockIds);
    checkBytes(statement + "\n" + conditions, MATH_LIMITS.conceptBytes);
    invariant(
      k.conditionBlockIds.every(
        (id) => blockMap.get(id)?.kind === "conditions",
      ),
      "E_INVALID_CONDITION_SECTION",
    );
    invariant(
      k.kind !== "method" ||
        k.statementBlockIds.some((id) => blockMap.get(id)?.kind === "method"),
      "E_MISSING_METHOD",
    );
    invariant(Object.keys(k.capabilities).length > 0, "E_MISSING_CAPABILITY");
    const revisionId = contentHash({
      id: k.id,
      title: k.title,
      kind: k.kind,
      statement,
      conditions,
      capabilities: k.capabilities,
      provideable: k.provideable,
      requiredToUseWhenGiven: k.requiredToUseWhenGiven,
      schemaVersion: 1,
      parserVersion: PARSER_VERSION,
    });
    const citations: Citation[] = k.sourceOccurrenceIds.map((occurrenceId) => {
      const p = provenance.records.find(
        (p) =>
          p.occurrenceId === occurrenceId &&
          blockIds.some((b) => p.blockIds.includes(b)),
      );
      invariant(p, "E_MISSING_OCCURRENCE");
      invariant(
        p.origin !== "source" ||
          (p.evidence.length > 0 && p.observationIds.length > 0),
        "E_MISSING_SOURCE",
      );
      const span = p.evidence[0] ? { ...p.evidence[0] } : undefined;
      if (span && p.evidence.length > 1) {
        invariant(
          p.evidence.every(
            (e) =>
              e.sourceRevisionId === span.sourceRevisionId &&
              contentHash(e.sourcePath) === contentHash(span.sourcePath),
          ),
          "E_OCCURRENCE_SOURCE_MISMATCH",
        );
        const pages = p.evidence.filter((e) => e.pdfPageStart !== undefined);
        if (pages.length) {
          span.pdfPageStart = Math.min(...pages.map((e) => e.pdfPageStart!));
          span.pdfPageEnd = Math.max(...pages.map((e) => e.pdfPageEnd!));
        }
      }
      invariant(
        !span || meta.sourceRevisionIds.includes(span.sourceRevisionId),
        "E_UNKNOWN_SOURCE",
      );
      invariant(
        p.origin === "source" &&
          p.verified &&
          receipt.acceptedConceptIds.includes(k.id)
          ? span?.hierarchyStatus === "verified" && span.sourcePath.length > 0
          : true,
        "SOURCE_HIERARCHY_UNRESOLVED",
      );
      invariant(
        !span?.pdfPageStart ||
          (!!span.pdfPageEnd && span.pdfPageEnd >= span.pdfPageStart),
        "E_SOURCE_PAGES",
      );
      return {
        citationId: `cite-${contentHash({ concept: k.id, occurrenceId }).slice(0, 40)}`,
        conceptId: k.id,
        conceptRevisionId: revisionId,
        sourceOccurrenceId: occurrenceId,
        origin: p.origin,
        subjectTitle,
        bookTitle: span?.bookTitle,
        edition: span?.edition,
        sourceRevisionId: span?.sourceRevisionId,
        sourcePath: span?.sourcePath ?? [],
        itemKind: span?.itemKind ?? k.kind,
        printedItemLabel: span?.printedItemLabel,
        itemTitle: span?.itemTitle ?? k.title,
        pdfPageStart: span?.pdfPageStart,
        pdfPageEnd: span?.pdfPageEnd,
        printedPageLabel: span?.printedPageLabel,
        blockIds: p.blockIds,
        hierarchyStatus: span?.hierarchyStatus ?? "not-applicable",
        supportingCitationIds: [],
      };
    });
    invariant(
      blockIds.every((id) => citations.some((c) => c.blockIds.includes(id))),
      "E_UNCITED_CONDITION",
    );
    return {
      readiness: "ready",
      id: k.id,
      subjectId,
      ownerUnitId: meta.unitId,
      revisionId,
      title: k.title,
      kind: k.kind,
      statement,
      conditions,
      capabilities: k.capabilities,
      provideable: k.provideable,
      requiredToUseWhenGiven: k.requiredToUseWhenGiven,
      related: k.related,
      recommended: k.recommended,
      citations,
      sourceArtifactHash: artifactHash,
      blockIds,
    };
  });
  const allCitations = concepts.flatMap((c) => c.citations);
  for (const citation of allCitations)
    if (citation.origin === "derived") {
      const record = provenance.records.find(
        (p) => p.occurrenceId === citation.sourceOccurrenceId,
      )!;
      citation.supportingCitationIds = [
        ...new Set(
          record.supportingClaimIds.flatMap((claimId) => {
            const support = provenance.records.find(
              (p) => p.id === claimId || p.observationIds.includes(claimId),
            );
            const citations = support
              ? allCitations.filter(
                  (c) => c.sourceOccurrenceId === support.occurrenceId,
                )
              : [];
            invariant(citations.length, "E_UNRESOLVED_DERIVATION");
            return citations.map((c) => c.citationId);
          }),
        ),
      ];
    }
  const visitCitation = (id: string, path: string[]) => {
    invariant(!path.includes(id), "E_DERIVATION_CYCLE");
    const citation = allCitations.find((c) => c.citationId === id);
    invariant(citation, "E_UNRESOLVED_DERIVATION");
    for (const support of citation.supportingCitationIds)
      visitCitation(support, [...path, id]);
  };
  for (const citation of allCitations) visitCitation(citation.citationId, []);
  const readyConcepts = new Set(
    meta.knowledgeItems
      .filter(
        (k) =>
          receipt.acceptedConceptIds.includes(k.id) &&
          !meta.unresolved.some((u) => u.conceptIds.includes(k.id)) &&
          [...k.statementBlockIds, ...k.conditionBlockIds].every((b) => {
            const p = provenance.records.find(
              (p) => p.id === blockMap.get(b)?.provenanceId,
            );
            return (
              p?.verified &&
              p.formulaVerified &&
              (p.origin !== "source" ||
                p.evidence.every((e) => e.hierarchyStatus === "verified"))
            );
          }),
      )
      .map((k) => k.id),
  );
  for (const concept of concepts)
    concept.readiness = readyConcepts.has(concept.id) ? "ready" : "blocked";
  const objectives: Objective[] = meta.objectives.map((o) => {
    readBlocks([...o.assessmentBlockIds, ...o.proofSupport.blockIds]);
    invariant(
      o.difficultyRange[0] <= o.difficultyRange[1],
      "E_DIFFICULTY_RANGE",
    );
    invariant(
      o.assessmentBlockIds.every(
        (id) => blockMap.get(id)?.kind === "assessment",
      ),
      "E_INVALID_ASSESSMENT_BLOCK",
    );
    const proofOkay =
      !o.assessedCapabilities.some((r) => r.capability === "prove") ||
      (o.proofSupport.blockIds.length > 0 &&
        o.proofSupport.coverage !== "none" &&
        (o.proofRequirement !== "complete" ||
          o.proofSupport.coverage === "complete"));
    return {
      ...o,
      unitId: meta.unitId,
      readiness:
        meta.status === "reference"
          ? "reference-only"
          : receipt.acceptedObjectiveIds.includes(o.id) &&
              [...o.assessmentBlockIds, ...o.proofSupport.blockIds].every(
                (id) => {
                  const p = provenance.records.find(
                    (p) => p.id === blockMap.get(id)?.provenanceId,
                  );
                  return p?.verified && p.formulaVerified;
                },
              ) &&
              proofOkay &&
              !meta.unresolved.some((u) => u.objectiveIds.includes(o.id)) &&
              o.assessedCapabilities.every(
                (r) =>
                  readyConcepts.has(r.conceptId) ||
                  meta.knowledgeRefs.some((k) => k.conceptId === r.conceptId),
              )
            ? "ready"
            : "blocked",
    };
  });
  for (const f of meta.problemFamilies) {
    readBlocks([f.specificationBlockId]);
    invariant(
      f.objectiveIds.every((id) => objectives.some((o) => o.id === id)),
      "E_UNKNOWN_OBJECTIVE",
    );
  }
  const unit: Unit = {
    id: meta.unitId,
    subjectId,
    revisionId: contentHash({
      meta,
      blocks,
      artifactHash,
      provenanceHash,
      receipt,
      parserVersion: PARSER_VERSION,
    }),
    title: meta.title,
    contentLanguage: meta.contentLanguage,
    sourceArtifactHash: artifactHash,
    provenanceHash,
    reviewHash: contentHash(receipt),
    objectiveIds: objectives.map((o) => o.id),
    conceptIds: concepts.map((c) => c.id),
    blocks,
    problemFamilies: meta.problemFamilies,
    proofCoverage: meta.proofCoverage,
    status:
      objectives.length && objectives.every((o) => o.readiness === "ready")
        ? "ready"
        : objectives.some((o) => o.readiness === "ready")
          ? "partial"
          : "reference-only",
  };
  return {
    unit,
    concepts,
    objectives,
    artifactHash,
    provenanceHash,
    normalized,
    provenance,
    receipt,
    knowledgeRefs: meta.knowledgeRefs,
  };
}
const subjectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  title: z.string().min(1),
  rootNodeId: idSchema,
  order: z.number().int(),
  foundationProfileIds: z.array(idSchema),
  units: z.array(
    z.strictObject({
      id: idSchema,
      path: z.string(),
      provenance: z.string(),
      review: z.string(),
    }),
  ),
  profiles: z.array(z.string()),
  sources: z.array(z.string()),
});
const nodeSchema = z.strictObject({
  id: idSchema,
  parentId: idSchema.nullable(),
  kind: z.string().min(1),
  title: z.string().min(1),
  order: z.number().int(),
  unitIds: z.array(idSchema),
});
export const sourceDocumentSchema = z.strictObject({
  sourceId: idSchema,
  sourceRevisionId: hashSchema,
  title: z.string().min(1),
  edition: z.string(),
  fileHash: hashSchema,
  pageCount: z.number().int().nonnegative(),
  outline: z.array(
    z.strictObject({
      sourceNodeId: idSchema,
      parentId: idSchema.nullable(),
      kind: z.string(),
      printedLabel: z.string().optional(),
      title: z.string(),
    }),
  ),
});
export async function buildCatalog(root: string) {
  const warnings: string[] = [],
    sources: Record<string, string> = {},
    provenances: Record<string, unknown> = {};
  const listing = await readdir(root, { withFileTypes: true });
  for (const item of listing) invariant(!item.isSymbolicLink(), "E_SYMLINK");
  if (!listing.some((f) => f.name === "math.catalog.yaml"))
    return {
      catalog: {
        id: contentHash([]),
        schemaVersion: 1,
        parserVersion: PARSER_VERSION,
        subjects: [],
        nodes: [],
        units: [],
        concepts: [],
        objectives: [],
        profiles: [],
      } as Catalog,
      sources,
      provenances,
      warnings: ["W_NO_CATALOG_METADATA"],
    };
  const manifest = z
    .strictObject({
      schemaVersion: z.literal(1),
      subjects: z.array(z.strictObject({ id: idSchema, path: z.string() })),
    })
    .parse(parseYaml(await readSafe(root, "math.catalog.yaml")));
  const catalog: Catalog = {
    id: "",
    authoringPaths: {},
    schemaVersion: 1,
    parserVersion: PARSER_VERSION,
    subjects: [],
    nodes: [],
    units: [],
    concepts: [],
    objectives: [],
    profiles: [],
  };
  const allPaths = new Set<string>();
  function track(path: string) {
    const normalized = path.normalize("NFC").toLowerCase();
    invariant(!allPaths.has(normalized), "E_PATH_COLLISION");
    allPaths.add(normalized);
  }
  for (const entry of manifest.subjects) {
    invariant(
      !entry.path.includes("/") && entry.path !== ".",
      "E_SUBJECT_PATH",
    );
    const prefix = entry.path + "/";
    catalog.authoringPaths![`subject:${entry.id}`] = entry.path;
    track(entry.path);
    const subject = subjectSchema.parse(
      parseYaml(await readSafe(root, prefix + "subject.yaml")),
    );
    invariant(subject.id === entry.id, "E_SUBJECT_ID");
    catalog.subjects.push({
      id: subject.id,
      title: subject.title,
      rootNodeId: subject.rootNodeId,
      order: subject.order,
      foundationProfileIds: subject.foundationProfileIds,
    });
    const curriculum = z
      .strictObject({
        schemaVersion: z.literal(1),
        subjectId: idSchema,
        nodes: z.array(nodeSchema),
      })
      .parse(parseYaml(await readSafe(root, prefix + "curriculum.yaml")));
    invariant(curriculum.subjectId === subject.id, "E_SUBJECT_ID");
    for (const node of curriculum.nodes) {
      const ancestorIds: string[] = [],
        seen = new Set([node.id]);
      let parentId = node.parentId;
      while (parentId) {
        invariant(!seen.has(parentId), "E_NODE_CYCLE");
        seen.add(parentId);
        ancestorIds.unshift(parentId);
        const parent = curriculum.nodes.find((n) => n.id === parentId);
        invariant(parent, "E_MISSING_NODE_ID");
        parentId = parent.parentId;
      }
      invariant(
        node.id === subject.rootNodeId
          ? node.parentId === null
          : ancestorIds[0] === subject.rootNodeId,
        "E_INVALID_ROOT",
      );
      catalog.nodes.push({ ...node, subjectId: subject.id, ancestorIds });
    }
    invariant(
      curriculum.nodes.some((n) => n.id === subject.rootNodeId),
      "E_MISSING_NODE_ID",
    );
    for (const file of subject.units) {
      track(prefix + file.path);
      catalog.authoringPaths![file.id] = prefix + file.path;
      const compiled = compileUnit(
        await readSafe(root, prefix + file.path),
        parseYaml(await readSafe(root, prefix + file.provenance)),
        parseYaml(await readSafe(root, prefix + file.review)),
        subject.id,
        subject.title,
      );
      invariant(file.id === compiled.unit.id, "E_UNIT_ID");
      catalog.units.push(compiled.unit);
      catalog.concepts.push(...compiled.concepts);
      catalog.objectives.push(...compiled.objectives);
      sources[compiled.artifactHash] = compiled.normalized;
      provenances[compiled.provenanceHash] = {
        ...compiled.provenance,
        review: compiled.receipt,
      };
    }
    for (const file of subject.profiles) {
      const profile = z
        .strictObject({
          id: idSchema,
          title: z.string().min(1),
          revision: z.string().min(1),
          acceptedCapabilities: z.array(refSchema).max(1000),
          sourceDescription: z.string().min(1),
        })
        .parse(parseYaml(await readSafe(root, prefix + file)));
      catalog.profiles.push(profile);
    }
    // Sources contain metadata only. PDFs are deliberately never read by catalog compilation.
    for (const file of subject.sources) {
      const source = sourceDocumentSchema.parse(
        parseYaml(await readSafe(root, prefix + file)),
      );
      invariant(source.fileHash === source.sourceRevisionId, "E_SOURCE_HASH");
      invariant(
        new Set(source.outline.map((n) => n.sourceNodeId)).size ===
          source.outline.length,
        "E_DUPLICATE_SOURCE_NODE",
      );
      for (const node of source.outline) {
        const visited = new Set([node.sourceNodeId]);
        let parentId = node.parentId;
        while (parentId) {
          invariant(!visited.has(parentId), "E_SOURCE_OUTLINE_CYCLE");
          visited.add(parentId);
          const parent = source.outline.find(
            (n) => n.sourceNodeId === parentId,
          );
          invariant(parent, "E_SOURCE_OUTLINE_MISSING");
          parentId = parent.parentId;
        }
      }
      invariant(
        !provenances[source.sourceRevisionId] ||
          contentHash(provenances[source.sourceRevisionId]) ===
            contentHash(source),
        "E_SOURCE_REVISION_CONFLICT",
      );
      provenances[source.sourceRevisionId] = source;
    }
    if (!subject.units.length) warnings.push(`W_EMPTY_SUBJECT:${subject.id}`);
  }
  for (const name of [
    "subjects",
    "nodes",
    "units",
    "concepts",
    "objectives",
    "profiles",
  ] as const)
    invariant(
      new Set(catalog[name].map((x) => x.id)).size === catalog[name].length,
      `E_DUPLICATE_${name.toUpperCase()}_ID`,
    );
  for (const node of catalog.nodes)
    for (const id of node.unitIds)
      invariant(
        catalog.units.some(
          (u) => u.id === id && u.subjectId === node.subjectId,
        ),
        "E_UNKNOWN_UNIT",
      );
  for (const subject of catalog.subjects)
    for (const id of subject.foundationProfileIds)
      invariant(
        catalog.profiles.some((p) => p.id === id),
        "E_UNKNOWN_PROFILE",
      );
  for (const profile of catalog.profiles)
    for (const ref of profile.acceptedCapabilities)
      invariant(
        catalog.concepts.some(
          (c) => c.id === ref.conceptId && c.capabilities[ref.capability],
        ),
        "E_UNKNOWN_PREREQUISITE",
      );
  for (const c of catalog.concepts)
    for (const citation of c.citations) {
      if (citation.origin === "source") {
        const source = provenances[citation.sourceRevisionId!] as any;
        invariant(source && source.title, "E_MISSING_SOURCE_DOCUMENT");
        const ids = new Map(
          source.outline.map((n: any) => [n.sourceNodeId, n]),
        );
        let parent: string | null = null;
        for (const node of citation.sourcePath) {
          const actual = ids.get(node.sourceNodeId) as any;
          invariant(
            actual &&
              actual.parentId === parent &&
              actual.title === node.title &&
              actual.kind === node.kind &&
              actual.printedLabel === node.printedLabel,
            "E_SOURCE_OUTLINE_MISMATCH",
          );
          parent = node.sourceNodeId;
        }
        invariant(
          !citation.pdfPageEnd || citation.pdfPageEnd <= source.pageCount,
          "E_SOURCE_PAGES",
        );
      }
    }
  validateGraph(catalog);
  const { id, ...body } = catalog;
  catalog.id = contentHash(body);
  return { catalog, sources, provenances, warnings };
}

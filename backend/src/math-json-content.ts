/** The JSON schemas in prompt/ are the single authoring contract. No LLM is used here. */
import { readFile, lstat, realpath } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { Ajv } from "ajv";
import type { Catalog, Citation, Concept, CurriculumNode, Objective, Unit, Capability } from "./math-types.js";
import { contentHash, invariant, checkBytes } from "./math-schema.js";
import { validateGraph } from "./math-graph.js";
import { compileCurriculumDependencies, dependencyClosure, type ManifestNode } from "./math-curriculum-dependencies.js";
import { validateMathMarkdown, markdownAst } from "./math-content.js";
export const JSON_COMPILER_VERSION = "math-json-2";
export interface JsonBlock { type: "block"; id: string; format: "markdown"; text: string }
export interface JsonSection { type: "section"; id: string; title: string; label?: string; keywords?: string[]; content: JsonContent[] }
export interface JsonItem {
  type: "item"; id: string; kind: string; title?: string; label?: string; keywords?: string[];
  content: (JsonBlock | JsonItem)[]; provesItemId?: string;
  learning?: { capabilities: Capability[]; requires: { itemId: string; capability: Capability }[]; proofCoverage: "none" | "sketch" | "complete" };
  objectives?: Omit<Objective, "unitId">[];
}
export type JsonContent = JsonBlock | JsonSection | JsonItem;
export interface JsonChapter {
  schemaVersion: 2; subjectId: string; chapterId: string; title: string;
  source: { kind: string; originalFile: string; originalSha256: string; urls?: string[]; originalHeadings?: string[] };
  content: JsonContent[];
}
export interface JsonSubject {
  schemaVersion: 2; subjectId: string; title: string; contentLanguage: string;
  nodes: ManifestNode[];
  dependencies: { semantics: "requires-all"; edges: { nodeId: string; requires: string[] }[] };
  foundationRefs: { subjectId: string; conceptId: string; capability: Capability; revisionId: string }[];
  review?: { contentHash: string; compilerVersion: typeof JSON_COMPILER_VERSION; reviewedBy: string; reviewedAt: string };
}
function schemaFile(name: string) {
  // Source and dist live one level below backend. Packaged runtime has dist/schemas.
  for (const url of [new URL(`./schemas/${name}`, import.meta.url), new URL(`../../prompt/${name}`, import.meta.url)]) {
    try { return JSON.parse(readFileSync(url, "utf8")); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Missing mathematics schema: ${name}`);
}
const ajv = new Ajv({ allErrors: true, strict: false });
const chapterValidator = ajv.compile(schemaFile("math-chapter.schema.json"));
const subjectValidator = ajv.compile(schemaFile("math-subject.schema.json"));
export const jsonAuthorPackageSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object", additionalProperties: false,
  properties: {
    schemaVersion: { const: 2 },
    subject: { $ref: "#/$defs/subject" },
    chapters: { type: "array", minItems: 1, maxItems: 1000, items: { $ref: "#/$defs/chapter" } },
    unresolved: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 2000 } },
  },
  required: ["schemaVersion", "subject", "chapters", "unresolved"],
  $defs: { subject: schemaFile("math-subject.schema.json"), chapter: schemaFile("math-chapter.schema.json") },
};
/** A small lexical JSON pass rejects duplicate object keys, including escaped aliases. */
export function parseStrictJson(text: string): unknown {
  checkBytes(text, 2 * 1024 * 1024);
  let at = 0;
  const ws = () => { while (/\s/.test(text[at] ?? "") && at < text.length) at++; };
  const string = () => {
    const start = at++; while (at < text.length) {
      if (text[at] === "\\") { at += 2; continue; }
      if (text[at++] === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new Error("Unterminated JSON string");
  };
  const value = (depth: number): void => {
    invariant(depth <= 40, "E_JSON_DEPTH"); ws();
    if (text[at] === "{") {
      at++; ws(); const keys = new Set<string>();
      if (text[at] === "}") { at++; return; }
      while (at < text.length) {
        invariant(text[at] === '"', "E_INVALID_JSON"); const key = string();
        invariant(!keys.has(key), "E_DUPLICATE_JSON_KEY", 400, { key }); keys.add(key);
        ws(); invariant(text[at++] === ":", "E_INVALID_JSON"); value(depth + 1); ws();
        if (text[at] === "}") { at++; return; }
        invariant(text[at++] === ",", "E_INVALID_JSON"); ws();
      }
      invariant(false, "E_INVALID_JSON");
    } else if (text[at] === "[") {
      at++; ws(); if (text[at] === "]") { at++; return; }
      while (at < text.length) { value(depth + 1); ws(); if (text[at] === "]") { at++; return; } invariant(text[at++] === ",", "E_INVALID_JSON"); }
      invariant(false, "E_INVALID_JSON");
    } else if (text[at] === '"') string();
    else { const start = at; while (at < text.length && !/[\s,}\]]/.test(text[at])) at++; invariant(at > start, "E_INVALID_JSON"); JSON.parse(text.slice(start, at)); }
  };
  value(0); ws(); invariant(at === text.length, "E_INVALID_JSON"); return JSON.parse(text);
}
export function parseJsonChapter(input: string | unknown): JsonChapter {
  const data = typeof input === "string" ? parseStrictJson(input) : input;
  checkBytes(data, 2 * 1024 * 1024);
  invariant(chapterValidator(data), "E_CHAPTER_SCHEMA", 400, { errors: chapterValidator.errors });
  validateChapter(data as JsonChapter); return data as JsonChapter;
}
function assertJsonPath(file: string) {
  invariant(file.endsWith(".json") && !isAbsolute(file) && !file.includes("\\") && !file.split("/").some(s => s === ".." || s === "" || s === "."), "E_UNSAFE_PATH");
}
export function parseJsonSubject(input: string | unknown): JsonSubject {
  const data = typeof input === "string" ? parseStrictJson(input) : input;
  invariant(subjectValidator(data), "E_SUBJECT_SCHEMA", 400, { errors: subjectValidator.errors });
  const subject = data as JsonSubject;
  for (const node of subject.nodes) if (node.contentFile) assertJsonPath(node.contentFile);
  compileCurriculumDependencies(subject.nodes, subject.dependencies.edges); return subject;
}
export function walkJsonContent(content: JsonContent[], visit: (node: JsonContent, path: (JsonSection | JsonItem)[]) => void, path: (JsonSection | JsonItem)[] = []) {
  invariant(path.length <= 24, "E_CHAPTER_DEPTH");
  for (const node of content) { visit(node, path); if (node.type !== "block") walkJsonContent(node.content, visit, [...path, node]); }
}
export function validateChapter(chapter: JsonChapter) {
  const ids = new Set<string>(), items = new Map<string, JsonItem>(); let count = 0;
  invariant(!isAbsolute(chapter.source.originalFile) && !chapter.source.originalFile.includes("\\") && !chapter.source.originalFile.split("/").includes(".."), "E_UNSAFE_SOURCE_PATH");
  validateMathMarkdown(chapter.title);
  walkJsonContent(chapter.content, (node) => {
    invariant(++count <= 20000, "E_CHAPTER_SIZE"); invariant(!ids.has(node.id), "E_DUPLICATE_CONTENT_ID"); ids.add(node.id);
    if (node.type !== "block" && node.title) validateMathMarkdown(node.title);
    if (node.type === "block") {
      // Raw HTML is never enabled in the renderer or accepted in new textbook content.
      const containsHtml = (n: any): boolean => n.type === "html" || (n.children ?? []).some(containsHtml);
      invariant(!containsHtml(markdownAst(node.text)), "E_RAW_HTML", 400, { blockId: node.id }); validateMathMarkdown(node.text);
    }
    if (node.type === "item") items.set(node.id, node);
  });
  for (const item of items.values()) {
    if (item.kind === "proof") invariant(item.provesItemId && items.has(item.provesItemId) && item.provesItemId !== item.id, "E_UNKNOWN_PROOF_TARGET");
    if (item.learning) invariant(new Set(item.learning.capabilities).size === item.learning.capabilities.length, "E_DUPLICATE_CAPABILITY");
    for (const o of item.objectives ?? []) {
      invariant(item.learning && o.assessedCapabilities.length > 0 && o.assessedCapabilities.every(r => r.conceptId === item.id && item.learning!.capabilities.includes(r.capability)), "E_OBJECTIVE_CAPABILITY");
      invariant(o.difficultyRange[0] <= o.difficultyRange[1], "E_DIFFICULTY_RANGE");
      invariant([...o.assessmentBlockIds, ...o.proofSupport.blockIds].every(id => ids.has(id)), "E_MISSING_BLOCK");
      if (o.assessedCapabilities.some(r => r.capability === "prove")) invariant(o.proofRequirement !== "none" && o.proofSupport.coverage !== "none" && o.proofSupport.blockIds.length > 0 && (o.proofRequirement !== "complete" || o.proofSupport.coverage === "complete"), "E_PROOF_SUPPORT_REQUIRED");
    }
    if (item.learning?.capabilities.includes("prove")) invariant(item.learning.proofCoverage !== "none", "E_PROOF_SUPPORT_REQUIRED");
  }
}
async function safeJson(root: string, file: string) {
  invariant(file.endsWith(".json") && !isAbsolute(file) && !file.includes("\\") && !file.split("/").some(s => s === ".." || s === "" || s === "."), "E_UNSAFE_PATH");
  const base = await realpath(root); let at = base;
  for (const segment of file.split("/")) { at = resolve(at, segment); invariant(!(await lstat(at)).isSymbolicLink(), "E_SYMLINK"); }
  invariant(relative(base, at) !== ".." && !relative(base, at).startsWith(`..${sep}`), "E_UNSAFE_PATH");
  return readFile(at, "utf8");
}
export function subjectReviewHash(subject: JsonSubject, chapters: JsonChapter[]) {
  const { review, ...manifest } = subject; return contentHash({ subject: manifest, chapters, compilerVersion: JSON_COMPILER_VERSION });
}
const emptyDeps = () => ({ allOf: [], anyOf: [] });
function displayTitle(item: JsonItem) { return item.title ?? `${item.kind}${item.label ? ` ${item.label}` : ""}`; }
export function compileJsonSubject(subject: JsonSubject, chapters: JsonChapter[], requireReview = true) {
  parseJsonSubject(subject); for (const chapter of chapters) parseJsonChapter(chapter);
  const deps = compileCurriculumDependencies(subject.nodes, subject.dependencies.edges);
  const reviewHash = subjectReviewHash(subject, chapters);
  if (requireReview) invariant(subject.review?.contentHash === reviewHash && subject.review.compilerVersion === JSON_COMPILER_VERSION, "E_JSON_REVIEW_REQUIRED");
  const nodes: CurriculumNode[] = subject.nodes.map(n => ({ id: n.id, subjectId: subject.subjectId, parentId: n.parentId, ancestorIds: deps.ancestors[n.id], kind: n.kind, title: n.title, order: n.order, unitIds: [] }));
  const units: Unit[] = [], concepts: Concept[] = [], objectives: Objective[] = [];
  const sources: Record<string, string> = {}, artifacts: Record<string, JsonChapter> = {}, conceptChapterIds: Record<string, string> = {};
  const allIds = new Set(subject.nodes.map(n => n.id));
  for (const chapter of chapters) {
    invariant(chapter.subjectId === subject.subjectId && subject.nodes.some(n => n.id === chapter.chapterId && n.kind === "chapter"), "E_CHAPTER_ID");
    const artifactHash = contentHash(chapter); sources[artifactHash] = JSON.stringify(chapter); artifacts[artifactHash] = chapter;
    const chapterPath = [...deps.ancestors[chapter.chapterId], chapter.chapterId].map(id => { const n = nodes.find(n => n.id === id)!; return { sourceNodeId: n.id, kind: n.kind, title: n.title }; });
    walkJsonContent(chapter.content, (node, path) => {
      invariant(!allIds.has(node.id), "E_DUPLICATE_CONTENT_ID"); allIds.add(node.id);
      if (node.type === "block") return;
      const parentId = path.at(-1)?.id ?? chapter.chapterId;
      const ancestorIds = [...deps.ancestors[chapter.chapterId], chapter.chapterId, ...path.map(n => n.id)];
      const display = node.type === "item" ? displayTitle(node) : node.title;
      const displayWithLabel = node.label && node.title ? `${node.label}. ${display}` : display;
      const runtimeNode: CurriculumNode = { id: node.id, subjectId: subject.subjectId, parentId, ancestorIds, kind: node.type === "section" ? "section" : node.kind, title: displayWithLabel, order: (path.at(-1)?.content ?? chapter.content).findIndex(n => n.id === node.id), unitIds: [] };
      nodes.push(runtimeNode);
      if (node.type !== "item" || !node.learning) return;
      const branch = path[0] ?? node;
      const context = chapter.content.slice(0, chapter.content.findIndex(c => c.id === branch.id)).filter(c => c.type === "block") as JsonBlock[];
      const collected: JsonBlock[] = [...context];
      // Only context preceding this branch is inherited; later sibling prose cannot leak backward.
      for (let i = 0; i < path.length; i++) {
        const ancestor = path[i], child = path[i + 1] ?? node;
        for (const c of ancestor.content.slice(0, ancestor.content.findIndex(c => c.id === child.id))) if (c.type === "block") collected.push(c);
      }
      walkJsonContent(node.content, c => { if (c.type === "block") collected.push(c); });
      const blocks = [...new Map(collected.map(b => [b.id, b])).values()].map(b => ({ id: b.id, kind: "knowledge", anchor: b.id, markdown: b.text, provenanceId: `provenance-${contentHash(b.id).slice(0, 32)}` }));
      const statement = blocks.map(b => b.markdown).join("\n\n"); checkBytes(statement, 64 * 1024);
      const capabilities = Object.fromEntries(node.learning.capabilities.map(capability => [capability, { prerequisites: { allOf: node.learning!.requires.map(r => ({ conceptId: r.itemId, capability: r.capability })), anyOf: [] } }]));
      const revisionId = contentHash({ node, blocks, artifactHash, compilerVersion: JSON_COMPILER_VERSION });
      const citation: Citation = { citationId: `cite-${contentHash({ id: node.id, revisionId }).slice(0, 40)}`, conceptId: node.id, conceptRevisionId: revisionId, sourceOccurrenceId: node.id, origin: chapter.source.kind === "author" ? "author" : "source", subjectTitle: subject.title, sourceRevisionId: artifactHash, sourcePath: [...chapterPath, ...path.map(n => ({ sourceNodeId: n.id, kind: n.type === "section" ? "section" : n.kind, title: n.type === "section" ? n.title : displayTitle(n), ...(n.label ? { printedLabel: n.label } : {}) }))], itemKind: node.kind, ...(node.label ? { printedItemLabel: node.label } : {}), itemTitle: display, blockIds: blocks.map(b => b.id), hierarchyStatus: "verified", supportingCitationIds: [] };
      const compiledObjectives: Objective[] = node.objectives ? node.objectives.map(o => ({ ...o, unitId: node.id })) : node.learning.capabilities.filter(c => c !== "prove").map(capability => ({ id: `${node.id.slice(0, 68)}-${contentHash(node.id + capability).slice(0, 10)}-${capability}`, unitId: node.id, description: `${capability}: ${display}`, assessedCapabilities: [{ conceptId: node.id, capability }], additionalPrerequisites: emptyDeps(), assessmentBlockIds: blocks.map(b => b.id), difficultyRange: [1, 2], proofRequirement: "none", proofSupport: { coverage: "none", blockIds: [] }, readiness: "ready" }));
      const count = compiledObjectives.filter(o => o.readiness === "ready").length;
      if (node.content.some(c => c.type === "item")) {
        // A learnable parent must remain selectable even when it contains proof/remark supplements.
        const targetId = `${node.id.slice(0, 72)}-target-${contentHash(node.id).slice(0, 8)}`;
        invariant(!allIds.has(targetId), "E_DUPLICATE_CONTENT_ID"); allIds.add(targetId);
        nodes.push({ id: targetId, subjectId: subject.subjectId, parentId: node.id, ancestorIds: [...ancestorIds, node.id], kind: "objective", title: displayWithLabel, order: -1, unitIds: [node.id], ...({ eligibleObjectiveCount: count } as object) });
      } else {
        runtimeNode.unitIds = [node.id];
        (runtimeNode as CurriculumNode & { eligibleObjectiveCount: number }).eligibleObjectiveCount = count;
      }
      concepts.push({ id: node.id, subjectId: subject.subjectId, ownerUnitId: node.id, revisionId, title: display, kind: node.kind, readiness: "ready", statement, conditions: context.map(b => b.text).join("\n\n"), capabilities, provideable: false, requiredToUseWhenGiven: [], related: [], recommended: [], citations: [citation], sourceArtifactHash: artifactHash, blockIds: blocks.map(b => b.id) });
      units.push({ id: node.id, subjectId: subject.subjectId, revisionId, title: display, contentLanguage: subject.contentLanguage, sourceArtifactHash: artifactHash, provenanceHash: contentHash(citation), reviewHash, objectiveIds: compiledObjectives.map(o => o.id), conceptIds: [node.id], blocks, problemFamilies: [], proofCoverage: node.learning.proofCoverage, status: compiledObjectives.some(o => o.readiness === "ready") ? "ready" : "reference-only" });
      objectives.push(...compiledObjectives); conceptChapterIds[node.id] = chapter.chapterId;
    });
  }
  const chapterIds = chapters.map(c => c.chapterId);
  invariant(new Set(chapterIds).size === chapterIds.length && subject.nodes.filter(n => n.kind === "chapter").every(n => chapterIds.includes(n.id)), "E_MISSING_CHAPTER");
  for (const concept of concepts) for (const capability of Object.values(concept.capabilities)) for (const ref of capability!.prerequisites.allOf) {
    const source = conceptChapterIds[concept.id], target = conceptChapterIds[ref.conceptId];
    invariant(target && (source === target || dependencyClosure(deps.chapterDependencies, source).includes(target)), "E_CROSS_CHAPTER_DEPENDENCY");
  }
  for (const objective of objectives) for (const ref of [...objective.additionalPrerequisites.allOf, ...objective.additionalPrerequisites.anyOf.flatMap(a => a.requires)]) {
    const source = conceptChapterIds[objective.unitId], target = conceptChapterIds[ref.conceptId];
    invariant(target && (source === target || dependencyClosure(deps.chapterDependencies, source).includes(target)), "E_CROSS_CHAPTER_DEPENDENCY");
  }
  return { nodes, units, concepts, objectives, sources, artifacts, chapterDependencies: deps.chapterDependencies, conceptChapterIds, reviewHash };
}
export async function buildJsonCatalog(root: string, options: { requireReview?: boolean } = {}) {
  const manifest = parseStrictJson(await safeJson(root, "catalog.json")) as { schemaVersion: number; subjects: string[] };
  invariant(manifest && Object.keys(manifest).sort().join(",") === "schemaVersion,subjects" && manifest.schemaVersion === 2 && Array.isArray(manifest.subjects) && manifest.subjects.every(f => typeof f === "string") && manifest.subjects.length <= 100, "E_CATALOG_SCHEMA");
  const seenPaths = new Set<string>(), subjects: JsonSubject[] = [], results: ReturnType<typeof compileJsonSubject>[] = [];
  const track = (file: string) => { const key = file.normalize("NFC").toLowerCase(); invariant(!seenPaths.has(key), "E_PATH_COLLISION"); seenPaths.add(key); };
  for (const file of manifest.subjects) {
    track(file); const subject = parseJsonSubject(await safeJson(root, file)); subjects.push(subject);
    const chapters: JsonChapter[] = [];
    for (const node of subject.nodes.filter(n => n.kind === "chapter")) {
      invariant(node.contentFile, "E_MISSING_CHAPTER_FILE");
      const path = `${dirname(file) === "." ? "" : dirname(file) + "/"}${node.contentFile}`;
      track(path); const chapter = parseJsonChapter(await safeJson(root, path)); invariant(chapter.chapterId === node.id, "E_CHAPTER_ID"); chapters.push(chapter);
    }
    results.push(compileJsonSubject(subject, chapters, options.requireReview !== false));
  }
  const catalog = { id: "", schemaVersion: 1, parserVersion: JSON_COMPILER_VERSION, subjects: subjects.map((s, i) => ({ id: s.subjectId, title: s.title, rootNodeId: s.nodes.find(n => n.parentId === null)!.id, order: i, foundationProfileIds: [], foundationRefs: s.foundationRefs })), nodes: results.flatMap(r => r.nodes), units: results.flatMap(r => r.units), concepts: results.flatMap(r => r.concepts), objectives: results.flatMap(r => r.objectives), profiles: [], curriculumHash: contentHash(subjects.map(({ review, ...s }) => s)), chapterDependencies: Object.assign({}, ...results.map(r => r.chapterDependencies)), conceptChapterIds: Object.assign({}, ...results.map(r => r.conceptChapterIds)), foundationRefs: subjects.flatMap(s => s.foundationRefs) } as Catalog;
  for (const collection of [catalog.subjects, catalog.nodes, catalog.concepts, catalog.units, catalog.objectives]) invariant(new Set(collection.map(n => n.id)).size === collection.length, "E_DUPLICATE_CATALOG_ID");
  for (const foundation of subjects.flatMap(s => s.foundationRefs)) {
    const concept = catalog.concepts.find(c => c.id === foundation.conceptId && c.subjectId === foundation.subjectId && c.revisionId === foundation.revisionId);
    invariant(concept?.capabilities[foundation.capability], "E_UNKNOWN_FOUNDATION_REVISION");
  }
  validateGraph(catalog); const { id, ...body } = catalog; catalog.id = contentHash(body);
  return { catalog, sources: Object.assign({}, ...results.map(r => r.sources)) as Record<string,string>, artifacts: Object.assign({}, ...results.map(r => r.artifacts)) as Record<string,JsonChapter>, provenances: {} as Record<string,unknown>, warnings: [] as string[] };
}

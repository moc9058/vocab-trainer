import { mathHash, mathText, sourceHeadings } from "./math-core.js";
import type { Curriculum, MathSource } from "./math-types.js";
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function curriculumRevision(
  c: Omit<Curriculum, "revision"> | Curriculum,
): string {
  const { revision: _, ...content } = c as Curriculum;
  return mathHash(canonical(content));
}
export function validateCurriculum(
  raw: unknown,
  bookId: string,
  sources: MathSource[],
  files: { id: string; file: string }[],
  language: string,
): Curriculum {
  const c = raw as Curriculum;
  const fail = (message: string): never => {
    throw new Error(`Invalid curriculum: ${message}`);
  };
  if (
    !c ||
    c.schemaVersion !== 2 ||
    c.bookId !== bookId ||
    c.instructionLanguage !== "en" ||
    c.sourceLanguage !== language ||
    !Array.isArray(c.sources) ||
    !Array.isArray(c.objectives) ||
    !c.objectives.length
  )
    fail("metadata");
  if (
    c.sources.length !== sources.length ||
    new Set(c.sources.map((s) => s.chapterId)).size !== sources.length
  )
    fail("sources");
  for (const s of sources) {
    const entry = c.sources.find((r) => r.chapterId === s.id);
    if (
      !entry ||
      entry.sha256 !== mathHash(s.markdown) ||
      entry.file !== files.find((f) => f.id === s.id)?.file
    )
      fail(`stale source ${s.id}`);
  }
  const ids = new Set<string>();
  for (const o of c.objectives) {
    const source = sources.find((s) => s.id === o.chapterId);
    if (
      !/^[\w-]{1,100}$/.test(o.id) ||
      ids.has(o.id) ||
      !source ||
      !mathText(o.statement, 4000) ||
      !["active", "retired"].includes(o.status) ||
      !["concept", "application", "reasoning", "modeling"].includes(o.ability)
    )
      fail(`objective ${o.id}`);
    ids.add(o.id);
    if (
      !Array.isArray(o.supportedTaskKinds) ||
      !o.supportedTaskKinds.length ||
      new Set(o.supportedTaskKinds).size !== o.supportedTaskKinds.length ||
      o.supportedTaskKinds.some(
        (k) => !["prove", "determine", "compute", "derive"].includes(k),
      )
    )
      fail(`task kinds ${o.id}`);
    if (!Array.isArray(o.sourceRefs) || !o.sourceRefs.length)
      fail(`references ${o.id}`);
    for (const r of o.sourceRefs) {
      const s = sources.find((s) => s.id === r.chapterId);
      if (
        !s ||
        !mathText(r.section, 1000) ||
        !sourceHeadings(s.markdown).includes(r.heading) ||
        !r.heading.replace(/<[^>]*>/g, "").startsWith(r.section)
      )
        fail(`section ${o.id}: ${r.heading}`);
    }
    for (const key of [
      "prerequisiteObjectiveIds",
      "requiredBackground",
      "scopeConstraints",
      "commonErrors",
    ] as const) {
      if (!Array.isArray(o[key]) || o[key].some((v) => !mathText(v, 4000)))
        fail(`${key} ${o.id}`);
    }
    if (
      !Array.isArray(o.successCriteria) ||
      !o.successCriteria.length ||
      new Set(o.successCriteria.map((s) => s.id)).size !==
        o.successCriteria.length ||
      o.successCriteria.some(
        (s) => !mathText(s.id, 100) || !mathText(s.criterion, 4000),
      )
    )
      fail(`criteria ${o.id}`);
    if (Buffer.byteLength(canonical(o)) > 64000)
      fail(`objective exceeds 64KB: ${o.id}`);
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) fail(`prerequisite cycle ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const o = c.objectives.find((o) => o.id === id)!;
    for (const p of o.prerequisiteObjectiveIds) {
      const dep = c.objectives.find((o) => o.id === p);
      if (!dep || (o.status === "active" && dep.status !== "active"))
        fail(`unknown/retired prerequisite ${p}`);
      if (
        sources.find((s) => s.id === dep!.chapterId)!.number >
        sources.find((s) => s.id === o.chapterId)!.number
      )
        fail(`later prerequisite ${p}`);
      visit(p);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const o of c.objectives) visit(o.id);
  if (c.revision !== curriculumRevision(c)) fail("revision hash");
  return c;
}
export function curriculumReadingView(c: Curriculum): string {
  return (
    `# ${c.bookId} learning objectives\n\nGenerated from learning-objectives.json. Revision: ${c.revision}.\n\nOperational statements are English; problems follow the book language.\n\n` +
    c.objectives
      .map(
        (o) =>
          `## ${o.id}\n\n${o.statement}\n\n${o.localizedStatements?.ja ?? ""}\n\nStatus: ${o.status}. Tasks: ${o.supportedTaskKinds.join(", ")}.\n\n${o.sourceRefs.map((r) => `- ${r.chapterId}: ${r.heading}`).join("\n")}\n\n${o.successCriteria.map((s) => `- ${s.id}: ${s.criterion}`).join("\n")}\n`,
      )
      .join("\n")
  );
}

/** Hierarchy and knowledge dependencies are separate DAGs. */
import { invariant } from "./math-schema.js";
export interface ManifestNode {
  id: string; kind: "subject" | "part" | "chapter"; parentId: string | null;
  order: number; title: string; contentFile?: string;
}
export interface ChapterDependencies {
  roots: string[];
  ancestors: Record<string, string[]>;
  chapterDependencies: Record<string, string[]>;
}
export function dependencyClosure(dependencies: Record<string, string[]>, id: string): string[] {
  const found = new Set<string>(), active = new Set<string>();
  const visit = (at: string) => {
    invariant(dependencies[at], "E_UNKNOWN_CHAPTER");
    invariant(!active.has(at), "E_CURRICULUM_DEPENDENCY_CYCLE");
    if (found.has(at)) return;
    active.add(at);
    for (const child of dependencies[at]) visit(child);
    active.delete(at); found.add(at);
  };
  visit(id); found.delete(id); return [...found].sort();
}
export function compileCurriculumDependencies(
  nodes: ManifestNode[], edges: { nodeId: string; requires: string[] }[],
): ChapterDependencies {
  const index = new Map(nodes.map(n => [n.id, n]));
  invariant(index.size === nodes.length, "E_DUPLICATE_NODE_ID");
  const roots = nodes.filter(n => n.parentId === null);
  invariant(roots.length === 1 && roots[0].kind === "subject", "E_INVALID_ROOT");
  const ancestors: Record<string, string[]> = {};
  for (const node of nodes) {
    const path: string[] = [], visited = new Set([node.id]);
    let parent = node.parentId;
    while (parent !== null) {
      invariant(!visited.has(parent), "E_NODE_CYCLE"); visited.add(parent);
      const p = index.get(parent); invariant(p, "E_MISSING_NODE_ID");
      invariant(p.kind !== "chapter", "E_CHAPTER_HAS_MANIFEST_CHILDREN");
      path.unshift(parent); parent = p.parentId;
      invariant(path.length <= 32, "E_CURRICULUM_DEPTH");
    }
    invariant(node.id === roots[0].id || path[0] === roots[0].id, "E_INVALID_ROOT");
    invariant(node.kind !== "subject" || node.id === roots[0].id, "E_INVALID_ROOT");
    ancestors[node.id] = path;
  }
  const chapters = nodes.filter(n => n.kind === "chapter");
  const descendants = (id: string) => chapters.filter(n => n.id === id || ancestors[n.id].includes(id)).map(n => n.id);
  const result: Record<string, string[]> = Object.fromEntries(chapters.map(n => [n.id, []]));
  invariant(new Set(edges.map(e => e.nodeId)).size === edges.length, "E_DUPLICATE_DEPENDENCY_EDGE");
  for (const edge of edges) {
    invariant(index.has(edge.nodeId) && index.get(edge.nodeId)!.kind !== "subject", "E_UNKNOWN_DEPENDENCY_NODE");
    invariant(new Set(edge.requires).size === edge.requires.length, "E_DUPLICATE_DEPENDENCY_EDGE");
    for (const prerequisite of edge.requires) {
      invariant(index.has(prerequisite) && index.get(prerequisite)!.kind !== "subject", "E_UNKNOWN_DEPENDENCY_NODE");
      const required = descendants(prerequisite);
      invariant(required.length, "E_EMPTY_DEPENDENCY_PART");
      for (const chapter of descendants(edge.nodeId))
        result[chapter].push(...required);
    }
  }
  for (const id of Object.keys(result)) {
    result[id] = [...new Set(result[id])].sort();
    invariant(!result[id].includes(id), "E_CURRICULUM_SELF_DEPENDENCY");
  }
  for (const id of Object.keys(result)) dependencyClosure(result, id);
  return { roots: roots.map(n => n.id), ancestors, chapterDependencies: result };
}

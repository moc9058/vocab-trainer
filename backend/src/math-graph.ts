import type { CapabilityRef, Catalog, Dependencies } from "./math-types.js";
import { invariant, MATH_LIMITS, MathError } from "./math-schema.js";
export const refKey = (ref: CapabilityRef) =>
  `${ref.conceptId}:${ref.capability}`;
export const uniqueRefs = (refs: CapabilityRef[]) =>
  [...new Map(refs.map((r) => [refKey(r), r])).values()].sort((a, b) =>
    refKey(a).localeCompare(refKey(b), "en"),
  );
export const emptyDependencies = (): Dependencies => ({ allOf: [], anyOf: [] });
export function graphIndex(catalog: Catalog) {
  return new Map(catalog.concepts.map((c) => [c.id, c]));
}
export function validateGraph(catalog: Catalog): void {
  const concepts = graphIndex(catalog),
    visiting = new Set<string>(),
    done = new Set<string>();
  function visit(ref: CapabilityRef, path: string[]) {
    const key = refKey(ref),
      c = concepts.get(ref.conceptId);
    invariant(c?.capabilities[ref.capability], "E_UNKNOWN_PREREQUISITE", 400, {
      path: [...path, key],
    });
    invariant(!visiting.has(key), "E_DEPENDENCY_CYCLE", 400, {
      path: [...path, key],
    });
    if (done.has(key)) return;
    visiting.add(key);
    const d = c.capabilities[ref.capability]!.prerequisites;
    for (const child of [...d.allOf, ...d.anyOf.flatMap((a) => a.requires)])
      visit(child, [...path, key]);
    visiting.delete(key);
    done.add(key);
  }
  for (const c of catalog.concepts) {
    for (const capability of Object.keys(
      c.capabilities,
    ) as CapabilityRef["capability"][])
      visit({ conceptId: c.id, capability }, []);
    for (const ref of [
      ...c.requiredToUseWhenGiven,
      ...c.related,
      ...c.recommended,
    ])
      invariant(
        concepts.get(ref.conceptId)?.capabilities[ref.capability],
        "E_UNKNOWN_PREREQUISITE",
      );
    if (c.provideable)
      for (const ref of c.requiredToUseWhenGiven)
        invariant(ref.conceptId !== c.id, "E_GIVEN_CYCLE");
  }
  for (const o of catalog.objectives)
    for (const ref of [
      ...o.assessedCapabilities,
      ...o.additionalPrerequisites.allOf,
      ...o.additionalPrerequisites.anyOf.flatMap((a) => a.requires),
    ]) {
      invariant(
        concepts.get(ref.conceptId)?.capabilities[ref.capability],
        "E_UNKNOWN_PREREQUISITE",
        400,
        { objectiveId: o.id, ref },
      );
    }
}
interface Expansion {
  refs: CapabilityRef[];
  branches: { owner: string; alternativeId: string }[];
  priority: number;
  paths: Record<string, string[]>;
  givens: CapabilityRef[];
}
/** Enumerates complete alternatives before ranking, so local greedy choices cannot hide costs. */
export function resolveDependencies(
  catalog: Catalog,
  roots: CapabilityRef[],
  additional: { owner: string; dependencies: Dependencies }[],
  known: Set<string>,
  options: { provided?: boolean; mustEstablish?: Set<string> } = {},
): Expansion {
  const concepts = graphIndex(catalog);
  let explored = 0;
  const count = () => {
    if (++explored > MATH_LIMITS.orSearch)
      throw new MathError("DEPENDENCY_TOO_COMPLEX", 422);
  };
  const merge = (a: Expansion, b: Expansion): Expansion => ({
    refs: uniqueRefs([...a.refs, ...b.refs]),
    givens: uniqueRefs([...a.givens, ...b.givens]),
    branches: [...a.branches, ...b.branches].filter(
      (x, i, all) =>
        all.findIndex(
          (v) => v.owner === x.owner && v.alternativeId === x.alternativeId,
        ) === i,
    ),
    priority: a.priority + b.priority,
    paths: { ...a.paths, ...b.paths },
  });
  const blank = (): Expansion => ({
    refs: [],
    branches: [],
    paths: {},
    givens: [],
    priority: 0,
  });
  function combine(groups: Expansion[][]): Expansion[] {
    return groups.reduce(
      (acc, group) =>
        acc.flatMap((a) =>
          group
            .filter(
              (b) =>
                !b.branches.some((branch) =>
                  a.branches.some(
                    (prior) =>
                      prior.owner === branch.owner &&
                      prior.alternativeId !== branch.alternativeId,
                  ),
                ),
            )
            .map((b) => {
              count();
              return merge(a, b);
            }),
        ),
      [blank()],
    );
  }
  function expand(ref: CapabilityRef, path: string[]): Expansion[] {
    count();
    const key = refKey(ref),
      c = concepts.get(ref.conceptId);
    invariant(c?.capabilities[ref.capability], "E_UNKNOWN_PREREQUISITE");
    invariant(c.readiness === "ready", "MATH_CONCEPT_NOT_READY", 422);
    invariant(!path.includes(key), "E_DEPENDENCY_CYCLE", 422, {
      path: [...path, key],
    });
    let given = false;
    if (
      options.provided &&
      !known.has(key) &&
      c.provideable &&
      !options.mustEstablish?.has(key)
    )
      given = true;
    const dep = given
      ? { allOf: c.requiredToUseWhenGiven, anyOf: [] }
      : c.capabilities[ref.capability]!.prerequisites;
    return expandDeps(key, dep, [...path, key]).map((e) =>
      merge(e, {
        ...blank(),
        refs: [ref],
        givens: given ? [ref] : [],
        paths: { [key]: [...path, key] },
      }),
    );
  }
  function expandDeps(
    owner: string,
    dep: Dependencies,
    path: string[],
  ): Expansion[] {
    const mandatory = combine(dep.allOf.map((r) => expand(r, path)));
    if (!dep.anyOf.length) return mandatory;
    const alternatives = dep.anyOf.flatMap((a) =>
      combine(a.requires.map((r) => expand(r, path))).map((e) => ({
        ...e,
        branches: [...e.branches, { owner, alternativeId: a.id }],
        priority: e.priority + a.priority,
      })),
    );
    return combine([mandatory, alternatives]);
  }
  const variants = combine([
    ...roots.map((r) => expand(r, [])),
    ...additional.map((a) => expandDeps(a.owner, a.dependencies, [])),
  ]);
  const rank = (e: Expansion) =>
    [
      e.refs.filter(
        (r) =>
          !known.has(refKey(r)) &&
          !e.givens.some((g) => refKey(g) === refKey(r)),
      ).length,
      e.refs.filter((r) => !known.has(refKey(r))).length,
      e.priority,
    ] as const;
  variants.sort((a, b) => {
    const ar = rank(a),
      br = rank(b);
    for (let i = 0; i < 3; i++) if (ar[i] !== br[i]) return ar[i] - br[i];
    return JSON.stringify(a.branches).localeCompare(
      JSON.stringify(b.branches),
      "en",
    );
  });
  return variants[0] ?? blank();
}

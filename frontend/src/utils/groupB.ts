import { getGroups, createGroup } from "../api/vocab";
import { getGrammarGroups, createGrammarGroup } from "../api/grammar";
import { categoryGroups } from "../types";

/**
 * A Group B group holds words AND grammar together — unlike Group A, where a word
 * group and a grammar group are unrelated sets that merely happen to share a name.
 *
 * The backend still stores each side as its own document (`word_groups` /
 * `grammar_groups`, both `category: "B"`); the group NAME is what joins them into
 * one study set. A one-sided group is normal — it just means that domain has no
 * members yet — so the missing side is created on demand at registration time.
 */
export interface UnifiedGroupB {
  name: string;
  wordGroupId?: string;
  grammarGroupId?: string;
}

/** Every category-B group of a language, merged across both domains by name.
 *  Read failures REJECT rather than degrade to []: a swallowed error is
 *  indistinguishable from "this side doesn't exist", and resolveGroupBTargets
 *  would then CREATE duplicate-named groups it merely failed to see. */
export async function loadGroupBGroups(language: string): Promise<UnifiedGroupB[]> {
  const [wordGroups, grammarGroups] = await Promise.all([
    getGroups(language),
    getGrammarGroups(language),
  ]);
  const byName = new Map<string, UnifiedGroupB>();
  for (const g of categoryGroups(wordGroups, "B")) {
    byName.set(g.name, { ...(byName.get(g.name) ?? { name: g.name }), wordGroupId: g.id });
  }
  for (const g of categoryGroups(grammarGroups, "B")) {
    byName.set(g.name, { ...(byName.get(g.name) ?? { name: g.name }), grammarGroupId: g.id });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Creates both sides so the new group is immediately usable by either domain.
 *  Re-checks the server first and only creates the missing halves: a retry
 *  after a half-failed pair create (network drop between the two POSTs) must
 *  HEAL the pair, not duplicate the side that survived. The server's
 *  category-B create is also idempotent by name, so even a concurrent create
 *  resolves to one group per side. */
export async function createGroupBGroup(language: string, name: string): Promise<UnifiedGroupB> {
  const existing = (await loadGroupBGroups(language)).find((g) => g.name === name);
  const wordGroupId = existing?.wordGroupId ?? (await createGroup(language, name, "B")).id;
  const grammarGroupId = existing?.grammarGroupId ?? (await createGrammarGroup(language, name, "B")).id;
  return { name, wordGroupId, grammarGroupId };
}

/**
 * Turn selected group names into the concrete per-domain IDs the queues need,
 * filling in whichever side does not exist yet. Only the domains that actually
 * have something to register are materialized, so analyzing an article with no
 * grammar never leaves an empty grammar group behind.
 */
export async function resolveGroupBTargets(
  language: string,
  names: string[],
  need: { words: boolean; grammar: boolean }
): Promise<{ wordGroupIds: string[]; grammarGroupIds: string[] }> {
  if (names.length === 0) return { wordGroupIds: [], grammarGroupIds: [] };
  const groups = await loadGroupBGroups(language);
  const byName = new Map(groups.map((g) => [g.name, g]));

  const wordGroupIds: string[] = [];
  const grammarGroupIds: string[] = [];
  for (const name of names) {
    const group = byName.get(name);
    if (need.words) {
      wordGroupIds.push(group?.wordGroupId ?? (await createGroup(language, name, "B")).id);
    }
    if (need.grammar) {
      grammarGroupIds.push(
        group?.grammarGroupId ?? (await createGrammarGroup(language, name, "B")).id
      );
    }
  }
  return { wordGroupIds, grammarGroupIds };
}

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

/** Every category-B group of a language, merged across both domains by name. */
export async function loadGroupBGroups(language: string): Promise<UnifiedGroupB[]> {
  const [wordGroups, grammarGroups] = await Promise.all([
    getGroups(language).catch(() => []),
    getGrammarGroups(language).catch(() => []),
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

/** Creates both sides at once so the new group is immediately usable by either domain. */
export async function createGroupBGroup(language: string, name: string): Promise<UnifiedGroupB> {
  const [wordGroup, grammarGroup] = await Promise.all([
    createGroup(language, name, "B"),
    createGrammarGroup(language, name, "B"),
  ]);
  return { name, wordGroupId: wordGroup.id, grammarGroupId: grammarGroup.id };
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

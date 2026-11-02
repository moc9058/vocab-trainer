import type { WordGroup } from "./types.js";

export interface WordRegistrationGroups {
  /** At most one A group; B groups may also be included for existing clients. */
  groupIds?: string[];
  /** Explicit additional B memberships. */
  groupBIds?: string[];
}

export class WordRegistrationGroupError extends Error {}

/** A registration always has one A home; default is chronological, independent of display order. */
export function resolveWordRegistrationGroups(language: string, groups: WordGroup[], request: WordRegistrationGroups) {
  const available = groups.filter(group => group.language === language);
  const byId = new Map(available.map(group => [group.id, group]));
  const requested = [...new Set([...(request.groupIds ?? []), ...(request.groupBIds ?? [])])];
  for (const id of requested) {
    if (!byId.has(id)) throw new WordRegistrationGroupError(`Word group '${id}' does not exist in ${language}`);
  }
  for (const id of request.groupBIds ?? []) {
    if (byId.get(id)!.category !== "B") throw new WordRegistrationGroupError(`Word group '${id}' is not a Group B group`);
  }
  const selectedA = requested.map(id => byId.get(id)!).filter(group => group.category !== "B");
  if (selectedA.length > 1) throw new WordRegistrationGroupError("A word can be registered in only one Group A group");
  const a = selectedA[0] ?? available.filter(group => group.category !== "B")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
  if (!a) throw new WordRegistrationGroupError("Create a Group A word group before registering a word");
  const b = requested.map(id => byId.get(id)!).filter(group => group.category === "B");
  return { a, b };
}

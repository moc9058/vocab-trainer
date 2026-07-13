import { fetchJson, postJson, putJson, deleteRequest } from "./client";
import type {
  Grammar,
  GrammarDraft,
  GrammarGroup,
  GrammarQuizSession,
  GrammarSettings,
  PaginatedResult,
  Word,
} from "../types";

export function getGrammarItems(
  language: string,
  filters?: { level?: string; search?: string; groupId?: string },
  page = 1,
  limit = 50
): Promise<PaginatedResult<Grammar>> {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("limit", String(limit));
  if (filters?.level) params.set("level", filters.level);
  if (filters?.search) params.set("search", filters.search);
  if (filters?.groupId) params.set("groupId", filters.groupId);
  return fetchJson(`/api/grammar/${encodeURIComponent(language)}/items?${params}`);
}

export function createGrammarItem(
  language: string,
  item: Omit<Grammar, "language">
): Promise<Grammar> {
  return postJson(`/api/grammar/${encodeURIComponent(language)}/items`, item);
}

export function smartAddGrammarItem(
  language: string,
  item: Omit<Grammar, "language">
): Promise<Grammar> {
  return postJson(`/api/grammar/${encodeURIComponent(language)}/smart-add`, item);
}

export function updateGrammarItem(
  language: string,
  grammarId: string,
  updates: Partial<Grammar>
): Promise<Grammar> {
  return putJson(
    `/api/grammar/${encodeURIComponent(language)}/items/${encodeURIComponent(grammarId)}`,
    updates
  );
}

export function deleteGrammarItem(language: string, grammarId: string): Promise<void> {
  return deleteRequest(
    `/api/grammar/${encodeURIComponent(language)}/items/${encodeURIComponent(grammarId)}`
  );
}

// ----- Grammar Drafts -----

export function getGrammarDrafts(language: string): Promise<GrammarDraft[]> {
  return fetchJson(`/api/grammar/${encodeURIComponent(language)}/drafts`);
}

export function uploadGrammarDrafts(
  language: string,
  drafts: Array<Omit<GrammarDraft, "id" | "language" | "createdAt">>
): Promise<{ created: number; drafts: GrammarDraft[] }> {
  return postJson(`/api/grammar/${encodeURIComponent(language)}/drafts`, { drafts });
}

export function updateGrammarDraft(
  language: string,
  draftId: string,
  updates: Partial<Omit<GrammarDraft, "id" | "language" | "createdAt">>
): Promise<GrammarDraft> {
  return putJson(
    `/api/grammar/${encodeURIComponent(language)}/drafts/${encodeURIComponent(draftId)}`,
    updates
  );
}

export function deleteGrammarDraft(language: string, draftId: string): Promise<void> {
  return deleteRequest(
    `/api/grammar/${encodeURIComponent(language)}/drafts/${encodeURIComponent(draftId)}`
  );
}

// ----- Settings -----

export function getGrammarSettings(): Promise<GrammarSettings> {
  return fetchJson("/api/grammar/settings");
}

export function updateGrammarSettings(defaultDefinitionLanguage: string): Promise<GrammarSettings> {
  return putJson("/api/grammar/settings", { defaultDefinitionLanguage });
}

// ----- Grammar Groups -----

export function getGrammarGroups(language: string): Promise<GrammarGroup[]> {
  return fetchJson(`/api/grammar/${encodeURIComponent(language)}/groups`);
}

export function createGrammarGroup(language: string, name: string): Promise<GrammarGroup> {
  return postJson(`/api/grammar/${encodeURIComponent(language)}/groups`, { name });
}

export function renameGrammarGroup(
  language: string,
  groupId: string,
  name: string
): Promise<GrammarGroup> {
  return putJson(
    `/api/grammar/${encodeURIComponent(language)}/groups/${encodeURIComponent(groupId)}`,
    { name }
  );
}

export function deleteGrammarGroup(language: string, groupId: string): Promise<void> {
  return deleteRequest(
    `/api/grammar/${encodeURIComponent(language)}/groups/${encodeURIComponent(groupId)}`
  );
}

export function modifyGrammarGroupMembers(
  language: string,
  groupId: string,
  grammarIds: string[],
  action: "add" | "remove"
): Promise<GrammarGroup> {
  return postJson(
    `/api/grammar/${encodeURIComponent(language)}/groups/${encodeURIComponent(groupId)}/grammar`,
    { grammarIds, action }
  );
}

// ----- Quiz -----

export function startGrammarQuiz(opts: {
  language: string;
  questionCount?: number;
  groupIds?: string[];
  groupWeights?: Record<string, number>;
}): Promise<GrammarQuizSession> {
  return postJson("/api/grammar-quiz/start", opts);
}

// Mid-session weight change: server reorders the unanswered tail and returns
// the full session in the new order.
export function updateGrammarQuizWeights(
  language: string,
  groupWeights: Record<string, number>
): Promise<GrammarQuizSession> {
  return putJson(
    `/api/grammar-quiz/session/language/${encodeURIComponent(language)}/weights`,
    { groupWeights }
  );
}

export function answerGrammarQuestion(opts: {
  language: string;
  grammarId: string;
  correct: boolean;
}): Promise<{ session: GrammarQuizSession }> {
  return postJson("/api/grammar-quiz/answer", opts);
}

export async function getCurrentGrammarSession(language: string): Promise<GrammarQuizSession | null> {
  try {
    return await fetchJson(`/api/grammar-quiz/session/language/${encodeURIComponent(language)}`);
  } catch {
    return null;
  }
}

export function getGrammarProgress(
  language: string
): Promise<{ language: string; components: Record<string, unknown> }> {
  return fetchJson(`/api/grammar-progress/${encodeURIComponent(language)}`);
}

export function resetGrammarProgress(language: string): Promise<void> {
  return deleteRequest(`/api/grammar-progress/${encodeURIComponent(language)}`);
}

export function checkMissingWords(language: string, terms: string[]): Promise<{ missing: string[] }> {
  return postJson("/api/grammar-quiz/check-missing-words", { language, terms });
}

export function addMissingWords(
  language: string,
  words: { term: string; pinyin: string; sentence: string; translation: string }[]
): Promise<{ added: Word[] }> {
  return postJson("/api/grammar-quiz/add-missing-words", { language, words });
}

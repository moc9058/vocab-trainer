import { fetchJson, postJson, putJson, deleteRequest } from "./client";
import type {
  GrammarChapterInfo,
  GrammarItemDoc,
  GrammarQuizSession,
  PaginatedResult,
  Word,
} from "../types";

export function getGrammarChapters(language: string): Promise<GrammarChapterInfo[]> {
  return fetchJson(`/api/grammar/${encodeURIComponent(language)}/chapters`);
}

export function getGrammarItems(
  language: string,
  filters?: { chapter?: number; subchapter?: string; level?: string; search?: string },
  page = 1,
  limit = 50
): Promise<PaginatedResult<GrammarItemDoc>> {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("limit", String(limit));
  if (filters?.chapter) params.set("chapter", String(filters.chapter));
  if (filters?.subchapter) params.set("subchapter", filters.subchapter);
  if (filters?.level) params.set("level", filters.level);
  if (filters?.search) params.set("search", filters.search);
  return fetchJson(`/api/grammar/${encodeURIComponent(language)}/items?${params}`);
}

export function createGrammarItem(
  language: string,
  item: Omit<GrammarItemDoc, "language">
): Promise<GrammarItemDoc> {
  return postJson(`/api/grammar/${encodeURIComponent(language)}/items`, item);
}

export function updateGrammarItem(
  language: string,
  componentId: string,
  updates: Partial<GrammarItemDoc>
): Promise<GrammarItemDoc> {
  return putJson(`/api/grammar/${encodeURIComponent(language)}/items/${encodeURIComponent(componentId)}`, updates);
}

export function deleteGrammarItem(
  language: string,
  componentId: string
): Promise<void> {
  return deleteRequest(`/api/grammar/${encodeURIComponent(language)}/items/${encodeURIComponent(componentId)}`);
}

export function getSubchapters(
  language: string,
  chapters?: number[]
): Promise<{ chapterNumber: number; subchapterId: string; subchapterTitle: Record<string, string> }[]> {
  const params = new URLSearchParams();
  if (chapters && chapters.length > 0) params.set("chapters", chapters.join(","));
  return fetchJson(`/api/grammar/${encodeURIComponent(language)}/subchapters?${params}`);
}

export function startGrammarQuiz(opts: {
  language: string;
  questionCount?: number;
  chapters?: number[];
  subchapters?: string[];
  displayLanguage?: string;
  quizMode?: string;
}): Promise<GrammarQuizSession> {
  return postJson("/api/grammar-quiz/start", opts);
}

export function answerGrammarQuestion(opts: {
  language: string;
  componentId: string;
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

export function getGrammarProgress(language: string): Promise<{ language: string; components: Record<string, unknown> }> {
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

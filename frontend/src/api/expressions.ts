import { fetchJson, postJson, putJson, deleteRequest } from "./client";
import type {
  Expression,
  ExpressionGroup,
  ExpressionQuizSubsession,
  CorrectionResult,
  PaginatedResult,
} from "../types";

export function getExpressions(
  language: string,
  filters?: { search?: string; purpose?: string; groupId?: string },
  page = 1,
  limit = 50
): Promise<PaginatedResult<Expression>> {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("limit", String(limit));
  if (filters?.search) params.set("search", filters.search);
  if (filters?.purpose) params.set("purpose", filters.purpose);
  if (filters?.groupId) params.set("groupId", filters.groupId);
  return fetchJson(`/api/expressions/${encodeURIComponent(language)}/items?${params}`);
}

export function createExpression(
  language: string,
  item: Omit<Expression, "language">
): Promise<Expression> {
  return postJson(`/api/expressions/${encodeURIComponent(language)}/items`, item);
}

export function updateExpression(
  language: string,
  expressionId: string,
  updates: Partial<Expression>
): Promise<Expression> {
  return putJson(
    `/api/expressions/${encodeURIComponent(language)}/items/${encodeURIComponent(expressionId)}`,
    updates
  );
}

export function deleteExpression(language: string, expressionId: string): Promise<void> {
  return deleteRequest(
    `/api/expressions/${encodeURIComponent(language)}/items/${encodeURIComponent(expressionId)}`
  );
}

// ----- Expression Groups -----

export function getExpressionGroups(language: string): Promise<ExpressionGroup[]> {
  return fetchJson(`/api/expressions/${encodeURIComponent(language)}/groups`);
}

export function createExpressionGroup(language: string, name: string): Promise<ExpressionGroup> {
  return postJson(`/api/expressions/${encodeURIComponent(language)}/groups`, { name });
}

export function renameExpressionGroup(
  language: string,
  groupId: string,
  name: string
): Promise<ExpressionGroup> {
  return putJson(
    `/api/expressions/${encodeURIComponent(language)}/groups/${encodeURIComponent(groupId)}`,
    { name }
  );
}

export function deleteExpressionGroup(language: string, groupId: string): Promise<void> {
  return deleteRequest(
    `/api/expressions/${encodeURIComponent(language)}/groups/${encodeURIComponent(groupId)}`
  );
}

export function modifyExpressionGroupMembers(
  language: string,
  groupId: string,
  expressionIds: string[],
  action: "add" | "remove"
): Promise<ExpressionGroup> {
  return postJson(
    `/api/expressions/${encodeURIComponent(language)}/groups/${encodeURIComponent(groupId)}/expressions`,
    { expressionIds, action }
  );
}

// ----- Quiz -----

export function startExpressionQuiz(opts: {
  language: string;
  questionCount?: number;
  purposeFilter?: ("speaking" | "writing")[];
  groupIds?: string[];
}): Promise<ExpressionQuizSubsession> {
  return postJson("/api/expression-quiz/start", opts);
}

export function submitExpressionAnswer(opts: {
  language: string;
  expressionId: string;
  userInput: string;
}): Promise<{ expressionQuiz: ExpressionQuizSubsession; correctionResult: CorrectionResult }> {
  return postJson("/api/expression-quiz/answer", opts);
}

export function gradeExpressionQuestion(opts: {
  language: string;
  expressionId: string;
  correct: boolean;
}): Promise<{ expressionQuiz: ExpressionQuizSubsession }> {
  return postJson("/api/expression-quiz/grade", opts);
}

export async function getCurrentExpressionSession(
  language: string
): Promise<ExpressionQuizSubsession | null> {
  try {
    return await fetchJson(`/api/expression-quiz/session/language/${encodeURIComponent(language)}`);
  } catch {
    return null;
  }
}

/** Bulk hydration for the recall quiz — one call covers a whole session. */
export function getExpressionsByIds(
  language: string,
  ids: string[]
): Promise<{ items: Expression[] }> {
  return postJson(`/api/expressions/${encodeURIComponent(language)}/items/batch`, { ids });
}

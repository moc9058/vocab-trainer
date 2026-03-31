import { fetchJson, putJson, deleteRequest } from "./client";

export interface TokenUsageRecord {
  id: string;
  timestamp: string;
  model: string;
  caller: string;
  route: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  thoughtsTokens?: number;
}

export interface TokenUsageDailySummary {
  model: string;
  date: string;
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  thoughtsTokens: number;
  byRoute: Record<string, {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>;
}

export interface TokenCostRate {
  input: number;
  cachedInput: number;
  output: number;
  thoughtsInput: number;
}

export interface TokenCostConfig {
  models: Record<string, TokenCostRate>;
  updatedAt: string;
}

export interface UsageMetricsSummary {
  period: { from: string; to: string };
  byModel: Record<string, {
    totalCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    thoughtsTokens: number;
    estimatedCost: number;
  }>;
  totalEstimatedCost: number;
  daily: TokenUsageDailySummary[];
}

export async function getUsageLogs(params?: {
  model?: string;
  route?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}): Promise<{ records: TokenUsageRecord[]; total: number }> {
  const query = new URLSearchParams();
  if (params?.model) query.set("model", params.model);
  if (params?.route) query.set("route", params.route);
  if (params?.from) query.set("from", params.from);
  if (params?.to) query.set("to", params.to);
  if (params?.page) query.set("page", String(params.page));
  if (params?.limit) query.set("limit", String(params.limit));
  const qs = query.toString();
  return fetchJson(`/api/metrics/usage${qs ? `?${qs}` : ""}`);
}

export async function getUsageSummary(params?: {
  from?: string;
  to?: string;
}): Promise<UsageMetricsSummary> {
  const query = new URLSearchParams();
  if (params?.from) query.set("from", params.from);
  if (params?.to) query.set("to", params.to);
  const qs = query.toString();
  return fetchJson(`/api/metrics/summary${qs ? `?${qs}` : ""}`);
}

export async function getCostConfig(): Promise<TokenCostConfig> {
  return fetchJson("/api/metrics/costs");
}

export async function updateCostConfig(
  models: Record<string, TokenCostRate>
): Promise<TokenCostConfig> {
  return putJson("/api/metrics/costs", { models });
}

export async function clearUsageLogs(): Promise<void> {
  return deleteRequest("/api/metrics/usage");
}

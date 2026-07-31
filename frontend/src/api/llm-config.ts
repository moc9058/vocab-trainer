import { fetchJson, postJson, putJson } from "./client";

/** Mirrors `backend/src/llm-features.ts:LLMFeature`. Served by the API rather
 *  than duplicated here, so the two can never drift. */
export interface LLMFeature {
  key: string;
  routes: string[];
  defaultTier: "mini" | "full";
  label: string;
  description: string;
}

export type LLMModelSource = "feature" | "default" | "env";

export interface LLMConfigPayload {
  catalog: string[];
  defaults: { mini?: string; full?: string };
  features: Record<string, string>;
  updatedAt: string;
  featureCatalog: LLMFeature[];
  /** The env / `config/llm` values every resolution falls back to. */
  tierFallbacks: { mini: string; full: string };
  /** What each feature would actually use right now, and why. */
  effective: Record<string, { model: string; source: LLMModelSource }>;
}

export interface ModelTestResult {
  ok: boolean;
  model: string;
  /** True once `models.retrieve` succeeded — distinguishes "no such model" from
   *  "exists but the call was rejected". */
  exists: boolean;
  latencyMs: number;
  error?: string;
}

export function getLLMConfig(): Promise<LLMConfigPayload> {
  return fetchJson("/api/llm-config/");
}

export function updateLLMConfig(body: {
  catalog: string[];
  defaults: { mini?: string; full?: string };
  features: Record<string, string>;
}): Promise<LLMConfigPayload> {
  return putJson("/api/llm-config/", body);
}

export function testLLMModel(model: string): Promise<ModelTestResult> {
  return postJson("/api/llm-config/test", { model });
}

export function listAvailableModels(): Promise<{
  models: { id: string; created: number }[];
  error?: string;
}> {
  return fetchJson("/api/llm-config/available");
}

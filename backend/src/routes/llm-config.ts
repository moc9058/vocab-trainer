import type { FastifyPluginAsync } from "fastify";
import { getLLMModelConfig, setLLMModelConfig, ensureModelInCostConfig } from "../firestore.js";
import {
  createOpenAIClient,
  invalidateModelConfigCache,
  getModelMini,
  getModelFull,
  resolveEffectiveModels,
} from "../llm.js";
import { LLM_FEATURES, FEATURE_BY_KEY } from "../llm-features.js";
import type { LLMModelConfig } from "../types.js";

const EMPTY: LLMModelConfig = {
  catalog: [],
  defaults: {},
  features: {},
  updatedAt: "",
};

/** The env / `config/llm` values — the floor every resolution falls back to.
 *  `getModelFull` throws when unset, which is not an error here: the settings
 *  screen wants to SHOW that it is unset. */
async function tierFallbacks(): Promise<{ mini: string; full: string }> {
  const [mini, full] = await Promise.all([
    getModelMini().catch(() => ""),
    getModelFull().catch(() => ""),
  ]);
  return { mini, full };
}

async function buildPayload(config: LLMModelConfig) {
  const fallbacks = await tierFallbacks();
  return {
    ...config,
    /** The static catalog, so the client needs no duplicated copy. */
    featureCatalog: LLM_FEATURES,
    tierFallbacks: fallbacks,
    // Computed by llm.ts itself (beside resolveModel), so what the UI shows and
    // what a call would use cannot drift.
    effective: resolveEffectiveModels(config, fallbacks),
  };
}

const llmConfigRoutes: FastifyPluginAsync = async (fastify) => {
  // GET / — current assignments plus what each feature would actually use.
  // Never exposes OPENAI_API_KEY: it lives in config/llm, a different document.
  fastify.get("/", async () => {
    const config = (await getLLMModelConfig()) ?? EMPTY;
    return buildPayload(config);
  });

  // PUT / — replace the catalog and assignments wholesale.
  fastify.put<{
    Body: {
      catalog: string[];
      defaults: { mini?: string; full?: string };
      features: Record<string, string>;
    };
  }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          required: ["catalog", "defaults", "features"],
          properties: {
            catalog: { type: "array", items: { type: "string" } },
            defaults: {
              type: "object",
              properties: { mini: { type: "string" }, full: { type: "string" } },
            },
            features: { type: "object" },
          },
        },
      },
    },
    async (request, reply) => {
      const { catalog, defaults, features } = request.body;

      const cleanCatalog = [...new Set(catalog.map((m) => m.trim()).filter(Boolean))];

      const cleanDefaults: { mini?: string; full?: string } = {};
      for (const tier of ["mini", "full"] as const) {
        const v = defaults?.[tier]?.trim();
        if (v) cleanDefaults[tier] = v;
      }

      // An unknown feature key would be dead weight nobody can see or clear from
      // the UI, so reject rather than silently store it.
      const cleanFeatures: Record<string, string> = {};
      for (const [key, value] of Object.entries(features ?? {})) {
        if (!FEATURE_BY_KEY.has(key)) {
          return reply.badRequest(`Unknown LLM feature key: ${key}`);
        }
        const v = typeof value === "string" ? value.trim() : "";
        if (v) cleanFeatures[key] = v;
      }

      const config: LLMModelConfig = {
        catalog: cleanCatalog,
        defaults: cleanDefaults,
        features: cleanFeatures,
        updatedAt: new Date().toISOString(),
      };
      await setLLMModelConfig(config);
      // So this instance serves the new value at once instead of waiting out the
      // 30s TTL. Other instances catch up on their own.
      invalidateModelConfigCache();
      return buildPayload(config);
    }
  );

  // POST /test — does this model name actually exist, and can we call it?
  //
  // Two probes, because one is ambiguous: newer reasoning models reject
  // `temperature` and `max_tokens`, so a failed completion alone cannot
  // distinguish "no such model" from "wrong parameters". `models.retrieve`
  // answers the first question on its own.
  //
  // Always 200 — the client renders OpenAI's own error text verbatim, which is
  // the only useful answer to "is `gpt-5.6-terra` a real model?".
  fastify.post<{ Body: { model: string } }>(
    "/test",
    {
      schema: {
        body: {
          type: "object",
          required: ["model"],
          properties: { model: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request) => {
      const model = request.body.model.trim();
      const started = Date.now();
      let exists = false;

      try {
        const cl = await createOpenAIClient();

        await cl.models.retrieve(model);
        exists = true;

        // Deliberately NOT routed through `recordUsage` — a settings probe is
        // not study activity, and logging it would put phantom rows in the
        // metrics and skew "which feature costs most".
        await cl.chat.completions.create({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_completion_tokens: 1,
        });

        // Register it now rather than on first real use, so its (zero) rates are
        // already visible on the Costs tab while the user is still here.
        await ensureModelInCostConfig(model).catch(() => {});

        return { ok: true as const, model, exists, latencyMs: Date.now() - started };
      } catch (err) {
        return {
          ok: false as const,
          model,
          exists,
          latencyMs: Date.now() - started,
          error: (err as Error).message,
        };
      }
    }
  );

  // GET /available — seed the catalog picker from the account's own model list.
  //
  // Returned unfiltered: the list mixes chat models with embeddings, tts,
  // whisper and image models, but filtering by name prefix would reintroduce
  // hardcoded model knowledge, which this repo currently has none of. The client
  // has a search box instead. Newest first, since that is what you are hunting
  // for when a new model ships.
  fastify.get("/available", async () => {
    try {
      const cl = await createOpenAIClient();
      const list = await cl.models.list();
      const models = [...list.data]
        .sort((a, b) => b.created - a.created)
        .map((m) => ({ id: m.id, created: m.created }));
      return { models };
    } catch (err) {
      return { models: [] as { id: string; created: number }[], error: (err as Error).message };
    }
  });
};

export default llmConfigRoutes;

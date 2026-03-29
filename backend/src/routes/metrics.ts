import type { FastifyPluginAsync } from "fastify";
import type { TokenCostConfig, TokenCostRate, UsageMetricsSummary } from "../types.js";
import {
  getTokenUsageLogs,
  getDailyUsageSummaries,
  getTokenCostConfig,
  setTokenCostConfig,
  clearTokenUsage,
} from "../firestore.js";

const metricsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /usage — paginated raw usage logs
  fastify.get<{
    Querystring: {
      model?: string;
      route?: string;
      from?: string;
      to?: string;
      page?: string;
      limit?: string;
    };
  }>("/usage", async (request) => {
    const { model, route, from, to, page, limit } = request.query;
    return getTokenUsageLogs({
      model,
      route,
      from,
      to,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  });

  // GET /summary — aggregated summary with cost estimates
  fastify.get<{
    Querystring: { from?: string; to?: string };
  }>("/summary", async (request) => {
    const { from, to } = request.query;
    const [dailySummaries, costConfig] = await Promise.all([
      getDailyUsageSummaries(from, to),
      getTokenCostConfig(),
    ]);

    const byModel: UsageMetricsSummary["byModel"] = {};

    for (const day of dailySummaries) {
      if (!byModel[day.model]) {
        byModel[day.model] = {
          totalCalls: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cachedTokens: 0,
          estimatedCost: 0,
        };
      }
      const m = byModel[day.model];
      m.totalCalls += day.totalCalls;
      m.promptTokens += day.promptTokens;
      m.completionTokens += day.completionTokens;
      m.totalTokens += day.totalTokens;
      m.cachedTokens += day.cachedTokens;
    }

    // Compute estimated costs
    let totalEstimatedCost = 0;
    if (costConfig) {
      for (const [model, agg] of Object.entries(byModel)) {
        const rates: TokenCostRate | undefined = costConfig.models[model];
        if (!rates) continue;

        const nonCachedInput = agg.promptTokens - agg.cachedTokens;
        const inputCost = rates.input * nonCachedInput;
        const cachedCost = rates.cachedInput * agg.cachedTokens;
        const outputCost = rates.output * agg.completionTokens;

        agg.estimatedCost = inputCost + cachedCost + outputCost;
        totalEstimatedCost += agg.estimatedCost;
      }
    }

    const period = {
      from: from ?? (dailySummaries.length > 0 ? dailySummaries[dailySummaries.length - 1].date : ""),
      to: to ?? (dailySummaries.length > 0 ? dailySummaries[0].date : ""),
    };

    return {
      period,
      byModel,
      totalEstimatedCost,
      daily: dailySummaries,
    } satisfies UsageMetricsSummary;
  });

  // GET /costs — get current cost configuration
  fastify.get("/costs", async () => {
    const config = await getTokenCostConfig();
    return config ?? { models: {}, updatedAt: "" };
  });

  // PUT /costs — update cost-per-token rates
  fastify.put<{
    Body: { models: Record<string, TokenCostRate> };
  }>("/costs", {
    schema: {
      body: {
        type: "object",
        required: ["models"],
        properties: {
          models: { type: "object" },
        },
      },
    },
  }, async (request) => {
    const config: TokenCostConfig = {
      models: request.body.models,
      updatedAt: new Date().toISOString(),
    };
    await setTokenCostConfig(config);
    return config;
  });

  // DELETE /usage — clear all usage logs and daily summaries
  fastify.delete("/usage", async () => {
    await clearTokenUsage();
    return { success: true };
  });
};

export default metricsRoutes;

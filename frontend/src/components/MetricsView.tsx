import { useState, useEffect, useCallback } from "react";
import {
  getUsageSummary,
  getCostConfig,
  updateCostConfig,
  clearUsageLogs,
  getUsageLogs,
  type UsageMetricsSummary,
  type TokenCostConfig,
  type TokenCostRate,
  type TokenUsageRecord,
} from "../api/metrics";

function formatCost(cost: number | null | undefined): string {
  const c = cost ?? 0;
  if (c < 0.01) return `$${c.toFixed(6)}`;
  if (c < 1) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}

function formatNumber(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

export default function MetricsView() {
  const [summary, setSummary] = useState<UsageMetricsSummary | null>(null);
  const [costConfig, setCostConfig] = useState<TokenCostConfig | null>(null);
  const [logs, setLogs] = useState<TokenUsageRecord[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"summary" | "logs" | "costs">("summary");
  const [dateRange, setDateRange] = useState<{ from: string; to: string }>({
    from: "",
    to: "",
  });

  // Cost editing state
  const [editingCosts, setEditingCosts] = useState<Record<string, TokenCostRate>>({});
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([
        getUsageSummary(dateRange.from || dateRange.to ? dateRange : undefined),
        getCostConfig(),
      ]);
      setSummary(s);
      setCostConfig(c);
      setEditingCosts(c.models ?? {});
    } catch (err) {
      console.error("Failed to fetch metrics:", err);
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  const fetchLogs = useCallback(async () => {
    try {
      const result = await getUsageLogs({ page: logsPage, limit: 20 });
      setLogs(result.records);
      setLogsTotal(result.total);
    } catch (err) {
      console.error("Failed to fetch logs:", err);
    }
  }, [logsPage]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (activeTab === "logs") fetchLogs();
  }, [activeTab, fetchLogs]);

  async function handleSaveCosts() {
    setSaving(true);
    try {
      const updated = await updateCostConfig(editingCosts);
      setCostConfig(updated);
      await fetchData();
    } catch (err) {
      console.error("Failed to save costs:", err);
    } finally {
      setSaving(false);
    }
  }

  async function handleClearLogs() {
    if (!confirm("Clear all usage logs? This cannot be undone.")) return;
    try {
      await clearUsageLogs();
      await fetchData();
      setLogs([]);
      setLogsTotal(0);
    } catch (err) {
      console.error("Failed to clear logs:", err);
    }
  }

  function handleCostChange(model: string, field: keyof TokenCostRate, value: string) {
    const num = parseFloat(value) || 0;
    setEditingCosts((prev) => ({
      ...prev,
      [model]: { ...prev[model], [field]: num },
    }));
  }

  if (loading && !summary) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-gray-400">Loading metrics...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6 space-y-6">
      <h2 className="text-xl font-bold text-gray-100">LLM Usage Metrics</h2>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg bg-gray-800 p-1">
        {(["summary", "logs", "costs"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              activeTab === tab
                ? "bg-gray-700 text-white"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            {tab === "summary" ? "Summary" : tab === "logs" ? "Usage Logs" : "Cost Config"}
          </button>
        ))}
      </div>

      {/* Date range filter */}
      {activeTab === "summary" && (
        <div className="flex flex-wrap gap-3 items-center">
          <label className="text-sm text-gray-400">
            From
            <input
              type="date"
              value={dateRange.from}
              onChange={(e) => setDateRange((d) => ({ ...d, from: e.target.value }))}
              className="ml-2 rounded bg-gray-800 border border-gray-600 px-2 py-1 text-sm text-gray-200"
            />
          </label>
          <label className="text-sm text-gray-400">
            To
            <input
              type="date"
              value={dateRange.to}
              onChange={(e) => setDateRange((d) => ({ ...d, to: e.target.value }))}
              className="ml-2 rounded bg-gray-800 border border-gray-600 px-2 py-1 text-sm text-gray-200"
            />
          </label>
          {(dateRange.from || dateRange.to) && (
            <button
              onClick={() => setDateRange({ from: "", to: "" })}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              Clear dates
            </button>
          )}
        </div>
      )}

      {/* Summary Tab */}
      {activeTab === "summary" && summary && (
        <div className="space-y-6">
          {/* Total cost banner */}
          <div className="rounded-xl bg-gradient-to-r from-indigo-900/50 to-violet-900/50 border border-indigo-700/40 p-5">
            <p className="text-sm text-indigo-300">Total Estimated Cost</p>
            <p className="text-3xl font-bold text-white mt-1">
              {formatCost(summary.totalEstimatedCost)}
            </p>
            {summary.period.from && (
              <p className="text-xs text-indigo-400 mt-2">
                {summary.period.from} to {summary.period.to}
              </p>
            )}
          </div>

          {/* Per-model breakdown */}
          {Object.keys(summary.byModel).length > 0 ? (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
                By Model
              </h3>
              {Object.entries(summary.byModel).map(([model, data]) => (
                <div
                  key={model}
                  className="rounded-lg bg-gray-800/60 border border-gray-700 p-4"
                >
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-medium text-gray-200">{model}</h4>
                    <span className="text-sm font-medium text-indigo-400">
                      {formatCost(data.estimatedCost)}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <Stat label="Total Calls" value={formatNumber(data.totalCalls)} />
                    <Stat label="Prompt Tokens" value={formatNumber(data.promptTokens)} />
                    <Stat label="Cached Tokens" value={formatNumber(data.cachedTokens)} />
                    <Stat label="Completion Tokens" value={formatNumber(data.completionTokens)} />
                    <Stat label="Total Tokens" value={formatNumber(data.totalTokens)} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-gray-500 py-8">No usage data yet</p>
          )}

          {/* Daily breakdown */}
          {summary.daily.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
                Daily Usage
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-400 border-b border-gray-700">
                      <th className="pb-2 pr-4">Date</th>
                      <th className="pb-2 pr-4">Model</th>
                      <th className="pb-2 pr-4 text-right">Calls</th>
                      <th className="pb-2 pr-4 text-right">Prompt</th>
                      <th className="pb-2 pr-4 text-right">Cached</th>
                      <th className="pb-2 pr-4 text-right">Completion</th>
                      <th className="pb-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.daily.map((day, i) => (
                      <tr key={i} className="border-b border-gray-800 text-gray-300">
                        <td className="py-2 pr-4">{day.date}</td>
                        <td className="py-2 pr-4 text-gray-400">{day.model}</td>
                        <td className="py-2 pr-4 text-right">{day.totalCalls}</td>
                        <td className="py-2 pr-4 text-right">{formatNumber(day.promptTokens)}</td>
                        <td className="py-2 pr-4 text-right">{formatNumber(day.cachedTokens)}</td>
                        <td className="py-2 pr-4 text-right">{formatNumber(day.completionTokens)}</td>
                        <td className="py-2 text-right">{formatNumber(day.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Logs Tab */}
      {activeTab === "logs" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-400">{logsTotal} total records</p>
            <button
              onClick={handleClearLogs}
              className="rounded-lg border border-red-800 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900/30"
            >
              Clear All
            </button>
          </div>

          {logs.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-400 border-b border-gray-700">
                      <th className="pb-2 pr-3">Time</th>
                      <th className="pb-2 pr-3">Model</th>
                      <th className="pb-2 pr-3">Route</th>
                      <th className="pb-2 pr-3 text-right">Prompt</th>
                      <th className="pb-2 pr-3 text-right">Cached</th>
                      <th className="pb-2 pr-3 text-right">Completion</th>
                      <th className="pb-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log.id} className="border-b border-gray-800 text-gray-300">
                        <td className="py-2 pr-3 text-xs whitespace-nowrap">
                          {new Date(log.timestamp).toLocaleString()}
                        </td>
                        <td className="py-2 pr-3 text-xs text-gray-400">{log.model}</td>
                        <td className="py-2 pr-3 text-xs text-gray-400">{log.route}</td>
                        <td className="py-2 pr-3 text-right">{log.promptTokens}</td>
                        <td className="py-2 pr-3 text-right">{log.cachedTokens ?? 0}</td>
                        <td className="py-2 pr-3 text-right">{log.completionTokens}</td>
                        <td className="py-2 text-right">{log.totalTokens}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {logsTotal > 20 && (
                <div className="flex items-center justify-center gap-3">
                  <button
                    disabled={logsPage <= 1}
                    onClick={() => setLogsPage((p) => p - 1)}
                    className="rounded px-3 py-1 text-sm text-gray-400 hover:bg-gray-700 disabled:opacity-30"
                  >
                    Prev
                  </button>
                  <span className="text-sm text-gray-500">
                    Page {logsPage} of {Math.ceil(logsTotal / 20)}
                  </span>
                  <button
                    disabled={logsPage >= Math.ceil(logsTotal / 20)}
                    onClick={() => setLogsPage((p) => p + 1)}
                    className="rounded px-3 py-1 text-sm text-gray-400 hover:bg-gray-700 disabled:opacity-30"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="text-center text-gray-500 py-8">No usage logs yet</p>
          )}
        </div>
      )}

      {/* Cost Config Tab */}
      {activeTab === "costs" && (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            Set cost per token for each model. Values are in dollars per token
            (e.g. 0.00000015 = $0.15 per 1M tokens).
          </p>

          {Object.keys(editingCosts).length > 0 ? (
            Object.entries(editingCosts).map(([model, rates]) => (
              <div
                key={model}
                className="rounded-lg bg-gray-800/60 border border-gray-700 p-4 space-y-3"
              >
                <h4 className="font-medium text-gray-200">{model}</h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <CostInput
                    label="Input ($/token)"
                    value={rates.input}
                    onChange={(v) => handleCostChange(model, "input", v)}
                  />
                  <CostInput
                    label="Cached Input ($/token)"
                    value={rates.cachedInput}
                    onChange={(v) => handleCostChange(model, "cachedInput", v)}
                  />
                  <CostInput
                    label="Output ($/token)"
                    value={rates.output}
                    onChange={(v) => handleCostChange(model, "output", v)}
                  />
                </div>
              </div>
            ))
          ) : (
            <p className="text-center text-gray-500 py-6">
              No models registered yet. Models are added automatically when LLM calls are made.
            </p>
          )}

          <button
            onClick={handleSaveCosts}
            disabled={saving}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Cost Configuration"}
          </button>

          {costConfig?.updatedAt && (
            <p className="text-xs text-gray-500 text-center">
              Last updated: {new Date(costConfig.updatedAt).toLocaleString()}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm font-medium text-gray-300">{value}</p>
    </div>
  );
}

function CostInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-gray-500">{label}</span>
      <input
        type="number"
        step="any"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0"
        className="mt-1 w-full rounded bg-gray-900 border border-gray-600 px-2 py-1.5 text-sm text-gray-200"
      />
    </label>
  );
}

import { useState, useEffect, useCallback } from "react";
import {
  getLLMConfig,
  updateLLMConfig,
  testLLMModel,
  listAvailableModels,
  type LLMConfigPayload,
  type LLMModelSource,
  type ModelTestResult,
} from "../api/llm-config";

/** English throughout, matching the sibling admin screen `MetricsView` — these
 *  are technical feature names shown beside raw route strings. */
type Tab = "assignments" | "catalog";

const SOURCE_LABEL: Record<LLMModelSource, string> = {
  feature: "assigned",
  default: "tier default",
  env: "from .env / config/llm",
};

const SOURCE_CLASS: Record<LLMModelSource, string> = {
  feature: "bg-emerald-900/40 text-emerald-300 border-emerald-700",
  default: "bg-sky-900/40 text-sky-300 border-sky-700",
  env: "bg-gray-700/60 text-gray-400 border-gray-600",
};

export default function LLMModelsView() {
  const [payload, setPayload] = useState<LLMConfigPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("assignments");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Local edit buffers, seeded from the fetch (the MetricsView costs-tab pattern).
  const [catalog, setCatalog] = useState<string[]>([]);
  const [defaults, setDefaults] = useState<{ mini?: string; full?: string }>({});
  const [features, setFeatures] = useState<Record<string, string>>({});

  const [newModel, setNewModel] = useState("");
  const [tests, setTests] = useState<Record<string, ModelTestResult | "pending">>({});
  const [available, setAvailable] = useState<string[] | null>(null);
  const [availableError, setAvailableError] = useState<string | null>(null);
  const [availableFilter, setAvailableFilter] = useState("");
  const [loadingAvailable, setLoadingAvailable] = useState(false);

  const seed = useCallback((p: LLMConfigPayload) => {
    setPayload(p);
    setCatalog(p.catalog ?? []);
    setDefaults(p.defaults ?? {});
    setFeatures(p.features ?? {});
  }, []);

  useEffect(() => {
    getLLMConfig()
      .then(seed)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [seed]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      // Any model that is actually in use must stay in the picker, or the next
      // edit would silently drop it.
      const inUse = [
        ...Object.values(features),
        ...(defaults.mini ? [defaults.mini] : []),
        ...(defaults.full ? [defaults.full] : []),
      ];
      const merged = [...new Set([...catalog, ...inUse])].filter(Boolean);
      const updated = await updateLLMConfig({ catalog: merged, defaults, features });
      seed(updated);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(model: string) {
    setTests((t) => ({ ...t, [model]: "pending" }));
    try {
      const result = await testLLMModel(model);
      setTests((t) => ({ ...t, [model]: result }));
    } catch (err) {
      setTests((t) => ({
        ...t,
        [model]: { ok: false, model, exists: false, latencyMs: 0, error: String(err) },
      }));
    }
  }

  async function handleLoadAvailable() {
    setLoadingAvailable(true);
    setAvailableError(null);
    try {
      const res = await listAvailableModels();
      setAvailable(res.models.map((m) => m.id));
      if (res.error) setAvailableError(res.error);
    } catch (err) {
      setAvailableError(String(err));
    } finally {
      setLoadingAvailable(false);
    }
  }

  function addModel(name: string) {
    const trimmed = name.trim();
    if (!trimmed || catalog.includes(trimmed)) return;
    setCatalog((c) => [...c, trimmed]);
    setNewModel("");
  }

  function removeModel(name: string) {
    setCatalog((c) => c.filter((m) => m !== name));
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-400 border-t-transparent" />
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <div className="rounded border border-red-700 bg-red-900/30 p-3 text-sm text-red-300">
          {error ?? "Failed to load LLM configuration."}
        </div>
      </div>
    );
  }

  const miniFeatures = payload.featureCatalog.filter((f) => f.defaultTier === "mini");
  const fullFeatures = payload.featureCatalog.filter((f) => f.defaultTier === "full");

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <h2 className="text-xl font-bold text-gray-100">LLM Models</h2>

      {/* The one coupling between this screen and the Costs tab — worth stating
          up front, because $0 spend looks like "free", not "unconfigured". */}
      <div className="rounded-lg border border-amber-800/60 bg-amber-900/20 p-3 text-xs leading-relaxed text-amber-200">
        A model you have never used before is auto-registered for cost tracking at{" "}
        <strong>zero rates</strong>, so its spend reads $0 until you enter the real prices
        under <em>LLM Usage &amp; Costs → Cost Config</em>.
        <br />
        Saved changes apply immediately on this server and within 30 seconds everywhere else.
      </div>

      <div className="flex gap-1 rounded-lg bg-gray-800 p-1">
        {(["assignments", "catalog"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              tab === t ? "bg-gray-700 text-white" : "text-gray-400 hover:text-gray-200"
            }`}
          >
            {t === "assignments" ? "Feature Assignments" : "Model Catalog"}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded border border-red-700 bg-red-900/30 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {tab === "catalog" ? (
        <section className="space-y-4">
          <div className="rounded-xl bg-gray-800/60 p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
              Registered models
            </h3>
            {catalog.length === 0 ? (
              <p className="text-sm text-gray-500">
                No models registered yet. Add one below — any OpenAI model name works.
              </p>
            ) : (
              <ul className="space-y-2">
                {catalog.map((model) => {
                  const result = tests[model];
                  return (
                    <li
                      key={model}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-700 bg-gray-900/40 px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-sm text-gray-200">
                        {model}
                      </span>
                      {result === "pending" ? (
                        <span className="text-xs text-gray-400">testing…</span>
                      ) : result ? (
                        <span
                          className={`text-xs ${result.ok ? "text-emerald-400" : "text-red-400"}`}
                        >
                          {result.ok ? `✓ ok (${result.latencyMs}ms)` : result.exists ? "✗ exists, call failed" : "✗ no such model"}
                        </span>
                      ) : null}
                      <button
                        onClick={() => handleTest(model)}
                        className="rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 transition-colors hover:bg-gray-700"
                      >
                        Test
                      </button>
                      <button
                        onClick={() => removeModel(model)}
                        className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-500 transition-colors hover:border-red-700 hover:text-red-400"
                      >
                        Remove
                      </button>
                      {result && result !== "pending" && result.error && (
                        // Verbatim provider text — the only useful answer to
                        // "is this a real model?".
                        <p className="w-full break-words font-mono text-[11px] leading-relaxed text-red-300/80">
                          {result.error}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <input
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addModel(newModel);
                  }
                }}
                list="llm-available-models"
                placeholder="gpt-5.6-terra"
                className="min-w-0 flex-1 rounded border border-gray-600 bg-gray-900 px-3 py-2 font-mono text-sm text-gray-200 placeholder:text-gray-600"
              />
              <datalist id="llm-available-models">
                {(available ?? []).map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <button
                onClick={() => addModel(newModel)}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
              >
                Add
              </button>
            </div>
          </div>

          <div className="rounded-xl bg-gray-800/60 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
                Available from OpenAI
              </h3>
              <button
                onClick={handleLoadAvailable}
                disabled={loadingAvailable}
                className="rounded border border-gray-600 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:bg-gray-700 disabled:opacity-50"
              >
                {loadingAvailable ? "Loading…" : available ? "Reload" : "Load from OpenAI"}
              </button>
            </div>
            {availableError && (
              <p className="mb-2 break-words font-mono text-[11px] text-red-300/80">{availableError}</p>
            )}
            {available === null ? (
              <p className="text-sm text-gray-500">
                Lists every model your API key can see, newest first — chat, embedding, audio and
                image models alike. Nothing is filtered out, because this app hardcodes no model
                names.
              </p>
            ) : (
              <>
                <input
                  value={availableFilter}
                  onChange={(e) => setAvailableFilter(e.target.value)}
                  placeholder="Filter…"
                  className="mb-3 w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600"
                />
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {available
                    .filter((id) => id.toLowerCase().includes(availableFilter.toLowerCase()))
                    .map((id) => (
                      <button
                        key={id}
                        onClick={() => addModel(id)}
                        disabled={catalog.includes(id)}
                        className="block w-full truncate rounded px-2 py-1 text-left font-mono text-xs text-gray-300 transition-colors hover:bg-gray-700 disabled:text-gray-600 disabled:hover:bg-transparent"
                      >
                        {catalog.includes(id) ? "✓ " : "+ "}
                        {id}
                      </button>
                    ))}
                </div>
              </>
            )}
          </div>
        </section>
      ) : (
        <section className="space-y-4">
          <div className="rounded-xl bg-gray-800/60 p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
              Tier defaults
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["mini", "full"] as const).map((tier) => (
                <label key={tier} className="block">
                  <span className="mb-1 block text-sm text-gray-300">
                    {tier === "mini" ? "MINI (fast / cheap tasks)" : "FULL (reasoning tasks)"}
                  </span>
                  <select
                    value={defaults[tier] ?? ""}
                    onChange={(e) =>
                      setDefaults((d) => ({ ...d, [tier]: e.target.value || undefined }))
                    }
                    className="w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-200"
                  >
                    <option value="">
                      {payload.tierFallbacks[tier]
                        ? `Use .env / config/llm (${payload.tierFallbacks[tier]})`
                        : "Use .env / config/llm (not set)"}
                    </option>
                    {catalog.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>

          {[
            { title: "MINI-tier features", items: miniFeatures },
            { title: "FULL-tier features", items: fullFeatures },
          ].map(({ title, items }) => (
            <div key={title} className="rounded-xl bg-gray-800/60 p-4">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
                {title}
              </h3>
              <ul className="space-y-3">
                {items.map((feature) => {
                  const eff = payload.effective[feature.key];
                  return (
                    <li
                      key={feature.key}
                      className="rounded-lg border border-gray-700 bg-gray-900/40 p-3"
                    >
                      <div className="mb-1 flex flex-wrap items-baseline gap-2">
                        <span className="text-sm font-medium text-gray-100">{feature.label}</span>
                        {eff && (
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] ${SOURCE_CLASS[eff.source]}`}
                          >
                            {eff.model || "unset"} · {SOURCE_LABEL[eff.source]}
                          </span>
                        )}
                      </div>
                      <p className="mb-2 text-xs text-gray-500">{feature.description}</p>
                      <p className="mb-2 font-mono text-[11px] text-gray-600">
                        {feature.routes.join("  ·  ")}
                      </p>
                      <select
                        value={features[feature.key] ?? ""}
                        onChange={(e) =>
                          setFeatures((f) => {
                            const next = { ...f };
                            if (e.target.value) next[feature.key] = e.target.value;
                            else delete next[feature.key];
                            return next;
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-200"
                      >
                        <option value="">Use {feature.defaultTier.toUpperCase()} default</option>
                        {catalog.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          <p className="text-xs text-gray-600">
            Maintenance scripts use their own route labels and are not listed here; they always
            take the tier default.
          </p>
        </section>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {savedAt && <span className="text-xs text-gray-500">Saved at {savedAt}</span>}
      </div>
    </div>
  );
}

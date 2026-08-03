import type { LLMTier } from "./types.js";

/**
 * The catalog of LLM-backed features the settings screen lets you assign a model to.
 *
 * `routes` are the `route` labels already passed at every `callLLM`
 * call site — they exist for per-feature token accounting (`recordUsage`), and
 * that makes them exactly the right configuration key too: both answer "which
 * feature is this?". Reusing them is why per-feature model assignment needs no
 * change at any call site.
 *
 * Streaming and non-streaming variants of one feature share a row: they are the
 * same job over a different transport, and nobody wants to configure them apart.
 */
export interface LLMFeature {
  /** Stable id persisted in `config/llm_models.features`. Never rename. */
  key: string;
  /** `route` labels that resolve to this feature. */
  routes: string[];
  /** Which tier default applies when this feature has no explicit assignment. */
  defaultTier: LLMTier;
  /** Shown as the row title. Plain English, like the sibling MetricsView screen
   *  — these are technical feature names and the route strings beside them are
   *  English anyway. */
  label: string;
  /** One line explaining what the call actually does. */
  description: string;
}

export const LLM_FEATURES: LLMFeature[] = [
  {
    key: "vocab-smart-add",
    routes: ["vocab/smart-add"],
    defaultTier: "mini",
    label: "Vocabulary smart-add",
    description:
      "Looks up a new word: definitions, examples, level, topics.",
  },
  {
    key: "example-translations",
    routes: ["vocab/translate-examples", "grammar/translate-examples"],
    defaultTier: "mini",
    label: "Example-sentence translations",
    description:
      "Fills in missing translations on example sentences (words and grammar).",
  },
  {
    key: "hanja-readings",
    routes: ["vocab/hanja-readings"],
    defaultTier: "full",
    label: "Korean hanja readings",
    description:
      "Per-character hun-eum readings for Chinese words.",
  },
  {
    key: "grammar-smart-add",
    routes: ["grammar/smart-add"],
    defaultTier: "mini",
    label: "Grammar smart-add",
    description:
      "Looks up a new grammar point and translates its descriptions.",
  },
  {
    key: "grammar-transliteration",
    routes: ["llm/fill-grammar-transliteration"],
    defaultTier: "mini",
    label: "Grammar statement pinyin",
    description:
      "Reading for a Chinese grammar statement.",
  },
  {
    key: "segmentation",
    routes: ["llm/segment-batch", "llm/fill-segment-pinyin"],
    defaultTier: "mini",
    label: "Sentence segmentation & pinyin",
    description:
      "Splits Chinese sentences into words and assigns per-segment pinyin.",
  },
  {
    key: "translation-decompose",
    routes: ["translation/decompose", "translation/decompose-stream"],
    defaultTier: "mini",
    label: "Translation: decompose",
    description:
      "Step 1 - splits the source text into sentences and chunks.",
  },
  {
    key: "translation-translate",
    routes: ["translation/translate", "translation/translate-stream"],
    defaultTier: "full",
    label: "Translation: translate",
    description:
      "Step 2 - produces the actual translation.",
  },
  {
    key: "import-analyze",
    routes: ["import/analyze-stream"],
    defaultTier: "full",
    label: "Article import analysis",
    description:
      "Segments an article and extracts every word and grammar point.",
  },
  {
    key: "speaking-writing",
    routes: ["speaking-writing/correct", "speaking-writing/correct-stream"],
    defaultTier: "full",
    label: "Speaking & writing correction",
    description:
      "Corrects your composed text and explains each change.",
  },
  {
    key: "expression-quiz-grade",
    routes: ["expression-quiz/answer"],
    defaultTier: "full",
    label: "Expression writing quiz",
    description:
      "Grades the sentence you write in the LLM-graded expression quiz. The expression RECALL quiz uses no LLM.",
  },
  {
    key: "grammar-quiz-batch-add",
    routes: ["grammar-quiz/batch-add"],
    defaultTier: "mini",
    label: "Grammar quiz batch word-add",
    description:
      "Bulk-creates words missing from a grammar item's examples.",
  },
];

/** route label -> feature key. A route that isn't here (the `scripts/*` ones,
 *  or `"unknown"`) simply falls through to the tier default. */
export const ROUTE_TO_FEATURE = new Map<string, string>(
  LLM_FEATURES.flatMap((f) => f.routes.map((r) => [r, f.key] as [string, string]))
);

export const FEATURE_BY_KEY = new Map<string, LLMFeature>(
  LLM_FEATURES.map((f) => [f.key, f])
);

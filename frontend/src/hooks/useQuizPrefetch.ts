import { useCallback, useEffect, useRef, useState } from "react";
import { hydrateQuizQuestions } from "../api/quiz";
import { getGrammarItemsByIds } from "../api/grammar";
import type { Grammar, QuizQuestion } from "../types";

/**
 * Loads every question of a quiz session up front, so once a quiz is running it needs the
 * network only to RECORD answers (and even that is deferred — see `utils/answerOutbox.ts`).
 *
 * Two properties make this work:
 *
 * 1. **Keyed by id, not by position.** A session's question order changes constantly — a wrong
 *    answer splices a retry copy into the tail, resume re-draws the tail from the group
 *    weights, the weights panel re-orders it mid-session — but the SET of ids never changes.
 *    The old paged loader indexed hydrated data positionally, so every re-order invalidated it
 *    and forced a blocking re-fetch. An id-keyed cache makes re-ordering free.
 *
 * 2. **First chunk small, rest large.** The first card renders as soon as `ready` flips, which
 *    takes one small request; the remainder streams in behind it. Downloading a whole session
 *    before showing anything would reproduce the very stall this exists to prevent.
 */

/** Small enough to land fast on a weak connection — this is what gates the first card. */
const FIRST_CHUNK = 24;
/** Everything after the first card is background work, so favour fewer round-trips. */
const CHUNK = 150;
const GRAMMAR_CHUNK = 100;

export interface QuizPrefetchResult {
  /** Hydrated word payloads (definitions/examples/hanja), keyed by `wordId`. */
  words: Map<string, QuizQuestion>;
  /** Hydrated grammar items (descriptions/examples), keyed by `grammarId`. */
  grammar: Map<string, Grammar>;
  /**
   * Ids the server confirmed it has no document for — a word or grammar item deleted after the
   * session was built. They will never land in the caches, so callers must treat them as
   * resolved rather than as "still loading", or the quiz would deadlock on that card.
   */
  missing: Set<string>;
  /** True once the first chunk has landed. NOT a promise that every card is loaded — callers
   *  must additionally check that the card they are about to show is in the cache. */
  ready: boolean;
  /** True while background chunks are still arriving. */
  loading: boolean;
  loaded: number;
  total: number;
  /** Set when a chunk failed; loading stops until `retry` is called. */
  error: boolean;
  retry: () => void;
}

/**
 * `wordIds` / `grammarIds` should be listed in the order the user will meet them (i.e. starting
 * at the current question) so the soonest cards load first. Only a change to the id SET
 * restarts loading — re-ordering the same ids is free, which is what keeps a mid-session
 * weight change or a retry insert off the network entirely.
 */
export function useQuizPrefetch(
  language: string,
  wordIds: string[],
  grammarIds: string[]
): QuizPrefetchResult {
  const [words, setWords] = useState<Map<string, QuizQuestion>>(new Map());
  const [grammar, setGrammar] = useState<Map<string, Grammar>>(new Map());
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  /** Consecutive failed passes, for the auto-resume backoff. Reset on a complete pass. */
  const failureCountRef = useRef(0);

  // Read inside the effect but deliberately NOT dependencies: the effect must re-run only when
  // the set of ids changes, while still fetching in the latest known order.
  const wordIdsRef = useRef(wordIds);
  const grammarIdsRef = useRef(grammarIds);
  wordIdsRef.current = wordIds;
  grammarIdsRef.current = grammarIds;
  // Mirrors of the caches, so a retry resumes where it stopped instead of re-downloading
  // everything that already arrived.
  const wordsRef = useRef(words);
  const grammarRef = useRef(grammar);
  wordsRef.current = words;
  grammarRef.current = grammar;

  // Order-independent identity of the work: re-ordering must not restart the loader.
  const wordKey = [...new Set(wordIds)].sort().join(",");
  const grammarKey = [...new Set(grammarIds)].sort().join(",");

  const retry = useCallback(() => {
    setError(false);
    setRetryToken((t) => t + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      // Snapshot the CURRENT order, de-duplicated, minus anything already cached.
      const pendingWords = [...new Set(wordIdsRef.current)].filter((id) => !wordsRef.current.has(id));
      const pendingGrammar = [...new Set(grammarIdsRef.current)].filter(
        (id) => !grammarRef.current.has(id)
      );

      setLoading(true);
      setError(false);

      let first = true;
      let wordCursor = 0;
      let grammarCursor = 0;

      // Interleave the two domains so a combined quiz whose first card is grammar isn't
      // stuck behind every word in the session.
      while (wordCursor < pendingWords.length || grammarCursor < pendingGrammar.length) {
        const wordSize = first ? FIRST_CHUNK : CHUNK;
        const grammarSize = first ? FIRST_CHUNK : GRAMMAR_CHUNK;
        const wordSlice = pendingWords.slice(wordCursor, wordCursor + wordSize);
        const grammarSlice = pendingGrammar.slice(grammarCursor, grammarCursor + grammarSize);

        try {
          const [wordResult, grammarResult] = await Promise.all([
            wordSlice.length > 0
              ? hydrateQuizQuestions(language, wordSlice)
              : Promise.resolve({ questions: [] as QuizQuestion[] }),
            grammarSlice.length > 0
              ? getGrammarItemsByIds(language, grammarSlice)
              : Promise.resolve({ items: [] as Grammar[] }),
          ]);
          if (cancelled) return;

          if (wordResult.questions.length > 0) {
            setWords((prev) => {
              const next = new Map(prev);
              for (const q of wordResult.questions) next.set(q.wordId, q);
              return next;
            });
          }
          if (grammarResult.items.length > 0) {
            setGrammar((prev) => {
              const next = new Map(prev);
              for (const item of grammarResult.items) next.set(item.id, item);
              return next;
            });
          }

          // Both endpoints omit ids they have no document for. Record them, or a card whose
          // word/grammar was deleted mid-session would look permanently "still loading".
          const returnedWords = new Set(wordResult.questions.map((q) => q.wordId));
          const returnedGrammar = new Set(grammarResult.items.map((i) => i.id));
          const absent = [
            ...wordSlice.filter((id) => !returnedWords.has(id)),
            ...grammarSlice.filter((id) => !returnedGrammar.has(id)),
          ];
          if (absent.length > 0) {
            setMissing((prev) => new Set([...prev, ...absent]));
          }
        } catch {
          if (cancelled) return;
          // Stop rather than hammering a dead connection. Whatever arrived stays usable, and
          // `retry` (or simply reaching a card that is already cached) picks up from here.
          setError(true);
          setLoading(false);
          return;
        }

        wordCursor += wordSlice.length;
        grammarCursor += grammarSlice.length;
        if (first) {
          first = false;
          setReady(true);
        }
      }

      if (cancelled) return;
      failureCountRef.current = 0;
      setReady(true);
      setLoading(false);
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [language, wordKey, grammarKey, retryToken]);

  /**
   * Auto-resume. A latched `error` used to sit there until the user noticed the amber chip and
   * tapped it, so a two-second blip left the rest of the session unloaded for that sitting.
   * Retry on reconnect, and on a widening timer for the flaky-but-not-offline case.
   */
  useEffect(() => {
    if (!error) return;
    failureCountRef.current += 1;
    const delay = Math.min(5_000 * 2 ** (failureCountRef.current - 1), 60_000);
    const timer = setTimeout(retry, delay);
    const onOnline = () => retry();
    window.addEventListener("online", onOnline);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [error, retry]);

  const uniqueWordIds = new Set(wordIds);
  const uniqueGrammarIds = new Set(grammarIds);
  const total = uniqueWordIds.size + uniqueGrammarIds.size;
  let loaded = 0;
  for (const id of uniqueWordIds) if (words.has(id) || missing.has(id)) loaded += 1;
  for (const id of uniqueGrammarIds) if (grammar.has(id) || missing.has(id)) loaded += 1;

  return { words, grammar, missing, ready, loading, loaded, total, error, retry };
}

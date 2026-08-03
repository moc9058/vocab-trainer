import { useEffect, useState } from "react";
import type { SearchIndexEntry } from "../types";
import { getWordSearchIndex } from "../api/vocab";
import { getGrammarSearchIndex } from "../api/grammar";

export type SearchIndexKind = "word" | "grammar";

/**
 * Module-level cache of the slim search-preview index, one entry per
 * `${kind}:${language}`. Shared by every consumer (list search boxes AND the
 * add-modal term fields), so the few-hundred-KB worst-case payload is fetched
 * once per session, not per component.
 *
 * Invalidation is stale-while-revalidate: `invalidateSearchIndex` keeps the old
 * entries on screen and refetches in the background — no flicker, and never a
 * fetch per keystroke. It must be called after ANY word/grammar CRUD; the
 * queue-driven adds are covered by the lists' `refreshSignal` effects, but
 * direct in-list edits/deletes only mutate local state, so those call sites
 * invalidate explicitly.
 */
interface CacheEntry {
  entries: SearchIndexEntry[] | null;
  promise: Promise<void> | null;
  stale: boolean;
}

const cache = new Map<string, CacheEntry>();
const subscribers = new Map<string, Set<() => void>>();

function keyOf(kind: SearchIndexKind, language: string): string {
  return `${kind}:${language}`;
}

function notify(key: string): void {
  subscribers.get(key)?.forEach((fn) => fn());
}

function fetchIndex(kind: SearchIndexKind, language: string): Promise<{ items: SearchIndexEntry[] }> {
  return kind === "word" ? getWordSearchIndex(language) : getGrammarSearchIndex(language);
}

function ensureFetched(kind: SearchIndexKind, language: string): void {
  const key = keyOf(kind, language);
  let entry = cache.get(key);
  if (!entry) {
    entry = { entries: null, promise: null, stale: false };
    cache.set(key, entry);
  }
  if (entry.promise || (entry.entries && !entry.stale)) return;
  entry.stale = false;
  const p = fetchIndex(kind, language)
    .then(({ items }) => {
      entry!.entries = items;
    })
    .catch(() => {
      // Keep whatever we had; mark stale so the next consumer retries.
      entry!.stale = true;
    })
    .finally(() => {
      entry!.promise = null;
      notify(key);
    });
  entry.promise = p;
}

/** Mark a language's index stale and refetch in the background (if anyone is
 *  subscribed). Old entries stay visible until the fresh ones land. */
export function invalidateSearchIndex(kind: SearchIndexKind, language: string): void {
  const key = keyOf(kind, language);
  const entry = cache.get(key);
  if (!entry) return; // never fetched — nothing to refresh
  entry.stale = true;
  if (subscribers.get(key)?.size) ensureFetched(kind, language);
}

export function useSearchIndex(
  kind: SearchIndexKind,
  language: string,
  enabled: boolean
): { entries: SearchIndexEntry[]; loading: boolean } {
  const key = keyOf(kind, language);
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let subs = subscribers.get(key);
    if (!subs) {
      subs = new Set();
      subscribers.set(key, subs);
    }
    const rerender = () => setVersion((v) => v + 1);
    subs.add(rerender);
    ensureFetched(kind, language);
    return () => {
      subs!.delete(rerender);
    };
  }, [key, kind, language, enabled]);

  const entry = cache.get(key);
  return {
    entries: entry?.entries ?? [],
    loading: enabled && !entry?.entries && !!entry?.promise,
  };
}

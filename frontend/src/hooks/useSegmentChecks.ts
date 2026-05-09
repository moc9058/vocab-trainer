import { useState, useEffect, useRef } from "react";
import { checkTerms, smartAddWord } from "../api/vocab";
import { getFlaggedWords, flagWord } from "../api/flagged";

export function useSegmentChecks(language: string, segmentTexts: string[]) {
  const [existingTerms, setExistingTerms] = useState<Map<string, string>>(new Map());
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const [checkingTerms, setCheckingTerms] = useState(false);
  const [busySegments, setBusySegments] = useState<Set<string>>(new Set());
  const [addError, setAddError] = useState<string | null>(null);
  const versionRef = useRef(0);

  useEffect(() => {
    setExistingTerms(new Map());
    setFlaggedIds(new Set());
    getFlaggedWords(language)
      .then(({ words }) => setFlaggedIds(new Set(words.map((w) => w.id))))
      .catch(() => {});
  }, [language]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (segmentTexts.length === 0) {
      setExistingTerms(new Map());
      setCheckingTerms(false);
      return;
    }
    setCheckingTerms(true);
    const v = ++versionRef.current;
    const timer = setTimeout(() => {
      checkTerms(language, segmentTexts)
        .then(({ existing }) => {
          if (v !== versionRef.current) return;
          setExistingTerms(new Map(Object.entries(existing)));
          setCheckingTerms(false);
        })
        .catch(() => {
          if (v !== versionRef.current) return;
          setCheckingTerms(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  // Serialize to string so the effect re-runs only when segment content changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, segmentTexts.join("|")]);

  async function addSegment(term: string, sentence: string, translation: string, withFlag: boolean) {
    if (existingTerms.has(term)) return;
    versionRef.current++;
    setBusySegments((prev) => new Set(prev).add(term));
    try {
      const cleanSentence = sentence.replace(/[\s　]+/g, "");
      const { generatedWords: _gw, ...word } = await smartAddWord(language, {
        term,
        examples: [{ sentence: cleanSentence, translation }],
        flag: withFlag,
      });
      setExistingTerms((prev) => new Map(prev).set(term, word.id));
      if (withFlag) setFlaggedIds((prev) => new Set(prev).add(word.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAddError(msg || "Failed to add segment");
      setTimeout(() => setAddError(null), 3000);
    } finally {
      setBusySegments((prev) => { const n = new Set(prev); n.delete(term); return n; });
    }
  }

  async function flagExistingSegment(term: string) {
    const wordId = existingTerms.get(term);
    if (!wordId || flaggedIds.has(wordId)) return;
    setBusySegments((prev) => new Set(prev).add(term));
    try {
      await flagWord(language, wordId);
      setFlaggedIds((prev) => new Set(prev).add(wordId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAddError(msg || "Failed to flag segment");
      setTimeout(() => setAddError(null), 3000);
    } finally {
      setBusySegments((prev) => { const n = new Set(prev); n.delete(term); return n; });
    }
  }

  return {
    existingTerms,
    flaggedIds,
    checkingTerms,
    busySegments,
    addSegment,
    flagExistingSegment,
    addError,
  };
}

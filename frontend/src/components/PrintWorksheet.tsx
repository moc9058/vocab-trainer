import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { LANG_LABEL_MAP } from "../settings/defaults";
import { sampleWords } from "../api/quiz";
import type { Word, Meaning } from "../types";

interface Props {
  language: string;
  filters: { topics: string[]; categories: string[]; levels: string[]; groupIds: string[]; flaggedOnly?: boolean };
  count: number | null;
  onBack: () => void;
}

function pickDefinitionText(meaning: Meaning, lang: string): string {
  const text = meaning.text ?? {};
  if (text[lang]) return text[lang];
  const firstKey = Object.keys(text)[0];
  return firstKey ? text[firstKey] : "";
}

function formatMeaning(meaning: Meaning, lang: string): string {
  const pos = meaning.partOfSpeech ? `(${meaning.partOfSpeech}) ` : "";
  return `${pos}${pickDefinitionText(meaning, lang)}`.trim();
}

function pinyinFor(word: Word, meaning: Meaning, isFirst: boolean): string | undefined {
  if (meaning.pinyins && meaning.pinyins.length > 0) return meaning.pinyins.join(" / ");
  if (isFirst) return word.transliteration;
  return undefined;
}

export default function PrintWorksheet({ language, filters, count, onBack }: Props) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const navigate = useNavigate();
  const [words, setWords] = useState<Word[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const printedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    sampleWords({
      language,
      ...(count == null ? {} : { questionCount: count }),
      topics: filters.topics,
      categories: filters.categories,
      levels: filters.levels,
      groupIds: filters.groupIds,
      ...(filters.flaggedOnly ? { flaggedOnly: true } : {}),
    })
      .then((res) => {
        if (cancelled) return;
        setWords(res.words);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err?.message ?? err));
      });
    return () => {
      cancelled = true;
    };
  }, [language, count, filters]);

  useEffect(() => {
    if (!words || words.length === 0 || printedRef.current) return;
    printedRef.current = true;
    const id = window.setTimeout(() => window.print(), 200);
    return () => window.clearTimeout(id);
  }, [words]);

  const printLang = settings.printDefinitionLanguage;
  const filterSummary = [
    filters.levels.length ? `${filters.levels.join(", ")}` : null,
    filters.topics.length ? filters.topics.join(", ") : null,
    filters.categories.length ? filters.categories.join(", ") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="worksheet-root min-h-screen bg-gray-100 text-gray-900">
      <style>{`
        @page { size: A4 portrait; margin: 18mm 16mm; }
        .worksheet-root { font-family: "Helvetica Neue", Helvetica, Arial, "Noto Sans CJK", "Noto Sans", sans-serif; }
        .worksheet { max-width: 178mm; margin: 0 auto; padding: 12mm 0; }
        .ws-header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #333; padding-bottom: 6px; margin-bottom: 12px; }
        .ws-title { font-size: 18px; font-weight: 700; }
        .ws-meta { font-size: 11px; color: #444; }
        .ws-subline { font-size: 11px; color: #444; margin-bottom: 14px; }
        .ws-rows { list-style: none; padding: 0; margin: 0; columns: 2; column-gap: 8mm; column-rule: 1px solid #ddd; }
        .ws-row { display: flex; align-items: baseline; gap: 6px; padding: 6px 0; border-bottom: 1px dotted #999; break-inside: avoid; -webkit-column-break-inside: avoid; page-break-inside: avoid; }
        .ws-num { width: 26px; text-align: right; color: #888; font-size: 10px; font-variant-numeric: tabular-nums; flex-shrink: 0; padding-right: 4px; border-right: 1px solid #ccc; margin-right: 6px; }
        .ws-term { font-size: 14px; font-weight: 600; min-width: 50px; flex-shrink: 0; }
        .ws-blank { flex: 1; min-width: 18mm; border-bottom: 1px solid #888; height: 16px; margin-left: 4px; }
        .ws-trans { font-size: 11px; color: #555; margin-left: 8px; }
        .ws-key { margin: 0; padding: 0; list-style: none; columns: 2; column-gap: 8mm; column-rule: 1px solid #ddd; }
        .ws-key li { padding: 5px 0; border-bottom: 1px dotted #bbb; break-inside: avoid; -webkit-column-break-inside: avoid; page-break-inside: avoid; font-size: 11.5px; }
        .ws-key .num { color: #444; font-variant-numeric: tabular-nums; margin-right: 8px; }
        .ws-key .term { font-weight: 600; margin-right: 8px; }
        .ws-key .pinyin { color: #555; margin-right: 8px; font-style: italic; }
        .ws-key .defs { color: #111; }
        .ws-key .defs span + span::before { content: "; "; color: #888; }
        .page-break { page-break-before: always; }
        .ws-controls { position: sticky; top: 0; z-index: 10; background: #f3f4f6; border-bottom: 1px solid #d1d5db; padding: 10px 16px; display: flex; gap: 8px; }
        .ws-controls button { padding: 6px 12px; border-radius: 6px; border: 1px solid #9ca3af; background: white; cursor: pointer; font-size: 13px; }
        .ws-controls button.primary { background: #2563eb; color: white; border-color: #2563eb; }
        .ws-controls .spacer { flex: 1; }
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; color: black !important; }
          .worksheet-root { background: white !important; }
          .worksheet { padding: 0; max-width: none; }
        }
      `}</style>

      <div className="ws-controls no-print">
        <button onClick={onBack}>{t("back")}</button>
        <div className="spacer" />
        <button className="primary" onClick={() => window.print()} disabled={!words || words.length === 0}>
          {t("printAgain")}
        </button>
      </div>

      <div className="worksheet">
        {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
        {!words && !error && <p>{t("generatingWorksheet")}</p>}
        {words && words.length === 0 && <p>{t("worksheetEmpty")}</p>}
        {words && words.length > 0 && (
          <>
            <div className="ws-header">
              <div className="ws-title">{LANG_LABEL_MAP[language] ?? language} — {t("printWorksheet")}</div>
              <div className="ws-meta">
                {t("worksheetName")}: ______________ &nbsp; {t("worksheetDate")}: ______________
              </div>
            </div>
            {filterSummary && (
              <div className="ws-subline">
                {t("worksheetFiltersLabel")}: {filterSummary} · {words.length} {t("words")}
              </div>
            )}
            <ol className="ws-rows">
              {words.map((w, i) => (
                <li key={w.id} className="ws-row">
                  <span className="ws-num">{i + 1}.</span>
                  <span className="ws-term">{w.term}</span>
                  <span className="ws-blank" />
                </li>
              ))}
            </ol>

            <div className="page-break" />
            <div className="ws-header">
              <div className="ws-title">{t("answerKey")}</div>
              <div className="ws-meta">{LANG_LABEL_MAP[printLang] ?? printLang}</div>
            </div>
            <ol className="ws-key">
              {words.map((w, i) => {
                const meanings = w.definitions ?? [];
                const firstPinyin = meanings.length > 0 ? pinyinFor(w, meanings[0], true) : w.transliteration;
                return (
                  <li key={w.id}>
                    <span className="num">{i + 1}.</span>
                    <span className="term">{w.term}</span>
                    {firstPinyin && <span className="pinyin">{firstPinyin}</span>}
                    <span className="defs">
                      {meanings.length === 0 ? (
                        <span style={{ color: "#999" }}>—</span>
                      ) : (
                        meanings.map((m, mi) => <span key={mi}>{formatMeaning(m, printLang)}</span>)
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>

      <div className="ws-controls no-print">
        <button onClick={() => navigate(-1)}>{t("back")}</button>
      </div>
    </div>
  );
}

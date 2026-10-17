import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/context";
import { generateImportSentenceExplanation } from "../../api/import";
import { fixedGrammarOccurrenceIds, readingConstructions, readingOccurrences, validReading } from "../../utils/importReadingAnalysis";
import type { ImportSession } from "../../types";
import RubyText from "../RubyText";

const BOUNDARIES_KEY = "importShowTextBoundaries";
const PINYIN_KEY = "importShowFullTextPinyin";
interface Props {
  session: ImportSession;
  onEditSentence?: (index: number) => void;
  onPatch?: (updater: (session: ImportSession) => ImportSession, immediate?: boolean) => void;
}

export default function ImportFullTextReader({ session, onEditSentence, onPatch }: Props) {
  const { t } = useI18n();
  const [showPinyin, setShowPinyin] = useState(() => localStorage.getItem(PINYIN_KEY) !== "0");
  const [showBoundaries, setShowBoundaries] = useState(() => localStorage.getItem(BOUNDARIES_KEY) !== "0");
  const [selected, setSelected] = useState<{ sentenceIndex: number; occurrenceId?: string; constructionId?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const requestRef = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const autoRequested = useRef(new Set<string>());
  useEffect(() => {
    requestController.current?.abort(); requestController.current = null;
    setSelected(null); setError(null); setBusy(false); requestRef.current++;
  }, [session.id]);
  useEffect(() => () => { requestRef.current++; requestController.current?.abort(); }, []);

  function close() {
    setSelected(null); setError(null);
    triggerRef.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (!selected) return;
    const previous = document.body.style.overflow;
    const mobile = window.matchMedia("(max-width: 1023px)").matches;
    if (mobile) document.body.style.overflow = "hidden";
    panelRef.current?.focus({ preventScroll: true });
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key !== "Tab" || !mobile) return;
      const controls = panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex="0"]');
      if (!controls?.length) { event.preventDefault(); return; }
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    window.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", keydown); };
  }, [!!selected]);

  const sentence = selected ? session.paragraphs.flatMap(p => p.sentences).find(s => s.index === selected.sentenceIndex) : undefined;
  const occurrences = sentence ? readingOccurrences(sentence, session.items) : [];
  const fixedGrammar = sentence ? fixedGrammarOccurrenceIds(sentence, session.items, occurrences) : new Set<string>();
  const word = occurrences.find(word => word.id === selected?.occurrenceId);
  const constructions = sentence ? readingConstructions(sentence, session.items) : [];
  const activeConstruction = constructions.find(point => point.id === selected?.constructionId);
  const reading = sentence ? validReading(sentence) : undefined;
  const gestureRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  function select(event: React.MouseEvent<HTMLElement>, next: NonNullable<typeof selected>) {
    event.stopPropagation();
    if (window.getSelection()?.toString().trim() || movedRef.current) return;
    triggerRef.current = event.currentTarget;
    setSelected(next); setError(null);
  }
  async function generate() {
    if (!sentence || busy || requestController.current || !onPatch) return;
    const controller = new AbortController(); requestController.current = controller;
    const request = ++requestRef.current;
    const sessionId = session.id;
    const source = sentence.text;
    const index = sentence.index;
    setBusy(true); setError(null);
    try {
      const result = await generateImportSentenceExplanation(session.language, sessionId, index, controller.signal);
      const current = sessionRef.current;
      if (request !== requestRef.current || current.id !== sessionId || result.sentenceIndex !== index || result.readingAnalysis.sourceText !== source || current.paragraphs.flatMap(p => p.sentences).find(s => s.index === index)?.text !== source) return;
      onPatch(s => s.id !== sessionId ? s : ({ ...s, paragraphs: s.paragraphs.map(p => ({ ...p, sentences: p.sentences.map(value =>
        value.index === index && value.text === source ? { ...value, readingAnalysis: result.readingAnalysis } : value) })) }), true);
      // New occurrence ids need not be the same as the previous analysis.
      setSelected(current => current?.sentenceIndex === index ? { sentenceIndex: index } : current);
    } catch (err) {
      if (request === requestRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally { if (request === requestRef.current) { setBusy(false); requestController.current = null; } }
  }

  // New compact imports load syntax on the first explicit sentence selection; old articles keep the manual button.
  useEffect(() => {
    if (!sentence || selected?.occurrenceId || !session.analysisProgress || reading || !onPatch || busy) return;
    const key = `${session.id}:${sentence.index}:${sentence.text}`;
    if (autoRequested.current.has(key)) return;
    autoRequested.current.add(key);
    void generate();
  }, [selected?.sentenceIndex, selected?.occurrenceId, session.id, reading, busy]);

  return <div className={`min-w-0 ${selected ? "lg:pr-[26rem]" : ""}`} data-testid="import-full-text-reader">
    <div className="mb-5 space-y-2 text-xs text-gray-400">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" aria-pressed={showBoundaries}
          onClick={() => setShowBoundaries(value => { localStorage.setItem(BOUNDARIES_KEY, value ? "0" : "1"); return !value; })}
          className="rounded-lg border border-gray-700 px-3 py-2 text-indigo-200">
          {t("importTextBoundaries")}: {showBoundaries ? t("importBoundariesOn") : t("importBoundariesOff")}
        </button>
        {showBoundaries && <>
          <span className="border-b border-indigo-400/70 px-1 pb-0.5">{t("importReaderWord")}</span>
          <span className="border-b-2 border-dotted border-emerald-400/80 px-1 pb-0.5">{t("importReaderGrammarElement")}</span>
        </>}
        <span>↗ {t("importSentenceExplanation")}</span>
      </div>
      <p>{t("importReaderBoundaryHint")}</p>
    </div>
    {session.language === "chinese" && <button type="button" aria-pressed={showPinyin}
      onClick={() => setShowPinyin(value => { localStorage.setItem(PINYIN_KEY, value ? "0" : "1"); return !value; })}
      className="mb-5 rounded-lg border border-gray-700 px-3 py-2 text-xs text-indigo-200">
      {showPinyin ? t("importHideFullTextPinyin") : t("importShowFullTextPinyin")}
    </button>}
    <article className="space-y-6 break-words text-[17px] leading-[2.3] text-gray-100 sm:text-lg"
      onPointerDown={event => { gestureRef.current = { x: event.clientX, y: event.clientY }; movedRef.current = false; }}
      onPointerMove={event => { if (gestureRef.current && Math.hypot(event.clientX - gestureRef.current.x, event.clientY - gestureRef.current.y) > 8) movedRef.current = true; }}
      onPointerUp={() => { gestureRef.current = null; }}>
      {session.paragraphs.map((paragraph, pIndex) => <p key={pIndex}>
        {paragraph.sentences.map((value, sentenceIndex) => {
          const tokens = readingOccurrences(value, session.items);
          const points = readingConstructions(value, session.items);
          const grammarIds = fixedGrammarOccurrenceIds(value, session.items, tokens);
          const highlight = value.index === selected?.sentenceIndex ? points.find(point => point.id === selected.constructionId) : undefined;
          const parts: React.ReactNode[] = [];
          let cursor = 0;
          for (const token of tokens) {
            if (token.range.start > cursor) parts.push(value.text.slice(cursor, token.range.start));
            const emphasized = highlight?.ranges.some(range => range.start < token.range.end && range.end > token.range.start);
            const isGrammar = grammarIds.has(token.id);
            parts.push(<button key={token.id} type="button" aria-label={token.surface}
              title={`${t(isGrammar ? "importReaderGrammarElement" : "importReaderWord")}: ${token.surface}`}
              data-reading-kind={isGrammar ? "grammar" : "word"}
              onClick={event => select(event, { sentenceIndex: value.index, occurrenceId: token.id })}
              className={`mx-px rounded px-0.5 text-left border-b-2 ${showBoundaries ? isGrammar ? "border-dotted border-emerald-400/80" : "border-solid border-indigo-400/40" : "border-transparent"} hover:bg-indigo-900/50 focus-visible:outline-2 focus-visible:outline-indigo-400 ${emphasized ? "bg-emerald-900/60 text-emerald-100" : selected?.sentenceIndex === value.index && selected.occurrenceId === token.id ? "bg-indigo-900/60" : ""}`}>
              <RubyText text={token.surface} segments={session.language === "chinese" && showPinyin && token.transliteration ? [{ text: token.surface, transliteration: token.transliteration }] : undefined} />
            </button>);
            cursor = token.range.end;
          }
          if (cursor < value.text.length) parts.push(value.text.slice(cursor));
          return <span key={value.index} tabIndex={-1} className={selected?.sentenceIndex === value.index ? "rounded bg-gray-800/40" : ""}
            onClick={event => select(event, { sentenceIndex: value.index })}>
            {sentenceIndex > 0 && " "}{parts}
            <button type="button" aria-label={`${t("importSentenceExplanation")} ${value.index + 1}`}
              onClick={event => select(event, { sentenceIndex: value.index })}
              className="mx-1 inline-flex min-h-8 items-center rounded px-1.5 align-middle text-xs text-gray-500 hover:bg-gray-800 hover:text-indigo-200">↗<span className="sr-only">{t("importSentenceExplanation")}</span></button>
            {points.length > 0 && <button type="button"
              onClick={event => select(event, { sentenceIndex: value.index, constructionId: points[0].id })}
              className="mx-1 inline-flex min-h-8 items-center rounded border border-emerald-900/80 px-2 align-middle text-xs text-emerald-300 hover:bg-emerald-950/50 focus-visible:outline-2 focus-visible:outline-emerald-400">
              {t("importReaderGrammar")} {points.length}
            </button>}
          </span>;
        })}
      </p>)}
    </article>
    {session.analysisProgress && session.analysisProgress.nextChunk < session.analysisProgress.chunks.length && <section className="mt-6 text-gray-400">
      <h4 className="mb-2 text-xs">{t("importPendingSource")}</h4>
      <p className="whitespace-pre-wrap break-words text-[17px] leading-relaxed">{session.analysisProgress.chunks.slice(session.analysisProgress.nextChunk).join("")}</p>
    </section>}

    {sentence && selected && <>
      <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={close} />
      <aside ref={panelRef} tabIndex={-1} role="dialog" aria-modal={window.matchMedia("(max-width: 1023px)").matches || undefined}
        aria-label={t("importSentenceExplanation")}
        className="fixed inset-x-0 bottom-0 z-50 max-h-[78dvh] overflow-y-auto overscroll-contain rounded-t-2xl border border-gray-700 bg-gray-900 p-4 shadow-2xl outline-none sm:p-6 lg:inset-x-auto lg:bottom-4 lg:right-4 lg:top-48 lg:max-h-none lg:w-[min(26rem,45vw)] lg:rounded-2xl">
        <header className="mb-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className={`mb-1 text-xs ${word && !fixedGrammar.has(word.id) ? "text-indigo-300" : "text-emerald-300"}`}>
              {word ? t(fixedGrammar.has(word.id) ? "importReaderGrammarElement" : "importReaderWord") : activeConstruction ? t("importReaderGrammar") : t("importSentenceExplanation")}
            </p>
            <h3 className="font-semibold text-indigo-200">{word?.surface ?? activeConstruction?.statement ?? t("importSentenceExplanation")}</h3>
          </div>
          <button type="button" onClick={close} aria-label={t("importCloseFullText")} className="rounded px-3 py-1 text-gray-400 hover:bg-gray-800">×</button>
        </header>
        <p className="mb-3 break-words text-base leading-relaxed text-gray-200">{sentence.text}</p>
        {sentence.translation && <p className="mb-4 text-sm text-indigo-200/80">{sentence.translation}</p>}
        {word && <div className="mb-4 space-y-2 rounded-xl bg-indigo-950/30 p-3 text-sm text-gray-200">
          {word.transliteration && <p className="font-mono text-indigo-300">{word.transliteration}</p>}
          <p><strong>{t("importContextMeaning")}: </strong>{word.contextualMeaning || t("importNoContextMeaning")}</p>
          {word.partOfSpeech && <p className="text-xs text-gray-400">{word.partOfSpeech}</p>}
          {word.role && <p><strong>{t("importElementRole")}: </strong>{word.role}</p>}
          {word.reasoning && <p><strong>{t("importInterpretationReason")}: </strong>{word.reasoning}</p>}
          {word.contrast && <p><strong>{t("importUsageContrast")}: </strong>{word.contrast}</p>}
          <button type="button" onClick={() => setSelected({ sentenceIndex: sentence.index })} className="text-indigo-300 underline">{t("importSentenceExplanation")}</button>
        </div>}
        {!word && reading?.overview && <p className="mb-4 whitespace-pre-wrap text-sm leading-relaxed text-gray-200">{reading.overview}</p>}
        {(word ? constructions.filter(point => word.constructionIds.includes(point.id)) : constructions).map(point => <section key={point.id} className="mb-3 rounded-xl border border-emerald-900/70 p-3 text-sm text-gray-200">
          <p className="mb-1 text-xs text-emerald-400/80">{t("importReaderGrammar")}</p>
          <button type="button" onClick={() => setSelected({ sentenceIndex: sentence.index, constructionId: point.id })} className="break-words text-left font-semibold text-emerald-300">{point.statement}</button>
          <p className="mt-1 whitespace-pre-wrap">{point.meaning}</p>
          {point.roleInSentence && <p className="mt-2 text-gray-400">{point.roleInSentence}</p>}
          {point.elements.map((element, index) => <p key={index} className="mt-2 border-l border-gray-700 pl-2">
            <span className="text-emerald-200">{reading?.occurrences.filter(value => element.occurrenceIds.includes(value.id)).map(value => value.surface).join(" + ")} · {element.role}</span>
            {session.language === "chinese" && <span className="block font-mono text-xs text-indigo-300">{reading?.occurrences.filter(value => element.occurrenceIds.includes(value.id)).map(value => value.transliteration).filter(Boolean).join(" + ")}</span>}
            <span className="block">{element.explanation}</span>
          </p>)}
        </section>)}
        {reading?.ambiguityNotes.map((note, index) => <p key={index} className="mb-2 text-sm text-amber-300">{note}</p>)}
        {!reading && <p className="mb-3 text-sm text-gray-400">{sentence.readingAnalysis ? t("importStaleExplanation") : t("importNoExplanation")}</p>}
        {error && <p role="alert" className="mb-3 break-words text-sm text-red-300">{error}</p>}
        <footer className="mt-4 flex flex-wrap gap-2 text-xs">
          {onPatch && <button type="button" onClick={() => void generate()} disabled={busy} className="rounded-lg border border-indigo-700 px-3 py-2 text-indigo-200 disabled:opacity-50">{busy ? t("importGeneratingExplanation") : reading ? t("importRegenerateExplanation") : t("importGenerateExplanation")}</button>}
          {onEditSentence && <button type="button" onClick={() => { close(); onEditSentence(sentence.index); }} className="rounded-lg border border-gray-700 px-3 py-2 text-gray-300">{t("importEditSentence")}</button>}
        </footer>
      </aside>
    </>}
  </div>;
}

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/context";
import { generateImportSentenceExplanation } from "../../api/import";
import { constructionParts, fixedGrammarOccurrenceIds, occurrenceConstructions, readingWordCandidate, reconcileReadingSession, readingConstructions, readingOccurrences, validReading } from "../../utils/importReadingAnalysis";
import type { ConstructionPart } from "../../utils/importReadingAnalysis";
import type { ImportItem, ImportSession } from "../../types";
import RubyText from "../RubyText";

const BOUNDARIES_KEY = "importShowTextBoundaries";
const SLOT_STYLES = [
  "bg-sky-950/70 text-sky-100 border-sky-400/70",
  "bg-amber-950/70 text-amber-100 border-amber-400/70",
  "bg-violet-950/70 text-violet-100 border-violet-400/70",
];
function partStyle(part: ConstructionPart) {
  return part.fixed ? "bg-emerald-900/60 text-emerald-100 border-emerald-400/80" : SLOT_STYLES[part.slotIndex % SLOT_STYLES.length];
}
const PINYIN_KEY = "importShowFullTextPinyin";
interface Props {
  session: ImportSession;
  renderRegistration?: (item: ImportItem) => React.ReactNode;
  onEditSentence?: (index: number) => void;
  onPatch?: (updater: (session: ImportSession) => ImportSession, immediate?: boolean) => void;
}

export default function ImportFullTextReader({ session, onEditSentence, onPatch, renderRegistration }: Props) {
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
  const relatedConstructions = word ? occurrenceConstructions(word, constructions) : constructions;
  const activeConstruction = relatedConstructions.find(point => point.id === selected?.constructionId)
    ?? (word ? relatedConstructions[0] : undefined);
  const grammarCandidate = (id: string, statement: string) => session.items.find(item => item.kind === "grammar" && item.sentenceIndex === sentence?.index && item.status !== "skipped"
    && (item.constructionId === id || item.statement.replace(/\s/gu, "") === statement.replace(/\s/gu, "")));
  const parts = sentence && activeConstruction ? constructionParts(sentence, activeConstruction, occurrences, fixedGrammar) : [];
  const partAt = (start: number, end: number) => parts.find(part => part.words.some(word => word.range.start < end && word.range.end > start)
    || (start >= part.words[0].range.start && end <= part.words[part.words.length - 1].range.end && !/\p{L}/u.test(sentence?.text.slice(start, end) ?? "")));
  function sentencePreview() {
    if (!sentence) return null;
    const cuts = [...new Set([0, sentence.text.length, ...occurrences.flatMap(token => [token.range.start, token.range.end]),
      ...(activeConstruction?.ranges.flatMap(range => [range.start, range.end]) ?? [])])]
      .filter(offset => offset >= 0 && offset <= sentence.text.length).sort((a, b) => a - b);
    const runs: { start: number; end: number; part?: ConstructionPart; nodes: React.ReactNode[] }[] = [];
    cuts.slice(0, -1).forEach((start, index) => {
      const end = cuts[index + 1];
      const part = partAt(start, end);
      const node = <span key={start} data-construction-part={part?.label} data-part-kind={part ? part.fixed ? "fixed" : "slot" : undefined}
        className={`${part ? `rounded border-b-2 ${part.fixed ? "border-dotted" : "border-solid"} ${partStyle(part)}` : ""} ${word && word.range.start <= start && word.range.end >= end ? "underline decoration-indigo-300 decoration-2 underline-offset-4" : ""}`}>{sentence.text.slice(start, end)}</span>;
      const previous = runs[runs.length - 1];
      if (previous && previous.part?.key === part?.key) { previous.nodes.push(node); previous.end = end; }
      else runs.push({ start, end, part, nodes: [node] });
    });
    return runs.map(run => {
      if (!run.part) return <span key={run.start} className="align-top">{run.nodes}</span>;
      const part = run.part;
      const label = part.fixed ? t("importFixedPartShort") : part.role && part.role !== part.label ? `${part.label} · ${part.role}` : part.label;
      return <span key={run.start} className="mr-1 inline-flex max-w-full flex-col items-center align-top" data-testid="import-labeled-part">
        <span className="min-w-0 break-words" data-testid="import-part-source">{run.nodes}</span>
        <span title={label} data-testid="import-part-label"
          className={`mt-1 max-w-48 break-words px-0.5 text-center text-[11px] leading-snug ${part.fixed ? "text-emerald-300" : part.slotIndex % 3 === 0 ? "text-sky-200" : part.slotIndex % 3 === 1 ? "text-amber-200" : "text-violet-200"}`}>{label}</span>
      </span>;
    });
  }
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
      onPatch(s => s.id !== sessionId ? s : reconcileReadingSession({ ...s, paragraphs: s.paragraphs.map(p => ({ ...p, sentences: p.sentences.map(value =>
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
          const active = value.index === selected?.sentenceIndex;
          const parts: React.ReactNode[] = [];
          let cursor = 0;
          for (const token of tokens) {
            if (token.range.start > cursor) parts.push(value.text.slice(cursor, token.range.start));
            const part = active ? partAt(token.range.start, token.range.end) : undefined;
            const isGrammar = grammarIds.has(token.id);
            parts.push(<button key={token.id} type="button" aria-label={token.surface}
              title={`${part ? `${part.label} · ` : ""}${t(isGrammar ? "importReaderGrammarElement" : "importReaderWord")}: ${token.surface}`}
              data-construction-part={part?.label} data-part-kind={part ? part.fixed ? "fixed" : "slot" : undefined}
              data-reading-kind={isGrammar ? "grammar" : "word"}
              onClick={event => select(event, { sentenceIndex: value.index, occurrenceId: token.id })}
              className={`mx-px rounded px-0.5 text-left border-b-2 ${part ? part.fixed ? "border-dotted" : "border-solid" : showBoundaries ? isGrammar ? "border-dotted border-emerald-400/80" : "border-solid border-indigo-400/40" : "border-transparent"} ${part ? "hover:brightness-125" : "hover:bg-indigo-900/50"} focus-visible:outline-2 focus-visible:outline-indigo-400 ${part ? partStyle(part) : selected?.sentenceIndex === value.index && selected.occurrenceId === token.id ? "bg-indigo-900/60" : ""}`}>
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
        {word && !fixedGrammar.has(word.id) && <div className="mb-3">{renderRegistration?.(readingWordCandidate(sentence, word, session.items))}</div>}
        {word && !fixedGrammar.has(word.id) && <div className="mb-4 space-y-2 rounded-xl bg-indigo-950/30 p-3 text-sm text-gray-200">
          {word.transliteration && <p className="font-mono text-indigo-300">{word.transliteration}</p>}
          <p><strong>{t("importContextMeaning")}: </strong>{word.contextualMeaning || t("importNoContextMeaning")}</p>
          {word.partOfSpeech && <p className="text-xs text-gray-400">{word.partOfSpeech}</p>}
          {word.role && <p><strong>{t("importElementRole")}: </strong>{word.role}</p>}
          {word.reasoning && <p><strong>{t("importInterpretationReason")}: </strong>{word.reasoning}</p>}
          {word.contrast && <p><strong>{t("importUsageContrast")}: </strong>{word.contrast}</p>}
          <button type="button" onClick={() => setSelected({ sentenceIndex: sentence.index })} className="text-indigo-300 underline">{t("importSentenceExplanation")}</button>
        </div>}
        {relatedConstructions.length > 0 && <div className="mb-3 text-xs">
          {relatedConstructions.length > 1 && <p className="mb-2 text-gray-400">{t("importLinkedConstruction")}</p>}
          <div className="flex flex-wrap gap-2">
            {relatedConstructions.map(point => <button key={point.id} type="button" aria-pressed={activeConstruction?.id === point.id}
              onClick={() => setSelected(current => current && ({ ...current, constructionId: point.id }))}
              className={`max-w-full break-words rounded-lg border px-3 py-2 text-left ${activeConstruction?.id === point.id ? "border-emerald-500 bg-emerald-950/60 text-emerald-200" : "border-gray-700 text-gray-300 hover:bg-gray-800"}`}>
              {point.statement}
            </button>)}
          </div>
        </div>}
        {activeConstruction && <section className="mb-4 rounded-xl border border-emerald-800/70 bg-emerald-950/20 p-3" data-testid="import-construction-summary">
          <h4 className="sr-only">{activeConstruction.statement}</h4>
          <p className="whitespace-pre-wrap text-base leading-relaxed text-gray-100">{activeConstruction.meaning}</p>
          {(() => { const item = grammarCandidate(activeConstruction.id, activeConstruction.statement);
            return item ? <div className="mt-3">{renderRegistration?.(item)}</div> : null; })()}
        </section>}
        <p data-testid="import-sentence-preview" className="mb-3 break-words text-base leading-loose text-gray-200">{sentencePreview()}</p>
        {sentence.translation && <p className="mb-4 text-sm text-indigo-200/80">{sentence.translation}</p>}
        {!word && reading?.overview && <p className="mb-4 whitespace-pre-wrap text-sm leading-relaxed text-gray-200">{reading.overview}</p>}
        {activeConstruction && <details key={`${sentence.index}-${activeConstruction.id}`} className="mb-3 rounded-xl border border-gray-700 text-sm text-gray-200">
          <summary className="cursor-pointer rounded-xl px-3 py-2 text-gray-300 focus-visible:outline-2 focus-visible:outline-emerald-400">{t("importConstructionDetails")}</summary>
          <div className="space-y-3 px-3 pb-3" data-testid="import-construction-parts">
            <p className="text-xs text-gray-400">{t("importLinkedConstructionHint")}</p>
            {activeConstruction.roleInSentence && <p className="text-sm text-gray-300">{activeConstruction.roleInSentence}</p>}
            {parts.map(part => <div key={part.key} className={`min-w-0 rounded-lg border px-2 py-2 ${partStyle(part)}`}>
              <span className="block break-words">{part.words.map(value => value.surface).join(" ")}</span>
              <span className="mt-1 block text-xs font-semibold">{part.label} · {t(part.fixed ? "importFixedPart" : "importVariablePart")}</span>
              {part.role && part.role !== part.label && <span className="block text-xs opacity-80">{part.role}</span>}
              {session.language === "chinese" && <span className="mt-1 block font-mono text-xs text-indigo-300">{part.words.map(value => value.transliteration).filter(Boolean).join(" + ")}</span>}
              {part.explanation && <p className="mt-1 text-sm">{part.explanation}</p>}
            </div>)}
            {!activeConstruction.elements.length && <p className="text-xs text-gray-400">{t("importMissingSlotAnalysis")}</p>}
          </div>
        </details>}
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

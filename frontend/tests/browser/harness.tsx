import CaptureWorkspace from '../../src/components/capture/CaptureWorkspace';
import ImportFullTextReader from '../../src/components/import/ImportFullTextReader';
import type { LocalCapture, NativeCapturePlugin } from '../../src/platform/capture';
import { BrowserRouter } from 'react-router-dom';
import ExpressionRecallQuizView from "../../src/components/ExpressionRecallQuizView";
import ExpressionRecallTaking from "../../src/components/ExpressionRecallTaking";
import type { CombinedQuizVariant } from "../../src/api/combined-quiz";
// Development-only entrypoint. The production Vite build includes only index.html.
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { I18nProvider } from '../../src/i18n/context';
import { SettingsProvider } from '../../src/settings/context';
import CombinedQuizTaking from '../../src/components/CombinedQuizTaking';
import QuizTaking from '../../src/components/QuizTaking';
import GrammarQuizTaking from '../../src/components/GrammarQuizTaking';
import { useImportSession } from '../../src/hooks/useImportSession';
import { useWordQueue } from '../../src/hooks/useWordQueue';
import { useGrammarQueue } from '../../src/hooks/useGrammarQueue';
import ImportView from '../../src/components/ImportView';
import ImportReview from '../../src/components/import/ImportReview';
import ImportFullTextModal from '../../src/components/import/ImportFullTextModal';
import type { ImportSession } from '../../src/types';
import '../../src/index.css';

function ImportHarness() {
  const words = useWordQueue();
  const grammar = useGrammarQueue();
  const review = useImportSession({ language: 'chinese', onQueue: words.enqueue, onGrammarQueue: grammar.enqueue, descriptionLanguage: 'en' });
  useEffect(() => { void review.load('article'); }, []);
  return <main>
    <button onClick={() => review.registerItem('row', 'A')}>Add A</button>
    <button onClick={() => review.registerItem('row', 'B')}>Add or Retry B</button>
    <button onClick={() => { void review.registerItem('row', 'B'); void review.registerItem('row', 'A'); }}>Add B and A together</button>
    <button onClick={() => review.patch(s => ({ ...s, groupBNames: ['Second article'] }))}>Change B destination</button>
    <pre data-testid="items">{JSON.stringify(review.session?.items ?? [])}</pre>
    <pre data-testid="results">{JSON.stringify(words.recentResults)}</pre>
  </main>;
}

function CaptureHarness() {
  const [selection, setSelection] = useState<unknown>(null);
  const sample: LocalCapture = { id: 'capture', inputKind: 'image', method: 'shared-image', receivedAt: new Date().toISOString(), acknowledged: false, operations: {},
    imageUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="600"><rect width="360" height="600" fill="#111827"/><text x="20" y="100" fill="white">虽然很忙，但我还是来了。</text><text x="20" y="300" fill="white">确实如此。</text></svg>'),
    blocks: [{ id: 'post', text: '虽然很忙，但我还是来了。', rects: [{ left: .05, top: .1, width: .8, height: .12 }], confidence: .95 }, { id: 'comment', text: '确实如此。', rects: [{ left: .05, top: .45, width: .6, height: .12 }], confidence: .6 }] };
  const store = useRef<Record<string, LocalCapture>>({ capture: sample, second: { ...sample, id: 'second', inputKind: 'text', method: 'shared-text', text: '臺灣的經濟與发展。', blocks: undefined, imageUrl: undefined, ...((window as any).captureFixture ?? {}) } });
  const [id, setId] = useState<string | undefined>((window as any).captureEmpty ? undefined : (window as any).captureText ? 'second' : 'capture');
  const [saved, setSaved] = useState<unknown>();
  const source = {
    load: async ({ id }: { id: string }) => structuredClone(store.current[id]),
    recognize: async ({ id }: { id: string }) => structuredClone(store.current[id]),
    acknowledge: async () => {}, acknowledgeLaunch: async () => {},
    receiveText: async ({ text }: { text: string }) => {
      (window as any).captureCreates = ((window as any).captureCreates ?? 0) + 1;
      if ((window as any).captureFailReceive) throw new Error('inbox full');
      const value: LocalCapture = { id: 'pasted', inputKind: 'text', method: 'paste', text, receivedAt: new Date().toISOString(), acknowledged: true, operations: {} };
      store.current.pasted = value; return value;
    },
    saveDraft: async ({ id, draft }: any) => { if ((window as any).captureFailSave) throw new Error('disk full'); store.current[id].draft = draft; setSaved({ id, draft }); },
    pickImage: async () => ({ cancelled: true }), discard: async () => {},
  } as unknown as NativeCapturePlugin;
  return <><button onClick={() => setId('second')}>Switch capture</button><button onClick={() => setId('capture')}>Original capture</button><CaptureWorkspace captureId={id} source={source} onConfirm={value => { setSelection(value); }} onResume={() => {}} onClose={() => {}} /><pre className="whitespace-pre-wrap break-all" data-testid="capture-selection">{JSON.stringify(selection)}</pre><pre className="whitespace-pre-wrap break-all" data-testid="capture-draft">{JSON.stringify(saved)}</pre></>;
}
function MeaningHarness() {
  const [value, setValue] = useState(fixture as ImportSession);
  return <><ImportFullTextReader session={value} onPatch={update => setValue(update)} renderRegistration={item => <button>{'Register ' + (item.kind === 'word' ? item.term : item.statement)}</button>} /><pre className="whitespace-pre-wrap break-all" data-testid="meaning-session">{JSON.stringify(value)}</pre></>;
}

function ImportViewHarness() {
  const words = useWordQueue(); const grammar = useGrammarQueue();
  return <ImportView language="chinese" onQueue={words.enqueue} onGrammarQueue={grammar.enqueue} />;
}
function CaptureImportHarness() {
  const words = useWordQueue(); const grammar = useGrammarQueue();
  const source = useMemo(() => {
    const capture: LocalCapture = { id: 'capture-import', inputKind: 'text', method: 'shared-text', text: '雖然很忙，但我还是来了。', receivedAt: new Date().toISOString(), acknowledged: false, operations: {} };
    (window as any).captureOperations = capture.operations;
    return {
      list: async () => ({ captures: [capture], launches: [] }), load: async () => structuredClone(capture),
      saveDraft: async ({ draft }: any) => { capture.draft = draft; }, acknowledge: async () => { capture.acknowledged = true; },
      recordOperation: async ({ blockId, request, sessionId }: any) => {
        const previous = capture.operations[blockId];
        if (previous && previous.request !== request) throw new Error('request changed');
        capture.operations[blockId] = { request, sessionId, createdAt: previous?.createdAt ?? new Date().toISOString() };
      },
      addListener: async () => ({ remove: async () => {} }),
    } as unknown as NativeCapturePlugin;
  }, []);
  return <ImportView language="chinese" onQueue={words.enqueue} onGrammarQueue={grammar.enqueue} captureSource={source} />;
}
function ImportReviewHarness() {
  const words = useWordQueue();
  const grammar = useGrammarQueue();
  const review = useImportSession({ language: 'chinese', onQueue: words.enqueue, onGrammarQueue: grammar.enqueue, descriptionLanguage: 'ja' });
  useEffect(() => { void review.load('article'); }, []);
  return review.session ? <ImportReview session={review.session} allWordGroups={[]} allGrammarGroups={[]}
    membershipOverlay={review.membershipOverlay} saveStatus={review.saveStatus} saveError={review.saveError}
    onCompareSaved={review.compareSaved} onResolveSaved={review.resolveSaved}
    onPrepareRevision={review.prepareAnalysis} onAcceptRevision={review.acceptAnalysisSession}
    onRetrySave={review.flush} onPatch={review.patch} onSetItems={review.setItems} onPatchItem={review.patchItem}
    onRegister={review.registerItem} onExit={() => {}} /> : <p>Loading</p>;
}
function ImportFullTextHarness() {
  const [open, setOpen] = useState(true);
  return open
    ? <ImportFullTextModal session={fixture as ImportSession} onClose={() => setOpen(false)} />
    : <span>closed</span>;
}
const mode = new URLSearchParams(location.search).get('mode');
const fixture = (window as any).fixture ?? (mode === 'import-full-text' ? {
  id: 'full-text', language: 'chinese', title: '你好', text: '你好。\n第二段。',
  paragraphs: [
    { sentences: [{ index: 0, text: '你好。' }] },
    { sentences: [{ index: 1, text: '第二段。' }] },
  ],
  items: [
    { id: 'w1', kind: 'word', sentenceIndex: 0, order: 0, term: '你', transliteration: 'nǐ', origin: 'llm', status: 'pending' },
    { id: 'w2', kind: 'word', sentenceIndex: 0, order: 1, term: '好', transliteration: 'hǎo', origin: 'llm', status: 'pending' },
  ],
  groupBNames: [], focusedSentenceIndex: 0, status: 'in-progress', createdAt: '', updatedAt: '',
} : undefined);
createRoot(document.getElementById('root')!).render(<BrowserRouter><I18nProvider><SettingsProvider>
  {mode === 'capture-import' ? <CaptureImportHarness /> : mode === 'capture' ? <CaptureHarness /> : mode === 'meaning' ? <MeaningHarness /> : mode === 'import-view' ? <ImportViewHarness />
    : mode === 'import-review' ? <ImportReviewHarness />
    : mode === 'import' ? <ImportHarness />
    : mode === 'import-full-text' ? <ImportFullTextHarness />
    : mode === 'word' ? <QuizTaking session={fixture} onComplete={() => {}} onBrowse={() => {}} onStartNew={() => {}} />
    : mode === 'grammar' ? <GrammarQuizTaking session={fixture} onComplete={() => {}} onStartNew={() => {}} />
    : mode === 'recall-view' ? <ExpressionRecallQuizView language="zh" onBack={() => {}} />
    : mode === 'recall' ? <ExpressionRecallTaking language="zh" session={fixture} onComplete={() => {}} onStartNew={() => {}} />
    : <CombinedQuizTaking session={fixture} variant={(new URLSearchParams(location.search).get('variant') ?? "mixed") as CombinedQuizVariant} onComplete={() => {}} onBrowse={() => {}} onStartNew={() => {}} />}
</SettingsProvider></I18nProvider></BrowserRouter>);

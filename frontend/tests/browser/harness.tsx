// Development-only entrypoint. The production Vite build includes only index.html.
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { I18nProvider } from '../../src/i18n/context';
import { SettingsProvider } from '../../src/settings/context';
import CombinedQuizTaking from '../../src/components/CombinedQuizTaking';
import QuizTaking from '../../src/components/QuizTaking';
import GrammarQuizTaking from '../../src/components/GrammarQuizTaking';
import { useImportSession } from '../../src/hooks/useImportSession';
import { useWordQueue } from '../../src/hooks/useWordQueue';
import { useGrammarQueue } from '../../src/hooks/useGrammarQueue';
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
createRoot(document.getElementById('root')!).render(<I18nProvider><SettingsProvider>
  {mode === 'import' ? <ImportHarness />
    : mode === 'import-full-text' ? <ImportFullTextHarness />
    : mode === 'word' ? <QuizTaking session={fixture} onComplete={() => {}} onBrowse={() => {}} onStartNew={() => {}} />
    : mode === 'grammar' ? <GrammarQuizTaking session={fixture} onComplete={() => {}} onStartNew={() => {}} />
    : <CombinedQuizTaking session={fixture} variant="mixed" onComplete={() => {}} onBrowse={() => {}} onStartNew={() => {}} />}
</SettingsProvider></I18nProvider>);

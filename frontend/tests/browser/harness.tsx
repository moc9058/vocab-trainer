// Development-only entrypoint. The production Vite build includes only index.html.
import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import { I18nProvider } from '../../src/i18n/context';
import { SettingsProvider } from '../../src/settings/context';
import CombinedQuizTaking from '../../src/components/CombinedQuizTaking';
import { useImportSession } from '../../src/hooks/useImportSession';
import { useWordQueue } from '../../src/hooks/useWordQueue';
import { useGrammarQueue } from '../../src/hooks/useGrammarQueue';
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
const fixture = (window as any).fixture;
createRoot(document.getElementById('root')!).render(<I18nProvider><SettingsProvider>
  {new URLSearchParams(location.search).get('mode') === 'import' ? <ImportHarness /> : <CombinedQuizTaking session={fixture} variant="mixed" onComplete={() => {}} onBrowse={() => {}} onStartNew={() => {}} />}
</SettingsProvider></I18nProvider>);

import './runtime';
import { bindPanel } from './runtime';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { SettingsProvider } from '../settings/context';
import { I18nProvider } from '../i18n/context';
import Panel from './Panel';
import '../index.css';
void bindPanel().then(() => createRoot(document.getElementById('root')!).render(
  <HashRouter><SettingsProvider><I18nProvider><Panel /></I18nProvider></SettingsProvider></HashRouter>
)).catch(() => { document.getElementById('root')!.textContent = window.browser.i18n.getMessage('safariBindError'); });

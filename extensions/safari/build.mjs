import { readFile, writeFile, copyFile, cp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await rm(new URL('dist', import.meta.url), { recursive: true, force: true });
execFileSync('npm', ['run', 'build:extension', '--prefix', '../../frontend'], { stdio: 'inherit', cwd: new URL('.', import.meta.url) });
const routes = JSON.parse(await readFile(new URL('../../backend/src/extension-routes.json', import.meta.url)));
for (const file of ['manifest.json', 'src/background.js', 'src/content.js', 'src/policy.js']) await copyFile(new URL(file, import.meta.url), new URL(`dist/${file.split('/').at(-1)}`, import.meta.url));
await cp(new URL('_locales', import.meta.url), new URL('dist/_locales', import.meta.url), { recursive: true });

await writeFile(new URL('dist/policy.js', import.meta.url), `const EXTENSION_ROUTES = ${JSON.stringify(routes)};\n` + await readFile(new URL('src/policy.js', import.meta.url), 'utf8'));

const translations = await readFile(new URL('../../frontend/src/i18n/translations.ts', import.meta.url), 'utf8');
for (const language of ['en', 'ja', 'ko']) {
  const messages = JSON.parse(await readFile(new URL(`_locales/${language}/messages.json`, import.meta.url), 'utf8'));
  const section = translations.split(`  ${language}: {`)[1].split(/\n  (?:en|ja|ko): \{/)[0];
  for (const key of ['safariAnalyze', 'safariTooLong', 'safariPanelOpen', 'safariTab', 'safariBindError']) {
    const match = section.match(new RegExp(`    ${key}: (".*"),`));
    if (!match) throw new Error(`Missing extension translation: ${key}/${language}`);
    messages[key] = { message: JSON.parse(match[1]) };
  }
  await writeFile(new URL(`dist/_locales/${language}/messages.json`, import.meta.url), JSON.stringify(messages, null, 2) + '\n');
}

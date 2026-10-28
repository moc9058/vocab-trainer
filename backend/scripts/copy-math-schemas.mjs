import { mkdir, copyFile } from 'node:fs/promises';
const target = new URL('../dist/schemas/', import.meta.url);
await mkdir(target, { recursive: true });
for (const name of ['math-chapter.schema.json','math-subject.schema.json'])
  await copyFile(new URL(`../../prompt/${name}`, import.meta.url), new URL(name,target));

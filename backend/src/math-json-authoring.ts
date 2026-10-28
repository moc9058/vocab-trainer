/** Local JSON review/accept workflow. The manifest and full subject graph are reviewed atomically. */
import { readFile, writeFile, mkdir, rename, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildJsonCatalog, compileJsonSubject, parseJsonChapter, parseJsonSubject, parseStrictJson, subjectReviewHash, JSON_COMPILER_VERSION, type JsonChapter, type JsonSubject } from "./math-json-content.js";
import { contentHash, invariant } from "./math-schema.js";
import { safePath } from "./math-content.js";
export interface JsonPackage { schemaVersion: 2; subject: JsonSubject; chapters: JsonChapter[]; unresolved: string[] }
export interface JsonRun { schemaVersion: 2; root: string; subjectPath: string; package: JsonPackage; baseHashes: Record<string,string|null>; reviewHash: string }
async function hashFile(root: string, file: string) { try { return contentHash(await readFile(await safePath(root,file),"utf8")); } catch(error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
const render = (value: unknown) => JSON.stringify(value,null,2)+"\n";
function parsePackage(input: unknown): JsonPackage {
  const pkg = input as JsonPackage;
  invariant(pkg && Object.keys(pkg).sort().join(",") === "chapters,schemaVersion,subject,unresolved" && pkg.schemaVersion === 2 && Array.isArray(pkg.chapters) && pkg.chapters.length > 0 && pkg.chapters.length <= 1000 && Array.isArray(pkg.unresolved) && pkg.unresolved.every(s => typeof s === "string"), "E_JSON_PACKAGE_SCHEMA");
  parseJsonSubject(pkg.subject); for(const chapter of pkg.chapters) parseJsonChapter(chapter);
  compileJsonSubject(pkg.subject,pkg.chapters,false); return pkg;
}
export async function importJsonAuthorPackage(input: unknown, root: string, runDirectory: string) {
  const pkg=parsePackage(input),baseHashes:Record<string,string|null>={};
  let prefix=pkg.subject.subjectId;
  try {
    const manifest = parseStrictJson(await readFile(await safePath(root, "catalog.json"), "utf8")) as any;
    for (const file of manifest.subjects ?? []) {
      const existing = parseJsonSubject(await readFile(await safePath(root, file), "utf8"));
      if (existing.subjectId === pkg.subject.subjectId) { prefix = dirname(file); break; }
    }
  } catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for(const file of ["catalog.json",`${prefix}/subject.json`,...pkg.subject.nodes.filter(n=>n.kind==="chapter").map(n=>`${prefix}/${n.contentFile}`)]) baseHashes[file]=await hashFile(root,file);
  const body={schemaVersion:2 as const,root:await safePath(root,"."),subjectPath:prefix,package:pkg,baseHashes};
  const run:JsonRun={...body,reviewHash:contentHash(body)};
  await mkdir(runDirectory,{recursive:true}); await writeFile(join(runDirectory,"run.json"),render(run),{flag:"wx"}); return run;
}
async function readRun(runDirectory:string) {
  const run=parseStrictJson(await readFile(join(runDirectory,"run.json"),"utf8")) as JsonRun;
  const {reviewHash,...body}=run;
  invariant(contentHash(body)===reviewHash,"E_REVIEW_HASH_MISMATCH"); parsePackage(run.package); return run;
}
export async function reviewJsonAuthorRun(runDirectory:string) {
  const run=await readRun(runDirectory);
  return {reviewHash:run.reviewHash,root:run.root,units:run.package.chapters.map(chapter=>({id:chapter.chapterId,title:chapter.title,content:chapter.content,source:chapter.source,change:run.baseHashes[`${run.subjectPath}/${run.package.subject.nodes.find(n=>n.id===chapter.chapterId)!.contentFile}`]?"modified":"new"})),unresolved:run.package.unresolved,coverage:[]};
}
export async function acceptJsonAuthorRun(runDirectory:string,chapterIds:string[],expectedHash:string,reviewedBy:string) {
  const run=await readRun(runDirectory),pkg=run.package;
  invariant(run.reviewHash===expectedHash,"E_REVIEW_HASH_MISMATCH",409);
  invariant(reviewedBy.trim() && chapterIds.length===pkg.chapters.length && new Set(chapterIds).size===chapterIds.length && chapterIds.every(id=>pkg.chapters.some(c=>c.chapterId===id)),"E_COMPLETE_JSON_SUBJECT_REQUIRED");
  invariant(!pkg.unresolved.length,"E_UNRESOLVED_PACKAGE");
  const subject: JsonSubject={...pkg.subject,review:{contentHash:subjectReviewHash(pkg.subject,pkg.chapters),compilerVersion:JSON_COMPILER_VERSION,reviewedBy,reviewedAt:new Date().toISOString()}};
  compileJsonSubject(subject,pkg.chapters);
  const manifestPath="catalog.json",prefix=run.subjectPath;
  const oldManifest=run.baseHashes[manifestPath]?parseStrictJson(await readFile(await safePath(run.root,manifestPath),"utf8")) as any:{schemaVersion:2,subjects:[]};
  invariant(oldManifest.schemaVersion===2 && Array.isArray(oldManifest.subjects),"E_CATALOG_SCHEMA");
  const subjectFile=`${prefix}/subject.json`;
  if(!oldManifest.subjects.includes(subjectFile)) oldManifest.subjects.push(subjectFile);
  const writes:Record<string,string>={[manifestPath]:render(oldManifest),[subjectFile]:render(subject)};
  for(const chapter of pkg.chapters) writes[`${prefix}/${subject.nodes.find(n=>n.id===chapter.chapterId)!.contentFile}`]=render(chapter);
  const journalFile=join(runDirectory,"accept-journal.json");
  let journal:{reviewHash:string,writes:Record<string,string>,state:string};
  try { journal=JSON.parse(await readFile(journalFile,"utf8")); invariant(journal.reviewHash===expectedHash,"E_ACCEPT_IN_PROGRESS",409); }
  catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; journal={reviewHash:expectedHash,writes,state:"prepared"}; await writeFile(journalFile,render(journal),{flag:"wx"}); }
  for(const [file,text] of Object.entries(journal.writes)) {
    const current=await hashFile(run.root,file); invariant(current===(run.baseHashes[file]??null)||current===contentHash(text),"E_AUTHORING_CONFLICT",409,{path:file});
  }
  // Validate the proposed complete catalog before touching the authoring original.
  const stage=join(runDirectory,"staged-root"); await mkdir(stage,{recursive:true});
  for(const file of oldManifest.subjects as string[]) {
    if(file===subjectFile) continue;
    const text=await readFile(await safePath(run.root,file),"utf8"),other=parseJsonSubject(text);
    await mkdir(dirname(join(stage,file)),{recursive:true}); await writeFile(join(stage,file),text);
    for(const node of other.nodes.filter(n=>n.kind==="chapter")) {
      const relativeFile=`${dirname(file)}/${node.contentFile}`;
      const content=await readFile(await safePath(run.root,relativeFile),"utf8");
      await mkdir(dirname(join(stage,relativeFile)),{recursive:true}); await writeFile(join(stage,relativeFile),content);
    }
  }
  for(const [file,text] of Object.entries(journal.writes)) { await mkdir(dirname(join(stage,file)),{recursive:true}); await writeFile(join(stage,file),text); }
  await buildJsonCatalog(stage);
  for(const [file,text] of Object.entries(journal.writes)) {
    const target=resolve(run.root,file); await mkdir(dirname(target),{recursive:true}); await safePath(run.root,dirname(file));
    if(await hashFile(run.root,file)===contentHash(text)) continue;
    // The read/compare is repeated immediately before each reversible atomic rename.
    invariant(await hashFile(run.root,file)===(run.baseHashes[file]??null),"E_AUTHORING_CONFLICT",409);
    await writeFile(`${target}.math-json-tmp`,text); await rename(`${target}.math-json-tmp`,target);
  }
  journal.state="completed"; await writeFile(journalFile,render(journal));
}

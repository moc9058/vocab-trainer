import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildJsonCatalog, compileJsonSubject, parseJsonChapter, parseJsonSubject, parseStrictJson, subjectReviewHash, JSON_COMPILER_VERSION, walkJsonContent, type JsonSubject, type JsonChapter } from "../../src/math-json-content.js";
import { compileCurriculumDependencies, dependencyClosure } from "../../src/math-curriculum-dependencies.js";
import { importJsonAuthorPackage, reviewJsonAuthorRun, acceptJsonAuthorRun } from "../../src/math-json-authoring.js";
import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { jsonAuthorPackageSchema } from "../../src/math-json-content.js";
import { importAuthorPackage, reviewAuthorRun, acceptAuthorRun } from "../../src/math-authoring.js";
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const example = () => readFile(join(repository,"prompt/math-chapter.example.json"),"utf8").then(parseJsonChapter);
const subjectFor = (chapter:JsonChapter):JsonSubject => ({schemaVersion:2,subjectId:chapter.subjectId,title:"Example",contentLanguage:"en",nodes:[{id:"example-root",kind:"subject",parentId:null,title:"Example",order:0},{id:chapter.chapterId,kind:"chapter",parentId:"example-root",title:chapter.title,contentFile:"chapter.json",order:1}],dependencies:{semantics:"requires-all",edges:[]},foundationRefs:[]});
function approve(subject:JsonSubject,chapters:JsonChapter[]) { subject.review={contentHash:subjectReviewHash(subject,chapters),compilerVersion:JSON_COMPILER_VERSION,reviewedBy:"test",reviewedAt:"2026-10-28"}; return subject; }
const hash = (s:string) => createHash("sha256").update(s).digest("hex");
test("v2 JSON schema accepts untitled items and recursive sections, rejects duplicate keys and unknown fields",async()=>{
  const chapter=await example();
  const packageValidator = new Ajv({strict:false}).compile(jsonAuthorPackageSchema);
  assert.ok(packageValidator({schemaVersion:2,subject:subjectFor(chapter),chapters:[chapter],unresolved:[]}), JSON.stringify(packageValidator.errors));
  const section=chapter.content[1] as any;
  section.content=[{type:"section",id:"nested",title:"Nested",content:section.content}];
  const compiled=compileJsonSubject(approve(subjectFor(chapter),[chapter]),[chapter]);
  assert.equal(compiled.concepts[0].title,"definition 1.1");
  assert.deepEqual(compiled.objectives.map(o=>o.difficultyRange),[[1,2],[1,2]]);
  assert.ok(compiled.objectives.every(o=>o.assessedCapabilities.every(r=>r.capability!=="prove")));
  assert.throws(()=>parseStrictJson('{"x":1,"\\u0078":2}'),/E_DUPLICATE_JSON_KEY/);
  assert.throws(()=>parseJsonChapter({...chapter,unknown:true}),/E_CHAPTER_SCHEMA/);
  assert.throws(()=>parseStrictJson("[".repeat(42)+"0"+"]".repeat(42)),/E_JSON_DEPTH/);
  const broken=structuredClone(chapter); (broken.content[0] as any).text="$\\notacommand{x}$";
  assert.throws(()=>parseJsonChapter(broken),/E_INVALID_LATEX/);
  (broken.content[0] as any).text="<script>alert(1)</script>";
  assert.throws(()=>parseJsonChapter(broken),/E_RAW_HTML/);
  assert.throws(()=>parseJsonChapter({...chapter,source:{...chapter.source,originalFile:"/private/input.pdf"}}),/E_UNSAFE_SOURCE_PATH/);
  assert.throws(()=>parseJsonSubject({...subjectFor(chapter),nodes:[...subjectFor(chapter).nodes.slice(0,1),{...subjectFor(chapter).nodes[1],contentFile:"../outside.json"}]}),/E_UNSAFE_PATH/);
});
test("chapter and Part dependencies expand independently and reject missing references and cycles",()=>{
  const nodes:any[]=[{id:"root",kind:"subject",parentId:null,title:"R",order:0},{id:"p",kind:"part",parentId:"root",title:"P",order:1},...["a","b"].map((id,i)=>({id,kind:"chapter",parentId:"p",title:id,order:i})),...["c","d"].map((id,i)=>({id,kind:"chapter",parentId:"root",title:id,order:i+2}))];
  const graph=compileCurriculumDependencies(nodes,[{nodeId:"c",requires:["p"]},{nodeId:"d",requires:["c"]}]);
  assert.deepEqual(dependencyClosure(graph.chapterDependencies,"d"),["a","b","c"]);
  assert.deepEqual(dependencyClosure(graph.chapterDependencies,"a"),[]);
  assert.throws(()=>compileCurriculumDependencies(nodes,[{nodeId:"p",requires:["a"]}]),/E_CURRICULUM_SELF_DEPENDENCY/);
  assert.throws(()=>compileCurriculumDependencies(nodes,[{nodeId:"c",requires:["d"]},{nodeId:"d",requires:["c"]}]),/E_CURRICULUM_DEPENDENCY_CYCLE/);
  assert.throws(()=>compileCurriculumDependencies(nodes,[{nodeId:"c",requires:["missing"]}]),/E_UNKNOWN_DEPENDENCY_NODE/);
});
test("cross-chapter item dependencies require the declared chapter closure; proof targets and receipts are checked",async()=>{
  const a=await example(),b=structuredClone(a); b.chapterId="second-chapter";
  walkJsonContent(b.content,n=>{n.id="second-"+n.id;});
  const bItem=(b.content[1] as any).content[0]; bItem.learning.requires=[{itemId:"example-subspace",capability:"apply"}];
  const s=subjectFor(a); s.nodes.push({id:b.chapterId,kind:"chapter",parentId:"example-root",title:"Second",order:2,contentFile:"second.json"});
  assert.throws(()=>compileJsonSubject(s,[a,b],false),/E_CROSS_CHAPTER_DEPENDENCY/);
  s.dependencies.edges=[{nodeId:b.chapterId,requires:[a.chapterId]}];
  assert.equal(compileJsonSubject(approve(s,[a,b]),[a,b]).concepts.length,2);
  (a.content[0] as any).text+=" modified";
  assert.throws(()=>compileJsonSubject(s,[a,b]),/E_JSON_REVIEW_REQUIRED/);
  const proof=await example(); (proof.content[1] as any).content.push({type:"item",id:"unknown-proof",kind:"proof",provesItemId:"missing",content:[]});
  assert.throws(()=>parseJsonChapter(proof),/E_UNKNOWN_PROOF_TARGET/);
});
test("allowlist ignores unregistered folders, rejects symlinks and canonical path collisions",async()=>{
  const root=await mkdtemp(join(tmpdir(),"math-json-"));
  try { const c=await example(),s=approve(subjectFor(c),[c]);
    await mkdir(join(root,"ok")); await mkdir(join(root,"unlisted"));
    await writeFile(join(root,"unlisted","bad.json"),"invalid unregistered content");
    await writeFile(join(root,"catalog.json"),JSON.stringify({schemaVersion:2,subjects:["ok/subject.json"]}));
    await writeFile(join(root,"ok","subject.json"),JSON.stringify(s)); await writeFile(join(root,"ok","chapter.json"),JSON.stringify(c));
    assert.equal((await buildJsonCatalog(root)).catalog.concepts.length,1);
    await rm(join(root,"ok","chapter.json")); await symlink(join(repository,"prompt/math-chapter.example.json"),join(root,"ok","chapter.json"));
    await assert.rejects(buildJsonCatalog(root),/E_SYMLINK/);
    await writeFile(join(root,"catalog.json"),'{"schemaVersion":2,"subjects":["ok/subject.json","ok/subject.json"]}');
    await assert.rejects(buildJsonCatalog(root),/E_SYMLINK|E_PATH_COLLISION/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test("all nine chapter JSONs compile, preserve the original bytes through the reverse map, and declare eight edges",async()=>{
  const built=await buildJsonCatalog(join(repository,"textbook"));
  assert.equal(built.catalog.subjects.length,1); assert.equal(Object.keys(built.sources).length,9);
  const s=JSON.parse(await readFile(join(repository,"textbook/Linear Algebra/subject.json"),"utf8"));
  assert.equal(s.dependencies.edges.length,8);
  assert.deepEqual(dependencyClosure((built.catalog as any).chapterDependencies,"la-ch05"),["la-ch01","la-ch02","la-ch03","la-ch04"]);
  for(const file of s.nodes.filter((n:any)=>n.kind==="chapter").map((n:any)=>n.contentFile)) {
    const c=parseJsonChapter(await readFile(join(repository,"textbook/Linear Algebra",file),"utf8"));
    const report=JSON.parse(await readFile(join(repository,"docs/math-v2-conversion",`${c.chapterId}.json`),"utf8"));
    const blocks=new Map<string,string>(),nodes=new Map<string,any>(); walkJsonContent(c.content,n=>{nodes.set(n.id,n);if(n.type==="block") blocks.set(n.id,n.text);});
    for (const mapping of report.mappings.filter((m:any)=>m.type==="heading" && m.id!==c.chapterId)) {
      const node=nodes.get(mapping.id);
      const clean=mapping.original.replace(/^#+\s+/,"").replace(/^(?:\*\*)?(\d+(?:\.\d+)*)(?:\*\*)?\.\s*/,"").replace(/<\/?(?:span\b[^>]*|u|details|summary)>/gi,"");
      if(node.type==="section") assert.equal(node.title,clean);
      else {
        const named=clean.match(/^\(([^()$=]+)\)\s*/);
        const expected=named && node.title===named[1].trim()?clean.slice(named[0].length):clean;
        assert.equal(blocks.get(`${node.id}-heading`)??"",expected);
        if(node.title && !named) assert.equal(node.title,clean);
      }
    }
    const restored=report.mappings.map((m:any)=>{if(m.type==="heading")return m.original;let text=blocks.get(m.blockId)!; const tokens=report.decorations.find((d:any)=>d.blockId===m.blockId)?.tokens??[];for(const t of [...tokens].reverse()) text=text.slice(0,t.offset)+t.html+text.slice(t.offset);assert.equal(hash(text),m.sha256);return text;}).join("");
    assert.equal(hash(restored),c.source.originalSha256); assert.equal(hash(restored),report.roundTripSha256);
  }
});
test("JSON package review/accept is hash-bound, detects edits, and replays without changing source hashes",async()=>{
  const root=await mkdtemp(join(tmpdir(),"math-json-author-")),run=await mkdtemp(join(tmpdir(),"math-json-run-"));
  try {const c=await example(),s=subjectFor(c); const imported=await importAuthorPackage({schemaVersion:2,subject:s,chapters:[c],unresolved:[]},root,run);
    assert.equal((await reviewAuthorRun(run)).units[0].id,c.chapterId);
    await assert.rejects(acceptJsonAuthorRun(run,[c.chapterId],"wrong","test"),/E_REVIEW_HASH_MISMATCH/);
    await acceptAuthorRun(run,[c.chapterId],imported.reviewHash,"test");
    const first=await buildJsonCatalog(root);
    await acceptAuthorRun(run,[c.chapterId],imported.reviewHash,"test");
    assert.equal((await buildJsonCatalog(root)).catalog.id,first.catalog.id);
  } finally {await rm(root,{recursive:true,force:true});await rm(run,{recursive:true,force:true});}
});

test("JSON acceptance detects a changed authoring original before any overwrite",async()=>{
  const root=await mkdtemp(join(tmpdir(),"math-json-conflict-")),run=await mkdtemp(join(tmpdir(),"math-json-conflict-run-"));
  try {const c=await example(),s=subjectFor(c),pkg={schemaVersion:2,subject:s,chapters:[c],unresolved:[]};
    const imported=await importAuthorPackage(pkg,root,run);
    await mkdir(join(root,s.subjectId),{recursive:true});
    const file=join(root,s.subjectId,"chapter.json"); await writeFile(file,JSON.stringify(c)+"\n");
    await assert.rejects(acceptAuthorRun(run,[c.chapterId],imported.reviewHash,"test"),/E_AUTHORING_CONFLICT/);
    assert.equal(await readFile(file,"utf8"),JSON.stringify(c)+"\n");
  } finally {await rm(root,{recursive:true,force:true});await rm(run,{recursive:true,force:true});}
});

test("only explicitly declared capability/revision foundations can cross subject boundaries",async()=>{
  const a=await example(),b=structuredClone(a); b.subjectId="foundation-algebra"; b.chapterId="foundation-chapter";
  walkJsonContent(b.content,n=>{n.id="foundation-"+n.id;});
  const sb=subjectFor(b); sb.nodes[0].id="foundation-root"; sb.nodes[1].parentId="foundation-root";
  const compiledB=compileJsonSubject(approve(sb,[b]),[b]);
  const sa=subjectFor(a),item=(a.content[1] as any).content[0];
  item.learning.requires=[{itemId:compiledB.concepts[0].id,capability:"apply"}];
  assert.throws(()=>compileJsonSubject(sa,[a],false),/E_CROSS_CHAPTER_DEPENDENCY/);
  sa.foundationRefs=[{subjectId:b.subjectId,conceptId:compiledB.concepts[0].id,capability:"apply",revisionId:compiledB.concepts[0].revisionId}];
  assert.equal(compileJsonSubject(approve(sa,[a]),[a]).concepts.length,1);
  item.learning.requires[0].capability="recognize";
  assert.throws(()=>compileJsonSubject(sa,[a],false),/E_CROSS_CHAPTER_DEPENDENCY/);
  item.learning.requires[0].capability="apply";
  sa.foundationRefs[0].subjectId=sa.subjectId;
  assert.throws(()=>compileJsonSubject(sa,[a],false),/E_FOUNDATION_SUBJECT/);
});

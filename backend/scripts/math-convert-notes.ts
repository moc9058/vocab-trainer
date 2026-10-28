/** One-time, read-only Markdown migration adapter. Never used by production deploy. */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, basename } from "node:path";
import { markdownAst } from "../src/math-content.js";
import { parseJsonChapter, subjectReviewHash, JSON_COMPILER_VERSION, type JsonContent, type JsonChapter, type JsonSubject, type JsonItem } from "../src/math-json-content.js";
import { invariant } from "../src/math-schema.js";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const root = resolve(process.argv[2] ?? "../textbook/Linear Algebra");
const reportRoot = resolve(root, "../../docs/math-v2-conversion");
await mkdir(reportRoot, { recursive: true });
const filenames = (await readdir(root)).filter(f => /^\d+\..*\.md$/.test(f)).sort((a,b) => parseInt(a)-parseInt(b));
invariant(filenames.length === 9, "E_EXPECTED_NINE_ORIGINALS");
const chapters: JsonChapter[] = [];
const summaries = [];
for (const filename of filenames) {
  const raw = await readFile(resolve(root, filename), "utf8"), tree = markdownAst(raw);
  const headings = tree.children.filter((n: any) => n.type === "heading") as any[];
  const n = parseInt(filename), prefix = `la-ch${String(n).padStart(2,"0")}`;
  const chapter: JsonChapter = { schemaVersion: 2, subjectId: "linear-algebra", chapterId: prefix, title: filename.replace(/^\d+\. /, "").replace(/\.md$/, ""), source: { kind: "local-notes", originalFile: filename, originalSha256: sha(raw), urls: [...raw.matchAll(/https:\/\/[^\s<>]+/g)].map(m => m[0]), originalHeadings: headings.map(h => raw.slice(h.position.start.offset,h.position.end.offset)) }, content: [] };
  const mappings: any[] = [], decorations: any[] = [];
  const stack: {depth:number, node: JsonContent}[] = [];
  const blockById = new Map<string,string>();
  let serial = 0;
  function stripHtml(text: string, id: string) {
    const tokens: {offset:number,html:string}[] = [];
    let removed = 0;
    const clean = text.replace(/<\/?(?:span\b[^>]*|u|details|summary)>/gi, (html: string, offset: number) => { tokens.push({offset:offset-removed,html}); removed += html.length; return ""; });
    if(tokens.length) decorations.push({blockId:id,tokens,annotation:"Source color/underline emphasis retained in conversion metadata; textual content and existing Markdown emphasis are preserved."});
    return clean;
  }
  function body(text: string, owner: JsonContent[], start: number, end:number) {
    if (!text) return;
    const id = `${prefix}-block-${String(++serial).padStart(4,"0")}`;
    const clean = stripHtml(text,id); owner.push({type:"block",id,format:"markdown",text:clean}); blockById.set(id,clean);
    mappings.push({type:"body",blockId:id,sourceStart:start,sourceEnd:end,sha256:sha(text)});
  }
  if (headings[0].position.start.offset > 0) body(raw.slice(0,headings[0].position.start.offset),chapter.content,0,headings[0].position.start.offset);
  for(let i=0;i<headings.length;i++) {
    const h = headings[i], start=h.position.start.offset, end=h.position.end.offset, rawHeading=raw.slice(start,end);
    const tailEnd=headings[i+1]?.position.start.offset??raw.length;
    if(h.depth===1) {
      mappings.push({type:"heading",id:chapter.chapterId,sourceStart:start,sourceEnd:end,original:rawHeading,action:"moved-to-chapter-title"});
      body(raw.slice(end,tailEnd),chapter.content,end,tailEnd); continue;
    }
    while(stack.length && stack.at(-1)!.depth>=h.depth) stack.pop();
    const parent = stack.at(-1)?.node;
    const owner = parent && parent.type!=="block" ? parent.content : chapter.content;
    const headingContent=rawHeading.replace(/^#+\s+/,"");
    const labelMatch=headingContent.match(/^(?:\*\*)?(\d+(?:\.\d+)*)(?:\*\*)?\.\s*/);
    if (!labelMatch) {
      // Properties and other unnumbered subheadings stay as Markdown in their owning item.
      body(raw.slice(start,tailEnd),owner,start,tailEnd); continue;
    }
    const label=labelMatch[1], text=headingContent.slice(labelMatch[0].length);
    const hasNumberedChildren=headings.slice(i+1).some((next:any,j:number) => next.depth>h.depth && /^#+\s+(?:\*\*)?\d/.test(raw.slice(next.position.start.offset,next.position.end.offset)) && !headings.slice(i+1,i+1+j).some((between:any)=>between.depth<=h.depth));
    const section=h.depth===2 || hasNumberedChildren;
    const id=`${prefix}-${section?"section":"item"}-${label.replace(/\./g,"-")}`;
    const clean=stripHtml(text,id);
    let node: JsonContent;
    if(section) node={type:"section",id,title:clean,label,content:[]};
    else {
      const category=chapter.content.filter(c=>c.type==="section").at(-1);
      const kind=category?.type==="section" && /Definitions/i.test(category.title)?"definition":category?.type==="section"&&/Examples/i.test(category.title)?"example":"theorem";
      const item:JsonItem={type:"item",id,kind,label,content:[]};
      const named=clean.match(/^\(([^()$=]+)\)\s*/);
      // Only a leading nominal parenthetical is a name. Mathematical assumptions remain body text.
      if(named && !/\b(?:is|are|has|if|let|suppose|for|when)\b/i.test(named[1])) item.title=named[1].trim();
      else if(kind==="definition" && !/[.$=]|\b(?:Suppose|Let|A number|A map|If|An operator|Two vectors)\b/.test(clean) && clean.length<100) item.title=clean;
      let statement=clean;
      if(named && item.title) statement=clean.slice(named[0].length);
      if(statement) {
        const blockId=`${id}-heading`;
        item.content.push({type:"block",id:blockId,format:"markdown",text:statement}); blockById.set(blockId,statement);
      }
      // Conservative defaults assess use/recognition only; proof text is never promoted to permission.
      item.learning={capabilities:["recognize","apply"],requires:[],proofCoverage:"none"};
      node=item;
    }
    owner.push(node); stack.push({depth:h.depth,node});
    mappings.push({type:"heading",id,sourceStart:start,sourceEnd:end,original:rawHeading,action:section?"moved-to-section-title": "moved-to-item-title-and-statement"});
    body(raw.slice(end,tailEnd),node.content,end,tailEnd);
  }
  parseJsonChapter(chapter);
  // Exact round trip: only decorated HTML is restored; headings come from the explicit reverse map.
  const restored=mappings.map(m=> {
    if(m.type==="heading") return m.original;
    let text=blockById.get(m.blockId)!;
    const dec=decorations.find(d=>d.blockId===m.blockId);
    for(const token of [...(dec?.tokens??[])].reverse()) text=text.slice(0,token.offset)+token.html+text.slice(token.offset);
    invariant(sha(text)===m.sha256,"E_CONVERSION_FRAGMENT_MISMATCH"); return text;
  }).join("");
  invariant(restored===raw,"E_CONVERSION_ROUNDTRIP_MISMATCH");
  const math=(text:string)=>{ const out:string[]=[]; const visit=(node:any)=>{if(node.type==="math"||node.type==="inlineMath")out.push(node.value);for(const child of node.children??[])visit(child);};visit(markdownAst(text));return out;};
  invariant(JSON.stringify(math(raw))===JSON.stringify(math(restored)),"E_CONVERSION_MATH_MISMATCH");
  const summary={chapterId:prefix,originalFile:filename,originalSha256:sha(raw),roundTripSha256:sha(restored),exactRoundTrip:true,mathCount:math(raw).length,mathTokenSha256:sha(JSON.stringify(math(raw))),headings:headings.length,items:mappings.filter(m=>m.action==="moved-to-item-title-and-statement").length,decorationCount:decorations.reduce((a,d)=>a+d.tokens.length,0)};
  await writeFile(resolve(root,filename.replace(/\.md$/,".json")),JSON.stringify(chapter,null,2)+"\n");
  await writeFile(resolve(reportRoot,`${prefix}.json`),JSON.stringify({...summary,mappings,decorations,learningReview:"recognize/apply only; difficulty [1,2]; no inferred proof permission or high difficulty; shared chapter assumptions preserved in each compiled unit",suspicions:[]},null,2)+"\n");
  summaries.push(summary); chapters.push(chapter);
}
const subject:JsonSubject={schemaVersion:2,subjectId:"linear-algebra",title:"Linear Algebra",contentLanguage:"en",nodes:[{id:"la",kind:"subject",parentId:null,order:0,title:"Linear Algebra"},...chapters.map((c,i)=>({id:c.chapterId,kind:"chapter" as const,parentId:"la",order:i+1,title:c.title,contentFile:filenames[i].replace(/\.md$/,".json")}))],dependencies:{semantics:"requires-all",edges:chapters.slice(1).map((c,i)=>({nodeId:c.chapterId,requires:[chapters[i].chapterId]}))},foundationRefs:[]};
subject.review={contentHash:subjectReviewHash(subject,chapters),compilerVersion:JSON_COMPILER_VERSION,reviewedBy:"math-v2-conservative-conversion",reviewedAt:"2026-10-28"};
await writeFile(resolve(root,"subject.json"),JSON.stringify(subject,null,2)+"\n");
await writeFile(resolve(root,"../catalog.json"),JSON.stringify({schemaVersion:2,subjects:["Linear Algebra/subject.json"]},null,2)+"\n");
await writeFile(resolve(reportRoot,"summary.json"),JSON.stringify({schemaVersion:2,compilerVersion:JSON_COMPILER_VERSION,chapters:summaries,reviewHash:subject.review.contentHash,mathematicalCorrectnessReview:"Not claimed. Conversion preserves the supplied notes exactly under reversible decoration/title moves; objectives are conservative deterministic defaults."},null,2)+"\n");
console.log(JSON.stringify(summaries,null,2));

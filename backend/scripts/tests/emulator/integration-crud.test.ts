import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('An explicit emulator is required');
process.env.FIRESTORE_PROJECT = `integration-crud-${Date.now()}`;
process.env.FIRESTORE_DATABASE_ID = 'vocab-database';
const llm = await import('../../../src/llm.js');
mock.module('../../../src/llm.js',{ namedExports:{ ...llm, callLLM:async (input: {route:string}) => input.route.startsWith('grammar/')
  ? JSON.stringify({ descriptions:[{ partOfSpeech:'',text:{ ko:'생성 설명',ja:'生成説明' } }] })
  : JSON.stringify({ transliteration:'hòuhuǐ',definitions:[{text:{ko:'후회하다',ja:'後悔する',en:'regret'}}],examples:[],topics:['Education'],level:'HSK4' }),
  fillGrammarTransliteration:async () => new Map([[0,'ba+O+V']]), fillSegmentPinyin:async () => new Map() } });
mock.module('../../../src/hanja.js',{ namedExports:{ generateHanjaReadings:async () => [] } });
const authModule = await import('../../../src/auth-config.js');
const authConfig = { clientId:'test',clientSecret:'test',sessionSecret:'integration-cookie-test-secret',redirectUris:['https://library.test/api/auth/callback'],allowedEmails:['owner@test'] };
mock.module('../../../src/auth-config.js',{ namedExports:{ ...authModule,getAuthConfig:() => authConfig,isEmailAllowed:(email: string) => email === 'owner@test' } });
process.env.INTEGRATIONS_ENABLED = 'true';
const { db } = await import('../../../src/firestore.js');
const { LibraryOAuth, oauthScopes, digest, secret } = await import('../../../src/integrations/oauth.js');
const { LibraryIntegrationService } = await import('../../../src/integrations/service.js');
const { runIntegrationOperation } = await import('../../../src/integrations/tasks.js');
const { wordIndexDocId } = await import('../../../src/word-index-id.js');
const logger = Fastify().log;

test('OAuth PKCE and full word/grammar CRUD preserve membership, translations and shared examples',async () => {
  try {
    await db.doc('config/vocabulary').set({smartAddSchema:{},smartAddPrompts:{default:'Generate word definitions'},segmentPrompt:'',segmentSchema:{}});
    await db.doc('config/grammar').set({smartAddSchema:{},smartAddPrompts:{default:'Complete grammar descriptions'}});
    await db.doc('languages/chinese').set({ language:'Chinese',topics:[],levels:[] });
    const oauth = new LibraryOAuth(db,'https://library.test',email => email === 'owner@test');
    await assert.rejects(oauth.register({redirect_uris:['https://evil.test/callback']}));
    const client = await oauth.register({redirect_uris:['https://chatgpt.com/connector/oauth/test']});
    const verifier = secret();
    const auth = await oauth.authorization({client_id:client.client_id,redirect_uri:client.redirect_uris[0],resource:oauth.resource,response_type:'code',state:'original-state',scope:oauthScopes.join(' '),code_challenge:digest(verifier),code_challenge_method:'S256'},'owner@test');
    await assert.rejects(oauth.approve(auth.id,auth.csrf,'attacker@test'));
    const redirect = new URL(await oauth.approve(auth.id,auth.csrf,'owner@test'));
    assert.equal(redirect.searchParams.get('state'),'original-state');
    const request = {grant_type:'authorization_code',client_id:client.client_id,redirect_uri:client.redirect_uris[0] as string,resource:oauth.resource,code:redirect.searchParams.get('code')!,code_verifier:verifier};
    await assert.rejects(oauth.exchange({...request,code_verifier:secret()}));
    const token = await oauth.exchange(request);
    await assert.rejects(oauth.exchange(request));
    const principal = await oauth.authenticate(`Bearer ${token.access_token}`);
    const service = new LibraryIntegrationService(db,oauth,'test-cursor-secret',async () => {});
    const mutation = async (action: any, input: any, expect = 'succeeded') => {
      const operationId = input.operationId ?? randomUUID();
      await service.execute(action,{...input,operationId},principal);
      const docs = await db.collection('integration_operations').where('operationId','==',operationId).get();
      await runIntegrationOperation(db,oauth,docs.docs[0].id,logger);
      const op = await service.operations.get(principal,operationId);
      assert.equal(op?.status,expect,JSON.stringify(op?.error));
      return op!;
    };
    const a = (await mutation('create_group',{kind:'word',category:'A',name:'Lesson'})).result!.itemId;
    const b = (await mutation('create_group',{kind:'word',category:'B',name:'Article'})).result!.itemId;
    const ga = (await mutation('create_group',{kind:'grammar',category:'A',name:'Grammar'})).result!.itemId;
    const sentence = '现在后悔也来不及了。';
    const op = await mutation('create_word',{word:{term:'后悔',definitions:[{text:{ko:'사용자 뜻'}}],examples:[{sentence,translation:{ko:'사용자 번역'}}]},targets:{groupAIds:[a],groupBIds:[b]}});
    const id = op.result!.itemId as string;
    const replay = await service.execute('create_word',{operationId:op.operationId,...op.input as any,word:{...((op.input as any).word)}},principal);
    assert.equal(replay.status,'succeeded');
    let word = await service.execute('get_word',{itemId:id},principal) as any;
    assert.equal(word.data.definitions[0].text.ko,'사용자 뜻'); assert.equal(word.groups.length,2);
    await mutation('update_word',{itemId:id,expectedVersion:'stale',patch:{notes:'must fail'}},'failed');
    await mutation('update_word',{itemId:id,expectedVersion:word.version,patch:{definitionTextUpdates:[{index:0,language:'ko',text:'변경된 뜻'}]}});
    word = await service.execute('get_word',{itemId:id},principal) as any;
    assert.equal(word.data.definitions[0].text.ja,'後悔する');
    const grammarOp = await mutation('create_grammar',{grammar:{statement:'把+O+V',descriptions:[{partOfSpeech:'',text:{ko:'직접 쓴 설명'}}],examples:[{sentence,translation:{ko:'사용자 번역'}}]},targets:{groupAIds:[ga]}});
    const grammarId = grammarOp.result!.itemId as string;
    let grammar = await service.execute('get_grammar',{itemId:grammarId},principal) as any;
    assert.equal(grammar.data.descriptions[0].text.ko,'직접 쓴 설명'); assert.equal(grammar.data.descriptions[0].text.ja,'生成説明');
    assert.equal(grammar.examples[0].id,word.examples[0].id);
    const sharedId = word.examples[0].id;
    await mutation('update_grammar',{itemId:grammarId,expectedVersion:grammar.version,patch:{exampleChanges:{replaceOwned:[{sentence,translation:{ko:'문법 전용 번역'}}]}}});
    grammar = await service.execute('get_grammar',{itemId:grammarId},principal) as any;
    assert.notEqual(grammar.examples[0].id,sharedId);
    assert.equal(grammar.examples[0].translation.ko,'문법 전용 번역');
    assert.equal((await db.doc(`example_sentences/${sharedId}`).get()).data()!.translation.ko,'사용자 번역');
    assert.ok(!(await db.doc(`example_sentences/${sharedId}`).get()).data()!.appearsInGrammarIds.includes(grammarId));
    await db.doc(`integration_connections/${principal.connectionId}`).update({scopes:['vocab.read']});
    await assert.rejects(service.execute('create_group',{operationId:randomUUID(),kind:'word',category:'A',name:'Forbidden'},principal),{code:'FORBIDDEN'});
    await db.doc(`integration_connections/${principal.connectionId}`).update({scopes:oauthScopes});

    await mutation('change_item_groups',{kind:'word',itemId:id,expectedVersion:word.version,removeBIds:[b]});
    word = await service.execute('get_word',{itemId:id},principal) as any;
    assert.equal(word.groups.length,1);
    await mutation('delete_word',{itemId:id,expectedVersion:word.version});
    assert.equal((await db.doc(`word_index/${wordIndexDocId('chinese','后悔')}`).get()).exists,false);
    assert.equal((await db.doc(`word_groups/${a}`).get()).data()!.wordIds.length,0);
    assert.equal((await db.doc(`example_sentences/${grammar.examples[0].id}`).get()).exists,true);
    grammar = await service.execute('get_grammar',{itemId:grammarId},principal) as any;
    await mutation('update_grammar',{itemId:grammarId,expectedVersion:grammar.version,patch:{descriptionTextUpdates:[{index:0,language:'ko',text:'수정 설명'}]}});
    grammar = await service.execute('get_grammar',{itemId:grammarId},principal) as any;
    assert.equal(grammar.data.descriptions[0].text.ja,'生成説明');
    await mutation('delete_grammar',{itemId:grammarId,expectedVersion:grammar.version});
    assert.equal((await db.doc(`grammar_groups/${ga}`).get()).data()!.grammarIds.length,0);
    // A common word's reference fan-out must not prevent a membership-only write.
    const { versionOf } = await import('../../../src/integrations/domain.js');
    const common = db.doc('words/common');
    const content = {language:'chinese',term:'在',exampleIds:Array.from({length:151},(_,i) => `owned-${i}`),
      appearsInIds:Array.from({length:284},(_,i) => `reference-${i}`),examples:[{sentence:'legacy content'}],notes:'preserve'};
    await common.set(content);
    await db.doc(`word_groups/${a}`).update({wordIds:['common']});
    const index = db.doc(`word_index/${wordIndexDocId('chinese','在')}`);
    await index.set({id:'common',term:'在',language:'chinese',extra:'preserve'});
    const dispatchFailure = new LibraryIntegrationService(db,oauth,'cursor-secret',async () => { throw new Error('dispatch unavailable'); });
    const acceptedId = randomUUID();
    const accepted = await dispatchFailure.execute('change_item_groups',{operationId:acceptedId,kind:'word',itemId:'common',
      expectedVersion:versionOf(await common.get()),addBIds:[b]},principal);
    assert.equal(accepted.status,'queued');
    const receipt = (await db.collection('integration_operations').where('operationId','==',acceptedId).get()).docs[0];
    await runIntegrationOperation(db,oauth,receipt.id,logger);
    assert.equal((await receipt.ref.get()).data()!.status,'succeeded');
    const {addedToGroupBAt,...preserved} = (await common.get()).data()!;
    assert.ok(addedToGroupBAt);
    assert.deepEqual(preserved,content);
    assert.deepEqual((await index.get()).data(),{id:'common',term:'在',language:'chinese',extra:'preserve'});
    assert.ok((await db.doc(`word_groups/${a}`).get()).data()!.wordIds.includes('common'));
    assert.ok((await db.doc(`word_groups/${b}`).get()).data()!.wordIds.includes('common'));
    await mutation('change_item_groups',{kind:'word',itemId:'common',expectedVersion:versionOf(await common.get()),removeBIds:[b]});
    assert.ok(!(await db.doc(`word_groups/${b}`).get()).data()!.wordIds.includes('common'));
    assert.deepEqual((await common.get()).data(),{...content,addedToGroupBAt});
    const destination = (await mutation('create_group',{kind:'word',category:'A',name:'Destination'})).result!.itemId;
    const secondB = (await mutation('create_group',{kind:'word',category:'B',name:'Second article'})).result!.itemId;
    await db.doc(`word_groups/${b}`).update({wordIds:['common']});
    const beforeMove = (await common.get()).data()!;
    const moved = await mutation('create_word',{word:{term:' 在 ',notes:'must not overwrite',definitions:[{text:{ko:'must not overwrite'}}]},
      targets:{groupAIds:[destination],groupBIds:[secondB]}});
    assert.equal(moved.result!.itemId,'common'); assert.equal(moved.result!.reusedExisting,true);
    assert.deepEqual(moved.result!.groupAIds,[destination]);
    assert.ok(!(await db.doc(`word_groups/${a}`).get()).data()!.wordIds.includes('common'));
    for (const group of [destination,b,secondB]) assert.ok((await db.doc(`word_groups/${group}`).get()).data()!.wordIds.includes('common'));
    const {addedToGroupAAt:_a,addedToGroupBAt:_b,...afterMove} = (await common.get()).data()!;
    const {addedToGroupAAt:_oldA,addedToGroupBAt:_oldB,...beforeContent} = beforeMove;
    assert.deepEqual(afterMove,beforeContent);
    assert.equal((await db.collection('words').where('term','==','在').get()).size,1);
    assert.equal((await db.doc(`words/${moved.allocatedItemId}`).get()).exists,false);
    await mutation('create_word',{word:{term:'在'},targets:{groupAIds:[a]}});
    const replayMove = await service.execute('create_word',moved.input,principal);
    assert.equal(replayMove.status,'succeeded');
    assert.ok((await db.doc(`word_groups/${a}`).get()).data()!.wordIds.includes('common'));
    assert.ok(!(await db.doc(`word_groups/${destination}`).get()).data()!.wordIds.includes('common'));
    const beforeInvalid = (await common.get()).data();
    await mutation('create_word',{word:{term:'在'},targets:{groupAIds:['missing']}},'failed');
    assert.deepEqual((await common.get()).data(),beforeInvalid);
    // Missing indexes still find the existing term; omitted A selects newest A.
    await index.delete();
    const defaultMove = await mutation('create_word',{word:{term:'在'},targets:{groupBIds:[b]}});
    assert.equal(defaultMove.result!.itemId,'common'); assert.deepEqual(defaultMove.result!.groupAIds,[destination]);
    assert.equal((await index.get()).data()!.id,'common');
    // Duplicate registrations prepared before either commit serialize to one word.
    const { commitMutation } = await import('../../../src/integrations/domain.js');
    const concurrent = await Promise.all([1,2].map(async () => {
      const job = await service.operations.accept(principal,'create_word',{operationId:randomUUID(),word:{term:'并发词'},targets:{groupAIds:[destination],groupBIds:[b]}});
      const running = await service.operations.claim(principal,job.operationId); assert.ok(running);
      await service.operations.commitCore(principal,job.operationId,running.generation,tx => commitMutation(db,tx,running,
        {data:{term:'并发词',definitions:[{text:{ko:'동시 등록'}}]},examples:[]}));
      await service.operations.complete(principal,job.operationId,running.generation);
      return (await service.operations.get(principal,job.operationId))!;
    }));
    assert.equal(concurrent[0].result!.itemId,concurrent[1].result!.itemId);
    assert.equal(concurrent.filter(job => job.result!.reusedExisting).length,1);
    assert.equal((await db.collection('words').where('term','==','并发词').get()).size,1);
    // If a reused term disappears after preparation, retry must discard the
    // empty checkpoint and enrich a new word rather than save an empty record.
    const disappearing = await service.operations.accept(principal,'create_word',{operationId:randomUUID(),word:{term:'消失词'}});
    await db.doc('words/disappearing').set({language:'chinese',term:'消失词'});
    const disappearingRun = await service.operations.claim(principal,disappearing.operationId); assert.ok(disappearingRun);
    await service.operations.saveCheckpoint(principal,disappearing.operationId,disappearingRun.generation,{});
    await db.doc('words/disappearing').delete();
    await assert.rejects(service.operations.commitCore(principal,disappearing.operationId,disappearingRun.generation,
      tx => commitMutation(db,tx,disappearingRun,{})),{code:'TEMPORARILY_UNAVAILABLE',retryable:true});
    await service.operations.fail(principal,disappearing.operationId,disappearingRun.generation,'TEMPORARILY_UNAVAILABLE',true);
    await service.operations.retry(principal,disappearing.operationId);
    const disappearingDoc = (await db.collection('integration_operations').where('operationId','==',disappearing.operationId).get()).docs[0];
    await runIntegrationOperation(db,oauth,disappearingDoc.id,logger);
    const recovered = (await service.operations.get(principal,disappearing.operationId))!;
    assert.equal(recovered.status,'succeeded',JSON.stringify(recovered.error));
    assert.equal((await db.doc(`words/${recovered.result!.itemId}`).get()).data()!.definitions[0].text.ko,'후회하다');
    // Status remains available when unrelated reads and mutation submissions exhaust their budgets.
    for (const bucket of ['read','write']) await db.doc(`integration_limits/${digest(`principal:${principal.id}:${bucket}:${Math.floor(Date.now()/60000)}`)}`).set({count:1000});
    await assert.rejects(service.execute('get_word',{itemId:'common'},principal),{code:'RATE_LIMITED'});
    assert.equal((await service.execute('get_operation',{operationId:acceptedId},principal)).status,'succeeded');
    assert.ok(Array.isArray((await service.execute('list_operations',{},principal)).items));
    const { integrationRoutes } = await import('../../../src/routes/integrations.js');
    const { default: cookie } = await import('@fastify/cookie');
    const http = Fastify(); await http.register(cookie); await http.register(integrationRoutes);
    const address = await http.listen({ port:0,host:'127.0.0.1' });
    try {
      const metadata = await fetch(`${address}/.well-known/oauth-protected-resource/api/integrations/mcp`);
      assert.equal((await metadata.json() as any).resource,oauth.resource);
      const cookieValue = `vt_session=${authModule.signSession({email:'owner@test'},authConfig.sessionSecret)}`;
      const consentQuery = new URLSearchParams({client_id:client.client_id,redirect_uri:client.redirect_uris[0] as string,response_type:'code',resource:oauth.resource,scope:'vocab.read',state:'http-state',code_challenge:digest(verifier),code_challenge_method:'S256'});
      const consentPage = await fetch(`${address}/api/integrations/oauth/authorize?${consentQuery}`,{headers:{Cookie:cookieValue}});
      assert.equal(consentPage.headers.get('referrer-policy'),'same-origin');
      assert.ok(consentPage.headers.get('content-security-policy')?.includes("form-action 'self' https://chatgpt.com https://chat.openai.com;"));
      const html = await consentPage.text();
      assert.equal(consentPage.status,200,html);
      assert.ok(html.includes('name="id"'),html);
      const id = html.match(/name="id" value="([^"]+)"/)![1];
      const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
      const rejected = await fetch(`${address}/api/integrations/oauth/approve`,{method:'POST',headers:{Cookie:cookieValue,Origin:'https://evil.test','Content-Type':'application/json'},body:JSON.stringify({id,csrf}),redirect:'manual'});
      assert.equal(rejected.status,403);
      const opaque = await fetch(`${address}/api/integrations/oauth/approve`,{method:'POST',headers:{Cookie:cookieValue,Origin:'null','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id,csrf}),redirect:'manual'});
      assert.equal(opaque.status,403);
      const approved = await fetch(`${address}/api/integrations/oauth/approve`,{method:'POST',headers:{Cookie:cookieValue,Origin:'https://library.test','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id,csrf}),redirect:'manual'});
      assert.equal(approved.status,302); assert.equal(new URL(approved.headers.get('location')!).origin,'https://chatgpt.com');
      const unauthorized = await fetch(`${address}/api/integrations/mcp`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      assert.equal(unauthorized.status,401); assert.ok(unauthorized.headers.get('www-authenticate'));
      const initialize = await fetch(`${address}/api/integrations/mcp`,{ method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${token.access_token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}}) });
      assert.equal(initialize.status,200,await initialize.clone().text());
      const list = await fetch(`${address}/api/integrations/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${token.access_token}`,'MCP-Protocol-Version':'2025-03-26'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})});
      assert.equal(list.status,200); assert.equal((await list.json() as any).result.tools.length,17);
      // Discovery/polling traffic must not hit the old shared 60/IP ceiling.
      for (let i=0;i<65;i++) {
        const response = await fetch(`${address}/api/integrations/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${token.access_token}`},body:JSON.stringify({jsonrpc:'2.0',id:i+3,method:'tools/list'})});
        assert.equal(response.status,200); await response.text();
      }
      const internal = await fetch(`${address}/internal/integration-operations/reconcile`,{method:'POST'}); assert.equal(internal.status,401);
    } finally { await http.close(); }
    const rotated = await oauth.exchange({grant_type:'refresh_token',client_id:client.client_id,resource:oauth.resource,refresh_token:token.refresh_token});
    await assert.rejects(oauth.exchange({grant_type:'refresh_token',client_id:client.client_id,resource:oauth.resource,refresh_token:token.refresh_token}));
    await assert.rejects(oauth.authenticate(`Bearer ${rotated.access_token}`));
  } finally { await db.terminate(); }
});

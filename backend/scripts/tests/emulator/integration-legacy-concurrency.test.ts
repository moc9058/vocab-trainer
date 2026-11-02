import { test } from 'node:test';
import assert from 'node:assert/strict';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('An explicit emulator is required');
process.env.FIRESTORE_PROJECT = `integration-legacy-${Date.now()}`;
process.env.FIRESTORE_DATABASE_ID = 'vocab-database';
const { db, updateWord, modifyWordGroupMembers, modifyGrammarGroupMembers } = await import('../../../src/firestore.js');
const { wordIndexDocId } = await import('../../../src/word-index-id.js');
test('legacy renames serialize with the shared index; membership cannot add deleted/foreign items',async () => {
  try {
    for (const [id,term] of [['zh-a','甲'],['zh-b','乙']]) {
      await db.doc(`words/${id}`).set({language:'chinese',term,definitions:[{text:{ko:term}}],exampleIds:[],appearsInIds:[]});
      await db.doc(`word_index/${wordIndexDocId('chinese',term)}`).set({language:'chinese',term,id});
    }
    const results = await Promise.allSettled([updateWord('chinese','zh-a',{term:'丙'}),updateWord('chinese','zh-b',{term:'丙'})]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length,1);
    const index = (await db.doc(`word_index/${wordIndexDocId('chinese','丙')}`).get()).data()!;
    assert.equal((await db.doc(`words/${index.id}`).get()).data()!.term,'丙');
    await db.doc('word_groups/a').set({id:'a',language:'chinese',name:'A',wordIds:[],createdAt:'2026-01-01'});
    await assert.rejects(modifyWordGroupMembers('a',['deleted-id'],'add'));
    assert.deepEqual((await db.doc('word_groups/a').get()).data()!.wordIds,[]);
    await db.doc('grammar_groups/g').set({id:'g',language:'chinese',name:'G',grammarIds:[],createdAt:'2026-01-01'});
    await db.doc('grammar_items/foreign').set({language:'japanese',statement:'test'});
    await assert.rejects(modifyGrammarGroupMembers('g',['foreign'],'add'));
    assert.deepEqual((await db.doc('grammar_groups/g').get()).data()!.grammarIds,[]);
  } finally { await db.terminate(); }
});

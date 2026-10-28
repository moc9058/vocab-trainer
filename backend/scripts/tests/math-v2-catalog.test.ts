import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from '../../src/math-content.js';
import { resolveScopeV2, planNextQuestion } from '../../src/math-scope.js';
const { catalog } = await buildCatalog(fileURLToPath(new URL('../../../textbook/', import.meta.url)));
const request = (selectedNodeIds: string[]) => ({ schemaVersion: 2 as const, subjectId: 'linear-algebra', selectedNodeIds, difficulty: 2 as const, responseLanguage: 'ja' as const });
test('published nine-chapter JSON scopes keep chapter5 targets and chapters1–4 prerequisites distinct', () => {
  const scope = resolveScopeV2(request(['la-ch05']), catalog);
  assert.deepEqual(scope.prerequisiteChapterIds, ['la-ch01', 'la-ch02', 'la-ch03', 'la-ch04']);
  assert(scope.targetObjectiveIds.length > 0);
  for (const id of scope.targetObjectiveIds) {
    const objective = catalog.objectives.find(o => o.id === id)!;
    assert.equal(catalog.conceptChapterIds![objective.assessedCapabilities[0].conceptId], 'la-ch05');
  }
  assert(scope.prerequisites.length > 0);
  assert(scope.prerequisites.every(r => scope.prerequisiteChapterIds!.includes(catalog.conceptChapterIds![r.conceptId])));
  assert.equal(scope.plans.length, 0);
});
test('all selectable JSON leaves fit the v2 contract and a single leaf never imports its same-chapter siblings', () => {
  const leaves = catalog.nodes.filter(n => n.unitIds.length && !catalog.nodes.some(c => c.parentId === n.id));
  const whole = resolveScopeV2(request(leaves.map(n => n.id)), catalog);
  assert.equal(whole.targetObjectiveIds.length, catalog.objectives.filter(o => o.readiness === 'ready').length);
  const leaf = leaves.find(n => n.ancestorIds.includes('la-ch05'))!;
  const scope = resolveScopeV2(request([leaf.id]), catalog);
  const plan = planNextQuestion(scope, catalog, 22);
  assert(plan.targetObjectiveIds.every(id => catalog.objectives.find(o => o.id === id)?.unitId === leaf.unitIds[0]));
  const own = catalog.units.find(u => u.id === leaf.unitIds[0])!.conceptIds;
  assert(!scope.prerequisites.some(r => catalog.conceptChapterIds![r.conceptId] === 'la-ch05' && !own.includes(r.conceptId)));
  assert(plan.mayAssume.every(r => !plan.mustEstablish.some(p => p.conceptId === r.conceptId)));
});

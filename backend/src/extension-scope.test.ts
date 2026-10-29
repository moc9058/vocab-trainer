import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extensionAllows } from './extension-scope.js';
test('extension capabilities include shared registration APIs but exclude admin, quizzes and other languages', () => {
  for (const [method, path] of [
    ['POST', '/api/import/chinese/sessions'], ['GET', '/api/import/chinese/sessions/id/analysis-job'],
    ['POST', '/api/import/chinese/sessions/id/sentences/0/explanation'], ['PUT', '/api/import/chinese/sessions/id'],
    ['POST', '/api/vocab/chinese/smart-add'], ['POST', '/api/vocab/chinese/groups/id/words'],
    ['POST', '/api/grammar/chinese/smart-add'], ['POST', '/api/grammar/chinese/groups/id/grammar'],
    ['GET', '/api/grammar/settings'], ['POST', '/api/auth/extension/revoke'],
  ]) assert.equal(extensionAllows(method, path), true, `${method} ${path}`);
  for (const [method, path] of [
    ['PUT', '/api/grammar/settings'], ['POST', '/api/math/tests'], ['POST', '/api/quiz/chinese'],
    ['GET', '/api/llm-config'], ['POST', '/api/auth/mobile/start'], ['POST', '/api/auth/extension/connections/revoke'],
    ['POST', '/api/vocab/japanese/smart-add'], ['DELETE', '/api/import/chinese/sessions/id'],
    ['GET', '/api/import/chinese/sessions/%2e%2e'], ['GET', '/api/import/chinese/sessions/..'],
    ['GET', '/api/import/chinese/sessions/id?admin=1'], ['GET', 'https://evil.example/api/import/chinese/sessions'],
  ]) assert.equal(extensionAllows(method, path), false, `${method} ${path}`);
});

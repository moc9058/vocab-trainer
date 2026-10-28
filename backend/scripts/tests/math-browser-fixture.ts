import {
  linearAlgebraFixture,
  request,
  validCandidate,
} from "./math-fixtures.js";
import { resolveScope, makePreview } from "../../src/math-scope.js";
const f = await linearAlgebraFixture(),
  scope = resolveScope(request(), f.catalog),
  preview = {
    ...makePreview(scope, "preview-fixture"),
    labels: Object.fromEntries([
      ...f.catalog.concepts.map((c) => [c.id, c.title]),
      ...f.catalog.objectives.map((o) => [o.id, o.description]),
    ]),
  },
  candidate = validCandidate(f.catalog, scope, scope.plans[0]);
console.log(
  JSON.stringify({ f, scope, preview, candidate, scopeRequest: request() }),
);

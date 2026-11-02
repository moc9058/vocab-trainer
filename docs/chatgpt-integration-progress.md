# ChatGPT integration implementation progress

2026-11-02. Work in progress; the integration is not available to ChatGPT yet.
See [the implementation plan](chatgpt-vocab-crud-plan.md).

Implemented foundations:

- Strict integration.v1 tool input contracts and JSON Schema export, with bounded
  payloads, server-field rejection, partial-language edits and ownership-aware
  example commands. Existing HTTP registration contracts are unchanged.
- SDK MCP server factory with 17 tools, annotations, per-call authorization and
  sanitized failure results. The dispatcher remains an injected interface.
- OAuth access-token verification with pinned issuer/JWKS origin, audience,
  asymmetric signature algorithms, required expiry/subject/scope, explicit
  identity mapping, live allowlist checks and connection revocation checks.
- Firestore operation acceptance and dispatch outbox in one transaction,
  request hash conflicts, leases with fencing generations, domain-write callback
  committed atomically with the receipt, and restart after core commit.

These modules are not registered in `index.ts`. No external endpoint has been
opened and no production library mutation was performed during verification.

Still required before end-to-end use:

1. Extract existing route orchestration into shared word/grammar/example services.
2. Implement the domain dispatcher, read projections, conditional updates,
   transactional groups and resumable shared-example cleanup.
3. Complete the operation lifecycle (failure, checkpoints, explicit retries,
   pagination, rate limits and retention/tombstones).
4. Add Cloud Tasks worker/dispatcher/reconciler and infrastructure scripts.
5. Configure an OAuth provider and explicit owner connections; connect the
   authenticator to the real identity store and Fastify request boundary.
6. Add Streamable HTTP transport, discovery/proxy routes and setup instructions.
7. Verify existing callers, emulator full-stack CRUD and actual ChatGPT acceptance.

Verification performed:

- Backend TypeScript build.
- Backend unit/regression suite: 157 passed, including 8 integration tests.
- An isolated emulator on port 8189, using a unique test project: concurrent
  acceptance, hash conflict, principal isolation, expired lease fencing,
  atomic core receipt replay and worker restart; 1 test passed.
- MCP initialize/list/call tested through the SDK in-memory transport, including
  permission denial and revocation between calls. HTTP transport and ChatGPT
  account connection have not been tested.

Commands from the repository root:

```bash
npm run build --prefix backend
npm test --prefix backend
npm run test:integration --prefix backend
# Requires an already running, explicitly selected emulator; never falls back to production.
FIRESTORE_EMULATOR_HOST=127.0.0.1:8189 npm run test:integration:emulator --prefix backend
```

No OAuth credentials or user-provided identity are accepted in tool arguments.
Provider configuration and actual account support remain to be confirmed. The
configuration reader requires explicit `INTEGRATIONS_ENABLED=true`, issuer,
audience, JWKS URI and MCP resource; this does not enable a route by itself.

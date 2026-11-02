# ChatGPT ↔ Vocab Trainer

The backend exposes authenticated Chinese vocabulary and grammar CRUD through
Streamable HTTP MCP. It uses the existing Google login to approve a connection;
no Auth0 account, Google client secret pasted into ChatGPT, or shared API key is
needed. The library remains the existing shared library for allowed accounts.

## Connect in ChatGPT

1. Open ChatGPT on the web and add a custom MCP server/plugin, or install the
   private Vocab Trainer plugin when its link is supplied.
2. Use this server URL:
   `https://vocab-trainer-frontend-olncevthqa-an.a.run.app/api/integrations/mcp`.
3. Select OAuth with dynamic client registration (DCR). Do not supply a client
   secret. Discovery advertises the authorization, token and registration URLs.
4. Sign in to Vocab Trainer with your usual Google account. If the approval page
   asks you to sign in, use its Google login link, then return and reload it.
5. Review the requested scopes and press Allow. Closing the page cancels approval.
6. Select the installed plugin in a conversation and ask, for example:
   “Register 后悔 with the Korean meaning 후회하다” or “Show the grammar 把+O+V”.

Account/workspace permissions determine whether custom MCP plugins are available.
The server and emulator protocol tests do not establish access to a particular
ChatGPT account. Actual installation, Google consent and conversation acceptance
must be verified on that account.

## Behavior

- Tools cover word/grammar create, search, get, partial update and delete; group
  listing/creation and membership changes; and operation status/retry.
- Definitions use ISO language keys. Chinese study language is fixed by the server.
- Create may use the server LLM even when supplied fields are complete. Word
  definitions must finish in Korean/Japanese/English; grammar preserves supplied
  explanations and fills Japanese/Korean.
- Registration assigns a real A home, defaulting to the newest A group, plus
  requested B memberships. Words have one A home; grammar may have several.
  No A group is silently created. Word and grammar group IDs are distinct.
- Mutations return queued operations. Poll `get_operation` until succeeded or
  failed; never claim that queued means registered. `list_operations` can find
  unfinished work if a conversation is interrupted.
- Reuse the same UUID operationId for the same request. Changing its payload
  yields an idempotency conflict. Retry a retryable failed operation with
  `retry_operation`; GET never starts it again.
- Read an item before editing or deleting it. Send its exact version token.
  Concurrent changes cause VERSION_CONFLICT. Read again and rebuild the patch.
- Definition/description language patches preserve other languages. Array
  replacement is explicit. Removing Group B membership keeps the library item.
- Owned and referenced examples are distinguished. Dropping an owned example does
  not remove another item's reference. Conflicting translations of an existing
  sentence are stored as separate example variants, preserving other consumers.
  Detached example documents are retained for safe garbage collection rather than
  physically deleted during these external mutations. Operation warnings disclose
  this retention. No production cleanup or bulk migration is performed.
- An item with more than 150 owned examples, 200 referenced examples, or operations
  spanning more than 350 writes is rejected without a partial core commit.
  At most 250 groups per domain are handled by a mutation. These are explicit
  implementation limits, not ChatGPT limits.
- No arbitrary Firestore access, settings changes, quiz grading, progress reset,
  whole-library deletion, or textbook publication is exposed.

## Authorization and revocation

OAuth authorization code + S256 PKCE uses a one-use two-minute code and ten-minute
approval request. Access tokens last one hour. Refresh tokens rotate, last 30 days,
and revoke the connection on reuse. Clients and connections expire after 90 days;
reconnect when necessary. Only token hashes are stored. Tokens are bound to the
canonical MCP resource and registered exact ChatGPT redirect URI.

Every call and uncommitted worker transaction checks the live connection,
allowlist and scopes. Removing an allowed email or disabling a connection blocks
future access. Already committed work can finish derived metadata reconciliation.
Existing Safari extension and mobile bearer tokens do not authorize this endpoint.

To inspect connections while signed in, GET `/api/integrations/connections`.
To revoke one, POST `/api/integrations/connections/revoke` with `{ "id": "..." }`
from the canonical Vocab Trainer origin, using the existing login cookie.
OAuth clients may also use the advertised standard revocation endpoint.
There is currently no frontend connection-management panel.

Operations retain full inputs for 30 days, then the reconciler removes input and
checkpoints. Hash receipts remain until the 90-day TTL. Reads of expired operations
are denied even before TTL executes. Do not automatically replay an expired request
under a new ID. Logs include safe operation identifiers and error codes, not tokens.

## Hosting and setup

All integration routes are disabled unless `INTEGRATIONS_ENABLED=true` and existing
Google auth is configured. The public origin is the origin of the first existing
Google redirect URI. Use the canonical frontend hostname for consent and MCP.

After code deployment, provision the dedicated queue, invoker identity, recovery
scheduler, TTL fields and nonsecret Cloud Run settings:

```bash
cd backend
npx tsx scripts/setup-integration-jobs.ts vocab-trainer-490014 asia-northeast1
```

The script preserves the import queue and existing Cloud Run environment values.
No `--auth`, `--llm`, `--prompts`, seed load or textbook sync is required. New
settings are INTEGRATIONS_ENABLED, INTEGRATION_TASK_PROJECT,
INTEGRATION_TASK_REGION, INTEGRATION_TASK_QUEUE, INTEGRATION_WORKER_URL and
INTEGRATION_TASK_ACCOUNT. No signing key or external OAuth provider is needed for
the built-in issuer. The earlier optional JWT verifier module is not a live route.

Normal Bash/PowerShell deploys validate the integration queue and scheduler when
enabled. Disable acceptance by setting INTEGRATIONS_ENABLED=false. Before rolling
back to code that lacks workers, pause the dedicated queue/scheduler and inspect
running/core-committed operations. A code rollback does not undo saved data.

Local compose includes a separate integration worker. In host development it can
also be run with an explicitly selected emulator:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run dev:integration-worker --prefix backend
```

The local worker refuses a production fallback. HTTP OIDC worker routes never have
an emulator authentication bypass. Cloud Tasks and Cloud Scheduler use a dedicated
Google service account and exact OIDC audience; generic queue headers do not grant
access. Each mutation's core item/index/groups/examples and receipt commit in one
transaction. A durable outbox covers enqueue failures; leases fence stale workers.

## Verification

```bash
npm run build --prefix backend
npm test --prefix backend
npm run test:mixed --prefix backend
FIRESTORE_EMULATOR_HOST=127.0.0.1:8189 npm run test:integration:emulator --prefix backend
(cd frontend && npx tsc --noEmit)
npm test --prefix frontend
npm run build --prefix frontend
```

The integration emulator tests use isolated projects and fake LLM responses. They
exercise Google-cookie boundary helpers, OAuth PKCE/code replay/refresh reuse,
word and grammar CRUD, language preservation, groups, shared examples, version
conflicts, worker restarts and legacy index rename races. HTTP tests initialize
MCP and list tools through the actual SDK transport and reject unauthenticated
worker calls. Real Google OAuth and actual ChatGPT conversation acceptance remain
separate account-level checks.

## Sources

The implementation follows [OpenAI MCP connection guidance](https://developers.openai.com/api/docs/guides/custom-mcp-server),
[MCP authentication guidance](https://developers.openai.com/plugins/build/auth),
and [MCP server guidance](https://developers.openai.com/plugins/build/mcp-server).
The original [implementation plan](chatgpt-vocab-crud-plan.md) records the intended
scope; this guide documents the implemented choices and limits.

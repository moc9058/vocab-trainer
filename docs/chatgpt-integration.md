# ChatGPT ↔ Vocab Trainer

The backend exposes authenticated Chinese vocabulary and grammar CRUD through
Streamable HTTP MCP. It uses the existing Google login to approve a connection;
no Auth0 account, Google client secret pasted into ChatGPT, or shared API key is
needed. The library remains the existing shared library for allowed accounts.

## Web and native mobile registration status

The original private package is **Desktop Only**. Its HTTPS server URL does not
make that imported package web-compatible. OpenAI documents that imported MCP
packages can receive this classification, and adding `.app.json` alone does not
remove it. See [Desktop-only plugins](https://learn.chatgpt.com/docs/enterprise/plugin-management).
Do not present the original installation link as a web/mobile connection.

The selected approach preserves the existing Cloud Run backend, Firestore and
Google-approved OAuth connection. No Sites bridge or separate proxy is authorized.
Web OAuth, discovery of all 17 tools and actual profile/word lookup succeeded on
2026-11-03. Native mobile profile invocation also succeeded; full CRUD acceptance remains pending;
server deployment alone does not establish those outcomes.
On 2026-11-03, Safari's ChatGPT Plugins → Add menu exposed **Add custom MCP
server**. The direct OAuth connection was started as **Vocab Trainer Cloud**,
using the existing canonical endpoint. Prefer this personal connection path;
portal submission is not required for private use. OAuth completed and actual web read tools ran successfully. The native iPhone
installed list includes this cloud plugin, and its profile call returned the
same connection ID as web. See the dated
[verification record](chatgpt-integration-progress.md#personal-cloud-connection-2026-11-03).

The first Safari consent POST returned 403. The authorization page used
`Referrer-Policy: no-referrer`, which can suppress the form POST's Origin in
Safari. It now uses `same-origin` so same-origin approval retains provenance
without disclosing OAuth query parameters across origins. Exact Origin, signed
cookie, one-use CSRF and consent checks remain required; null origins are rejected.
Safari also applies CSP form-action to the approval POST's 302 redirect. The
policy permits only self plus the existing registered ChatGPT origins
(`https://chatgpt.com` and `https://chat.openai.com`), matching the issuer allowlist.

### Register the existing remote server

For personal use, open ChatGPT Plugins → Add → Add custom MCP server, name it
Vocab Trainer Cloud, enter the canonical URL below and select OAuth. Leave
client credentials empty for dynamic registration, then complete consent.
Preserve the original Desktop Only package while verifying the new connection.
See the [official quickstart](https://developers.openai.com/plugins/quickstart).

If that menu is unavailable, inspect the portal as a fallback. Follow the portal's [remote MCP registration procedure](https://developers.openai.com/plugins/deploy/submission):

1. Inspect existing Vocab Trainer apps/drafts in the selected organization before
   creating anything. Preserve the existing private package until a replacement
   has passed acceptance.
2. Use the remote **With MCP / Connect MCP server** route. The source package is
   `integrations/chatgpt/vocab-trainer/`; its root manifest, MCP declaration and
   skill must remain together if the portal requires a ZIP. A ZIP upload by itself
   is not evidence of a web-capable registered app.
3. Use this exact canonical server URL:
   `https://vocab-trainer-frontend-olncevthqa-an.a.run.app/api/integrations/mcp`.
4. Select OAuth with dynamic client registration (DCR). Do not supply a client
   secret. Discovery advertises authorization, token and registration endpoints.
5. If domain verification is required, record the portal's exact challenge host
   and token before changing the server. The expected route is
   `/.well-known/openai-apps-challenge`, with only the token as a plain-text body.
   The frontend already proxies `/.well-known/` to the backend; it does not serve
   a challenge token yet. Do not substitute a placeholder or another app's token.
6. Complete Google login and consent as described below, then inspect the tool
   scan. Expect 17 tools covering library profile, word/grammar CRUD, groups and
   durable operation status/list/retry. Resolve actual reported errors before
   altering the OAuth redirect-origin allowlist or tool schemas.
7. Use an owner-private installation/test path if the portal offers one. Record
   the returned app ID, plugin ID and installation link exactly. Do not invent an
   app ID or add an `.app.json` binding before the app exists.
8. If the available path requires public publication, review submission, or does
   not permit native mobile access, record the exact limitation and stop that
   transition. Public submission and a new hosting service are not authorized.
   Do not claim that a draft/scan alone resolves Desktop Only.

The available Plugin Creator tools can inspect and update packages; they do not
expose remote app registration or domain verification. Browser access to the
signed-in developer portal is required for those steps.

### Google consent and use

1. Sign in to Vocab Trainer with the usual Google account. If the approval page
   asks for sign-in, follow its Google login link, then return and reload it.
2. Review requested scopes and press Allow. Closing the page cancels approval.
3. Select the registered plugin in a new conversation and ask, for example:
   “Register 后悔 with the Korean meaning 후회하다” or “Show the grammar 把+O+V”.

Account/workspace permissions determine which registration and installation
features are available. The custom MCP plus-menu instructions apply only where
that menu is actually available. Never equate the imported private package, a
custom developer connection and a portal-registered remote app without checking
the actual account and platform behavior.

### Required platform acceptance

Run on ChatGPT web and the native ChatGPT mobile app, with the desktop app fully
quit. Use clearly marked test fixtures and delete only those fixtures afterward.
Record dates, client versions, registered IDs, operation IDs and outcomes; never
record credentials or tokens.

- Install/activate without Desktop Only; complete Google consent and discover tools.
- Create, read, update and delete one Chinese word and one grammar element on each
  platform. Poll each mutation to terminal success and verify the saved values.
- Read an item created on web from mobile using the same ID, then update it on
  mobile and confirm the change on web and in the existing library UI.
- Verify A/B membership changes preserve the main item and the established A-home
  invariants. Confirm a repeated operation ID does not duplicate a mutation.
- Verify insufficient scopes and a revoked connection are rejected; reconnect
  successfully and verify the intended Google account is used.

Do not mark platform support complete when only metadata, emulator tests, portal
registration, a tool scan or Cloud Run deployment has succeeded.

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
- Keep at most five mutations unfinished at once. Prefer one `list_operations`
  call for multiple jobs and respect `pollAfterMs` (3 seconds). Per-minute budgets
  are separate: 60 mutation requests, 120 library reads and 180 status reads.
  MCP transport has a separate 600-request/IP ceiling; OAuth routes retain their
  60-request/IP ceiling. Rate errors include a 60-second retry delay and the actual
  error code in both text and structured tool results. Accepted jobs retain their
  queued receipt if immediate dispatch fails; the durable outbox retries dispatch.
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
- Content mutations on an item with more than 150 owned examples, 200 referenced examples, or operations
  spanning more than 350 writes is rejected without a partial core commit.
  At most 250 groups per domain are handled by a mutation. These are explicit
  implementation limits, not ChatGPT limits.
- Membership-only changes preserve content, indexes and example references and
  do not apply example-count limits. The group and write limits still apply.
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

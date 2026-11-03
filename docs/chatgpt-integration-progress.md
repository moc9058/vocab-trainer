# ChatGPT integration implementation record

Updated 2026-11-02. See [the integration guide](chatgpt-integration.md) for actual
behavior, connection steps, operations and implementation limits.

The initial foundation commit was bfb3e0b. The subsequent implementation connects
those contracts to real domain services, Firestore transactions, OAuth approval
using the existing Google login, Streamable HTTP routes, durable Cloud Tasks and a
recovery scheduler. Word and grammar preparation are shared with existing routes.
Legacy word rename commits now serialize the word/index together, and membership
adds reject missing/cross-language items inside their transaction.

Verified locally: backend build/unit tests, mixed quiz regressions, isolated
emulator word/grammar CRUD and OAuth tests, actual HTTP MCP initialization/listing,
operation replay/lease/restart tests, and legacy concurrent rename tests. No
production vocabulary fixture was created for these checks.

Actual ChatGPT installation, Google consent and natural-language end-to-end
acceptance require the account connection. Do not equate server deployment with
that account-level verification. The final task report records deployment status.

Implementation decisions differing from the broad original plan:

- Built-in OAuth issuer reuses existing cookie/Google authentication, so no managed
  provider account or billing setup is required. Only registered ChatGPT HTTPS
  redirect origins are accepted; DCR clients use PKCE without a client secret.
- External core mutations are atomic and bounded instead of arbitrarily chunked.
  Oversized operations fail before writing. Detached examples are retained with
  an explicit warning, preserving shared consumers and avoiding a GC race with
  existing clients. Existing legacy cleanup behavior is unchanged.
- No Actions fallback, full REST mirror, or frontend management panel is needed
  for the implemented MCP path. Cookie-protected connection list/revoke endpoints
  and OAuth revocation are available.
- Example-translation conflicts create separately referenced variants. Existing
  shared translations are preserved; the canonical sentence index remains intact.
- The optional JWT verifier from the foundation remains a tested utility; live
  routing uses the built-in opaque OAuth token store.

## Desktop Only investigation and migration (2026-11-02)

The existing uploaded package has root `mcp.json` and compatibility `.mcp.json`
server declarations, and no App binding. Its current verified registration is:

- Plugin: `plugins_6ae824b0a8448191b566627d8906ee1b` (USER / PRIVATE).
- Release: `pluginrel_6ae824b47ea48191b2d853f3a8893af6`, version 1.0.0.
- Existing link: https://chatgpt.com/plugins/plugins_6ae824b0a8448191b566627d8906ee1b
  (Desktop Only; not a verified web/mobile installation link).

OpenAI's imported-plugin classification explains the observed label; an HTTPS
server URL or a newly added App-reference file does not remove it. The selected
replacement route is developer-portal remote MCP registration using the same
server, issuer and data. The user declined a Sites bridge and reports a visible
registration button in the developer portal. No public submission is authorized.

| Check | Current result |
| --- | --- |
| Original private package identity | Confirmed through Plugin Creator metadata |
| Developer portal registration | Pending; no new app/draft was created in this run |
| Domain-verification token | Not obtained; no challenge route/token added |
| OAuth callback compatibility with portal | Pending actual portal connection |
| New private installation link | Not issued |
| ChatGPT web CRUD | Not verified |
| Native ChatGPT mobile CRUD with desktop quit | Not verified |
| Cross-device IDs, revocation and operation replay | Not verified in ChatGPT |

The implementation attempt could not access the portal: the computer-use tool
reported a locked Mac and local browser use disabled in Work settings. The user
has been asked to unlock the Mac and enable that access. This is an environment
access prerequisite, not an OAuth/server failure. No runtime, OAuth policy, plugin
package, registration, hosting or production data was changed for this attempt.
Follow the registration and acceptance checklist in the integration guide when
access is restored. Do not replace these pending outcomes with earlier server
protocol/emulator test results.


## Personal cloud connection (2026-11-03)

ChatGPT web now exposes Plugins → Add → Add custom MCP server for this account.
Created **Vocab Trainer Cloud** directly against the existing canonical endpoint:

- Plugin: `plugin_asdk_app_6ae9ac3ed1d88191ac1da64a2222238d`.
- App: `asdk_app_6ae9ac3ed1d88191ac1da64a2222238d`.
- Link: https://chatgpt.com/plugins/plugin_asdk_app_6ae9ac3ed1d88191ac1da64a2222238d
- Web displays **Your cloud plugin**; the original Desktop Only package remains.
- Existing Google login and user-approved eight CRUD/group scopes completed OAuth.
- ChatGPT displayed nine write and eight read tools.
- Actual web conversation successfully called `get_connection_profile` and
  `search_words` (exact 后悔 → `zh-000632`), with no library mutation.
- Evidence conversation: https://chatgpt.com/c/6ae9af4b-ace4-83ee-a7c0-897859495616
- Native iPhone ChatGPT displays the new plugin in its installed list. Mobile
  invocation and full word/grammar CRUD acceptance are still pending.

Two Safari consent problems were fixed: no-referrer caused the exact-Origin check
to fail; form-action self then blocked the successful 302 back to ChatGPT. The
page now uses Referrer-Policy same-origin and permits form navigation only to self
and the two ChatGPT origins already accepted by OAuth client registration. Null
and foreign origins remain rejected, and cookie/one-use CSRF checks remain.
Backend build, 161 unit tests and isolated emulator integration tests passed.
Both fixes were pushed to master and deployed through deploy.sh. The iPhone app's
production asset sync, signed build, profile/device checks, overwrite installation
and launch also succeeded. No portal draft or public submission was needed.

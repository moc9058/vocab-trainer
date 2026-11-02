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

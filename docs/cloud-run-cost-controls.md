# Cloud Run cost controls

## Runtime and deployment limits

`backend/src/llm-budget.ts` wraps Fastify handlers in an AsyncLocalStorage context.
Every model call in the handler shares its 180-second wall-clock budget, including
sequential translation stages, parallel target languages, configuration lookup,
connection establishment and SDK retry delays. Article analysis at
`/api/import/:language/analyze-stream` gets 600 seconds. The model catalog probes
also use the request signal. Maintenance scripts calling `callLLM` outside HTTP
receive the same limit per call.

The OpenAI client retries at most twice and limits each connection/non-streaming
attempt to 120 seconds. Streaming uses a separate 30-second idle timer after
connection establishment, plus the overall budget. A stalled stream throws instead
of returning incomplete output for persistence. Client disconnection aborts model
requests and stops SSE keep-alives. Shared configuration reads may finish in the
background, but a cancelled caller stops waiting and cannot start a new model call.
Ordinary database writes, including quiz answer commits, are not cancelled.

Both deployment scripts pin these settings for both services:

| Setting | Value |
| --- | --- |
| Service and revision minimum instances | 0 |
| Service and revision maximum instances | 3 |
| CPU / memory | 1 vCPU / 512 MiB |
| Maximum concurrency | 80 |
| Billing | Request-based (`--cpu-throttling`) |
| Cloud Run request timeout | 660 seconds |
| Startup CPU boost | Enabled |

nginx's upstream read timeout is also 660 seconds, leaving time for a 600-second
article-analysis budget to report an error. The read timeout measures inactivity;
SSE keep-alives do not reset the application's wall-clock deadline. Maximum
instances is a scaling control, not a guaranteed monthly spending cap.

## Streaming and logging

The updated frontend requests `{ text, streamFormat: "chunks" }` for article
analysis. The server emits `analysis-chunk` with `{ chunk }`, and the frontend
accumulates it locally before invoking its existing `onDelta(fullText)` callback.
For cached clients omitting `streamFormat`, the server retains `analysis-delta`
with `{ text: fullText }`. The updated frontend also accepts that older format,
so either deployment order is supported. The final `analysis-result` is unchanged.

Backend application logs go only to stdout. Automatic Fastify request logs and
nginx access logs are disabled because Cloud Run already records requests;
application errors and nginx errors remain logged. No growing local log file is
created in Cloud Run's memory-backed filesystem.

## Read-only usage baseline with uv

All Python dependencies belong to a uv virtual environment. From the repo root:

```bash
uv venv .venv
uv pip install --python .venv/bin/python -r backend/scripts/python-requirements.txt
.venv/bin/python backend/scripts/report-cloud-run-usage.py
# Optional: --project PROJECT --region REGION --days 7
```

On Windows use `.venv\Scripts\python.exe` in place of `.venv/bin/python`.
The script uses the current `gcloud` login, reads Cloud Monitoring only, and never
prints or saves access tokens. It needs `monitoring.timeSeries.list` permission.
Missing data is reported as `null`, not zero. TLS certificates come from certifi
installed in the uv environment. `.venv/` is excluded from Git.

Baseline read on **2026-10-07**, before deployment of these controls, covering
2026-09-07 11:50 UTC through 2026-10-07 11:50 UTC:

| Service | Billable instance seconds, all revisions | Requests |
| --- | ---: | ---: |
| backend | 1,547,195.311 | 1,625 |
| frontend | 1,547,375.988 | 1,697 |

These are usage metrics, not invoice totals or average request durations.
Multiple requests can share an instance's billable time. Historical revisions and
historical billing settings are included. Actual Cloud Run CPU/memory/request and
network SKUs, Logging, Firestore and OpenAI charges must be compared separately in
billing reports. Free tier, discounts and taxes are not calculated by this script.
Compare equal periods after deployment, accounting for changes in workload.

## Verification

```bash
npm run build --prefix backend
npm test --prefix backend
(cd backend && node --experimental-test-module-mocks --import tsx --test scripts/tests/llm-cost-controls.test.ts)
(cd frontend && npx tsc --noEmit)
npm test --prefix frontend
npm run build --prefix frontend
bash -n deploy.sh
git diff --check
```

The cost-control tests mock model and database calls; no real LLM fees or cloud
writes occur. They cover pre-stream connection deadlines, shared sequential
budgets, stream-idle failures and compatibility between stream formats. The
ordinary backend suite also checks concurrent request isolation and cancellation
over a real local HTTP connection.

Verification on 2026-10-07 passed backend/frontend builds, frontend type checking,
unit suites, mixed route regressions, cost-control regressions, Bash syntax and
`git diff --check`. An isolated Docker Compose environment with Node 24 and a
Firestore emulator also served the frontend, auth status, languages and saved
import sessions through nginx with HTTP 200; no backend log directory was created.
Real OpenAI calls were not made. PowerShell execution was not checked because
`pwsh` is unavailable.

Deployed on 2026-10-07 with `./deploy.sh` to `vocab-trainer-490014` /
`asia-northeast1`. Backend revision `vocab-trainer-backend-00467-6vn` and frontend
revision `vocab-trainer-frontend-00452-vrp` each received 100% of traffic.
Post-deploy checks confirmed service/revision maximum 3, request-based billing,
concurrency 80 and a 660-second timeout. The frontend returned HTTP 200 and its
proxied `/api/auth/me` reported authentication enabled. Authenticated study flows
and real LLM calls were not exercised in production.

For future normal deployments, start Docker Desktop and run from the repo root:

```bash
./deploy.sh
# Explicit equivalent:
./deploy.sh vocab-trainer-490014 asia-northeast1
```

This builds and deploys both services and prunes superseded artifacts. Config
upload flags are only needed when intentionally changing stored configuration.

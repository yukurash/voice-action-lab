# Voice action lab server

Node 24, TypeScript source execution, Fastify. `buildApp(config, dependencies)`
creates an application without listening; `index.ts` starts it only when executed.
Dependencies are pinned in this workspace's package manifest. Install from the
repository root using its lockfile.
`@fastify/static` is pinned to 10.1.3 (Fastify 5.x compatible) for its path traversal
and noncanonical URL fixes; do not downgrade to the affected 8.x release.
Static files are resolved at request time, not enumerated only at startup, so
new hashed assets referenced by a rebuilt index remain accessible. Global owner
authentication and static-root confinement apply to those requests too.

## Private runtime configuration

Do not commit actual resource endpoints, identities, tokens, recordings, or results.

| Variable | Meaning |
| --- | --- |
| `HOST`, `PORT` | Defaults: `127.0.0.1`, `3000`. |
| `NODE_ENV` | `production` disables development authentication. |
| `AUTH_MODE` | `dev` or `easyauth`. Development requires loopback binding. |
| `TRUST_EASYAUTH_PROXY` | Must explicitly be `true` with EasyAuth. |
| `ALLOWED_TENANT_ID` | Required tenant UUID for EasyAuth. |
| `ALLOWED_OBJECT_IDS` | Required comma-separated object UUID allowlist, not an entire tenant. |
| `ALLOWED_ORIGINS` | Exact comma-separated browser origins. Production requires HTTPS. |
| `LIVE_ENABLED` | Defaults to `false`; disabled live requests return 503, never simulation. |
| `AZURE_OPENAI_ENDPOINT` | Private HTTPS Azure OpenAI resource endpoint; required when live enabled. |
| `AZURE_LIVE_MODEL` | Must be `gpt-live-1`. |
| `AZURE_BACKEND_MODEL` | Must be `gpt-5.5`. |
| `AZURE_CREDENTIAL_MODE` | `cli` in development or `managed-identity`; production requires managed identity. |
| `AZURE_TENANT_ID` | Optional Azure CLI credential tenant. |
| `AZURE_CLIENT_ID` | Optional user-assigned managed identity client ID. |
| `STATIC_DIRECTORY` | Optional absolute path to the built SPA only. No repository-root serving. |
| `STEP_INTERVAL_MS` | Game-engine movement step interval, default `1000`; integer 100–5000. Identical in both modes. |
| `AZURE_STORAGE_ACCOUNT_NAME` | Optional private Blob account name, not a URL/key/connection string. Omitted means exports return `export_not_configured`. |
| `AZURE_STORAGE_CONTAINER` | Existing private container; defaults to `experiments`. |
| `SOURCE_COMMIT` | Optional full 40/64-character hexadecimal commit hash included in exports. |
| `MAINTENANCE_PORT` | Unset disables the operator listener. Bicep sets `3001`; it binds only to `127.0.0.1`, never the public host. |
| `CLOSE_TIMEOUT_MS` | Final-usage close grace, default `8000`; integer 1-10000. Identical in both modes. Unconfirmed usage remains explicitly unconfirmed. |

**EasyAuth is a deployment trust boundary.** The application validates
`x-ms-client-principal`, but cannot independently authenticate this header.
The production ingress must require authenticated EasyAuth requests and prevent
direct access that bypasses the identity proxy or preserves forged identity headers.
Do not configure trusted-proxy mode on an unprotected public listener.

## Operator maintenance

When explicitly enabled, a separate HTTP listener binds only to loopback.
It is not a Fastify route and must not be exposed by ingress or port forwarding.
Container operators can run `node /app/packages/deployment/client.ts drain`,
`status`, or `resume` inside the Linux runtime container.

Drain synchronously closes admission and waits for creation, live work, and
asynchronous usage collection to release the single reservation. It does not
cancel that work. The client polls every five seconds for at most eleven minutes;
each request is independently bounded. Only verified inactive-and-draining state
produces the exact `VOICE_ACTION_LAB_DRAIN_READY` line. An exec transport exit
code, inactivity alone, or a substring match is not evidence that drain succeeded.
Timeout or failure leaves admission blocked for explicit operator recovery.
`resume` reopens admission; it does not restart any old operation.
The listener is closed with the application, including startup failure cleanup.

## Browser API

Deployment drain blocks both new live and simulation sessions with
`503 deployment_in_progress`, without stopping the existing session.
`/api/config` reports temporary unavailability during drain.

All API routes require the configured owner identity. POST requests and the
events WebSocket require an allowed `Origin`. The health endpoint is public
and returns only `{status:"ok"}`.

- `GET /api/config`: `{liveAvailable, reason}`. Configured availability is not proof
  that the Azure account, deployment, or quota will accept a session.
- `GET /api/state` and read-only `WS /api/events`: `BrowserState`.
- `GET /api/experiment-config`: `{schemaVersion:1, settings, closeTimeoutMs, protocolSha256}`.
  `settings` is identical to the private export's settings. The lowercase SHA-256
  hashes the UTF-8 `JSON.stringify(sessionConfiguration(liveModel, backendModel))`
  actually used for session creation. It contains neither mode nor dynamic IDs.
  Use this owner-only, non-mutating route to pin and check deployed configuration
  before sending trial audio. It exposes no endpoint, identity, credential, or
  raw prompt. Deployment/model versions must still be recorded separately.
- `POST /api/simulation/start`: `{mode}` → state. Mode is `voice-only` or `cancel-actions`.
- `POST /api/command`: a strict `GameCommand` → `{result,state}`; simulation only.
- `POST /api/session`: `{mode,sdp}` → `{sdp,expiresAt}`. The server reserves the
  single session atomically and creates WebRTC, but does not attach sideband yet.
- `POST /api/session/ready`: `{}` → state. Call only after applying the answer,
  ICE/peer connection becoming `connected`, and the data channel becoming `open`.
  This attaches the server sideband and finishes setup. Keep browser microphone
  tracks disabled until this request succeeds. Duplicate ready requests return 409.
- `POST /api/session/close`: `{}` → state; closes either live or simulation.
- `POST /api/stop`: `{}` → state; emergency stop, including in-flight creation.
- `POST /api/activity`: `{offsetMs}` → `{ok:true}`. Optional live user/assistant audio-activity
  notification containing only an increasing finite offset in 0–600000 ms.

Close the previous session before switching modes. A closed run remains visible
to its owner; starting a new run resets it. Disconnecting the owner's last event
WebSocket stops the current run immediately. Reconnecting displays stopped state,
never replays commands. Clients should also close the session when their WebRTC
connection fails.

Pending creation/negotiation/attachment must finish within 45 seconds. Engine
actions are disabled until readiness completes. An SDP answer alone does not
mean live setup succeeded. The ten-minute deadline is local and requires no
`expires_at` field in the upstream creation response.

Sessions last at most ten minutes and close after 90 seconds without audio or processing
activity. At 75 seconds the existing `session.message` supplies an idle warning.
User and assistant transcript arrival, browser audio notifications, delegation
arrival, and backend response activity reset inactivity. Pending backend work
and queued/running game operations prevent idle closure. Transcript metadata is
only an activity signal, not a measurement of audible stopping. Browser
notifications and ongoing processing cannot extend the ten-minute absolute deadline.
The server polls the engine/state every 500 ms; this is separate from the
configurable movement step interval. A 1000 ms movement step keeps queued and
uncommitted movement observable during spoken corrections.
The configured interval is passed to the engine, so the first movement waits
for the full interval after admission, even if the run's polling cycle is older.
`tick()` is host-scheduled; the engine uses a run-relative monotonic clock, with
a captured wall-clock origin only for ISO expiry timestamps. Azure delegation
creation offsets are translated using the local HTTP creation-request start as
a conservative lower bound for the remote time origin. Network uncertainty can
reject a fresh event close to a cancellation barrier rather than admit stale
work. Invalid/stale/future offsets are explicitly rejected; missing offsets
after a cancellation are rejected, not silently treated as fresh.
This lower-bound argument assumes `offset_ms` measures delegation creation on
the timeline causally created by that same session request. The official event
example alone does not establish that origin; validate it against the service
before treating mapped offsets as verified experimental measurements.
Live run metadata explicitly marks `sourceOffsetsSynchronized: false`.
Use server-monotonic event times for server-observed receipt/queue/commit
intervals. Do not subtract mapped source offsets from registration times to
report transport or speech latency; the server performs no synchronized
cross-clock audio-latency measurement.

## Live behavior and privacy

Credentials stay on the server. No ephemeral key or Azure session ID is returned
to the browser. The configured endpoint is the only allowed upstream.
`session.start` is never sent on sideband. Both experiment modes have identical
voice/backend prompts, tools, and models; only the game engine policy differs.

Only nested completed function calls dispatch commands. The server registers the
outer delegation ID and preserves the function call ID. Tool results are returned
immediately when queued; they do not wait for motion. After all tool outputs in a
completed backend response, the server sends one `response.create`. Duplicate
completed calls do not execute or continue twice.

The server never logs or exports raw service errors, SDP, transcripts, credentials,
audio, or recordings. Only bounded timing metadata from transcript events can
appear in the state timeline; that is not proof of audible speech stopping.
Graceful close waits for `session.closed` and final usage. Timeout, disconnect, or
failed attachment records `final_usage_unconfirmed`; this does not assert that
remote billing stopped. Final usage is a last cumulative value, not a sum of updates.

## Optional private Blob exports

The application uses one configured Azure credential instance for live requests
and Blob exports. Production requires managed identity. It does not create a
container, grant roles, enable public access, issue SAS URLs, or write local result
files. Infrastructure must supply the existing private container, Blob data-plane
RBAC and private DNS/network connectivity. The standard Blob endpoint resolves
through the private network; it is never returned to the browser.

- `POST /api/exports {}`: owner and Origin required; only after the current run
  fully closes. Returns **201** `{runId, downloadPath}`. The path is an authenticated
  application route, not a Blob URL.
- `GET /api/exports/:runId`: owner-authenticated JSON attachment. The persisted
  owner is checked even when a different user owns the currently active run.
- `DELETE /api/exports/:runId`: owner and Origin required. Send `{}` with
  `Content-Type: application/json`; bodyless DELETE is accepted directly by the
  server but can be rejected by the deployed browser/proxy path.
  Returns **200** `{runId, deleted:true}`. Azure soft-delete/version retention may
  retain recoverable copies according to infrastructure policy.

The blob name is `experiments/{runId}.json` **inside the configured container**.
Run IDs must be UUIDs. An owner fingerprint is stored in Blob metadata, not in the
downloaded JSON. Conditional creation prevents overwrites; ETag conditions bind
reads/deletes to the ownership-checked version.

The versioned export contains source, redacted final game state/events, close/export
timestamps, voice-session cumulative usage status and model/pacing/time-limit settings.
`SOURCE_COMMIT` is included when configured. It omits free-text event details,
session messages, prompts, audio, transcript text, SDP, credentials, account names
and raw upstream payloads. Opaque operation/call/delegation correlation IDs and
bounded transcript timing metadata are retained; they are not synchronized audio
latency measurements. Voice usage does not imply complete backend-token billing.

Exports are capped at 2 MiB, 3,000 operations and 20,000 events, with explicit **413**
instead of silently truncating scientific results. Storage requests have a 15-second
abort deadline. Missing configuration returns **503** `export_not_configured`;
active/no closed run returns **409**; duplicate export returns **409**; missing
export returns **404**; a different persisted owner returns **403**. Storage failures
are sanitized error codes, never success-shaped responses or raw SDK errors.

Tests can inject `PrivateExportStore` through `buildApp(config, {exportStore})`.
Export storage must still be configured explicitly, so an injected store cannot
silently enable an unconfigured feature.

## Validation

From the repository root after workspace dependency installation and engine integration:

```text
node --test tests/server.test.ts tests/server-gateway.test.ts tests/server-exports.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js apps/server tests/server.test.ts tests/server-gateway.test.ts tests/server-exports.test.ts
```

Tests use fake credentials/HTTP and local WebSockets only, never live Azure calls.

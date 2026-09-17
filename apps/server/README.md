# Voice action lab server

Node 24, TypeScript source execution, Fastify. `buildApp(config, dependencies)`
creates an application without listening; `index.ts` starts it only when executed.
Dependencies are pinned in this workspace's package manifest. Install from the
repository root using its lockfile.
`@fastify/static` is pinned to 10.1.3 (Fastify 5.x compatible) for its path traversal
and noncanonical URL fixes; do not downgrade to the affected 8.x release.

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

**EasyAuth is a deployment trust boundary.** The application validates
`x-ms-client-principal`, but cannot independently authenticate this header.
The production ingress must require authenticated EasyAuth requests and prevent
direct access that bypasses the identity proxy or preserves forged identity headers.
Do not configure trusted-proxy mode on an unprotected public listener.

## Browser API

All API routes require the configured owner identity. POST requests and the
events WebSocket require an allowed `Origin`. The health endpoint is public
and returns only `{status:"ok"}`.

- `GET /api/config`: `{liveAvailable, reason}`. Configured availability is not proof
  that the Azure account, deployment, or quota will accept a session.
- `GET /api/state` and read-only `WS /api/events`: `BrowserState`.
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

**Private export is intentionally not implemented.** There is no export endpoint
and no filesystem result writer. Storage/export requires a separately reviewed
private destination outside the repository.

## Validation

From the repository root after workspace dependency installation and engine integration:

```text
node --test tests/server.test.ts tests/server-gateway.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js apps/server tests/server.test.ts tests/server-gateway.test.ts
```

Tests use fake credentials/HTTP and local WebSockets only, never live Azure calls.

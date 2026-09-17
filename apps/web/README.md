# Voice Action Lab frontend

Japanese React + TypeScript single-page client. All interface graphics are original inline SVG/CSS. No external fonts, assets, credentials, recordings, or run exports are included.

## Parent workspace integration

- Install dependencies from the root workspace. This package does not manage the root lockfile.
- Vite is pinned to **8.2.2**, the highest published stable version checked on 2026-09-17, rather than the `latest` tag pointing at `8.3.0-beta.1`. React and React DOM are pinned to **19.3.0**; `@vitejs/plugin-react` **6.1.1** supports Vite 8.
- TypeScript, Node types, and browser-test tooling come from the root workspace (`typescript`, `@types/node`, `@playwright/test`).
- Use the parent's Node 24 environment. No `VITE_*` variable or browser-side service credential is required; deployment/model/region configuration stays on the server.
- Run `npm run dev --workspace @voice-action-lab/web` for port **5173**.
- The Vite development server proxies `/api` HTTP and WebSocket traffic to **http://localhost:3001**.
- Run `npm run typecheck --workspace @voice-action-lab/web`, `npm run build --workspace @voice-action-lab/web`, and `npm test --workspace @voice-action-lab/web`.
- Run `npm run test:browser --workspace @voice-action-lab/web` after the parent installs dependencies and a Playwright browser is available. Tests own a temporary Vite server on port **5175** and mock every API/WebSocket interaction with synthetic fixtures; the application backend is not needed. Traces, video, and screenshots are disabled, and test output goes to the operating-system temporary directory, not the repository.
- `PLAYWRIGHT_CHANNEL=msedge` (or `chrome`) selects an already-installed browser instead of bundled Chromium. `PLAYWRIGHT_OUTPUT_DIR` optionally selects an explicit **outside-repository** temporary test output location.
- Build output is `apps/web/dist`. Production hosting must serve the built client and proxy the same-origin `/api` endpoints, including WebSocket upgrades. `vite preview` is not a production API proxy.

## Contract and server expectations

The client imports types from [the shared contract](../../packages/contracts/index.ts) without modifying it. HTTP responses and WebSocket snapshots are runtime-validated. Only the requested routes are used:

| Method | Route | Use |
| --- | --- | --- |
| GET | `/api/config` | Live availability and disabled-button reason |
| GET | `/api/state` | Initial and reconnected state |
| WebSocket | `/api/events` | Authoritative `BrowserState` snapshots |
| POST | `/api/simulation/start` | Explicit simulation start `{ mode }` |
| POST | `/api/command` | Simulation-only `GameCommand` |
| POST | `/api/stop` | Global stop `{}` |
| POST | `/api/session` | Server SDP exchange `{ mode, sdp }` |
| POST | `/api/session/ready` | Attach trusted server sideband after peer connection and datachannel open; `{}` returns `BrowserState` |
| POST | `/api/session/close` | Release the live session `{}` |

- Authentication is same-origin/server-managed. HTTP 401/403 are presented explicitly.
- Enforce single-session ownership, session expiry (at most ten minutes), and stale-start cancellation on the server too. A browser cannot guarantee network delivery or timers in a suspended/closed tab. Close must invalidate any in-progress SDP startup or sideband attachment even if its HTTP client timed out.
- `/api/session` must return the SDP answer without waiting for sideband attachment. Attaching before the browser peer connects can return 404 and deadlock the exchange. `/api/session/ready` performs that attachment later and must return an active live `BrowserState` in the selected mode on success.
- Stop is available during microphone permission, ICE gathering, SDP exchange, and sideband setup. The client disables/releases local media and aborts event waits immediately, then stops the game, waits for any in-flight SDP/ready request to settle, and closes the live server session. Failed server cleanup is visible and retryable.
- A reconnecting WebSocket is **not** proof that WebRTC recovered. State-feed loss disables commands/start and marks positions stale, but never fabricates a new game.
- `session.expiresAt` controls the visible countdown; starts also have a local ten-minute ceiling. The server remains responsible for the authoritative limit and idle handling.
- Optional future `session.idleWarning: string` is displayed verbatim as a warning if present. There is no invented idle endpoint or client activity upload.
- Event `kind` is preserved visibly. Basic categories recognize speech/audio/transcript, operation/move, cancel/interrupt, and commit names. Event timestamps are server-relative, not browser audio-stop measurements.

## Media lifecycle and recording

- Live startup order is strict: user gesture -> `getUserMedia` -> **disable the captured microphone track** -> add the track and `oai-events` -> local offer/description -> wait for **complete ICE gathering (8 seconds maximum)** -> send the final `localDescription.sdp` to `/api/session` -> apply the remote answer -> wait for **peer connected AND datachannel open (25 seconds maximum)** -> POST `/api/session/ready` `{}` -> validate active live `BrowserState` -> **enable the microphone**.
- Sideband attachment is triggered by native peer/datachannel readiness, not by waiting for a server-connected snapshot. A WebSocket snapshot alone cannot enable the microphone while `/api/session/ready` is pending. The ready request runs once per connection; failure or cancellation never enables the mic or switches to simulation.
- SDP HTTP exchange is bounded to 30 seconds; the ready HTTP request uses the normal 20-second API timeout. ICE/transport waits remove listeners/timers on completion, timeout, or disposal. A late ready response after stop is ignored, and server close follows that in-flight attachment.
- Incoming audio is played through an audio element from remote media tracks, never synthesized from JSON. Autoplay failures offer an explicit retry button.
- The first microphone device ID is reused for sequential A/B runs within the page. If that device disappears, connection fails explicitly rather than switching microphones.
- `session.*_transcript.delta` text is optional ephemeral UI only. It is bounded in memory and cleared for the next run; it is not an audio timing probe.
- Optional recording combines microphone and remote streams into a **local** `MediaStreamAudioDestinationNode`. It does not connect the microphone to speakers. Recording starts only with consent, stops on disconnect, and is bounded to 64 MB. Download is a browser blob URL created after stop; no recording/upload route exists.
- Audio, transcripts, and download URLs are not persisted across reloads. A pending recording download must be discarded before starting another recording.
- No browser analyser/audio-stop measurement claims are implemented. Parent-owned audio measurements/private exports can integrate separately.

## Validation

[API tests](src/api.test.ts) use explicitly synthetic fixtures only and Node's built-in runner. They cover contract validation, auth errors, malformed/network responses, exact request shapes, and absence of a live-error simulation fallback.

[WebRTC wait tests](src/webrtc.test.ts) use event targets and controlled timers to verify the exact eight-second gathering and twenty-five-second connection limits, both-state readiness, failure, and cancellation.

[Browser tests](tests/lab.spec.ts) cover source labelling, disabled live availability, sequential mode locking, authoritative positions, exact simulation replacement commands, invalid state, microphone denial, late permission after emergency stop, server expiry, optional idle warning, narrow viewport overflow, and reduced motion. Synthetic WebRTC cases verify fully gathered SDP, peer-plus-channel ordering, disabled microphone until sideband success, exact startup timeouts, failed/late sideband attachment, cancellation during gathering/SDP/ready, and reuse of the same microphone for sequential A/B startup.

These tests exercise client behavior with synthetic transports; they are **not** evidence of real audio quality, audible interruption, or Azure live integration. Real acceptance requires the parent-configured service, actual microphone permission, incoming media playback, and separate A/B runs. Validate protocol cancellation against server commits independently from actual audio-stop measurements; keep recordings and measurement exports outside the repository.

For the parent's standalone Chromium live probe, use the actual application on `http://localhost:5173` and the backend on port 3001, not `about:blank` or the mocked test harness on port 5175. Synthetic microphone media may replace physical input, but the real-integration probe must retain the native peer, actual SDP exchange, and actual backend/WebSocket routes. The regular browser suite intentionally mocks those boundaries and cannot validate ICE connectivity or the deployed model.

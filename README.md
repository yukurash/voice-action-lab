# Voice Action Lab

An experimental TypeScript project for comparing voice interruption with
application-level cancellation of pending actions.

## Public, no-Azure demo

**[Open the interactive demo](https://yukurash.github.io/voice-action-lab/)**

This GitHub Pages site reuses the experiment's cargo board, operation queue,
timeline and action engine. It runs entirely in the browser and is explicitly
labelled as an explanatory simulation, **not a recording or live experiment**.
Buttons stand in for already-interpreted commands; speech recognition, model
reasoning and audio interruption are not simulated.

Try **red to the right**, advance two steps, then **replace with blue**.
Mode A continues the red operation; mode B cancels its remaining steps before
moving blue. Committed positions are not rolled back. Manual steps advance a
synthetic clock by three seconds; optional automatic progression advances one
step every three seconds. Emergency stop affects both modes; changing modes or
resetting starts a fresh, empty demo.

The public bundle contains no microphone/recording code, Azure client, backend
connection, exported run data, audio, transcripts or article content. State
exists only in the current tab's memory. A restrictive CSP disables network
connections and media. The authenticated cloud application is a separate build;
its default behavior and access restrictions are unchanged.

```powershell
npm run build:demo
npm run preview:demo --workspace @voice-action-lab/web
# Open http://127.0.0.1:5176/voice-action-lab/
npm run test:demo --workspace @voice-action-lab/web
```

`vite.demo.config.ts` uses a separate entry point, excludes the normal public
directory and rejects live-client/server modules in the runtime dependency
graph. Only `apps/web/dist/demo` is published by the Pages workflow after the
main-branch CI succeeds. The built-site tests use the actual project subpath,
block microphone/audio/WebRTC/backend access, and verify both cancellation
policies, reset/stop, pacing, offline operation and a mobile viewport.

## Status

The browser application and server are implemented. A real-service smoke test
has exercised the UI connection button, synthetic Japanese microphone input,
GPT-Live delegation, backend tool calls, paced game movement, incoming audio,
and normal shutdown. The owner-only cloud app is deployed; private run
export/download/delete is verified. Formal experiment data stays private and
is not shipped with the public demo.
Simulated results must never be presented as live-service measurements.

## Intended scope

- A small browser scene with a cart and two cargo colors.
- The same voice model and configuration in both comparison modes.
- Separate observation of speech, requested actions, and committed movement.
- An authenticated, owner-only Azure deployment.

## Action engine

[GameEngine](packages/game-engine/index.ts) has no internal timers. The host
registers each delegation and calls `tick()` to commit at most one movement
step. Every clock value and optional creation offset uses the same monotonic,
run-relative time basis.

In `voice-only`, cancellation is observed without removing pending operations.
In `cancel-actions`, cancellation invalidates the prior epoch and cancels
uncommitted work. Replacement performs cancellation and enqueues its new action
atomically. Already committed positions are never rolled back. Call IDs are
deduplicated, conflicting retries are rejected, and terminal stop cannot be
reversed by late results. Exact retries return historical receipts, not a new
execution or a claim about the operation's current state.

## Experiment primitives

[Experiment utilities](packages/experiments/index.ts) build a seeded schedule of
five scenarios, ten repetitions, and both modes: 100 planned slots. Adjacent
pairs are counterbalanced with five A-first and five B-first pairs per scenario.
Reports retain failed and not-run slots instead of dropping them.

Action metrics consume the complete event history and distinguish ignored
intent, accepted cancellation, pending targets, and steps after that acceptance.
Emergency cleanup is not semantic cancellation. Exact idempotent replays have
no distinct engine event and are reported as unobservable, not as zero.
These utilities do not infer speech timing from action or transcript events.

The output-path guard requires an absolute repository-external path and checks
existing ancestors and symlinks. It does not create files or provide a filesystem
concurrency lock. Actual run data must remain outside this checkout.

## Running a private experiment

The [runner](scripts/run-experiments.ts) and [analyzer](scripts/analyze-experiments.ts)
extend those primitives with a fixed manifest, exclusive run lock, atomic result
files, PCM evidence hashes, and resume without replaying started slots. They are
operator tools, not public HTTP batch endpoints. CI uses synthetic evidence only.

Before running:

1. Use the approved Azure CLI owner login and explicit subscription, tenant and
   app authentication client IDs. Never put an access token in arguments/files.
2. Generate the fixed Japanese WAV fixtures with the
   [fixture generator](scripts/generate-fixtures.ts), outside the repository.
   Retain its manifest and verify hashes rather than substituting new recordings.
3. Check out the exact source commit deployed to the owner-only app. Use the
   [operator health proof](packages/deployment/README.md) to verify the immutable
   image and source, and freeze automatic deployment for the entire experiment.
   The runner checks `/api/experiment-config` before the batch, before each trial,
   and after ready but before input. **The supplied image digest is an operator
   assertion; the runner does not independently query ARM for it.**
4. Choose a new absolute output directory outside the checkout. Keep all files
   there, including failure evidence. On Windows the browser helper uses installed
   Microsoft Edge; elsewhere it uses Playwright Chromium. `PLAYWRIGHT_CHANNEL`
   may select another installed supported channel; do not change it mid-batch.

The bearer-authenticated browser harness explicitly fetches the same-origin,
hashed, self-contained worklet bundle through its authenticated page connection,
then loads the unchanged bytes from a short-lived in-memory Blob URL. Direct
worklet module requests can bypass Playwright's page-level extra headers. The
bridge accepts only the measurement asset path, HTTP 200 and a JavaScript MIME
type, with a five-second/256-KiB bound; it forbids redirects and external origins.
It does not persist or embed a bearer token, alter server authentication, replace
the PCM processor, or mock WebRTC/model traffic. Ordinary browser UI loading is
unchanged. A CSP that forbids Blob worklets fails explicitly; the harness does not
weaken it. Use the built client for these bearer-authenticated experiments.

Example PowerShell arguments (replace every placeholder):

```powershell
$experiment = @(
  '--origin', 'https://<owner-only-app-host>',
  '--subscription', '<subscription-guid>',
  '--tenant', '<tenant-guid>',
  '--auth-client-id', '<application-client-guid>',
  '--source-commit', '<deployed-full-commit>',
  '--image-digest', 'sha256:<verified-64-hex-digest>',
  '--fixtures', 'C:\private-inputs\audio\manifest.json',
  '--out', 'C:\private-results\experiment-001',
  '--seed', '12345',
  '--formal'
)
node .\scripts\run-experiments.ts @experiment
node .\scripts\run-experiments.ts @experiment --execute
node .\scripts\analyze-experiments.ts --run 'C:\private-results\experiment-001' --report 'analysis-001.json'
```

Without `--execute`, the CLI reports **not executed** and does not authenticate,
launch a browser or call a model. This is argument/path checking, not proof that
the fixtures, deployment or service are usable. For a diagnostic pilot, replace
`--formal` with `--limit 2` and use a different output directory; a pilot is not a
formal 100-trial result.

Formal runs have five scenarios, ten paired repetitions and both modes, processed
sequentially with a 180-second per-trial bound. Normal runs observe 45 seconds
after the first clip. Cancel, replacement and backchannel wait up to 30 seconds
for fresh received-PCM activity before the second clip, then observe 45 seconds.
Boundary trials instead inject the brief cancel on the first observation of
red at x >= 5 with pending work: they do **not** require simultaneous speech.
Lack of audio overlap makes the audio metric missing, not the action boundary
invalid.

The [PCM contract](apps/web/README.md) uses one measurement clock and fixed
20-ms/-45-dBFS/3-on/6-off windows. Pauses, forward frame gaps and unobserved stops
must not turn into apparent zero-latency successes. Audio metrics carry missing
reasons; action observations and final voice-usage confirmation are reported
separately. An unconfirmed usage total is neither zero cost nor evidence that an
otherwise observed action goal failed. Reports retain all 100 planned slots.

AudioContext/performance anchor offsets can vary during a valid capture. Their
full observed min/max envelope is used only to attribute a measured onset to a
fixture: the entire interval must fit within that fixture. The envelope width is
retained as `anchorOffsetSpreadMs`; it is not added to, or subtracted from, the
same-context audio duration. Ambiguous attribution remains missing. Backwards
clocks, future anchors and inconsistent sample sequences are still invalid.
The live activity gate uses the latest sample's paired clocks and delivery age,
not an old offset from the beginning of the run.

`goalMet` means conformance to the predefined **mode-specific** scenario rule.
For example, the A cancellation rule expects an ignored intent and completed red
movement, whereas B expects cancellation of pending work with no subsequent
target steps. It is not a shared user-intent success rate or a model-quality
score. Compare the recorded cancellation counts, pending targets and committed
steps separately. The driver waits for the actual browser microphone/peer before
input and for completion of the UI's close flow before reporting release.

Resume with the **same arguments and output** plus `--execute --resume`.
Started slots are never retried merely because they failed or the process crashed.
A leftover lock is not automatically stolen: first prove the old process is gone
and the service is idle before an operator removes that exact lock. Configuration
drift is a stop condition, not permission to silently update the manifest.
The analyzer checks evidence hashes and recomputes PCM metrics; use a new report
filename rather than overwriting an existing analysis.

## Public repository boundary

This repository is for application code, tests, infrastructure templates, and
reproduction instructions. Article drafts, actual experiment results, recordings,
transcripts, local credentials, and article media belong outside the repository.

## Development

Use Node.js 24 and install the locked development dependencies:

```sh
npm ci
npm run verify
```

`verify` checks the Git index for disallowed public files and credential
signatures, type-checks the server and client, runs ESLint and unit tests, and
builds the browser application. Unit tests do not validate a live model.
CI runs them on Linux and Windows; the required aggregate check is named `ci`.
CI also compiles every Bicep template and runs the synthetic browser regression
suite without Azure credentials. The required `ci` gate includes these jobs.

For local simulation, set `AUTH_MODE=dev`, bind the server to loopback, and allow
the exact browser origins in `ALLOWED_ORIGINS`. Start `npm start` and, in another
terminal, `npm run dev --workspace @voice-action-lab/web`. The server uses port
3000; Vite uses 5173. Live mode is off by default and must be explicitly configured.
See the [server configuration](apps/server/README.md) and
[client lifecycle](apps/web/README.md). Keep actual environment files outside Git.

## Azure infrastructure

- [Foundry](infra/foundry.bicep): dedicated keyless account and pinned voice and
  reasoning model deployments. Deployment versions must exist in the selected
  region; a model catalog page alone is not deployment evidence.
- [Foundation](infra/foundation.bicep): a dedicated Container Apps environment,
  private registry, runtime and publishing identities, private Blob container,
  and Key Vault. GitHub OIDC is restricted to the repository's `production`
  environment, which must itself restrict deployments to `main`.
- [Speech](infra/speech.bicep): a separate keyless Speech resource and narrowly
  scoped authorization for generating synthetic input fixtures.
- [Authentication secret](infra/auth-secret.bicep): ARM secure-string input for
  initializing the private vault; never pass its value on a command line or
  publish it in deployment outputs.

The cloud `experiments` container is not public, disallows shared-key access,
and expires cloud copies after 30 days. Keep any required long-lived results
outside this repository. The registry has no admin password or anonymous pull.
Azure RBAC is scoped to this project's resources, not the subscription.
Blob Storage and Key Vault use Private Link and private DNS in the app's virtual
network. Their public data-plane access stays disabled, including for the owner.
Do not weaken a subscription's network policy to make local data access work.

[Application deployment](infra/app.bicep) initially keeps ingress internal.
Verify EasyAuth, its owner-only identity policy, and readiness before setting
`externalIngress=true`. The image is selected by digest, not a mutable tag.
The [container build](Dockerfile) uses a pinned Node image and a non-root runtime.

The [publishing workflow](.github/workflows/deploy.yml) accepts only successful
`ci` commits reachable from `main`. Its `production` environment must allow only
`main`. Configure `AZURE_PUBLISHER_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `AZURE_REGISTRY_NAME`, `AZURE_RESOURCE_GROUP`, and
`AZURE_CONTAINER_APP` as environment variables, not secret values in code.
Keep the repository-level `AZURE_DEPLOY_ENABLED` variable `false` during bootstrap;
enable it only after the owner-only app is verified. No personal access token or
long-lived Azure credential is copied into Actions. Automated releases use
loopback drain and verified runtime health, and drain the current ready revision
again before rollback. See the [operator and recovery contract](packages/deployment/README.md).
Bootstrap the health helper before enabling automatic deployment, and freeze
releases throughout a measurement batch.
Set the foundation's `githubSubject` to the exact issued OIDC subject. Newer
GitHub subjects can include immutable owner and repository IDs; a legacy
name-only trust entry will not match those claims. Preserve the stronger claim
rather than changing GitHub to a weaker subject format.

If EasyAuth accepts a login but the API rejects its principal schema, the server
logs only known field names, shape flags, and a bounded provider category. It
does not log the principal, claim values, authorization headers, or tokens.
Container Apps can use `Bearer` or `AuthenticationTypes.Federation` as the
identity's `auth_typ`; that field is not always the provider name. These formats
require the trusted `X-MS-CLIENT-PRINCIPAL-IDP: aad` header, and the tenant and
owner object-ID checks still apply. The legacy `auth_typ: aad` format is retained.
Automated clients use a scoped Entra bearer token containing `tid` and `oid`.
A compact client-directed sign-in token can omit these claims and is therefore
rejected; an authenticated display name or opaque session ID is not an owner
authorization substitute.

The Entra login credential has the tenant's permitted lifetime and must be
rotated before expiry. Model and storage data access use managed identity, not
that login credential.
See [deployment and credential lifecycle](infra/README.md) for bootstrap
boundaries, private parameter handling, and overlapping login-secret rotation.

WebRTC setup must gather ICE candidates and apply the SDP answer before the
server attaches the Live sideband. Attaching before the browser connects can
return HTTP 404. Do not wait for sideband attachment before returning the SDP
answer. Do not infer that the primary WebSocket endpoint works merely because
the WebRTC and sideband paths work.

## Git and publication checks

Before committing or pushing, verify the active GitHub account, the actual Git
author and committer identities, and the HTTPS push remote:

```sh
npm run check:identity
```

The public-source check reads staged blobs, not just the working files. It
rejects private artifact paths, generated data, symlinks, submodules, and known
credential signatures. It is a defense in depth, not a substitute for reviewing
the staged diff. Untracked files are not certified by this check.

Do not put private material in this directory, even if it is ignored. A sibling
directory with no Git repository should hold private experiment and writing
artifacts. Do not upload that material to public Actions artifacts or PRs.

## License

MIT. See [LICENSE](LICENSE).

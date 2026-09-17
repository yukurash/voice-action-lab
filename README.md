# Voice Action Lab

An experimental TypeScript project for comparing voice interruption with
application-level cancellation of pending actions.

## Status

The browser application and server are implemented. A real-service smoke test
has exercised the UI connection button, synthetic Japanese microphone input,
GPT-Live delegation, backend tool calls, paced game movement, incoming audio,
and normal shutdown. The owner-only cloud app and formal A/B experiment are
still being prepared.
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
long-lived Azure credential is copied into Actions. Active sessions can be
interrupted by a deployment; freeze releases during a measurement batch.

The Entra login credential has the tenant's permitted lifetime and must be
rotated before expiry. Model and storage data access use managed identity, not
that login credential.

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

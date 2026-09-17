# Voice Action Lab

An experimental TypeScript project for comparing voice interruption with
application-level cancellation of pending actions.

## Status

Application implementation is in progress. GPT-Live-1 deployment, WebRTC audio
output, server-side control, and normal session closure have been smoke-tested
on Azure. This is not yet a completed interactive demo or an A/B experiment.
Simulated results must never be presented as live-service measurements.

## Intended scope

- A small browser scene with a cart and two cargo colors.
- The same voice model and configuration in both comparison modes.
- Separate observation of speech, requested actions, and committed movement.
- An authenticated, owner-only Azure deployment.

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
signatures, type-checks the TypeScript tooling, runs ESLint, builds it, and runs
the tooling tests. These checks do not validate a voice model or a deployed app.
CI runs them on Linux and Windows; the required aggregate check is named `ci`.
CI also compiles every Bicep template without Azure credentials.

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

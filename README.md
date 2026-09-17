# Voice Action Lab

An experimental TypeScript project for comparing voice interruption with
application-level cancellation of pending actions.

## Status

Repository and development workflow setup only. GPT-Live-1 availability has not
been verified in the intended Azure environment. No live voice demo is deployed,
and simulated results must not be presented as live-service measurements.

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

# Noninteractive Azure maintenance

[Operator CLI](../../scripts/maintenance-azure.ts) uses the existing Azure CLI
login through `AzureCliCredential`, with explicit subscription and tenant IDs.
It checks the token tenant before ARM access and never changes the default Azure
CLI context. Use an operator identity with existing Container Apps read/exec
permissions; this tool does not grant roles or change authentication settings.
The SDK receives only the subscription selector; the returned token's tenant
must match the separately required tenant. Azure CLI rejects simultaneous
subscription and tenant switches during token acquisition.

Generic PowerShell example (replace placeholders):

```powershell
node scripts\maintenance-azure.ts health --subscription "<subscription-guid>" --tenant "<tenant-guid>" --resource-group "example-rg" --app "example-app" --revision "example-app--release" --expected-image "registry.example/lab:release" --expected-source-commit "<full-commit>"
```

Only `drain`, `resume`, `status`, and `health` are accepted. Subscription, tenant,
resource group, and app are required; there are no ambient target defaults,
arbitrary commands, TTY input, automatic retries, or automatic resume.
`--revision` asserts the current `latestReadyRevisionName`, rather than selecting
an arbitrary old revision. `--expected-image` checks that revision's template,
not the application's potentially newer, unready template.
`--expected-source-commit` is an optional health-only equality check.

## Scope and result proofs

- Azure Public Cloud only, ARM API `2025-01-01`, single active-revision mode,
  exactly one declared application container (no init containers), and exactly
  one ready, started, running replica. The platform-injected `http-auth` replica
  sidecar is allowed only alongside that application and must itself be healthy;
  extra declared workloads and unknown sidecars are rejected.
  Multiple replicas/revisions are not a supported drain strategy.
- The regional exec origin must exactly match the app's canonical location
  (for example, `South India` becomes `southindia.azurecontainerapps.dev`).
  ARM and WebSocket redirects are forbidden. Returned paths/query strings are
  not reused; the exec path is constructed from the validated target.
- `drain` runs the existing [maintenance client](./client.ts). Success requires
  validated `{"draining":true,"active":false}` followed by the exact standalone
  `VOICE_ACTION_LAB_DRAIN_READY` line. It does not force-stop an existing run.
- `resume` requires exactly two boolean fields, `draining` and `active`, with
  `draining:false`. `status` reports those two fields without interpreting an
  active run as an error.
- `health` runs [the runtime helper](./health.ts), requiring HTTP 200, JSON content
  type, and exactly `{"status":"ok"}` from
  `http://127.0.0.1:3000/health/live`. `SOURCE_COMMIT` must be a full 40/64-character
  hexadecimal commit, normalized to lowercase. Validated metadata plus the exact
  `VOICE_ACTION_LAB_HEALTH_READY` line are required. `/health`, SPA HTML, ingress
  reachability, and authenticated application APIs are not used as health proof.
- Proof initiates a clean WebSocket close; queued stderr, proxy errors, malformed
  frames, contradictory output, abnormal close, or absent close acknowledgement
  still fail. An exec close/exit alone is never proof.

Success writes one JSON line containing `action`, `revision`, `image`, `replica`,
`container`, and either `state:{draining,active}` or `health:"ok",sourceCommit`.
Failure writes only `{"error":"<fixed-code>"}` to stderr and no success line.
Exit codes: 0 verified, 1 failed/uncertain, 2 invalid arguments. No ARM payload,
exec URL, token, or raw remote output is logged or persisted.

Overall deadline: drain 675 seconds; other actions 30 seconds. Credential process
and WS handshake: 10 seconds each; each ARM request, runtime loopback request,
and close acknowledgement: 5 seconds. ARM bodies are capped at 256 KiB; WS
messages at 16 KiB and cumulative output (including info frames) at 64 KiB.
These deadlines are not additional to the overall budget.

A failed or timed-out drain may already have closed admission. Do not infer
rollback or retry a mutation blindly; inspect `status` on the pinned target and
explicitly decide whether to `resume`. Discovery/health describe one observed
revision and configured commit, not a guarantee against another deployment racing
after the check or cryptographic attestation of image contents.

No runtime requests occur merely by importing either module. Workflow wiring,
image publication (including the new helper), permissions, and live acceptance are
separate operator/integration steps. Tests use synthetic ARM responses and
isolated ephemeral loopback servers, never a real application's maintenance port.

Protocol references:
[official Azure CLI exec framing](https://github.com/Azure/azure-cli/blob/dev/src/azure-cli/azure/cli/command_modules/containerapp/_ssh_utils.py),
[ARM replica API](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps-revision-replicas/list-replicas?view=rest-resource-manager-containerapps-2025-01-01).

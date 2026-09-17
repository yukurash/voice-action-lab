# Deployment and credential lifecycle

These templates target a dedicated resource group. Keep real parameter values,
application IDs, tenant IDs, credential metadata, and compiled deployment
requests outside the public repository.

## Application bootstrap

Use a digest published from a required-CI-successful commit on `main`. Supply
`registryName`, `storageAccountName`, `vaultName`, `foundryEndpoint`,
`authClientId`, `ownerObjectId`, and the 64-character `imageDigest` to
[app.bicep](app.bicep). The default movement interval is 3000 ms in both modes.
The runtime enables loopback maintenance on port 3001; only port 3000 is ingress.

Initially leave `externalIngress=false`. Verify the identity proxy, exact
tenant/object-ID allowlist, readiness, and image before enabling external TLS
ingress. When migrating a pre-maintenance image, arrange an owner-controlled
idle window first. That one-time bootstrap is not an atomic drain guarantee.
Subsequent releases must verify drain through the container operator channel.
Never give the publishing identity access to the owner's browser API as a
shortcut around deployment coordination.

The template intentionally returns HTTP 401 for unauthenticated application
requests. For interactive sign-in, open
`https://<app-host>/.auth/login/aad?post_login_redirect_uri=/` first. That
platform-owned route redirects to Entra and returns to the app after the owner's
login. A direct bearer-token API test does not replace this interactive login
step, and no publishing identity is added to the browser-owner allowlist.

Freeze automatic deployment during a measurement batch and pin its source,
digest, model versions, and configuration separately. A successful image build
alone does not prove a healthy or authenticated deployment.

## Login credential rotation

Managed identity handles model, Blob, registry, and vault access. The Entra web
login's client secret is a separate credential. Track its Graph credential
`keyId`, expiry, and vault secret URI in private operator records. Do not wait
for expiry or assume a tenant permits the default credential lifetime.

Perform rotation outside live sessions and formal experiments:

1. Verify that the operator is in the intended tenant and subscription. Use an
   owner-authorized operator, not the narrowly scoped GitHub publishing identity.
   Record the current credential key ID without retrieving or displaying its
   secret value. Disable automatic application releases for the maintenance
   window.
2. Add a new password credential to the existing Entra application, with an
   expiry shorter than the tenant's maximum lifetime. For a 30-day policy, use
   at most 29 days. Keep the old credential during the overlap.
3. Keep the returned `secretText` only in process memory. Submit it as the
   `clientSecret` **secure-string template parameter** in an authenticated
   HTTPS ARM deployment request using [auth-secret.bicep](auth-secret.bicep).
   Supply the matching Unix expiry seconds as `expiresOn`. Do not put the
   value in an `az` argument, environment variable, parameter file, shell
   transcript, deployment output, or log. Do not enable verbose HTTP logging.
   If this step fails, keep the old credential usable. Remove the new
   credential only after proving the vault update was not applied. A timeout
   can have an ambiguous outcome: retain both credentials and inspect the ARM
   operation and secret-version metadata rather than revoking a credential
   that may already be referenced.
4. Confirm the deployment succeeded and the expected secret metadata exists.
   The application's reference is versionless. Container Apps checks for new
   versions within 30 minutes; revisions referencing secrets in environment
   variables can restart during refresh. A code-deployment freeze does not
   freeze secret refresh. Do not run measurements during this window.
5. Verify a **fresh interactive OAuth login** and the owner-authenticated API.
   An existing browser cookie or direct API bearer-token test does not prove
   that the new login client secret works. MFA or consent must be completed
   by the owner; do not bypass it. Keep the old credential if fresh login
   cannot yet be verified.
6. After refresh, successful fresh login, and a safe overlap, remove only the
   old Graph password credential by its exact key ID. Record the new key ID
   and expiry privately, check owner rejection rules, and reopen admission.

Never turn on vault public networking or shared keys to perform rotation.
Use the secure ARM bootstrap path or an authorized operator within the private
network. Never remove every application credential as a cleanup shortcut.

References:
- [Container Apps secrets and Key Vault references](https://learn.microsoft.com/azure/container-apps/manage-secrets)
- [Microsoft Graph application addPassword](https://learn.microsoft.com/graph/api/application-addpassword)
- [Microsoft Graph application removePassword](https://learn.microsoft.com/graph/api/application-removepassword)

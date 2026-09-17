import { AzureCliCredential, ManagedIdentityCredential } from "@azure/identity";
import type { ServerConfig } from "./config.ts";

export function createCredential(config: ServerConfig): AzureCliCredential | ManagedIdentityCredential {
  return config.credentialMode === "managed-identity"
    ? new ManagedIdentityCredential(config.managedIdentityClientId ? { clientId: config.managedIdentityClientId } : {})
    : new AzureCliCredential(config.credentialTenantId ? { tenantId: config.credentialTenantId } : {});
}

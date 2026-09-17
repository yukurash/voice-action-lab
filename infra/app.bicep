targetScope = 'resourceGroup'

param location string = resourceGroup().location
param appName string = 'voice-action-lab'
param environmentName string = 'voice-action-lab-secure-env'
param registryName string
param storageAccountName string
param vaultName string
param foundryEndpoint string
param authClientId string
param ownerObjectId string
@description('Optional additional OAuth client ID for owner-authenticated API testing. The owner principal allowlist remains required.')
param additionalAuthClientId string = ''
param tenantId string = subscription().tenantId
param externalIngress bool = false
@minValue(100)
@maxValue(5000)
param stepIntervalMs int = 3000
@minLength(64)
@maxLength(64)
param imageDigest string

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: environmentName
}
resource runtime 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: 'voice-action-lab-runtime'
}
resource publisher 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: 'voice-action-lab-publisher'
}
resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: registryName
}
resource vault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: vaultName
}

var publicOrigin = 'https://${appName}.${environment.properties.defaultDomain}'

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${runtime.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 5
      ingress: {
        external: externalIngress
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [{ server: registry.properties.loginServer, identity: runtime.id }]
      secrets: [{
        name: 'easyauth-client-secret'
        keyVaultUrl: '${vault.properties.vaultUri}secrets/easyauth-client-secret'
        identity: runtime.id
      }]
    }
    template: {
      containers: [{
        name: 'app'
        image: '${registry.properties.loginServer}/voice-action-lab@sha256:${imageDigest}'
        resources: { cpu: 1, memory: '2Gi' }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'HOST', value: '0.0.0.0' }
          { name: 'PORT', value: '3000' }
          { name: 'MAINTENANCE_PORT', value: '3001' }
          { name: 'CLOSE_TIMEOUT_MS', value: '8000' }
          { name: 'AUTH_MODE', value: 'easyauth' }
          { name: 'TRUST_EASYAUTH_PROXY', value: 'true' }
          { name: 'ALLOWED_TENANT_ID', value: tenantId }
          { name: 'ALLOWED_OBJECT_IDS', value: ownerObjectId }
          { name: 'ALLOWED_ORIGINS', value: publicOrigin }
          { name: 'LIVE_ENABLED', value: 'true' }
          { name: 'AZURE_OPENAI_ENDPOINT', value: foundryEndpoint }
          { name: 'AZURE_LIVE_MODEL', value: 'gpt-live-1' }
          { name: 'AZURE_BACKEND_MODEL', value: 'gpt-5.5' }
          { name: 'AZURE_CREDENTIAL_MODE', value: 'managed-identity' }
          { name: 'AZURE_CLIENT_ID', value: runtime.properties.clientId }
          { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storageAccountName }
          { name: 'AZURE_STORAGE_CONTAINER', value: 'experiments' }
          { name: 'STATIC_DIRECTORY', value: '/app/apps/web/dist' }
          { name: 'STEP_INTERVAL_MS', value: string(stepIntervalMs) }
        ]
        probes: [
          { type: 'Startup', tcpSocket: { port: 3000 }, periodSeconds: 2, failureThreshold: 60 }
          { type: 'Readiness', tcpSocket: { port: 3000 }, periodSeconds: 5 }
          { type: 'Liveness', tcpSocket: { port: 3000 }, periodSeconds: 10 }
        ]
      }]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

resource auth 'Microsoft.App/containerApps/authConfigs@2025-01-01' = {
  parent: app
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
    }
    httpSettings: { requireHttps: true }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: authClientId
          clientSecretSettingName: 'easyauth-client-secret'
          openIdIssuer: '${az.environment().authentication.loginEndpoint}${tenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [authClientId, 'api://${authClientId}']
          defaultAuthorizationPolicy: {
            allowedApplications: empty(additionalAuthClientId) ? [authClientId] : [authClientId, additionalAuthClientId]
            allowedPrincipals: { identities: [ownerObjectId] }
          }
        }
      }
    }
  }
}

resource deploymentPermission 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(app.id, publisher.id, 'ContainerAppsContributor')
  scope: app
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '358470bc-b998-42bd-ab17-a7e34c199c0f')
    principalId: publisher.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource identityAssignmentPermission 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(runtime.id, publisher.id, 'ManagedIdentityOperator')
  scope: runtime
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'f1a07417-d97a-45cb-824c-7a7467783830')
    principalId: publisher.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output appUrl string = publicOrigin
output actualIngressHostname string = app.properties.configuration.ingress.fqdn

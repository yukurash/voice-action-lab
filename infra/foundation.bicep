targetScope = 'resourceGroup'

param location string = resourceGroup().location
param namePrefix string = 'voice-action-lab'
param foundryAccountName string
param operatorObjectId string
@description('Exact GitHub OIDC subject, including immutable owner/repository IDs when emitted. Read the token claim from the workflow; do not weaken it to a legacy name-only subject.')
param githubSubject string

var suffix = uniqueString(resourceGroup().id)
var tags = {
  project: 'voice-action-lab'
  audience: 'owner-only'
  content: 'private-experiments'
}

resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: foundryAccountName
}

resource runtime 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${namePrefix}-runtime'
  location: location
  tags: tags
}

resource publisher 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${namePrefix}-publisher'
  location: location
  tags: tags
}

resource federation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = {
  parent: publisher
  name: 'github-production'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: githubSubject
    audiences: ['api://AzureADTokenExchange']
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: 'valab${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
    roleAssignmentMode: 'LegacyRegistryPermissions'
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, runtime.id, 'AcrPull')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: runtime.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource acrPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, publisher.id, 'AcrPush')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8311e382-0749-4cb8-b61a-304f252e45ec')
    principalId: publisher.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource modelUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, runtime.id, 'OpenAIUser')
  scope: foundry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
    principalId: runtime.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: 'valab${suffix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Disabled'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = {
  parent: storage
  name: 'default'
}

resource experiments 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = {
  parent: blobService
  name: 'experiments'
  properties: { publicAccess: 'None' }
}

resource blobWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(experiments.id, runtime.id, 'BlobDataContributor')
  scope: experiments
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: runtime.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource blobOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(experiments.id, operatorObjectId, 'BlobDataContributor')
  scope: experiments
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: operatorObjectId
    principalType: 'User'
  }
}

resource retention 'Microsoft.Storage/storageAccounts/managementPolicies@2025-01-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [{
        name: 'expire-private-cloud-copies'
        enabled: true
        type: 'Lifecycle'
        definition: {
          filters: { blobTypes: ['blockBlob'], prefixMatch: ['experiments/'] }
          actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } } }
        }
      }]
    }
  }
}

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: 'valab-${suffix}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Disabled'
  }
}

resource secretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, runtime.id, 'SecretsUser')
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: runtime.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource secretOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, operatorObjectId, 'SecretsOfficer')
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
    principalId: operatorObjectId
    principalType: 'User'
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: '${namePrefix}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${namePrefix}-network'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.213.0.0/16'] }
    subnets: [
      {
        name: 'infrastructure'
        properties: {
          addressPrefix: '10.213.0.0/23'
          delegations: [{
            name: 'container-apps'
            properties: { serviceName: 'Microsoft.App/environments' }
          }]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: '10.213.2.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource infrastructureSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: network
  name: 'infrastructure'
}

resource endpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: network
  name: 'private-endpoints'
}

var privateServices = [
  { name: 'blob', id: storage.id, zone: 'privatelink.blob.${az.environment().suffixes.storage}' }
  { name: 'vault', id: vault.id, zone: 'privatelink.vaultcore.azure.net' }
]

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for service in privateServices: {
  name: service.zone
  location: 'global'
  tags: tags
}]

resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (service, i) in privateServices: {
  parent: zones[i]
  name: namePrefix
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: network.id }
  }
}]

resource endpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [for service in privateServices: {
  name: '${namePrefix}-${service.name}'
  location: location
  tags: tags
  properties: {
    subnet: { id: endpointSubnet.id }
    privateLinkServiceConnections: [{
      name: service.name
      properties: {
        privateLinkServiceId: service.id
        groupIds: [service.name]
      }
    }]
  }
}]

resource zoneGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (service, i) in privateServices: {
  parent: endpoints[i]
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [{
      name: service.name
      properties: { privateDnsZoneId: zones[i].id }
    }]
  }
}]

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${namePrefix}-secure-env'
  location: location
  tags: tags
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: infrastructureSubnet.id
      internal: false
    }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output storageAccountName string = storage.name
output vaultUri string = vault.properties.vaultUri
output environmentId string = environment.id
output environmentDomain string = environment.properties.defaultDomain
output runtimeIdentityId string = runtime.id
output runtimeClientId string = runtime.properties.clientId
output publisherIdentityId string = publisher.id
output publisherClientId string = publisher.properties.clientId
output publisherPrincipalId string = publisher.properties.principalId

targetScope = 'resourceGroup'

@minLength(3)
@maxLength(64)
param accountName string

param location string = resourceGroup().location

@description('Existing operator object ID in the deployment tenant. Empty skips the assignment.')
param operatorObjectId string = ''

param liveModelVersion string = '2026-09-10'
param backendModelVersion string = '2026-04-24'

@minValue(1)
param liveCapacity int = 1

@minValue(1)
param backendCapacity int = 100

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: accountName
  location: location
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: accountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    allowProjectManagement: true
  }
  tags: {
    application: 'voice-action-lab'
  }
}

resource live 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: account
  name: 'gpt-live-1'
  // The provider serializes deployment writes on the parent account.
  dependsOn: [
    backend
  ]
  sku: {
    name: 'GlobalStandard'
    capacity: liveCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-live-1'
      version: liveModelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

resource backend 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: account
  name: 'gpt-5.5'
  sku: {
    name: 'GlobalStandard'
    capacity: backendCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5.5'
      version: backendModelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

var openAiUserRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
)

resource operatorAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(operatorObjectId)) {
  name: guid(account.id, operatorObjectId, openAiUserRole)
  scope: account
  properties: {
    principalId: operatorObjectId
    principalType: 'User'
    roleDefinitionId: openAiUserRole
  }
}

output accountResourceId string = account.id
output openAiEndpoint string = account.properties.endpoints['OpenAI Language Model Instance API']
output liveDeployment string = live.name
output backendDeployment string = backend.name

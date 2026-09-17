targetScope = 'resourceGroup'

param location string = 'japaneast'
param operatorObjectId string

resource speech 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: 'voice-action-lab-speech'
  location: location
  kind: 'SpeechServices'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: 'valabspeech${uniqueString(resourceGroup().id)}'
    disableLocalAuth: true
  }
}

resource fixtureGenerator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(speech.id, operatorObjectId, 'SpeechUser')
  scope: speech
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'f2dc8367-1007-4938-bd23-fe263f013447')
    principalId: operatorObjectId
    principalType: 'User'
  }
}

output accountId string = speech.id
output endpoint string = speech.properties.endpoint

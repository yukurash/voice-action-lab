targetScope = 'resourceGroup'

param vaultName string
@secure()
param clientSecret string
param expiresOn int

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: vaultName
}

resource secret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: vault
  name: 'easyauth-client-secret'
  properties: {
    value: clientSecret
    attributes: { enabled: true, exp: expiresOn }
  }
}

output secretUri string = secret.properties.secretUri

import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { ownerFromRequest } from "../apps/server/auth.ts";
import { loadConfig } from "../apps/server/config.ts";

const tenant = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const stranger = "33333333-3333-4333-8333-333333333333";

for (const scenario of [
  { identity: "aad", provider: undefined, tenant, owner, expected: 200 },
  { identity: "aad", provider: "aad", tenant, owner, expected: 200 },
  { identity: "Bearer", provider: "aad", tenant, owner, expected: 200 },
  { identity: "AuthenticationTypes.Federation", provider: "aad", tenant, owner, expected: 200 },
  { identity: "Bearer", provider: undefined, tenant, owner, expected: 401 },
  { identity: "AuthenticationTypes.Federation", provider: "github", tenant, owner, expected: 401 },
  { identity: "aad", provider: "github", tenant, owner, expected: 401 },
  { identity: "unknown", provider: "aad", tenant, owner, expected: 401 },
  { identity: "Bearer", provider: "aad", tenant, owner: stranger, expected: 403 },
  { identity: "AuthenticationTypes.Federation", provider: "aad", tenant: stranger, owner, expected: 403 },
]) {
  test(`trusted identity ${scenario.identity}/${scenario.provider ?? "absent"}/${scenario.owner}/${scenario.tenant} -> ${scenario.expected}`, async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const app = Fastify();
    const config = loadConfig({
      AUTH_MODE: "easyauth", TRUST_EASYAUTH_PROXY: "true",
      ALLOWED_TENANT_ID: tenant, ALLOWED_OBJECT_IDS: owner,
    });
    app.get("/", (request) => ({ owner: ownerFromRequest(request, config) }));
    t.after(() => app.close());
    const response = await app.inject({
      url: "/",
      headers: {
        "x-ms-client-principal": Buffer.from(JSON.stringify({
          auth_typ: scenario.identity,
          claims: [
            { typ: "http://schemas.microsoft.com/identity/claims/tenantid", val: scenario.tenant },
            { typ: "http://schemas.microsoft.com/identity/claims/objectidentifier", val: scenario.owner },
          ],
        })).toString("base64"),
        ...(scenario.provider === undefined ? {} : { "x-ms-client-principal-idp": scenario.provider }),
      },
    });
    assert.equal(response.statusCode, scenario.expected);
    if (scenario.expected === 200) assert.deepEqual(response.json(), { owner: `${tenant}:${owner}` });
  });
}

test("rejected EasyAuth schema logs bounded metadata, never principal contents", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const app = Fastify();
  const config = loadConfig({
    AUTH_MODE: "easyauth",
    TRUST_EASYAUTH_PROXY: "true",
    ALLOWED_TENANT_ID: "11111111-1111-4111-8111-111111111111",
    ALLOWED_OBJECT_IDS: "22222222-2222-4222-8222-222222222222",
  });
  app.get("/", (request) => ({ owner: ownerFromRequest(request, config) }));
  t.after(() => app.close());
  const response = await app.inject({
    url: "/",
    headers: {
      "x-ms-client-principal": Buffer.from(JSON.stringify({
        auth_typ: "private-provider-value",
        claims: [{ typ: "name", val: "private-person-value" }],
        "private-field-name": "private-field-value",
      })).toString("base64"),
      "x-ms-client-principal-idp": "aad",
    },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(warnings.length, 1);
  assert.deepEqual(JSON.parse(warnings[0] ?? ""), {
    event: "easyauth_principal_schema_rejected",
    object: true,
    fields: ["auth_typ", "claims"],
    authType: "unrecognized",
    claimsArray: true,
    providerHeaderIsAad: true,
  });
  assert.ok(!warnings.join("").includes("private-"));
});

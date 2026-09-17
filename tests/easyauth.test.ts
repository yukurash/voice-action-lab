import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { ownerFromRequest } from "../apps/server/auth.ts";
import { loadConfig } from "../apps/server/config.ts";

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

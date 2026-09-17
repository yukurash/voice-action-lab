import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildApp } from "../apps/server/app.ts";
import { loadConfig } from "../apps/server/config.ts";
import { buildRunSettings } from "../apps/server/exports.ts";
import { sessionConfiguration } from "../apps/server/protocol.ts";

test("owner configuration pins actual settings and protocol identically across both modes", async (t) => {
  const settings = loadConfig({ SOURCE_COMMIT: "a".repeat(40), STEP_INTERVAL_MS: "3000" });
  const app = await buildApp(settings);
  t.after(() => app.close());
  const response = await app.inject("/api/experiment-config");
  assert.equal(response.statusCode, 200);
  const expected = {
    schemaVersion: 1, settings: buildRunSettings(settings), closeTimeoutMs: 8000,
    protocolSha256: createHash("sha256").update(JSON.stringify(sessionConfiguration("gpt-live-1", "gpt-5.5"))).digest("hex"),
  };
  assert.deepEqual(response.json(), expected);
  assert.deepEqual(Object.keys(expected.settings).sort(), [
    "backendModel", "idleLimitMs", "liveModel", "sessionLimitMs",
    "sourceCommit", "sourceOffsetsSynchronized", "stepIntervalMs", "tickMs",
  ]);
  const headers = { origin: "http://127.0.0.1:3000" };
  for (const mode of ["voice-only", "cancel-actions"]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/simulation/start", headers, payload: { mode } })).statusCode, 200);
    assert.deepEqual((await app.inject("/api/experiment-config")).json(), expected);
    assert.equal((await app.inject({ method: "POST", url: "/api/session/close", headers, payload: {} })).statusCode, 200);
  }
});

test("experiment configuration requires owner authentication, even when live is disabled", async (t) => {
  const app = await buildApp(loadConfig({
    AUTH_MODE: "easyauth", TRUST_EASYAUTH_PROXY: "true",
    ALLOWED_TENANT_ID: "11111111-1111-1111-1111-111111111111",
    ALLOWED_OBJECT_IDS: "22222222-2222-2222-2222-222222222222",
  }));
  t.after(() => app.close());
  assert.equal((await app.inject("/api/experiment-config")).statusCode, 401);
});

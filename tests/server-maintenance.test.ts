import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../apps/server/app.ts";
import { loadConfig } from "../apps/server/config.ts";
import type { CloseResult, LiveConnection } from "../apps/server/gateway.ts";
import { startMaintenanceListener } from "../packages/deployment/index.ts";
import type { MaintenanceListener } from "../packages/deployment/index.ts";

const origin = "http://127.0.0.1:3000";
const headers = { origin };
const offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { complete = resolve; });
  return { promise, resolve(value: T) {
    if (!complete) throw new Error("Deferred initialization failed.");
    complete(value);
  } };
}

test("maintenance tracks pending creation and closing, blocks both start routes, and never becomes public", async (t) => {
  const listenerReady = deferred<MaintenanceListener>();
  const opening = deferred<void>();
  const created = deferred<LiveConnection>();
  const closeStarted = deferred<void>();
  const closed = deferred<CloseResult>();
  const connection: LiveConnection = {
    answerSdp: offer, sessionId: "test_session",
    attach: async () => undefined, send: () => undefined,
    close: () => { closeStarted.resolve(); return closed.promise; },
    terminate: () => { closed.resolve({ confirmed: false, usage: null }); },
  };
  const app = await buildApp(loadConfig({
    LIVE_ENABLED: "true", AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/",
    MAINTENANCE_PORT: "0",
  }), {
    gateway: { open: () => { opening.resolve(); return created.promise; } },
    startMaintenance: async (options) => {
      const listener = await startMaintenanceListener(options);
      listenerReady.resolve(listener);
      return listener;
    },
  });
  t.after(async () => {
    created.resolve(connection);
    closed.resolve({ confirmed: false, usage: null });
    await app.close();
  });
  await app.ready();
  const listener = await listenerReady.promise;
  assert.equal(listener.host, "127.0.0.1");
  const base = `http://${listener.host}:${listener.port}`;
  const status = async () => (await fetch(`${base}/status`)).json();
  const command = async (name: string) => (await fetch(`${base}/${name}`, { method: "POST" })).json();

  assert.deepEqual(await status(), { draining: false, active: false });
  const pending = app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "cancel-actions", sdp: offer } }).then((result) => result);
  await opening.promise;
  assert.deepEqual(await command("drain"), { draining: true, active: true });
  for (const [url, payload] of [
    ["/api/session", { mode: "voice-only", sdp: offer }],
    ["/api/simulation/start", { mode: "voice-only" }],
  ] as const) {
    const rejected = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.json().error, "deployment_in_progress");
  }
  assert.equal((await app.inject("/api/config")).json().liveAvailable, false);
  created.resolve(connection);
  assert.equal((await pending).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/session/ready", headers, payload: {} })).statusCode, 200);
  const closing = app.inject({ method: "POST", url: "/api/session/close", headers, payload: {} }).then((result) => result);
  await closeStarted.promise;
  assert.deepEqual(await status(), { draining: true, active: true });
  closed.resolve({ confirmed: true, usage: { seconds: 1 } });
  assert.equal((await closing).statusCode, 200);
  assert.deepEqual(await status(), { draining: true, active: false });
  assert.deepEqual(await command("resume"), { draining: false, active: false });
  assert.equal((await app.inject({ method: "POST", url: "/api/simulation/start", headers, payload: { mode: "voice-only" } })).statusCode, 200);
  assert.deepEqual(await status(), { draining: false, active: true });
  for (const path of ["/status", "/drain", "/resume"]) {
    assert.equal((await app.inject({ url: path, headers })).statusCode, 404);
  }
});

test("maintenance is opt-in and close grace is explicit and bounded", () => {
  assert.equal(loadConfig({}).maintenancePort, undefined);
  assert.equal(loadConfig({}).closeTimeoutMs, 8_000);
  assert.equal(loadConfig({ CLOSE_TIMEOUT_MS: "5000" }).closeTimeoutMs, 5_000);
  assert.throws(() => loadConfig({ MAINTENANCE_PORT: "-1" }), /maintenance port/);
  assert.throws(() => loadConfig({ CLOSE_TIMEOUT_MS: "10001" }), /time limits/);
});

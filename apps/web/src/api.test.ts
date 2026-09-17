import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import viteConfig from "../vite.config.ts";
import type { BrowserState } from "../../../packages/contracts/index.ts";
import { ApiError, idleWarning, isActivityResponse, isBrowserState, isCommandResponse, isConfig, isSessionAnswer, liveSessionReady, post, request } from "./api.ts";

function fixture(): BrowserState {
  return {
    game: {
      runId: "synthetic-test",
      mode: "voice-only",
      epoch: 0,
      cargo: { red: 3, blue: 3 },
      operations: [],
      events: [],
      stopped: true,
    },
    session: { source: "simulation", transport: "disconnected", message: "", expiresAt: null, recording: false },
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("development API and WebSocket proxy match the IPv4 server defaults", () => {
  assert.equal(viteConfig.server?.port, 5173);
  assert.equal(viteConfig.server?.strictPort, true);
  const proxy = viteConfig.server?.proxy?.["/api"];
  assert.ok(proxy && typeof proxy !== "string");
  assert.equal(proxy.target, "http://127.0.0.1:3000");
  assert.equal(proxy.ws, true);
  assert.equal(proxy.changeOrigin, true);
});

test("validates both modes, sources, operations and primitive event details", () => {
  const state = fixture();
  assert.equal(isBrowserState(state), true);
  state.game.mode = "cancel-actions";
  state.session.source = "live";
  state.session.transport = "connected";
  state.session.expiresAt = "2099-01-01T00:10:00Z";
  state.game.operations.push({
    id: "synthetic-op", callId: "synthetic-call", delegationId: "synthetic-delegation",
    epoch: 0, cargo: "blue", destination: "left", status: "running", createdAtMs: 0, endedAtMs: null,
  });
  state.game.events.push({
    sequence: 1, atMs: 1, kind: "step.committed", operationId: "synthetic-op", delegationId: null,
    details: { position: 2, reason: "synthetic", committed: true, optional: null },
  });
  assert.equal(isBrowserState(state), true);
});

test("rejects malformed or unsafe authoritative state without coercion", () => {
  const state = fixture();
  for (const value of [
    null, [], {}, { ...state, game: null },
    { ...state, game: { ...state.game, mode: "both" } },
    { ...state, game: { ...state.game, cargo: { red: -1, blue: 3 } } },
    { ...state, game: { ...state.game, cargo: { red: 3, blue: 7 } } },
    { ...state, game: { ...state.game, cargo: { red: Number.NaN, blue: 3 } } },
    { ...state, game: { ...state.game, operations: [{}] } },
    { ...state, game: { ...state.game, events: [{ sequence: 1, details: { nested: {} } }] } },
    { ...state, session: { ...state.session, expiresAt: "invalid" } },
    { ...state, session: { ...state.session, transport: { toString: {} } } },
    { ...state, session: { ...state.session, source: "mock-live" } },
  ]) assert.equal(isBrowserState(value), false);
});

test("validates config, SDP and command responses", () => {
  assert.equal(isConfig({ liveAvailable: false, reason: "Not configured" }), true);
  assert.equal(isConfig({ liveAvailable: "false", reason: "" }), false);
  assert.equal(isSessionAnswer({ sdp: "", expiresAt: "2099-01-01T00:10:00Z" }), false);
  assert.equal(isSessionAnswer({ sdp: "synthetic", expiresAt: "invalid" }), false);
  assert.equal(isSessionAnswer({ sdp: "synthetic", expiresAt: "2099-01-01T00:10:00Z" }), true);
  assert.equal(isCommandResponse({
    state: fixture(), result: { outcome: "observed-not-applied", operationId: null, reason: "voice-only" },
  }), true);
  assert.equal(isCommandResponse({
    state: fixture(), result: { outcome: "success", operationId: null, reason: "" },
  }), false);
});

test("optional idle warning is display-only and never assumed", () => {
  const state = fixture();
  assert.equal(idleWarning(null), null);
  assert.equal(idleWarning(state), null);
  assert.equal(idleWarning({ ...state, session: { ...state.session, ...{ idleWarning: "Stop soon" } } }), "Stop soon");
  assert.equal(idleWarning({ ...state, session: { ...state.session, ...{ idleWarning: 12 } } }), null);
});

test("activity sends only a relative offset and requires an affirmative acknowledgement", async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/activity");
    assert.equal(init?.body, '{"offsetMs":2500}');
    assert.equal(init?.credentials, "same-origin");
    return Response.json({ ok: true });
  };
  assert.deepEqual(await post("/api/activity", { offsetMs: 2500 }, isActivityResponse), { ok: true });
  for (const value of [null, {}, { ok: false }, { ok: "true" }]) {
    assert.equal(isActivityResponse(value), false);
  }
  globalThis.fetch = async () => Response.json({ ok: false });
  await assert.rejects(post("/api/activity", { offsetMs: 2500 }, isActivityResponse), /契約と一致しません/);
});

test("live readiness requires a running live server session in the selected mode", () => {
  const state = fixture();
  assert.equal(liveSessionReady(null, "voice-only"), false);
  assert.equal(liveSessionReady(state, "voice-only"), false);
  state.session.source = "live";
  state.session.transport = "connected";
  assert.equal(liveSessionReady(state, "voice-only"), false);
  state.game.stopped = false;
  assert.equal(liveSessionReady(state, "voice-only"), true);
  assert.equal(liveSessionReady(state, "cancel-actions"), false);
  for (const transport of ["connecting", "closing", "disconnected", "error"] as const) {
    state.session.transport = transport;
    assert.equal(liveSessionReady(state, "voice-only"), false);
  }
  state.session.transport = "connected";
  state.session.source = "simulation";
  assert.equal(liveSessionReady(state, "voice-only"), false);
});

test("401 and 403 explain owner authentication and permissions", async () => {
  for (const status of [401, 403]) {
    globalThis.fetch = async () => Response.json({ error: "Owner access only" }, { status });
    await assert.rejects(request("/api/state", isBrowserState), (error: unknown) =>
      error instanceof ApiError && error.status === status
      && error.message.includes(status === 401 ? "認証" : "許可")
      && error.message.includes("Owner access only"));
  }
});

test("non-JSON auth failures remain explicit", async () => {
  globalThis.fetch = async () => new Response("Forbidden", { status: 403 });
  await assert.rejects(request("/api/state", isBrowserState), /許可されていません/);
});

test("network, malformed state, and non-JSON responses fail explicitly", async () => {
  globalThis.fetch = async () => { throw new TypeError("Offline"); };
  await assert.rejects(request("/api/state", isBrowserState), /サーバーに接続できません/);
  globalThis.fetch = async () => Response.json({ game: {} });
  await assert.rejects(request("/api/state", isBrowserState), /契約と一致しません/);
  globalThis.fetch = async () => new Response("<html>error</html>", { status: 500 });
  await assert.rejects(request("/api/state", isBrowserState), /JSON 以外/);
});

test("posts only the requested route and JSON body with same-origin credentials", async () => {
  const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return Response.json(fixture());
  };
  const result = await post("/api/simulation/start", { mode: "cancel-actions" }, isBrowserState);
  assert.deepEqual(result, fixture());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "/api/simulation/start");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.body, '{"mode":"cancel-actions"}');
  assert.equal(calls[0]?.init?.credentials, "same-origin");
});

test("live errors never initiate a simulation fallback", async () => {
  const calls: (RequestInfo | URL)[] = [];
  globalThis.fetch = async (input) => {
    calls.push(input);
    return Response.json({ error: "Live unavailable" }, { status: 503 });
  };
  await assert.rejects(post("/api/session", { mode: "voice-only", sdp: "synthetic" }, isSessionAnswer), /Live unavailable/);
  assert.deepEqual(calls, ["/api/session"]);
});

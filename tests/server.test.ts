import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/server/app.ts";
import { loadConfig, validateConfig } from "../apps/server/config.ts";
import type { ServerConfig } from "../apps/server/config.ts";
import type { CloseResult, LiveConnection, LiveGateway, OpenLiveRequest } from "../apps/server/gateway.ts";
import { completedTool, sessionConfiguration } from "../apps/server/protocol.ts";
import type { BrowserState } from "../packages/contracts/index.ts";

const origin = "http://127.0.0.1:3000";
const offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const headers = { origin };
const tenantId = "11111111-1111-1111-1111-111111111111";
const firstOid = "22222222-2222-2222-2222-222222222222";
const secondOid = "33333333-3333-3333-3333-333333333333";

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...loadConfig({}), tickMs: 20, closeTimeoutMs: 30, ...overrides };
}

function liveConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return config({ liveEnabled: true, azureEndpoint: "https://example-resource.openai.azure.com/", ...overrides });
}

function principal(oid = firstOid, tenant = tenantId, provider = "aad"): string {
  return Buffer.from(JSON.stringify({ auth_typ: provider, claims: [{ typ: "tid", val: tenant }, { typ: "oid", val: oid }] })).toString("base64");
}

class FakeConnection implements LiveConnection {
  answerSdp = offer;
  sessionId = "session_test";
  sent: Record<string, unknown>[] = [];
  closes = 0;
  terminated = false;
  attached = false;
  attaches = 0;
  attachHeld = false;
  attachRelease: (() => void) | null = null;
  creationStartedAtMs?: number;
  result: CloseResult = { confirmed: true, usage: { session_seconds: 1 } };

  send(event: Record<string, unknown>): void { this.sent.push(event); }
  async attach(): Promise<void> {
    this.attaches++;
    if (this.attachHeld) await new Promise<void>((resolve) => { this.attachRelease = resolve; });
    this.attached = true;
  }
  async close(): Promise<CloseResult> {
    this.closes++;
    return this.attached ? this.result : { confirmed: false, usage: null };
  }
  terminate(): void { this.terminated = true; }
}

class FakeGateway implements LiveGateway {
  requests: OpenLiveRequest[] = [];
  connection = new FakeConnection();
  held = false;
  fail = false;
  release: (() => void) | null = null;

  async open(request: OpenLiveRequest): Promise<LiveConnection> {
    this.requests.push(request);
    this.connection.attached = false;
    if (this.fail) throw new Error("SECRET raw service error must not escape");
    if (this.held) {
      await new Promise<void>((resolve, reject) => {
        this.release = resolve;
        request.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    }
    return this.connection;
  }

  emit(event: unknown): void {
    const request = this.requests.at(-1);
    assert.ok(request);
    request.onEvent(event);
  }
}

async function setup(t: TestContext, settings = config(), gateway = new FakeGateway(), now?: () => number) {
  const app = await buildApp(settings, { gateway, ...(now ? { now } : {}) });
  t.after(() => app.close());
  await app.ready();
  return { app, gateway };
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for local test condition.");
}

async function ready(app: FastifyInstance, gateway: FakeGateway): Promise<void> {
  const response = await app.inject({ method: "POST", url: "/api/session/ready", headers, payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().session.source, "live");
  gateway.connection.sent.length = 0;
}

function delegation(id = "delegation_1", offset = 0) {
  return { type: "session.delegation.created", offset_ms: offset, delegation: { id, target: "responses", response_id: "response_1" } };
}

function tool(name = "move_cargo", args = '{"cargo":"red","destination":"right"}', callId = "call_1", delegationId = "delegation_1") {
  return {
    type: "response.event", delegation_id: delegationId,
    event: { type: "response.output_item.done", item: { type: "function_call", call_id: callId, name, arguments: args } },
  };
}

test("configuration is live-disabled by default and rejects unsafe authentication/binding", () => {
  assert.equal(loadConfig({}).liveEnabled, false);
  assert.equal(loadConfig({}).stepIntervalMs, 1000);
  assert.equal(loadConfig({ STEP_INTERVAL_MS: "1500" }).stepIntervalMs, 1500);
  assert.throws(() => loadConfig({ STEP_INTERVAL_MS: "0" }), /time limits/);
  assert.throws(() => loadConfig({ STEP_INTERVAL_MS: "5001" }), /time limits/);
  assert.throws(() => loadConfig({ HOST: "0.0.0.0" }), /loopback/);
  assert.throws(() => loadConfig({ NODE_ENV: "production", AUTH_MODE: "dev" }), /loopback/);
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /allowlist/);
  assert.throws(() => loadConfig({ LIVE_ENABLED: "yes" }), /true or false/);
  assert.throws(() => loadConfig({ LIVE_ENABLED: "true" }), /AZURE_OPENAI_ENDPOINT/);
  assert.throws(() => validateConfig(liveConfig({ azureEndpoint: "https://example.com/" })), /endpoint/);
  assert.throws(() => validateConfig(liveConfig({ azureEndpoint: "https://example.openai.azure.com@evil.example/" })), /endpoint/);
  assert.throws(() => validateConfig(liveConfig({ azureEndpoint: "https://example.openai.azure.com/path" })), /endpoint/);
  assert.throws(() => validateConfig(config({ backendModel: "fallback-model" })), /gpt-5.5/);
});

test("health is nonsensitive; live-disabled requests never silently create simulation", async (t) => {
  const { app, gateway } = await setup(t);
  assert.deepEqual((await app.inject("/health/live")).json(), { status: "ok" });
  assert.equal((await app.inject("/api/config")).json().liveAvailable, false);
  const response = await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } });
  assert.equal(response.statusCode, 503);
  assert.equal(gateway.requests.length, 0);
  const state: BrowserState = (await app.inject("/api/state")).json();
  assert.equal(state.session.transport, "disconnected");
  assert.equal(state.game.stopped, true);
});

test("mutations and websocket upgrades reject missing or mismatched Origins", async (t) => {
  const { app } = await setup(t);
  for (const requestHeaders of [{}, { origin: "https://untrusted.example" }]) {
    const response = await app.inject({ method: "POST", url: "/api/simulation/start", headers: requestHeaders, payload: { mode: "voice-only" } });
    assert.equal(response.statusCode, 403);
  }
  const wsResponse = await app.inject({ method: "GET", url: "/api/events", headers: { origin: "https://untrusted.example", upgrade: "websocket" } });
  assert.equal(wsResponse.statusCode, 403);
});

test("production authenticates an aad tenant AND object allowlist, not arbitrary tenant users", async (t) => {
  const production = liveConfig({
    production: true, host: "0.0.0.0", credentialMode: "managed-identity",
    allowedOrigins: ["https://lab.example"],
    auth: { mode: "easyauth", trustEasyAuthProxy: true, tenantId, objectIds: [firstOid, secondOid] },
  });
  const { app } = await setup(t, production);
  assert.equal((await app.inject("/api/config")).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/state", headers: { "x-ms-client-principal": "bad!" } })).statusCode, 401);
  for (const p of [principal("44444444-4444-4444-4444-444444444444"), principal(firstOid, secondOid)]) {
    assert.equal((await app.inject({ url: "/api/state", headers: { "x-ms-client-principal": p } })).statusCode, 403);
  }
  assert.equal((await app.inject({ url: "/api/state", headers: { "x-ms-client-principal": principal(firstOid, tenantId, "google") } })).statusCode, 401);
  const ownerHeaders = { origin: "https://lab.example", "x-ms-client-principal": principal() };
  assert.equal((await app.inject({ method: "POST", url: "/api/simulation/start", headers: ownerHeaders, payload: { mode: "cancel-actions" } })).statusCode, 200);
  const otherHeaders = { ...ownerHeaders, "x-ms-client-principal": principal(secondOid) };
  assert.equal((await app.inject({ url: "/api/state", headers: otherHeaders })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/stop", headers: otherHeaders, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/stop", headers: ownerHeaders, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/session", headers: ownerHeaders, payload: { mode: "voice-only", sdp: offer } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/session/ready", headers: otherHeaders, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/session/ready", headers: { origin: "https://lab.example" }, payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/session/ready", headers: ownerHeaders, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/session/close", headers: ownerHeaders, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/simulation/start", headers: otherHeaders, payload: { mode: "voice-only" } })).statusCode, 200);
});

test("simulation is explicitly labelled, commands validate, and emergency stop freezes operations", async (t) => {
  let clock = 1_000;
  const { app } = await setup(t, config(), undefined, () => clock);
  const started = await app.inject({ method: "POST", url: "/api/simulation/start", headers, payload: { mode: "cancel-actions" } });
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().session.source, "simulation");
  assert.equal((await app.inject({ method: "POST", url: "/api/command", headers, payload: { type: "move", cargo: "green", destination: "right" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/command", headers, payload: { type: "cancel", untrusted: true } })).statusCode, 400);
  const move = await app.inject({ method: "POST", url: "/api/command", headers, payload: { type: "move", cargo: "red", destination: "right" } });
  assert.equal(move.statusCode, 200);
  assert.equal(move.json().result.outcome, "queued");
  const stopped: BrowserState = (await app.inject({ method: "POST", url: "/api/stop", headers, payload: {} })).json();
  assert.equal(stopped.game.stopped, true);
  clock += 5_000;
  await delay(40);
  assert.deepEqual((await app.inject("/api/state")).json().game.cargo, stopped.game.cargo);
  assert.equal((await app.inject({ method: "POST", url: "/api/command", headers, payload: { type: "cancel" } })).statusCode, 409);
});

test("all POST contracts reject invalid bodies and unknown fields", async (t) => {
  const { app } = await setup(t, liveConfig());
  const cases = [
    ["/api/simulation/start", { mode: "invalid" }],
    ["/api/simulation/start", { mode: "voice-only", sessionId: "injected" }],
    ["/api/session", { mode: "voice-only", sdp: "not sdp" }],
    ["/api/session", { mode: "voice-only", sdp: offer, url: "https://evil.example" }],
    ["/api/session/close", { sessionId: "someone-else" }],
    ["/api/session/ready", { sessionId: "someone-else" }],
    ["/api/stop", []],
    ["/api/activity", { offsetMs: -1 }],
    ["/api/activity", { offsetMs: 600_001 }],
    ["/api/activity", { offsetMs: "123" }],
  ] as const;
  for (const [url, payload] of cases) {
    assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 400, url);
  }
});

test("session creation reserves atomically and marks live only after sideband attach", async (t) => {
  const gateway = new FakeGateway();
  gateway.held = true;
  const { app } = await setup(t, liveConfig(), gateway);
  const creating = app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } });
  const pending = creating.then((result) => result);
  await until(() => gateway.requests.length === 1);
  const during: BrowserState = (await app.inject("/api/state")).json();
  assert.equal(during.session.transport, "connecting");
  assert.notEqual(during.session.source, "live");
  assert.equal(during.game.events.find((event) => event.kind === "live_connecting")?.details.sourceOffsetsSynchronized, false);
  assert.equal((await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "cancel-actions", sdp: offer } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/api/simulation/start", headers, payload: { mode: "voice-only" } })).statusCode, 409);
  gateway.release?.();
  const result = await pending;
  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(result.json()).sort(), ["expiresAt", "sdp"]);
  assert.equal(gateway.connection.attaches, 0, "The browser must receive SDP before any sideband attempt.");
  assert.notEqual((await app.inject("/api/state")).json().session.source, "live");
  await ready(app, gateway);
  assert.equal((await app.inject("/api/state")).json().session.source, "live");
  assert.equal((await app.inject({ method: "POST", url: "/api/session/ready", headers, payload: {} })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/api/command", headers, payload: { type: "cancel" } })).statusCode, 409);
});

test("failed live creation is sanitized, releases reservation and does not fall back", async (t) => {
  const gateway = new FakeGateway();
  gateway.fail = true;
  const { app } = await setup(t, liveConfig(), gateway);
  const response = await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } });
  assert.equal(response.statusCode, 502);
  assert.ok(!response.body.includes("SECRET"));
  assert.ok(!response.body.includes(offer));
  const state: BrowserState = (await app.inject("/api/state")).json();
  assert.equal(state.game.stopped, true);
  assert.match(state.session.message, /unconfirmed/);
  assert.equal((await app.inject({ method: "POST", url: "/api/simulation/start", headers, payload: { mode: "voice-only" } })).statusCode, 200);
});

test("closing during creation aborts the pending request without a zombie run", async (t) => {
  const gateway = new FakeGateway();
  gateway.held = true;
  const { app } = await setup(t, liveConfig(), gateway);
  const pending = app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } }).then((value) => value);
  await until(() => gateway.requests.length === 1);
  assert.equal((await app.inject({ method: "POST", url: "/api/stop", headers, payload: {} })).statusCode, 200);
  assert.equal(gateway.requests[0]?.signal.aborted, true);
  assert.ok((await pending).statusCode >= 400);
  assert.equal((await app.inject("/api/state")).json().game.stopped, true);
});

test("live tools use completed nested calls only, dispatch immediately, deduplicate, and continue once", async (t) => {
  const { app, gateway } = await setup(t, liveConfig());
  await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "cancel-actions", sdp: offer } });
  await ready(app, gateway);
  gateway.emit({ type: "session.input_transcript.delta", delta: "move red right" });
  gateway.emit({ type: "response.output_item.done", item: { type: "function_call", call_id: "injected" } });
  assert.equal(gateway.connection.sent.length, 0);
  gateway.emit(delegation());
  gateway.emit(tool());
  assert.equal(gateway.connection.sent.length, 1);
  const output = gateway.connection.sent[0];
  assert.equal(output?.type, "response.item.create");
  const item = output?.item as { call_id: string; output: string };
  assert.equal(item.call_id, "call_1");
  assert.equal(JSON.parse(item.output).outcome, "queued");
  assert.equal((await app.inject("/api/state")).json().game.operations.length, 1);
  gateway.emit(tool());
  assert.equal(gateway.connection.sent.length, 1);
  gateway.emit({ type: "response.event", delegation_id: "delegation_1", event: { type: "response.completed", response: { id: "response_tools" } } });
  gateway.emit({ type: "response.event", delegation_id: "delegation_1", event: { type: "response.completed", response: { id: "response_tools" } } });
  assert.equal(gateway.connection.sent.filter((event) => event.type === "response.create").length, 1);
  assert.ok(!(await app.inject("/api/state")).body.includes("move red right"));
});

test("invalid and unregistered live tool calls are rejected without executing", async (t) => {
  const { app, gateway } = await setup(t, liveConfig());
  await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } });
  await ready(app, gateway);
  gateway.emit(tool("cancel_pending", '{"cargo":"red"}'));
  gateway.emit(tool("move_cargo", '{"cargo":"red","destination":"right"}', "call_2", "not_registered"));
  const state: BrowserState = (await app.inject("/api/state")).json();
  assert.equal(state.game.operations.length, 0);
  for (const event of gateway.connection.sent) {
    const item = event.item as { output: string };
    assert.equal(JSON.parse(item.output).outcome, "rejected");
  }
});

test("final usage is confirmed only on graceful receipt and disconnect stops operations", async (t) => {
  const { app, gateway } = await setup(t, liveConfig());
  await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } });
  await ready(app, gateway);
  gateway.emit(delegation());
  gateway.emit(tool());
  const closed: BrowserState = (await app.inject({ method: "POST", url: "/api/session/close", headers, payload: {} })).json();
  assert.equal(closed.game.stopped, true);
  assert.match(closed.session.message, /final usage confirmed/);
  assert.ok(closed.game.events.some((event) => event.kind === "final_usage_confirmed"));
  assert.equal(gateway.connection.closes, 1);
  await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } });
  await ready(app, gateway);
  gateway.requests.at(-1)?.onDisconnect("raw service private message");
  await until(() => gateway.connection.terminated);
  await delay(1);
  const disconnected: BrowserState = (await app.inject("/api/state")).json();
  assert.equal(disconnected.game.stopped, true);
  assert.match(disconnected.session.message, /final usage unconfirmed/);
  assert.ok(!JSON.stringify(disconnected).includes("raw service private"));
});

test("graceful timeout records usage unconfirmed and late tools cannot restart a closed game", async (t) => {
  const { app, gateway } = await setup(t, liveConfig());
  gateway.connection.result = { confirmed: false, usage: null };
  await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "cancel-actions", sdp: offer } });
  await ready(app, gateway);
  const closed = await app.inject({ method: "POST", url: "/api/stop", headers, payload: {} });
  assert.match(closed.json().session.message, /unconfirmed/);
  gateway.emit(delegation());
  gateway.emit(tool());
  assert.equal((await app.inject("/api/state")).json().game.operations.length, 0);
});

test("idle warnings, user activity, idle timeout, and maximum session duration are enforced", async (t) => {
  let clock = 10_000;
  const { app, gateway } = await setup(t, liveConfig({ idleLimitMs: 90_000 }), undefined, () => clock);
  await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } });
  await ready(app, gateway);
  clock += 76_000;
  await delay(40);
  assert.match((await app.inject("/api/state")).json().session.message, /Idle warning/);
  assert.equal((await app.inject({ method: "POST", url: "/api/activity", headers, payload: { offsetMs: 76_000 } })).statusCode, 200);
  clock += 80_000;
  await delay(40);
  assert.equal((await app.inject("/api/state")).json().session.transport, "connected");
  clock += 11_000;
  await delay(40);
  assert.match((await app.inject("/api/state")).json().session.message, /idle_timeout/);
  await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } });
  await ready(app, gateway);
  clock += 600_001;
  gateway.emit({ type: "session.input_transcript.delta", delta: "activity" });
  await delay(40);
  assert.match((await app.inject("/api/state")).json().session.message, /session_time_limit/);
});

test("pending negotiation and sideband attachment reserve the run, delay actions, and reject duplicate ready calls", async (t) => {
  const { app, gateway } = await setup(t, liveConfig());
  gateway.connection.attachHeld = true;
  assert.equal((await app.inject({ method: "POST", url: "/api/session/ready", headers, payload: {} })).statusCode, 409);
  const created = await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "cancel-actions", sdp: offer } });
  assert.equal(created.statusCode, 200);
  assert.equal(gateway.connection.attaches, 0);
  gateway.emit(delegation());
  gateway.emit(tool());
  assert.equal((await app.inject("/api/state")).json().game.operations.length, 0);
  assert.equal((await app.inject({ method: "POST", url: "/api/session/ready", headers: { origin: "https://evil.example" }, payload: {} })).statusCode, 403);
  const pending = app.inject({ method: "POST", url: "/api/session/ready", headers, payload: {} }).then((response) => response);
  await until(() => gateway.connection.attaches === 1);
  assert.equal((await app.inject("/api/state")).json().game.operations.length, 0);
  assert.equal((await app.inject({ method: "POST", url: "/api/session/ready", headers, payload: {} })).statusCode, 409);
  gateway.connection.attachRelease?.();
  assert.equal((await pending).statusCode, 200);
  assert.equal((await app.inject("/api/state")).json().game.operations.length, 1);
});

test("negotiation timeout releases the session without attaching or accepting live operations", async (t) => {
  let clock = 0;
  const { app, gateway } = await setup(t, liveConfig(), undefined, () => clock);
  await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } });
  clock += 45_001;
  await delay(40);
  const state: BrowserState = (await app.inject("/api/state")).json();
  assert.equal(state.game.stopped, true);
  assert.match(state.session.message, /negotiation_timeout.*unconfirmed/);
  assert.equal(gateway.connection.attaches, 0);
  assert.equal((await app.inject({ method: "POST", url: "/api/session/ready", headers, payload: {} })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/api/simulation/start", headers, payload: { mode: "voice-only" } })).statusCode, 200);
});

test("websocket streams state but reconnecting after disconnect never replays operations", async (t) => {
  const { app } = await setup(t);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}/api/events`;
  const socket = new WebSocket(url, { headers });
  const firstMessage = once(socket, "message");
  await once(socket, "open");
  const [initial] = await firstMessage;
  assert.equal(JSON.parse(String(initial)).session.source, "simulation");
  await app.inject({ method: "POST", url: "/api/simulation/start", headers, payload: { mode: "voice-only" } });
  await app.inject({ method: "POST", url: "/api/command", headers, payload: { type: "move", cargo: "red", destination: "right" } });
  socket.close();
  await once(socket, "close");
  await delay(10);
  const stopped = (await app.inject("/api/state")).json();
  assert.equal(stopped.game.stopped, true);
  const next = new WebSocket(url, { headers });
  const nextMessage = once(next, "message");
  await once(next, "open");
  assert.equal(JSON.parse(String((await nextMessage)[0])).game.stopped, true);
  next.close();
  await once(next, "close");
});

test("protocol schemas are strict, fixed across A/B, and do not use transcript fragments", () => {
  const session = sessionConfiguration("gpt-live-1", "gpt-5.5");
  assert.equal(session.delegation.responses.parallel_tool_calls, false);
  assert.equal(session.audio.output.voice, "marin");
  assert.equal(session.delegation.responses.tools.length, 3);
  assert.ok(session.delegation.responses.tools.every((entry) => entry.strict && entry.parameters.additionalProperties === false));
  assert.equal(completedTool({ type: "session.input_transcript.delta", delta: "cancel" }), null);
  assert.equal(completedTool(tool("unknown_tool"))?.request, null);
  assert.equal(completedTool(tool("cancel_pending", '{"type":"move"}'))?.request, null);
  assert.equal(completedTool(tool("cancel_pending", "{}"))?.request?.command.type, "cancel");
});

test("movement step interval is independent of 20ms state polling and never catches up multiple steps", async (t) => {
  let clock = 100_000;
  const { app } = await setup(t, config({ stepIntervalMs: 1_000 }), undefined, () => clock);
  await app.inject({ method: "POST", url: "/api/simulation/start", headers, payload: { mode: "voice-only" } });
  await app.inject({ method: "POST", url: "/api/command", headers, payload: { type: "move", cargo: "red", destination: "right" } });
  clock += 999;
  await delay(40);
  assert.equal((await app.inject("/api/state")).json().game.cargo.red, 0);
  clock++;
  await delay(40);
  assert.equal((await app.inject("/api/state")).json().game.cargo.red, 1);
  clock += 3_000;
  await delay(40);
  const state: BrowserState = (await app.inject("/api/state")).json();
  assert.equal(state.game.cargo.red, 2);
  assert.ok(state.game.events.every((event) => event.atMs <= 4_000));
});

test("a command admitted late in a run still waits its entire configured movement interval", async (t) => {
  let clock = 0;
  const { app } = await setup(t, config({ stepIntervalMs: 1_000 }), undefined, () => clock);
  await app.inject({ method: "POST", url: "/api/simulation/start", headers, payload: { mode: "voice-only" } });
  clock = 4_900;
  await app.inject({ method: "POST", url: "/api/command", headers, payload: { type: "move", cargo: "red", destination: "right" } });
  clock = 5_000;
  await delay(40);
  assert.equal((await app.inject("/api/state")).json().game.cargo.red, 0);
  clock = 5_900;
  await delay(40);
  assert.equal((await app.inject("/api/state")).json().game.cargo.red, 1);
});

test("remote offsets translate into run-relative time and stale registration exceptions never crash live handling", async (t) => {
  let clock = 100_000;
  const gateway = new FakeGateway();
  gateway.held = true;
  gateway.connection.creationStartedAtMs = 100_100;
  const { app } = await setup(t, liveConfig(), gateway, () => clock);
  const creating = app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "cancel-actions", sdp: offer } }).then((response) => response);
  await until(() => gateway.requests.length === 1);
  clock += 500;
  gateway.release?.();
  assert.equal((await creating).statusCode, 200);
  await ready(app, gateway);
  gateway.emit(delegation("cancel_delegation", 200));
  gateway.emit(tool("cancel_pending", "{}", "cancel_call", "cancel_delegation"));
  gateway.emit(delegation("stale_delegation", 100));
  gateway.emit(tool("move_cargo", '{"cargo":"red","destination":"right"}', "stale_call", "stale_delegation"));
  gateway.emit(delegation("future_delegation", 999_999));
  gateway.emit({ type: "session.delegation.created", delegation: { id: "missing_offset", target: "responses" } });
  let state: BrowserState = (await app.inject("/api/state")).json();
  assert.equal(state.session.transport, "connected");
  assert.equal(state.game.operations.length, 0);
  assert.ok(state.game.events.some((event) => event.kind === "delegation_registration_rejected"));
  assert.ok(state.game.events.some((event) => event.kind === "delegation_offset_required_after_cancel"));
  clock += 500;
  gateway.emit(delegation("fresh_delegation", 800));
  gateway.emit(tool("move_cargo", '{"cargo":"blue","destination":"right"}', "fresh_call", "fresh_delegation"));
  state = (await app.inject("/api/state")).json();
  assert.equal(state.game.operations.length, 1);
  assert.equal(state.game.operations[0]?.cargo, "blue");
  assert.ok(state.game.events.every((event) => event.atMs <= 1_000));
});

test("emergency close during attachment prevents late readiness from enabling a stopped run", async (t) => {
  const { app, gateway } = await setup(t, liveConfig());
  gateway.connection.attachHeld = true;
  await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } });
  const pending = app.inject({ method: "POST", url: "/api/session/ready", headers, payload: {} }).then((response) => response);
  await until(() => gateway.connection.attaches === 1);
  assert.equal((await app.inject({ method: "POST", url: "/api/stop", headers, payload: {} })).statusCode, 200);
  gateway.connection.attachRelease?.();
  assert.equal((await pending).statusCode, 409);
  const state: BrowserState = (await app.inject("/api/state")).json();
  assert.equal(state.game.stopped, true);
  assert.notEqual(state.session.transport, "connected");
});

test("static assets and SPA fallback stay owner-authenticated and cannot escape the static root", async (t) => {
  const settings = config({
    production: true, host: "0.0.0.0", credentialMode: "managed-identity",
    allowedOrigins: ["https://lab.example"],
    auth: { mode: "easyauth", trustEasyAuthProxy: true, tenantId, objectIds: [firstOid] },
    staticDirectory: resolve("tests", "server-fixtures", "public"),
  });
  const { app } = await setup(t, settings);
  const ownerHeaders = { "x-ms-client-principal": principal() };
  for (const url of ["/", "/app.css", "/experiment", "//app.css", "/./app.css", "/%2e/app.css"]) {
    const response = await app.inject({ url });
    assert.notEqual(response.statusCode, 200, `Unauthenticated static path: ${url}`);
    assert.ok(!response.body.includes("STATIC_ASSET_TEST_MARKER"));
    assert.ok(!response.body.includes("STATIC_INDEX_TEST_MARKER"));
  }
  assert.equal((await app.inject({ url: "/app.css", headers: ownerHeaders })).statusCode, 200);
  assert.match((await app.inject({ url: "/experiment", headers: ownerHeaders })).body, /STATIC_INDEX_TEST_MARKER/);
  for (const url of [
    "/../outside.txt", "/%2e%2e/outside.txt", "/..%5coutside.txt", "/%2e%2e%2foutside.txt",
  ]) {
    const response = await app.inject({ url, headers: ownerHeaders });
    assert.notEqual(response.statusCode, 200, `Path outside static root: ${url}`);
    assert.ok(!response.body.includes("OUTSIDE_STATIC_ROOT_TEST_MARKER"));
    assert.ok(!response.body.includes("STATIC_ASSET_TEST_MARKER"));
  }
  assert.equal((await app.inject({ url: "/api/unknown", headers: ownerHeaders })).statusCode, 404);
  assert.equal((await app.inject("/health/live")).statusCode, 200);
});

test("assistant activity resets idle timeout without claiming transcript timing is audible stopping", async (t) => {
  let clock = 0;
  const { app, gateway } = await setup(t, liveConfig(), undefined, () => clock);
  await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } });
  await ready(app, gateway);
  clock = 80_000;
  gateway.emit({ type: "session.output_transcript.delta", delta: "private assistant speech", start_ms: 79_000, end_ms: 80_000 });
  clock = 100_000;
  await delay(40);
  let state: BrowserState = (await app.inject("/api/state")).json();
  assert.equal(state.session.transport, "connected");
  assert.ok(state.game.events.some((event) => event.kind === "output_transcript_timing"));
  assert.ok(!JSON.stringify(state).includes("private assistant speech"));
  assert.ok(!state.game.events.some((event) => event.kind.includes("audible_stop")));
  clock = 170_001;
  await delay(40);
  state = (await app.inject("/api/state")).json();
  assert.match(state.session.message, /idle_timeout/);
});

test("queued or running work prevents idle closure but never bypasses the absolute session cap", async (t) => {
  let clock = 0;
  const { app } = await setup(t, config(), undefined, () => clock);
  await app.inject({ method: "POST", url: "/api/simulation/start", headers, payload: { mode: "voice-only" } });
  await app.inject({ method: "POST", url: "/api/command", headers, payload: { type: "move", cargo: "red", destination: "right" } });
  clock = 91_000;
  await delay(40);
  const active: BrowserState = (await app.inject("/api/state")).json();
  assert.equal(active.session.transport, "connected");
  assert.ok(active.game.operations.some((operation) => operation.status === "running"));
  clock = 600_001;
  await delay(40);
  const stopped: BrowserState = (await app.inject("/api/state")).json();
  assert.equal(stopped.game.stopped, true);
  assert.match(stopped.session.message, /session_time_limit/);
});

test("pending backend processing prevents idle closure until completion then starts a fresh inactivity window", async (t) => {
  let clock = 0;
  const { app, gateway } = await setup(t, liveConfig(), undefined, () => clock);
  await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } });
  await ready(app, gateway);
  gateway.emit(delegation());
  clock = 91_000;
  await delay(40);
  assert.equal((await app.inject("/api/state")).json().session.transport, "connected");
  gateway.emit({ type: "response.event", delegation_id: "delegation_1", event: { type: "response.completed" } });
  clock = 180_000;
  await delay(40);
  assert.equal((await app.inject("/api/state")).json().session.transport, "connected");
  clock = 181_001;
  await delay(40);
  assert.match((await app.inject("/api/state")).json().session.message, /idle_timeout/);
  await app.inject({ method: "POST", url: "/api/session", headers, payload: { mode: "voice-only", sdp: offer } });
  await ready(app, gateway);
  gateway.emit(delegation("long_running_backend"));
  clock += 600_001;
  await delay(40);
  assert.match((await app.inject("/api/state")).json().session.message, /session_time_limit/);
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { AzureLiveGateway, GatewayError } from "../apps/server/gateway.ts";
import { loadConfig } from "../apps/server/config.ts";
import { finalUsage } from "../apps/server/protocol.ts";

const offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const settings = {
  ...loadConfig({}),
  liveEnabled: true,
  azureEndpoint: "https://example-resource.openai.azure.com/",
};

test("gateway creates configured WebRTC, authenticates server-side, and attaches without session.start", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const localUrl = `ws://127.0.0.1:${address.port}`;
  const received: Record<string, unknown>[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const event: Record<string, unknown> = JSON.parse(data.toString());
      received.push(event);
      if (event.type === "session.close") {
        socket.send(JSON.stringify({ type: "session.closed", usage: { session_seconds: 2, secret: "not propagated" } }));
      }
    });
  });
  let requested = false;
  const gateway = new AzureLiveGateway(settings, {
    credential: {
      async getToken(scope) {
        assert.equal(scope, "https://cognitiveservices.azure.com/.default");
        return { token: "fake-unit-test-token" };
      },
    },
    fetch: async (url, init) => {
      requested = true;
      assert.equal(String(url), "https://example-resource.openai.azure.com/openai/v1/live/sessions");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.transport.type, "webrtc");
      assert.equal(body.transport.sdp, offer);
      assert.equal(body.session.model, "gpt-live-1");
      assert.equal(body.session.delegation.responses.model, "gpt-5.5");
      assert.equal(body.session.delegation.responses.parallel_tool_calls, false);
      assert.equal(body.session.audio.output.voice, "marin");
      assert.ok(!("mode" in body.session));
      return Response.json({ session: { id: "session_from_service" }, transport: { sdp: offer } });
    },
    createSocket: (url, options) => {
      assert.equal(url, "wss://example-resource.openai.azure.com/openai/v1/live/sessions/session_from_service/attach");
      assert.equal(options.headers?.Authorization, "Bearer fake-unit-test-token");
      return new WebSocket(localUrl);
    },
  });
  const connection = await gateway.open({
    sdp: offer, signal: new AbortController().signal,
    onEvent: () => {}, onDisconnect: () => {},
  });
  assert.equal(requested, true);
  assert.equal(connection.answerSdp, offer);
  assert.equal(received.length, 0);
  assert.equal(server.clients.size, 0, "Creation returns SDP without waiting on sideband.");
  await connection.attach();
  const result = await connection.close(200);
  assert.deepEqual(result, { confirmed: true, usage: { session_seconds: 2 } });
  assert.deepEqual(received.map((event) => event.type), ["session.close"]);
});

test("gateway sanitizes upstream errors, rejects malicious session IDs, and never follows redirects", async () => {
  const base = { credential: { async getToken() { return { token: "unit-test" }; } } };
  for (const response of [
    new Response("secret resource transcript", { status: 403 }),
    Response.json({ session: { id: "../../other-session" }, transport: { sdp: offer } }),
  ]) {
    const gateway = new AzureLiveGateway(settings, {
      ...base,
      fetch: async (_url, init) => { assert.equal(init?.redirect, "error"); return response; },
      createSocket: () => { assert.fail("Invalid responses must not open a socket."); },
    });
    await assert.rejects(
      gateway.open({ sdp: offer, signal: new AbortController().signal, onEvent: () => {}, onDisconnect: () => {} }),
      (error: unknown) => error instanceof GatewayError && !error.message.includes("secret"),
    );
  }
});

test("a 201 session needs no expires_at and a sideband HTTP 404 is preserved without its body", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("PRIVATE upstream response body");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let disconnected = false;
  const gateway = new AzureLiveGateway(settings, {
    credential: { async getToken() { return { token: "unit-test" }; } },
    fetch: async () => Response.json({ session: { id: "live_test" }, transport: { type: "webrtc", sdp: offer } }, { status: 201 }),
    createSocket: () => new WebSocket(`ws://127.0.0.1:${address.port}`),
  });
  const connection = await gateway.open({ sdp: offer, signal: new AbortController().signal, onEvent: () => {}, onDisconnect: () => { disconnected = true; } });
  await assert.rejects(
    connection.attach(),
    (error: unknown) => error instanceof GatewayError && error.message === "live_attach_http_404_usage_unconfirmed",
  );
  assert.equal(disconnected, false, "An attach rejection is not an established-live disconnect.");
});

test("gateway close timeout and abrupt sideband disconnect leave usage unconfirmed", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const gateway = new AzureLiveGateway(settings, {
    credential: { async getToken() { return { token: "unit-test" }; } },
    fetch: async () => Response.json({ session: { id: "session_test" }, transport: { sdp: offer } }),
    createSocket: () => new WebSocket(`ws://127.0.0.1:${address.port}`),
  });
  const connection = await gateway.open({
    sdp: offer, signal: new AbortController().signal, onEvent: () => {}, onDisconnect: () => {},
  });
  await connection.attach();
  assert.deepEqual(await connection.close(20), { confirmed: false, usage: null });
  assert.deepEqual(await connection.close(20), { confirmed: false, usage: null });
});

test("usage keeps only finite nonnegative numeric totals from session.closed", () => {
  assert.equal(finalUsage({ type: "session.usage.updated", usage: { seconds: 9 } }), null);
  assert.equal(finalUsage({ type: "session.closed" }), null);
  assert.deepEqual(finalUsage({
    type: "session.closed",
    usage: { seconds: 10, tokens: 20, transcript: "private", invalid: -1, infinite: Infinity, nested: { secret: "private" } },
  }), { seconds: 10, tokens: 20 });
});

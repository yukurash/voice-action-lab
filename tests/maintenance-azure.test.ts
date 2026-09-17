import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import type { AzureCliCredentialOptions } from "@azure/identity";
import {
  AzureMaintenanceError,
  OPERATOR_LIMITS,
  parseAzureMaintenanceArgs,
  runAzureMaintenance,
  runAzureMaintenanceCli,
  validatedExecOrigin,
} from "../scripts/maintenance-azure.ts";
import type { AzureMaintenanceDependencies, AzureMaintenanceOptions, ExecSocket } from "../scripts/maintenance-azure.ts";
import { DRAIN_READY_MARKER } from "../packages/deployment/protocol.ts";
import { HEALTH_READY_MARKER } from "../packages/deployment/health.ts";

const SUBSCRIPTION = "11111111-1111-1111-1111-111111111111";
const TENANT = "22222222-2222-2222-2222-222222222222";
const RESOURCE = `/subscriptions/${SUBSCRIPTION}/resourceGroups/example-rg/providers/Microsoft.App/containerApps/example-app`;
const REVISION = "example-app--release";
const REVISION_RESOURCE = `${RESOURCE}/revisions/${REVISION}`;
const REPLICA = `${REVISION}-abcde-12345`;
const IMAGE = "registry.example/lab:release";
const COMMIT = "a".repeat(40);
const OPERATOR_TOKEN = "synthetic-operator-token";
const OPTIONS: AzureMaintenanceOptions = {
  action: "status", subscription: SUBSCRIPTION, tenant: TENANT, resourceGroup: "example-rg", app: "example-app",
};
const ARGS = ["--subscription", SUBSCRIPTION, "--tenant", TENANT, "--resource-group", "example-rg", "--app", "example-app"];
const state = (draining: boolean, active: boolean) => `${JSON.stringify({ draining, active })}\n`;
const stdout = (value: string) => Buffer.concat([Buffer.from([0, 1]), Buffer.from(value)]);
const ready = state(true, false) + `${DRAIN_READY_MARKER}\n`;
const healthy = `{"status":"ok","sourceCommit":"${COMMIT}"}\n${HEALTH_READY_MARKER}\n`;
const hasCode = (code: string) => (error: unknown) => error instanceof AzureMaintenanceError && error.code === code;

class MockSocket extends EventEmitter implements ExecSocket {
  terminated = false;
  closeRequested = false;
  sent: Buffer[] = [];
  acknowledgeClose = true;

  send(data: Buffer, callback: (error?: Error) => void): void {
    this.sent.push(data);
    callback();
  }

  close(): void {
    this.closeRequested = true;
    this.emit("close-requested");
    if (this.acknowledgeClose) queueMicrotask(() => this.emit("close", 1000));
  }

  terminate(): void {
    this.terminated = true;
  }
}

function fixture(frames: Buffer[] = [stdout(state(false, false))], remoteClose = true) {
  const app = {
    id: RESOURCE,
    location: "South India",
    properties: {
      latestReadyRevisionName: REVISION,
      configuration: { activeRevisionsMode: "Single" },
      template: { containers: [{ name: "app", image: "registry.example/lab:unready" }] },
    },
  };
  const revision = {
    id: REVISION_RESOURCE, name: REVISION,
    properties: { active: true, template: { containers: [{ name: "app", image: IMAGE }] } },
  };
  const replicas = {
    value: [{
      id: `${REVISION_RESOURCE}/replicas/${REPLICA}`, name: REPLICA,
      properties: {
        runningState: "Running",
        containers: [{
          name: "app", ready: true, started: true, runningState: "Running",
          logStreamEndpoint: `https://southindia.azurecontainerapps.dev/subscriptions/${SUBSCRIPTION}/logstream?discard=this`,
        }],
      },
    }],
  };
  const responses = new Map<string, unknown>([
    [RESOURCE, app], [REVISION_RESOURCE, revision], [`${REVISION_RESOURCE}/replicas`, replicas],
    [`${RESOURCE}/getAuthtoken`, { properties: { token: OPERATOR_TOKEN } }],
  ]);
  const requests: { url: URL; init: RequestInit }[] = [];
  const credentialSettings: AzureCliCredentialOptions[] = [];
  const deadlines: number[] = [];
  const socket = new MockSocket();
  let socketCalls = 0;
  let tokenTenant = TENANT;
  const dependencies: AzureMaintenanceDependencies = {
    credential: (settings) => {
      credentialSettings.push(settings);
      return {
        getToken: async (scope, settings) => {
          assert.equal(scope, "https://management.azure.com/.default");
          assert.ok(settings?.abortSignal);
          return {
            token: `synthetic.${Buffer.from(JSON.stringify({ tid: tokenTenant })).toString("base64url")}.signature`,
            expiresOnTimestamp: Date.now() + 3_600_000,
          };
        },
      };
    },
    fetch: async (input, init) => {
      assert.ok(init);
      const url = new URL(String(input));
      requests.push({ url, init });
      assert.equal(url.origin, "https://management.azure.com");
      assert.equal(url.search, "?api-version=2025-01-01");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      assert.match(new Headers(init.headers).get("Authorization") ?? "", /^Bearer synthetic\./u);
      assert.equal(init.method, url.pathname.endsWith("/getAuthtoken") ? "POST" : "GET");
      assert.ok(responses.has(url.pathname), "Unexpected ARM operation");
      return Response.json(responses.get(url.pathname));
    },
    socket: (url, settings) => {
      socketCalls++;
      assert.equal(url.origin, "wss://southindia.azurecontainerapps.dev");
      assert.equal(url.pathname, `/subscriptions/${SUBSCRIPTION}/resourceGroups/example-rg/containerApps/example-app/revisions/${REVISION}/replicas/${REPLICA}/containers/app/exec`);
      assert.deepEqual([...url.searchParams.keys()], ["command"]);
      assert.ok([
        "node /app/packages/deployment/client.ts drain",
        "node /app/packages/deployment/client.ts resume",
        "node /app/packages/deployment/client.ts status",
        "node /app/packages/deployment/health.ts",
      ].includes(url.searchParams.get("command") ?? ""));
      assert.equal(settings.headers?.Authorization, `Bearer ${OPERATOR_TOKEN}`);
      assert.equal(settings.followRedirects, false);
      assert.equal(settings.handshakeTimeout, 10_000);
      assert.equal(settings.maxPayload, OPERATOR_LIMITS.frameBytes);
      assert.equal(settings.perMessageDeflate, false);
      assert.equal(settings.rejectUnauthorized, true);
      queueMicrotask(() => {
        socket.emit("open");
        for (const frame of frames) socket.emit("message", frame, true);
        if (remoteClose) socket.emit("close", 1000);
      });
      return socket;
    },
    deadline: (milliseconds) => {
      deadlines.push(milliseconds);
      return AbortSignal.timeout(milliseconds);
    },
  };
  return {
    app, revision, replicas, responses, requests, credentialSettings, deadlines, socket, dependencies,
    get socketCalls() { return socketCalls; },
    set tokenTenant(value: string) { tokenTenant = value; },
  };
}

test("allowlisted actions require explicit subscription/tenant and reject arbitrary commands/options", () => {
  for (const action of ["drain", "resume", "status", "health"]) {
    assert.equal(parseAzureMaintenanceArgs([action, ...ARGS]).action, action);
  }
  for (const args of [
    [], ["exec", ...ARGS], ["status"], ["status", ...ARGS, "--command", "rm"],
    ["status", ...ARGS, "--app", "other"], ["status", ...ARGS, "--revision"],
    ["status", ...ARGS, "--expected-source-commit", COMMIT], ["status", ...ARGS, "extra"],
    ["status", ...ARGS, "--revision", "../escape"], ["health", ...ARGS, "--expected-source-commit", "main"],
    ["status", ...ARGS.map((arg) => arg === SUBSCRIPTION ? "default" : arg)],
    ["status", ...ARGS.map((arg) => arg === "example-rg" ? "rg/escape" : arg)],
  ]) assert.throws(() => parseAzureMaintenanceArgs(args), hasCode("invalid_arguments"));
});

test("pins credential subscription/tenant, exact ARM paths, selected revision image and framed terminal resize", async () => {
  const f = fixture();
  const result = await runAzureMaintenance({ ...OPTIONS, revision: REVISION, expectedImage: IMAGE }, f.dependencies);
  assert.deepEqual(result, { action: "status", revision: REVISION, image: IMAGE, replica: REPLICA, container: "app", state: { draining: false, active: false } });
  assert.deepEqual(f.credentialSettings, [{ subscription: SUBSCRIPTION, processTimeoutInMs: 10_000 }]);
  assert.equal(f.requests.length, 4);
  assert.equal(f.deadlines[0], 30_000);
  assert.equal(f.deadlines.filter((value) => value === 5_000).length, 4);
  assert.deepEqual(f.socket.sent, [Buffer.concat([Buffer.from([0, 4]), Buffer.from('{"Width":120,"Height":30}')])]);
  assert.equal(f.socket.closeRequested, true);
  assert.equal(f.socket.terminated, true);
});

test("drain accepts progress, fragmented stdout, CRLF and the exact independent ready line", async () => {
  const output = (state(true, true) + ready).replaceAll("\n", "\r\n");
  const f = fixture([Buffer.from([1, 112]), ...Array.from(output, (char) => stdout(char))], false);
  const result = await runAzureMaintenance({ ...OPTIONS, action: "drain" }, f.dependencies);
  assert.deepEqual(result.state, { draining: true, active: false });
  assert.equal(f.deadlines[0], 675_000);
});

test("resume requires admission open; status permits all four truthful boolean states", async () => {
  const resume = await runAzureMaintenance({ ...OPTIONS, action: "resume" }, fixture([stdout(state(false, true))]).dependencies);
  assert.deepEqual(resume.state, { draining: false, active: true });
  for (const draining of [false, true]) {
    for (const active of [false, true]) {
      const result = await runAzureMaintenance(OPTIONS, fixture([stdout(state(draining, active))]).dependencies);
      assert.deepEqual(result.state, { draining, active });
    }
  }
});

test("health requires runtime JSON, exact marker, and optional expected source commit", async () => {
  const result = await runAzureMaintenance(
    { ...OPTIONS, action: "health", expectedSourceCommit: COMMIT.toUpperCase() }, fixture([stdout(healthy)]).dependencies,
  );
  assert.equal(result.health, "ok");
  assert.equal(result.sourceCommit, COMMIT);
  assert.equal(result.state, undefined);
  await assert.rejects(
    runAzureMaintenance({ ...OPTIONS, action: "health", expectedSourceCommit: "b".repeat(40) }, fixture([stdout(healthy)]).dependencies),
    hasCode("source_commit_mismatch"),
  );
});

const invalidOutputs: [AzureMaintenanceOptions["action"], string, string][] = [
  ["drain", "", "exec_marker_missing"],
  ["drain", state(true, false), "exec_marker_missing"],
  ["drain", `${DRAIN_READY_MARKER}\n`, "exec_state_conflict"],
  ["drain", state(true, true) + `${DRAIN_READY_MARKER}\n`, "exec_state_conflict"],
  ["drain", state(false, false) + `${DRAIN_READY_MARKER}\n`, "exec_state_conflict"],
  ["drain", state(true, false) + state(true, true) + `${DRAIN_READY_MARKER}\n`, "exec_state_conflict"],
  ["drain", state(true, false) + `prefix ${DRAIN_READY_MARKER}\n`, "exec_invalid_output"],
  ["drain", state(true, false) + ` ${DRAIN_READY_MARKER}\n`, "exec_invalid_output"],
  ["drain", state(true, false) + `${DRAIN_READY_MARKER} suffix\n`, "exec_invalid_output"],
  ["drain", state(true, false) + `${DRAIN_READY_MARKER}`, "exec_invalid_output"],
  ["drain", ready + state(false, false), "exec_invalid_output"],
  ["drain", ready + "unfinished", "exec_invalid_output"],
  ["drain", state(true, false) + `\u001b[0m${DRAIN_READY_MARKER}\n`, "exec_invalid_output"],
  ["resume", state(true, false), "exec_state_conflict"],
  ["status", '{"draining":"false","active":false}\n', "exec_invalid_output"],
  ["status", '{"draining":false,"active":false,"extra":true}\n', "exec_invalid_output"],
  ["status", '{"draining":false,"draining":true,"active":false}\n', "exec_invalid_output"],
  ["status", '{"draining":false,"draining":true}\n', "exec_invalid_output"],
  ["status", state(false, false) + state(false, false), "exec_invalid_output"],
  ["status", "null\n", "exec_invalid_output"],
  ["status", "<html>ok</html>\n", "exec_invalid_output"],
  ["health", `${HEALTH_READY_MARKER}\n`, "exec_invalid_output"],
  ["health", '{"status":"ok","sourceCommit":"main"}\n', "exec_invalid_output"],
  ["health", '{"status":"ok"}\n', "exec_invalid_output"],
  ["health", `{"status":"ok","sourceCommit":"${COMMIT}"}\n`, "exec_marker_missing"],
];
for (const [index, [action, output, code]] of invalidOutputs.entries()) {
  test(`rejects invalid ${action} output case ${index + 1} without success-shaped fallback`, async () => {
    await assert.rejects(runAzureMaintenance({ ...OPTIONS, action }, fixture([stdout(output)]).dependencies), hasCode(code));
  });
}

test("stderr, proxy errors, unknown channels, invalid UTF8, and late errors all fail", async () => {
  const cases: [Buffer[], string][] = [
    [[Buffer.from([0, 2, 32])], "exec_stderr"],
    [[Buffer.from([2, 112])], "exec_proxy_error"],
    [[Buffer.from([0])], "exec_invalid_frame"],
    [[Buffer.from([0, 4])], "exec_invalid_frame"],
    [[Buffer.from([3])], "exec_invalid_frame"],
    [[Buffer.alloc(0)], "exec_invalid_frame"],
    [[Buffer.from([0, 1, 0xff])], "exec_invalid_output"],
    [[stdout(ready), Buffer.from([0, 2, 101])], "exec_stderr"],
    [[stdout(ready), Buffer.from([2, 101])], "exec_proxy_error"],
    [[stdout(ready), Buffer.from([0, 1, 0xc3])], "exec_invalid_output"],
  ];
  for (const [frames, code] of cases) {
    await assert.rejects(runAzureMaintenance({ ...OPTIONS, action: "drain" }, fixture(frames).dependencies), hasCode(code));
  }
});

test("bounds individual messages and cumulative stdout/info before buffering", async () => {
  for (const frames of [
    [Buffer.alloc(OPERATOR_LIMITS.frameBytes + 1)],
    Array.from({ length: 5 }, () => Buffer.concat([Buffer.from([1]), Buffer.alloc(OPERATOR_LIMITS.frameBytes - 1, 65)])),
    Array.from({ length: 5 }, () => stdout("a".repeat(OPERATOR_LIMITS.frameBytes - 2))),
  ]) await assert.rejects(runAzureMaintenance(OPTIONS, fixture(frames).dependencies), hasCode("exec_output_limit"));
});

test("regional endpoint validation removes display-name whitespace but rejects alternate authorities", () => {
  assert.equal(validatedExecOrigin("https://southindia.azurecontainerapps.dev/path", " South India "), "https://southindia.azurecontainerapps.dev");
  for (const endpoint of [
    "http://southindia.azurecontainerapps.dev/path",
    "https://southindia.azurecontainerapps.dev.evil.example/path",
    "https://eastus.azurecontainerapps.dev/path",
    "https://southindia.azurecontainerapps.dev:8443/path",
    "https://user@southindia.azurecontainerapps.dev/path",
    "https://southindia.azurecontainerapps.dev/#fragment",
    "https://southindia.azurecontainerapps.dev\\evil",
    "https://southindia.azurecontainerapps.dev/\npath",
    "not-a-url", "https://127.0.0.1/path",
  ]) assert.throws(() => validatedExecOrigin(endpoint, "South India"), hasCode("exec_endpoint_invalid"));
  assert.throws(() => validatedExecOrigin("https://southindia.azurecontainerapps.dev/", "South.India"), hasCode("exec_endpoint_invalid"));
});

test("wrong tenant fails before any ARM operation", async () => {
  const f = fixture();
  f.tokenTenant = "33333333-3333-3333-3333-333333333333";
  await assert.rejects(runAzureMaintenance(OPTIONS, f.dependencies), hasCode("tenant_mismatch"));
  assert.equal(f.requests.length, 0);
  assert.equal(f.socketCalls, 0);
});

test("mismatched targets, multiple containers/replicas and paging fail before operator-token acquisition", async () => {
  const cases: [ReturnType<typeof fixture>, Partial<AzureMaintenanceOptions>, string][] = [];
  const manyContainers = fixture();
  manyContainers.app.properties.template.containers.push({ name: "sidecar", image: IMAGE });
  cases.push([manyContainers, {}, "container_count"]);
  const initContainer = fixture();
  initContainer.responses.set(REVISION_RESOURCE, {
    ...initContainer.revision,
    properties: {
      ...initContainer.revision.properties,
      template: { ...initContainer.revision.properties.template, initContainers: [{ name: "init", image: IMAGE }] },
    },
  });
  cases.push([initContainer, {}, "container_count"]);
  const manyReplicas = fixture();
  manyReplicas.replicas.value.push(structuredClone(manyReplicas.replicas.value[0]!));
  cases.push([manyReplicas, {}, "replica_count"]);
  const noReplica = fixture();
  noReplica.replicas.value.length = 0;
  cases.push([noReplica, {}, "replica_count"]);
  const paging = fixture();
  paging.responses.set(`${REVISION_RESOURCE}/replicas`, { ...paging.replicas, nextLink: "https://example.invalid/next" });
  cases.push([paging, {}, "replica_count"]);
  const multiRevision = fixture();
  multiRevision.app.properties.configuration.activeRevisionsMode = "Multiple";
  cases.push([multiRevision, {}, "unsupported_revision_mode"]);
  const notReady = fixture();
  notReady.replicas.value[0]!.properties.containers[0]!.ready = false;
  cases.push([notReady, {}, "replica_not_ready"]);
  const wrongId = fixture();
  wrongId.revision.id = `${RESOURCE}/revisions/example-app--other`;
  cases.push([wrongId, {}, "arm_invalid_response"]);
  cases.push([fixture(), { revision: "example-app--other" }, "revision_mismatch"]);
  cases.push([fixture(), { expectedImage: "registry.example/lab:other" }, "image_mismatch"]);
  for (const [f, options, code] of cases) {
    await assert.rejects(runAzureMaintenance({ ...OPTIONS, ...options }, f.dependencies), hasCode(code));
    assert.equal(f.socketCalls, 0);
    assert.equal(f.requests.some(({ url }) => url.pathname.endsWith("/getAuthtoken")), false);
  }
});

test("the platform-injected healthy http-auth sidecar is not an additional application workload", async () => {
  const f = fixture();
  const replica = f.replicas.value[0];
  assert.ok(replica);
  const application = replica.properties.containers[0];
  assert.ok(application);
  replica.properties.containers.push({ ...application, name: "http-auth" });
  const result = await runAzureMaintenance(OPTIONS, f.dependencies);
  assert.equal(result.container, "app");
  assert.equal(result.image, IMAGE);
  f.app.properties.template.containers.push({ name: "http-auth", image: IMAGE });
  await assert.rejects(runAzureMaintenance(OPTIONS, f.dependencies), hasCode("container_count"));
});

test("an unhealthy auth sidecar cannot be ignored during operator readiness", async () => {
  const f = fixture();
  const replica = f.replicas.value[0];
  assert.ok(replica);
  const application = replica.properties.containers[0];
  assert.ok(application);
  replica.properties.containers.push({ ...application, name: "http-auth", ready: false });
  await assert.rejects(runAzureMaintenance(OPTIONS, f.dependencies), hasCode("replica_not_ready"));
});

test("nullable ARM initContainers means absent, not a hidden additional container", async () => {
  const f = fixture();
  f.responses.set(REVISION_RESOURCE, {
    ...f.revision,
    properties: { ...f.revision.properties, template: { ...f.revision.properties.template, initContainers: null } },
  });
  assert.deepEqual((await runAzureMaintenance(OPTIONS, f.dependencies)).state, { draining: false, active: false });
});

test("ARM rejects redirects, HTTP errors, malformed/oversized bodies, and invalid auth tokens", async () => {
  for (const response of [
    Response.redirect("https://example.invalid/", 302),
    new Response("private upstream payload", { status: 403 }),
    new Response("<html>ok</html>", { headers: { "Content-Type": "text/html" } }),
    new Response("{", { headers: { "Content-Type": "application/json" } }),
    new Response(" ".repeat(OPERATOR_LIMITS.armBytes + 1), { headers: { "Content-Type": "application/json" } }),
  ]) {
    const f = fixture();
    f.dependencies.fetch = async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return response;
    };
    await assert.rejects(runAzureMaintenance(OPTIONS, f.dependencies), (error: unknown) =>
      error instanceof AzureMaintenanceError && ["arm_rejected", "arm_invalid_response"].includes(error.code));
    assert.equal(f.socketCalls, 0);
  }
  const f = fixture();
  f.responses.set(`${RESOURCE}/getAuthtoken`, { properties: { token: "unsafe\r\nheader" } });
  await assert.rejects(runAzureMaintenance(OPTIONS, f.dependencies), hasCode("operator_token_invalid"));
});

test("overall and ARM deadlines terminate hanging work with fixed codes", async () => {
  for (const phase of ["credential", "arm", "socket"]) {
    const f = fixture([], false);
    const abort = new AbortController();
    f.dependencies.deadline = (milliseconds) => phase === "arm" && milliseconds === 5_000 || phase !== "arm" && milliseconds === 30_000
      ? abort.signal : AbortSignal.timeout(milliseconds);
    if (phase === "credential") f.dependencies.credential = () => ({ getToken: async () => new Promise(() => {}) });
    if (phase === "arm") f.dependencies.fetch = async () => new Promise(() => {});
    const timer = setTimeout(() => abort.abort(), 20);
    try {
      await assert.rejects(runAzureMaintenance(OPTIONS, f.dependencies), hasCode(phase === "arm" ? "arm_timeout" : "deadline_exceeded"));
      if (phase === "socket") assert.equal(f.socket.terminated, true);
    } finally {
      clearTimeout(timer);
    }
  }
});

test("nonbinary/proxy handshake/transport errors and abnormal close never report success", async () => {
  for (const [event, payload, code] of [
    ["message", stdout(state(false, false)), "exec_invalid_frame"],
    ["unexpected-response", undefined, "exec_handshake_failed"],
    ["error", new Error("private payload and token"), "exec_transport_failed"],
    ["close", 1006, "exec_transport_failed"],
  ] as const) {
    const f = fixture([], false);
    f.dependencies.socket = () => {
      queueMicrotask(() => f.socket.emit(event, payload, false));
      return f.socket;
    };
    await assert.rejects(runAzureMaintenance(OPTIONS, f.dependencies), hasCode(code));
    assert.equal(f.socket.terminated, true);
  }
});

test("proof does not hide a missing close acknowledgement or a resize send failure", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([stdout(ready)], false);
  f.socket.acknowledgeClose = false;
  const closing = once(f.socket, "close-requested");
  const result = runAzureMaintenance({ ...OPTIONS, action: "drain" }, f.dependencies);
  await closing;
  context.mock.timers.tick(OPERATOR_LIMITS.closeMs);
  await assert.rejects(result, hasCode("exec_close_timeout"));
  assert.equal(f.socket.terminated, true);
  context.mock.timers.reset();
  const failure = fixture();
  failure.socket.send = () => { throw new Error("private details"); };
  await assert.rejects(runAzureMaintenance(OPTIONS, failure.dependencies), hasCode("exec_transport_failed"));
});

test("CLI outputs only verified fields or a fixed error, never raw payloads/URLs/tokens", async () => {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const io = { stdout: (line: string) => { stdoutLines.push(line); }, stderr: (line: string) => { stderrLines.push(line); } };
  assert.equal(await runAzureMaintenanceCli(["status", ...ARGS], io, fixture().dependencies), 0);
  assert.deepEqual(Object.keys(JSON.parse(stdoutLines[0]!)), ["action", "revision", "image", "replica", "container", "state"]);
  stdoutLines.length = 0;
  const f = fixture();
  f.dependencies.credential = () => { throw new Error(`private-payload https://example.invalid/ ${OPERATOR_TOKEN}`); };
  assert.equal(await runAzureMaintenanceCli(["status", ...ARGS], io, f.dependencies), 1);
  assert.deepEqual(stdoutLines, []);
  assert.deepEqual(stderrLines, ['{"error":"authentication_failed"}']);
  assert.equal(await runAzureMaintenanceCli(["exec", ...ARGS], io, f.dependencies), 2);
});

test("native non-TTY WebSocket sends binary resize and closes only after validated proof", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let resize: Buffer | undefined;
  wss.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${OPERATOR_TOKEN}`);
    socket.on("message", (data, binary) => {
      assert.equal(binary, true);
      assert.ok(Buffer.isBuffer(data));
      resize = data;
      socket.send(Buffer.from([1, 79, 75]));
      socket.send(stdout(ready));
    });
  });
  const f = fixture();
  f.dependencies.socket = (_url, settings) => new WebSocket(`ws://127.0.0.1:${address.port}`, settings);
  try {
    const result = await runAzureMaintenance({ ...OPTIONS, action: "drain" }, f.dependencies);
    assert.deepEqual(result.state, { draining: true, active: false });
    assert.deepEqual(resize?.subarray(0, 2), Buffer.from([0, 4]));
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("native WebSocket rejects handshake redirects and enforces a bounded handshake", async () => {
  for (const mode of ["redirect", "stall"]) {
    const connections = new Set<Socket>();
    let upgrades = 0;
    const server = createServer();
    server.on("connection", (socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
    });
    server.on("upgrade", (_request, socket) => {
      upgrades++;
      if (mode === "redirect") {
        socket.end("HTTP/1.1 302 Found\r\nLocation: /second\r\nContent-Length: 0\r\n\r\n");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const f = fixture();
    f.dependencies.socket = (_url, settings) => {
      assert.equal(settings.handshakeTimeout, 10_000);
      return new WebSocket(`ws://127.0.0.1:${address.port}`, { ...settings, handshakeTimeout: 30 });
    };
    try {
      await assert.rejects(runAzureMaintenance(OPTIONS, f.dependencies),
        hasCode(mode === "redirect" ? "exec_handshake_failed" : "exec_transport_failed"));
      assert.equal(upgrades, 1);
    } finally {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, request } from "node:http";
import type { RequestListener } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  MaintenanceGate,
  MaintenanceDrainingError,
  MaintenanceClientError,
  startMaintenanceListener,
  runMaintenanceCommand,
  runMaintenanceCli,
  DEFAULT_MAINTENANCE_PORT,
  DRAIN_TIMEOUT_MS,
  STATUS_POLL_INTERVAL_MS,
  DRAIN_READY_MARKER,
} from "../packages/deployment/index.ts";
import type { MaintenanceCommand, MaintenanceStatus } from "../packages/deployment/index.ts";

const execute = promisify(execFile);
const clientFile = fileURLToPath(new URL(
  import.meta.url.endsWith(".ts") ? "../packages/deployment/client.ts" : "../packages/deployment/client.js",
  import.meta.url,
));

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout, stderr,
    io: { stdout: (line: string) => { stdout.push(line); }, stderr: (line: string) => { stderr.push(line); } },
  };
}

async function fixture(t: TestContext, initialActive = false) {
  const gate = new MaintenanceGate();
  let active = initialActive;
  const listener = await startMaintenanceListener({ gate, active: () => active, port: 0 });
  t.after(() => listener.close());
  return { gate, listener, setActive(value: boolean) { active = value; } };
}

function call(port: number, method = "GET", path = "/status", body?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number | undefined; body: string; error: string | string[] | undefined; remote: string | undefined; allow: string | undefined }>((resolve, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1", port, method, path, agent: false,
      headers: {
        ...(body !== undefined && headers["Transfer-Encoding"] === undefined ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
        ...headers,
      },
    }, (response) => {
      const remote = response.socket.remoteAddress;
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode, body: text, error: response.headers["x-maintenance-error"],
        remote, allow: response.headers.allow,
      }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

async function rawServer(t: TestContext, handler: RequestListener): Promise<number> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

test("gate is synchronous, blocks admission, and never releases an existing reservation", () => {
  const gate = new MaintenanceGate();
  let active = false;
  const reserve = () => {
    gate.assertAccepting();
    if (active) throw new Error("active_reservation");
    active = true;
    return () => { active = false; };
  };
  const close = reserve();
  assert.equal(gate.beginDrain(), undefined);
  assert.equal(gate.isDraining, true);
  assert.equal(active, true);
  assert.throws(reserve, MaintenanceDrainingError);
  gate.beginDrain();
  assert.equal(active, true);
  gate.resume();
  assert.equal(gate.isDraining, false);
  assert.throws(reserve, /active_reservation/);
  gate.beginDrain();
  close();
  assert.equal(active, false);
  assert.throws(reserve, (error: unknown) => error instanceof MaintenanceDrainingError && error.code === "MAINTENANCE_DRAINING");
  gate.resume();
  gate.resume();
  reserve()();
  assert.equal(active, false);
});

test("loopback endpoints expose exactly draining/active and preserve active work through drain/resume", async (t) => {
  const f = await fixture(t, true);
  assert.equal(f.listener.host, "127.0.0.1");
  assert.ok(f.listener.port > 0);
  const status = await call(f.listener.port);
  assert.equal(status.remote, "127.0.0.1");
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.body), { draining: false, active: true });
  const drained = await call(f.listener.port, "POST", "/drain");
  assert.deepEqual(JSON.parse(drained.body), { draining: true, active: true });
  assert.throws(() => f.gate.assertAccepting(), MaintenanceDrainingError);
  assert.deepEqual(JSON.parse((await call(f.listener.port, "POST", "/drain")).body), { draining: true, active: true });
  assert.deepEqual(JSON.parse((await call(f.listener.port, "POST", "/resume")).body), { draining: false, active: true });
  f.gate.beginDrain();
  f.setActive(false);
  assert.deepEqual(JSON.parse((await call(f.listener.port)).body), { draining: true, active: false });
  await call(f.listener.port, "POST", "/resume");
  assert.doesNotThrow(() => f.gate.assertAccepting());
});

test("methods, paths, request bodies and query strings are strict and cannot change admission", async (t) => {
  const f = await fixture(t);
  for (const [method, path, status] of [
    ["GET", "/drain", 405], ["POST", "/status", 405], ["DELETE", "/resume", 405],
    ["HEAD", "/status", 405], ["OPTIONS", "/status", 405],
    ["GET", "/api/session", 404], ["POST", "/drain?force=true", 404], ["GET", "/status/", 404],
  ] as const) {
    const response = await call(f.listener.port, method, path);
    assert.equal(response.status, status);
    assert.equal(response.body, "");
    assert.ok(response.error);
    if (status === 405) assert.equal(response.allow, path === "/status" ? "GET" : "POST");
    assert.equal(f.gate.isDraining, false);
  }
  for (const [method, path, body] of [
    ["POST", "/drain", "{}"], ["POST", "/resume", " "], ["GET", "/status", "{}"],
  ]) {
    const response = await call(f.listener.port, method, path, body);
    assert.equal(response.status, 400);
    assert.equal(response.error, "body_not_allowed");
    assert.equal(response.body, "");
    assert.equal(f.gate.isDraining, false);
  }
  const chunked = await call(f.listener.port, "POST", "/drain", "", { "Transfer-Encoding": "chunked" });
  assert.equal(chunked.status, 400);
  assert.equal(f.gate.isDraining, false);
  const empty = await call(f.listener.port, "POST", "/drain", "");
  assert.equal(empty.status, 200);
  assert.equal(f.gate.isDraining, true);
});

test("browser-origin and non-loopback authority requests cannot invoke maintenance", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { Host: `example.invalid:${f.listener.port}` },
    { Origin: "https://example.invalid" },
    { Origin: "null" },
    { "Sec-Fetch-Site": "cross-site" },
  ]) {
    const response = await call(f.listener.port, "POST", "/drain", undefined, headers);
    assert.equal(response.status, 403);
    assert.equal(response.body, "");
    assert.equal(f.gate.isDraining, false);
  }
});

test("callback failures or nonboolean active state fail explicitly without exposing private details", async (t) => {
  const invalid: unknown = { userId: "PRIVATE_SESSION_CONTENT" };
  for (const active of [
    (): boolean => { throw new Error("PRIVATE_SESSION_CONTENT"); },
    (): boolean => invalid as boolean,
  ]) {
    const gate = new MaintenanceGate();
    const listener = await startMaintenanceListener({ gate, active, port: 0 });
    t.after(() => listener.close());
    const response = await call(listener.port, "POST", "/drain");
    assert.equal(response.status, 503);
    assert.equal(response.body, "");
    assert.ok(response.error);
    assert.equal(JSON.stringify(response).includes("PRIVATE_SESSION_CONTENT"), false);
    assert.equal(gate.isDraining, true);
    assert.throws(() => gate.assertAccepting(), MaintenanceDrainingError);
    const resumed = await call(listener.port, "POST", "/resume");
    assert.equal(resumed.status, 503);
    assert.equal(gate.isDraining, true);
  }
});

test("listener validates ports, reports bind failure, and closes idempotently", async (t) => {
  const gate = new MaintenanceGate();
  for (const port of [-1, 65_536, 3.5, NaN, Infinity, "3001", null]) {
    await assert.rejects(startMaintenanceListener({ gate, active: () => false, port: port as number }), RangeError);
  }
  const first = await fixture(t);
  await assert.rejects(startMaintenanceListener({ gate, active: () => false, port: first.listener.port }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EADDRINUSE");
  const closing = first.listener.close();
  assert.equal(first.listener.close(), closing);
  await closing;
});

test("real drain waits for the parent to close its reservation and leaves admission blocked", async (t) => {
  const f = await fixture(t, true);
  let now = 0;
  const waits: number[] = [];
  const statuses: MaintenanceStatus[] = [];
  const result = await runMaintenanceCommand("drain", {
    port: f.listener.port,
    onStatus: (status) => statuses.push(status),
  }, {
    now: () => now,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      assert.throws(() => f.gate.assertAccepting(), MaintenanceDrainingError);
      assert.deepEqual(JSON.parse((await call(f.listener.port)).body), { draining: true, active: true });
      now += milliseconds;
      f.setActive(false);
    },
  });
  assert.deepEqual(waits, [5_000]);
  assert.deepEqual(statuses, [{ draining: true, active: true }, { draining: true, active: false }]);
  assert.deepEqual(result, { draining: true, active: false });
  assert.equal(f.gate.isDraining, true);
});

test("a drain deadline leaves the real gate blocked and the active reservation untouched", async (t) => {
  const f = await fixture(t, true);
  let now = 0;
  await assert.rejects(runMaintenanceCommand("drain", { port: f.listener.port, timeoutMs: 5_000 }, {
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  }), (error: unknown) => error instanceof MaintenanceClientError && error.code === "drain_timeout");
  assert.equal(now, 5_000);
  assert.throws(() => f.gate.assertAccepting(), MaintenanceDrainingError);
  assert.deepEqual(JSON.parse((await call(f.listener.port)).body), { draining: true, active: true });
});

test("CLI drain has an exact eleven-minute bound, low-rate polling, nonzero timeout, and no readiness marker", async () => {
  const output = capture();
  let now = 0;
  const calls: { at: number; command: MaintenanceCommand; timeout: number }[] = [];
  const sleeps: number[] = [];
  const exit = await runMaintenanceCli(["drain"], {}, output.io, {
    now: () => now,
    request: async (port, command, timeout) => {
      assert.equal(port, DEFAULT_MAINTENANCE_PORT);
      calls.push({ at: now, command, timeout });
      return { draining: true, active: true };
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
  });
  assert.equal(exit, 1);
  assert.equal(now, DRAIN_TIMEOUT_MS);
  assert.equal(now, 660_000);
  assert.equal(calls.length, 132);
  assert.equal(calls[0]?.command, "drain");
  assert.ok(calls.slice(1).every((call) => call.command === "status"));
  assert.ok(sleeps.every((milliseconds) => milliseconds === STATUS_POLL_INTERVAL_MS));
  assert.ok(calls.every((call) => call.timeout <= 5_000 && call.timeout <= DRAIN_TIMEOUT_MS - call.at));
  assert.ok(calls.every((call, index) => index === 0 || call.at - (calls[index - 1]?.at ?? 0) === 5_000));
  assert.ok(output.stderr.includes("maintenance failed: drain_timeout"));
  assert.ok(!output.stdout.includes(DRAIN_READY_MARKER));
});

test("request time consumes the total drain budget and readiness arriving at the deadline fails", async () => {
  let now = 0;
  const calls: number[] = [];
  await assert.rejects(runMaintenanceCommand("drain", { port: 3001, timeoutMs: 1_001 }, {
    now: () => now,
    request: async (_port, _command, timeout) => {
      calls.push(timeout);
      now += 600;
      return { draining: true, active: true };
    },
    sleep: async (milliseconds) => { assert.equal(milliseconds, 401); now += milliseconds; },
  }), (error: unknown) => error instanceof MaintenanceClientError && error.code === "drain_timeout");
  assert.deepEqual(calls, [1_001]);
  assert.equal(now, 1_001);
  now = 0;
  const output = capture();
  const exit = await runMaintenanceCli(["drain"], {}, output.io, {
    now: () => now,
    request: async () => { now = DRAIN_TIMEOUT_MS; return { draining: true, active: false }; },
  });
  assert.equal(exit, 1);
  assert.ok(!output.stdout.includes(DRAIN_READY_MARKER));
});

test("a concurrent resume interrupts draining; inactivity alone is never readiness", async () => {
  let now = 0;
  let calls = 0;
  const output = capture();
  const exit = await runMaintenanceCli(["drain"], {}, output.io, {
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    request: async () => ++calls === 1 ? { draining: true, active: true } : { draining: false, active: false },
  });
  assert.equal(exit, 1);
  assert.equal(calls, 2);
  assert.deepEqual(output.stderr, ["maintenance failed: drain_interrupted"]);
  assert.ok(!output.stdout.includes(DRAIN_READY_MARKER));
});

test("only successful drain emits one exact readiness line; status and resume never emit it", async () => {
  for (const command of ["drain", "status", "resume"] as const) {
    const output = capture();
    const exit = await runMaintenanceCli([command], { MAINTENANCE_PORT: "12345" }, output.io, {
      now: () => 0,
      request: async (port, requested) => {
        assert.equal(port, 12345);
        assert.equal(requested, command);
        return { draining: command !== "resume", active: false };
      },
    });
    assert.equal(exit, 0);
    assert.equal(output.stdout.filter((line) => line === DRAIN_READY_MARKER).length, command === "drain" ? 1 : 0);
    assert.deepEqual(JSON.parse(output.stdout[0] ?? ""), { draining: command !== "resume", active: false });
    assert.deepEqual(output.stderr, []);
  }
});

test("resume is nonzero when the endpoint has not reopened admission", async () => {
  const output = capture();
  const exit = await runMaintenanceCli(["resume"], {}, output.io, {
    now: () => 0,
    request: async () => ({ draining: true, active: false }),
  });
  assert.equal(exit, 1);
  assert.deepEqual(output.stderr, ["maintenance failed: resume_failed"]);
  assert.ok(!output.stdout.includes(DRAIN_READY_MARKER));
});

test("HTTP failures, malformed/extra status fields, oversized responses and redirects never produce readiness", async (t) => {
  let status = 200;
  let type = "application/json";
  let payload = "";
  const port = await rawServer(t, (_request, response) => {
    response.writeHead(status, { "Content-Type": type, Location: "https://example.invalid/" });
    response.end(payload);
  });
  for (const value of [
    null, [], {}, { draining: "true", active: false }, { draining: true, active: null },
    { draining: true, active: false, private: DRAIN_READY_MARKER },
  ]) {
    payload = JSON.stringify(value);
    const output = capture();
    assert.equal(await runMaintenanceCli(["drain"], { MAINTENANCE_PORT: String(port) }, output.io), 1);
    assert.deepEqual(output.stdout, []);
    assert.deepEqual(output.stderr, ["maintenance failed: invalid_response"]);
  }
  for (const [code, contentType, body, error] of [
    [200, "application/json", "{", "invalid_response"],
    [200, "application/json", "x".repeat(1_024), "invalid_response"],
    [200, "text/plain", '{"draining":true,"active":false}', "invalid_response"],
    [503, "application/json", "PRIVATE_SESSION_CONTENT", "http_error"],
    [302, "application/json", '{"draining":true,"active":false}', "http_error"],
  ] as const) {
    status = code;
    type = contentType;
    payload = body;
    const output = capture();
    assert.equal(await runMaintenanceCli(["drain"], { MAINTENANCE_PORT: String(port) }, output.io), 1);
    assert.deepEqual(output.stdout, []);
    assert.deepEqual(output.stderr, [`maintenance failed: ${error}`]);
  }
});

test("a nonresponsive HTTP listener is bounded by the client request timeout", { timeout: 5_000 }, async (t) => {
  const port = await rawServer(t, () => {});
  await assert.rejects(runMaintenanceCommand("status", { port, requestTimeoutMs: 50 }),
    (error: unknown) => error instanceof MaintenanceClientError && error.code === "request_timeout");
});

test("invalid client arguments, environment, options and clocks fail without network work", async () => {
  let requests = 0;
  const dependencies = { request: async () => { requests += 1; return { draining: true, active: false }; } };
  for (const args of [[], ["unknown"], ["drain", "extra"]]) {
    const output = capture();
    assert.equal(await runMaintenanceCli(args, {}, output.io, dependencies), 2);
    assert.deepEqual(output.stdout, []);
  }
  for (const value of ["", "0", "-1", "65536", "localhost:3001", " 3001", "3.5", "PRIVATE_TOKEN"]) {
    const output = capture();
    assert.equal(await runMaintenanceCli(["drain"], { MAINTENANCE_PORT: value }, output.io, dependencies), 2);
    assert.deepEqual(output.stdout, []);
    assert.deepEqual(output.stderr, ["maintenance failed: invalid_port"]);
  }
  for (const options of [
    { timeoutMs: 0 }, { timeoutMs: DRAIN_TIMEOUT_MS + 1 }, { pollIntervalMs: 999 },
    { pollIntervalMs: 60_001 }, { requestTimeoutMs: 0 }, { requestTimeoutMs: 5_001 },
  ]) await assert.rejects(runMaintenanceCommand("drain", { port: 3001, ...options }, dependencies));
  for (const clock of [-1, NaN, Infinity]) {
    await assert.rejects(runMaintenanceCommand("drain", { port: 3001 }, { ...dependencies, now: () => clock }));
  }
  assert.equal(requests, 0);
});

test("source CLI executes with MAINTENANCE_PORT and exposes process failure codes safely", async (t) => {
  const f = await fixture(t);
  const env = { ...process.env, MAINTENANCE_PORT: String(f.listener.port) };
  const options = { env, timeout: 5_000, windowsHide: true };
  const status = await execute(process.execPath, [clientFile, "status"], options);
  assert.deepEqual(JSON.parse(status.stdout), { draining: false, active: false });
  const drain = await execute(process.execPath, [clientFile, "drain"], options);
  assert.deepEqual(drain.stdout.trim().split(/\r?\n/u), ['{"draining":true,"active":false}', DRAIN_READY_MARKER]);
  assert.equal(f.gate.isDraining, true);
  const resume = await execute(process.execPath, [clientFile, "resume"], options);
  assert.deepEqual(JSON.parse(resume.stdout), { draining: false, active: false });
  await assert.rejects(execute(process.execPath, [clientFile, "invalid"], options), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error && "stdout" in error);
    assert.equal(error.code, 2);
    assert.equal(error.stdout, "");
    return true;
  });
  const badPort = await rawServer(t, (_request, response) => { response.writeHead(503); response.end("PRIVATE_SESSION_CONTENT"); });
  await assert.rejects(execute(process.execPath, [clientFile, "drain"], {
    ...options, env: { ...env, MAINTENANCE_PORT: String(badPort) },
  }), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error && "stdout" in error && "stderr" in error);
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.equal(error.stderr, "maintenance failed: http_error\n");
    return true;
  });
});

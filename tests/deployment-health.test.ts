import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import {
  checkRuntimeHealth, HEALTH_READY_MARKER, HEALTH_TIMEOUT_MS, RuntimeHealthError, runRuntimeHealthCli,
} from "../packages/deployment/health.ts";
import type { RuntimeHealthDependencies } from "../packages/deployment/health.ts";

const COMMIT = "a".repeat(40);

async function withLoopback(
  respond: (response: ServerResponse) => void,
  run: (dependencies: RuntimeHealthDependencies) => Promise<void>,
) {
  const server = createServer((incoming, response) => {
    assert.equal(incoming.url, "/health/live");
    assert.equal(incoming.method, "GET");
    assert.equal(incoming.headers.authorization, undefined);
    respond(response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const dependencies: RuntimeHealthDependencies = {
    request: (settings, callback) => {
      assert.equal(settings.hostname, "127.0.0.1");
      assert.equal(settings.port, 3000);
      assert.equal(settings.path, "/health/live");
      assert.equal(settings.agent, false);
      return request({ ...settings, port: address.port }, callback);
    },
    signal: () => AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  };
  try {
    await run(dependencies);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("runtime health checks only the dedicated loopback path and emits exact proof with normalized commit", async () => {
  await withLoopback((response) => {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end('{"status":"ok"}');
  }, async (dependencies) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runRuntimeHealthCli([], { SOURCE_COMMIT: COMMIT.toUpperCase(), PORT: "1234" }, {
      stdout: (line) => { stdout.push(line); }, stderr: (line) => { stderr.push(line); },
    }, dependencies);
    assert.equal(code, 0);
    assert.deepEqual(stdout, [`{"status":"ok","sourceCommit":"${COMMIT}"}`, HEALTH_READY_MARKER]);
    assert.deepEqual(stderr, []);
    assert.equal((await checkRuntimeHealth({ SOURCE_COMMIT: "B".repeat(64) }, dependencies)).sourceCommit, "b".repeat(64));
  });
});

test("missing/malformed source commits and arbitrary arguments cannot produce health proof", async () => {
  for (const commit of [undefined, "", "main", "a".repeat(39), "a".repeat(65), `${COMMIT}\n`]) {
    await assert.rejects(checkRuntimeHealth({ SOURCE_COMMIT: commit }), (error: unknown) =>
      error instanceof RuntimeHealthError && error.code === "source_commit_invalid");
  }
  const lines: string[] = [];
  assert.equal(await runRuntimeHealthCli(["anything"], {}, {
    stdout: (line) => { lines.push(line); }, stderr: (line) => { lines.push(line); },
  }), 2);
  assert.deepEqual(lines, ["health failed: invalid_arguments"]);
});

test("fallback HTML, extra/duplicate fields, malformed JSON, redirects and non-200 are never healthy", async () => {
  const cases: [number, string, string][] = [
    [200, "text/html", "<html>ok</html>"],
    [200, "application/json", '{"status":"ok","extra":true}'],
    [200, "application/json", '{"status":"bad","status":"ok"}'],
    [200, "application/json", '{"status":"ok"} trailing'],
    [200, "application/json", "null"],
    [200, "application/json", '{"status":true}'],
    [200, "application/json", '{"status":"OK"}'],
    [200, "application/json", '\u00a0{"status":"ok"}'],
    [200, "application/json", " ".repeat(300)],
    [302, "application/json", '{"status":"ok"}'],
    [503, "application/json", '{"status":"ok"}'],
  ];
  for (const [status, type, body] of cases) {
    await withLoopback((response) => {
      response.writeHead(status, { "Content-Type": type, Location: "http://example.invalid/" });
      response.end(body);
    }, async (dependencies) => {
      await assert.rejects(checkRuntimeHealth({ SOURCE_COMMIT: COMMIT }, dependencies), (error: unknown) =>
        error instanceof RuntimeHealthError && ["health_rejected", "health_invalid_response"].includes(error.code));
    });
  }
});

test("stalled loopback response is aborted and only a fixed failure code is emitted", async () => {
  await withLoopback((response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"status":');
  }, async (dependencies) => {
    const abort = new AbortController();
    dependencies.signal = () => abort.signal;
    const lines: string[] = [];
    const timer = setTimeout(() => abort.abort(), 20);
    try {
      assert.equal(await runRuntimeHealthCli([], { SOURCE_COMMIT: COMMIT }, {
        stdout: (line) => { lines.push(line); }, stderr: (line) => { lines.push(line); },
      }, dependencies), 1);
      assert.deepEqual(lines, ["health failed: health_request_failed"]);
    } finally {
      clearTimeout(timer);
    }
  });
});

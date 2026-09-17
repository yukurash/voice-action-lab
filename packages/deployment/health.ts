import { request } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

export const HEALTH_READY_MARKER = "VOICE_ACTION_LAB_HEALTH_READY";
export const HEALTH_TIMEOUT_MS = 5_000;

export function isSourceCommit(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(value);
}

export class RuntimeHealthError extends Error {
  readonly code: "source_commit_invalid" | "health_rejected" | "health_invalid_response" | "health_request_failed";

  constructor(code: RuntimeHealthError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface RuntimeHealthDependencies {
  request: (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
  signal: () => AbortSignal;
}

export interface RuntimeHealthResult {
  status: "ok";
  sourceCommit: string;
}

export async function checkRuntimeHealth(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  overrides: Partial<RuntimeHealthDependencies> = {},
): Promise<RuntimeHealthResult> {
  const commit = environment.SOURCE_COMMIT;
  if (!isSourceCommit(commit)) throw new RuntimeHealthError("source_commit_invalid");
  const dependencies: RuntimeHealthDependencies = {
    request,
    signal: () => AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    ...overrides,
  };
  const options: RequestOptions = {
    hostname: "127.0.0.1",
    port: 3000,
    path: "/health/live",
    method: "GET",
    agent: false,
    headers: { Accept: "application/json" },
    signal: dependencies.signal(),
  };
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (code: RuntimeHealthError["code"]) => {
      if (settled) return;
      settled = true;
      connection.destroy();
      reject(new RuntimeHealthError(code));
    };
    const connection = dependencies.request(options, (response) => {
      if (response.statusCode !== 200) {
        fail("health_rejected");
        response.destroy();
        return;
      }
      if (response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        fail("health_invalid_response");
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 256) {
          fail("health_invalid_response");
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", () => fail("health_request_failed"));
      response.on("aborted", () => fail("health_request_failed"));
      response.on("end", () => {
        if (settled) return;
        // The dedicated route has one field; duplicate keys and SPA HTML are not health evidence.
        if (!/^[ \t\r\n]*\{[ \t\r\n]*"status"[ \t\r\n]*:[ \t\r\n]*"ok"[ \t\r\n]*\}[ \t\r\n]*$/u.test(Buffer.concat(chunks).toString("utf8"))) {
          fail("health_invalid_response");
          return;
        }
        settled = true;
        resolve();
      });
    });
    connection.on("error", () => fail("health_request_failed"));
    connection.end();
  });
  return { status: "ok", sourceCommit: commit.toLowerCase() };
}

export async function runRuntimeHealthCli(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  io = {
    stdout: (line: string) => { process.stdout.write(`${line}\n`); },
    stderr: (line: string) => { process.stderr.write(`${line}\n`); },
  },
  overrides: Partial<RuntimeHealthDependencies> = {},
): Promise<number> {
  if (argv.length !== 0) {
    io.stderr("health failed: invalid_arguments");
    return 2;
  }
  try {
    const result = await checkRuntimeHealth(environment, overrides);
    io.stdout(JSON.stringify(result));
    io.stdout(HEALTH_READY_MARKER);
    return 0;
  } catch (error: unknown) {
    io.stderr(`health failed: ${error instanceof RuntimeHealthError ? error.code : "health_request_failed"}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runRuntimeHealthCli(process.argv.slice(2));

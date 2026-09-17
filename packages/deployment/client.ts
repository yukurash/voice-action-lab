import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DEFAULT_MAINTENANCE_PORT,
  DRAIN_READY_MARKER,
  DRAIN_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  STATUS_POLL_INTERVAL_MS,
  isMaintenanceStatus,
  validatePort,
} from "./protocol.ts";
import type { MaintenanceCommand, MaintenanceStatus } from "./protocol.ts";

export class MaintenanceClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MaintenanceClientError";
    this.code = code;
  }
}

export interface MaintenanceClientOptions {
  port: number;
  /** Positive integer, at most 660000. Default: eleven minutes. */
  timeoutMs?: number;
  /** 1000..60000; default 5000. */
  pollIntervalMs?: number;
  /** Positive integer, at most 5000; also capped by the remaining total deadline. */
  requestTimeoutMs?: number;
  onStatus?: (status: MaintenanceStatus) => void;
}

export interface MaintenanceClientDependencies {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  request: (port: number, command: MaintenanceCommand, timeoutMs: number) => Promise<MaintenanceStatus>;
}

export interface MaintenanceClientIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function requestStatus(port: number, command: MaintenanceCommand, timeoutMs: number): Promise<MaintenanceStatus> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: MaintenanceClientError) => {
      if (settled) return;
      settled = true;
      connection.destroy();
      reject(error);
    };
    const connection = request({
      hostname: "127.0.0.1",
      port,
      path: `/${command}`,
      method: command === "status" ? "GET" : "POST",
      agent: false,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json", "Content-Length": "0" },
    }, (response) => {
      if (response.statusCode !== 200) {
        fail(new MaintenanceClientError("http_error", "Maintenance endpoint rejected the request."));
        response.destroy();
        return;
      }
      if (response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        fail(new MaintenanceClientError("invalid_response", "Maintenance response must be JSON."));
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 256) {
          fail(new MaintenanceClientError("invalid_response", "Maintenance response exceeded its size limit."));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", (error: Error) => fail(new MaintenanceClientError(
        "request_failed", "Maintenance response was interrupted.", { cause: error },
      )));
      response.on("aborted", () => fail(new MaintenanceClientError("request_failed", "Maintenance response was interrupted.")));
      response.on("end", () => {
        if (settled) return;
        let value: unknown;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (error: unknown) {
          fail(new MaintenanceClientError("invalid_response", "Maintenance response was not valid JSON.", { cause: error }));
          return;
        }
        if (!isMaintenanceStatus(value)) {
          fail(new MaintenanceClientError("invalid_response", "Maintenance response must contain exactly two boolean status fields."));
          return;
        }
        settled = true;
        resolve({ draining: value.draining, active: value.active });
      });
    });
    connection.on("error", (error: Error) => fail(new MaintenanceClientError(
      error.name === "AbortError" ? "request_timeout" : "request_failed",
      "Maintenance request failed or timed out.",
      { cause: error },
    )));
    connection.end();
  });
}

function positiveInteger(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new MaintenanceClientError("invalid_options", "Invalid maintenance timeout or polling interval.");
  }
  return value;
}

/** No automatic resume on failure: the admission gate remains fail-closed. */
export async function runMaintenanceCommand(
  command: MaintenanceCommand,
  options: MaintenanceClientOptions,
  overrides: Partial<MaintenanceClientDependencies> = {},
): Promise<MaintenanceStatus> {
  if (command !== "drain" && command !== "resume" && command !== "status") {
    throw new MaintenanceClientError("invalid_arguments", "Expected drain, resume, or status.");
  }
  const port = validatePort(options.port);
  const timeout = positiveInteger(options.timeoutMs === undefined ? DRAIN_TIMEOUT_MS : options.timeoutMs, DRAIN_TIMEOUT_MS);
  const poll = positiveInteger(options.pollIntervalMs === undefined ? STATUS_POLL_INTERVAL_MS : options.pollIntervalMs, 60_000);
  if (poll < 1_000) throw new MaintenanceClientError("invalid_options", "Status polling must be at least one second apart.");
  const requestTimeout = positiveInteger(options.requestTimeoutMs === undefined ? REQUEST_TIMEOUT_MS : options.requestTimeoutMs, REQUEST_TIMEOUT_MS);
  const dependencies: MaintenanceClientDependencies = {
    now: () => performance.now(),
    sleep: async (milliseconds) => { await sleep(milliseconds); },
    request: requestStatus,
    ...overrides,
  };
  let previousTime = 0;
  const now = () => {
    const value = dependencies.now();
    if (!Number.isFinite(value) || value < previousTime) {
      throw new MaintenanceClientError("invalid_clock", "Maintenance clock must be finite and monotonic.");
    }
    previousTime = value;
    return value;
  };
  const deadline = now() + timeout;
  const remaining = () => {
    const value = deadline - now();
    if (value <= 0) {
      throw new MaintenanceClientError(
        command === "drain" ? "drain_timeout" : "request_timeout",
        "Maintenance deadline expired before completion.",
      );
    }
    return value;
  };
  let nextCommand = command;
  for (;;) {
    const status = await dependencies.request(port, nextCommand, Math.ceil(Math.min(requestTimeout, remaining())));
    remaining();
    if (!isMaintenanceStatus(status)) {
      throw new MaintenanceClientError("invalid_response", "Maintenance status has an invalid shape.");
    }
    options.onStatus?.({ draining: status.draining, active: status.active });
    if (command === "resume" && status.draining) {
      throw new MaintenanceClientError("resume_failed", "Admission is still draining after resume.");
    }
    if (command !== "drain") return status;
    if (!status.draining) throw new MaintenanceClientError("drain_interrupted", "Admission resumed before drain readiness.");
    if (!status.active) return status;
    await dependencies.sleep(Math.min(poll, remaining()));
    nextCommand = "status";
  }
}

/** JSON status lines go to stdout. Only a successful drain emits DRAIN_READY_MARKER. */
export async function runMaintenanceCli(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  io: MaintenanceClientIO = {
    stdout: (line) => { process.stdout.write(`${line}\n`); },
    stderr: (line) => { process.stderr.write(`${line}\n`); },
  },
  overrides: Partial<MaintenanceClientDependencies> = {},
): Promise<number> {
  const command = argv[0];
  if (argv.length !== 1 || command !== "drain" && command !== "resume" && command !== "status") {
    io.stderr("Usage: node /app/packages/deployment/client.ts drain|resume|status");
    return 2;
  }
  const configured = environment.MAINTENANCE_PORT;
  if (configured !== undefined && !/^\d{1,5}$/u.test(configured)) {
    io.stderr("maintenance failed: invalid_port");
    return 2;
  }
  const port = configured === undefined ? DEFAULT_MAINTENANCE_PORT : Number(configured);
  if (port < 1 || port > 65_535) {
    io.stderr("maintenance failed: invalid_port");
    return 2;
  }
  try {
    const status = await runMaintenanceCommand(command, {
      port,
      onStatus: (value) => io.stdout(JSON.stringify(value)),
    }, overrides);
    if (command === "drain" && status.draining && !status.active) io.stdout(DRAIN_READY_MARKER);
    return 0;
  } catch (error: unknown) {
    io.stderr(`maintenance failed: ${error instanceof MaintenanceClientError ? error.code : "unexpected_failure"}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runMaintenanceCli(process.argv.slice(2));
}

import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { MaintenanceGate } from "./gate.ts";
import { DEFAULT_MAINTENANCE_PORT, validatePort } from "./protocol.ts";
import type { MaintenanceStatus } from "./protocol.ts";

export interface MaintenanceListenerOptions {
  gate: MaintenanceGate;
  /** True for any reserved session, including creation and asynchronous closing. */
  active: () => boolean;
  /** Defaults to 3001; zero requests an ephemeral loopback port. */
  port?: number;
}

export interface MaintenanceListener {
  readonly host: "127.0.0.1";
  readonly port: number;
  close(): Promise<void>;
}

function failure(response: ServerResponse, status: number, code: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Length": "0",
    "Cache-Control": "no-store",
    "Connection": "close",
    "X-Maintenance-Error": code,
  });
  response.end();
}

/** Separate loopback listener only: no application routes, authentication material, or session data. */
export async function startMaintenanceListener(options: MaintenanceListenerOptions): Promise<MaintenanceListener> {
  if (!options || !(options.gate instanceof MaintenanceGate) || typeof options.active !== "function") {
    throw new TypeError("A maintenance gate and synchronous active callback are required.");
  }
  const requestedPort = validatePort(options.port === undefined ? DEFAULT_MAINTENANCE_PORT : options.port, true);
  let port = requestedPort;
  const server = createServer({ maxHeaderSize: 8_192 }, (request, response) => {
    const expectedHost = `127.0.0.1:${port}`;
    if (request.socket.remoteAddress !== "127.0.0.1"
      || request.headers.host !== expectedHost && !(port === 80 && request.headers.host === "127.0.0.1")) {
      failure(response, 403, "loopback_only");
      return;
    }
    // Local unauthenticated maintenance must not be callable through browser CSRF or DNS rebinding.
    if (request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined) {
      failure(response, 403, "browser_request_forbidden");
      return;
    }
    const path = request.url;
    if (path !== "/drain" && path !== "/resume" && path !== "/status") {
      failure(response, 404, "unknown_endpoint");
      return;
    }
    const method = path === "/status" ? "GET" : "POST";
    if (request.method !== method) {
      response.setHeader("Allow", method);
      failure(response, 405, "method_not_allowed");
      return;
    }
    if (request.headers["transfer-encoding"] !== undefined
      || request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") {
      failure(response, 400, "body_not_allowed");
      return;
    }
    let hasBody = false;
    request.on("data", () => {
      hasBody = true;
      failure(response, 400, "body_not_allowed");
    });
    request.on("error", () => failure(response, 400, "invalid_request"));
    request.on("end", () => {
      if (hasBody || response.destroyed || response.writableEnded) return;
      if (path === "/drain") options.gate.beginDrain();
      let active: unknown;
      try {
        active = options.active();
      } catch {
        failure(response, 503, "active_state_unavailable");
        return;
      }
      if (typeof active !== "boolean") {
        failure(response, 503, "invalid_active_state");
        return;
      }
      if (path === "/resume") options.gate.resume();
      const status: MaintenanceStatus = { draining: options.gate.isDraining, active };
      const body = JSON.stringify(status);
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "Connection": "close",
      });
      response.end(body);
    });
  });
  server.maxHeadersCount = 16;
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.setTimeout(5_000, (socket) => socket.destroy());
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\nX-Maintenance-Error: invalid_request\r\n\r\n");
  });
  for (const event of ["upgrade", "connect"] as const) {
    server.on(event, (_request, socket) => {
      socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: requestedPort, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    server.close();
    throw new Error("Maintenance listener did not bind to IPv4 loopback.");
  }
  port = address.port;
  let closing: Promise<void> | undefined;
  return Object.freeze({
    host: "127.0.0.1",
    port,
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  });
}

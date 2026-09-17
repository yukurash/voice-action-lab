import { AzureCliCredential, ManagedIdentityCredential } from "@azure/identity";
import WebSocket from "ws";
import type { ClientOptions, RawData } from "ws";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { ServerConfig } from "./config.ts";
import { object } from "./auth.ts";
import { finalUsage, serviceId, sessionConfiguration } from "./protocol.ts";

export interface CloseResult {
  confirmed: boolean;
  usage: Record<string, number> | null;
}

export interface LiveConnection {
  answerSdp: string;
  sessionId: string;
  creationStartedAtMs?: number;
  attach(): Promise<void>;
  send(event: Record<string, unknown>): void;
  close(timeoutMs: number): Promise<CloseResult>;
  terminate(): void;
}

export interface OpenLiveRequest {
  sdp: string;
  signal: AbortSignal;
  onEvent: (event: unknown) => void;
  onDisconnect: (reason: string) => void;
}

export interface LiveGateway {
  open(request: OpenLiveRequest): Promise<LiveConnection>;
}

interface Credential {
  getToken(scope: string): Promise<{ token: string } | null>;
}

export interface GatewayDependencies {
  credential?: Credential;
  fetch?: typeof globalThis.fetch;
  createSocket?: (url: string, options: ClientOptions) => WebSocket;
  now?: () => number;
}

export class GatewayError extends Error {
  status: number;

  constructor(code: string, status = 502) {
    super(code);
    this.status = status;
  }
}

interface LiveTransport {
  send(event: Record<string, unknown>): void;
  close(timeoutMs: number): Promise<CloseResult>;
  terminate(): void;
}

class DeferredLiveConnection implements LiveConnection {
  answerSdp: string;
  sessionId: string;
  creationStartedAtMs: number;
  private factory: (signal: AbortSignal) => Promise<LiveTransport>;
  private controller = new AbortController();
  private transport: LiveTransport | null = null;
  private attachPromise: Promise<void> | null = null;

  constructor(sessionId: string, answerSdp: string, creationStartedAtMs: number, factory: (signal: AbortSignal) => Promise<LiveTransport>) {
    this.sessionId = sessionId;
    this.answerSdp = answerSdp;
    this.creationStartedAtMs = creationStartedAtMs;
    this.factory = factory;
  }

  attach(): Promise<void> {
    if (this.attachPromise) return this.attachPromise;
    this.attachPromise = this.factory(this.controller.signal).then((transport) => {
      if (this.controller.signal.aborted) {
        transport.terminate();
        throw new GatewayError("live_attach_cancelled_usage_unconfirmed");
      }
      this.transport = transport;
    });
    return this.attachPromise;
  }

  send(event: Record<string, unknown>): void {
    if (!this.transport) throw new GatewayError("live_not_ready");
    this.transport.send(event);
  }

  async close(timeoutMs: number): Promise<CloseResult> {
    if (!this.transport) {
      this.controller.abort();
      return { confirmed: false, usage: null };
    }
    return this.transport.close(timeoutMs);
  }

  terminate(): void {
    this.controller.abort();
    this.transport?.terminate();
  }
}

class SidebandConnection implements LiveTransport {
  answerSdp: string;
  sessionId: string;
  private socket: WebSocket;
  private closing = false;
  private disconnected = false;
  private opened = false;
  private closeResult: CloseResult | null = null;
  private closePromise: Promise<CloseResult> | null = null;
  private settleClose: ((result: CloseResult) => void) | null = null;

  constructor(socket: WebSocket, sessionId: string, answerSdp: string, request: OpenLiveRequest) {
    this.socket = socket;
    this.sessionId = sessionId;
    this.answerSdp = answerSdp;
    socket.once("open", () => { this.opened = true; });
    socket.on("message", (data: RawData, binary: boolean) => {
      if (binary) return;
      let event: unknown;
      try {
        event = JSON.parse(data.toString());
      } catch {
        this.fail("invalid_service_event", request);
        return;
      }
      if (object(event)?.type === "session.closed") {
        this.closeResult = { confirmed: true, usage: finalUsage(event) };
        this.settleClose?.(this.closeResult);
      }
      request.onEvent(event);
    });
    socket.on("error", () => this.fail("sideband_error", request));
    socket.on("close", () => {
      this.settleClose?.(this.closeResult ?? { confirmed: false, usage: null });
      if (this.opened && !this.closing && !this.disconnected) {
        this.disconnected = true;
        request.onDisconnect("sideband_disconnected");
      }
    });
  }

  private fail(reason: string, request: OpenLiveRequest): void {
    if (this.opened && !this.closing && !this.disconnected) {
      this.disconnected = true;
      request.onDisconnect(reason);
    }
    this.settleClose?.(this.closeResult ?? { confirmed: false, usage: null });
    this.socket.terminate();
  }

  send(event: Record<string, unknown>): void {
    if (this.socket.readyState !== WebSocket.OPEN || this.closing) {
      throw new GatewayError("sideband_unavailable");
    }
    this.socket.send(JSON.stringify(event));
  }

  close(timeoutMs: number): Promise<CloseResult> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = new Promise<CloseResult>((resolve) => {
      const timer = setTimeout(() => finish(this.closeResult ?? { confirmed: false, usage: null }), timeoutMs);
      const finish = (result: CloseResult) => {
        clearTimeout(timer);
        this.settleClose = null;
        this.socket.terminate();
        resolve(result);
      };
      this.settleClose = finish;
      if (this.closeResult) {
        finish(this.closeResult);
      } else if (this.socket.readyState !== WebSocket.OPEN) {
        finish({ confirmed: false, usage: null });
      } else {
        try {
          this.socket.send(JSON.stringify({ type: "session.close" }));
        } catch {
          finish({ confirmed: false, usage: null });
        }
      }
    });
    return this.closePromise;
  }

  terminate(): void {
    this.closing = true;
    this.socket.terminate();
    this.settleClose?.(this.closeResult ?? { confirmed: false, usage: null });
  }
}

export class AzureLiveGateway implements LiveGateway {
  private config: ServerConfig;
  private dependencies: GatewayDependencies;

  constructor(config: ServerConfig, dependencies: GatewayDependencies = {}) {
    this.config = config;
    this.dependencies = dependencies;
  }

  async open(request: OpenLiveRequest): Promise<LiveConnection> {
    if (!this.config.liveEnabled || !this.config.azureEndpoint) throw new GatewayError("live_disabled", 503);
    const credential = this.dependencies.credential ?? (this.config.credentialMode === "managed-identity"
      ? new ManagedIdentityCredential(this.config.managedIdentityClientId
        ? { clientId: this.config.managedIdentityClientId } : {})
      : new AzureCliCredential(this.config.credentialTenantId ? { tenantId: this.config.credentialTenantId } : {}));
    let accessToken: { token: string } | null;
    try {
      accessToken = await credential.getToken("https://cognitiveservices.azure.com/.default");
    } catch {
      throw new GatewayError("azure_credential_unavailable", 503);
    }
    if (!accessToken || request.signal.aborted) throw new GatewayError("session_creation_cancelled", 503);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
    let response: Response;
    const creationStartedAtMs = (this.dependencies.now ?? Date.now)();
    try {
      response = await (this.dependencies.fetch ?? globalThis.fetch)(
        new URL("/openai/v1/live/sessions", this.config.azureEndpoint),
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            session: sessionConfiguration(this.config.liveModel, this.config.backendModel),
            transport: { type: "webrtc", sdp: request.sdp },
          }),
          redirect: "error",
          signal,
        },
      );
    } catch {
      throw new GatewayError("live_session_request_failed");
    }
    if (!response.ok) {
      // Never relay the service body: it can include prompts, SDP or resource identifiers.
      await response.body?.cancel();
      throw new GatewayError(`live_session_http_${response.status}`);
    }
    let body: Record<string, unknown> | null;
    try {
      const text = await response.text();
      if (text.length > 131_072) throw new Error("oversized_response");
      body = object(JSON.parse(text));
    } catch {
      throw new GatewayError("invalid_live_session_response");
    }
    const session = object(body?.session);
    const transport = object(body?.transport);
    if (!serviceId(session?.id) || typeof transport?.sdp !== "string"
      || !transport.sdp.startsWith("v=0") || transport.sdp.length > 65_536) {
      throw new GatewayError("invalid_live_session_response");
    }
    const sessionId = session.id;
    const answerSdp = transport.sdp;
    const endpoint = this.config.azureEndpoint;
    const token = accessToken.token;
    // Azure can return 404 for sideband until the browser applies the answer and ICE connects.
    return new DeferredLiveConnection(sessionId, answerSdp, creationStartedAtMs, async (attachSignal) => {
      const signal = AbortSignal.any([request.signal, attachSignal, AbortSignal.timeout(15_000)]);
      if (signal.aborted) throw new GatewayError("live_attach_cancelled_usage_unconfirmed");
      const url = new URL(`/openai/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`, endpoint);
      url.protocol = "wss:";
      const socket = (this.dependencies.createSocket ?? ((address, options) => new WebSocket(address, options)))(
        url.href,
        { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 15_000, maxPayload: 1_048_576 },
      );
      const connection = new SidebandConnection(socket, sessionId, answerSdp, request);
      try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          signal.removeEventListener("abort", aborted);
          socket.off("open", opened);
          socket.off("error", failed);
          socket.off("close", failed);
          socket.off("unexpected-response", unexpected);
        };
        const opened = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new GatewayError("live_attach_failed_usage_unconfirmed")); };
        const aborted = () => { cleanup(); socket.terminate(); reject(new GatewayError("live_attach_cancelled_usage_unconfirmed")); };
        const unexpected = (_request: ClientRequest, response: IncomingMessage) => {
          cleanup();
          const code = response.statusCode;
          reject(new GatewayError(Number.isInteger(code) && code !== undefined && code >= 100 && code <= 599
            ? `live_attach_http_${code}_usage_unconfirmed` : "live_attach_failed_usage_unconfirmed"));
          response.destroy();
          socket.terminate();
        };
        socket.once("open", opened);
        socket.once("error", failed);
        socket.once("close", failed);
        socket.once("unexpected-response", unexpected);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
      } catch (error) {
        connection.terminate();
        if (error instanceof GatewayError) throw error;
        throw new GatewayError("live_attach_failed_usage_unconfirmed");
      }
      return connection;
    });
  }
}

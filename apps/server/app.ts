import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import WebSocket from "ws";
import { GameEngine } from "../../packages/game-engine/index.ts";
import { parseGameCommand } from "../../packages/contracts/index.ts";
import type { BrowserState, CommandResult, ExperimentMode, LabEvent, SessionStatus } from "../../packages/contracts/index.ts";
import { exactBody, HttpError, object, ownerFromRequest, validateOrigin } from "./auth.ts";
import { validateConfig } from "./config.ts";
import type { ServerConfig } from "./config.ts";
import { AzureLiveGateway, GatewayError } from "./gateway.ts";
import type { CloseResult, LiveConnection, LiveGateway } from "./gateway.ts";
import { completedTool, serviceId } from "./protocol.ts";
import { createCredential } from "./credentials.ts";
import { AzureBlobExportStore } from "./export-store.ts";
import { buildRunExport, exportRunId, parseRunExport } from "./exports.ts";
import type { PrivateExportStore } from "./exports.ts";
import { MaintenanceGate, MaintenanceDrainingError, startMaintenanceListener } from "../../packages/deployment/index.ts";
import type { MaintenanceListener } from "../../packages/deployment/index.ts";

export interface AppDependencies {
  gateway?: LiveGateway;
  now?: () => number;
  newId?: () => string;
  exportStore?: PrivateExportStore;
  maintenanceGate?: MaintenanceGate;
  startMaintenance?: typeof startMaintenanceListener;
}

interface Run {
  id: string;
  owner: string;
  kind: "live" | "simulation";
  engine: GameEngine;
  startedAt: number;
  expiresAt: number;
  lastActivity: number;
  lastActivityOffset: number;
  serviceOriginOffsetMs: number;
  controller: AbortController;
  phase: "connecting" | "negotiating" | "attaching" | "connected" | "closing";
  connection: LiveConnection | null;
  closePromise: Promise<void> | null;
  calls: Set<string>;
  continuations: Set<string>;
  backendPending: Set<string>;
  completedResponses: Set<string>;
  pendingEvents: unknown[];
}

function modeFrom(value: unknown): ExperimentMode {
  if (value !== "voice-only" && value !== "cancel-actions") throw new HttpError(400, "invalid_mode");
  return value;
}

export async function buildApp(config: ServerConfig, dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  validateConfig(config);
  const wallOrigin = Date.now();
  const monotonicOrigin = performance.now();
  const now = dependencies.now ?? (() => wallOrigin + performance.now() - monotonicOrigin);
  const newId = dependencies.newId ?? randomUUID;
  const credential = createCredential(config);
  const gateway = dependencies.gateway ?? new AzureLiveGateway(config, { now, credential });
  const exportStore = config.exportStorage
    ? dependencies.exportStore ?? new AzureBlobExportStore(config.exportStorage, credential)
    : null;
  const app = Fastify({ logger: false, bodyLimit: 80_000, trustProxy: false });
  const maintenanceGate = dependencies.maintenanceGate ?? new MaintenanceGate();
  let maintenance: MaintenanceListener | null = null;
  const owners = new WeakMap<FastifyRequest, string>();
  const sockets = new Map<WebSocket, string>();
  let run: Run | null = null;
  let stateOwner: string | null = null;
  const initialStartedAt = now();
  let engine = new GameEngine({
    mode: "voice-only", runId: newId(), now: () => Math.max(0, now() - initialStartedAt),
    stepIntervalMs: config.stepIntervalMs,
  });
  engine.stop("not-started");
  let status: SessionStatus = {
    transport: "disconnected", source: "simulation", message: "No active session. Simulation is not a live model.",
    expiresAt: null, recording: false,
  };
  let audit: LabEvent[] = [];
  let serverClosing = false;
  let rateWindowAt = now();
  let mutationCount = 0;
  let closedRun: { runId: string; closedAt: string } | null = null;

  function record(current: Run, kind: string, details: LabEvent["details"] = {}): void {
    if (run !== current) return;
    audit.push({
      sequence: 0, atMs: Math.max(0, now() - current.startedAt), kind,
      operationId: null, delegationId: null, details,
    });
    if (audit.length > 200) audit = audit.slice(-200);
  }

  function state(): BrowserState {
    const game = engine.snapshot();
    // Transport metadata contains only safe numeric/enum data, never speech or service payloads.
    const events = [...game.events, ...audit].sort((left, right) => left.atMs - right.atMs)
      .map((event, index) => ({ ...event, sequence: index + 1 }));
    return { game: { ...game, events }, session: { ...status } };
  }

  function publish(): void {
    const message = JSON.stringify(state());
    for (const [socket, owner] of sockets) {
      if (stateOwner !== null && stateOwner !== owner) continue;
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.bufferedAmount > 262_144) {
        socket.close(1013, "slow_consumer");
        continue;
      }
      socket.send(message, (error) => { if (error) socket.terminate(); });
    }
  }

  function owner(request: FastifyRequest): string {
    const id = owners.get(request);
    if (!id) throw new HttpError(401, "authentication_required");
    return id;
  }

  function ensureOwner(request: FastifyRequest): string {
    const id = owner(request);
    if (stateOwner !== null && stateOwner !== id) throw new HttpError(403, "session_owner_mismatch");
    return id;
  }

  function ownerForStart(request: FastifyRequest): string {
    const id = owner(request);
    if (run && run.owner !== id) throw new HttpError(403, "session_owner_mismatch");
    return id;
  }

  function touch(current: Run): void {
    if (run !== current || current.phase !== "connected") return;
    current.lastActivity = now();
    if (status.message.startsWith("Idle warning")) status.message = current.kind === "live" ? "Live connected." : "Simulation — no model connection.";
  }

  function closeRun(current: Run, reason: string, lost = false): Promise<void> {
    if (current.closePromise) return current.closePromise;
    if (run !== current) return Promise.resolve();
    current.phase = "closing";
    current.engine.stop(reason);
    status = { ...status, transport: "closing", message: reason };
    record(current, "session_closing", { reason });
    publish();
    current.closePromise = Promise.resolve().then(async () => {
      let result: CloseResult = { confirmed: false, usage: null };
      if (current.kind === "live") {
        if (!current.connection) {
          current.controller.abort();
        } else if (lost) {
          current.connection.terminate();
        } else {
          try {
            result = await current.connection.close(config.closeTimeoutMs);
          } catch {
            current.connection.terminate();
          }
        }
      }
      if (run !== current) return;
      if (current.kind === "live") {
        const confirmed = result.confirmed && result.usage !== null;
        record(current, confirmed ? "final_usage_confirmed" : "final_usage_unconfirmed", result.usage ?? {});
        status = {
          ...status, transport: lost ? "error" : "disconnected", expiresAt: null,
          message: `${reason}; ${confirmed ? "final usage confirmed" : "final usage unconfirmed"}.`,
        };
      } else {
        status = { ...status, transport: "disconnected", expiresAt: null, message: `Simulation stopped: ${reason}.` };
      }
      closedRun = { runId: current.engine.snapshot().runId, closedAt: new Date(now()).toISOString() };
      run = null;
      publish();
    });
    return current.closePromise;
  }

  function safeSend(current: Run, event: Record<string, unknown>): boolean {
    if (run !== current || current.phase !== "connected" || !current.connection) return false;
    try {
      current.connection.send(event);
      return true;
    } catch {
      void closeRun(current, "sideband_send_failed", true);
      return false;
    }
  }

  function onServiceEvent(current: Run, value: unknown): void {
    if (run !== current) return;
    const event = object(value);
    if (!event) return;
    if (event.type === "session.closed") {
      if (current.phase !== "closing") void closeRun(current, "service_closed");
      return;
    }
    if (current.phase === "connecting" || current.phase === "negotiating" || current.phase === "attaching") {
      if (event.type === "session.delegation.created" || event.type === "response.event" || event.type === "error") {
        if (current.pendingEvents.length >= 50) void closeRun(current, "connecting_event_limit", true);
        else current.pendingEvents.push(value);
      }
      return;
    }
    if (current.phase !== "connected") return;
    if (event.type === "error") {
      void closeRun(current, "live_service_error");
      return;
    }
    if (event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") {
      // Only timing metadata is retained. These fragments are not audible-stop confirmations.
      touch(current);
      if (typeof event.start_ms === "number" && Number.isFinite(event.start_ms) && event.start_ms >= 0
        && typeof event.end_ms === "number" && Number.isFinite(event.end_ms)
        && event.end_ms >= event.start_ms && event.end_ms <= config.sessionLimitMs) {
        record(current, event.type === "session.input_transcript.delta" ? "input_transcript_timing" : "output_transcript_timing",
          { startMs: event.start_ms, endMs: event.end_ms });
        publish();
      }
      return;
    }
    if (event.type === "session.delegation.created") {
      const delegation = object(event.delegation);
      if (delegation?.target !== "responses" || !serviceId(delegation.id)) return;
      current.backendPending.add(delegation.id);
      touch(current);
      let offset: number | undefined;
      if (event.offset_ms !== undefined) {
        if (typeof event.offset_ms !== "number" || !Number.isFinite(event.offset_ms)
          || event.offset_ms < 0 || event.offset_ms > config.sessionLimitMs) {
          record(current, "delegation_offset_rejected");
          publish();
          return;
        }
        // The HTTP request start is a conservative lower bound, not an optimistic
        // receipt-time calibration that could make old work appear post-cancellation.
        offset = current.serviceOriginOffsetMs + event.offset_ms;
      } else if (current.engine.snapshot().epoch > 0) {
        record(current, "delegation_offset_required_after_cancel");
        publish();
        return;
      }
      try {
        current.engine.registerDelegation(delegation.id, offset);
      } catch {
        record(current, "delegation_registration_rejected");
        publish();
        return;
      }
      touch(current);
      record(current, "delegation_received");
      publish();
      return;
    }
    const nested = object(event.event);
    const responseId = object(nested?.response)?.id;
    if (event.type === "response.event" && nested?.type === "response.completed" && serviceId(responseId)) {
      // A duplicate terminal event must not clear a still-running continuation.
      if (current.completedResponses.has(responseId)) return;
      if (current.completedResponses.size >= 1_024) {
        void closeRun(current, "backend_response_limit");
        return;
      }
      current.completedResponses.add(responseId);
    }
    if (event.type === "response.event" && serviceId(event.delegation_id) && typeof nested?.type === "string") {
      touch(current);
      if (nested.type !== "response.completed") current.backendPending.add(event.delegation_id);
    }
    const tool = completedTool(value);
    if (tool) {
      const key = `${tool.delegationId}:${tool.callId}`;
      if (current.calls.has(key)) return;
      if (current.calls.size >= 500) {
        void closeRun(current, "tool_call_limit");
        return;
      }
      current.calls.add(key);
      const result: CommandResult = tool.request ? current.engine.dispatch(tool.request)
        : { outcome: "rejected", operationId: null, reason: "invalid_tool_arguments" };
      touch(current);
      if (safeSend(current, {
        type: "response.item.create", event_id: `event_${newId()}`,
        item: { type: "function_call_output", call_id: tool.callId, output: JSON.stringify(result) },
      })) {
        current.continuations.add(tool.delegationId);
      }
      publish();
      return;
    }
    if (event.type !== "response.event" || !serviceId(event.delegation_id)) return;
    // Wait until all output_item.done events in this response have arrived before continuing.
    if (nested?.type === "response.completed") {
      if (current.continuations.delete(event.delegation_id)) {
        safeSend(current, { type: "response.create", event_id: `event_${newId()}` });
      } else {
        current.backendPending.delete(event.delegation_id);
      }
    } else if (nested?.type === "response.failed" || nested?.type === "response.incomplete" || nested?.type === "error") {
      void closeRun(current, "backend_response_failed");
    }
  }

  function begin(ownerId: string, mode: ExperimentMode, kind: Run["kind"]): Run {
    maintenanceGate.assertAccepting();
    if (run) throw new HttpError(409, "session_already_active");
    const startedAt = now();
    engine = new GameEngine({
      mode, runId: newId(), now: () => Math.max(0, now() - startedAt),
      stepIntervalMs: config.stepIntervalMs,
    });
    audit = [];
    const current: Run = {
      id: newId(), owner: ownerId, kind, engine, startedAt,
      expiresAt: startedAt + config.sessionLimitMs, lastActivity: startedAt, lastActivityOffset: -1,
      serviceOriginOffsetMs: 0,
      controller: new AbortController(), phase: kind === "live" ? "connecting" : "connected",
      connection: null, closePromise: null, calls: new Set(), continuations: new Set(),
      backendPending: new Set(), completedResponses: new Set(), pendingEvents: [],
    };
    run = current;
    closedRun = null;
    stateOwner = ownerId;
    status = {
      transport: kind === "live" ? "connecting" : "connected", source: "simulation", recording: false,
      expiresAt: new Date(current.expiresAt).toISOString(),
      message: kind === "live" ? "Connecting live transport; no live session attached yet." : "Simulation — no model connection.",
    };
    record(current, kind === "live" ? "live_connecting" : "simulation_started", {
      stepIntervalMs: config.stepIntervalMs,
      ...(kind === "live" ? { sourceOffsetsSynchronized: false, sourceOffsetBasis: "creation-request-lower-bound" } : {}),
    });
    publish();
    return current;
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MaintenanceDrainingError) return reply.code(503).send({ error: "deployment_in_progress" });
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof GatewayError) return reply.code(error.status).send({ error: error.message });
    const statusCode = object(error)?.statusCode;
    if (statusCode === 400 || statusCode === 413 || statusCode === 415) {
      return reply.code(statusCode).send({ error: "invalid_body" });
    }
    return reply.code(500).send({ error: "internal_error" });
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (request.method === "GET" && request.url === "/health/live") return;
    owners.set(request, ownerFromRequest(request, config));
    if (request.method !== "GET" && request.method !== "HEAD" || request.url.split("?")[0] === "/api/events") {
      validateOrigin(request, config);
    }
    if (request.method === "POST" && !["/api/stop", "/api/session/close"].includes(request.url)) {
      if (now() - rateWindowAt >= 60_000) { rateWindowAt = now(); mutationCount = 0; }
      if (++mutationCount > 240) throw new HttpError(429, "request_rate_limited");
    }
  });

  await app.register(websocket, { options: { maxPayload: 4_096 } });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/api/config", async () => ({
    liveAvailable: config.liveEnabled && !maintenanceGate.isDraining,
    reason: maintenanceGate.isDraining ? "Deployment in progress. New sessions are temporarily blocked."
      : config.liveEnabled ? "Live configured; account and session connection are verified on connect." : "Live is disabled by server configuration.",
  }));
  app.get("/api/state", async (request) => { ensureOwner(request); return state(); });
  app.get("/api/events", { websocket: true, preValidation: async (request) => { ensureOwner(request); } }, (socket, request) => {
    const socketOwner = owner(request);
    sockets.set(socket, socketOwner);
    socket.send(JSON.stringify(state()));
    // The browser channel is read-only; model commands only enter through the server sideband.
    socket.on("message", () => socket.close(1008, "read_only_channel"));
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      sockets.delete(socket);
      if (!serverClosing && run?.owner === socketOwner && ![...sockets.values()].includes(socketOwner)) {
        void closeRun(run, "browser_disconnected");
      }
    });
  });
  app.post("/api/simulation/start", async (request) => {
    const id = ownerForStart(request);
    const body = exactBody(request.body, ["mode"]);
    const mode = modeFrom(body.mode);
    begin(id, mode, "simulation");
    return state();
  });
  app.post("/api/command", async (request) => {
    ensureOwner(request);
    let command;
    try { command = parseGameCommand(request.body); }
    catch { throw new HttpError(400, "invalid_command"); }
    if (!run || run.kind !== "simulation" || run.phase !== "connected") throw new HttpError(409, "simulation_required");
    const delegationId = `sim_${newId()}`;
    run.engine.registerDelegation(delegationId);
    const result = run.engine.dispatch({ callId: `call_${newId()}`, delegationId, command });
    touch(run);
    publish();
    return { result, state: state() };
  });
  app.post("/api/session", async (request) => {
    const id = ownerForStart(request);
    const body = exactBody(request.body, ["mode", "sdp"]);
    const mode = modeFrom(body.mode);
    if (typeof body.sdp !== "string" || body.sdp.length > 65_536 || !body.sdp.startsWith("v=0")
      || !body.sdp.includes("m=audio")) throw new HttpError(400, "invalid_sdp");
    if (!config.liveEnabled) throw new HttpError(503, "live_disabled");
    const current = begin(id, mode, "live");
    try {
      const connection = await gateway.open({
        sdp: body.sdp, signal: current.controller.signal,
        onEvent: (event) => onServiceEvent(current, event),
        onDisconnect: (reason) => {
          if (run === current) void closeRun(current, reason === "sideband_error" ? reason : "sideband_disconnected", true);
        },
      });
      if (run !== current || current.phase !== "connecting" || current.controller.signal.aborted) {
        await connection.close(config.closeTimeoutMs);
        throw new HttpError(409, "session_creation_cancelled");
      }
      current.connection = connection;
      const creationStartedAt = connection.creationStartedAtMs ?? current.startedAt;
      if (!Number.isFinite(creationStartedAt) || creationStartedAt < current.startedAt || creationStartedAt > now()) {
        throw new GatewayError("invalid_live_creation_clock_usage_unconfirmed");
      }
      current.serviceOriginOffsetMs = creationStartedAt - current.startedAt;
      current.phase = "negotiating";
      status = { ...status, message: "SDP created. Awaiting browser ICE/data channel before sideband attachment." };
      record(current, "webrtc_offer_accepted");
      publish();
      return { sdp: connection.answerSdp, expiresAt: new Date(current.expiresAt).toISOString() };
    } catch (error) {
      if (run === current) await closeRun(current, error instanceof GatewayError ? error.message : "live_connection_failed", true);
      if (error instanceof GatewayError || error instanceof HttpError) throw error;
      throw new GatewayError("live_connection_failed");
    }
  });
  app.post("/api/session/ready", async (request) => {
    ensureOwner(request);
    exactBody(request.body, []);
    if (!run || run.kind !== "live" || run.phase !== "negotiating" || !run.connection) {
      throw new HttpError(409, "session_not_awaiting_ready");
    }
    const current = run;
    const connection = run.connection;
    current.phase = "attaching";
    status = { ...status, message: "Browser ready. Attaching server sideband." };
    publish();
    try {
      await connection.attach();
      if (run !== current || current.phase !== "attaching" || current.controller.signal.aborted) {
        await connection.close(config.closeTimeoutMs);
        throw new HttpError(409, "session_creation_cancelled");
      }
      connection.send({
        type: "session.thinking.append", delegation_id: null,
        content: JSON.stringify({ cargo: current.engine.snapshot().cargo, queued_operations: 0 }),
      });
      current.phase = "connected";
      current.lastActivity = now();
      status = { ...status, transport: "connected", source: "live", message: "Live connected." };
      record(current, "live_attached");
      for (const event of current.pendingEvents.splice(0)) onServiceEvent(current, event);
      if (current.phase !== "connected") throw new GatewayError("live_session_closed_during_attach");
      publish();
      return state();
    } catch (error) {
      if (run === current) await closeRun(current, error instanceof GatewayError ? error.message : "live_attach_failed", true);
      if (error instanceof GatewayError || error instanceof HttpError) throw error;
      throw new GatewayError("live_attach_failed");
    }
  });
  app.post("/api/activity", async (request) => {
    ensureOwner(request);
    const body = exactBody(request.body, ["offsetMs"]);
    if (typeof body.offsetMs !== "number" || !Number.isFinite(body.offsetMs)
      || body.offsetMs < 0 || body.offsetMs > config.sessionLimitMs) throw new HttpError(400, "invalid_activity");
    if (!run || run.kind !== "live" || run.phase !== "connected") throw new HttpError(409, "live_session_required");
    if (body.offsetMs > run.lastActivityOffset) {
      run.lastActivityOffset = body.offsetMs;
      touch(run);
    }
    return { ok: true };
  });
  app.post("/api/stop", async (request) => {
    ensureOwner(request);
    exactBody(request.body, []);
    if (run) await closeRun(run, "emergency");
    else engine.stop("emergency");
    return state();
  });
  app.post("/api/session/close", async (request) => {
    ensureOwner(request);
    exactBody(request.body, []);
    if (run) await closeRun(run, "user_closed");
    return state();
  });

  app.post("/api/exports", async (request, reply) => {
    const requester = ensureOwner(request);
    exactBody(request.body, []);
    if (!exportStore) throw new HttpError(503, "export_not_configured");
    if (run || !closedRun) throw new HttpError(409, "export_requires_closed_run");
    const snapshot = state();
    if (snapshot.game.runId !== closedRun.runId || !snapshot.game.stopped) throw new HttpError(409, "export_requires_closed_run");
    const document = buildRunExport(snapshot, config, closedRun.closedAt, new Date(now()).toISOString());
    await exportStore.create(document, requester);
    return reply.code(201).send({ runId: document.runId, downloadPath: `/api/exports/${document.runId}` });
  });
  app.get<{ Params: { runId: string } }>("/api/exports/:runId", async (request, reply) => {
    const requester = owner(request);
    const runId = exportRunId(request.params.runId);
    if (!exportStore) throw new HttpError(503, "export_not_configured");
    const document = parseRunExport(await exportStore.read(runId, requester), runId);
    reply.header("Content-Disposition", `attachment; filename="${runId}.json"`);
    return reply.send(document);
  });
  app.delete<{ Params: { runId: string } }>("/api/exports/:runId", async (request) => {
    const requester = owner(request);
    const runId = exportRunId(request.params.runId);
    exactBody(request.body === undefined ? {} : request.body, []);
    if (!exportStore) throw new HttpError(503, "export_not_configured");
    await exportStore.remove(runId, requester);
    return { runId, deleted: true };
  });

  if (config.staticDirectory) {
    await app.register(fastifyStatic, { root: config.staticDirectory, wildcard: true, index: "index.html", dotfiles: "deny" });
    app.setNotFoundHandler((request, reply) => {
      if ((request.method === "GET" || request.method === "HEAD") && !request.url.startsWith("/api/")
        && !request.url.startsWith("/health/") && !request.url.includes(".")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "not_found" });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "not_found" }));
  }

  const timer = setInterval(() => {
    const current = run;
    if (!current || current.phase === "closing") return;
    if (current.phase === "connected" && (current.backendPending.size > 0
      || current.engine.snapshot().operations.some((operation) => operation.status === "queued" || operation.status === "running"))) {
      touch(current);
    }
    if (now() >= current.expiresAt) {
      void closeRun(current, "session_time_limit");
    } else if (current.kind === "live" && current.phase !== "connected"
      && now() - current.startedAt >= config.negotiationTimeoutMs) {
      void closeRun(current, "negotiation_timeout");
    } else if (now() - current.lastActivity >= config.idleLimitMs) {
      void closeRun(current, "idle_timeout");
    } else if (current.phase === "connected") {
      current.engine.tick();
      if (now() - current.lastActivity >= Math.max(0, config.idleLimitMs - 15_000)) {
        status.message = "Idle warning: this session will close soon without user activity.";
      }
      publish();
    }
  }, config.tickMs);
  timer.unref();
  app.addHook("onReady", async () => {
    if (config.maintenancePort !== undefined) {
      maintenance = await (dependencies.startMaintenance ?? startMaintenanceListener)({
        gate: maintenanceGate, active: () => run !== null, port: config.maintenancePort,
      });
    }
  });
  app.addHook("onClose", async () => {
    maintenanceGate.beginDrain();
    serverClosing = true;
    clearInterval(timer);
    if (run) await closeRun(run, "server_shutdown");
    for (const socket of sockets.keys()) socket.terminate();
    sockets.clear();
    await maintenance?.close();
  });
  return app;
}

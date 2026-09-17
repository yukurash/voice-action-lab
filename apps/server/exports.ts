import { createHash } from "node:crypto";
import type { BrowserState, GameSnapshot, LabEvent, OperationStatus } from "../../packages/contracts/index.ts";
import type { ServerConfig } from "./config.ts";
import { HttpError, object } from "./auth.ts";

export const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const publicReasons = new Set([
  "cancel", "replace",
  "Engine is stopped.", "Delegation is not registered.", "Delegation belongs to a stale epoch.",
  "callId collision.", "Delegation creation is at or before the cancellation barrier.",
  "Creation offset must be finite, nonnegative, and not in the future.",
  "Invalid delegationId.", "Delegation registration cannot be changed.",
  "Invalid callId or delegationId.", "Request must be an object.",
  "Request must contain only callId, delegationId, and command.",
]);

export interface RunExport {
  schemaVersion: 1;
  runId: string;
  source: "live" | "simulation";
  closedAt: string;
  exportedAt: string;
  game: GameSnapshot;
  session: { transport: "disconnected" | "error"; recording: false };
  usage: {
    scope: "voice-session-only";
    status: "confirmed" | "unconfirmed" | "not-applicable";
    metrics: Record<string, number> | null;
  };
  settings: {
    liveModel: string;
    backendModel: string;
    stepIntervalMs: number;
    tickMs: number;
    sessionLimitMs: number;
    idleLimitMs: number;
    sourceOffsetsSynchronized: false;
    sourceCommit?: string;
  };
}

export interface PrivateExportStore {
  create(document: RunExport, owner: string): Promise<void>;
  read(runId: string, owner: string): Promise<RunExport>;
  remove(runId: string, owner: string): Promise<void>;
}

export function exportRunId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new HttpError(400, "invalid_export_run_id");
  return value.toLowerCase();
}

export function ownerFingerprint(owner: string): string {
  return createHash("sha256").update(owner).digest("hex");
}

function invalid(): never { throw new HttpError(502, "invalid_export_document"); }

function record(value: unknown): Record<string, unknown> {
  return object(value) ?? invalid();
}

function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : invalid();
}

function id(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : invalid();
}

function nullableId(value: unknown): string | null { return value === null ? null : id(value); }

function iso(value: unknown): string {
  if (typeof value !== "string" || value.length > 32 || !Number.isFinite(Date.parse(value))) return invalid();
  return new Date(value).toISOString();
}

function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value)) return invalid();
  if (value.length > limit) throw new HttpError(413, "export_too_large");
  return value;
}

function color(value: unknown): "red" | "blue" { return value === "red" || value === "blue" ? value : invalid(); }
function destination(value: unknown): "left" | "right" { return value === "left" || value === "right" ? value : invalid(); }

function operationStatus(value: unknown): OperationStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "cancelled" || value === "failed"
    ? value : invalid();
}

function eventDetails(value: unknown): LabEvent["details"] {
  const result: LabEvent["details"] = {};
  for (const [key, entry] of Object.entries(record(value)).slice(0, 64)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || /audio|transcript|sdp|secret|credential|authorization|endpoint|prompt/i.test(key)) continue;
    if (entry === null || typeof entry === "boolean") result[key] = entry;
    else if (typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= Number.MAX_SAFE_INTEGER) result[key] = entry;
    else if (key === "cargo" && (entry === "red" || entry === "blue")) result[key] = entry;
    else if (key === "destination" && (entry === "left" || entry === "right")) result[key] = entry;
    else if (key === "commandType" && (entry === "move" || entry === "cancel" || entry === "replace")) result[key] = entry;
    else if (key === "sourceOffsetBasis" && entry === "creation-request-lower-bound") result[key] = entry;
    else if (key === "reason" && typeof entry === "string" && publicReasons.has(entry)) result[key] = entry;
  }
  return result;
}

function redactGame(value: unknown, runId: string): GameSnapshot {
  const game = record(value);
  const cargo = record(game.cargo);
  if (game.runId !== runId || game.stopped !== true || (game.mode !== "voice-only" && game.mode !== "cancel-actions")) return invalid();
  return {
    runId,
    mode: game.mode,
    stopped: true,
    epoch: number(game.epoch),
    cargo: { red: number(cargo.red, 6), blue: number(cargo.blue, 6) },
    operations: array(game.operations, 3_000).map((value) => {
      const operation = record(value);
      return {
        id: id(operation.id), callId: id(operation.callId), delegationId: id(operation.delegationId),
        epoch: number(operation.epoch), cargo: color(operation.cargo), destination: destination(operation.destination),
        status: operationStatus(operation.status), createdAtMs: number(operation.createdAtMs),
        endedAtMs: operation.endedAtMs === null ? null : number(operation.endedAtMs),
      };
    }),
    events: array(game.events, 20_000).map((value) => {
      const event = record(value);
      return {
        sequence: number(event.sequence), atMs: number(event.atMs), kind: id(event.kind),
        operationId: nullableId(event.operationId), delegationId: nullableId(event.delegationId),
        details: eventDetails(event.details),
      };
    }),
  };
}

function usageFor(game: GameSnapshot, source: RunExport["source"]): RunExport["usage"] {
  if (source === "simulation") return { scope: "voice-session-only", status: "not-applicable", metrics: null };
  const event = game.events.findLast((entry) => entry.kind === "final_usage_confirmed" || entry.kind === "final_usage_unconfirmed");
  if (event?.kind !== "final_usage_confirmed") return { scope: "voice-session-only", status: "unconfirmed", metrics: null };
  const metrics: Record<string, number> = {};
  for (const key of ["seconds", "session_seconds", "input_tokens", "output_tokens", "total_tokens"]) {
    const value = event.details[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) metrics[key] = value;
  }
  return { scope: "voice-session-only", status: "confirmed", metrics };
}

export function parseRunExport(value: unknown, expectedRunId: string): RunExport {
  const document = record(value);
  if (document.schemaVersion !== 1 || document.runId !== expectedRunId
    || (document.source !== "live" && document.source !== "simulation")) return invalid();
  const session = record(document.session);
  if (session.transport !== "disconnected" && session.transport !== "error") return invalid();
  const settings = record(document.settings);
  if (settings.liveModel !== "gpt-live-1" || settings.backendModel !== "gpt-5.5") return invalid();
  const sourceCommit = settings.sourceCommit;
  if (sourceCommit !== undefined && (typeof sourceCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sourceCommit))) return invalid();
  const game = redactGame(document.game, expectedRunId);
  return {
    schemaVersion: 1, runId: expectedRunId, source: document.source,
    closedAt: iso(document.closedAt), exportedAt: iso(document.exportedAt),
    game, session: { transport: session.transport, recording: false },
    usage: usageFor(game, document.source),
    settings: {
      liveModel: settings.liveModel, backendModel: settings.backendModel,
      stepIntervalMs: number(settings.stepIntervalMs, 5_000), tickMs: number(settings.tickMs, 1_000),
      sessionLimitMs: number(settings.sessionLimitMs, 600_000), idleLimitMs: number(settings.idleLimitMs, 90_000),
      sourceOffsetsSynchronized: false, ...(sourceCommit === undefined ? {} : { sourceCommit }),
    },
  };
}

export function buildRunExport(state: BrowserState, config: ServerConfig, closedAt: string, exportedAt: string): RunExport {
  const runId = exportRunId(state.game.runId);
  const document = parseRunExport({
    schemaVersion: 1, runId, source: state.session.source, closedAt, exportedAt,
    game: state.game, session: { transport: state.session.transport },
    settings: {
      liveModel: config.liveModel, backendModel: config.backendModel,
      stepIntervalMs: config.stepIntervalMs, tickMs: config.tickMs,
      sessionLimitMs: config.sessionLimitMs, idleLimitMs: config.idleLimitMs,
      ...(config.sourceCommit ? { sourceCommit: config.sourceCommit } : {}),
    },
  }, runId);
  serializeRunExport(document);
  return document;
}

export function serializeRunExport(document: RunExport): Buffer {
  const buffer = Buffer.from(JSON.stringify(document), "utf8");
  if (buffer.byteLength > MAX_EXPORT_BYTES) throw new HttpError(413, "export_too_large");
  return buffer;
}

export function decodeRunExport(buffer: Buffer, runId: string): RunExport {
  if (buffer.byteLength > MAX_EXPORT_BYTES) throw new HttpError(413, "export_too_large");
  let value: unknown;
  try { value = JSON.parse(buffer.toString("utf8")); }
  catch { throw new HttpError(502, "invalid_export_document"); }
  return parseRunExport(value, runId);
}

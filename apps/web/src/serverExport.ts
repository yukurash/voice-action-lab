import type { BrowserState, GameSnapshot, LabEvent } from "../../../packages/contracts/index.ts";
import { isBrowserState, isRecord } from "./api.ts";
import { boundedNumber, exactKeys } from "./audioMeasurement.ts";

export const SERVER_EXPORT_FORMAT = "voice-action-lab.server-export";
export const MAX_SERVER_EXPORT_BYTES = 2 * 1024 * 1024;
const numericLimit = Number.MAX_SAFE_INTEGER;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const publicReasons = new Set([
  "cancel", "replace", "Engine is stopped.", "Delegation is not registered.", "Delegation belongs to a stale epoch.",
  "callId collision.", "Delegation creation is at or before the cancellation barrier.",
  "Creation offset must be finite, nonnegative, and not in the future.",
  "Invalid delegationId.", "Delegation registration cannot be changed.", "Invalid callId or delegationId.",
  "Request must be an object.", "Request must contain only callId, delegationId, and command.",
]);

export interface ServerRunSettings {
  liveModel: "gpt-live-1";
  backendModel: "gpt-5.5";
  stepIntervalMs: number;
  tickMs: number;
  sessionLimitMs: number;
  idleLimitMs: number;
  sourceOffsetsSynchronized: false;
  sourceCommit?: string;
}
export type ServerRunUsage =
  | { scope: "voice-session-only"; status: "confirmed"; metrics: Record<string, number> }
  | { scope: "voice-session-only"; status: "unconfirmed" | "not-applicable"; metrics: null };

export interface ServerRunExport {
  schemaVersion: 1;
  runId: string;
  source: "live" | "simulation";
  closedAt: string;
  exportedAt: string;
  game: GameSnapshot;
  session: { transport: "disconnected" | "error"; recording: false };
  usage: ServerRunUsage;
  settings: ServerRunSettings;
}

export interface ServerReplay {
  format: typeof SERVER_EXPORT_FORMAT;
  version: 1;
  snapshot: BrowserState;
  measurements: [];
  server: Pick<ServerRunExport, "runId" | "closedAt" | "exportedAt" | "usage" | "settings">;
}

function identifier(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
}
function safeDetails(details: LabEvent["details"]): boolean {
  const entries = Object.entries(details);
  return entries.length <= 64 && entries.every(([key, value]) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || /audio|transcript|sdp|secret|credential|authorization|endpoint|prompt/i.test(key)) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= numericLimit;
    if (key === "cargo") return value === "red" || value === "blue";
    if (key === "destination") return value === "left" || value === "right";
    if (key === "commandType") return value === "move" || value === "cancel" || value === "replace";
    if (key === "sourceOffsetBasis") return value === "creation-request-lower-bound";
    return key === "reason" && publicReasons.has(value);
  });
}
function safeGame(game: GameSnapshot, runId: string): boolean {
  return exactKeys(game, ["runId", "mode", "epoch", "cargo", "stopped", "operations", "events"])
    && game.runId === runId && game.stopped && boundedNumber(game.epoch, numericLimit)
    && exactKeys(game.cargo, ["red", "blue"]) && game.operations.length <= 3000 && game.events.length <= 20_000
    && game.operations.every((operation) =>
      exactKeys(operation, ["id", "callId", "delegationId", "epoch", "cargo", "destination", "status", "createdAtMs", "endedAtMs"])
      && [operation.id, operation.callId, operation.delegationId].every(identifier)
      && boundedNumber(operation.epoch, numericLimit) && boundedNumber(operation.createdAtMs, numericLimit)
      && (operation.endedAtMs === null || boundedNumber(operation.endedAtMs, numericLimit)))
    && game.events.every((event) =>
      exactKeys(event, ["sequence", "atMs", "kind", "operationId", "delegationId", "details"])
      && boundedNumber(event.sequence, numericLimit) && boundedNumber(event.atMs, numericLimit)
      && identifier(event.kind) && (event.operationId === null || identifier(event.operationId))
      && (event.delegationId === null || identifier(event.delegationId)) && safeDetails(event.details));
}
function settings(value: unknown): value is ServerRunSettings {
  if (!isRecord(value)) return false;
  const keys = ["liveModel", "backendModel", "stepIntervalMs", "tickMs", "sessionLimitMs", "idleLimitMs", "sourceOffsetsSynchronized"];
  if (Object.hasOwn(value, "sourceCommit")) {
    keys.push("sourceCommit");
    if (typeof value.sourceCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.sourceCommit)) return false;
  }
  return exactKeys(value, keys) && value.liveModel === "gpt-live-1" && value.backendModel === "gpt-5.5"
    && value.sourceOffsetsSynchronized === false
    && boundedNumber(value.stepIntervalMs, 5000) && boundedNumber(value.tickMs, 1000)
    && boundedNumber(value.sessionLimitMs, 600_000) && boundedNumber(value.idleLimitMs, 90_000);
}
function iso(value: unknown): string {
  if (typeof value !== "string" || value.length > 32 || !Number.isFinite(Date.parse(value))) {
    throw new Error("サーバー書き出しの日付が不正です。");
  }
  return new Date(value).toISOString();
}
function usage(value: unknown, source: ServerRunExport["source"], game: GameSnapshot): ServerRunUsage {
  if (!exactKeys(value, ["scope", "status", "metrics"]) || value.scope !== "voice-session-only") {
    throw new Error("サーバー書き出しの利用量形式が不正です。");
  }
  const last = game.events.findLast((event) => event.kind === "final_usage_confirmed" || event.kind === "final_usage_unconfirmed");
  const status = source === "simulation" ? "not-applicable" : last?.kind === "final_usage_confirmed" ? "confirmed" : "unconfirmed";
  if (value.status !== status) throw new Error("利用量の確認状態が保存されたイベントと一致しません。");
  if (status !== "confirmed") {
    if (value.metrics !== null) throw new Error("未確認・対象外の利用量に数値を補完できません。");
    return { scope: "voice-session-only", status, metrics: null };
  }
  const metrics: Record<string, number> = {};
  for (const key of ["seconds", "session_seconds", "input_tokens", "output_tokens", "total_tokens"]) {
    const number = last?.details[key];
    if (boundedNumber(number, numericLimit)) metrics[key] = number;
  }
  const supplied = value.metrics;
  if (!exactKeys(supplied, Object.keys(metrics)) || Object.entries(metrics).some(([key, number]) => supplied[key] !== number)) {
    throw new Error("利用量の数値が保存された最終イベントと一致しません。");
  }
  return { scope: "voice-session-only", status, metrics };
}

export function parseServerExport(value: unknown, byteLength: number): ServerReplay {
  if (!boundedNumber(byteLength, MAX_SERVER_EXPORT_BYTES)) throw new Error("サーバー書き出しの読み込みは2 MBまでです。");
  if (!exactKeys(value, ["schemaVersion", "runId", "source", "closedAt", "exportedAt", "game", "session", "usage", "settings"])
    || value.schemaVersion !== 1 || typeof value.runId !== "string" || !uuid.test(value.runId)
    || (value.source !== "live" && value.source !== "simulation")
    || !exactKeys(value.session, ["transport", "recording"])
    || (value.session.transport !== "disconnected" && value.session.transport !== "error") || value.session.recording !== false
    || !settings(value.settings)) {
    throw new Error("サーバー書き出し v1 の形式が不正です。");
  }
  const snapshot = {
    game: value.game,
    session: {
      source: value.source, transport: value.session.transport, recording: false,
      message: "サーバー保存データ（ローカル表示）", expiresAt: null,
    },
  };
  if (!isBrowserState(snapshot) || !safeGame(snapshot.game, value.runId)) {
    throw new Error("サーバー書き出しの停止済みゲーム状態が不正です。");
  }
  return {
    format: SERVER_EXPORT_FORMAT, version: 1, snapshot, measurements: [],
    server: {
      runId: value.runId, closedAt: iso(value.closedAt), exportedAt: iso(value.exportedAt),
      usage: usage(value.usage, value.source, snapshot.game), settings: value.settings,
    },
  };
}

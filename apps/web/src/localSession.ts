import type { BrowserState } from "../../../packages/contracts/index.ts";
import { isBrowserState } from "./api.ts";
import { MAX_MEASUREMENT_RECORDS, boundedNumber, exactKeys, isAudioMeasurementEvent } from "./audioMeasurement.ts";
import type { AudioMeasurementEvent, MeasurementSample } from "./audioMeasurement.ts";
import { parseServerExport } from "./serverExport.ts";
import type { ServerReplay } from "./serverExport.ts";

export const LOCAL_SESSION_FORMAT = "voice-action-lab.local-session";
export const MAX_LOCAL_SESSION_BYTES = 32 * 1024 * 1024;
const REDACTED_MESSAGE = "ローカル保存済みの状態";
const eventKinds = new Set([
  "redacted", "step.committed", "operation.queued", "operation.started", "operation.completed",
  "operation.cancelled", "operation.failed", "run.started", "run.stopped",
  "cancel.observed", "cancel.applied", "epoch.advanced", "session.closed",
]);

export interface LocalSession {
  format: typeof LOCAL_SESSION_FORMAT;
  version: 1;
  snapshot: BrowserState;
  measurements: AudioMeasurementEvent[];
}
export type ReplayDocument = LocalSession | ServerReplay;

export function redactSnapshot(state: BrowserState): BrowserState {
  const identifiers = new Map<string, string>();
  const id = (value: string): string => {
    let local = identifiers.get(value);
    if (!local) {
      local = `op-${identifiers.size + 1}`;
      identifiers.set(value, local);
    }
    return local;
  };
  return {
    game: {
      runId: "local-replay", mode: state.game.mode, epoch: state.game.epoch,
      cargo: { red: state.game.cargo.red, blue: state.game.cargo.blue }, stopped: state.game.stopped,
      operations: state.game.operations.map((operation) => ({
        id: id(operation.id), callId: "redacted", delegationId: "redacted",
        epoch: operation.epoch, cargo: operation.cargo, destination: operation.destination,
        status: operation.status, createdAtMs: operation.createdAtMs, endedAtMs: operation.endedAtMs,
      })),
      events: state.game.events.map((event) => ({
        sequence: event.sequence, atMs: event.atMs, kind: eventKinds.has(event.kind) ? event.kind : "redacted",
        operationId: event.operationId === null ? null : id(event.operationId), delegationId: null, details: {},
      })),
    },
    session: {
      source: state.session.source, transport: "disconnected", message: REDACTED_MESSAGE, expiresAt: null, recording: false,
    },
  };
}

function safeInteger(value: number, max = Number.MAX_SAFE_INTEGER): boolean {
  return boundedNumber(value, max) && Number.isSafeInteger(value);
}
function localId(value: string): boolean {
  return /^op-[1-9]\d{0,4}$/.test(value);
}

function isRedactedSnapshot(value: unknown): value is BrowserState {
  if (!isBrowserState(value) || !exactKeys(value, ["game", "session"])) return false;
  const { game, session } = value;
  return exactKeys(game, ["runId", "mode", "epoch", "cargo", "stopped", "operations", "events"])
    && game.runId === "local-replay" && game.stopped && safeInteger(game.epoch)
    && exactKeys(game.cargo, ["red", "blue"]) && safeInteger(game.cargo.red, 6) && safeInteger(game.cargo.blue, 6)
    && game.operations.length <= 2000 && new Set(game.operations.map((operation) => operation.id)).size === game.operations.length
    && game.operations.every((operation) =>
      exactKeys(operation, ["id", "callId", "delegationId", "epoch", "cargo", "destination", "status", "createdAtMs", "endedAtMs"])
      && localId(operation.id) && operation.callId === "redacted" && operation.delegationId === "redacted"
      && safeInteger(operation.epoch) && boundedNumber(operation.createdAtMs, 3_600_000)
      && (operation.endedAtMs === null || (boundedNumber(operation.endedAtMs, 3_600_000) && operation.endedAtMs >= operation.createdAtMs)))
    && game.events.length <= 10_000
    && game.events.every((event, index) =>
      exactKeys(event, ["sequence", "atMs", "kind", "operationId", "delegationId", "details"])
      && safeInteger(event.sequence) && (index === 0 || event.sequence > (game.events[index - 1]?.sequence ?? event.sequence))
      && boundedNumber(event.atMs, 3_600_000) && eventKinds.has(event.kind)
      && (event.operationId === null || localId(event.operationId))
      && event.delegationId === null && exactKeys(event.details, []))
    && exactKeys(session, ["source", "transport", "message", "expiresAt", "recording"])
    && session.transport === "disconnected" && session.message === REDACTED_MESSAGE && session.expiresAt === null && !session.recording;
}

function validate(value: unknown): LocalSession {
  if (!exactKeys(value, ["format", "version", "snapshot", "measurements"])
    || value.format !== LOCAL_SESSION_FORMAT || value.version !== 1 || !isRedactedSnapshot(value.snapshot)) {
    throw new Error("ローカル保存形式、版、または匿名化された停止済み状態が不正です。");
  }
  const measurements = value.measurements;
  if (!Array.isArray(measurements) || measurements.length > MAX_MEASUREMENT_RECORDS || !measurements.every(isAudioMeasurementEvent)) {
    throw new Error("音声計測メタデータの形式または件数が不正です。");
  }
  let measurementId: string | null = null;
  let previousPerformance = -Infinity;
  let previousContext = -Infinity;
  const previous: Partial<Record<"input" | "output", MeasurementSample>> = {};
  let firstWindow: number | null = null;
  let lastWindow = 0;
  for (const [index, entry] of measurements.entries()) {
    if (index === 0 && entry.type === "anchor") measurementId = entry.measurementId;
    else if (entry.type === "anchor") throw new Error("計測の時計アンカーが重複しています。");
    if (!measurementId || entry.measurementId !== measurementId
      || entry.clockAnchor.performanceNowMs < previousPerformance || entry.clockAnchor.contextTime < previousContext) {
      throw new Error("計測IDまたは時計アンカーの順序が不正です。");
    }
    previousPerformance = entry.clockAnchor.performanceNowMs;
    previousContext = entry.clockAnchor.contextTime;
    if (entry.type === "sample") {
      const prior = previous[entry.direction];
      if (prior && (entry.sequence <= prior.sequence || entry.windowStartTime < prior.contextTime - 0.000001)) {
        throw new Error("計測ウィンドウの順序が不正です。");
      }
      firstWindow = firstWindow === null ? entry.windowStartTime : Math.min(firstWindow, entry.windowStartTime);
      lastWindow = Math.max(lastWindow, entry.contextTime);
      if (lastWindow - firstWindow > 600.001) throw new Error("計測が10分の上限を超えています。");
      if (entry.transitionTime !== null
        && Math.abs(entry.contextTime - entry.transitionTime - (entry.transition === "start" ? 0.06 : 0.12)) > 0.00026) {
        throw new Error("音声活動の確認ウィンドウ数が不正です。");
      }
      previous[entry.direction] = entry;
    }
  }
  return { format: LOCAL_SESSION_FORMAT, version: 1, snapshot: value.snapshot, measurements };
}

export function serializeLocalSession(snapshot: BrowserState, measurements: readonly AudioMeasurementEvent[]): string {
  if (!snapshot.game.stopped) throw new Error("停止済みのセッションだけを書き出せます。");
  const session = validate({ format: LOCAL_SESSION_FORMAT, version: 1, snapshot: redactSnapshot(snapshot), measurements: [...measurements] });
  const text = JSON.stringify(session);
  if (new TextEncoder().encode(text).byteLength > MAX_LOCAL_SESSION_BYTES) throw new Error("書き出しが32 MBの上限を超えています。");
  return text;
}

function readJson(text: string): { value: unknown; byteLength: number } {
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > MAX_LOCAL_SESSION_BYTES) throw new Error("読み込みは32 MBまでです。");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("JSONファイルを読み取れません。"); }
  return { value, byteLength };
}

export function parseLocalSession(text: string): LocalSession {
  return validate(readJson(text).value);
}

export function parseReplayDocument(text: string): ReplayDocument {
  const { value, byteLength } = readJson(text);
  if (value !== null && typeof value === "object" && Object.hasOwn(value, "schemaVersion")) {
    return parseServerExport(value, byteLength);
  }
  return validate(value);
}

export function sampleAt(samples: readonly MeasurementSample[], contextTime: number): MeasurementSample | null {
  if (!boundedNumber(contextTime, 3600)) throw new Error("リプレイの時刻が不正です。");
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const sample = samples[middle];
    if (!sample) throw new Error("リプレイのサンプル索引が不正です。");
    if (sample.contextTime <= contextTime + 1e-9) low = middle + 1;
    else high = middle;
  }
  const sample = samples[low - 1];
  return sample && contextTime - sample.contextTime <= 0.02013 ? sample : null;
}

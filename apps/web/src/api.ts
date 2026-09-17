import type {
  BrowserState,
  CommandResult,
  ExperimentMode,
  GameCommand,
  LabEvent,
  Operation,
} from "../../../packages/contracts/index.ts";

export interface LabConfig {
  liveAvailable: boolean;
  reason: string;
}

export interface SessionAnswer {
  sdp: string;
  expiresAt: string;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOperation(value: unknown): value is Operation {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.callId === "string"
    && typeof value.delegationId === "string"
    && isFiniteNumber(value.epoch)
    && (value.cargo === "red" || value.cargo === "blue")
    && (value.destination === "left" || value.destination === "right")
    && typeof value.status === "string"
    && ["queued", "running", "completed", "cancelled", "failed"].includes(value.status)
    && isFiniteNumber(value.createdAtMs)
    && (value.endedAtMs === null || isFiniteNumber(value.endedAtMs));
}

function isEvent(value: unknown): value is LabEvent {
  return isRecord(value)
    && isFiniteNumber(value.sequence)
    && isFiniteNumber(value.atMs)
    && typeof value.kind === "string"
    && nullableString(value.operationId)
    && nullableString(value.delegationId)
    && isRecord(value.details)
    && Object.values(value.details).every((entry) =>
      entry === null || typeof entry === "string" || typeof entry === "boolean"
      || isFiniteNumber(entry));
}

export function isBrowserState(value: unknown): value is BrowserState {
  if (!isRecord(value) || !isRecord(value.game) || !isRecord(value.session)) return false;
  const { game, session } = value;
  return typeof game.runId === "string"
    && (game.mode === "voice-only" || game.mode === "cancel-actions")
    && isFiniteNumber(game.epoch)
    && isRecord(game.cargo)
    && [game.cargo.red, game.cargo.blue].every((position) =>
      isFiniteNumber(position) && position >= 0 && position <= 6)
    && Array.isArray(game.operations) && game.operations.every(isOperation)
    && Array.isArray(game.events) && game.events.every(isEvent)
    && typeof game.stopped === "boolean"
    && typeof session.transport === "string"
    && ["disconnected", "connecting", "connected", "closing", "error"].includes(session.transport)
    && (session.source === "live" || session.source === "simulation")
    && typeof session.message === "string"
    && nullableString(session.expiresAt)
    && (session.expiresAt === null || Number.isFinite(Date.parse(session.expiresAt)))
    && typeof session.recording === "boolean";
}

export function isConfig(value: unknown): value is LabConfig {
  return isRecord(value) && typeof value.liveAvailable === "boolean" && typeof value.reason === "string";
}

export function isSessionAnswer(value: unknown): value is SessionAnswer {
  return isRecord(value) && typeof value.sdp === "string" && value.sdp.length > 0
    && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt));
}

export function isActivityResponse(value: unknown): value is { ok: true } {
  return isRecord(value) && value.ok === true;
}

function isCommandResult(value: unknown): value is CommandResult {
  return isRecord(value)
    && typeof value.outcome === "string"
    && ["queued", "cancelled", "observed-not-applied", "rejected"].includes(value.outcome)
    && nullableString(value.operationId) && typeof value.reason === "string";
}

export function isCommandResponse(value: unknown): value is { result: CommandResult; state: BrowserState } {
  return isRecord(value) && isCommandResult(value.result) && isBrowserState(value.state);
}

export async function request<T>(
  path: string,
  validate: (value: unknown) => value is T,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", signal: AbortSignal.timeout(20_000), ...options });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ApiError(0, "サーバー応答がタイムアウトしました。実行状態は未確認です。停止または状態の再取得を行ってください。");
    }
    throw new ApiError(0, "サーバーに接続できません。ネットワークとサーバーの起動状態を確認してください。");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    const prefix = response.status === 401 ? "認証が必要です。"
      : response.status === 403 ? "この操作は許可されていません。" : "";
    throw new ApiError(response.status, `${prefix}サーバーから JSON 以外の応答がありました（HTTP ${response.status}）。`);
  }
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    const prefix = response.status === 401
      ? "認証が必要です。所有者用の認証を確認してください。"
      : response.status === 403
        ? "この操作は許可されていません。所有者のアクセス権を確認してください。"
        : "リクエストに失敗しました。";
    throw new ApiError(response.status, `${prefix} ${detail}`);
  }
  if (!validate(body)) {
    throw new ApiError(response.status, "サーバー応答の形式が契約と一致しません。ページを再読み込みしてください。");
  }
  return body;
}

export function post<T>(
  path: string,
  body: object,
  validate: (value: unknown) => value is T,
  options: RequestInit = {},
): Promise<T> {
  return request(path, validate, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...options,
  });
}

export function command(body: GameCommand): Promise<{ result: CommandResult; state: BrowserState }> {
  return post("/api/command", body, isCommandResponse);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "原因を特定できないエラーが発生しました。再読み込みしてください。";
}

export function idleWarning(state: BrowserState | null): string | null {
  if (state && "idleWarning" in state.session && typeof state.session.idleWarning === "string") {
    return state.session.idleWarning || null;
  }
  return null;
}

export function liveSessionReady(state: BrowserState | null, mode: ExperimentMode): boolean {
  return state !== null && state.session.source === "live" && state.session.transport === "connected"
    && !state.game.stopped && state.game.mode === mode;
}

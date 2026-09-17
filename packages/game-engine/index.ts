import { parseGameCommand } from "../contracts/index.ts";
import type {
  CargoColor,
  CommandRequest,
  CommandResult,
  ExperimentMode,
  GameCommand,
  GameSnapshot,
  LabEvent,
  Operation,
} from "../contracts/index.ts";

interface EngineOptions {
  mode: ExperimentMode;
  runId: string;
  /** Run-relative milliseconds, on the same clock as delegation creation offsets. */
  now: () => number;
  /** Optional 100..5000ms pacing; omitted means each host tick may commit a step. */
  stepIntervalMs?: number;
}

interface Delegation {
  epoch: number;
  sourceOffsetMs: number | undefined;
}

interface CachedCall {
  delegationId: string;
  command: GameCommand;
  result: CommandResult;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && !/\s/u.test(value)
    && [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPending(operation: Operation): boolean {
  return operation.status === "queued" || operation.status === "running";
}

function sameCommand(first: GameCommand, second: GameCommand): boolean {
  if (first.type === "cancel" || second.type === "cancel") {
    return first.type === second.type;
  }
  return first.type === second.type
    && first.cargo === second.cargo
    && first.destination === second.destination;
}

export class GameEngine {
  readonly #mode: ExperimentMode;
  readonly #runId: string;
  readonly #now: () => number;
  readonly #stepIntervalMs: number | undefined;
  readonly #cargo: Record<CargoColor, number> = { red: 0, blue: 0 };
  readonly #operations: Operation[] = [];
  readonly #events: LabEvent[] = [];
  readonly #delegations = new Map<string, Delegation>();
  readonly #calls = new Map<string, CachedCall>();
  #epoch = 0;
  #stopped = false;
  #cancellationBarrierMs: number | null = null;
  #lastStepAtMs = 0;

  constructor(options: EngineOptions) {
    if (!isRecord(options)) throw new TypeError("Engine options must be an object.");
    if (options.mode !== "voice-only" && options.mode !== "cancel-actions") {
      throw new TypeError("Unknown experiment mode.");
    }
    if (!isId(options.runId)) throw new TypeError("Invalid runId.");
    if (typeof options.now !== "function") throw new TypeError("now must be a function.");
    if (options.stepIntervalMs !== undefined
      && (!Number.isInteger(options.stepIntervalMs)
        || options.stepIntervalMs < 100 || options.stepIntervalMs > 5_000)) {
      throw new RangeError("stepIntervalMs must be an integer between 100 and 5000.");
    }
    this.#mode = options.mode;
    this.#runId = options.runId;
    this.#now = options.now;
    this.#stepIntervalMs = options.stepIntervalMs;
  }

  /**
   * Registration errors throw because the public API returns void.
   * A source offset at or before an accepted cancellation is stale; omitted
   * offsets attest to creation in the current epoch, not delayed remote creation.
   */
  registerDelegation(id: string, sourceOffsetMs?: number): void {
    const atMs = this.#time();
    const reject = (reason: string): never => {
      this.#emit(atMs, "delegation.rejected", null, isId(id) ? id : null, { reason });
      throw new Error(reason);
    };
    if (!isId(id)) reject("Invalid delegationId.");
    if (this.#stopped) reject("Engine is stopped.");
    if (sourceOffsetMs !== undefined
      && (!Number.isFinite(sourceOffsetMs) || sourceOffsetMs < 0 || sourceOffsetMs > atMs)) {
      reject("Creation offset must be finite, nonnegative, and not in the future.");
    }
    if (sourceOffsetMs !== undefined && this.#cancellationBarrierMs !== null
      && sourceOffsetMs <= this.#cancellationBarrierMs) {
      reject("Delegation creation is at or before the cancellation barrier.");
    }
    const existing = this.#delegations.get(id);
    if (existing) {
      if (existing.epoch !== this.#epoch) reject("Delegation belongs to a stale epoch.");
      if (existing.sourceOffsetMs !== sourceOffsetMs) {
        reject("Delegation registration cannot be changed.");
      }
      return;
    }
    this.#delegations.set(id, { epoch: this.#epoch, sourceOffsetMs });
    this.#emit(atMs, "delegation.registered", null, id, {
      epoch: this.#epoch,
      sourceOffsetMs: sourceOffsetMs ?? null,
    });
  }

  dispatch(request: CommandRequest): CommandResult {
    if (!isRecord(request)) return this.#reject(null, null, "Request must be an object.");
    const callId = isId(request.callId) ? request.callId : null;
    const delegationId = isId(request.delegationId) ? request.delegationId : null;
    if (callId === null || delegationId === null) {
      return this.#reject(callId, delegationId, "Invalid callId or delegationId.");
    }
    if (Object.keys(request).length !== 3
      || !Object.hasOwn(request, "command")
      || !Object.hasOwn(request, "callId")
      || !Object.hasOwn(request, "delegationId")) {
      return this.#reject(callId, delegationId, "Request must contain only callId, delegationId, and command.");
    }

    let command: GameCommand;
    try {
      command = parseGameCommand(request.command);
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      return this.#reject(callId, delegationId, `Invalid command: ${error.message}`);
    }

    const cached = this.#calls.get(callId);
    if (cached) {
      if (cached.delegationId !== delegationId || !sameCommand(cached.command, command)) {
        return this.#reject(callId, delegationId, "callId collision.");
      }
      // A retry replays the historical receipt, including after stop, not work.
      return { ...cached.result };
    }

    const atMs = this.#time();
    let result: CommandResult;
    const delegation = this.#delegations.get(delegationId);
    if (this.#stopped) {
      result = this.#reject(callId, delegationId, "Engine is stopped.", atMs);
    } else if (!delegation) {
      result = this.#reject(callId, delegationId, "Delegation is not registered.", atMs);
    } else if (delegation.epoch !== this.#epoch) {
      result = this.#reject(callId, delegationId, "Delegation belongs to a stale epoch.", atMs);
    } else if (command.type === "cancel") {
      this.#cancel(atMs, callId, delegationId, command.type);
      result = {
        outcome: this.#mode === "cancel-actions" ? "cancelled" : "observed-not-applied",
        operationId: null,
        reason: this.#mode === "cancel-actions"
          ? "Pending work cancelled."
          : "Cancellation observed; voice-only policy leaves pending work unchanged.",
      };
    } else {
      if (command.type === "replace") this.#cancel(atMs, callId, delegationId, command.type);
      const operation: Operation = {
        id: `${this.#runId}:operation:${this.#operations.length + 1}`,
        callId,
        delegationId,
        epoch: this.#epoch,
        cargo: command.cargo,
        destination: command.destination,
        status: "queued",
        createdAtMs: atMs,
        endedAtMs: null,
      };
      this.#operations.push(operation);
      this.#emit(atMs, "operation.queued", operation.id, delegationId, {
        callId,
        commandType: command.type,
        epoch: operation.epoch,
        cargo: operation.cargo,
        destination: operation.destination,
      });
      result = {
        outcome: "queued",
        operationId: operation.id,
        reason: command.type === "replace" && this.#mode === "voice-only"
          ? "Replacement queued without cancelling earlier work under voice-only policy."
          : "Operation queued.",
      };
    }
    this.#calls.set(callId, { delegationId, command, result });
    return { ...result };
  }

  /** Commits at most one step, and never starts a second operation in this tick. */
  tick(): void {
    if (this.#stopped) return;
    const operation = this.#operations.find(isPending);
    if (!operation) return;
    const atMs = this.#time();
    const target = operation.destination === "left" ? 0 : 6;
    const from = this.#cargo[operation.cargo];
    // Pace from queue admission or the last committed step; never catch up in a burst.
    if (from !== target && this.#stepIntervalMs !== undefined
      && atMs - Math.max(operation.createdAtMs, this.#lastStepAtMs) < this.#stepIntervalMs) {
      return;
    }
    if (operation.status === "queued") {
      operation.status = "running";
      this.#emit(atMs, "operation.started", operation.id, operation.delegationId, {
        callId: operation.callId,
        epoch: operation.epoch,
      });
    }
    if (from !== target) {
      const to = from + Math.sign(target - from);
      this.#cargo[operation.cargo] = to;
      this.#lastStepAtMs = atMs;
      this.#emit(atMs, "operation.step", operation.id, operation.delegationId, {
        callId: operation.callId,
        epoch: operation.epoch,
        cargo: operation.cargo,
        from,
        to,
      });
    }
    if (this.#cargo[operation.cargo] === target) {
      operation.status = "completed";
      operation.endedAtMs = atMs;
      this.#emit(atMs, "operation.completed", operation.id, operation.delegationId, {
        callId: operation.callId,
        epoch: operation.epoch,
        cargo: operation.cargo,
        destination: operation.destination,
      });
    }
  }

  /** Terminal host stop is unconditional in both experiment modes. */
  stop(reason: string): void {
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new TypeError("Stop reason must be a nonempty string.");
    }
    if (this.#stopped) return;
    const atMs = this.#time();
    this.#stopped = true;
    this.#epoch += 1;
    const cancelled = this.#invalidate(atMs);
    this.#emitCancelled(atMs, cancelled, "engine.stopped");
    this.#emit(atMs, "engine.stopped", null, null, {
      reason,
      epoch: this.#epoch,
      cancelledCount: cancelled.length,
    });
  }

  snapshot(): GameSnapshot {
    return {
      runId: this.#runId,
      mode: this.#mode,
      epoch: this.#epoch,
      cargo: { ...this.#cargo },
      operations: this.#operations.map((operation) => ({ ...operation })),
      events: this.#events.map((event) => ({ ...event, details: { ...event.details } })),
      stopped: this.#stopped,
    };
  }

  #time(): number {
    const atMs = this.#now();
    if (!Number.isFinite(atMs) || atMs < 0) {
      throw new RangeError("now must return finite, nonnegative run-relative milliseconds.");
    }
    return atMs;
  }

  #reject(
    callId: string | null,
    delegationId: string | null,
    reason: string,
    atMs = this.#time(),
  ): CommandResult {
    this.#emit(atMs, "command.rejected", null, delegationId, {
      callId,
      reason,
      epoch: this.#epoch,
    });
    return { outcome: "rejected", operationId: null, reason };
  }

  #cancel(atMs: number, callId: string, delegationId: string, commandType: string): void {
    if (this.#mode === "voice-only") {
      this.#emit(atMs, "cancellation.observed", null, delegationId, {
        callId,
        commandType,
        epoch: this.#epoch,
        applied: false,
      });
      return;
    }
    const previousEpoch = this.#epoch;
    this.#epoch += 1;
    this.#cancellationBarrierMs = Math.max(this.#cancellationBarrierMs ?? 0, atMs);
    const cancelled = this.#invalidate(atMs);
    this.#emit(atMs, "cancellation.accepted", null, delegationId, {
      callId,
      commandType,
      previousEpoch,
      epoch: this.#epoch,
      cancelledCount: cancelled.length,
    });
    this.#emitCancelled(atMs, cancelled, commandType);
  }

  #invalidate(atMs: number): Operation[] {
    const cancelled = this.#operations.filter(isPending);
    for (const operation of cancelled) {
      operation.status = "cancelled";
      operation.endedAtMs = atMs;
    }
    return cancelled;
  }

  #emitCancelled(atMs: number, operations: Operation[], reason: string): void {
    for (const operation of operations) {
      this.#emit(atMs, "operation.cancelled", operation.id, operation.delegationId, {
        callId: operation.callId,
        epoch: operation.epoch,
        reason,
      });
    }
  }

  #emit(
    atMs: number,
    kind: string,
    operationId: string | null,
    delegationId: string | null,
    details: LabEvent["details"],
  ): void {
    this.#events.push({
      sequence: this.#events.length + 1,
      atMs,
      kind,
      operationId,
      delegationId,
      details,
    });
  }
}

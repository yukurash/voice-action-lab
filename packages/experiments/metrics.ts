import type { CargoColor, ExperimentMode, GameSnapshot, LabEvent } from "../contracts/index.ts";

type CancelCommand = "cancel" | "replace";

export interface CancellationTarget {
  readonly sequence: number;
  readonly commandType: CancelCommand;
  readonly operationIds: readonly string[];
}

export interface PostCancellationStep {
  readonly operationId: string;
  readonly cancellationSequence: number;
  readonly stepSequence: number;
}

export interface ActionMetrics {
  readonly runId: string;
  readonly mode: ExperimentMode;
  readonly capturedAfterStop: boolean;
  /** Includes both standalone cancel and the cancellation phase of replace. */
  readonly cancelIntentAccepted: number;
  readonly cancelIntentIgnored: number;
  readonly cancelIntentsByCommand: Readonly<Record<CancelCommand, { accepted: number; ignored: number }>>;
  readonly acceptedCancellationTargets: readonly CancellationTarget[];
  readonly pendingOperationsCancelled: number;
  readonly cancelledOperationIds: readonly string[];
  readonly stepsAfterAcceptedCancellation: number;
  readonly postCancellationSteps: readonly PostCancellationStep[];
  readonly rejections: {
    readonly total: number;
    readonly late: number;
    readonly duplicateCallId: number;
    readonly unregistered: number;
    readonly terminal: number;
    readonly other: number;
  };
  /** Exact idempotent replays emit no engine event, so their count is not observable. */
  readonly idempotentReplayCount: null;
  /** Engine-visible corrections are replace operations, not inferred cancel-plus-move intent. */
  readonly correctionsQueued: number;
  readonly correctionsCompleted: number;
  readonly finalPositions: Readonly<Record<CargoColor, number>>;
}

function operationId(event: LabEvent): string {
  if (typeof event.operationId !== "string" || event.operationId.length === 0) {
    throw new Error(`Missing operation ID for ${event.kind}.`);
  }
  return event.operationId;
}

function cancelCommand(event: LabEvent): CancelCommand {
  const type = event.details.commandType;
  if (type !== "cancel" && type !== "replace") throw new Error("Invalid cancellation command type.");
  return type;
}

/**
 * Derive from the complete, ordered engine history captured before host cleanup.
 * Even if handed a stopped snapshot, engine.stopped cancellations are excluded.
 * No speech, source-clock alignment, or unobservable exact-replay metrics are inferred.
 */
export function deriveActionMetrics(snapshot: GameSnapshot): ActionMetrics {
  const pending = new Set<string>();
  const targeted = new Map<string, number>();
  const cancelled = new Set<string>();
  const corrections = new Set<string>();
  const completedCorrections = new Set<string>();
  const acceptedCancellationTargets: CancellationTarget[] = [];
  const postCancellationSteps: PostCancellationStep[] = [];
  const byCommand = { cancel: { accepted: 0, ignored: 0 }, replace: { accepted: 0, ignored: 0 } };
  const rejections = { total: 0, late: 0, duplicateCallId: 0, unregistered: 0, terminal: 0, other: 0 };
  let ignored = 0;
  for (const [index, event] of snapshot.events.entries()) {
    if (event.sequence !== index + 1) {
      throw new Error("Metrics require a complete, contiguous, ordered event history.");
    }
    switch (event.kind) {
      case "operation.queued": {
        const id = operationId(event);
        pending.add(id);
        if (event.details.commandType === "replace") corrections.add(id);
        break;
      }
      case "operation.completed": {
        const id = operationId(event);
        pending.delete(id);
        if (corrections.has(id)) completedCorrections.add(id);
        break;
      }
      case "operation.failed":
        pending.delete(operationId(event));
        break;
      case "operation.cancelled": {
        const id = operationId(event);
        if (targeted.has(id) && (event.details.reason === "cancel" || event.details.reason === "replace")) {
          cancelled.add(id);
        }
        pending.delete(id);
        break;
      }
      case "cancellation.accepted": {
        const commandType = cancelCommand(event);
        const ids = [...pending];
        acceptedCancellationTargets.push({ sequence: event.sequence, commandType, operationIds: ids });
        for (const id of ids) {
          if (!targeted.has(id)) targeted.set(id, event.sequence);
        }
        byCommand[commandType].accepted += 1;
        break;
      }
      case "cancellation.observed":
        byCommand[cancelCommand(event)].ignored += 1;
        ignored += 1;
        break;
      case "operation.step": {
        const id = operationId(event);
        const cancellationSequence = targeted.get(id);
        if (cancellationSequence !== undefined) {
          postCancellationSteps.push({ operationId: id, cancellationSequence, stepSequence: event.sequence });
        }
        break;
      }
      case "command.rejected":
      case "delegation.rejected": {
        rejections.total += 1;
        const reason = event.details.reason;
        if (reason === "Delegation belongs to a stale epoch."
          || reason === "Delegation creation is at or before the cancellation barrier.") {
          rejections.late += 1;
        } else if (event.kind === "command.rejected" && reason === "callId collision.") {
          rejections.duplicateCallId += 1;
        } else if (reason === "Delegation is not registered.") {
          rejections.unregistered += 1;
        } else if (reason === "Engine is stopped.") {
          rejections.terminal += 1;
        } else {
          rejections.other += 1;
        }
        break;
      }
    }
  }
  return {
    runId: snapshot.runId,
    mode: snapshot.mode,
    capturedAfterStop: snapshot.stopped,
    cancelIntentAccepted: acceptedCancellationTargets.length,
    cancelIntentIgnored: ignored,
    cancelIntentsByCommand: byCommand,
    acceptedCancellationTargets,
    pendingOperationsCancelled: cancelled.size,
    cancelledOperationIds: [...cancelled],
    stepsAfterAcceptedCancellation: postCancellationSteps.length,
    postCancellationSteps,
    rejections,
    idempotentReplayCount: null,
    correctionsQueued: corrections.size,
    correctionsCompleted: completedCorrections.size,
    finalPositions: { ...snapshot.cargo },
  };
}

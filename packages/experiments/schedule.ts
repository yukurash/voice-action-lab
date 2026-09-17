import type { ExperimentMode } from "../contracts/index.ts";
import type { ActionMetrics } from "./metrics.ts";

export interface ScheduleOptions {
  seed: number;
  /** Scenario content/voice stimuli belong to the runner, not this schedule. */
  scenarioIds: readonly [string, string, string, string, string];
}

export interface TrialSlot {
  readonly slotId: string;
  readonly ordinal: number;
  readonly pairId: string;
  readonly pairPosition: 1 | 2;
  readonly scenarioId: string;
  readonly repetition: number;
  readonly mode: ExperimentMode;
}

export interface TrialSchedule {
  readonly version: "paired-lcg32-v1";
  readonly seed: number;
  readonly scenarioIds: readonly string[];
  readonly repetitions: 10;
  readonly slots: readonly TrialSlot[];
}

export type TrialOutcome =
  | { readonly status: "completed"; readonly metrics: ActionMetrics }
  | { readonly status: "failed"; readonly errorCode: string; readonly metrics: ActionMetrics | null };

export interface TrialResult {
  readonly slotId: string;
  readonly outcome: TrialOutcome;
}

export interface TrialReport {
  readonly schedule: TrialSchedule;
  readonly trials: readonly {
    readonly slot: TrialSlot;
    readonly outcome: TrialOutcome | { readonly status: "not-run" };
  }[];
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(value);
}

/** Fifty adjacent pairs; each scenario has five A-first and five B-first pairs. */
export function createTrialSchedule(options: ScheduleOptions): TrialSchedule {
  if (!options || !Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffff_ffff) {
    throw new RangeError("Schedule seed must be an unsigned 32-bit integer.");
  }
  if (!Array.isArray(options.scenarioIds) || options.scenarioIds.length !== 5
    || !options.scenarioIds.every(validIdentifier) || new Set(options.scenarioIds).size !== 5) {
    throw new TypeError("Exactly five distinct scenario identifiers are required.");
  }
  let state = options.seed;
  const shuffle = <T>(values: readonly T[]): T[] => {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const other = Math.floor((state / 0x1_0000_0000) * (index + 1));
      const first = result[index];
      const second = result[other];
      if (first === undefined || second === undefined) throw new Error("Invalid schedule shuffle index.");
      result[index] = second;
      result[other] = first;
    }
    return result;
  };
  const pairs = options.scenarioIds.flatMap((scenarioId, scenarioIndex) => {
    const firstModes: ExperimentMode[] = Array.from({ length: 10 }, (_, index) =>
      index < 5 ? "voice-only" : "cancel-actions");
    return shuffle(firstModes).map((firstMode, index) => ({
      scenarioId,
      repetition: index + 1,
      pairId: `pair-${options.seed}-${scenarioIndex + 1}-${index + 1}`,
      firstMode,
    }));
  });
  const slots = shuffle(pairs).flatMap((pair, index): TrialSlot[] => {
    const secondMode = pair.firstMode === "voice-only" ? "cancel-actions" : "voice-only";
    const modes: ExperimentMode[] = [pair.firstMode, secondMode];
    return modes.map((mode, position): TrialSlot => Object.freeze({
      slotId: `${pair.pairId}-${mode}`,
      ordinal: index * 2 + position + 1,
      pairId: pair.pairId,
      pairPosition: position === 0 ? 1 : 2,
      scenarioId: pair.scenarioId,
      repetition: pair.repetition,
      mode,
    }));
  });
  return Object.freeze({
    version: "paired-lcg32-v1",
    seed: options.seed,
    scenarioIds: Object.freeze([...options.scenarioIds]),
    repetitions: 10,
    slots: Object.freeze(slots),
  });
}

/** Retains the entire plan: failures are rows, and missing results are explicitly not-run. */
export function createTrialReport(schedule: TrialSchedule, results: readonly TrialResult[]): TrialReport {
  const slots = new Map(schedule.slots.map((slot) => [slot.slotId, slot]));
  const outcomes = new Map<string, TrialOutcome>();
  for (const result of results) {
    const slot = slots.get(result.slotId);
    if (!slot) throw new Error("Result references an unknown planned slot.");
    if (outcomes.has(result.slotId)) throw new Error("Duplicate result for a planned slot.");
    const outcome = result.outcome;
    if (outcome.status !== "completed" && outcome.status !== "failed") {
      throw new Error("Invalid trial outcome status.");
    }
    if (outcome.status === "failed" && !validIdentifier(outcome.errorCode)) {
      throw new Error("A failed trial requires a sanitized errorCode, not raw error text.");
    }
    if (outcome.status === "completed" && !outcome.metrics) {
      throw new Error("A completed trial requires action metrics.");
    }
    if (outcome.metrics !== null && outcome.metrics.mode !== slot.mode) {
      throw new Error("Trial metrics mode does not match the planned mode.");
    }
    outcomes.set(result.slotId, structuredClone(outcome));
  }
  return {
    schedule,
    trials: schedule.slots.map((slot) => ({
      slot,
      outcome: outcomes.get(slot.slotId) ?? { status: "not-run" },
    })),
  };
}

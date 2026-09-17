import type { TrialSlot } from "./schedule.ts";
import type { RecordedTrialResult, RunManifest } from "./runner-model.ts";
import { ExperimentRunError, RUN_SCENARIOS, actionObservationCompleted, parseRecordedResult, parseRunManifest } from "./runner-model.ts";
import { PCM_RULES } from "./pcm.ts";

export interface Distribution {
  total: number;
  n: number;
  missing: number;
  p50: number | null;
  p95: number | null;
}

/** Nearest-rank quantiles; missing values never become zero or disappear from the denominator. */
export function summarizeDistribution(values: readonly (number | null)[]): Distribution {
  if (values.some((value) => value !== null && (!Number.isFinite(value) || value < 0))) {
    throw new ExperimentRunError("invalid_metric");
  }
  const available = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const percentile = (fraction: number) => available[Math.ceil(fraction * available.length) - 1] ?? null;
  return {
    total: values.length, n: available.length, missing: values.length - available.length,
    p50: percentile(0.5), p95: percentile(0.95),
  };
}

export interface AnalysisRow {
  slot: TrialSlot;
  status: "not-run" | "completed" | "failed";
  result: RecordedTrialResult | null;
  actionObservationCompleted: boolean;
  observedGoalMet: boolean | null;
}

export function analyzeRecordedTrials(manifest: RunManifest, results: readonly RecordedTrialResult[]) {
  manifest = parseRunManifest(manifest);
  const slots = new Map(manifest.schedule.slots.map((slot) => [slot.slotId, slot]));
  const indexed = new Map<string, RecordedTrialResult>();
  for (const result of results) {
    const slot = slots.get(result.slotId);
    if (!slot || slot.ordinal > manifest.execution.limit || indexed.has(result.slotId)) throw new ExperimentRunError("invalid_result_set");
    indexed.set(result.slotId, parseRecordedResult(result, manifest, slot));
  }
  const rows: AnalysisRow[] = manifest.schedule.slots.map((slot) => {
    const result = indexed.get(slot.slotId) ?? null;
    const completed = result !== null && actionObservationCompleted(manifest, slot, result);
    return { slot, status: result?.status ?? "not-run", result,
      actionObservationCompleted: completed, observedGoalMet: completed ? result?.goalMet ?? null : null };
  });
  const summarize = (group: readonly AnalysisRow[]) => ({
    planned: group.length,
    completed: group.filter((row) => row.status === "completed").length,
    failed: group.filter((row) => row.status === "failed").length,
    notRun: group.filter((row) => row.status === "not-run").length,
    goalMet: group.filter((row) => row.observedGoalMet === true).length,
    actionObservations: {
      total: group.length,
      n: group.filter((row) => row.actionObservationCompleted).length,
      missing: group.filter((row) => !row.actionObservationCompleted).length,
      goalMet: group.filter((row) => row.observedGoalMet === true).length,
      goalNotMet: group.filter((row) => row.observedGoalMet === false).length,
    },
    reservationsReleased: group.filter((row) => row.result?.cleanup.reservationReleased === true).length,
    conditionUnmet: group.filter((row) => row.result?.conditionMet === false).length,
    finalUsageConfirmed: group.filter((row) => row.result?.cleanup.usage.status === "confirmed").length,
    elapsedMs: summarizeDistribution(group.map((row) => row.result?.timings.elapsedMs ?? null)),
    observationMs: summarizeDistribution(group.map((row) => row.result?.timings.observationMs ?? null)),
    observationActualMs: summarizeDistribution(group.map((row) => row.result?.timings.observationActualMs ?? null)),
    cleanupMs: summarizeDistribution(group.map((row) => row.result?.timings.cleanupMs ?? null)),
    cancelIntentAccepted: summarizeDistribution(group.map((row) => row.result?.actionMetrics?.cancelIntentAccepted ?? null)),
    cancelIntentIgnored: summarizeDistribution(group.map((row) => row.result?.actionMetrics?.cancelIntentIgnored ?? null)),
    pendingOperationsCancelled: summarizeDistribution(group.map((row) => row.result?.actionMetrics?.pendingOperationsCancelled ?? null)),
    stepsAfterAcceptedCancellation: summarizeDistribution(group.map((row) => row.result?.actionMetrics?.stepsAfterAcceptedCancellation ?? null)),
    lateRejections: summarizeDistribution(group.map((row) => row.result?.actionMetrics?.rejections.late ?? null)),
    duplicateCallIdRejections: summarizeDistribution(group.map((row) => row.result?.actionMetrics?.rejections.duplicateCallId ?? null)),
    correctionsQueued: summarizeDistribution(group.map((row) => row.result?.actionMetrics?.correctionsQueued ?? null)),
    correctionsCompleted: summarizeDistribution(group.map((row) => row.result?.actionMetrics?.correctionsCompleted ?? null)),
    idempotentReplayCount: null,
    voiceMetrics: {
      status: group.some((row) => row.result?.voiceMetrics) ? "collected" : "not-collected",
      metric: PCM_RULES.metric,
      ...summarizeDistribution(group.map((row) => row.result?.voiceMetrics?.data.inputStartToReceivedPcmSilenceMs ?? null)),
      missingReasons: Object.fromEntries([...new Set(group.map((row) =>
        row.result?.voiceMetrics?.data.missingReason ?? (row.result?.voiceMetrics ? null : "not_collected")))]
        .filter((reason) => reason !== null).sort().map((reason) => [
          reason, group.filter((row) => (row.result?.voiceMetrics?.data.missingReason
            ?? (row.result?.voiceMetrics ? null : "not_collected")) === reason).length,
        ])),
      inputSamples: summarizeDistribution(group.map((row) => row.result?.voiceMetrics?.data.diagnostics.inputSamples ?? null)),
      outputSamples: summarizeDistribution(group.map((row) => row.result?.voiceMetrics?.data.diagnostics.outputSamples ?? null)),
      measurementEvents: summarizeDistribution(group.map((row) => row.result?.voiceMetrics?.data.diagnostics.measurementEvents ?? null)),
      transcriptEvents: summarizeDistribution(group.map((row) => row.result?.voiceMetrics?.data.diagnostics.transcriptEventCount ?? null)),
    },
  });
  return {
    schemaVersion: 1 as const,
    manifest,
    formalComplete: manifest.execution.formal && rows.length === 100 && rows.every((row) => row.result !== null),
    totals: summarize(rows),
    groups: RUN_SCENARIOS.flatMap((scenarioId) => (["voice-only", "cancel-actions"] as const).map((mode) => ({
      scenarioId, mode, ...summarize(rows.filter((row) => row.slot.scenarioId === scenarioId && row.slot.mode === mode)),
    }))),
    rows,
  };
}

export type ExperimentAnalysis = ReturnType<typeof analyzeRecordedTrials>;

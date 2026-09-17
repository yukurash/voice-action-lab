import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { GameEngine } from "../packages/game-engine/index.ts";
import { deriveActionMetrics } from "../packages/experiments/metrics.ts";
import { analyzeRecordedTrials, summarizeDistribution } from "../packages/experiments/aggregation.ts";
import {
  RUN_RULES, createRunManifest, finalUsage, interruptedResult, jsonHash, judgeAction,
  pacingEvidence, parseRecordedResult, sanitizeSnapshot,
} from "../packages/experiments/runner-model.ts";
import type { RecordedTrialResult, TrialStarted } from "../packages/experiments/runner-model.ts";
import type { TrialSlot } from "../packages/experiments/schedule.ts";
import { openRunStore, writeExclusiveArtifact } from "../scripts/run-experiments.ts";
import { analyzeExperimentDirectory, runAnalysisCli } from "../scripts/analyze-experiments.ts";
import { SYNTHETIC_FIXTURES } from "./synthetic-scenarios.ts";

const UTC = "2026-09-17T00:00:00.000Z";
function manifest() {
  const hash = "a".repeat(64);
  const sourceCommit = "b".repeat(40);
  return createRunManifest({
    createdAt: UTC, seed: 42, formal: true, limit: 100, sourceCommit,
    sourceFiles: { "scripts/run-experiments.ts": hash }, imageDigest: `sha256:${hash}`,
    configuration: {
      schemaVersion: 1, settings: {
        liveModel: "test-live", backendModel: "test-backend", sourceCommit,
        stepIntervalMs: 3000, tickMs: 500, sessionLimitMs: 600_000, idleLimitMs: 90_000, sourceOffsetsSynchronized: false,
      },
      closeTimeoutMs: 5000, protocolSha256: hash,
    },
    fixtureManifestSha256: hash,
    fixtures: SYNTHETIC_FIXTURES.map(({ id }) => ({ id, file: `${id}.wav`, bytes: 48, sha256: hash })),
    pcmContractVersion: "unit-test-pcm-v1",
  });
}

function normalRecord(): { manifest: ReturnType<typeof manifest>; slot: TrialSlot; result: RecordedTrialResult } {
  const plan = manifest();
  const slot = plan.schedule.slots.find((entry) => entry.scenarioId === "normal" && entry.mode === "voice-only");
  assert.ok(slot);
  let now = 1000;
  const engine = new GameEngine({ mode: slot.mode, runId: "normal-analysis", now: () => now, stepIntervalMs: 3000 });
  engine.registerDelegation("move");
  engine.dispatch({ callId: "move", delegationId: "move", command: { type: "move", cargo: "red", destination: "right" } });
  for (now = 4000; now <= 19_000; now += 3000) engine.tick();
  const snapshot = sanitizeSnapshot(engine.snapshot());
  const metrics = deriveActionMetrics(snapshot);
  const result: RecordedTrialResult = {
    schemaVersion: 1, manifestSha256: jsonHash(plan), slotId: slot.slotId, attemptId: "attempt-1", startedAt: UTC,
    status: "completed", failureCode: null, finishedAt: "2026-09-17T00:00:47.000Z", recoveredAt: null,
    preCleanupSnapshot: snapshot, actionMetrics: metrics, conditionMet: true,
    timings: {
      elapsedMs: 47_000, snapshotAtMs: 46_000, initialEndMs: 1000, secondEndMs: null,
      observationMs: 45_000, observationActualMs: 45_000, cleanupMs: 1000,
    },
    cleanup: { reservationReleased: true, usage: { scope: "voice-session-only", status: "confirmed", metrics: { session_seconds: 47 } } },
    voiceMetrics: null, goalMet: judgeAction("normal", snapshot, metrics),
  };
  return { manifest: plan, slot, result };
}

test("nearest-rank p50/p95 retain exact n and missing counts, including all-missing groups", () => {
  assert.deepEqual(summarizeDistribution([null, 0, 10, 20, 30, null]), { total: 6, n: 4, missing: 2, p50: 10, p95: 30 });
  assert.deepEqual(summarizeDistribution([null, null]), { total: 2, n: 0, missing: 2, p50: null, p95: null });
  assert.deepEqual(summarizeDistribution([]), { total: 0, n: 0, missing: 0, p50: null, p95: null });
  assert.equal(summarizeDistribution(Array.from({ length: 100 }, (_, index) => index + 1)).p95, 95);
  assert.throws(() => summarizeDistribution([NaN]), /invalid_metric/);
  assert.throws(() => summarizeDistribution([-1]), /invalid_metric/);
});

test("analysis includes all 100 counterbalanced rows and preserves missing, failed, and completed denominators", () => {
  const { manifest: plan, result } = normalRecord();
  const other = plan.schedule.slots.find((entry) => entry.slotId !== result.slotId);
  assert.ok(other);
  const failed = interruptedResult({
    schemaVersion: 1, manifestSha256: jsonHash(plan), slotId: other.slotId, attemptId: "interrupted-2", startedAt: UTC,
  }, UTC);
  const report = analyzeRecordedTrials(plan, [failed, result]);
  assert.equal(report.rows.length, 100);
  assert.equal(report.totals.planned, 100);
  assert.equal(report.totals.completed, 1);
  assert.equal(report.totals.failed, 1);
  assert.equal(report.totals.notRun, 98);
  assert.equal(report.totals.goalMet, 1);
  assert.equal(report.formalComplete, false);
  assert.equal(report.totals.elapsedMs.n, 1);
  assert.equal(report.totals.elapsedMs.missing, 99);
  assert.equal(report.totals.cancelIntentAccepted.n, 1);
  assert.equal(report.totals.cancelIntentAccepted.p50, 0);
  assert.equal(report.totals.idempotentReplayCount, null);
  assert.equal(report.totals.voiceMetrics.status, "not-collected");
  assert.equal(report.totals.voiceMetrics.n, 0);
  assert.equal(report.totals.voiceMetrics.missing, 100);
  assert.equal(report.totals.voiceMetrics.p50, null);
  assert.deepEqual(report.totals.voiceMetrics.missingReasons, { not_collected: 100 });
  assert.equal(report.groups.length, 10);
  assert.ok(report.groups.every((group) => group.planned === 10));
  for (let index = 0; index < 100; index += 2) {
    const a = report.rows[index]?.slot;
    const b = report.rows[index + 1]?.slot;
    assert.equal(a?.pairId, b?.pairId);
    assert.notEqual(a?.mode, b?.mode);
    assert.equal(a?.repetition, b?.repetition);
  }
  assert.throws(() => analyzeRecordedTrials(plan, [result, result]), /invalid_result_set/);
  assert.throws(() => analyzeRecordedTrials(plan, [{ ...result, slotId: "unknown" }]), /invalid_result_set/);
});

test("persisted result validation recomputes action metrics and rejects false completion or secret extensions", () => {
  const { manifest: plan, slot, result } = normalRecord();
  assert.deepEqual(parseRecordedResult(result, plan, slot), result);
  for (const invalid of [
    { ...result, goalMet: false },
    { ...result, actionMetrics: { ...result.actionMetrics, idempotentReplayCount: 0 } },
    { ...result, voiceMetrics: { guessedLatency: 1 } },
    { ...result, finishedAt: null },
    { ...result, token: "PRIVATE_SECRET" },
    { ...result, cleanup: { ...result.cleanup, usage: { ...result.cleanup.usage, metrics: { secret: 1 } } } },
    { ...result, timings: { ...result.timings, observationActualMs: 44_999 } },
    { ...result, timings: { ...result.timings, elapsedMs: 180_001 } },
    { ...result, timings: { ...result.timings, initialEndMs: 50_000 } },
    { ...result, timings: { ...result.timings, snapshotAtMs: 44_000 } },
    { ...result, preCleanupSnapshot: { ...result.preCleanupSnapshot, stopped: true } },
  ]) assert.throws(() => parseRecordedResult(invalid, plan, slot), /invalid_artifact/);
});

test("action achievement is independent of usage confirmation but never counts arbitrary partial failures", () => {
  const { manifest: plan, result } = normalRecord();
  const usageMissing: RecordedTrialResult = {
    ...result, status: "failed", failureCode: "cleanup_unconfirmed",
    cleanup: { ...result.cleanup, usage: { scope: "voice-session-only", status: "unconfirmed", metrics: null } },
  };
  const confirmed = analyzeRecordedTrials(plan, [result]);
  const unconfirmed = analyzeRecordedTrials(plan, [usageMissing]);
  assert.deepEqual(confirmed.totals.actionObservations, unconfirmed.totals.actionObservations);
  assert.deepEqual(unconfirmed.totals.actionObservations, { total: 100, n: 1, missing: 99, goalMet: 1, goalNotMet: 0 });
  assert.equal(unconfirmed.totals.goalMet, 1);
  assert.equal(unconfirmed.totals.failed, 1);
  assert.equal(unconfirmed.totals.finalUsageConfirmed, 0);
  assert.equal(unconfirmed.totals.reservationsReleased, 1);
  const row = unconfirmed.rows.find((entry) => entry.slot.slotId === result.slotId);
  assert.equal(row?.actionObservationCompleted, true);
  assert.equal(row?.observedGoalMet, true);
  for (const partial of [
    { ...usageMissing, failureCode: "driver_failed" },
    { ...usageMissing, failureCode: "input_pcm_unconfirmed" },
    { ...usageMissing, failureCode: "pcm_contract_invalid" },
    { ...usageMissing, timings: { ...usageMissing.timings, observationActualMs: 1000 } },
  ]) {
    assert.equal(partial.goalMet, true);
    const report = analyzeRecordedTrials(plan, [partial]);
    assert.deepEqual(report.totals.actionObservations, { total: 100, n: 0, missing: 100, goalMet: 0, goalNotMet: 0 });
    assert.equal(report.rows.find((entry) => entry.slot.slotId === result.slotId)?.observedGoalMet, null);
  }
});

test("accepted pending cancellation and emergency cleanup are distinct; bad post-cancel steps fail judgment", () => {
  let now = 0;
  const engine = new GameEngine({ mode: "cancel-actions", runId: "cancellation-analysis", now: () => now, stepIntervalMs: 3000 });
  engine.registerDelegation("move");
  engine.dispatch({ callId: "move", delegationId: "move", command: { type: "move", cargo: "red", destination: "right" } });
  now = 3000;
  engine.tick();
  engine.registerDelegation("cancel");
  engine.dispatch({ callId: "cancel", delegationId: "cancel", command: { type: "cancel" } });
  const before = engine.snapshot();
  const metrics = deriveActionMetrics(before);
  assert.equal(metrics.cancelIntentAccepted, 1);
  assert.equal(metrics.pendingOperationsCancelled, 1);
  assert.equal(metrics.stepsAfterAcceptedCancellation, 0);
  assert.equal(judgeAction("cancel", before, metrics), true);
  engine.stop("emergency-cleanup");
  const after = deriveActionMetrics(engine.snapshot());
  assert.equal(after.cancelIntentAccepted, 1);
  assert.equal(after.pendingOperationsCancelled, 1);
  assert.equal(after.capturedAfterStop, true);
  const target = before.operations[0];
  assert.ok(target);
  before.events.push({
    sequence: before.events.length + 1, atMs: 6000, kind: "operation.step",
    operationId: target.id, delegationId: target.delegationId, details: { from: 1, to: 2 },
  });
  const invalid = deriveActionMetrics(before);
  assert.equal(invalid.stepsAfterAcceptedCancellation, 1);
  assert.equal(judgeAction("cancel", before, invalid), false);
  const untouched = new GameEngine({ mode: "cancel-actions", runId: "emergency-only", now: () => now });
  untouched.registerDelegation("move");
  untouched.dispatch({ callId: "move", delegationId: "move", command: { type: "move", cargo: "red", destination: "right" } });
  untouched.stop("emergency-cleanup");
  assert.equal(deriveActionMetrics(untouched.snapshot()).pendingOperationsCancelled, 0);
  assert.equal(deriveActionMetrics(untouched.snapshot()).cancelIntentAccepted, 0);
});

test("first and inter-step pacing are measured from actual admitted operations, never source offsets", () => {
  const { result } = normalRecord();
  const snapshot = result.preCleanupSnapshot;
  assert.ok(snapshot);
  assert.deepEqual(pacingEvidence(snapshot), { observedSteps: 6, violations: 0 });
  const first = snapshot.events.find((event) => event.kind === "operation.step");
  assert.ok(first);
  first.details.sourceOffsetMs = -999_999;
  assert.equal(pacingEvidence(snapshot).violations, 0);
  first.atMs -= 1;
  assert.equal(pacingEvidence(snapshot).violations, 1);
});

test("post-cleanup final usage is separately allowlisted and never mixed with pre-cleanup action events", () => {
  const { result } = normalRecord();
  const snapshot = result.preCleanupSnapshot;
  assert.ok(snapshot);
  assert.equal(finalUsage(snapshot).status, "unconfirmed");
  snapshot.events.push({
    sequence: snapshot.events.length + 1, atMs: 47_000, kind: "final_usage_confirmed",
    delegationId: null, operationId: null,
    details: { session_seconds: 47, total_tokens: 100, transcript: "PRIVATE_CONTENT", input_tokens: -1 },
  });
  assert.deepEqual(finalUsage(snapshot), {
    scope: "voice-session-only", status: "confirmed", metrics: { session_seconds: 47, total_tokens: 100 },
  });
});

test("analyzer writes a new exclusive report, includes interrupted slots, and never changes source records", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "experiment-analysis-tests-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repository = join(base, "public-repo");
  const output = join(base, "private-run");
  await mkdir(repository);
  const { manifest: plan, slot, result } = normalRecord();
  const store = await openRunStore(repository, output);
  await store.initialize(plan, false);
  const { schemaVersion, manifestSha256, slotId, attemptId, startedAt } = result;
  await store.start(plan, slot, { schemaVersion, manifestSha256, slotId, attemptId, startedAt });
  await store.result(plan, slot, result);
  const other = plan.schedule.slots.find((entry) => entry.slotId !== slot.slotId);
  assert.ok(other);
  const incomplete: TrialStarted = { schemaVersion: 1, manifestSha256, slotId: other.slotId, attemptId: "crash", startedAt: UTC };
  await store.start(plan, other, incomplete);
  await assert.rejects(analyzeExperimentDirectory(repository, output, "blocked.json"), /runner_locked/);
  await store.close();
  const before = await readdir(join(output, "slots"));
  const original = await readFile(join(output, "manifest.json"), "utf8");
  const analyzed = await analyzeExperimentDirectory(repository, output, "analysis.json");
  assert.equal(analyzed.totals.failed, 1);
  assert.equal(analyzed.totals.completed, 1);
  assert.equal(analyzed.rows.length, 100);
  assert.deepEqual(await readdir(join(output, "slots")), before);
  assert.equal(await readFile(join(output, "manifest.json"), "utf8"), original);
  const reportPath = join(output, "reports", "analysis.json");
  const reportBytes = await readFile(reportPath, "utf8");
  const envelope = JSON.parse(reportBytes);
  assert.equal(envelope.sha256, jsonHash(envelope.payload));
  await assert.rejects(analyzeExperimentDirectory(repository, output, "analysis.json"), /EEXIST/);
  assert.equal(await readFile(reportPath, "utf8"), reportBytes);
  await assert.rejects(analyzeExperimentDirectory(repository, output, "../unsafe.json"), /invalid_report_name/);
  await writeExclusiveArtifact(repository, output, "slots/101.started.json", incomplete);
  await assert.rejects(analyzeExperimentDirectory(repository, output, "corrupted.json"), /invalid_artifact/);
});

test("analysis CLI rejects missing inputs with a fixed sanitized nonzero error", async (t) => {
  const messages: string[] = [];
  t.mock.method(console, "error", (message: string) => messages.push(message));
  assert.equal(await runAnalysisCli([]), 1);
  assert.deepEqual(messages, ["experiment analysis failed: invalid_arguments"]);
  assert.equal(RUN_RULES.quantiles, "nearest-rank");
});

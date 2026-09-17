import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  createTrialReport,
  createTrialSchedule,
  deriveActionMetrics,
  resolveExternalOutputPath,
} from "../packages/experiments/index.ts";
import type { ScheduleOptions } from "../packages/experiments/index.ts";
import { GameEngine } from "../packages/game-engine/index.ts";
import type { ExperimentMode, GameCommand, GameSnapshot, LabEvent } from "../packages/contracts/index.ts";

const scenarioIds = ["move", "cancel-before", "cancel-during", "replace", "queued-cancel"] as const;
const red: GameCommand = { type: "move", cargo: "red", destination: "right" };
const blue: GameCommand = { type: "move", cargo: "blue", destination: "right" };
const replacement: GameCommand = { type: "replace", cargo: "red", destination: "left" };

function game(mode: ExperimentMode = "cancel-actions") {
  let now = 0;
  const engine = new GameEngine({ mode, runId: "metrics-test", now: () => now });
  engine.registerDelegation("original");
  return {
    engine,
    dispatch(callId: string, command: GameCommand, delegationId = "original") {
      return engine.dispatch({ callId, delegationId, command });
    },
    tick(count = 1) {
      for (let index = 0; index < count; index += 1) {
        now += 1;
        engine.tick();
      }
    },
    fresh(id = "fresh") { now += 1; engine.registerDelegation(id, now); },
  };
}

test("schedule always contains all 100 slots and exactly balanced adjacent A/B pairs", () => {
  for (const seed of [0, 1, 42, 0xffff_ffff]) {
    const plan = createTrialSchedule({ seed, scenarioIds });
    assert.equal(plan.seed, seed);
    assert.equal(plan.version, "paired-lcg32-v1");
    assert.equal(plan.repetitions, 10);
    assert.equal(plan.slots.length, 100);
    assert.equal(new Set(plan.slots.map((slot) => slot.slotId)).size, 100);
    assert.equal(new Set(plan.slots.map((slot) => slot.pairId)).size, 50);
    assert.deepEqual(plan.slots.map((slot) => slot.ordinal), Array.from({ length: 100 }, (_, i) => i + 1));
    for (const scenarioId of scenarioIds) {
      const slots = plan.slots.filter((slot) => slot.scenarioId === scenarioId);
      assert.equal(slots.length, 20);
      for (const mode of ["voice-only", "cancel-actions"]) {
        assert.equal(slots.filter((slot) => slot.mode === mode).length, 10);
        assert.equal(slots.filter((slot) => slot.mode === mode && slot.pairPosition === 1).length, 5);
      }
      for (let repetition = 1; repetition <= 10; repetition += 1) {
        const pair = slots.filter((slot) => slot.repetition === repetition);
        assert.equal(pair.length, 2);
        const [first, second] = pair;
        assert.ok(first && second);
        assert.equal(second.ordinal, first.ordinal + 1);
        assert.equal(first.pairId, second.pairId);
        assert.equal(first.pairPosition, 1);
        assert.equal(second.pairPosition, 2);
        assert.notEqual(first.mode, second.mode);
      }
    }
  }
});

test("schedule is reproducible, seed-sensitive, and insulated from caller mutation", () => {
  const first = createTrialSchedule({ seed: 77, scenarioIds });
  assert.deepEqual(first, createTrialSchedule({ seed: 77, scenarioIds }));
  assert.notDeepEqual(first.slots, createTrialSchedule({ seed: 78, scenarioIds }).slots);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.slots), true);
  assert.equal(Object.isFrozen(first.scenarioIds), true);
  assert.ok(first.slots.every(Object.isFrozen));
  const options: ScheduleOptions = { seed: 77, scenarioIds: [...scenarioIds] };
  const copy = createTrialSchedule(options);
  Reflect.set(options.scenarioIds, 0, "changed");
  assert.deepEqual(copy, first);
});

test("schedule rejects invalid seeds and anything other than five unique scenario IDs", () => {
  for (const seed of [-1, 0x1_0000_0000, 1.5, NaN, Infinity, "1", null]) {
    assert.throws(() => createTrialSchedule({ seed, scenarioIds } as ScheduleOptions), /seed/i);
  }
  for (const ids of [[], ["one"], [...scenarioIds, "sixth"], ["a", "a", "b", "c", "d"],
    ["", "b", "c", "d", "e"], ["a b", "b", "c", "d", "e"], ["a", "b", "c", "d", 5]]) {
    const invalid: unknown = { seed: 1, scenarioIds: ids };
    assert.throws(() => createTrialSchedule(invalid as ScheduleOptions), /five/i);
  }
});

test("trial reports retain failures, missing trials, seed, and every planned slot", () => {
  const schedule = createTrialSchedule({ seed: 9, scenarioIds });
  const [first, second] = schedule.slots;
  assert.ok(first && second);
  const metrics = deriveActionMetrics(game(first.mode).engine.snapshot());
  const report = createTrialReport(schedule, [
    { slotId: second.slotId, outcome: { status: "failed", errorCode: "connection_timeout", metrics: null } },
    { slotId: first.slotId, outcome: { status: "completed", metrics } },
  ]);
  assert.equal(report.schedule.seed, 9);
  assert.equal(report.trials.length, 100);
  assert.deepEqual(report.trials.map((trial) => trial.slot), schedule.slots);
  assert.equal(report.trials[0]?.outcome.status, "completed");
  assert.deepEqual(report.trials[1]?.outcome, { status: "failed", errorCode: "connection_timeout", metrics: null });
  assert.equal(report.trials.filter((trial) => trial.outcome.status === "not-run").length, 98);
  Reflect.set(metrics.finalPositions, "red", 5);
  const outcome = report.trials[0]?.outcome;
  assert.ok(outcome?.status === "completed");
  assert.equal(outcome.metrics.finalPositions.red, 0);
  assert.equal(createTrialReport(schedule, []).trials.length, 100);
});

test("trial reports reject duplicate/unknown slots, wrong modes, and unsanitized failure text", () => {
  const schedule = createTrialSchedule({ seed: 9, scenarioIds });
  const slot = schedule.slots[0];
  assert.ok(slot);
  const failure = { slotId: slot.slotId, outcome: { status: "failed", errorCode: "timeout", metrics: null } } as const;
  assert.throws(() => createTrialReport(schedule, [failure, failure]), /duplicate/i);
  assert.throws(() => createTrialReport(schedule, [{ ...failure, slotId: "unknown" }]), /unknown/i);
  assert.throws(() => createTrialReport(schedule, [{
    slotId: slot.slotId,
    outcome: { status: "failed", errorCode: "raw exception with transcript", metrics: null },
  }]), /sanitized/i);
  const otherMode = slot.mode === "voice-only" ? "cancel-actions" : "voice-only";
  assert.throws(() => createTrialReport(schedule, [{
    slotId: slot.slotId, outcome: { status: "completed", metrics: deriveActionMetrics(game(otherMode).engine.snapshot()) },
  }]), /mode/i);
});

async function filesystem(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "voice-action-experiments-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repository = join(base, "public-repo");
  const external = join(base, "external");
  await mkdir(repository);
  await mkdir(external);
  return { base, repository, external };
}

async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

test("output guard returns canonical external paths, supports new ancestors, and creates no output", async (t) => {
  const { repository, external, base } = await filesystem(t);
  const output = join(external, "new", "nested", "trial.json");
  assert.equal(await resolveExternalOutputPath(output, repository), join(await realpath(external), "new", "nested", "trial.json"));
  await assert.rejects(stat(output), { code: "ENOENT" });
  assert.equal(await resolveExternalOutputPath(external, repository), await realpath(external));
  const sibling = join(base, "public-repo-copy", "out.json");
  assert.equal(await resolveExternalOutputPath(sibling, repository), sibling);
});

test("output guard rejects the repository, all descendants, and normalized traversal into it", async (t) => {
  const { repository, external } = await filesystem(t);
  await writeFile(join(repository, "existing.json"), "{}");
  for (const candidate of [
    repository, join(repository, "existing.json"), join(repository, "new", "out.json"),
    resolve(external, "..", "public-repo", "out.json"),
  ]) await assert.rejects(resolveExternalOutputPath(candidate, repository), /outside the public repository/i);
  if (process.platform === "win32") {
    await assert.rejects(resolveExternalOutputPath(join(repository.toUpperCase(), "new.json"), repository), /outside/i);
  }
});

test("output guard resolves an external symlink ancestor into the public repository and rejects it", async (t) => {
  const { repository, external } = await filesystem(t);
  const alias = join(external, "repository-alias");
  await linkDirectory(repository, alias);
  await assert.rejects(resolveExternalOutputPath(join(alias, "new", "out.json"), repository), /outside/i);
  await assert.rejects(resolveExternalOutputPath(join(repository, "out.json"), alias), /outside/i);
});

test("output guard rejects paths inside the repo even when their symlink target is external", async (t) => {
  const { repository, external } = await filesystem(t);
  const exit = join(repository, "exit");
  await linkDirectory(external, exit);
  await assert.rejects(resolveExternalOutputPath(join(exit, "out.json"), repository), /outside/i);
  const alias = join(external, "via-repo");
  await linkDirectory(repository, alias);
  await assert.rejects(resolveExternalOutputPath(join(alias, "exit", "out.json"), repository), /outside/i);
});

test("output guard canonicalizes safe aliases and rejects dangling links or non-directory ancestors", async (t) => {
  const { repository, external, base } = await filesystem(t);
  const alias = join(base, "safe-alias");
  await linkDirectory(external, alias);
  assert.equal(await resolveExternalOutputPath(join(alias, "new", "out.json"), repository),
    join(await realpath(external), "new", "out.json"));
  const dangling = join(external, "dangling");
  await linkDirectory(join(base, "missing-target"), dangling);
  await assert.rejects(resolveExternalOutputPath(join(dangling, "out.json"), repository), /dangling/i);
  const file = join(external, "file");
  await writeFile(file, "fixture");
  await assert.rejects(resolveExternalOutputPath(join(file, "out.json"), repository));
  await assert.rejects(resolveExternalOutputPath(join(external, "out.json"), file), /directory/i);
  await assert.rejects(resolveExternalOutputPath(join(external, "out.json"), join(base, "missing-repo")));
});

test("output guard rejects ambiguous paths and Windows namespace/stream aliases", async (t) => {
  const { repository, external } = await filesystem(t);
  for (const candidate of ["", "relative.json", "\0", join(external, "nul\0name")]) {
    await assert.rejects(resolveExternalOutputPath(candidate, repository), /absolute paths/i);
  }
  if (process.platform === "win32") {
    for (const candidate of ["\\\\?\\" + external, "\\\\.\\C:\\out", "\\out.json", `${repository}:stream`]) {
      await assert.rejects(resolveExternalOutputPath(candidate, repository));
    }
  }
});

test("A/B action metrics distinguish ignored intent, accepted cancellation, and pending cancellations", () => {
  for (const mode of ["voice-only", "cancel-actions"] as const) {
    const f = game(mode);
    f.dispatch("red", red);
    f.dispatch("blue", blue);
    f.tick(2);
    f.dispatch("cancel", { type: "cancel" });
    f.tick(20);
    const metrics = deriveActionMetrics(f.engine.snapshot());
    assert.equal(metrics.cancelIntentAccepted, mode === "cancel-actions" ? 1 : 0);
    assert.equal(metrics.cancelIntentIgnored, mode === "voice-only" ? 1 : 0);
    assert.equal(metrics.pendingOperationsCancelled, mode === "cancel-actions" ? 2 : 0);
    assert.equal(metrics.stepsAfterAcceptedCancellation, 0);
    assert.deepEqual(metrics.finalPositions, mode === "cancel-actions" ? { red: 2, blue: 0 } : { red: 6, blue: 6 });
    assert.equal(metrics.capturedAfterStop, false);
  }
});

function append(snapshot: GameSnapshot, event: Omit<LabEvent, "sequence">): void {
  snapshot.events.push({ ...event, sequence: snapshot.events.length + 1 });
}

test("post-cancel step metrics target only operations pending at that exact accepted cancellation", () => {
  const f = game();
  const completed = f.dispatch("completed", red);
  f.tick(6);
  const running = f.dispatch("running", blue);
  const queued = f.dispatch("queued", { type: "move", cargo: "red", destination: "left" });
  f.tick();
  f.dispatch("cancel", { type: "cancel" });
  f.fresh();
  const fresh = f.dispatch("fresh", red, "fresh");
  f.tick();
  const snapshot = f.engine.snapshot();
  assert.equal(deriveActionMetrics(snapshot).stepsAfterAcceptedCancellation, 0);
  for (const id of [completed.operationId, running.operationId, queued.operationId, fresh.operationId]) {
    assert.ok(id);
    append(snapshot, { kind: "operation.step", atMs: 100, operationId: id, delegationId: "original", details: {} });
  }
  const metrics = deriveActionMetrics(snapshot);
  assert.equal(metrics.stepsAfterAcceptedCancellation, 2);
  assert.deepEqual(metrics.postCancellationSteps.map((step) => step.operationId), [running.operationId, queued.operationId]);
  assert.deepEqual(metrics.acceptedCancellationTargets[0]?.operationIds, [running.operationId, queued.operationId]);
  assert.equal(metrics.pendingOperationsCancelled, 2);
});

test("replacement metrics distinguish queued/completed corrections and do not miscount valid new steps", () => {
  for (const mode of ["voice-only", "cancel-actions"] as const) {
    const f = game(mode);
    f.dispatch("red", red);
    f.dispatch("blue", blue);
    f.tick(2);
    f.dispatch("replace", replacement);
    const queued = deriveActionMetrics(f.engine.snapshot());
    assert.equal(queued.correctionsQueued, 1);
    assert.equal(queued.correctionsCompleted, 0);
    assert.equal(queued.cancelIntentsByCommand.replace[mode === "voice-only" ? "ignored" : "accepted"], 1);
    assert.equal(queued.cancelIntentsByCommand.cancel.accepted, 0);
    f.tick(30);
    const completed = deriveActionMetrics(f.engine.snapshot());
    assert.equal(completed.correctionsCompleted, 1);
    assert.equal(completed.stepsAfterAcceptedCancellation, 0);
  }
});

test("emergency cleanup is never semantic cancellation, including a correction cancelled by stop", () => {
  for (const mode of ["voice-only", "cancel-actions"] as const) {
    const f = game(mode);
    f.dispatch("red", red);
    f.dispatch("blue", blue);
    f.tick(2);
    const before = deriveActionMetrics(f.engine.snapshot());
    f.engine.stop("emergency-cleanup");
    const after = deriveActionMetrics(f.engine.snapshot());
    assert.deepEqual(after, { ...before, capturedAfterStop: true });
    assert.equal(after.pendingOperationsCancelled, 0);
  }
  const f = game();
  f.dispatch("red", red);
  f.tick();
  f.dispatch("replace", replacement);
  const before = deriveActionMetrics(f.engine.snapshot());
  f.engine.stop("cleanup");
  assert.deepEqual(deriveActionMetrics(f.engine.snapshot()), { ...before, capturedAfterStop: true });
  assert.equal(before.pendingOperationsCancelled, 1);
  assert.equal(before.correctionsCompleted, 0);
});

test("late, callId collision, unregistered, terminal, and other rejections are classified precisely", () => {
  const f = game();
  f.dispatch("move", red);
  const beforeReplay = deriveActionMetrics(f.engine.snapshot());
  f.dispatch("move", red);
  assert.deepEqual(deriveActionMetrics(f.engine.snapshot()), beforeReplay);
  assert.equal(beforeReplay.idempotentReplayCount, null);
  f.dispatch("move", blue);
  f.dispatch("missing", red, "not-registered");
  f.dispatch("cancel", { type: "cancel" });
  f.dispatch("stale", blue);
  assert.throws(() => f.engine.registerDelegation("old-created", 0), /barrier/i);
  const malformed: unknown = { callId: "bad", delegationId: "original", command: { type: "stop" } };
  f.engine.dispatch(malformed as Parameters<GameEngine["dispatch"]>[0]);
  f.engine.stop("cleanup");
  f.dispatch("terminal", blue);
  const metrics = deriveActionMetrics(f.engine.snapshot());
  assert.deepEqual(metrics.rejections, { total: 6, late: 2, duplicateCallId: 1, unregistered: 1, terminal: 1, other: 1 });
  assert.equal(metrics.cancelIntentAccepted, 1);
});

test("empty and repeated cancellations do not invent cancelled operations or duplicate intents", () => {
  const f = game();
  f.dispatch("one", { type: "cancel" });
  f.dispatch("one", { type: "cancel" });
  f.fresh();
  f.dispatch("two", { type: "cancel" }, "fresh");
  const metrics = deriveActionMetrics(f.engine.snapshot());
  assert.equal(metrics.cancelIntentAccepted, 2);
  assert.deepEqual(metrics.acceptedCancellationTargets.map((target) => target.operationIds), [[], []]);
  assert.equal(metrics.pendingOperationsCancelled, 0);
});

test("metrics match exact event kinds, reject partial histories, and never expose snapshot state", () => {
  const f = game();
  f.dispatch("one", red);
  const snapshot = f.engine.snapshot();
  const baseline = deriveActionMetrics(snapshot);
  for (const kind of ["speech.cancellation.accepted", "operation.cancelled.extra", "correction.completed"]) {
    append(snapshot, { kind, atMs: 0, operationId: "noise", delegationId: null, details: { text: "not copied" } });
  }
  const metrics = deriveActionMetrics(snapshot);
  assert.deepEqual(metrics, baseline);
  assert.equal(JSON.stringify(metrics).includes("not copied"), false);
  Reflect.set(metrics.finalPositions, "red", 100);
  assert.equal(snapshot.cargo.red, 0);
  snapshot.events.shift();
  assert.throws(() => deriveActionMetrics(snapshot), /complete.*history/i);
});

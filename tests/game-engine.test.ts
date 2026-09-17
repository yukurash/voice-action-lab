import assert from "node:assert/strict";
import test from "node:test";
import { GameEngine } from "../packages/game-engine/index.ts";
import type {
  CommandRequest,
  ExperimentMode,
  GameCommand,
  GameSnapshot,
  Operation,
} from "../packages/contracts/index.ts";

const modes: ExperimentMode[] = ["voice-only", "cancel-actions"];
const moveRed: GameCommand = { type: "move", cargo: "red", destination: "right" };
const moveBlue: GameCommand = { type: "move", cargo: "blue", destination: "right" };
const cancel: GameCommand = { type: "cancel" };
const replaceRed: GameCommand = { type: "replace", cargo: "red", destination: "left" };

function fixture(mode: ExperimentMode = "cancel-actions", stepIntervalMs?: number) {
  let now = 0;
  const engine = new GameEngine({
    mode, runId: "run-1", now: () => now,
    ...(stepIntervalMs === undefined ? {} : { stepIntervalMs }),
  });
  return {
    engine,
    setTime(value: number) { now = value; },
    advance() { now += 1; },
    register(id = "delegation-1", offset?: number) { engine.registerDelegation(id, offset); },
    dispatch(callId: string, command: GameCommand, delegationId = "delegation-1") {
      return engine.dispatch({ callId, delegationId, command });
    },
    ticks(count: number) {
      for (let i = 0; i < count; i += 1) {
        now += 1;
        engine.tick();
      }
    },
  };
}

function operation(snapshot: GameSnapshot, index = 0): Operation {
  const found = snapshot.operations[index];
  assert.ok(found);
  return found;
}

function pending(operation: Operation): boolean {
  return operation.status === "queued" || operation.status === "running";
}

for (const mode of modes) {
  test(`${mode}: dispatch returns immediately, ticks serialize both cargos and complete at 6`, () => {
    const f = fixture(mode);
    assert.deepEqual(f.engine.snapshot(), {
      runId: "run-1", mode, epoch: 0, cargo: { red: 0, blue: 0 },
      operations: [], events: [], stopped: false,
    });
    f.register();
    const red = f.dispatch("red", moveRed);
    const blue = f.dispatch("blue", moveBlue);
    assert.equal(red.outcome, "queued");
    assert.equal(blue.outcome, "queued");
    assert.notEqual(red.operationId, blue.operationId);
    assert.deepEqual(f.engine.snapshot().cargo, { red: 0, blue: 0 });
    assert.deepEqual(f.engine.snapshot().operations.map((op) => op.status), ["queued", "queued"]);
    f.ticks(1);
    assert.deepEqual(f.engine.snapshot().cargo, { red: 1, blue: 0 });
    assert.equal(operation(f.engine.snapshot()).status, "running");
    f.ticks(5);
    assert.deepEqual(f.engine.snapshot().cargo, { red: 6, blue: 0 });
    assert.equal(operation(f.engine.snapshot()).status, "completed");
    assert.equal(operation(f.engine.snapshot()).endedAtMs, 6);
    assert.equal(operation(f.engine.snapshot(), 1).status, "queued");
    f.ticks(6);
    assert.deepEqual(f.engine.snapshot().cargo, { red: 6, blue: 6 });
    assert.ok(f.engine.snapshot().operations.every((op) => op.status === "completed"));
    const settled = f.engine.snapshot();
    f.ticks(100);
    assert.deepEqual(f.engine.snapshot(), settled);
  });

  test(`${mode}: already-at-destination operations complete without steps or starting the next task`, () => {
    const f = fixture(mode);
    f.register();
    f.dispatch("left", { type: "move", cargo: "red", destination: "left" });
    f.dispatch("right", moveBlue);
    f.ticks(1);
    const state = f.engine.snapshot();
    assert.equal(operation(state).status, "completed");
    assert.equal(operation(state).endedAtMs, 1);
    assert.equal(operation(state, 1).status, "queued");
    assert.deepEqual(state.cargo, { red: 0, blue: 0 });
    assert.equal(state.events.filter((event) => event.kind === "operation.step").length, 0);
    f.ticks(1);
    assert.deepEqual(f.engine.snapshot().cargo, { red: 0, blue: 1 });
  });

  test(`${mode}: leftward movement takes one step per tick and never rolls back committed movement`, () => {
    const f = fixture(mode);
    f.register();
    f.dispatch("right", moveRed);
    f.dispatch("left", { type: "move", cargo: "red", destination: "left" });
    f.ticks(6);
    for (let x = 5; x >= 0; x -= 1) {
      f.ticks(1);
      assert.equal(f.engine.snapshot().cargo.red, x);
      assert.equal(operation(f.engine.snapshot(), 1).status, x === 0 ? "completed" : "running");
    }
  });

  test(`${mode}: identical retries replay a receipt without events, movement, or a second operation`, () => {
    const f = fixture(mode);
    f.register();
    const request: CommandRequest = { callId: "one", delegationId: "delegation-1", command: moveRed };
    const receipt = f.engine.dispatch(request);
    f.ticks(2);
    const before = f.engine.snapshot();
    assert.deepEqual(f.engine.dispatch({
      command: { destination: "right", cargo: "red", type: "move" },
      delegationId: "delegation-1",
      callId: "one",
    }), receipt);
    assert.deepEqual(f.engine.snapshot(), before);
    receipt.outcome = "rejected";
    receipt.operationId = "mutated";
    assert.equal(f.engine.dispatch(request).outcome, "queued");
    assert.equal(f.engine.dispatch(request).operationId, operation(before).id);
  });

  test(`${mode}: callId collisions reject changed cargo, direction, type, or delegation`, () => {
    const f = fixture(mode);
    f.register();
    f.register("other");
    const original = f.dispatch("one", moveRed);
    for (const [command, delegationId] of [
      [moveBlue, "delegation-1"],
      [{ type: "move", cargo: "red", destination: "left" }, "delegation-1"],
      [{ type: "replace", cargo: "red", destination: "right" }, "delegation-1"],
      [cancel, "delegation-1"],
      [moveRed, "other"],
    ] satisfies [GameCommand, string][]) {
      const result = f.dispatch("one", command, delegationId);
      assert.equal(result.outcome, "rejected");
      assert.match(result.reason, /collision/i);
      assert.equal(f.engine.snapshot().operations.length, 1);
      assert.equal(f.engine.snapshot().epoch, 0);
    }
    assert.deepEqual(f.dispatch("one", moveRed), original);
  });

  test(`${mode}: unregistered rejection is cached and later registration cannot resurrect that call`, () => {
    const f = fixture(mode);
    const result = f.dispatch("early", moveRed);
    assert.equal(result.outcome, "rejected");
    assert.match(result.reason, /not registered/i);
    f.register();
    const before = f.engine.snapshot();
    assert.deepEqual(f.dispatch("early", moveRed), result);
    assert.deepEqual(f.engine.snapshot(), before);
    assert.equal(f.dispatch("new", moveRed).outcome, "queued");
  });

  test(`${mode}: stop cancels running and queued work, retains completions, and makes ticks inert`, () => {
    const f = fixture(mode);
    f.register();
    f.dispatch("completed", moveRed);
    f.ticks(6);
    f.dispatch("running", moveBlue);
    f.dispatch("queued", { type: "move", cargo: "red", destination: "left" });
    f.ticks(2);
    f.setTime(20);
    f.engine.stop("owner-stop");
    const stopped = f.engine.snapshot();
    assert.equal(stopped.stopped, true);
    assert.deepEqual(stopped.cargo, { red: 6, blue: 2 });
    assert.deepEqual(stopped.operations.map((op) => op.status), ["completed", "cancelled", "cancelled"]);
    assert.deepEqual(stopped.operations.map((op) => op.endedAtMs), [6, 20, 20]);
    assert.equal(stopped.events.at(-1)?.kind, "engine.stopped");
    assert.equal(stopped.events.at(-1)?.details.reason, "owner-stop");
    f.ticks(100);
    f.engine.stop("second-stop");
    assert.deepEqual(f.engine.snapshot(), stopped);
    for (const [index, command] of [moveRed, cancel, replaceRed].entries()) {
      const result = f.dispatch(`after-stop-${index}`, command);
      assert.equal(result.outcome, "rejected");
      assert.match(result.reason, /stopped/i);
    }
    assert.throws(() => f.register("new"), /stopped/i);
    assert.deepEqual(f.engine.snapshot().operations, stopped.operations);
    assert.deepEqual(f.engine.snapshot().cargo, stopped.cargo);
  });

  test(`${mode}: a retry after terminal stop returns only its historical receipt`, () => {
    const f = fixture(mode);
    f.register();
    const receipt = f.dispatch("one", moveRed);
    f.engine.stop("owner-stop");
    const stopped = f.engine.snapshot();
    assert.deepEqual(f.dispatch("one", moveRed), receipt);
    assert.deepEqual(f.engine.snapshot(), stopped);
    assert.equal(operation(stopped).status, "cancelled");
  });

  test(`${mode}: snapshots deeply isolate arrays, cargo, operations, events, and event details`, () => {
    const f = fixture(mode);
    f.register();
    f.dispatch("one", moveRed);
    const original = f.engine.snapshot();
    const copy = f.engine.snapshot();
    copy.cargo.red = 100;
    copy.epoch = 100;
    copy.mode = "voice-only";
    copy.runId = "changed";
    copy.stopped = true;
    operation(copy).status = "cancelled";
    operation(copy).destination = "left";
    operation(copy).id = "changed";
    const event = copy.events[0];
    assert.ok(event);
    event.kind = "changed";
    event.details.epoch = 100;
    copy.operations.length = 0;
    copy.events.length = 0;
    assert.deepEqual(f.engine.snapshot(), original);
    f.ticks(1);
    assert.equal(original.cargo.red, 0);
    assert.equal(operation(original).status, "queued");
    assert.equal(f.engine.snapshot().cargo.red, 1);
  });
}

for (const mode of modes) {
  test(`${mode}: explicit intervals enforce exact step deadlines, sequential pacing, and no catch-up bursts`, () => {
    for (const interval of [100, 1_000, 5_000]) {
      const f = fixture(mode, interval);
      f.register();
      f.dispatch("red", moveRed);
      f.dispatch("blue", moveBlue);
      const queued = f.engine.snapshot();
      f.setTime(interval - 1);
      f.engine.tick();
      assert.deepEqual(f.engine.snapshot(), queued);
      f.setTime(interval);
      f.engine.tick();
      assert.deepEqual(f.engine.snapshot().cargo, { red: 1, blue: 0 });
      const first = f.engine.snapshot();
      f.engine.tick();
      assert.deepEqual(f.engine.snapshot(), first);
      f.setTime(10 * interval);
      f.engine.tick();
      assert.equal(f.engine.snapshot().cargo.red, 2);
      const delayed = f.engine.snapshot();
      f.setTime(11 * interval - 1);
      f.engine.tick();
      assert.deepEqual(f.engine.snapshot(), delayed);
      for (let multiplier = 11; multiplier <= 14; multiplier += 1) {
        f.setTime(multiplier * interval);
        f.engine.tick();
      }
      assert.deepEqual(f.engine.snapshot().cargo, { red: 6, blue: 0 });
      assert.equal(operation(f.engine.snapshot()).status, "completed");
      const completed = f.engine.snapshot();
      f.engine.tick();
      assert.deepEqual(f.engine.snapshot(), completed);
      f.setTime(15 * interval);
      f.engine.tick();
      assert.deepEqual(f.engine.snapshot().cargo, { red: 6, blue: 1 });
      assert.deepEqual(
        f.engine.snapshot().events.filter((event) => event.kind === "operation.step").map((event) => event.atMs),
        [1, 10, 11, 12, 13, 14, 15].map((multiplier) => multiplier * interval),
      );
    }
  });
}

test("timed cancellation invalidates due steps and fresh work waits from its own admission time", () => {
  const f = fixture("cancel-actions", 1_000);
  f.register();
  f.dispatch("red", moveRed);
  f.dispatch("blue", moveBlue);
  f.setTime(1_000);
  f.engine.tick();
  f.setTime(1_500);
  f.dispatch("cancel", cancel);
  const cancelled = f.engine.snapshot();
  f.setTime(100_000);
  f.engine.tick();
  assert.deepEqual(f.engine.snapshot(), cancelled);
  f.register("fresh", 100_000);
  f.dispatch("fresh", { type: "move", cargo: "red", destination: "left" }, "fresh");
  const admitted = f.engine.snapshot();
  f.setTime(100_999);
  f.engine.tick();
  assert.deepEqual(f.engine.snapshot(), admitted);
  f.setTime(101_000);
  f.engine.tick();
  assert.deepEqual(f.engine.snapshot().cargo, { red: 0, blue: 0 });
  assert.deepEqual(f.engine.snapshot().operations.slice(0, 2), cancelled.operations);
});

test("timed replacement preserves committed steps, resets admission deadline, and retries do not postpone it", () => {
  const f = fixture("cancel-actions", 1_000);
  f.register();
  f.dispatch("red", moveRed);
  f.dispatch("blue", moveBlue);
  for (const time of [1_000, 2_000]) {
    f.setTime(time);
    f.engine.tick();
  }
  f.setTime(2_500);
  const receipt = f.dispatch("replace", replaceRed);
  const replaced = f.engine.snapshot();
  assert.deepEqual(replaced.cargo, { red: 2, blue: 0 });
  f.setTime(3_000);
  assert.deepEqual(f.dispatch("replace", replaceRed), receipt);
  f.setTime(3_499);
  f.engine.tick();
  assert.deepEqual(f.engine.snapshot(), replaced);
  f.setTime(3_500);
  f.engine.tick();
  assert.equal(f.engine.snapshot().cargo.red, 1);
  f.setTime(4_500);
  f.engine.tick();
  assert.deepEqual(f.engine.snapshot().cargo, { red: 0, blue: 0 });
  assert.equal(operation(f.engine.snapshot(), 2).status, "completed");
  assert.deepEqual(f.engine.snapshot().operations.slice(0, 2), replaced.operations.slice(0, 2));
});

test("timed voice-only replacement keeps earlier operations and their pacing unchanged", () => {
  const f = fixture("voice-only", 1_000);
  f.register();
  f.dispatch("red", moveRed);
  f.dispatch("blue", moveBlue);
  f.setTime(1_000);
  f.engine.tick();
  f.setTime(1_500);
  f.dispatch("replace", replaceRed);
  for (let time = 2_000; time <= 12_000; time += 1_000) {
    f.setTime(time);
    f.engine.tick();
  }
  assert.deepEqual(f.engine.snapshot().cargo, { red: 6, blue: 6 });
  assert.equal(operation(f.engine.snapshot(), 2).status, "queued");
  f.setTime(13_000);
  f.engine.tick();
  assert.deepEqual(f.engine.snapshot().cargo, { red: 5, blue: 6 });
  assert.ok(f.engine.snapshot().operations.every((op) => op.status !== "cancelled"));
});

test("pacing never delays already-at-destination completion or defeats terminal stop", () => {
  for (const mode of modes) {
    const f = fixture(mode, 1_000);
    f.register();
    f.dispatch("left", { type: "move", cargo: "red", destination: "left" });
    f.dispatch("right", moveRed);
    f.engine.tick();
    assert.equal(operation(f.engine.snapshot()).status, "completed");
    assert.equal(operation(f.engine.snapshot()).endedAtMs, 0);
    f.engine.stop("before-deadline");
    const stopped = f.engine.snapshot();
    f.setTime(100_000);
    f.engine.tick();
    assert.deepEqual(f.engine.snapshot(), stopped);
    assert.equal(f.dispatch("late", moveBlue).outcome, "rejected");
  }
});

test("invalid explicit step intervals fail before the engine is constructed", () => {
  for (const stepIntervalMs of [null, "1000", NaN, Infinity, -Infinity, -1, 0, 99, 5_001, 1_000.5]) {
    assert.throws(() => new GameEngine({
      mode: "voice-only", runId: "invalid-interval", now: () => 0, stepIntervalMs,
    } as ConstructorParameters<typeof GameEngine>[0]), /stepIntervalMs/i);
  }
});

test("identical A/B inputs differ only in whether cancellation is applied", () => {
  const snapshots = modes.map((mode) => {
    const f = fixture(mode);
    f.register();
    f.dispatch("red", moveRed);
    f.dispatch("blue", moveBlue);
    f.ticks(2);
    f.setTime(10);
    const result = f.dispatch("cancel", cancel);
    assert.equal(result.outcome, mode === "voice-only" ? "observed-not-applied" : "cancelled");
    f.ticks(20);
    return f.engine.snapshot();
  });
  const [a, b] = snapshots;
  assert.ok(a && b);
  assert.deepEqual(a.cargo, { red: 6, blue: 6 });
  assert.deepEqual(b.cargo, { red: 2, blue: 0 });
  assert.ok(a.operations.every((op) => op.status === "completed"));
  assert.ok(b.operations.every((op) => op.status === "cancelled"));
  assert.equal(a.epoch, 0);
  assert.equal(b.epoch, 1);
  assert.ok(a.events.some((event) => event.kind === "cancellation.observed"));
  assert.ok(!a.events.some((event) => event.kind === "cancellation.accepted"));
  assert.ok(b.events.some((event) => event.kind === "cancellation.accepted"));
});

test("voice-only replacement observes intent and queues behind all existing work", () => {
  const f = fixture("voice-only");
  f.register();
  f.dispatch("red", moveRed);
  f.dispatch("blue", moveBlue);
  f.ticks(2);
  const result = f.dispatch("replace", replaceRed);
  assert.equal(result.outcome, "queued");
  assert.match(result.reason, /without cancelling/i);
  assert.deepEqual(f.engine.snapshot().operations.map((op) => op.status), ["running", "queued", "queued"]);
  assert.equal(f.engine.snapshot().epoch, 0);
  f.ticks(4);
  assert.deepEqual(f.engine.snapshot().cargo, { red: 6, blue: 0 });
  f.ticks(6);
  assert.deepEqual(f.engine.snapshot().cargo, { red: 6, blue: 6 });
  assert.equal(operation(f.engine.snapshot(), 2).status, "queued");
  f.ticks(6);
  assert.deepEqual(f.engine.snapshot().cargo, { red: 0, blue: 6 });
  assert.ok(f.engine.snapshot().operations.every((op) => op.status === "completed"));
  assert.equal(f.dispatch("later", moveRed).outcome, "queued");
});

test("cancel-actions replacement atomically cancels all pending work and queues at the fresh epoch", () => {
  const f = fixture();
  f.register();
  f.dispatch("red", moveRed);
  f.dispatch("blue", moveBlue);
  f.ticks(2);
  f.setTime(10);
  const result = f.dispatch("replace", replaceRed);
  assert.equal(result.outcome, "queued");
  const state = f.engine.snapshot();
  assert.deepEqual(state.cargo, { red: 2, blue: 0 });
  assert.deepEqual(state.operations.map((op) => op.status), ["cancelled", "cancelled", "queued"]);
  assert.deepEqual(state.operations.map((op) => op.epoch), [0, 0, 1]);
  assert.equal(operation(state, 2).id, result.operationId);
  assert.equal(operation(state, 2).createdAtMs, 10);
  const accepted = state.events.findIndex((event) => event.kind === "cancellation.accepted");
  const queued = state.events.findIndex((event) => event.kind === "operation.queued"
    && event.operationId === result.operationId);
  assert.ok(accepted >= 0 && queued > accepted);
  assert.equal(state.events[accepted]?.atMs, 10);
  assert.equal(state.events[queued]?.atMs, 10);
  assert.equal(f.dispatch("late", moveBlue).outcome, "rejected");
  f.ticks(2);
  assert.deepEqual(f.engine.snapshot().cargo, { red: 0, blue: 0 });
  assert.equal(operation(f.engine.snapshot(), 2).status, "completed");
});

test("cancellation before, during, and after the final committed step preserves the exact boundary", () => {
  for (const steps of [0, 1, 5, 6]) {
    const f = fixture();
    f.register();
    f.dispatch("red", moveRed);
    f.dispatch("blue", moveBlue);
    f.ticks(steps);
    f.dispatch("cancel", cancel);
    const boundary = f.engine.snapshot();
    f.ticks(50);
    assert.deepEqual(f.engine.snapshot(), boundary);
    assert.equal(boundary.cargo.red, steps);
    assert.equal(boundary.cargo.blue, 0);
    assert.equal(operation(boundary).status, steps === 6 ? "completed" : "cancelled");
    assert.equal(operation(boundary, 1).status, "cancelled");
  }
});

test("cancel-actions invalidates every registered old delegation, including delegates with no prior calls", () => {
  const f = fixture();
  f.register();
  f.register("delayed");
  f.dispatch("red", moveRed);
  f.setTime(10);
  f.dispatch("cancel", cancel);
  for (const id of ["delegation-1", "delayed"]) {
    for (const [index, command] of [moveRed, cancel, replaceRed].entries()) {
      const result = f.dispatch(`${id}:${index}`, command, id);
      assert.equal(result.outcome, "rejected");
      assert.match(result.reason, /stale epoch/i);
    }
    assert.throws(() => f.register(id), /stale epoch/i);
  }
  assert.equal(f.engine.snapshot().epoch, 1);
  assert.equal(f.engine.snapshot().operations.length, 1);
  f.advance();
  f.register("fresh");
  assert.equal(f.dispatch("new", moveBlue, "fresh").outcome, "queued");
  f.ticks(1);
  assert.equal(f.engine.snapshot().cargo.blue, 1);
});

test("late creation at or before a cancellation barrier is rejected without registering an ID", () => {
  const f = fixture();
  f.register();
  f.setTime(10);
  f.dispatch("cancel", cancel);
  f.setTime(20);
  for (const offset of [0, 9, 10]) {
    const id = `delayed-${offset}`;
    assert.throws(() => f.register(id, offset), /barrier/i);
    assert.equal(f.dispatch(`late-${offset}`, moveRed, id).outcome, "rejected");
  }
  f.register("after", 11);
  assert.equal(f.dispatch("after", moveBlue, "after").outcome, "queued");
  f.register("current");
  assert.equal(f.dispatch("current", moveRed, "current").outcome, "queued");
});

test("the newest cancellation barrier and a replacement barrier both prevent delayed creation", () => {
  const f = fixture();
  f.register();
  f.setTime(10);
  f.dispatch("first", cancel);
  f.setTime(11);
  f.register("second", 11);
  f.setTime(20);
  f.dispatch("second", replaceRed, "second");
  f.setTime(30);
  assert.throws(() => f.register("late", 15), /barrier/i);
  assert.throws(() => f.register("tie", 20), /barrier/i);
  f.register("fresh", 21);
  assert.equal(f.dispatch("third", moveBlue, "fresh").outcome, "queued");
  assert.equal(f.engine.snapshot().epoch, 2);
});

test("voice-only observation does not reject older delegation creation or invalidate delegates", () => {
  const f = fixture("voice-only");
  f.register();
  f.setTime(10);
  f.dispatch("cancel", cancel);
  f.setTime(20);
  f.register("late", 0);
  assert.equal(f.dispatch("late", moveRed, "late").outcome, "queued");
  assert.equal(f.dispatch("existing", moveBlue).outcome, "queued");
  assert.equal(f.engine.snapshot().epoch, 0);
});

test("double cancel is idempotent by callId, rejects the old epoch, and accepts a fresh delegation", () => {
  const f = fixture();
  f.register();
  f.dispatch("move", moveRed);
  const result = f.dispatch("cancel", cancel);
  const first = f.engine.snapshot();
  assert.deepEqual(f.dispatch("cancel", cancel), result);
  assert.deepEqual(f.engine.snapshot(), first);
  assert.equal(f.dispatch("second-old", cancel).outcome, "rejected");
  f.advance();
  f.register("fresh");
  assert.equal(f.dispatch("second", cancel, "fresh").outcome, "cancelled");
  assert.equal(f.engine.snapshot().epoch, 2);
  assert.equal(f.engine.snapshot().events.filter((event) => event.kind === "cancellation.accepted").length, 2);
  assert.equal(operation(f.engine.snapshot()).endedAtMs, operation(first).endedAtMs);
});

test("retries of moves and replacements cannot resurrect work after a newer cancellation", () => {
  const f = fixture();
  f.register();
  const move = f.dispatch("move", moveRed);
  f.ticks(2);
  const replacement = f.dispatch("replace", replaceRed);
  f.advance();
  f.register("fresh");
  f.dispatch("cancel", cancel, "fresh");
  const state = f.engine.snapshot();
  assert.deepEqual(f.dispatch("move", moveRed), move);
  assert.deepEqual(f.dispatch("replace", replaceRed), replacement);
  f.ticks(20);
  assert.deepEqual(f.engine.snapshot(), state);
  assert.equal(state.cargo.red, 2);
});

test("delegation registration is idempotent but cannot change its creation offset", () => {
  const f = fixture();
  f.setTime(10);
  f.register("one", 5);
  const state = f.engine.snapshot();
  f.register("one", 5);
  assert.deepEqual(f.engine.snapshot(), state);
  assert.throws(() => f.register("one", 6), /cannot be changed/i);
  assert.throws(() => f.register("one"), /cannot be changed/i);
  assert.equal(f.dispatch("valid", moveRed, "one").outcome, "queued");
});

test("runtime request and command validation explicitly rejects malformed input without work", () => {
  const f = fixture();
  f.register();
  const invalidCommands: unknown[] = [
    null, undefined, false, "cancel", [], 1, {},
    { type: "stop" },
    { type: "move", cargo: "green", destination: "right" },
    { type: "move", cargo: "red", destination: "middle" },
    { type: "replace", cargo: "red" },
    { type: "replace", destination: "left" },
    { type: "cancel", cargo: "red" },
    { type: "move", cargo: "red", destination: "right", transcript: "not-logged" },
  ];
  for (const [index, command] of invalidCommands.entries()) {
    const result = f.engine.dispatch({
      callId: `bad-${index}`, delegationId: "delegation-1", command,
    } as CommandRequest);
    assert.equal(result.outcome, "rejected");
    assert.equal(result.operationId, null);
    assert.match(result.reason, /invalid command/i);
  }
  for (const request of [
    null, undefined, false, [], "request", 3, {},
    { callId: "one", command: moveRed },
    { delegationId: "delegation-1", command: moveRed },
    { callId: "one", delegationId: "delegation-1" },
    { callId: "one", delegationId: "delegation-1", command: moveRed, extra: true },
    { callId: "one", delegationId: "delegation-1", command: moveRed, epoch: 20 },
  ]) {
    assert.equal(f.engine.dispatch(request as CommandRequest).outcome, "rejected");
  }
  const state = f.engine.snapshot();
  assert.equal(state.epoch, 0);
  assert.deepEqual(state.operations, []);
  assert.deepEqual(state.cargo, { red: 0, blue: 0 });
  assert.equal(JSON.stringify(state.events).includes("not-logged"), false);
  assert.ok(state.events.slice(1).every((event) => event.kind === "command.rejected"));
});

test("IDs and creation offsets reject invalid runtime values explicitly", () => {
  const f = fixture();
  f.setTime(10);
  f.register();
  for (const id of [undefined, null, 0, false, {}, [], "", " ", "a b", " a", "a\n", "a\0", "a\u007f"]) {
    assert.throws(() => f.engine.registerDelegation(id as string), /invalid delegationId/i);
    for (const request of [
      { callId: id, delegationId: "delegation-1", command: moveRed },
      { callId: "one", delegationId: id, command: moveRed },
    ]) {
      assert.equal(f.engine.dispatch(request as CommandRequest).outcome, "rejected");
    }
  }
  for (const offset of [-1, NaN, Infinity, -Infinity, 11, null, "1"]) {
    assert.throws(() => f.register("bad-offset", offset as number), /offset/i);
  }
  assert.equal(f.dispatch("missing", moveRed, "bad-offset").outcome, "rejected");
  assert.equal(f.engine.snapshot().operations.length, 0);
});

test("constructor, clock, and stop reason fail explicitly before mutating state", () => {
  const options = { mode: "voice-only", runId: "one", now: () => 0 };
  for (const value of [
    null, undefined, [], {},
    { ...options, mode: "other" },
    { ...options, runId: "" },
    { ...options, now: 0 },
  ]) {
    assert.throws(() => new GameEngine(value as ConstructorParameters<typeof GameEngine>[0]), TypeError);
  }
  const f = fixture();
  f.register();
  f.dispatch("one", moveRed);
  const before = f.engine.snapshot();
  for (const time of [-1, NaN, Infinity]) {
    f.setTime(time);
    assert.throws(() => f.engine.tick(), /now must return/i);
    assert.throws(() => f.dispatch("new", cancel), /now must return/i);
    assert.throws(() => f.register("new"), /now must return/i);
    assert.throws(() => f.engine.stop("owner-stop"), /now must return/i);
    assert.deepEqual(f.engine.snapshot(), before);
  }
  f.setTime(0);
  for (const reason of ["", " ", null, undefined, 1]) {
    assert.throws(() => f.engine.stop(reason as string), /reason/i);
    assert.deepEqual(f.engine.snapshot(), before);
  }
});

test("caller-owned command mutation cannot change queued operations or cached request identity", () => {
  const f = fixture();
  f.register();
  const request: CommandRequest = {
    callId: "one", delegationId: "delegation-1",
    command: { type: "move", cargo: "red", destination: "right" },
  };
  f.engine.dispatch(request);
  request.command = moveBlue;
  assert.match(f.engine.dispatch(request).reason, /collision/i);
  f.ticks(1);
  assert.deepEqual(f.engine.snapshot().cargo, { red: 1, blue: 0 });
});

test("events have contiguous sequences, caller timestamps, meaningful IDs, and cancellation ordering", () => {
  const f = fixture();
  f.setTime(10);
  f.register();
  f.setTime(20);
  const queued = f.dispatch("move", moveRed);
  f.setTime(30);
  f.engine.tick();
  f.setTime(40);
  f.dispatch("cancel", cancel);
  f.setTime(50);
  f.dispatch("stale", moveBlue);
  f.setTime(60);
  f.engine.stop("test-end");
  const events = f.engine.snapshot().events;
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.deepEqual(events.map((event) => event.kind), [
    "delegation.registered", "operation.queued", "operation.started", "operation.step",
    "cancellation.accepted", "operation.cancelled", "command.rejected", "engine.stopped",
  ]);
  assert.deepEqual(events.map((event) => event.atMs), [10, 20, 30, 30, 40, 40, 50, 60]);
  for (const event of events.filter((event) => event.kind.startsWith("operation."))) {
    assert.equal(event.operationId, queued.operationId);
    assert.equal(event.delegationId, "delegation-1");
    assert.equal(event.details.callId, "move");
  }
  assert.equal(events.find((event) => event.kind === "cancellation.accepted")?.details.cancelledCount, 1);
});

function stress(mode: ExperimentMode, seed: number, stepIntervalMs?: number): GameSnapshot {
  const f = fixture(mode, stepIntervalMs);
  let randomState = seed;
  const random = (max: number) => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState % max;
  };
  const delegates = ["delegation-1"];
  const requests: CommandRequest[] = [];
  const cancelledIds = new Set<string>();
  const positions = { red: 0, blue: 0 };
  f.register();
  let previous = f.engine.snapshot();
  let barrier = -1;
  let lastStepAtMs = 0;
  let now = 0;
  for (let index = 0; index < 96; index += 1) {
    now += stepIntervalMs === undefined ? 1 : random(stepIntervalMs * 3);
    f.setTime(now);
    const action = random(12);
    let ticked = false;
    if (action === 0) {
      const id = `delegate-${index}`;
      f.register(id);
      delegates.push(id);
    } else if (action >= 1 && action <= 3) {
      const delegationId = delegates[random(delegates.length)];
      assert.ok(delegationId);
      const command: GameCommand = action === 2 ? cancel : {
        type: action === 1 ? "move" : "replace",
        cargo: random(2) === 0 ? "red" : "blue",
        destination: random(2) === 0 ? "left" : "right",
      };
      const request: CommandRequest = { callId: `call-${index}`, delegationId, command };
      requests.push(request);
      f.engine.dispatch(request);
    } else if ((action === 7 || action === 8) && requests.length > 0) {
      const request = requests[random(requests.length)];
      assert.ok(request);
      if (action === 7) {
        const before = f.engine.snapshot();
        f.engine.dispatch(request);
        assert.deepEqual(f.engine.snapshot(), before);
      } else {
        const result = f.engine.dispatch({ ...request, delegationId: "collision-delegate" });
        assert.equal(result.outcome, "rejected");
        assert.match(result.reason, /collision/i);
      }
    } else if (action === 9) {
      assert.equal(f.dispatch(`unknown-${index}`, moveRed, "unregistered").outcome, "rejected");
    } else if (action === 10) {
      const offset = Math.max(0, now - 20);
      const id = `late-${index}`;
      if (offset <= barrier) {
        assert.throws(() => f.register(id, offset), /barrier/i);
      } else {
        f.register(id, offset);
        delegates.push(id);
      }
    } else {
      ticked = true;
      f.engine.tick();
    }

    const next = f.engine.snapshot();
    const newEvents = next.events.slice(previous.events.length);
    const steps = newEvents.filter((event) => event.kind === "operation.step");
    assert.ok(steps.length <= (ticked ? 1 : 0));
    for (const event of newEvents) {
      assert.equal(event.sequence, previous.events.length + newEvents.indexOf(event) + 1);
      assert.equal(event.atMs, now);
      if (event.kind === "cancellation.accepted") {
        assert.equal(mode, "cancel-actions");
        barrier = now;
        for (const op of previous.operations.filter(pending)) {
          cancelledIds.add(op.id);
          assert.equal(next.operations.find((candidate) => candidate.id === op.id)?.status, "cancelled");
        }
      }
      if (event.kind === "operation.cancelled") {
        assert.ok(event.operationId);
        cancelledIds.add(event.operationId);
      }
      if (event.kind === "operation.step") {
        assert.ok(event.operationId);
        assert.equal(cancelledIds.has(event.operationId), false, `seed ${seed}: cancelled task advanced`);
        const cargo = event.details.cargo;
        assert.ok(cargo === "red" || cargo === "blue");
        assert.equal(event.details.from, positions[cargo]);
        assert.equal(typeof event.details.to, "number");
        const to = event.details.to;
        assert.ok(typeof to === "number");
        assert.equal(Math.abs(to - positions[cargo]), 1);
        assert.ok(to >= 0 && to <= 6);
        positions[cargo] = to;
        const firstPending = previous.operations.find(pending);
        assert.equal(event.operationId, firstPending?.id);
        assert.ok(firstPending);
        if (stepIntervalMs !== undefined) {
          assert.ok(event.atMs - Math.max(firstPending.createdAtMs, lastStepAtMs) >= stepIntervalMs);
        }
        lastStepAtMs = event.atMs;
      }
    }
    assert.deepEqual(next.cargo, positions);
    assert.ok(next.operations.filter((op) => op.status === "running").length <= 1);
    for (const old of previous.operations) {
      if (old.status === "completed" || old.status === "cancelled") {
        assert.deepEqual(next.operations.find((op) => op.id === old.id), old);
      }
    }
    if (mode === "voice-only") {
      assert.equal(next.epoch, 0);
      assert.ok(next.operations.every((op) => op.status !== "cancelled"));
    } else {
      assert.ok(next.operations.filter(pending).every((op) => op.epoch === next.epoch));
    }
    previous = next;
  }
  f.advance();
  f.engine.stop("stress-end");
  const stopped = f.engine.snapshot();
  assert.ok(stopped.operations.every((op) => !pending(op)));
  f.ticks(10);
  assert.equal(f.dispatch("terminal-call", moveRed).outcome, "rejected");
  assert.deepEqual(f.engine.snapshot().operations, stopped.operations);
  assert.deepEqual(f.engine.snapshot().cargo, stopped.cargo);
  return f.engine.snapshot();
}

for (const mode of modes) {
  test(`${mode}: 256 deterministic interleavings never advance cancelled work or cross a commit boundary`, () => {
    for (let seed = 1; seed <= 256; seed += 1) stress(mode, seed);
  });
  test(`${mode}: 128 timed interleavings preserve cancellation barriers and minimum step intervals`, () => {
    for (let seed = 1; seed <= 128; seed += 1) stress(mode, seed, 1_000);
  });
}

test("seeded interleavings are reproducible, including complete event histories", () => {
  for (const mode of modes) {
    for (const seed of [1, 17, 93]) {
      assert.deepEqual(stress(mode, seed), stress(mode, seed));
      assert.deepEqual(stress(mode, seed, 1_000), stress(mode, seed, 1_000));
    }
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVITY_NOTIFY_INTERVAL_MS, AudioActivityClock, MAX_ACTIVITY_OFFSET_MS,
} from "./audioActivity.ts";
import { WINDOW_MS } from "./pcmWindow.ts";

test("one run-relative clock coalesces either source with strictly increasing integer offsets", () => {
  const clock = new AudioActivityClock(100_000);
  assert.equal(ACTIVITY_NOTIFY_INTERVAL_MS, 2000);
  assert.equal(clock.nextOffset(100_250.5, true), 250);
  assert.equal(clock.nextOffset(100_250.5, true), null);
  assert.equal(clock.nextOffset(102_249.9, true), null);
  assert.equal(clock.nextOffset(102_250.5, true), 2250);
  assert.equal(clock.nextOffset(104_250.5, true), 4250);
});

test("silence does not generate heartbeats or consume the next genuine activity slot", () => {
  const clock = new AudioActivityClock(100);
  assert.equal(clock.nextOffset(350, false), null);
  assert.equal(clock.nextOffset(10_100, false), null);
  assert.equal(clock.nextOffset(10_350, true), 10_250);
  assert.equal(clock.nextOffset(12_350, false), null);
  assert.equal(clock.nextOffset(12_351, true), 12_251);
});

test("activity offsets stop at the ten-minute protocol limit and reset for a new run", () => {
  assert.equal(MAX_ACTIVITY_OFFSET_MS, 600_000);
  const clock = new AudioActivityClock(15_000);
  assert.equal(clock.nextOffset(15_000, true), 0);
  assert.equal(clock.nextOffset(615_000, true), 600_000);
  assert.equal(clock.nextOffset(615_001, true), null);
  assert.equal(clock.nextOffset(700_000, true), null);
  assert.equal(new AudioActivityClock(700_000).nextOffset(700_250, true), 250);
});

test("invalid or backward clocks fail explicitly", () => {
  assert.throws(() => new AudioActivityClock(Number.NaN));
  const clock = new AudioActivityClock(100);
  assert.throws(() => clock.nextOffset(99, true));
  assert.throws(() => clock.nextOffset(Infinity, true));
  assert.equal(clock.nextOffset(200, false), null);
  assert.throws(() => clock.nextOffset(199, false));
});

test("continuous audio stays well below the shared 240-per-minute mutation budget", () => {
  const clock = new AudioActivityClock(0);
  const offsets: number[] = [];
  for (let now = 0; now < 60_000; now += WINDOW_MS) {
    const offset = clock.nextOffset(now, true);
    if (offset !== null) offsets.push(offset);
  }
  assert.equal(offsets.length, 30);
  assert.ok(offsets.every((offset, index) => index === 0 || offset - (offsets[index - 1] ?? offset) >= 2000));
});

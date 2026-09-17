import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVE_WINDOWS, PcmFrameDiscontinuity, PcmWindowMeter, RMS_THRESHOLD, SILENT_WINDOWS, THRESHOLD_DBFS, WINDOW_MS } from "./pcmWindow.ts";
import type { PcmWindowSample } from "./pcmWindow.ts";

function windows(amplitudes: number[]): PcmWindowSample[] {
  const meter = new PcmWindowMeter(48000, "input");
  const samples: PcmWindowSample[] = [];
  amplitudes.forEach((amplitude, index) => meter.process([new Float32Array(960).fill(amplitude)], index * 960, 960, (sample) => samples.push(sample)));
  return samples;
}

test("exact requested threshold and hysteresis confirm 3 active and 6 silent windows", () => {
  assert.equal(WINDOW_MS, 20);
  assert.equal(THRESHOLD_DBFS, -45);
  assert.equal(RMS_THRESHOLD, 10 ** (-45 / 20));
  assert.equal(ACTIVE_WINDOWS, 3);
  assert.equal(SILENT_WINDOWS, 6);
  const samples = windows([0.01, 0.01, 0.01, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(samples.map((sample) => sample.active), [false, false, true, true, true, true, true, true, false]);
  assert.equal(samples[2]?.transition, "start");
  assert.equal(samples[2]?.transitionTime, 0);
  assert.equal(samples[2]?.contextTime, 0.06);
  assert.equal(samples[8]?.transition, "stop");
  assert.equal(samples[8]?.transitionTime, 0.06);
  assert.equal(samples[8]?.contextTime, 0.18);
});

test("subthreshold signal and interrupted streaks do not fabricate activity transitions", () => {
  assert.ok(windows([0.005, 0.005, 0.005, 0.005]).every((sample) => !sample.active));
  const samples = windows([0.01, 0.01, 0, 0.01, 0.01, 0.01, 0, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(samples.filter((sample) => sample.transition).map((sample) => [sample.transition, sample.transitionTime, sample.contextTime]),
    [["start", 0.06, 0.12], ["stop", 0.24, 0.36]]);
});

test("20ms windows span render quanta without drift at 48k, 44.1k and fractional frame lengths", () => {
  for (const rate of [48000, 44100, 11025]) {
    const samples: PcmWindowSample[] = [];
    const meter = new PcmWindowMeter(rate, "output");
    for (let frame = 0; frame < rate; frame += 128) {
      const length = Math.min(128, rate - frame);
      meter.process([new Float32Array(length).fill(0.1)], frame, length, (sample) => samples.push(sample));
    }
    assert.equal(samples.length, 50);
    assert.equal(samples.at(-1)?.contextTime, 1);
    samples.forEach((sample, index) => {
      assert.equal(sample.direction, "output");
      assert.ok(Math.abs(sample.contextTime - (index + 1) * 0.02) <= 0.5 / rate + 1e-12);
      assert.ok(Math.abs(sample.rms - 0.1) < 1e-8);
    });
  }
});

test("stereo energy does not cancel opposite phase and missing inputs are real silence", () => {
  const meter = new PcmWindowMeter(48000, "output");
  const samples: PcmWindowSample[] = [];
  meter.process([new Float32Array(960).fill(0.1), new Float32Array(960).fill(-0.1)], 0, 960, (sample) => samples.push(sample));
  meter.process([], 960, 960, (sample) => samples.push(sample));
  assert.ok(Math.abs((samples[0]?.rms ?? 0) - 0.1) < 1e-8);
  assert.equal(samples[1]?.rms, 0);
});

test("pause drops partial windows and streaks, preserving the context clock and sequence", () => {
  const meter = new PcmWindowMeter(48000, "input");
  const samples: PcmWindowSample[] = [];
  meter.process([new Float32Array(1920).fill(0.1)], 0, 1920, (sample) => samples.push(sample));
  meter.reset();
  meter.process([new Float32Array(960).fill(0.1)], 48000, 960, (sample) => samples.push(sample));
  assert.equal(samples[2]?.sequence, 3);
  assert.equal(samples[2]?.windowStartTime, 1);
  assert.equal(samples[2]?.active, false);
});

test("invalid PCM and discontinuous frames fail explicitly instead of becoming silence", () => {
  assert.throws(() => new PcmWindowMeter(0, "input"));
  for (const value of [NaN, Infinity]) {
    assert.throws(() => new PcmWindowMeter(48000, "input").process([new Float32Array([value])], 0, 1, () => {}));
  }
  const meter = new PcmWindowMeter(48000, "input");
  meter.process([], 0, 128, () => {});
  assert.throws(() => meter.process([], 1152, 128, () => {}), (failure: unknown) => {
    assert.ok(failure instanceof PcmFrameDiscontinuity);
    assert.equal(failure.frameDelta, 1024);
    return true;
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { isAudioMeasurementEvent } from "../apps/web/src/audioMeasurement.ts";
import { PCM_RULES, deriveVoiceMetrics, freshOutputPcmActive, parsePcmEvidence } from "../packages/experiments/pcm.ts";
import { createPcmActivityAdapter } from "../scripts/run-experiments.ts";
import { pcmEvidence } from "./pcm-fixtures.ts";

test("same-meter input onset to received PCM silence uses backdated streaks, not confirmation times", () => {
  const evidence = parsePcmEvidence(pcmEvidence());
  assert.ok(evidence.events.every(isAudioMeasurementEvent));
  const result = deriveVoiceMetrics(evidence, "initial", "second");
  assert.equal(result.missingReason, null);
  assert.ok(Math.abs((result.inputStartToReceivedPcmSilenceMs ?? 0) - 400) < 0.000001);
  assert.ok(Math.abs((result.inputStartConfirmedAtContextTime ?? 0) - (result.inputStartContextTime ?? 0) - 0.06) < 0.000001);
  assert.ok(Math.abs((result.outputSilenceConfirmedAtContextTime ?? 0) - (result.outputSilenceContextTime ?? 0) - 0.12) < 0.000001);
  assert.equal(result.diagnostics.inputSamples, 150);
  assert.equal(result.diagnostics.outputSamples, 150);
  assert.equal(result.diagnostics.measurementEvents, 302);
  assert.equal(result.diagnostics.missingInputSamples, 0);
  assert.equal(result.clips.interruption?.peerAtPlayback?.trackEnabled, true);
});

test("meter origin and performance offset changes do not change the same-clock duration", () => {
  for (const origin of [0, 123, 900]) {
    const result = deriveVoiceMetrics(pcmEvidence({ meterOriginSeconds: origin, performanceOriginMs: 90_000 }), "initial", "second");
    assert.ok(Math.abs((result.inputStartToReceivedPcmSilenceMs ?? 0) - 400) < 0.000001);
  }
  const full = deriveVoiceMetrics(pcmEvidence({ durationMs: 46_000, performanceOriginMs: 0 }), "initial", "second");
  assert.equal(full.missingReason, null);
  assert.equal(full.diagnostics.inputSamples, 2300);
});

test("monotonic anchor drift preserves same-clock duration when the whole attribution interval fits the clips", () => {
  const evidence = pcmEvidence();
  evidence.playbacks[0]!.performanceStartMs += 50;
  evidence.playbacks[0]!.endedObservedPerformanceMs! += 50;
  for (const event of evidence.events) {
    event.clockAnchor.performanceNowMs += (event.clockAnchor.contextTime - 50) / 3 * 40;
  }
  evidence.capturedAtPerformanceMs = evidence.events.at(-1)!.clockAnchor.performanceNowMs;
  const parsed = parsePcmEvidence(evidence);
  const result = deriveVoiceMetrics(parsed, "initial", "second");
  assert.equal(result.missingReason, null);
  assert.ok((result.diagnostics.anchorOffsetSpreadMs ?? 0) > 40);
  assert.ok(Math.abs((result.inputStartToReceivedPcmSilenceMs ?? 0) - 400) < 0.000001);
  parsed.playbacks[1]!.performanceStartMs += 140;
  parsed.playbacks[1]!.endedObservedPerformanceMs! += 140;
  const ambiguous = deriveVoiceMetrics(parsed, "initial", "second");
  assert.equal(ambiguous.inputStartToReceivedPcmSilenceMs, null);
  assert.equal(ambiguous.missingReason, "input_attribution_ambiguous");

  const live = pcmEvidence({ durationMs: 1500, output: [[0.8, 1.5]] });
  for (const event of live.events) {
    event.clockAnchor.performanceNowMs += (event.clockAnchor.contextTime - 50) / 1.5 * 40;
  }
  live.capturedAtPerformanceMs = live.events.at(-1)!.clockAnchor.performanceNowMs + 5;
  assert.equal(freshOutputPcmActive(parsePcmEvidence(live)), true);
  live.capturedAtPerformanceMs += PCM_RULES.maxFreshAgeMs;
  assert.equal(freshOutputPcmActive(live), false);
});

test("mixed IDs, moved anchors, window gaps and invalid transitions stay null with exact reasons", () => {
  const mixed = pcmEvidence();
  const sample = mixed.events.find((event) => event.type === "sample" && event.direction === "output");
  assert.ok(sample);
  sample.measurementId = "another-clock";
  assert.equal(deriveVoiceMetrics(mixed, "initial", "second").missingReason, "mixed_measurement_ids");
  const clocks = pcmEvidence();
  clocks.events.at(-1)!.clockAnchor.performanceNowMs += 1000;
  assert.equal(deriveVoiceMetrics(clocks, "initial", "second").missingReason, "clock_ambiguous");
  const gap = pcmEvidence();
  gap.events.splice(50, 2);
  gap.receivedMeasurementEvents -= 2;
  const result = deriveVoiceMetrics(gap, "initial", "second");
  assert.equal(result.inputStartToReceivedPcmSilenceMs, null);
  assert.equal(result.missingReason, "sample_gap");
  assert.equal(result.diagnostics.missingInputSamples, 1);
  assert.equal(result.diagnostics.missingOutputSamples, 1);
  const transition = pcmEvidence();
  const onset = transition.events.find((event) => event.type === "sample" && event.transition === "start");
  assert.ok(onset?.type === "sample");
  onset.transitionTime = onset.windowStartTime;
  assert.equal(deriveVoiceMetrics(transition, "initial", "second").missingReason, "transition_invalid");
});

test("absent input, absent output, no overlap, and unconfirmed stop are different missing outcomes", () => {
  assert.equal(deriveVoiceMetrics(pcmEvidence({ input: [] }), "initial", "second").missingReason, "no_input");
  assert.equal(deriveVoiceMetrics(pcmEvidence({ output: [] }), "initial", "second").missingReason, "no_overlap");
  const noOutput = pcmEvidence();
  noOutput.events = noOutput.events.filter((event) => event.type !== "sample" || event.direction !== "output");
  noOutput.receivedMeasurementEvents = noOutput.events.length;
  assert.equal(deriveVoiceMetrics(noOutput, "initial", "second").missingReason, "no_output_samples");
  const noInput = pcmEvidence();
  noInput.events = noInput.events.filter((event) => event.type !== "sample" || event.direction !== "input");
  noInput.receivedMeasurementEvents = noInput.events.length;
  assert.equal(deriveVoiceMetrics(noInput, "initial", "second").missingReason, "no_input_samples");
  const tail = pcmEvidence({ output: [[0.8, 2.9]] });
  assert.equal(deriveVoiceMetrics(tail, "initial", "second").missingReason, "stop_not_observed");
  const alreadyQuiet = pcmEvidence({ output: [[0.8, 1.08]] });
  assert.equal(deriveVoiceMetrics(alreadyQuiet, "initial", "second").missingReason, "no_overlap");
});

test("fixture attribution rejects overlapping clips, cross-clip speech, ambiguous anchors and missing playback", () => {
  const overlapping = pcmEvidence();
  overlapping.playbacks[0]!.durationMs = 1500;
  overlapping.playbacks[0]!.endedObservedPerformanceMs = 2510;
  assert.equal(deriveVoiceMetrics(overlapping, "initial", "second").missingReason, "input_attribution_ambiguous");
  const spanning = pcmEvidence({ input: [[0.1, 1.4]] });
  assert.equal(deriveVoiceMetrics(spanning, "initial", "second").missingReason, "input_attribution_ambiguous");
  const ambiguous = pcmEvidence();
  ambiguous.playbacks[1]!.performanceStartMs = 2102;
  ambiguous.playbacks[1]!.durationMs = 400;
  ambiguous.events.at(-1)!.clockAnchor.performanceNowMs += 5;
  ambiguous.capturedAtPerformanceMs += 5;
  assert.equal(deriveVoiceMetrics(ambiguous, "initial", "second").missingReason, "input_attribution_ambiguous");
  assert.equal(deriveVoiceMetrics(pcmEvidence(), "initial", "missing").missingReason, "fixture_missing");
});

test("fresh activity requires current measured output, not a sticky flag, heartbeat or stale delivery", () => {
  const evidence = pcmEvidence({ durationMs: 1500, output: [[0.8, 1.5]] });
  assert.equal(freshOutputPcmActive(evidence), true);
  evidence.capturedAtPerformanceMs += PCM_RULES.maxFreshAgeMs + 1;
  assert.equal(freshOutputPcmActive(evidence), false);
  const silenceStreak = pcmEvidence({ durationMs: 1560, output: [[0.8, 1.5]] });
  assert.equal(freshOutputPcmActive(silenceStreak), false);
  const paused = pcmEvidence({ durationMs: 1500, output: [[0.8, 1.5]] });
  paused.events.push({
    type: "status", version: 1, measurementId: "test-meter", status: "paused",
    clockAnchor: { contextTime: 51.502, performanceNowMs: paused.capturedAtPerformanceMs },
  });
  paused.receivedMeasurementEvents += 1;
  assert.equal(freshOutputPcmActive(paused), false);
  assert.equal(deriveVoiceMetrics(paused, "initial", "second").missingReason, "measurement_interrupted");
});

test("peer state is diagnostic only and cannot manufacture input PCM or establish a model failure", () => {
  const evidence = pcmEvidence({ input: [] });
  const result = deriveVoiceMetrics(evidence, "initial", "second");
  assert.equal(result.clips.initial.peerAtPlayback?.connectionState, "connected");
  assert.equal(result.clips.initial.inputStartContextTime, null);
  assert.equal(result.diagnostics.inputAboveThresholdSamples, 0);
  assert.equal(result.diagnostics.interpretation, "observations-only-cause-not-established");
  evidence.peers[0]!.trackEnabled = false;
  assert.equal(deriveVoiceMetrics(evidence, "initial", "second").clips.initial.peerAtPlayback?.trackEnabled, false);
});

test("forward gaps reset both hysteresis streams without padding windows or losing pre-gap input proof", () => {
  const evidence = parsePcmEvidence(pcmEvidence({ gaps: [{ atMs: 600, durationMs: 128 }] }));
  const result = deriveVoiceMetrics(evidence, "initial", "second");
  assert.equal(result.missingReason, "measurement_interrupted");
  assert.equal(result.inputStartToReceivedPcmSilenceMs, null);
  assert.equal(result.clips.initial.missingReason, null);
  assert.equal(result.clips.interruption?.missingReason, null);
  assert.ok(result.clips.initial.inputStartContextTime !== null);
  assert.ok(result.clips.interruption?.inputStartContextTime !== null);
  assert.equal(result.diagnostics.statusEvents, 3);
  assert.equal(result.diagnostics.inputSamples, 143);
  assert.equal(result.diagnostics.outputSamples, 143);
  assert.equal(result.diagnostics.missingInputSamples, 6);
  assert.equal(result.diagnostics.missingOutputSamples, 6);
  for (const direction of ["input", "output"] as const) {
    const samples = evidence.events.filter((event) => event.type === "sample" && event.direction === direction);
    assert.ok(samples.every((sample, index) => sample.type === "sample" && sample.sequence === index + 1));
  }
  const recovering = pcmEvidence({ durationMs: 1500, gaps: [{ atMs: 1000, durationMs: 128 }] });
  assert.equal(freshOutputPcmActive(parsePcmEvidence(recovering)), true);
  // The reset occurred after this fixture started, so its apparent new onset is not attributable.
  const uncertain = deriveVoiceMetrics(recovering, "initial", "second");
  assert.equal(uncertain.clips.interruption?.inputStartContextTime, null);
  assert.equal(uncertain.clips.interruption?.missingReason, "input_attribution_ambiguous");
  assert.equal(freshOutputPcmActive(pcmEvidence({ durationMs: 1160, gaps: [{ atMs: 1000, durationMs: 128 }] })), false);
  const delayedStatuses = pcmEvidence({ durationMs: 1500, gaps: [{ atMs: 600, durationMs: 128 }] });
  const pause = delayedStatuses.events.findIndex((event) => event.type === "status" && event.status === "paused");
  const firstResumedSample = delayedStatuses.events[pause + 2];
  assert.ok(firstResumedSample?.type === "sample");
  for (const index of [pause, pause + 1]) {
    const status = delayedStatuses.events[index];
    assert.ok(status?.type === "status");
    status.clockAnchor = { ...firstResumedSample.clockAnchor };
  }
  assert.equal(freshOutputPcmActive(parsePcmEvidence(delayedStatuses)), true);
  const lostRecords = pcmEvidence();
  lostRecords.collectionGaps = 1;
  assert.equal(deriveVoiceMetrics(lostRecords, "initial", "second").clips.initial.missingReason, "collection_gap");
  assert.equal(freshOutputPcmActive(lostRecords), false);
});

test("persisting PCM rejects invalid clocks, backwards sequences and malformed hysteresis after a recovered gap", () => {
  for (const corrupt of [
    (evidence: ReturnType<typeof pcmEvidence>) => { evidence.events.at(-1)!.clockAnchor.contextTime -= 1; },
    (evidence: ReturnType<typeof pcmEvidence>) => {
      const sample = evidence.events.findLast((event) => event.type === "sample");
      assert.ok(sample?.type === "sample");
      sample.sequence -= 1;
    },
    (evidence: ReturnType<typeof pcmEvidence>) => {
      const sample = evidence.events.findLast((event) => event.type === "sample");
      assert.ok(sample?.type === "sample");
      sample.windowStartTime -= 1;
    },
    (evidence: ReturnType<typeof pcmEvidence>) => {
      const sample = evidence.events.findLast((event) => event.type === "sample");
      assert.ok(sample?.type === "sample");
      sample.active = true;
    },
    (evidence: ReturnType<typeof pcmEvidence>) => {
      const sample = evidence.events.findLast((event) => event.type === "sample");
      assert.ok(sample?.type === "sample");
      sample.rms = NaN;
    },
  ]) {
    const evidence = pcmEvidence({ gaps: [{ atMs: 600, durationMs: 128 }] });
    corrupt(evidence);
    assert.throws(() => parsePcmEvidence(evidence), /pcm_contract_invalid/);
  }
});

test("PCM evidence rejects raw waveforms, transcripts, arbitrary errors and unknown event properties", () => {
  assert.throws(() => parsePcmEvidence({ ...pcmEvidence(), rawPcm: [1, 2] }), /pcm_contract_invalid/);
  assert.throws(() => parsePcmEvidence({ ...pcmEvidence(), transcript: "SECRET" }), /pcm_contract_invalid/);
  const evidence = pcmEvidence();
  assert.throws(() => parsePcmEvidence({ ...evidence, events: [{ ...evidence.events[0], token: "SECRET" }] }), /pcm_contract_invalid/);
});

test("default adapter reads the implemented helper incrementally in an offline browser without mixing playback context", async () => {
  const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
  try {
    const context = await browser.newContext();
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    const adapter = createPcmActivityAdapter();
    await page.waitForTimeout(150);
    const evidence = pcmEvidence({ meterOriginSeconds: 50, durationMs: 100, input: [], output: [[0, 0.1]], playbacks: [] });
    await page.evaluate((events) => {
      const last = events.at(-1);
      if (!last) throw new Error("missing offline samples");
      const offset = performance.now() - last.clockAnchor.performanceNowMs;
      for (const event of events) event.clockAnchor.performanceNowMs += offset;
      window.__voiceActionExperiment = { playbacks: [], measurements: events, transcripts: [], errors: [] };
    }, evidence.events);
    const first = await adapter.collect?.(page);
    assert.ok(first);
    assert.equal(first.events.length, evidence.events.length);
    assert.equal(await adapter.remoteActive(page), true);
    await page.evaluate(() => {
      const probe = window.__voiceActionExperiment;
      if (!probe) throw new Error("missing probe");
      probe.playbacks.push({ id: "different-context", contextTime: 900, performanceTimeMs: performance.now(), durationSeconds: 0.1 });
      probe.transcripts.push({ type: "session.input_transcript.delta", receivedAtPerformanceMs: performance.now(), text: "DO_NOT_COPY" });
      probe.measurements.push({ type: "sample", secret: "DO_NOT_COPY" });
    });
    const second = await adapter.collect?.(page);
    assert.ok(second);
    assert.equal(second.events.length, first.events.length);
    assert.equal(second.invalidMeasurementEvents, 1);
    assert.equal(second.transcriptEventCount, 1);
    assert.equal(second.peers[0]?.connectionState, null);
    assert.equal(JSON.stringify(second).includes("DO_NOT_COPY"), false);
    assert.equal(JSON.stringify(second.playbacks).includes("contextTime"), false);
    assert.equal(await adapter.remoteActive(page), false);
  } finally { await browser.close(); }
});

import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { createPcmActivityAdapter } from "../../../scripts/run-experiments.ts";
import { pcmEvidence } from "../../../tests/pcm-fixtures.ts";

test("default adapter incrementally reads offline metadata without mixing playback context or retaining text", async ({ page, context }) => {
  await context.route("**/*", (route) => route.abort());
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  const adapter = createPcmActivityAdapter();
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
});

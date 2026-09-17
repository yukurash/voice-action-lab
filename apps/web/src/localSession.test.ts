import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserState } from "../../../packages/contracts/index.ts";
import type { AudioMeasurementEvent, MeasurementSample } from "./audioMeasurement.ts";
import { isAudioMeasurementEvent } from "./audioMeasurement.ts";
import { MAX_LOCAL_SESSION_BYTES, parseLocalSession, parseReplayDocument, sampleAt, serializeLocalSession } from "./localSession.ts";
import { PcmWindowMeter } from "./pcmWindow.ts";
import { MAX_SERVER_EXPORT_BYTES, SERVER_EXPORT_FORMAT } from "./serverExport.ts";
import { serverExportFixture } from "../tests/serverExport.fixture.ts";

function state(): BrowserState {
  return {
    game: {
      runId: "SENSITIVE-RUN", mode: "voice-only", epoch: 0, cargo: { red: 6, blue: 0 }, stopped: true,
      operations: [{ id: "SENSITIVE-OP", callId: "SENSITIVE-CALL", delegationId: "SENSITIVE-DELEGATION", epoch: 0,
        cargo: "red", destination: "right", status: "completed", createdAtMs: 0, endedAtMs: 6000 }],
      events: [{ sequence: 1, atMs: 6000, kind: "step.committed", operationId: "SENSITIVE-OP", delegationId: "SENSITIVE-DELEGATION",
        details: { transcript: "SENSITIVE-SPEECH", secret: "SENSITIVE-TOKEN" } }],
    },
    session: { source: "live", transport: "disconnected", message: "SENSITIVE-MESSAGE", expiresAt: null, recording: false },
  };
}
function metadata(): AudioMeasurementEvent[] {
  const samples: AudioMeasurementEvent[] = [{
    type: "anchor", version: 1, measurementId: "synthetic-test", sampleRate: 48000, windowMs: 20, thresholdDbfs: -45,
    activeWindows: 3, silentWindows: 6, clockAnchor: { contextTime: 0, performanceNowMs: 100 },
  }];
  new PcmWindowMeter(48000, "input").process([new Float32Array(2880).fill(0.01)], 0, 2880, (sample) => samples.push({
    ...sample, type: "sample", version: 1, measurementId: "synthetic-test",
    clockAnchor: { contextTime: sample.contextTime, performanceNowMs: 100 + sample.contextTime * 1000 },
  }));
  return samples;
}
test("snapshot and metadata round-trip while removing every arbitrary sensitive field", () => {
  const text = serializeLocalSession(state(), metadata());
  assert.equal(text.includes("SENSITIVE"), false);
  const result = parseLocalSession(text);
  assert.deepEqual(result.snapshot.game.cargo, { red: 6, blue: 0 });
  assert.equal(result.snapshot.game.operations[0]?.id, result.snapshot.game.events[0]?.operationId);
  assert.deepEqual(result.measurements, metadata());
  assert.ok(result.measurements.every(isAudioMeasurementEvent));
});
test("unknown fields, credentials, raw PCM, unsupported versions and unredacted snapshots are rejected", () => {
  const good = parseLocalSession(serializeLocalSession(state(), metadata()));
  for (const value of [
    { ...good, token: "sensitive" }, { ...good, version: 2 }, { ...good, snapshot: state() },
    { ...good, measurements: [...good.measurements, { ...good.measurements[1], pcm: [0.5] }] },
    { ...good, measurements: [{ ...good.measurements[0], thresholdDbfs: -40 }] },
    { ...good, snapshot: { ...good.snapshot, game: { ...good.snapshot.game, cargo: { red: 7, blue: 0 } } } },
  ]) assert.throws(() => parseLocalSession(JSON.stringify(value)));
  assert.throws(() => parseLocalSession('{"__proto__":{"polluted":true}}'));
  assert.throws(() => parseLocalSession("not-json"), /JSON/);
});
test("nonfinite clocks, missing anchors, mixed measurements and backward samples fail validation", () => {
  const good = parseLocalSession(serializeLocalSession(state(), metadata()));
  const events = good.measurements;
  const anchor = events[0];
  assert.ok(anchor?.type === "anchor");
  const invalidAnchor = { ...anchor, clockAnchor: { contextTime: 0, performanceNowMs: NaN } };
  assert.equal(isAudioMeasurementEvent(invalidAnchor), false);
  assert.throws(() => serializeLocalSession(state(), [invalidAnchor, ...events.slice(1)]));
  for (const measurements of [events.slice(1), [...events, events[1]], [...events, { ...events[2], measurementId: "another" }]]) {
    assert.throws(() => parseLocalSession(JSON.stringify({ ...good, measurements })));
  }
  const sample = events[1];
  assert.ok(sample?.type === "sample");
  assert.equal(isAudioMeasurementEvent({ ...sample, rms: Infinity }), false);
  assert.equal(isAudioMeasurementEvent({ ...sample, contextTime: sample.windowStartTime }), false);
});
test("file size is capped in UTF-8 bytes, and active snapshots cannot be exported", () => {
  assert.equal(MAX_LOCAL_SESSION_BYTES, 32 * 1024 * 1024);
  assert.throws(() => parseLocalSession("あ".repeat(Math.floor(MAX_LOCAL_SESSION_BYTES / 3) + 1)), /32 MB/);
  const active = state();
  active.game.stopped = false;
  assert.throws(() => serializeLocalSession(active, []), /停止済み/);
});

test("the ten-minute bound covers both directions even when their samples arrive in different orders", () => {
  const events = metadata();
  const anchor = events[0];
  const sample = events[1];
  assert.ok(anchor?.type === "anchor" && sample?.type === "sample");
  assert.throws(() => serializeLocalSession(state(), [
    anchor,
    { ...sample, direction: "output", windowStartTime: 700, contextTime: 700.02, clockAnchor: { contextTime: 700.024, performanceNowMs: 900000 } },
    { ...sample, clockAnchor: { contextTime: 700.04, performanceNowMs: 900010 } },
  ]), /10分/);
});
test("replay selects observed samples only, and does not invent activity across missing windows", () => {
  const samples = metadata().filter((entry): entry is MeasurementSample => entry.type === "sample");
  assert.equal(sampleAt(samples, 0), null);
  assert.equal(sampleAt(samples, 0.06)?.active, true);
  assert.equal(sampleAt(samples, 0.2), null);
  assert.throws(() => sampleAt(samples, NaN));
});

test("replay handles floating-point equality at a window boundary for arbitrary render-quantum origins", () => {
  for (let frame = 0; frame < 48000; frame += 128) {
    const samples: MeasurementSample[] = [];
    new PcmWindowMeter(48000, "input").process([], frame, 960, (sample) => samples.push({
      ...sample, type: "sample", version: 1, measurementId: "synthetic-test",
      clockAnchor: { contextTime: sample.contextTime, performanceNowMs: 1000 },
    }));
    assert.notEqual(sampleAt(samples, frame / 48000 + 0.02), null);
  }
});

test("the common reader preserves local archives and accepts the narrow server session with top-level source", () => {
  const local = serializeLocalSession(state(), metadata());
  assert.deepEqual(parseReplayDocument(local), parseLocalSession(local));
  const document = serverExportFixture();
  assert.deepEqual(Object.keys(document.session).sort(), ["recording", "transport"]);
  const replay = parseReplayDocument(JSON.stringify(document));
  assert.equal(replay.format, SERVER_EXPORT_FORMAT);
  if (replay.format !== SERVER_EXPORT_FORMAT) throw new Error("Wrong replay format.");
  assert.equal(replay.snapshot.session.source, "live");
  assert.equal(replay.snapshot.session.transport, "error");
  assert.equal(replay.snapshot.session.expiresAt, null);
  assert.deepEqual(replay.snapshot.game, document.game);
  assert.deepEqual(replay.measurements, []);
  assert.equal(replay.server.usage.status, "unconfirmed");
  assert.equal(replay.server.settings.sourceCommit, document.settings.sourceCommit);
  assert.throws(() => parseLocalSession(JSON.stringify(document)));
});

test("server usage status and numeric metrics must agree with the last final-usage event", () => {
  const document = serverExportFixture();
  const final = document.game.events[2];
  assert.ok(final);
  final.kind = "final_usage_confirmed";
  final.details = { session_seconds: 3.25, input_tokens: 4, output_tokens: 5, total_tokens: 9 };
  document.session.transport = "disconnected";
  document.usage = { scope: "voice-session-only", status: "confirmed", metrics: { session_seconds: 3.25, input_tokens: 4, output_tokens: 5, total_tokens: 9 } };
  const replay = parseReplayDocument(JSON.stringify(document));
  assert.equal(replay.format, SERVER_EXPORT_FORMAT);
  if (replay.format !== SERVER_EXPORT_FORMAT) throw new Error("Wrong replay format.");
  assert.deepEqual(replay.server.usage, document.usage);
  const mismatched = { ...document, usage: { ...document.usage, metrics: { ...document.usage.metrics, total_tokens: 1000 } } };
  assert.throws(() => parseReplayDocument(JSON.stringify(mismatched)), /数値/);
  document.game.events.push({ ...final, sequence: 4, atMs: 2100, kind: "final_usage_unconfirmed", details: {} });
  assert.throws(() => parseReplayDocument(JSON.stringify(document)), /確認状態/);
  document.usage = { scope: "voice-session-only", status: "unconfirmed", metrics: null };
  assert.doesNotThrow(() => parseReplayDocument(JSON.stringify(document)));
  assert.throws(() => parseReplayDocument(JSON.stringify({ ...document, usage: { ...document.usage, metrics: {} } })), /数値/);
});

test("simulation server exports stay not-applicable and do not acquire PCM measurements", () => {
  const document = serverExportFixture();
  document.source = "simulation";
  document.usage = { scope: "voice-session-only", status: "not-applicable", metrics: null };
  delete document.settings.sourceCommit;
  const replay = parseReplayDocument(JSON.stringify(document));
  assert.equal(replay.format, SERVER_EXPORT_FORMAT);
  if (replay.format !== SERVER_EXPORT_FORMAT) throw new Error("Wrong replay format.");
  assert.equal(replay.snapshot.session.source, "simulation");
  assert.equal(replay.server.usage.status, "not-applicable");
  assert.deepEqual(replay.measurements, []);
});

test("server import rejects unknown fields, unsafe identity, active states and incompatible settings", () => {
  const document = serverExportFixture();
  for (const value of [
    { ...document, schemaVersion: 2 }, { ...document, token: "synthetic-secret" },
    { ...document, runId: "../another" }, { ...document, source: "fake-live" },
    { ...document, game: { ...document.game, runId: "00000000-0000-0000-0000-000000000000" } },
    { ...document, game: { ...document.game, stopped: false } },
    { ...document, game: { ...document.game, cargo: { red: 7, blue: 0 } } },
    { ...document, session: { transport: "connected", recording: false } },
    { ...document, session: { ...document.session, recording: true } },
    { ...document, session: { ...document.session, source: "simulation" } },
    { ...document, closedAt: "invalid" },
    { ...document, settings: { ...document.settings, sourceOffsetsSynchronized: true } },
    { ...document, settings: { ...document.settings, stepIntervalMs: 5001 } },
    { ...document, settings: { ...document.settings, sourceCommit: "not-a-commit" } },
    { ...document, ["__proto__"]: { polluted: true } },
  ]) assert.throws(() => parseReplayDocument(JSON.stringify(value)));
  assert.throws(() => parseReplayDocument(JSON.stringify(document).replace('"tickMs":50', '"tickMs":1e309')));
});

test("server event details cannot smuggle audio, transcripts, arbitrary text or nested commands", () => {
  for (const details of [
    { transcript: "synthetic speech" }, { audio: [1, 2, 3] }, { authorization: "synthetic-token" },
    { arbitrary: "unredacted text" }, { reason: "unredacted text" }, { nested: { type: "move" } },
  ]) {
    const document = serverExportFixture();
    const first = document.game.events[0];
    assert.ok(first);
    const value = { ...document, game: { ...document.game, events: [{ ...first, details }, ...document.game.events.slice(1)] } };
    assert.throws(() => parseReplayDocument(JSON.stringify(value)));
  }
});

test("server imports use their own 2 MiB limit without reducing the local archive limit", () => {
  assert.equal(MAX_SERVER_EXPORT_BYTES, 2 * 1024 * 1024);
  const text = JSON.stringify(serverExportFixture());
  const padding = " ".repeat(MAX_SERVER_EXPORT_BYTES - new TextEncoder().encode(text).byteLength);
  assert.doesNotThrow(() => parseReplayDocument(text + padding));
  assert.throws(() => parseReplayDocument(text + padding + " "), /2 MB/);
  const local = serializeLocalSession(state(), []);
  assert.doesNotThrow(() => parseReplayDocument(local + " ".repeat(MAX_SERVER_EXPORT_BYTES)));
});

test("server collection bounds match 3000 operations and 20000 events, not smaller local limits", () => {
  const document = serverExportFixture();
  const operation = document.game.operations[0];
  assert.ok(operation);
  document.game.operations = Array.from({ length: 3000 }, () => ({ ...operation }));
  assert.equal(parseReplayDocument(JSON.stringify(document)).snapshot.game.operations.length, 3000);
  document.game.operations.push({ ...operation });
  assert.throws(() => parseReplayDocument(JSON.stringify(document)));
  document.game.operations = [];
  const event = { sequence: 1, atMs: 0, kind: "e", operationId: null, delegationId: null, details: {} };
  document.game.events = Array.from({ length: 20_000 }, () => ({ ...event }));
  const text = JSON.stringify(document);
  assert.ok(new TextEncoder().encode(text).byteLength < MAX_SERVER_EXPORT_BYTES);
  assert.equal(parseReplayDocument(text).snapshot.game.events.length, 20_000);
  document.game.events.push({ ...event });
  assert.throws(() => parseReplayDocument(JSON.stringify(document)));
});

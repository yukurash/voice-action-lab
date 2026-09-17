import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { GameEngine } from "../packages/game-engine/index.ts";
import type { ExperimentMode } from "../packages/contracts/index.ts";
import { FIXTURE_SET_VERSION, SYNTHETIC_FIXTURES } from "./synthetic-scenarios.ts";
import {
  ExperimentRunError, RUN_RULES, createRunManifest, jsonHash, parseRunManifest, sha256,
  parseFixtureManifest, parseExperimentConfiguration, assertManifestCompatible, sanitizeSnapshot,
} from "../packages/experiments/runner-model.ts";
import type { ExperimentConfiguration, RunManifest, TrialStarted } from "../packages/experiments/runner-model.ts";
import type { TrialSlot } from "../packages/experiments/schedule.ts";
import {
  acquireApiBearer, executeTrial, loadLocalInputs, openRunStore, recoverInterruptedSlots,
  runExperiments, runRunnerCli, writeExclusiveArtifact, fetchExperimentConfiguration,
} from "../scripts/run-experiments.ts";
import type { FixtureAudio, RunnerClock, RunnerPorts, TrialDriver } from "../scripts/run-experiments.ts";
import { PCM_CONTRACT_VERSION, freshOutputPcmActive } from "../packages/experiments/pcm.ts";
import type { PcmEvidence, PcmPlayback } from "../packages/experiments/pcm.ts";
import { pcmEvidence } from "./pcm-fixtures.ts";
import { analyzeExperimentDirectory } from "../scripts/analyze-experiments.ts";
import { analyzeRecordedTrials } from "../packages/experiments/aggregation.ts";

const COMMIT = "a".repeat(40);
const IMAGE = `sha256:${"b".repeat(64)}`;
const UTC = "2026-09-17T00:00:00.000Z";
const configuration = (): ExperimentConfiguration => ({
  schemaVersion: 1,
  settings: {
    liveModel: "test-live", backendModel: "test-backend", sourceCommit: COMMIT, stepIntervalMs: 3000,
    tickMs: 500, sessionLimitMs: 600_000, idleLimitMs: 90_000, sourceOffsetsSynchronized: false,
  },
  closeTimeoutMs: 5_000,
  protocolSha256: "c".repeat(64),
});

function wave(): Buffer {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF");
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVE", 8);
  return bytes;
}

function fixtureManifest() {
  return {
    version: FIXTURE_SET_VERSION, voice: "ja-JP-NanamiNeural", provider: "Azure Speech",
    sampleRate: 24_000, format: "riff-24khz-16bit-mono-pcm",
    fixtures: SYNTHETIC_FIXTURES.map((entry) => ({
      ...entry, file: `${entry.id}.wav`, bytes: wave().length, sha256: sha256(wave()),
    })),
  };
}

function audio(): FixtureAudio[] {
  return parseFixtureManifest(fixtureManifest()).map((metadata) => ({ metadata, base64: wave().toString("base64") }));
}

function manifest(limit = 100, pcmContractVersion = "unit-test-pcm-v1"): RunManifest {
  return createRunManifest({
    createdAt: UTC, seed: 77, formal: limit === 100, limit, sourceCommit: COMMIT,
    sourceFiles: { "scripts/runner.ts": sha256("unit source") }, imageDigest: IMAGE,
    configuration: configuration(), fixtureManifestSha256: jsonHash(fixtureManifest()),
    fixtures: audio().map((entry) => entry.metadata), pcmContractVersion,
  });
}

function startFor(plan: RunManifest, slot: TrialSlot): TrialStarted {
  return { schemaVersion: 1, manifestSha256: jsonHash(plan), slotId: slot.slotId, attemptId: "attempt-1", startedAt: UTC };
}

function slotFor(plan: RunManifest, scenario: string, mode: ExperimentMode): TrialSlot {
  const slot = plan.schedule.slots.find((entry) => entry.scenarioId === scenario && entry.mode === mode);
  assert.ok(slot);
  return slot;
}

class FakeClock implements RunnerClock {
  time = 0;
  readonly engines = new Set<GameEngine>();
  now() { return this.time; }
  utc() { return new Date(Date.parse(UTC) + this.time).toISOString(); }
  async sleep(milliseconds: number) {
    const end = this.time + milliseconds;
    while (this.time < end) {
      this.time = Math.min(end, this.time + 100);
      for (const engine of this.engines) engine.tick();
    }
  }
}

class FakeEnvironment {
  readonly clock = new FakeClock();
  readonly drivers: FakeDriver[] = [];
  active = 0;
  maximumActive = 0;
  pcm = true;
  skipBoundary = false;
  failPlayback = false;
  suppressCommands = false;
  releaseReservation = true;
  usageConfirmed = true;
  closeEarly = false;
  fastSteps = false;
  hangCleanup = false;
  cleanupEntered = false;
  badSourceMode: ExperimentMode | null = null;
  beforeStart: ((slot: TrialSlot) => Promise<void>) | undefined;
  inspectConfiguration: ((slot: TrialSlot) => Promise<unknown>) | undefined;
  voiceEvidenceFactory: ((driver: FakeDriver) => PcmEvidence) | undefined;
  remoteEvidenceFactory: ((driver: FakeDriver) => PcmEvidence) | undefined;
  cleanupCallback: (() => void) | undefined;
  ports(): RunnerPorts {
    return {
      pcmContractVersion: this.voiceEvidenceFactory ? PCM_CONTRACT_VERSION : "unit-test-pcm-v1", configuration: configuration(), clock: this.clock,
      createDriver: async (slot) => {
        const driver = new FakeDriver(this, slot);
        this.drivers.push(driver);
        return driver;
      },
    };
  }
}

class FakeDriver implements TrialDriver {
  readonly environment: FakeEnvironment;
  readonly slot: TrialSlot;
  engine: GameEngine | null = null;
  runStart = 0;
  readonly played: string[] = [];
  readonly playedMarkers: PcmPlayback[] = [];
  disposed = false;
  boundaryPosition: number | null = null;
  pcmChecks = 0;
  lastSnapshotBeforeCleanup: ReturnType<GameEngine["snapshot"]> | null = null;
  constructor(environment: FakeEnvironment, slot: TrialSlot) {
    this.environment = environment;
    this.slot = slot;
  }
  async inspect() {
    if (this.environment.inspectConfiguration) return this.environment.inspectConfiguration(this.slot);
    const result = configuration();
    if (this.environment.badSourceMode === this.slot.mode) result.settings.sourceCommit = "d".repeat(40);
    return result;
  }
  async assertIdle() {
    if (this.environment.active !== 0) throw new ExperimentRunError("server_busy");
  }
  async start(mode: ExperimentMode) {
    await this.environment.beforeStart?.(this.slot);
    assert.equal(this.environment.active, 0);
    this.environment.active += 1;
    this.environment.maximumActive = Math.max(this.environment.maximumActive, this.environment.active);
    this.runStart = this.environment.clock.now();
    this.engine = new GameEngine({ mode, runId: `run-${this.slot.ordinal}`,
      now: () => this.environment.clock.now() - this.runStart, stepIntervalMs: this.environment.fastSteps ? 1_000 : 3_000 });
    this.environment.clock.engines.add(this.engine);
  }
  async play(fixture: FixtureAudio, id: string) {
    if (this.environment.failPlayback) throw new Error("PRIVATE_BEARER_MUST_NOT_PERSIST");
    const engine = this.engine;
    assert.ok(engine);
    if (fixture.metadata.id === "brief-cancel") this.boundaryPosition = engine.snapshot().cargo.red;
    this.played.push(fixture.metadata.id);
    this.playedMarkers.push({
      id, performanceStartMs: this.environment.clock.now() - this.runStart, durationMs: 1000,
      endedObservedPerformanceMs: this.environment.clock.now() - this.runStart + 1000,
    });
    await this.environment.clock.sleep(1_000);
    if (fixture.metadata.id === "backchannel" || this.environment.suppressCommands) return;
    const delegationId = `delegation-${this.played.length}`;
    engine.registerDelegation(delegationId);
    engine.dispatch({
      callId: delegationId, delegationId,
      command: fixture.metadata.id === "move-red" ? { type: "move", cargo: "red", destination: "right" }
        : fixture.metadata.id === "replace-blue" ? { type: "replace", cargo: "blue", destination: "right" }
          : { type: "cancel" },
    });
  }
  async remoteActive() {
    this.pcmChecks += 1;
    return this.environment.pcm && (this.environment.remoteEvidenceFactory
      ? freshOutputPcmActive(this.environment.remoteEvidenceFactory(this)) : true);
  }
  async voiceEvidence() { return this.environment.voiceEvidenceFactory?.(this) ?? null; }
  async snapshot() {
    assert.ok(this.engine);
    if (this.environment.skipBoundary && this.slot.scenarioId === "boundary" && this.played.length === 1) {
      this.environment.skipBoundary = false;
      await this.environment.clock.sleep(20_000);
    }
    if (this.environment.closeEarly && this.played.length > 0) this.engine.stop("session-expired");
    return this.engine.snapshot();
  }
  async cleanup() {
    this.environment.cleanupEntered = true;
    if (this.environment.hangCleanup) await new Promise<never>(() => {});
    if (!this.engine) return {
      reservationReleased: this.environment.active === 0,
      usage: { scope: "voice-session-only", status: "unconfirmed", metrics: null } as const,
    };
    this.lastSnapshotBeforeCleanup = this.engine.snapshot();
    this.engine.stop("emergency-cleanup");
    this.environment.cleanupCallback?.();
    await this.environment.clock.sleep(200);
    if (this.environment.releaseReservation) this.environment.active -= 1;
    return {
      reservationReleased: this.environment.releaseReservation,
      usage: { scope: "voice-session-only", status: this.environment.usageConfirmed ? "confirmed" : "unconfirmed",
        metrics: this.environment.usageConfirmed ? { session_seconds: (this.environment.clock.now() - this.runStart) / 1_000 } : null } as const,
    };
  }
  async dispose() {
    this.disposed = true;
    if (this.engine) this.environment.clock.engines.delete(this.engine);
  }
}

function driverPcm(driver: FakeDriver, overrides: Parameters<typeof pcmEvidence>[0] = {}): PcmEvidence {
  const second = driver.playedMarkers[1];
  return pcmEvidence({
    durationMs: driver.environment.clock.now() - driver.runStart, performanceOriginMs: 0,
    playbacks: structuredClone(driver.playedMarkers),
    input: driver.playedMarkers.map((marker): [number, number] =>
      [marker.performanceStartMs / 1000 + 0.2, marker.performanceStartMs / 1000 + 0.7]),
    output: [[0.8, second ? second.performanceStartMs / 1000 + 0.6 : 2]],
    ...overrides,
  });
}

async function files(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "formal-runner-tests-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repository = join(base, "public-repo");
  const fixtures = join(base, "audio-v3");
  const output = join(base, "private-run");
  for (const directory of ["scripts", "packages", "apps/server", "apps/web/src", "tests"]) {
    await mkdir(join(repository, directory), { recursive: true });
  }
  for (const file of ["scripts/experiment-browser.ts", "scripts/run-experiments.ts",
    "scripts/analyze-experiments.ts", "tests/synthetic-scenarios.ts", "package.json", "package-lock.json", "tsconfig.json"]) {
    await writeFile(join(repository, file), file.endsWith(".json") ? "{}" : "// unit-test provenance\n");
  }
  await mkdir(fixtures);
  for (const entry of SYNTHETIC_FIXTURES) await writeFile(join(fixtures, `${entry.id}.wav`), wave());
  const fixturePath = join(fixtures, "manifest.json");
  await writeFile(fixturePath, JSON.stringify(fixtureManifest()));
  return {
    base, repository, fixtures, fixturePath, output,
    options(limit: number, resume = false) {
      return {
        repository, output, fixtureManifest: fixturePath, seed: 77, formal: limit === 100,
        limit, resume, sourceCommit: COMMIT, imageDigest: IMAGE,
      };
    },
  };
}

test("v3 fixture object is validated against public definitions without retaining subtitles", () => {
  const value = fixtureManifest();
  const parsed = parseFixtureManifest(value);
  assert.equal(parsed.length, 5);
  assert.equal(JSON.stringify(parsed).includes(SYNTHETIC_FIXTURES[0].text), false);
  assert.throws(() => parseFixtureManifest(value.fixtures), /invalid_artifact/);
  assert.throws(() => parseFixtureManifest({ ...value, version: "ja-cargo-v2" }), /fixture_manifest_mismatch/);
  const invalid = { ...value, fixtures: value.fixtures.map((entry, index) => index === 0 ? { ...entry, text: "incorrect" } : entry) };
  assert.throws(() => parseFixtureManifest(invalid), /fixture_manifest_mismatch/);
});

test("manifest fixes all 100 slots, source/image/config/fixture hashes, seed, and versioned rules", () => {
  const value = manifest();
  assert.equal(value.schedule.slots.length, 100);
  assert.equal(value.schedule.seed, 77);
  assert.equal(value.sourceSha256, jsonHash(value.sourceFiles));
  assert.equal(value.configurationSha256, jsonHash(value.configuration));
  assert.equal(value.rules.observationMs, 45_000);
  assert.equal(value.rules.remoteActiveWaitMs, 30_000);
  assert.equal(value.rules.trialMaxMs, 180_000);
  assert.equal(value.rules.sourceOffsetsSynchronized, false);
  assert.deepEqual(parseRunManifest(JSON.parse(JSON.stringify(value))), value);
  assertManifestCompatible(value, { ...value, createdAt: "2026-09-18T00:00:00.000Z" });
  for (const changed of [
    { ...value, imageDigest: `sha256:${"e".repeat(64)}` },
    { ...value, pcmContractVersion: "changed" },
    { ...value, fixtureManifestSha256: "e".repeat(64) },
    { ...value, execution: { formal: false, limit: 1 } },
  ]) assert.throws(() => assertManifestCompatible(value, changed), /manifest_mismatch/);
  assert.throws(() => parseRunManifest({ ...value, rules: { ...value.rules, observationMs: 20_000 } }), /manifest_mismatch/);
  assert.throws(() => parseRunManifest({ ...value, bearer: "NEVER_STORE" }), /manifest_mismatch/);
});

test("both mode configurations must match sourceCommit and the 3000ms step interval", async () => {
  for (const mode of ["voice-only", "cancel-actions"] as const) {
    const env = new FakeEnvironment();
    env.badSourceMode = mode;
    const plan = manifest();
    const slot = slotFor(plan, "normal", mode);
    const result = await executeTrial(plan, slot, startFor(plan, slot), audio(), env.ports());
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "source_mismatch");
    assert.equal(env.active, 0);
    assert.equal(env.drivers[0]?.engine, null);
  }
  assert.throws(() => parseExperimentConfiguration({
    ...configuration(), settings: { ...configuration().settings, stepIntervalMs: 1_000 },
  }, COMMIT), /config_mismatch/);
  assert.throws(() => parseExperimentConfiguration({
    ...configuration(), settings: { ...configuration().settings, sourceOffsetsSynchronized: true },
  }, COMMIT), /config_mismatch/);
  assert.throws(() => parseExperimentConfiguration({
    ...configuration(), settings: { ...configuration().settings, tickMs: 0 },
  }, COMMIT), /config_mismatch/);
  assert.throws(() => parseExperimentConfiguration({
    ...configuration(), settings: { ...configuration().settings, sourceCommit: undefined },
  }, COMMIT), /source_mismatch/);
});

test("a snapshot crossing the observation deadline never schedules a nonpositive sleep", async () => {
  const env = new FakeEnvironment();
  const plan = manifest();
  const slot = slotFor(plan, "normal", "voice-only");
  const ports = env.ports();
  const createDriver = ports.createDriver;
  const sleep = env.clock.sleep.bind(env.clock);
  env.clock.sleep = async (milliseconds) => {
    assert.ok(milliseconds > 0, "timers must never be negative or zero");
    await sleep(milliseconds);
  };
  ports.createDriver = async (...args) => {
    const driver = await createDriver(...args);
    const snapshot = driver.snapshot.bind(driver);
    let delayed = false;
    driver.snapshot = async (timeout) => {
      if (!delayed && env.drivers[0]!.played.length > 0) {
        delayed = true;
        await env.clock.sleep(RUN_RULES.observationMs + 1);
      }
      return snapshot(timeout);
    };
    return driver;
  };
  const result = await executeTrial(plan, slot, startFor(plan, slot), audio(), ports);
  assert.equal(result.status, "completed");
  assert.equal(result.timings.observationMs, RUN_RULES.observationMs);
  assert.equal(result.timings.observationActualMs, RUN_RULES.observationMs + 1);
});

test("normal and A replacement observe the entire fixed 45-second window, not early completion", async () => {
  for (const scenario of ["normal", "replace-blue"]) {
    const env = new FakeEnvironment();
    const plan = manifest();
    const slot = slotFor(plan, scenario, "voice-only");
    const result = await executeTrial(plan, slot, startFor(plan, slot), audio(), env.ports());
    assert.equal(result.status, "completed");
    assert.equal(result.timings.observationMs, 45_000);
    assert.equal(result.timings.observationActualMs, 45_000);
    const reference = scenario === "normal" ? result.timings.initialEndMs : result.timings.secondEndMs;
    assert.equal((result.timings.elapsedMs ?? 0) - (result.timings.cleanupMs ?? 0) - (reference ?? 0), 45_000);
    assert.deepEqual(result.preCleanupSnapshot?.cargo, { red: 6, blue: scenario === "normal" ? 0 : 6 });
    assert.equal(result.preCleanupSnapshot?.stopped, false);
    assert.ok(!result.preCleanupSnapshot?.events.some((event) => event.kind === "engine.stopped"));
    assert.equal(result.cleanup.usage.status, "confirmed");
    assert.equal(result.goalMet, true);
    assert.equal(env.active, 0);
    assert.equal(env.drivers[0]?.disposed, true);
  }
});

test("owner config GET is uncached and preserves the server's opaque protocol hash in the manifest", async (t) => {
  const remote = { ...configuration(), protocolSha256: sha256('{"z":1,"a":2}') };
  assert.notEqual(remote.protocolSha256, jsonHash({ z: 1, a: 2 }));
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    paths.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer PRIVATE_TEST_BEARER");
    assert.equal(new Headers(init?.headers).get("Cache-Control"), "no-cache");
    assert.equal(new Headers(init?.headers).get("Origin"), "https://example.invalid");
    assert.equal(init?.body, undefined);
    assert.ok(init?.signal);
    return Response.json(remote);
  });
  const actual = parseExperimentConfiguration(await fetchExperimentConfiguration("https://example.invalid", "PRIVATE_TEST_BEARER"), COMMIT);
  const plan = { ...manifest(), configuration: actual, configurationSha256: jsonHash(actual) };
  assert.deepEqual(parseRunManifest(plan).configuration, remote);
  assert.equal(JSON.stringify(plan).includes("PRIVATE_TEST_BEARER"), false);
  assert.deepEqual(paths, ["https://example.invalid/api/experiment-config"]);
});

test("config 404, auth/HTTP failures, invalid JSON and network errors never fall back to public config", async (t) => {
  let status = 404;
  let networkFailure = false;
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    paths.push(String(input));
    if (networkFailure) throw new Error("PRIVATE_NETWORK_DETAIL");
    return new Response(status === 204 ? null : "PRIVATE_SERVER_BODY", { status });
  });
  for (status of [404, 401, 403, 500, 302, 204, 200]) {
    const expected = status === 404 ? "config_not_found" : status === 200 ? "config_mismatch" : "config_unavailable";
    await assert.rejects(fetchExperimentConfiguration("https://example.invalid", "PRIVATE_TEST_BEARER"),
      (error: unknown) => error instanceof ExperimentRunError && error.message === expected);
  }
  networkFailure = true;
  await assert.rejects(fetchExperimentConfiguration("https://example.invalid", "PRIVATE_TEST_BEARER"),
    (error: unknown) => error instanceof ExperimentRunError && error.message === "config_unavailable");
  assert.equal(paths.length, 8);
  assert.ok(paths.every((path) => path === "https://example.invalid/api/experiment-config"));
});

test("every source, protocol and setting drift is rejected before session admission or audio in either mode", async () => {
  const baseline = configuration();
  const changed: { value: unknown; code: string }[] = [
    { value: { ...baseline, settings: { ...baseline.settings, sourceCommit: "d".repeat(40) } }, code: "source_mismatch" },
    ...[
      { ...baseline, protocolSha256: "d".repeat(64) },
      { ...baseline, closeTimeoutMs: 4000 },
      ...[
        { liveModel: "changed-live" }, { backendModel: "changed-backend" }, { stepIntervalMs: 1000 },
        { tickMs: 250 }, { sessionLimitMs: 500_000 }, { idleLimitMs: 80_000 }, { sourceOffsetsSynchronized: true },
        { extraSetting: true },
      ].map((setting) => ({ ...baseline, settings: { ...baseline.settings, ...setting } })),
      { ...baseline, protocolSha256: "invalid" },
      { ...baseline, rawPrompt: "PRIVATE_PROMPT" },
      null,
    ].map((value) => ({ value, code: "config_mismatch" })),
  ];
  for (const mode of ["voice-only", "cancel-actions"] as const) {
    for (const change of changed) {
      const env = new FakeEnvironment();
      env.inspectConfiguration = async () => change.value;
      const plan = manifest();
      const pinnedHash = jsonHash(plan);
      const slot = slotFor(plan, "normal", mode);
      const result = await executeTrial(plan, slot, startFor(plan, slot), audio(), env.ports());
      assert.equal(result.status, "failed");
      assert.equal(result.failureCode, change.code);
      assert.equal(env.active, 0);
      assert.equal(env.drivers[0]?.engine, null);
      assert.deepEqual(env.drivers[0]?.played, []);
      assert.equal(jsonHash(plan), pinnedHash);
      assert.equal(JSON.stringify(result).includes("PRIVATE_PROMPT"), false);
    }
  }
});

test("per-trial config disappearance keeps the failed slot and stops subsequent slots without rebasing the manifest", async (t) => {
  const f = await files(t);
  const env = new FakeEnvironment();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://example.invalid/api/experiment-config");
    // The production proxy rejects even authenticated requests without the exact Origin.
    if (new Headers(init?.headers).get("Origin") !== "https://example.invalid") return new Response(null, { status: 403 });
    requests += 1;
    return requests <= 3 ? Response.json(configuration()) : new Response("PRIVATE_SERVER_BODY", { status: 404 });
  });
  const initial = parseExperimentConfiguration(await fetchExperimentConfiguration("https://example.invalid", "PRIVATE_TEST_BEARER"), COMMIT);
  env.inspectConfiguration = async () => fetchExperimentConfiguration("https://example.invalid", "PRIVATE_TEST_BEARER");
  const result = await runExperiments(f.options(3), { ...env.ports(), configuration: initial });
  assert.equal(requests, 4);
  assert.equal(result.report.totals.completed, 1);
  assert.equal(result.report.totals.failed, 1);
  assert.equal(result.report.totals.notRun, 98);
  assert.equal(result.report.rows[1]?.result?.failureCode, "config_not_found");
  assert.equal(env.drivers[1]?.engine, null);
  assert.equal(env.drivers.length, 2);
  assert.equal(env.active, 0);
  assert.deepEqual(result.report.manifest.configuration, initial);
  assert.equal(result.report.manifest.configurationSha256, jsonHash(initial));
  const persisted = await readFile(join(f.output, "manifest.json"), "utf8");
  assert.equal(persisted.includes("PRIVATE_"), false);
  const envelope = JSON.parse(persisted);
  assert.equal(envelope.sha256, jsonHash(result.report.manifest));
});

test("configuration is checked again after readiness and before the initial audio input", async () => {
  for (const mode of ["voice-only", "cancel-actions"] as const) {
    const env = new FakeEnvironment();
    env.inspectConfiguration = async () => env.active === 0 ? configuration()
      : { ...configuration(), protocolSha256: "d".repeat(64) };
    const plan = manifest();
    const slot = slotFor(plan, "normal", mode);
    const result = await executeTrial(plan, slot, startFor(plan, slot), audio(), env.ports());
    assert.equal(result.failureCode, "config_mismatch");
    assert.equal(env.maximumActive, 1);
    assert.equal(env.active, 0);
    assert.deepEqual(env.drivers[0]?.played, []);
    assert.equal(result.timings.initialEndMs, null);
    assert.equal(result.actionMetrics?.cancelIntentAccepted, 0);
    assert.equal(result.cleanup.reservationReleased, true);
  }
});

test("PCM-gated scenarios fail after 30 seconds without playing a second clip or dropping the trial", async () => {
  for (const scenario of ["cancel", "replace-blue", "backchannel"]) {
    const env = new FakeEnvironment();
    env.pcm = false;
    const plan = manifest();
    const slot = slotFor(plan, scenario, "cancel-actions");
    const result = await executeTrial(plan, slot, startFor(plan, slot), audio(), env.ports());
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "pcm_condition_unmet");
    assert.equal(result.conditionMet, false);
    assert.equal(result.timings.secondEndMs, null);
    assert.equal(result.timings.observationMs, null);
    assert.equal((result.timings.elapsedMs ?? 0) - (result.timings.cleanupMs ?? 0) - (result.timings.initialEndMs ?? 0), 30_000);
    assert.deepEqual(env.drivers[0]?.played, ["move-red"]);
    assert.equal(result.actionMetrics?.cancelIntentAccepted, 0);
  }
});

test("boundary uses the first observed red>=5 with pending red work; a missed window is a retained failure", async () => {
  const plan = manifest();
  const slot = slotFor(plan, "boundary", "cancel-actions");
  const env = new FakeEnvironment();
  env.pcm = false;
  const result = await executeTrial(plan, slot, startFor(plan, slot), audio(), env.ports());
  assert.equal(result.status, "completed");
  assert.equal(env.drivers[0]?.boundaryPosition, 5);
  assert.deepEqual(env.drivers[0]?.played, ["move-red", "brief-cancel"]);
  assert.equal(env.drivers[0]?.pcmChecks, 0);
  assert.equal(result.actionMetrics?.stepsAfterAcceptedCancellation, 0);
  assert.equal(result.preCleanupSnapshot?.cargo.red, 5);
  const missed = new FakeEnvironment();
  missed.skipBoundary = true;
  const failed = await executeTrial(plan, slot, startFor(plan, slot), audio(), missed.ports());
  assert.equal(failed.failureCode, "boundary_condition_unmet");
  assert.equal(failed.conditionMet, false);
  assert.deepEqual(missed.drivers[0]?.played, ["move-red"]);
});

test("all 100 formal slots execute sequentially, with immutable starts preceding session admission", async (t) => {
  const f = await files(t);
  const env = new FakeEnvironment();
  env.beforeStart = async (slot) => {
    const stored = JSON.parse(await readFile(join(f.output, "slots", `${String(slot.ordinal).padStart(3, "0")}.started.json`), "utf8"));
    assert.equal(stored.payload.slotId, slot.slotId);
    const frozen = JSON.parse(await readFile(join(f.output, "manifest.json"), "utf8"));
    assert.equal(frozen.payload.rules.observationMs, 45_000);
    assert.equal(frozen.sha256, stored.payload.manifestSha256);
  };
  const result = await runExperiments(f.options(100), env.ports());
  assert.equal(result.report.formalComplete, true);
  assert.equal(result.report.rows.length, 100);
  assert.equal(result.report.totals.completed, 100);
  assert.equal(result.report.totals.failed, 0);
  assert.equal(result.report.totals.goalMet, 100);
  assert.equal(env.maximumActive, 1);
  assert.equal(env.active, 0);
  assert.equal(env.drivers.length, 100);
  assert.ok(result.report.rows.every((row) => (row.result?.timings.elapsedMs ?? Infinity) <= 180_000));
  assert.ok(result.report.rows.every((row) => row.result?.actionMetrics?.idempotentReplayCount === null));
  assert.equal((await readdir(join(f.output, "slots"))).length, 200);
  const resumed = await runExperiments(f.options(100, true), env.ports());
  assert.equal(resumed.report.totals.completed, 100);
  assert.equal(env.drivers.length, 100);
});

test("a silent boundary still injects brief-cancel at red five and observes actions with missing voice latency", async () => {
  const plan = manifest(100, PCM_CONTRACT_VERSION);
  const slot = slotFor(plan, "boundary", "cancel-actions");
  const env = new FakeEnvironment();
  env.pcm = false;
  env.voiceEvidenceFactory = (driver) => driverPcm(driver, { output: [] });
  const result = await executeTrial(plan, slot, startFor(plan, slot), audio(), env.ports());
  assert.equal(result.status, "completed");
  assert.equal(result.conditionMet, true);
  assert.equal(result.goalMet, true);
  assert.equal(result.timings.observationActualMs, 45_000);
  assert.equal(env.drivers[0]?.boundaryPosition, 5);
  assert.equal(env.drivers[0]?.pcmChecks, 0);
  assert.deepEqual(env.drivers[0]?.played, ["move-red", "brief-cancel"]);
  assert.equal(result.voiceMetrics?.data.inputStartToReceivedPcmSilenceMs, null);
  assert.equal(result.voiceMetrics?.data.missingReason, "no_overlap");
  assert.equal(analyzeRecordedTrials(plan, [result]).totals.actionObservations.goalMet, 1);
});

test("usage-only cleanup failure preserves a complete input-verified action observation", async () => {
  const plan = manifest(100, PCM_CONTRACT_VERSION);
  const slot = slotFor(plan, "normal", "voice-only");
  const reports = [];
  for (const usageConfirmed of [true, false]) {
    const env = new FakeEnvironment();
    env.usageConfirmed = usageConfirmed;
    env.voiceEvidenceFactory = driverPcm;
    const result = await executeTrial(plan, slot, startFor(plan, slot), audio(), env.ports());
    assert.equal(result.status, usageConfirmed ? "completed" : "failed");
    assert.equal(result.failureCode, usageConfirmed ? null : "cleanup_unconfirmed");
    assert.equal(result.cleanup.reservationReleased, true);
    assert.equal(result.goalMet, true);
    reports.push(analyzeRecordedTrials(plan, [result]));
  }
  assert.equal(reports[0]?.totals.goalMet, 1);
  assert.equal(reports[1]?.totals.goalMet, 1);
  assert.deepEqual(reports[0]?.totals.actionObservations, reports[1]?.totals.actionObservations);
});

test("forward-gap PCM resumes interruption admission and persists action success with null voice latency through reanalysis", async (t) => {
  const f = await files(t);
  const plan = manifest(100, PCM_CONTRACT_VERSION);
  const slot = slotFor(plan, "cancel", "cancel-actions");
  const start = startFor(plan, slot);
  const env = new FakeEnvironment();
  const gaps = [{ atMs: 800, durationMs: 128 }];
  let captured: PcmEvidence | undefined;
  let retained: PcmEvidence | undefined;
  env.remoteEvidenceFactory = (driver) => driverPcm(driver, { gaps });
  env.voiceEvidenceFactory = (driver) => {
    captured = driverPcm(driver, { gaps });
    return captured;
  };
  env.cleanupCallback = () => {
    assert.ok(captured);
    const last = captured.events.at(-1);
    assert.ok(last);
    captured.events.push({
      type: "status", version: 1, measurementId: last.measurementId, status: "paused",
      clockAnchor: { ...last.clockAnchor },
    });
    captured.receivedMeasurementEvents += 1;
  };
  const store = await openRunStore(f.repository, f.output);
  try {
    await store.initialize(plan, false);
    await store.start(plan, slot, start);
    const result = await executeTrial(plan, slot, start, audio(), env.ports(), (evidence) => { retained = evidence; });
    assert.ok(retained);
    assert.equal(result.status, "completed");
    assert.equal(result.goalMet, true);
    assert.equal(env.drivers[0]?.pcmChecks, 1);
    assert.equal(result.voiceMetrics?.data.missingReason, "measurement_interrupted");
    assert.equal(result.voiceMetrics?.data.inputStartToReceivedPcmSilenceMs, null);
    assert.equal(result.voiceMetrics?.data.diagnostics.statusEvents, 3);
    assert.equal(retained.events.filter((event) => event.type === "status" && event.status === "paused").length, 1);
    await store.evidence(plan, slot, start, retained);
    await store.result(plan, slot, result);
  } finally { await store.close(); }
  const analyzed = await analyzeExperimentDirectory(f.repository, f.output, "forward-gap-analysis.json");
  assert.equal(analyzed.rows.length, 100);
  assert.equal(analyzed.totals.goalMet, 1);
  assert.equal(analyzed.totals.actionObservations.n, 1);
  assert.equal(analyzed.totals.voiceMetrics.n, 0);
  assert.equal(analyzed.totals.voiceMetrics.missing, 100);
  assert.deepEqual(analyzed.totals.voiceMetrics.missingReasons, { not_collected: 99, measurement_interrupted: 1 });
});

test("resume never reruns either successes or failures and never overwrites terminal files", async (t) => {
  const f = await files(t);
  const env = new FakeEnvironment();
  env.failPlayback = true;
  const first = await runExperiments(f.options(3), env.ports());
  assert.equal(first.report.totals.failed, 3);
  assert.equal(first.report.totals.notRun, 97);
  const path = join(f.output, "slots", "001.result.json");
  const original = await readFile(path, "utf8");
  assert.equal(original.includes("PRIVATE_BEARER_MUST_NOT_PERSIST"), false);
  const count = env.drivers.length;
  env.failPlayback = false;
  const resumed = await runExperiments(f.options(3, true), env.ports());
  assert.equal(env.drivers.length, count);
  assert.equal(resumed.report.totals.failed, 3);
  assert.equal(await readFile(path, "utf8"), original);
  await assert.rejects(runExperiments({ ...f.options(3, true), imageDigest: `sha256:${"f".repeat(64)}` }, env.ports()), /manifest_mismatch/);
  await assert.rejects(runExperiments(f.options(100, true), env.ports()), /manifest_mismatch/);
  await assert.rejects(runExperiments(f.options(3, true), {
    ...env.ports(), configuration: { ...configuration(), protocolSha256: "d".repeat(64) },
  }), /manifest_mismatch/);
  assert.equal(env.drivers.length, count);
});

test("all 100 PCM slots persist hashed metadata, missing reasons and diagnostics without dropping failures on analysis or resume", async (t) => {
  const f = await files(t);
  const env = new FakeEnvironment();
  env.voiceEvidenceFactory = (driver) => {
    const absentInput = driver.slot.scenarioId === "normal" && driver.slot.repetition === 1 && driver.slot.mode === "voice-only";
    const gap = driver.slot.scenarioId === "cancel" && driver.slot.repetition === 1 && driver.slot.mode === "cancel-actions";
    const second = driver.playedMarkers[1];
    const evidence = pcmEvidence({
      durationMs: env.clock.now() - driver.runStart, performanceOriginMs: 0,
      playbacks: structuredClone(driver.playedMarkers),
      input: absentInput ? [] : driver.playedMarkers.map((marker): [number, number] =>
        [marker.performanceStartMs / 1000 + 0.2, marker.performanceStartMs / 1000 + 0.7]),
      output: [[0.8, second ? second.performanceStartMs / 1000 + 0.6 : 2]],
    });
    if (gap) {
      evidence.events.splice(50, 2);
      evidence.receivedMeasurementEvents -= 2;
    }
    return evidence;
  };
  const result = await runExperiments(f.options(100), env.ports());
  assert.equal(result.report.formalComplete, true);
  assert.equal(result.report.rows.length, 100);
  assert.equal(result.report.totals.completed, 98);
  assert.equal(result.report.totals.failed, 2);
  assert.equal(result.report.totals.notRun, 0);
  assert.equal(result.report.manifest.pcmContractVersion, PCM_CONTRACT_VERSION);
  assert.equal(result.report.manifest.pcmRules?.windowMs, 20);
  assert.equal(result.report.totals.voiceMetrics.n, 79);
  assert.equal(result.report.totals.voiceMetrics.missing, 21);
  assert.deepEqual(result.report.totals.voiceMetrics.missingReasons, { no_input: 1, no_overlap: 19, sample_gap: 1 });
  assert.ok(Math.abs((result.report.totals.voiceMetrics.p95 ?? 0) - 400) < 0.000001);
  assert.equal(result.report.totals.voiceMetrics.inputSamples.n, 100);
  assert.equal(env.maximumActive, 1);
  assert.equal(env.drivers.length, 100);
  assert.equal((await readdir(join(f.output, "evidence"))).length, 100);
  const pcmPath = join(f.output, "evidence", "001.pcm.json");
  const original = await readFile(pcmPath, "utf8");
  assert.ok(!original.includes("Float32Array"));
  assert.ok(!original.includes(SYNTHETIC_FIXTURES[0].text));
  const payload = JSON.parse(original);
  assert.equal(payload.sha256, jsonHash(payload.payload));
  assert.equal(jsonHash(payload.payload.evidence), result.report.rows[0]?.result?.voiceMetrics?.evidenceSha256);
  const analyzed = await analyzeExperimentDirectory(f.repository, f.output, "pcm-analysis.json");
  assert.deepEqual(analyzed.totals, result.report.totals);
  const resumed = await runExperiments(f.options(100, true), env.ports());
  assert.deepEqual(resumed.report.totals, result.report.totals);
  assert.equal(env.drivers.length, 100);
  assert.equal(await readFile(pcmPath, "utf8"), original);
  payload.payload.evidence.transcriptEventCount += 1;
  payload.sha256 = jsonHash(payload.payload);
  await writeFile(pcmPath, JSON.stringify(payload));
  const store = await openRunStore(f.repository, f.output);
  try { await assert.rejects(store.records(result.report.manifest), /invalid_artifact/); } finally { await store.close(); }
});

test("connected peer with neither input PCM nor delegations is an unconfirmed-input trial, not a model failure", async () => {
  const env = new FakeEnvironment();
  env.suppressCommands = true;
  env.voiceEvidenceFactory = (driver) => pcmEvidence({
    durationMs: env.clock.now() - driver.runStart, performanceOriginMs: 0,
    playbacks: structuredClone(driver.playedMarkers), input: [], output: [],
  });
  const plan = manifest();
  const slot = slotFor(plan, "normal", "voice-only");
  const result = await executeTrial(plan, slot, startFor(plan, slot), audio(), env.ports());
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "input_pcm_unconfirmed");
  assert.equal(result.preCleanupSnapshot?.operations.length, 0);
  assert.equal(result.preCleanupSnapshot?.events.filter((event) => event.kind === "delegation.registered").length, 0);
  assert.equal(result.voiceMetrics?.data.diagnostics.transcriptEventCount, 0);
  assert.equal(result.voiceMetrics?.data.diagnostics.inputAboveThresholdSamples, 0);
  assert.equal(result.voiceMetrics?.data.clips.initial.peerAtPlayback?.connectionState, "connected");
  assert.equal(result.voiceMetrics?.data.missingReason, "no_input");
  assert.equal(result.voiceMetrics?.data.diagnostics.interpretation, "observations-only-cause-not-established");
});

test("started-but-uncommitted crash slots become failed, never a fresh retry", async (t) => {
  const f = await files(t);
  const input = await loadLocalInputs(f.repository, f.fixturePath);
  const plan = createRunManifest({
    createdAt: UTC, seed: 77, formal: false, limit: 3, sourceCommit: COMMIT, sourceFiles: input.sourceFiles,
    imageDigest: IMAGE, configuration: configuration(), fixtureManifestSha256: input.fixtureManifestSha256,
    fixtures: input.fixtures.map((entry) => entry.metadata), pcmContractVersion: "unit-test-pcm-v1",
  });
  const slot = plan.schedule.slots[0];
  assert.ok(slot);
  const store = await openRunStore(f.repository, f.output);
  await store.initialize(plan, false);
  await store.start(plan, slot, startFor(plan, slot));
  await store.close();
  const env = new FakeEnvironment();
  const result = await runExperiments(f.options(3, true), env.ports());
  assert.equal(result.report.rows[0]?.result?.failureCode, "interrupted");
  assert.equal(result.report.rows[0]?.result?.timings.elapsedMs, null);
  assert.equal(env.drivers.length, 2);
  assert.ok(env.drivers.every((driver) => driver.slot.slotId !== slot.slotId));
  const again = await openRunStore(f.repository, f.output);
  const recovered = await recoverInterruptedSlots(again, await again.manifest(), new Date().toISOString());
  assert.equal(recovered.length, 3);
  await again.close();
});

test("live locks and corrupt records fail closed instead of stealing a run or skipping damaged evidence", async (t) => {
  const f = await files(t);
  const store = await openRunStore(f.repository, f.output);
  await assert.rejects(openRunStore(f.repository, f.output), /runner_locked/);
  const plan = manifest(1);
  await store.initialize(plan, false);
  const slot = plan.schedule.slots[0];
  assert.ok(slot);
  await store.start(plan, slot, startFor(plan, slot));
  await writeFile(join(f.output, "slots", "001.result.json"), "{partial");
  await assert.rejects(store.records(plan), /invalid_artifact/);
  await assert.rejects(store.start(plan, slot, startFor(plan, slot)), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "EEXIST");
  await store.close();
});

test("canonical output guards and fixture hashes apply before any driver is created", async (t) => {
  const f = await files(t);
  const env = new FakeEnvironment();
  await assert.rejects(runExperiments({ ...f.options(1), output: join(f.repository, "unsafe-results") }, env.ports()), /unsafe_output/);
  await assert.rejects(writeExclusiveArtifact(f.repository, f.output, resolve(f.repository, "unsafe.json"), {}), /unsafe_output/);
  const alias = join(f.base, "alias");
  await symlink(f.repository, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(runExperiments({ ...f.options(1), output: join(alias, "unsafe-results") }, env.ports()), /unsafe_output/);
  await writeFile(join(f.fixtures, "move-red.wav"), Buffer.from("modified"));
  await assert.rejects(runExperiments(f.options(1), env.ports()), /fixture_mismatch/);
  assert.equal(env.drivers.length, 0);
});

test("an unreleased reservation halts the run and retains every remaining planned slot", async (t) => {
  const f = await files(t);
  const env = new FakeEnvironment();
  env.releaseReservation = false;
  const result = await runExperiments(f.options(4), env.ports());
  assert.equal(result.report.totals.failed, 1);
  assert.equal(result.report.totals.notRun, 99);
  assert.equal(result.report.rows[0]?.result?.failureCode, "cleanup_unconfirmed");
  assert.equal(env.drivers.length, 1);
  assert.equal(env.active, 1);
  assert.equal(env.maximumActive, 1);
});

test("early closure and observed fast steps are explicit failures, not successful observations", async () => {
  const plan = manifest();
  const slot = slotFor(plan, "normal", "voice-only");
  const early = new FakeEnvironment();
  early.closeEarly = true;
  const first = await executeTrial(plan, slot, startFor(plan, slot), audio(), early.ports());
  assert.equal(first.failureCode, "session_closed_early");
  assert.equal(first.timings.observationMs, null);
  assert.equal(first.actionMetrics?.cancelIntentAccepted, 0);
  const fast = new FakeEnvironment();
  fast.fastSteps = true;
  const second = await executeTrial(plan, slot, startFor(plan, slot), audio(), fast.ports());
  assert.equal(second.failureCode, "step_interval_mismatch");
  assert.equal(second.goalMet, false);
});

test("hanging remote cleanup is bounded and still disposes the local browser", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = new FakeEnvironment();
  env.hangCleanup = true;
  const plan = manifest();
  const slot = slotFor(plan, "normal", "voice-only");
  const pending = executeTrial(plan, slot, startFor(plan, slot), audio(), env.ports());
  await nextTurn();
  assert.equal(env.cleanupEntered, true);
  const budget = RUN_RULES.cleanupReserveMs - 1_000;
  env.clock.time += budget;
  t.mock.timers.tick(budget);
  const result = await pending;
  assert.equal(result.failureCode, "cleanup_unconfirmed");
  assert.equal(result.cleanup.reservationReleased, false);
  assert.equal(env.drivers[0]?.disposed, true);
  assert.ok((result.timings.elapsedMs ?? Infinity) <= RUN_RULES.trialMaxMs);
});

test("token acquisition selects subscription only, requests app scope, checks tid, and keeps errors sanitized", async () => {
  const subscription = "11111111-1111-1111-1111-111111111111";
  const tenant = "22222222-2222-2222-2222-222222222222";
  const authClientId = "33333333-3333-3333-3333-333333333333";
  const token = `header.${Buffer.from(JSON.stringify({ tid: tenant })).toString("base64url")}.PRIVATE_SIGNATURE`;
  let selected = "";
  const credential = (value: string) => {
    selected = value;
    return { getToken: async (scopes: string | string[]) => {
      assert.equal(scopes, `api://${authClientId}/.default`);
      return { token, expiresOnTimestamp: Date.now() + 60_000 };
    } };
  };
  assert.equal(await acquireApiBearer({ subscription, tenant, authClientId }, credential), token);
  assert.equal(selected, subscription);
  await assert.rejects(acquireApiBearer({ subscription, tenant: subscription, authClientId }, credential),
    (error: unknown) => error instanceof ExperimentRunError && error.message === "tenant_mismatch");
  await assert.rejects(acquireApiBearer({ subscription, tenant, authClientId }, () => ({
    getToken: async () => { throw new Error(`SDK error ${token}`); },
  })), (error: unknown) => error instanceof ExperimentRunError && error.message === "auth_failed");
  for (const expiresOnTimestamp of [0, NaN]) {
    await assert.rejects(acquireApiBearer({ subscription, tenant, authClientId }, () => ({
      getToken: async () => ({ token, expiresOnTimestamp }),
    })), /auth_failed/);
  }
});

test("the real CLI cannot acquire credentials or start sessions while the parent PCM contract is absent", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "runner-cli-tests-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const args = [
    "--origin", "https://example.invalid", "--subscription", "11111111-1111-1111-1111-111111111111",
    "--tenant", "22222222-2222-2222-2222-222222222222", "--auth-client-id", "33333333-3333-3333-3333-333333333333",
    "--source-commit", COMMIT, "--image-digest", IMAGE, "--fixtures", join(base, "manifest.json"),
    "--out", join(base, "output"), "--seed", "1", "--formal", "--execute",
  ];
  const messages: string[] = [];
  t.mock.method(console, "error", (value: string) => messages.push(value));
  assert.equal(await runRunnerCli(args, null), 1);
  assert.deepEqual(messages, ["experiment runner failed: pcm_contract_pending"]);
  assert.ok(!(await readdir(base)).includes("output"));
  assert.equal(await runRunnerCli(args, { version: "legacy-heartbeat", remoteActive: async () => true }), 1);
  assert.equal(messages.at(-1), "experiment runner failed: pcm_contract_invalid");
  const output: string[] = [];
  t.mock.method(console, "log", (value: string) => output.push(value));
  assert.equal(await runRunnerCli(args.filter((arg) => arg !== "--execute"), null), 0);
  assert.deepEqual(JSON.parse(output[0] ?? ""), {
    status: "not-executed", plannedSlots: 100, limit: 100, formal: true, pcmContractReady: false,
  });
  assert.equal(await runRunnerCli(args.filter((arg) => arg !== "--execute")), 0);
  assert.equal(JSON.parse(output[1] ?? "").pcmContractReady, true);
  assert.equal(await runRunnerCli([...args, "--limit", "1"]), 1);
  assert.equal(messages.at(-1), "experiment runner failed: invalid_trial_limit");
});

test("the bounded driver creation deadline aborts late acquisition before any session starts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = new FakeEnvironment();
  const plan = manifest();
  const slot = slotFor(plan, "normal", "voice-only");
  const late = new FakeDriver(env, slot);
  let release: ((driver: TrialDriver) => void) | undefined;
  let signal: AbortSignal | undefined;
  const pending = executeTrial(plan, slot, startFor(plan, slot), audio(), {
    ...env.ports(),
    createDriver: async (_slot, _timeout, currentSignal) => {
      signal = currentSignal;
      return new Promise<TrialDriver>((resolve) => { release = resolve; });
    },
  });
  await nextTurn();
  env.clock.time = RUN_RULES.trialMaxMs - RUN_RULES.cleanupReserveMs;
  t.mock.timers.tick(env.clock.time);
  const result = await pending;
  assert.equal(result.failureCode, "trial_timeout");
  assert.ok((result.timings.elapsedMs ?? Infinity) <= 180_000);
  assert.equal(signal?.aborted, true);
  assert.equal(env.active, 0);
  assert.ok(release);
  release(late);
  await nextTurn();
  assert.equal(late.disposed, true);
  assert.equal(late.engine, null);
});

test("snapshot sanitization cannot retain bearer, transcript, SDP or arbitrary service strings", () => {
  const engine = new GameEngine({ mode: "voice-only", runId: "sanitize", now: () => 0 });
  engine.registerDelegation("one");
  const original = engine.snapshot();
  const event = original.events[0];
  assert.ok(event);
  event.details.authorization = "PRIVATE_BEARER";
  event.details.transcript = SYNTHETIC_FIXTURES[0].text;
  event.details.error = "PRIVATE_SDP";
  event.details.reason = "PRIVATE_BEARER";
  const sanitized = JSON.stringify(sanitizeSnapshot(original));
  assert.equal(sanitized.includes("PRIVATE_"), false);
  assert.equal(sanitized.includes(SYNTHETIC_FIXTURES[0].text), false);
});

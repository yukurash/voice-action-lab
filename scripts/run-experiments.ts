import { AzureCliCredential } from "@azure/identity";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Page } from "@playwright/test";
import type { ExperimentBrowser } from "./experiment-browser.ts";
import type { ExperimentMode, GameSnapshot } from "../packages/contracts/index.ts";
import { resolveExternalOutputPath, deriveActionMetrics } from "../packages/experiments/index.ts";
import { analyzeRecordedTrials } from "../packages/experiments/aggregation.ts";
import {
  ExperimentRunError, RUN_RULES, boundaryReady, canonicalJson, createRunManifest, finalUsage,
  interruptedResult, jsonHash, judgeAction, object, pacingEvidence, parseExperimentConfiguration,
  parseFixtureManifest, parseRecordedResult, parseRunManifest, sanitizeSnapshot, sha256,
  sourceCommit, assertManifestCompatible, validateStarted,
} from "../packages/experiments/runner-model.ts";
import type {
  ExperimentConfiguration, FinalUsage, FixtureId, FixtureMetadata, RecordedTrialResult,
  RunManifest, TrialStarted,
} from "../packages/experiments/runner-model.ts";
import type { TrialSlot } from "../packages/experiments/schedule.ts";
import { AUDIO_MEASUREMENT_EVENT, exactKeys, isAudioMeasurementEvent } from "../apps/web/src/audioMeasurement.ts";
import {
  PCM_CONTRACT_VERSION, PCM_RULES, PcmContractError, assertPcmContract, deriveVoiceMetrics,
  freshOutputPcmActive, parsePcmEvidence,
} from "../packages/experiments/pcm.ts";
import type { PcmEvidence, RecordedVoiceMetrics } from "../packages/experiments/pcm.ts";

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const FAILURE_CODES = new Set([
  "trial_timeout", "pcm_condition_unmet", "boundary_condition_unmet", "source_mismatch", "config_mismatch",
  "server_busy", "session_not_live", "session_closed_early", "mode_mismatch", "manual_route_used",
  "snapshot_invalid", "incomplete_event_history", "playback_failed", "cleanup_unconfirmed",
  "driver_failed", "fixture_mismatch", "auth_failed", "tenant_mismatch", "step_interval_mismatch", "pcm_contract_pending",
  "config_not_found", "config_unavailable",
  "pcm_contract_invalid", "pcm_evidence_unavailable", "pcm_measurement_missing", "input_pcm_unconfirmed", "peer_not_ready",
]);

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error: unknown) { if (missing(error)) return false; throw error; }
}

async function removeTemporary(path: string): Promise<void> {
  try { await unlink(path); } catch (error: unknown) { if (!missing(error)) throw error; }
}

async function jsonFile(path: string, maximum = MAX_JSON_BYTES): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw new ExperimentRunError("artifact_too_large");
  try { return JSON.parse(bytes.toString("utf8")); } catch (error: unknown) {
    throw new ExperimentRunError("invalid_artifact", { cause: error });
  }
}

async function guarded(path: string, repository: string): Promise<string> {
  try { return await resolveExternalOutputPath(path, repository); } catch (error: unknown) {
    throw new ExperimentRunError("unsafe_output", { cause: error });
  }
}

/** Same-volume hard-link installation is atomic and fails instead of replacing an existing record. */
export async function writeExclusiveArtifact(repository: string, output: string, filename: string, payload: unknown): Promise<void> {
  const target = await guarded(resolve(output, filename), repository);
  const temporaryDirectory = await guarded(resolve(output, ".tmp"), repository);
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  await mkdir(await guarded(dirname(target), repository), { recursive: true, mode: 0o700 });
  const temporary = await guarded(resolve(temporaryDirectory, `${randomUUID()}.json`), repository);
  const contents = canonicalJson({ schemaVersion: 1, sha256: jsonHash(payload), payload });
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await link(temporary, await guarded(target, repository));
  } finally {
    await removeTemporary(temporary);
  }
}

async function readArtifact(repository: string, path: string, maximum = MAX_JSON_BYTES): Promise<unknown> {
  const envelope = object(await jsonFile(await guarded(path, repository), maximum));
  if (envelope.schemaVersion !== 1 || envelope.sha256 !== jsonHash(envelope.payload)) {
    throw new ExperimentRunError("artifact_hash_mismatch");
  }
  return envelope.payload;
}

export interface RunStore {
  readonly output: string;
  manifest(): Promise<RunManifest>;
  initialize(expected: RunManifest, resume: boolean): Promise<RunManifest>;
  records(manifest: RunManifest): Promise<{ starts: TrialStarted[]; results: RecordedTrialResult[] }>;
  start(manifest: RunManifest, slot: TrialSlot, value: TrialStarted): Promise<void>;
  result(manifest: RunManifest, slot: TrialSlot, value: RecordedTrialResult): Promise<void>;
  evidence(manifest: RunManifest, slot: TrialSlot, start: TrialStarted, value: PcmEvidence): Promise<void>;
  report(payload: unknown): Promise<string>;
  close(): Promise<void>;
}

/**
 * A surviving lock is never automatically stolen. After a process crash the parent
 * must confirm that process is dead and the service idle before removing its lock.
 */
export async function openRunStore(repositoryRoot: string, directory: string): Promise<RunStore> {
  const output = await guarded(directory, repositoryRoot);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const lockPath = await guarded(resolve(output, ".runner.lock"), repositoryRoot);
  const nonce = randomUUID();
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new ExperimentRunError("runner_locked", { cause: error });
    }
    throw error;
  }
  try {
    await lock.writeFile(canonicalJson({ nonce, pid: process.pid }));
    await lock.sync();
  } finally { await lock.close(); }
  let closed = false;
  const slotPath = (slot: TrialSlot, suffix: string) => `slots/${String(slot.ordinal).padStart(3, "0")}.${suffix}.json`;
  const evidencePath = (slot: TrialSlot) => `evidence/${String(slot.ordinal).padStart(3, "0")}.pcm.json`;
  const verifyEvidence = async (manifest: RunManifest, slot: TrialSlot, result: RecordedTrialResult) => {
    if (result.voiceMetrics === null) return;
    const payload = object(await readArtifact(repositoryRoot, resolve(output, evidencePath(slot)), 16 * 1024 * 1024));
    if (!exactKeys(payload, ["start", "evidence"])) throw new ExperimentRunError("invalid_artifact");
    const start = validateStarted(payload.start, manifest, slot);
    const evidence = parsePcmEvidence(payload.evidence);
    if (canonicalJson(payload.start) !== canonicalJson(start) || start.attemptId !== result.attemptId || start.startedAt !== result.startedAt
      || jsonHash(evidence) !== result.voiceMetrics.evidenceSha256
      || canonicalJson(deriveVoiceMetrics(evidence, `${slot.slotId}-initial`, slot.scenarioId === "normal" ? null : `${slot.slotId}-second`))
        !== canonicalJson(result.voiceMetrics.data)) throw new ExperimentRunError("invalid_artifact");
  };
  const loadManifest = async () => parseRunManifest(await readArtifact(repositoryRoot, resolve(output, "manifest.json")));
  return {
    output,
    manifest: loadManifest,
    async initialize(expected, resume) {
      const path = resolve(output, "manifest.json");
      if (await exists(path)) {
        if (!resume) throw new ExperimentRunError("run_already_exists");
        const current = await loadManifest();
        assertManifestCompatible(current, expected);
        return current;
      }
      if (resume) throw new ExperimentRunError("resume_manifest_missing");
      if ((await readdir(output)).some((entry) => entry !== ".runner.lock")) throw new ExperimentRunError("output_not_empty");
      await writeExclusiveArtifact(repositoryRoot, output, "manifest.json", expected);
      return expected;
    },
    async records(manifest) {
      const directory = await guarded(resolve(output, "slots"), repositoryRoot);
      if (!await exists(directory)) return { starts: [], results: [] };
      const starts: TrialStarted[] = [];
      const results: RecordedTrialResult[] = [];
      for (const name of (await readdir(directory)).sort()) {
        const match = /^(\d{3})\.(started|result)\.json$/u.exec(name);
        const ordinal = Number(match?.[1]);
        const slot = manifest.schedule.slots[ordinal - 1];
        if (!match || !slot || ordinal > manifest.execution.limit) throw new ExperimentRunError("invalid_artifact");
        const payload = await readArtifact(repositoryRoot, resolve(directory, name));
        if (match[2] === "started") starts.push(validateStarted(payload, manifest, slot));
        else results.push(parseRecordedResult(payload, manifest, slot));
      }
      for (const result of results) {
        const start = starts.find((entry) => entry.slotId === result.slotId);
        if (!start || start.attemptId !== result.attemptId || start.startedAt !== result.startedAt) {
          throw new ExperimentRunError("invalid_artifact");
        }
        const slot = manifest.schedule.slots.find((slot) => slot.slotId === result.slotId);
        if (!slot) throw new ExperimentRunError("invalid_artifact");
        await verifyEvidence(manifest, slot, result);
      }
      return { starts, results };
    },
    async start(manifest, slot, value) {
      if (slot.ordinal > manifest.execution.limit) throw new ExperimentRunError("invalid_trial_limit");
      await writeExclusiveArtifact(repositoryRoot, output, slotPath(slot, "started"), validateStarted(value, manifest, slot));
    },
    async result(manifest, slot, value) {
      const start = validateStarted(await readArtifact(repositoryRoot, resolve(output, slotPath(slot, "started"))), manifest, slot);
      if (value.attemptId !== start.attemptId || value.startedAt !== start.startedAt) throw new ExperimentRunError("invalid_artifact");
      await verifyEvidence(manifest, slot, value);
      await writeExclusiveArtifact(repositoryRoot, output, slotPath(slot, "result"), parseRecordedResult(value, manifest, slot));
    },
    async evidence(manifest, slot, start, value) {
      await writeExclusiveArtifact(repositoryRoot, output, evidencePath(slot),
        { start: validateStarted(start, manifest, slot), evidence: parsePcmEvidence(value) });
    },
    async report(payload) {
      const filename = `reports/${randomUUID()}.json`;
      await writeExclusiveArtifact(repositoryRoot, output, filename, payload);
      return filename;
    },
    async close() {
      if (closed) return;
      const stored = object(await jsonFile(await guarded(lockPath, repositoryRoot)));
      if (stored.nonce !== nonce) throw new ExperimentRunError("runner_lock_changed");
      await unlink(lockPath);
      closed = true;
    },
  };
}

export async function recoverInterruptedSlots(store: RunStore, manifest: RunManifest, recoveredAt: string): Promise<RecordedTrialResult[]> {
  const records = await store.records(manifest);
  const results = [...records.results];
  for (const start of records.starts) {
    if (results.some((result) => result.slotId === start.slotId)) continue;
    const slot = manifest.schedule.slots.find((entry) => entry.slotId === start.slotId);
    if (!slot) throw new ExperimentRunError("invalid_artifact");
    const result = interruptedResult(start, recoveredAt);
    await store.result(manifest, slot, result);
    results.push(result);
  }
  return results;
}

export interface FixtureAudio { metadata: FixtureMetadata; base64: string }
export interface LocalInputs {
  sourceFiles: Record<string, string>;
  fixtureManifestSha256: string;
  fixtures: FixtureAudio[];
}

export async function loadLocalInputs(repository: string, fixtureManifestPath: string): Promise<LocalInputs> {
  const privateManifestPath = await guarded(fixtureManifestPath, repository);
  const manifestBytes = await readFile(privateManifestPath);
  if (manifestBytes.length > MAX_JSON_BYTES) throw new ExperimentRunError("fixture_manifest_mismatch");
  let value: unknown;
  try { value = JSON.parse(manifestBytes.toString("utf8")); } catch (error: unknown) {
    throw new ExperimentRunError("fixture_manifest_mismatch", { cause: error });
  }
  const metadata = parseFixtureManifest(value);
  const fixtures: FixtureAudio[] = [];
  const fixtureRoot = await realpath(dirname(privateManifestPath));
  for (const entry of metadata) {
    const path = await realpath(resolve(fixtureRoot, entry.file));
    if (dirname(path) !== fixtureRoot) throw new ExperimentRunError("fixture_mismatch");
    const bytes = await readFile(path);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256
      || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
      throw new ExperimentRunError("fixture_mismatch");
    }
    fixtures.push({ metadata: entry, base64: bytes.toString("base64") });
  }
  const root = await realpath(repository);
  const sourceFiles: Record<string, string> = {};
  const add = async (path: string) => {
    const physical = await realpath(path);
    const within = relative(root, physical);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new ExperimentRunError("source_path_escape");
    sourceFiles[relative(root, path).split(sep).join("/")] = sha256(await readFile(physical));
  };
  const walk = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (["node_modules", "dist", "coverage"].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new ExperimentRunError("source_path_escape");
      if (entry.isDirectory()) await walk(resolve(path, entry.name));
      else if (/\.tsx?$/u.test(entry.name)) await add(resolve(path, entry.name));
    }
  };
  for (const path of ["scripts", "packages", "apps/server", "apps/web/src"]) await walk(resolve(root, path));
  for (const path of ["tests/synthetic-scenarios.ts", "package.json", "package-lock.json", "tsconfig.json"]) await add(resolve(root, path));
  return { sourceFiles, fixtureManifestSha256: sha256(manifestBytes), fixtures };
}

export interface RunnerClock {
  now(): number;
  utc(): string;
  sleep(milliseconds: number): Promise<void>;
}
export interface TrialDriver {
  /** Fresh, repeatable metadata read; must not navigate away from an active session. */
  inspect(timeoutMs: number): Promise<unknown>;
  assertIdle(timeoutMs: number): Promise<void>;
  start(mode: ExperimentMode, timeoutMs: number): Promise<void>;
  play(fixture: FixtureAudio, id: string, timeoutMs: number): Promise<void>;
  remoteActive(timeoutMs: number): Promise<boolean>;
  snapshot(timeoutMs: number): Promise<GameSnapshot>;
  voiceEvidence?(timeoutMs: number): Promise<PcmEvidence | null>;
  cleanup(timeoutMs: number): Promise<{ reservationReleased: boolean; usage: FinalUsage }>;
  dispose(timeoutMs: number): Promise<void>;
}
export interface RunnerPorts {
  pcmContractVersion: string;
  configuration: ExperimentConfiguration;
  /** May allocate a browser, never a model session. Only TrialDriver.start may reserve a session. */
  createDriver(slot: TrialSlot, timeoutMs: number, signal: AbortSignal): Promise<TrialDriver>;
  clock?: RunnerClock;
}
export interface ExperimentRunOptions {
  repository: string;
  output: string;
  fixtureManifest: string;
  seed: number;
  formal: boolean;
  limit: number;
  resume: boolean;
  sourceCommit: string;
  imageDigest: string;
}

const wallClock: RunnerClock = {
  now: () => performance.now(),
  utc: () => new Date().toISOString(),
  sleep: async (milliseconds) => { await sleep(milliseconds); },
};

async function bounded<T>(
  clock: RunnerClock, deadline: number, operation: (remaining: number) => Promise<T>, onTimeout?: () => void,
): Promise<T> {
  const remaining = deadline - clock.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new ExperimentRunError("trial_timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation(remaining),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { onTimeout?.(); reject(new ExperimentRunError("trial_timeout")); }, Math.ceil(remaining));
      }),
    ]);
    if (clock.now() > deadline) { onTimeout?.(); throw new ExperimentRunError("trial_timeout"); }
    return result;
  } finally { if (timer) clearTimeout(timer); }
}

/** Effects are injected for offline tests. Production must supply the parent-approved PCM adapter. */
export async function executeTrial(
  manifest: RunManifest, slot: TrialSlot, start: TrialStarted, fixtures: readonly FixtureAudio[], ports: RunnerPorts,
  retainEvidence?: (evidence: PcmEvidence) => void,
): Promise<RecordedTrialResult> {
  const clock = ports.clock ?? wallClock;
  const began = clock.now();
  const deadline = began + RUN_RULES.trialMaxMs;
  const workDeadline = deadline - RUN_RULES.cleanupReserveMs;
  const controller = new AbortController();
  let driver: TrialDriver | undefined;
  let snapshot: GameSnapshot | null = null;
  let runId: string | null = null;
  let failureCode: string | null = null;
  let voiceMetrics: RecordedVoiceMetrics | null = null;
  let conditionMet: boolean | null = slot.scenarioId === "normal" ? true : null;
  const timings: RecordedTrialResult["timings"] = {
    elapsedMs: null, snapshotAtMs: null, initialEndMs: null, secondEndMs: null, observationMs: null, observationActualMs: null, cleanupMs: null,
  };
  let cleanup: RecordedTrialResult["cleanup"] = {
    reservationReleased: false, usage: { scope: "voice-session-only", status: "unconfirmed", metrics: null },
  };
  const getFixture = (id: FixtureId) => {
    const fixture = fixtures.find((entry) => entry.metadata.id === id);
    if (!fixture) throw new ExperimentRunError("fixture_mismatch");
    return fixture;
  };
  const recordSnapshot = (value: unknown) => {
    const current = sanitizeSnapshot(value);
    if (current.mode !== slot.mode) throw new ExperimentRunError("mode_mismatch");
    if (runId !== null && current.runId !== runId) throw new ExperimentRunError("session_not_live");
    runId = current.runId;
    snapshot = current;
    timings.snapshotAtMs = clock.now() - began;
    return current;
  };
  const capture = async () => {
    if (!driver) throw new ExperimentRunError("driver_failed");
    const currentDriver = driver;
    const current = recordSnapshot(await bounded(clock, workDeadline, (ms) => currentDriver.snapshot(ms)));
    if (current.stopped) throw new ExperimentRunError("session_closed_early");
    return current;
  };
  const verifyConfiguration = async (currentDriver: TrialDriver) => {
    const configuration = parseExperimentConfiguration(
      await bounded(clock, workDeadline, (ms) => currentDriver.inspect(ms)), manifest.sourceCommit);
    if (jsonHash(configuration) !== manifest.configurationSha256) throw new ExperimentRunError("config_mismatch");
  };
  try {
    const currentDriver = await bounded(clock, workDeadline, async (ms) => {
      const acquired = await ports.createDriver(slot, ms, controller.signal);
      if (controller.signal.aborted) {
        await acquired.dispose(RUN_RULES.cleanupReserveMs);
        throw new ExperimentRunError("trial_timeout");
      }
      driver = acquired;
      return acquired;
    }, () => controller.abort());
    await verifyConfiguration(currentDriver);
    await bounded(clock, workDeadline, (ms) => currentDriver.assertIdle(ms));
    await bounded(clock, workDeadline, (ms) => currentDriver.start(slot.mode, ms));
    await capture();
    await verifyConfiguration(currentDriver);
    await bounded(clock, workDeadline, (ms) => currentDriver.play(getFixture("move-red"), `${slot.slotId}-initial`, ms));
    timings.initialEndMs = clock.now() - began;
    let referenceEnd = clock.now();
    if (slot.scenarioId !== "normal") {
      const conditionDeadline = slot.scenarioId === "boundary" ? workDeadline : Math.min(workDeadline, referenceEnd + RUN_RULES.remoteActiveWaitMs);
      for (;;) {
        if (clock.now() >= conditionDeadline) {
          conditionMet = false;
          throw new ExperimentRunError(slot.scenarioId === "boundary" ? "boundary_condition_unmet" : "pcm_condition_unmet");
        }
        const current = await capture();
        if (slot.scenarioId === "boundary" && current.cargo.red === 6 && !boundaryReady(current)) {
          conditionMet = false;
          throw new ExperimentRunError("boundary_condition_unmet");
        }
        let met = slot.scenarioId === "boundary" && boundaryReady(current);
        if (slot.scenarioId !== "boundary") {
          try { met = await bounded(clock, conditionDeadline, (ms) => currentDriver.remoteActive(ms)); } catch (error: unknown) {
            if (error instanceof ExperimentRunError && error.code === "trial_timeout" && conditionDeadline < workDeadline) {
              conditionMet = false;
              throw new ExperimentRunError("pcm_condition_unmet", { cause: error });
            }
            throw error;
          }
        }
        if (met) { conditionMet = true; break; }
        const remaining = conditionDeadline - clock.now();
        if (remaining <= 0) {
          conditionMet = false;
          throw new ExperimentRunError(slot.scenarioId === "boundary" ? "boundary_condition_unmet" : "pcm_condition_unmet");
        }
        await clock.sleep(Math.min(RUN_RULES.pollMs, remaining));
      }
      const second: FixtureId = slot.scenarioId === "boundary" ? "brief-cancel"
        : slot.scenarioId === "replace-blue" ? "replace-blue"
          : slot.scenarioId === "backchannel" ? "backchannel" : "cancel";
      await bounded(clock, workDeadline, (ms) => currentDriver.play(getFixture(second), `${slot.slotId}-second`, ms));
      timings.secondEndMs = clock.now() - began;
      referenceEnd = clock.now();
    }
    const observationEnd = referenceEnd + RUN_RULES.observationMs;
    if (observationEnd > workDeadline) throw new ExperimentRunError("trial_timeout");
    while (clock.now() < observationEnd) {
      await capture();
      const remaining = observationEnd - clock.now();
      if (remaining > 0) await clock.sleep(Math.min(RUN_RULES.pollMs, remaining));
    }
    await capture();
    timings.observationMs = RUN_RULES.observationMs;
    timings.observationActualMs = clock.now() - referenceEnd;
    if (snapshot && pacingEvidence(snapshot).violations > 0) throw new ExperimentRunError("step_interval_mismatch");
  } catch (error: unknown) {
    failureCode = error instanceof PcmContractError ? "pcm_contract_invalid"
      : error instanceof ExperimentRunError && FAILURE_CODES.has(error.code) ? error.code : "driver_failed";
    if (failureCode === "pcm_condition_unmet" || failureCode === "boundary_condition_unmet") conditionMet = false;
  } finally {
    controller.abort();
    // On failure retain the freshest obtainable pre-cleanup evidence, with its actual capture time.
    if (driver && failureCode !== null && runId !== null && clock.now() < workDeadline) {
      const currentDriver = driver;
      try {
        recordSnapshot(await bounded(clock, Math.min(workDeadline, clock.now() + 1_000),
          (ms) => currentDriver.snapshot(ms)));
      } catch (error: unknown) {
        // Failed refreshes are missing evidence, never misleading zero-valued action measurements.
        snapshot = null;
        timings.snapshotAtMs = null;
        failureCode = error instanceof ExperimentRunError && FAILURE_CODES.has(error.code) ? error.code : "snapshot_invalid";
      }
    }
    if (driver?.voiceEvidence && clock.now() < deadline - 10_000) {
      const readEvidence = driver.voiceEvidence.bind(driver);
      try {
        const captured = await bounded(clock, Math.min(deadline - 10_000, clock.now() + 1_000), readEvidence);
        if (captured !== null) {
          const evidence = parsePcmEvidence(captured);
          voiceMetrics = {
            evidenceSha256: jsonHash(evidence),
            data: deriveVoiceMetrics(evidence, `${slot.slotId}-initial`, slot.scenarioId === "normal" ? null : `${slot.slotId}-second`),
          };
          retainEvidence?.(evidence);
          const data = voiceMetrics.data;
          if (data.missingReason === "invalid_event") failureCode ??= "pcm_contract_invalid";
          if (data.missingReason === "measurement_missing") failureCode ??= "pcm_measurement_missing";
          for (const clip of [data.clips.initial, data.clips.interruption]) {
            if (!clip) continue;
            if (clip.inputStartContextTime === null) failureCode ??= "input_pcm_unconfirmed";
            const peer = clip.peerAtPlayback;
            if (!peer || peer.connectionState !== "connected" || peer.trackEnabled !== true || peer.trackReadyState !== "live") {
              failureCode ??= "peer_not_ready";
            }
          }
        }
      } catch (error: unknown) {
        if (error instanceof PcmContractError) failureCode = "pcm_contract_invalid";
        else failureCode ??= "pcm_evidence_unavailable";
      }
    }
    if (manifest.pcmContractVersion === PCM_CONTRACT_VERSION && voiceMetrics === null) failureCode ??= "pcm_evidence_unavailable";
    const cleanupStarted = clock.now();
    if (driver) {
      const currentDriver = driver;
      // Reserve time for local browser disposal even when remote cleanup never acknowledges.
      const cleanupDeadline = Math.min(deadline - 1_000, cleanupStarted + RUN_RULES.cleanupReserveMs - 1_000);
      try { cleanup = await bounded(clock, cleanupDeadline, (ms) => currentDriver.cleanup(ms)); } catch {
        failureCode ??= "cleanup_unconfirmed";
      }
      try { await bounded(clock, deadline, (ms) => currentDriver.dispose(ms)); } catch {
        cleanup.reservationReleased = false;
        failureCode ??= "cleanup_unconfirmed";
      }
    }
    timings.cleanupMs = clock.now() - cleanupStarted;
    timings.elapsedMs = clock.now() - began;
    if (timings.elapsedMs > RUN_RULES.trialMaxMs) failureCode ??= "trial_timeout";
  }
  if (!cleanup.reservationReleased || cleanup.usage.status !== "confirmed") failureCode ??= "cleanup_unconfirmed";
  const metrics = snapshot ? deriveActionMetrics(snapshot) : null;
  return {
    ...start, status: failureCode === null ? "completed" : "failed", failureCode,
    finishedAt: clock.utc(), recoveredAt: null, preCleanupSnapshot: snapshot, actionMetrics: metrics,
    conditionMet, timings, cleanup, voiceMetrics,
    goalMet: snapshot && metrics && conditionMet === true && timings.observationMs === RUN_RULES.observationMs
      ? judgeAction(slot.scenarioId, snapshot, metrics) : null,
  };
}

export async function runExperiments(options: ExperimentRunOptions, ports: RunnerPorts) {
  const clock = ports.clock ?? wallClock;
  await guarded(options.output, options.repository);
  if (!ports.pcmContractVersion) throw new ExperimentRunError("pcm_contract_pending");
  const inputs = await loadLocalInputs(options.repository, options.fixtureManifest);
  const expected = createRunManifest({
    createdAt: clock.utc(), seed: options.seed, formal: options.formal, limit: options.limit,
    sourceCommit: options.sourceCommit, sourceFiles: inputs.sourceFiles, imageDigest: options.imageDigest,
    configuration: ports.configuration, fixtureManifestSha256: inputs.fixtureManifestSha256,
    fixtures: inputs.fixtures.map((entry) => entry.metadata), pcmContractVersion: ports.pcmContractVersion,
  });
  const store = await openRunStore(options.repository, options.output);
  try {
    const manifest = await store.initialize(expected, options.resume);
    const results = await recoverInterruptedSlots(store, manifest, clock.utc());
    for (const slot of manifest.schedule.slots.slice(0, manifest.execution.limit)) {
      if (results.some((entry) => entry.slotId === slot.slotId)) continue;
      const start: TrialStarted = {
        schemaVersion: 1, manifestSha256: jsonHash(manifest), slotId: slot.slotId,
        attemptId: randomUUID(), startedAt: clock.utc(),
      };
      await store.start(manifest, slot, start);
      let evidence: PcmEvidence | undefined;
      const result = await executeTrial(manifest, slot, start, inputs.fixtures, ports, (value) => { evidence = value; });
      if (evidence) await store.evidence(manifest, slot, start, evidence);
      await store.result(manifest, slot, result);
      results.push(result);
      if (!result.cleanup.reservationReleased || [
        "source_mismatch", "config_mismatch", "config_not_found", "config_unavailable", "step_interval_mismatch", "server_busy",
        "pcm_contract_invalid", "pcm_evidence_unavailable", "pcm_measurement_missing",
      ].includes(result.failureCode ?? "")
        || ["invalid_event", "measurement_missing"].includes(result.voiceMetrics?.data.missingReason ?? "")) break;
    }
    const report = analyzeRecordedTrials(manifest, results);
    const reportFile = await store.report(report);
    return { report, reportFile };
  } finally { await store.close(); }
}

export interface AuthenticationOptions { subscription: string; tenant: string; authClientId: string }

/** Startup and per-trial reads use the same owner-only endpoint, without redirects, caching or fallbacks. */
export async function fetchExperimentConfiguration(
  origin: string, bearer: string, timeoutMs = 30_000,
): Promise<unknown> {
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password || url.protocol !== "https:"
    && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new ExperimentRunError("invalid_origin");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ExperimentRunError("config_unavailable");
  let response: Response;
  try {
    response = await fetch(`${origin}/api/experiment-config`, {
      method: "GET", headers: { Authorization: `Bearer ${bearer}`, Origin: origin, "Cache-Control": "no-cache" },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(Math.ceil(Math.min(timeoutMs, 30_000))),
    });
  } catch (error: unknown) {
    throw new ExperimentRunError("config_unavailable", { cause: error });
  }
  if (response.status === 404) throw new ExperimentRunError("config_not_found");
  if (response.status !== 200) throw new ExperimentRunError("config_unavailable");
  try {
    const value: unknown = await response.json();
    return value;
  } catch (error: unknown) {
    throw new ExperimentRunError("config_mismatch", { cause: error });
  }
}

export async function acquireApiBearer(
  options: AuthenticationOptions,
  createCredential: (subscription: string) => Pick<AzureCliCredential, "getToken"> = (subscription) => new AzureCliCredential({ subscription }),
  signal?: AbortSignal,
) {
  try {
    const token = await createCredential(options.subscription).getToken(`api://${options.authClientId}/.default`,
      signal ? { abortSignal: signal } : {});
    const claims: unknown = JSON.parse(Buffer.from(token.token.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || !("tid" in claims)
      || typeof claims.tid !== "string" || claims.tid.toLowerCase() !== options.tenant.toLowerCase()) {
      throw new ExperimentRunError("tenant_mismatch");
    }
    if (!Number.isFinite(token.expiresOnTimestamp) || token.expiresOnTimestamp <= Date.now()) throw new ExperimentRunError("auth_failed");
    return token.token;
  } catch (error: unknown) {
    if (error instanceof ExperimentRunError) throw error;
    throw new ExperimentRunError("auth_failed", { cause: error });
  }
}

export interface PcmActivityAdapter {
  readonly version: string;
  remoteActive(page: Page): Promise<boolean>;
  collect?(page: Page): Promise<PcmEvidence>;
}

/** Incremental reads of the existing helper's data-only event log; never accesses waveform, SDP or transcript text. */
export function createPcmActivityAdapter(): PcmActivityAdapter {
  assertPcmContract();
  if (AUDIO_MEASUREMENT_EVENT !== "voice-action-lab:audio-measurement") throw new PcmContractError();
  const pages = new WeakMap<Page, { offset: number; evidence: PcmEvidence }>();
  const collect = async (page: Page): Promise<PcmEvidence> => {
    let current = pages.get(page);
    if (!current) {
      current = { offset: 0, evidence: {
        version: 1, capturedAtPerformanceMs: 0, events: [], playbacks: [], peers: [],
        receivedMeasurementEvents: 0, invalidMeasurementEvents: 0, collectionGaps: 0, helperErrorCount: 0, transcriptEventCount: 0,
      } };
      pages.set(page, current);
    }
    const batch = await page.evaluate((offset) => {
      const probe = window.__voiceActionExperiment;
      const capture = probe?.capture;
      const performanceNowMs = performance.now();
      return {
        total: probe?.measurements.length ?? 0,
        events: probe?.measurements.slice(offset) ?? [],
        performanceNowMs,
        playbacks: probe?.playbacks.map((marker) => ({
          id: marker.id, performanceStartMs: marker.performanceTimeMs, durationMs: marker.durationSeconds * 1000,
          completed: typeof marker.endedAt === "number" && Number.isFinite(marker.endedAt),
        })) ?? [],
        peer: {
          performanceNowMs, connectionState: capture?.peer?.connectionState ?? null,
          trackEnabled: capture?.track.enabled ?? null, trackReadyState: capture?.track.readyState ?? null,
        },
        helperErrorCount: probe?.errors.length ?? 0,
        transcriptEventCount: probe?.transcripts.length ?? 0,
        capacityExceeded: probe?.errors.includes("measurement_capacity_exceeded") ?? false,
      };
    }, current.offset);
    const evidence = current.evidence;
    if (batch.total < current.offset || batch.events.length !== batch.total - current.offset || batch.capacityExceeded) {
      evidence.collectionGaps += 1;
    }
    current.offset = batch.total;
    evidence.capturedAtPerformanceMs = batch.performanceNowMs;
    for (const event of batch.events) {
      evidence.receivedMeasurementEvents += 1;
      if (isAudioMeasurementEvent(event) && evidence.events.length < PCM_RULES.maxEvents) evidence.events.push(event);
      else evidence.invalidMeasurementEvents += 1;
    }
    if (evidence.peers.length < PCM_RULES.maxPeerObservations) evidence.peers.push(batch.peer);
    else evidence.collectionGaps += 1;
    for (const marker of batch.playbacks) {
      let stored = evidence.playbacks.find((entry) => entry.id === marker.id);
      if (!stored) {
        if (evidence.playbacks.length >= 2) throw new PcmContractError();
        stored = { id: marker.id, performanceStartMs: marker.performanceStartMs, durationMs: marker.durationMs, endedObservedPerformanceMs: null };
        evidence.playbacks.push(stored);
      } else if (stored.performanceStartMs !== marker.performanceStartMs || stored.durationMs !== marker.durationMs) {
        throw new PcmContractError();
      }
      if (marker.completed && stored.endedObservedPerformanceMs === null) stored.endedObservedPerformanceMs = batch.performanceNowMs;
    }
    evidence.helperErrorCount = batch.helperErrorCount;
    evidence.transcriptEventCount = batch.transcriptEventCount;
    return evidence;
  };
  return {
    version: PCM_CONTRACT_VERSION, collect,
    async remoteActive(page) { return freshOutputPcmActive(await collect(page)); },
  };
}

export async function createBrowserDriver(origin: string, bearer: string, pcm: PcmActivityAdapter, signal?: AbortSignal): Promise<TrialDriver> {
  if (signal?.aborted) throw new ExperimentRunError("trial_timeout");
  const helpers = await import("./experiment-browser.ts");
  const browser: ExperimentBrowser = await helpers.openExperimentBrowser(origin, bearer);
  if (signal?.aborted) {
    await helpers.disposeExperimentBrowser(browser);
    throw new ExperimentRunError("trial_timeout");
  }
  let ownedRunId: string | null = null;
  let creationAttempted = false;
  let pageLoaded = false;
  let latestEvidence: PcmEvidence | null = null;
  const collectPcm = async () => {
    if (pcm.collect) latestEvidence = await pcm.collect(browser.page);
  };
  const state = async () => {
    if (browser.routes.some((path) => path === "/api/command" || path.startsWith("/api/simulation/"))) {
      throw new ExperimentRunError("manual_route_used");
    }
    return helpers.readExperimentState(browser.page);
  };
  const poll = async (check: () => Promise<boolean>, timeoutMs: number) => {
    const end = performance.now() + timeoutMs;
    while (!await check()) {
      const remaining = end - performance.now();
      if (remaining <= 0) throw new ExperimentRunError("trial_timeout");
      await sleep(Math.min(100, remaining));
    }
  };
  return {
    async inspect(timeoutMs) {
      const configuration = await fetchExperimentConfiguration(origin, bearer, timeoutMs);
      if (!pageLoaded) {
        await browser.page.goto(origin, { timeout: timeoutMs });
        pageLoaded = true;
      }
      return configuration;
    },
    async assertIdle() {
      const current = await state();
      if (current.session.transport !== "disconnected" && current.session.transport !== "error") {
        throw new ExperimentRunError("server_busy");
      }
    },
    async start(mode, timeoutMs) {
      browser.page.setDefaultTimeout(timeoutMs);
      await browser.page.getByRole("radio", { name: mode === "voice-only" ? /^A\b/u : /^B\b/u }).check();
      const response = browser.page.waitForResponse((response) => response.url() === `${origin}/api/session`
        && response.request().method() === "POST", { timeout: timeoutMs });
      creationAttempted = true;
      const [created] = await Promise.all([response,
        browser.page.getByRole("button", { name: "実音声に接続", exact: true }).click()]);
      if (created.status() !== 200) throw new ExperimentRunError("session_not_live");
      ownedRunId = (await state()).game.runId;
      await poll(async () => {
        const current = await state();
        if (current.game.runId !== ownedRunId || current.game.mode !== mode) throw new ExperimentRunError("mode_mismatch");
        if (current.session.transport === "error" || current.game.stopped) throw new ExperimentRunError("session_closed_early");
        return current.session.transport === "connected" && current.session.source === "live"
          && await browser.page.evaluate(() => window.__voiceActionExperiment?.capture?.track.enabled === true
            && window.__voiceActionExperiment.capture.peer?.connectionState === "connected");
      }, timeoutMs);
    },
    async play(fixture, id, timeoutMs) {
      await collectPcm();
      await helpers.playFixture(browser.page, id, fixture.base64);
      await collectPcm();
      await browser.page.waitForFunction((id) => window.__voiceActionExperiment?.playbacks.some(
        (marker) => marker.id === id && marker.endedAt !== undefined,
      ), id, { timeout: timeoutMs, polling: RUN_RULES.pollMs });
      await collectPcm();
    },
    async remoteActive() {
      const value = await pcm.remoteActive(browser.page);
      if (typeof value !== "boolean") throw new ExperimentRunError("pcm_contract_pending");
      return value;
    },
    async snapshot() {
      const current = await state();
      if (current.session.source !== "live" || ownedRunId === null || current.game.runId !== ownedRunId) {
        throw new ExperimentRunError("session_not_live");
      }
      await collectPcm();
      return current.game;
    },
    async voiceEvidence() { return latestEvidence === null ? null : parsePcmEvidence(latestEvidence); },
    async cleanup(timeoutMs) {
      if (!creationAttempted) return { reservationReleased: true, usage: { scope: "voice-session-only", status: "unconfirmed", metrics: null } };
      if (!ownedRunId) return { reservationReleased: false, usage: { scope: "voice-session-only", status: "unconfirmed", metrics: null } };
      let current = await state();
      if (current.game.runId !== ownedRunId) throw new ExperimentRunError("cleanup_unconfirmed");
      if (!current.game.stopped) {
        await browser.page.getByRole("button", { name: "停止して切断", exact: true }).click({ timeout: timeoutMs });
      }
      await poll(async () => {
        current = await state();
        return current.game.runId === ownedRunId && current.game.stopped
          && (current.session.transport === "disconnected" || current.session.transport === "error")
          && await browser.page.getByRole("button", { name: "実音声に接続", exact: true }).isEnabled();
      }, timeoutMs);
      return { reservationReleased: true, usage: finalUsage(sanitizeSnapshot(current.game)) };
    },
    async dispose() { await helpers.disposeExperimentBrowser(browser); },
  };
}

export async function findExperimentRepository(): Promise<string> {
  let path = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (await exists(resolve(path, "scripts/experiment-browser.ts")) && await exists(resolve(path, "tests/synthetic-scenarios.ts"))) {
      const packageJson = object(await jsonFile(resolve(path, "package.json")));
      if (packageJson.name === "voice-action-lab") return realpath(path);
    }
    const parent = dirname(path);
    if (path === parent) throw new ExperimentRunError("repository_not_found");
    path = parent;
  }
}

export async function runRunnerCli(argv: readonly string[], pcm?: PcmActivityAdapter | null): Promise<number> {
  try {
    const adapter = pcm === undefined ? createPcmActivityAdapter() : pcm;
    const { values } = parseArgs({
      args: [...argv], strict: true, allowPositionals: false,
      options: {
        origin: { type: "string" }, subscription: { type: "string" }, tenant: { type: "string" },
        "auth-client-id": { type: "string" }, "source-commit": { type: "string" }, "image-digest": { type: "string" },
        fixtures: { type: "string" }, out: { type: "string" }, seed: { type: "string" }, limit: { type: "string" },
        formal: { type: "boolean", default: false }, execute: { type: "boolean", default: false }, resume: { type: "boolean", default: false },
      },
    });
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
    if (!values.origin || !values.subscription || !uuid.test(values.subscription) || !values.tenant || !uuid.test(values.tenant)
      || !values["auth-client-id"] || !uuid.test(values["auth-client-id"]) || !values.fixtures || !isAbsolute(values.fixtures)
      || !values.out || !isAbsolute(values.out) || !values.seed || !/^\d+$/u.test(values.seed)
      || !values["source-commit"] || !values["image-digest"]
      || !values.formal && values.limit === undefined) throw new ExperimentRunError("invalid_arguments");
    const origin = new URL(values.origin);
    if (origin.protocol !== "https:" || origin.origin !== values.origin || origin.username || origin.password) {
      throw new ExperimentRunError("invalid_origin");
    }
    const limit = values.limit === undefined ? 100 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || values.formal && limit !== 100) {
      throw new ExperimentRunError("invalid_trial_limit");
    }
    const commit = sourceCommit(values["source-commit"]);
    const seed = Number(values.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff || !/^sha256:[a-f0-9]{64}$/iu.test(values["image-digest"])) {
      throw new ExperimentRunError("invalid_arguments");
    }
    const repository = await findExperimentRepository();
    const output = await guarded(values.out, repository);
    if (!values.execute) {
      console.log(JSON.stringify({ status: "not-executed", plannedSlots: 100, limit, formal: values.formal,
        pcmContractReady: adapter?.version === PCM_CONTRACT_VERSION && typeof adapter.collect === "function" }));
      return 0;
    }
    if (!adapter) throw new ExperimentRunError("pcm_contract_pending");
    if (adapter.version !== PCM_CONTRACT_VERSION || typeof adapter.collect !== "function") throw new PcmContractError();
    const authentication = { subscription: values.subscription, tenant: values.tenant, authClientId: values["auth-client-id"] };
    const token = await acquireApiBearer(authentication);
    const configuration = parseExperimentConfiguration(await fetchExperimentConfiguration(values.origin, token), commit);
    const result = await runExperiments({
      repository, output, fixtureManifest: values.fixtures, seed, formal: values.formal,
      limit, resume: values.resume, sourceCommit: commit, imageDigest: values["image-digest"],
    }, {
      pcmContractVersion: adapter.version, configuration,
      createDriver: async (_slot, _timeout, signal) => createBrowserDriver(origin.origin, await acquireApiBearer(authentication, undefined, signal), adapter, signal),
    });
    console.log(JSON.stringify({
      status: result.report.formalComplete ? "formal-complete" : "limited-or-incomplete",
      planned: 100, completed: result.report.totals.completed, failed: result.report.totals.failed,
      notRun: result.report.totals.notRun, report: basename(result.reportFile),
    }));
    return result.report.totals.notRun === 100 - limit ? 0 : 1;
  } catch (error: unknown) {
    console.error(`experiment runner failed: ${error instanceof PcmContractError ? "pcm_contract_invalid"
      : error instanceof ExperimentRunError ? error.code : "runner_failed"}`);
    return 1;
  }
}

// Execution still requires --execute; importing this module never opens a browser or model session.
if (import.meta.main) process.exitCode = await runRunnerCli(process.argv.slice(2));

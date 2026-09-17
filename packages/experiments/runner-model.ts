import { createHash } from "node:crypto";
import type { GameSnapshot, OperationStatus } from "../contracts/index.ts";
import { FIXTURE_SET_VERSION, SYNTHETIC_FIXTURES } from "../../tests/synthetic-scenarios.ts";
import { createTrialSchedule } from "./schedule.ts";
import type { TrialSchedule, TrialSlot } from "./schedule.ts";
import { deriveActionMetrics } from "./metrics.ts";
import type { ActionMetrics } from "./metrics.ts";
import { PCM_CONTRACT_VERSION, PCM_RULES, parseRecordedVoiceMetrics } from "./pcm.ts";
import type { RecordedVoiceMetrics } from "./pcm.ts";

export const RUN_SCENARIOS = ["normal", "cancel", "replace-blue", "backchannel", "boundary"] as const;
export type RunScenario = typeof RUN_SCENARIOS[number];
export type FixtureId = typeof SYNTHETIC_FIXTURES[number]["id"];
export const RUN_RULES = Object.freeze({
  version: "action-study-v1",
  observationMs: 45_000,
  remoteActiveWaitMs: 30_000,
  trialMaxMs: 180_000,
  cleanupReserveMs: 15_000,
  pollMs: 100,
  stepIntervalMs: 3_000,
  quantiles: "nearest-rank",
  observationOrigin: "playback-end-observed",
  replayPolicy: "never-retry-started-slots",
  sourceOffsetsSynchronized: false,
  normal: "red=6,blue=0,no-pending,no-cancel-intent",
  cancelA: "ignored-cancel,red=6,blue=0,no-pending",
  cancelB: "accepted-cancel,pending-cancelled,blue=0,no-post-cancel-steps,no-pending",
  replaceA: "ignored-replace,completed-replace,red=6,blue=6,no-pending",
  replaceB: "accepted-replace,pending-cancelled,completed-replace,blue=6,no-post-cancel-steps,no-pending",
  backchannel: "red=6,blue=0,no-pending,no-cancel-intent",
  boundary: "first-observed-red>=5-with-pending-red-right;then-cancel-rules",
} as const);

export class ExperimentRunError extends Error {
  readonly code: string;
  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "ExperimentRunError";
    this.code = code;
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExperimentRunError("invalid_artifact");
  return { ...value };
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum) {
    throw new ExperimentRunError("invalid_artifact");
  }
  return value;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ExperimentRunError("invalid_artifact");
  return value;
}

export function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/iu.test(value)) throw new ExperimentRunError("invalid_digest");
  return value.toLowerCase();
}

export function sourceCommit(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(value)) {
    throw new ExperimentRunError("invalid_source_commit");
  }
  return value.toLowerCase();
}

export function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (entry === null || typeof entry === "boolean" || typeof entry === "string") return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object" && Object.getPrototypeOf(entry) === Object.prototype) {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, normalize(item)]));
    }
    throw new ExperimentRunError("non_json_artifact");
  };
  return JSON.stringify(normalize(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function jsonHash(value: unknown): string { return sha256(canonicalJson(value)); }

export interface FixtureMetadata {
  id: FixtureId;
  file: string;
  bytes: number;
  sha256: string;
}

/** Consumes the v3 object manifest. Text is checked against the public definition, never returned. */
export function parseFixtureManifest(value: unknown): FixtureMetadata[] {
  const manifest = object(value);
  if (manifest.version !== FIXTURE_SET_VERSION || manifest.provider !== "Azure Speech"
    || manifest.sampleRate !== 24_000 || manifest.format !== "riff-24khz-16bit-mono-pcm"
    || typeof manifest.voice !== "string" || !Array.isArray(manifest.fixtures)
    || manifest.fixtures.length !== SYNTHETIC_FIXTURES.length) {
    throw new ExperimentRunError("fixture_manifest_mismatch");
  }
  const entries = manifest.fixtures.map(object);
  return SYNTHETIC_FIXTURES.map((definition) => {
    const matches = entries.filter((entry) => entry.id === definition.id);
    const entry = matches[0];
    if (matches.length !== 1 || !entry || entry.text !== definition.text || entry.file !== `${definition.id}.wav`) {
      throw new ExperimentRunError("fixture_manifest_mismatch");
    }
    const bytes = integer(entry.bytes, 750_000);
    if (bytes < 44) throw new ExperimentRunError("fixture_manifest_mismatch");
    return { id: definition.id, file: `${definition.id}.wav`, bytes, sha256: digest(entry.sha256) };
  });
}

export interface ExperimentConfiguration {
  schemaVersion: 1;
  settings: {
    liveModel: string;
    backendModel: string;
    sourceCommit: string;
    stepIntervalMs: 3000;
    tickMs: number;
    sessionLimitMs: number;
    idleLimitMs: number;
    sourceOffsetsSynchronized: false;
  };
  closeTimeoutMs: number;
  /** Opaque server SHA-256 of JSON.stringify(sessionConfiguration(config)); never recomputed from a prompt here. */
  protocolSha256: string;
}

export function parseExperimentConfiguration(value: unknown, expectedCommit: string): ExperimentConfiguration {
  try {
    return parseConfigurationFields(value, expectedCommit);
  } catch (error: unknown) {
    if (error instanceof ExperimentRunError && ["source_mismatch", "config_mismatch"].includes(error.code)) throw error;
    throw new ExperimentRunError("config_mismatch", { cause: error });
  }
}

function parseConfigurationFields(value: unknown, expectedCommit: string): ExperimentConfiguration {
  const config = object(value);
  const settings = object(config.settings);
  if (Object.keys(config).some((key) => !["schemaVersion", "settings", "closeTimeoutMs", "protocolSha256"].includes(key))
    || Object.keys(settings).some((key) => ![
      "liveModel", "backendModel", "sourceCommit", "stepIntervalMs", "tickMs", "sessionLimitMs",
      "idleLimitMs", "sourceOffsetsSynchronized",
    ].includes(key))) throw new ExperimentRunError("config_mismatch");
  let observedCommit: string;
  try { observedCommit = sourceCommit(settings.sourceCommit); } catch (error: unknown) {
    throw new ExperimentRunError("source_mismatch", { cause: error });
  }
  if (config.schemaVersion !== 1 || observedCommit !== sourceCommit(expectedCommit)) {
    throw new ExperimentRunError("source_mismatch");
  }
  if (settings.stepIntervalMs !== 3_000 || settings.sourceOffsetsSynchronized !== false
    || typeof settings.liveModel !== "string" || typeof settings.backendModel !== "string"
    || !/^[a-z0-9.-]{1,64}$/iu.test(settings.liveModel) || !/^[a-z0-9.-]{1,64}$/iu.test(settings.backendModel)) {
    throw new ExperimentRunError("config_mismatch");
  }
  const positive = (value: unknown, maximum: number): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
      throw new ExperimentRunError("config_mismatch");
    }
    return value;
  };
  return {
    schemaVersion: 1,
    settings: {
      liveModel: settings.liveModel, backendModel: settings.backendModel,
      sourceCommit: observedCommit, stepIntervalMs: 3_000,
      tickMs: positive(settings.tickMs, 1_000),
      sessionLimitMs: positive(settings.sessionLimitMs, 600_000),
      idleLimitMs: positive(settings.idleLimitMs, 90_000),
      sourceOffsetsSynchronized: false,
    },
    closeTimeoutMs: positive(config.closeTimeoutMs, 30_000),
    protocolSha256: digest(config.protocolSha256),
  };
}

export interface RunManifest {
  schemaVersion: 1;
  createdAt: string;
  execution: { formal: boolean; limit: number };
  schedule: TrialSchedule;
  sourceCommit: string;
  sourceFiles: Record<string, string>;
  sourceSha256: string;
  imageDigest: string;
  configuration: ExperimentConfiguration;
  configurationSha256: string;
  fixtureVersion: string;
  fixtureManifestSha256: string;
  fixtureDefinitionSha256: string;
  fixtures: FixtureMetadata[];
  pcmContractVersion: string;
  pcmRules?: typeof PCM_RULES;
  rules: typeof RUN_RULES;
}

function iso(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new ExperimentRunError("invalid_artifact");
  return new Date(value).toISOString();
}

export function createRunManifest(input: {
  createdAt: string; seed: number; formal: boolean; limit: number;
  sourceCommit: string; sourceFiles: Record<string, string>; imageDigest: string;
  configuration: unknown; fixtureManifestSha256: string; fixtures: FixtureMetadata[];
  pcmContractVersion: string;
}): RunManifest {
  if (typeof input.formal !== "boolean" || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
    || input.formal && input.limit !== 100) throw new ExperimentRunError("invalid_trial_limit");
  if (!/^sha256:[a-f0-9]{64}$/iu.test(input.imageDigest)) throw new ExperimentRunError("invalid_image_digest");
  if (!/^[a-zA-Z0-9._-]{1,100}$/u.test(input.pcmContractVersion)) throw new ExperimentRunError("pcm_contract_pending");
  const sourceFiles: Record<string, string> = {};
  for (const [path, hash] of Object.entries(input.sourceFiles)) {
    if (!/^[a-zA-Z0-9_./-]+$/u.test(path) || path.startsWith("/") || path.split("/").includes("..")) {
      throw new ExperimentRunError("invalid_source_path");
    }
    sourceFiles[path] = digest(hash);
  }
  if (Object.keys(sourceFiles).length === 0) throw new ExperimentRunError("missing_source_hashes");
  const configuration = parseExperimentConfiguration(input.configuration, input.sourceCommit);
  if (input.fixtures.length !== 5 || new Set(input.fixtures.map((entry) => entry.id)).size !== 5) {
    throw new ExperimentRunError("fixture_manifest_mismatch");
  }
  const fixtures = SYNTHETIC_FIXTURES.map((definition) => {
    const entry = input.fixtures.find((item) => item.id === definition.id);
    if (!entry || entry.file !== `${definition.id}.wav`) throw new ExperimentRunError("fixture_manifest_mismatch");
    return { id: definition.id, file: entry.file, bytes: integer(entry.bytes, 750_000), sha256: digest(entry.sha256) };
  });
  return {
    schemaVersion: 1, createdAt: iso(input.createdAt),
    execution: { formal: input.formal, limit: input.limit },
    schedule: createTrialSchedule({ seed: input.seed, scenarioIds: RUN_SCENARIOS }),
    sourceCommit: sourceCommit(input.sourceCommit), sourceFiles, sourceSha256: jsonHash(sourceFiles),
    imageDigest: input.imageDigest.toLowerCase(), configuration, configurationSha256: jsonHash(configuration),
    fixtureVersion: FIXTURE_SET_VERSION, fixtureManifestSha256: digest(input.fixtureManifestSha256),
    fixtureDefinitionSha256: jsonHash(SYNTHETIC_FIXTURES), fixtures,
    pcmContractVersion: input.pcmContractVersion, rules: { ...RUN_RULES },
    ...(input.pcmContractVersion === PCM_CONTRACT_VERSION ? { pcmRules: { ...PCM_RULES } } : {}),
  };
}

export function parseRunManifest(value: unknown): RunManifest {
  const raw = object(value);
  const execution = object(raw.execution);
  const schedule = object(raw.schedule);
  const files = object(raw.sourceFiles);
  const sourceFiles = Object.fromEntries(Object.entries(files).map(([path, hash]) => [path, digest(hash)]));
  if (!Array.isArray(raw.fixtures) || typeof execution.formal !== "boolean"
    || typeof raw.pcmContractVersion !== "string" || typeof raw.imageDigest !== "string") {
    throw new ExperimentRunError("invalid_artifact");
  }
  const fixtures = raw.fixtures.map((entry): FixtureMetadata => {
    const item = object(entry);
    const definition = SYNTHETIC_FIXTURES.find((fixture) => fixture.id === item.id);
    if (!definition || item.file !== `${definition.id}.wav`) throw new ExperimentRunError("invalid_artifact");
    return { id: definition.id, file: `${definition.id}.wav`, bytes: integer(item.bytes), sha256: digest(item.sha256) };
  });
  const parsed = createRunManifest({
    createdAt: iso(raw.createdAt), seed: integer(schedule.seed), formal: execution.formal,
    limit: integer(execution.limit), sourceCommit: sourceCommit(raw.sourceCommit),
    sourceFiles, imageDigest: raw.imageDigest, configuration: raw.configuration,
    fixtureManifestSha256: digest(raw.fixtureManifestSha256), fixtures, pcmContractVersion: raw.pcmContractVersion,
  });
  if (canonicalJson(parsed) !== canonicalJson(raw)) throw new ExperimentRunError("manifest_mismatch");
  return parsed;
}

export function assertManifestCompatible(existing: RunManifest, expected: RunManifest): void {
  if (canonicalJson({ ...existing, createdAt: expected.createdAt }) !== canonicalJson(expected)) {
    throw new ExperimentRunError("manifest_mismatch");
  }
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]{1,200}$/u.test(value)) throw new ExperimentRunError("snapshot_invalid");
  return value;
}

const reasons = new Set([
  "cancel", "replace", "engine.stopped", "Engine is stopped.", "Delegation is not registered.",
  "Delegation belongs to a stale epoch.", "callId collision.",
  "Delegation creation is at or before the cancellation barrier.",
  "Creation offset must be finite, nonnegative, and not in the future.",
  "Invalid delegationId.", "Delegation registration cannot be changed.",
  "Invalid callId or delegationId.", "Request must be an object.",
  "Request must contain only callId, delegationId, and command.",
]);
const numericDetails = new Set([
  "epoch", "previousEpoch", "cancelledCount", "from", "to", "sourceOffsetMs", "stepIntervalMs",
  "seconds", "session_seconds", "input_tokens", "output_tokens", "total_tokens", "offsetMs",
]);

/** Allowlisted operational evidence only. Never copies transcripts, SDP, headers or arbitrary error messages. */
export function sanitizeSnapshot(value: unknown): GameSnapshot {
  const snapshot = object(value);
  const cargo = object(snapshot.cargo);
  if (snapshot.mode !== "voice-only" && snapshot.mode !== "cancel-actions"
    || typeof snapshot.stopped !== "boolean" || !Array.isArray(snapshot.operations) || !Array.isArray(snapshot.events)
    || snapshot.operations.length > 3_000 || snapshot.events.length > 20_000) throw new ExperimentRunError("snapshot_invalid");
  const color = (value: unknown) => {
    if (value !== "red" && value !== "blue") throw new ExperimentRunError("snapshot_invalid");
    return value;
  };
  const destination = (value: unknown) => {
    if (value !== "left" && value !== "right") throw new ExperimentRunError("snapshot_invalid");
    return value;
  };
  const status = (value: unknown): OperationStatus => {
    if (value !== "queued" && value !== "running" && value !== "completed" && value !== "cancelled" && value !== "failed") {
      throw new ExperimentRunError("snapshot_invalid");
    }
    return value;
  };
  return {
    runId: id(snapshot.runId), mode: snapshot.mode, stopped: snapshot.stopped,
    epoch: integer(snapshot.epoch), cargo: { red: integer(cargo.red, 6), blue: integer(cargo.blue, 6) },
    operations: snapshot.operations.map((entry) => {
      const operation = object(entry);
      return {
        id: id(operation.id), callId: id(operation.callId), delegationId: id(operation.delegationId),
        epoch: integer(operation.epoch), cargo: color(operation.cargo), destination: destination(operation.destination),
        status: status(operation.status), createdAtMs: finite(operation.createdAtMs),
        endedAtMs: operation.endedAtMs === null ? null : finite(operation.endedAtMs),
      };
    }),
    events: snapshot.events.map((entry, index) => {
      const event = object(entry);
      if (event.sequence !== index + 1) throw new ExperimentRunError("incomplete_event_history");
      const details: GameSnapshot["events"][number]["details"] = {};
      for (const [key, value] of Object.entries(object(event.details))) {
        if (numericDetails.has(key) && typeof value === "number" && Number.isFinite(value)) details[key] = value;
        else if (key === "applied" && typeof value === "boolean") details[key] = value;
        else if (key === "reason" && typeof value === "string" && reasons.has(value)) details[key] = value;
        else if ((key === "cargo" && (value === "red" || value === "blue"))
          || (key === "destination" && (value === "left" || value === "right"))
          || (key === "commandType" && (value === "move" || value === "cancel" || value === "replace"))) details[key] = value;
      }
      return {
        sequence: index + 1, atMs: finite(event.atMs), kind: id(event.kind),
        operationId: event.operationId === null ? null : id(event.operationId),
        delegationId: event.delegationId === null ? null : id(event.delegationId), details,
      };
    }),
  };
}

export interface FinalUsage {
  scope: "voice-session-only";
  status: "confirmed" | "unconfirmed" | "not-applicable";
  metrics: Record<string, number> | null;
}

export function finalUsage(snapshot: GameSnapshot | null): FinalUsage {
  const event = snapshot?.events.findLast((entry) => entry.kind === "final_usage_confirmed" || entry.kind === "final_usage_unconfirmed");
  if (event?.kind !== "final_usage_confirmed") return { scope: "voice-session-only", status: "unconfirmed", metrics: null };
  const metrics: Record<string, number> = {};
  for (const key of ["seconds", "session_seconds", "input_tokens", "output_tokens", "total_tokens"]) {
    const value = event.details[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) metrics[key] = value;
  }
  return { scope: "voice-session-only", status: "confirmed", metrics };
}

export function boundaryReady(snapshot: GameSnapshot): boolean {
  return snapshot.cargo.red >= 5 && snapshot.operations.some((entry) => entry.cargo === "red"
    && entry.destination === "right" && (entry.status === "queued" || entry.status === "running"));
}

export function pacingEvidence(snapshot: GameSnapshot): { observedSteps: number; violations: number } {
  let previous = 0;
  let observedSteps = 0;
  let violations = 0;
  for (const event of snapshot.events) {
    if (event.kind !== "operation.step") continue;
    observedSteps += 1;
    const operation = snapshot.operations.find((entry) => entry.id === event.operationId);
    if (!operation || event.atMs - Math.max(previous, operation.createdAtMs) < RUN_RULES.stepIntervalMs) violations += 1;
    previous = event.atMs;
  }
  return { observedSteps, violations };
}

export function judgeAction(scenario: string, snapshot: GameSnapshot, metrics: ActionMetrics): boolean {
  const pending = snapshot.operations.some((entry) => entry.status === "running" || entry.status === "queued");
  if (pending || metrics.stepsAfterAcceptedCancellation !== 0 || pacingEvidence(snapshot).violations !== 0) return false;
  if (scenario === "normal" || scenario === "backchannel") {
    return snapshot.cargo.red === 6 && snapshot.cargo.blue === 0
      && metrics.cancelIntentAccepted === 0 && metrics.cancelIntentIgnored === 0;
  }
  if (scenario === "replace-blue") {
    return snapshot.cargo.blue === 6 && metrics.correctionsCompleted > 0
      && (snapshot.mode === "voice-only"
        ? snapshot.cargo.red === 6 && metrics.cancelIntentsByCommand.replace.ignored > 0
        : metrics.cancelIntentsByCommand.replace.accepted > 0 && metrics.pendingOperationsCancelled > 0);
  }
  if (scenario !== "cancel" && scenario !== "boundary") throw new ExperimentRunError("unknown_scenario");
  return snapshot.cargo.blue === 0 && (snapshot.mode === "voice-only"
    ? snapshot.cargo.red === 6 && metrics.cancelIntentsByCommand.cancel.ignored > 0
    : metrics.cancelIntentsByCommand.cancel.accepted > 0 && metrics.pendingOperationsCancelled > 0);
}

export interface TrialStarted {
  schemaVersion: 1;
  manifestSha256: string;
  slotId: string;
  attemptId: string;
  startedAt: string;
}

export interface RecordedTrialResult extends TrialStarted {
  status: "completed" | "failed";
  failureCode: string | null;
  finishedAt: string | null;
  recoveredAt: string | null;
  preCleanupSnapshot: GameSnapshot | null;
  actionMetrics: ActionMetrics | null;
  conditionMet: boolean | null;
  timings: {
    elapsedMs: number | null;
    snapshotAtMs: number | null;
    initialEndMs: number | null;
    secondEndMs: number | null;
    observationMs: number | null;
    observationActualMs: number | null;
    cleanupMs: number | null;
  };
  cleanup: { reservationReleased: boolean; usage: FinalUsage };
  voiceMetrics: RecordedVoiceMetrics | null;
  goalMet: boolean | null;
}

/** Full action evidence is independent of the later usage/transport handshake, not of input or observation validity. */
export function actionObservationCompleted(manifest: RunManifest, slot: TrialSlot, result: RecordedTrialResult): boolean {
  const snapshot = result.preCleanupSnapshot;
  const timing = result.timings;
  const reference = slot.scenarioId === "normal" ? timing.initialEndMs : timing.secondEndMs;
  if (result.failureCode !== null && result.failureCode !== "cleanup_unconfirmed"
    || !snapshot || snapshot.stopped || result.conditionMet !== true || result.goalMet === null
    || timing.observationMs !== RUN_RULES.observationMs || timing.observationActualMs === null
    || timing.observationActualMs < RUN_RULES.observationMs || reference === null
    || timing.initialEndMs === null || timing.snapshotAtMs === null
    || timing.snapshotAtMs - reference < RUN_RULES.observationMs
    || timing.snapshotAtMs > RUN_RULES.trialMaxMs - RUN_RULES.cleanupReserveMs
    || timing.elapsedMs === null || timing.cleanupMs === null
    || reference + timing.observationActualMs > timing.elapsedMs - timing.cleanupMs
    || pacingEvidence(snapshot).violations !== 0) return false;
  if (manifest.pcmContractVersion === PCM_CONTRACT_VERSION || result.voiceMetrics !== null) {
    const voice = result.voiceMetrics?.data;
    if (!voice || [voice.clips.initial, voice.clips.interruption].some((clip) => clip !== null
      && (clip.inputStartContextTime === null || clip.missingReason !== null
        || clip.peerAtPlayback?.connectionState !== "connected"
        || clip.peerAtPlayback.trackEnabled !== true || clip.peerAtPlayback.trackReadyState !== "live"))) return false;
  }
  return true;
}

export function validateStarted(value: unknown, manifest: RunManifest, slot: TrialSlot): TrialStarted {
  const record = object(value);
  if (record.schemaVersion !== 1 || record.manifestSha256 !== jsonHash(manifest) || record.slotId !== slot.slotId) {
    throw new ExperimentRunError("invalid_artifact");
  }
  return {
    schemaVersion: 1, manifestSha256: jsonHash(manifest), slotId: slot.slotId,
    attemptId: id(record.attemptId), startedAt: iso(record.startedAt),
  };
}

export function interruptedResult(start: TrialStarted, recoveredAt: string): RecordedTrialResult {
  return {
    ...start, status: "failed", failureCode: "interrupted", finishedAt: null, recoveredAt: iso(recoveredAt),
    preCleanupSnapshot: null, actionMetrics: null, conditionMet: null,
    timings: { elapsedMs: null, snapshotAtMs: null, initialEndMs: null, secondEndMs: null, observationMs: null, observationActualMs: null, cleanupMs: null },
    cleanup: { reservationReleased: false, usage: { scope: "voice-session-only", status: "unconfirmed", metrics: null } },
    voiceMetrics: null, goalMet: null,
  };
}

export function parseRecordedResult(value: unknown, manifest: RunManifest, slot: TrialSlot): RecordedTrialResult {
  const record = object(value);
  const start = validateStarted(value, manifest, slot);
  if (record.status !== "completed" && record.status !== "failed"
    || record.failureCode !== null && (typeof record.failureCode !== "string" || !/^[a-z_]{1,80}$/u.test(record.failureCode))
    || record.conditionMet !== null && typeof record.conditionMet !== "boolean") throw new ExperimentRunError("invalid_artifact");
  let voiceMetrics: RecordedVoiceMetrics | null = null;
  if (record.voiceMetrics !== null) {
    try { voiceMetrics = parseRecordedVoiceMetrics(record.voiceMetrics); } catch (error: unknown) {
      throw new ExperimentRunError("invalid_artifact", { cause: error });
    }
    if (voiceMetrics.data.clips.initial.playbackId !== `${slot.slotId}-initial`
      || (slot.scenarioId === "normal" ? voiceMetrics.data.clips.interruption !== null
        : voiceMetrics.data.clips.interruption?.playbackId !== `${slot.slotId}-second`)) {
      throw new ExperimentRunError("invalid_artifact");
    }
  }
  const snapshot = record.preCleanupSnapshot === null ? null : sanitizeSnapshot(record.preCleanupSnapshot);
  if (snapshot && snapshot.mode !== slot.mode) throw new ExperimentRunError("mode_mismatch");
  const metrics = snapshot ? deriveActionMetrics(snapshot) : null;
  if (canonicalJson(metrics) !== canonicalJson(record.actionMetrics)) throw new ExperimentRunError("invalid_artifact");
  const timing = object(record.timings);
  const optional = (value: unknown) => value === null ? null : finite(value);
  const timings = {
    elapsedMs: optional(timing.elapsedMs), snapshotAtMs: optional(timing.snapshotAtMs),
    initialEndMs: optional(timing.initialEndMs), secondEndMs: optional(timing.secondEndMs),
    observationMs: optional(timing.observationMs), observationActualMs: optional(timing.observationActualMs), cleanupMs: optional(timing.cleanupMs),
  };
  const cleanup = object(record.cleanup);
  const rawUsage = object(cleanup.usage);
  if (typeof cleanup.reservationReleased !== "boolean" || rawUsage.scope !== "voice-session-only"
    || rawUsage.status !== "confirmed" && rawUsage.status !== "unconfirmed" && rawUsage.status !== "not-applicable") {
    throw new ExperimentRunError("invalid_artifact");
  }
  const usage: FinalUsage = { scope: "voice-session-only", status: rawUsage.status, metrics: null };
  if (rawUsage.metrics !== null) {
    usage.metrics = {};
    for (const [key, value] of Object.entries(object(rawUsage.metrics))) {
      if (!["seconds", "session_seconds", "input_tokens", "output_tokens", "total_tokens"].includes(key)) {
        throw new ExperimentRunError("invalid_artifact");
      }
      usage.metrics[key] = finite(value);
    }
  }
  const goalMet = snapshot && metrics && record.conditionMet === true && timings.observationMs === RUN_RULES.observationMs
    ? judgeAction(slot.scenarioId, snapshot, metrics) : null;
  if (record.goalMet !== goalMet || record.status === "completed" && (record.failureCode !== null || !snapshot
    || snapshot.stopped || timings.observationMs !== 45_000 || timings.observationActualMs === null
    || timings.observationActualMs < 45_000 || timings.elapsedMs === null || timings.elapsedMs > RUN_RULES.trialMaxMs
    || record.conditionMet !== true || !cleanup.reservationReleased || usage.status !== "confirmed")
    || record.status === "failed" && record.failureCode === null) {
    throw new ExperimentRunError("invalid_artifact");
  }
  const result: RecordedTrialResult = {
    ...start, status: record.status, failureCode: record.failureCode,
    finishedAt: record.finishedAt === null ? null : iso(record.finishedAt),
    recoveredAt: record.recoveredAt === null ? null : iso(record.recoveredAt),
    preCleanupSnapshot: snapshot, actionMetrics: metrics, conditionMet: record.conditionMet,
    timings, cleanup: { reservationReleased: cleanup.reservationReleased, usage }, voiceMetrics, goalMet,
  };
  if (result.failureCode === "interrupted") {
    if (result.recoveredAt === null || canonicalJson(result) !== canonicalJson(interruptedResult(start, result.recoveredAt))) {
      throw new ExperimentRunError("invalid_artifact");
    }
  } else if (result.finishedAt === null || result.recoveredAt !== null || timings.elapsedMs === null || timings.cleanupMs === null
    || timings.cleanupMs > timings.elapsedMs
    || (snapshot === null) !== (timings.snapshotAtMs === null)
    || timings.snapshotAtMs !== null && timings.snapshotAtMs > timings.elapsedMs
    || timings.initialEndMs !== null && timings.initialEndMs > timings.elapsedMs
    || timings.secondEndMs !== null && (timings.initialEndMs === null
      || timings.secondEndMs < timings.initialEndMs || timings.secondEndMs > timings.elapsedMs)) {
    throw new ExperimentRunError("invalid_artifact");
  }
  if (result.status === "completed") {
    if (manifest.pcmContractVersion === PCM_CONTRACT_VERSION && (!voiceMetrics
      || [voiceMetrics.data.clips.initial, voiceMetrics.data.clips.interruption].some((clip) => clip !== null
        && (clip.inputStartContextTime === null || clip.peerAtPlayback?.connectionState !== "connected"
          || clip.peerAtPlayback.trackEnabled !== true || clip.peerAtPlayback.trackReadyState !== "live")))) {
      throw new ExperimentRunError("invalid_artifact");
    }
    const reference = slot.scenarioId === "normal" ? timings.initialEndMs : timings.secondEndMs;
    if (reference === null || timings.elapsedMs === null || timings.cleanupMs === null || timings.observationActualMs === null
      || timings.snapshotAtMs === null || timings.snapshotAtMs - reference < RUN_RULES.observationMs
      || reference + timings.observationActualMs > timings.elapsedMs - timings.cleanupMs
      || slot.scenarioId === "normal" && timings.secondEndMs !== null) throw new ExperimentRunError("invalid_artifact");
  }
  if (canonicalJson(result) !== canonicalJson(record)) throw new ExperimentRunError("invalid_artifact");
  return result;
}

import { exactKeys, isAudioMeasurementEvent } from "../../apps/web/src/audioMeasurement.ts";
import type { AudioMeasurementEvent, MeasurementSample } from "../../apps/web/src/audioMeasurement.ts";
import { ACTIVE_WINDOWS, RMS_THRESHOLD, SILENT_WINDOWS, THRESHOLD_DBFS, WINDOW_MS } from "../../apps/web/src/pcmWindow.ts";

export const PCM_CONTRACT_VERSION = "ui-pcm-v1-runner-v1";
export const PCM_RULES = Object.freeze({
  version: PCM_CONTRACT_VERSION,
  windowMs: 20, thresholdDbfs: -45, activeWindows: 3, silentWindows: 6,
  maxFreshAgeMs: 200, maxPlaybackOverrunMs: 250,
  maxEvents: 20_000, maxPeerObservations: 4_000,
  metric: "input-start-to-received-pcm-silence",
  clock: "same-measurementId-and-meter-context",
  attribution: "performance-markers-and-anchor-intervals-only",
} as const);

export class PcmContractError extends Error {
  constructor() { super("pcm_contract_invalid"); this.name = "PcmContractError"; }
}

export function assertPcmContract(): void {
  if (WINDOW_MS !== 20 || THRESHOLD_DBFS !== -45 || RMS_THRESHOLD !== 10 ** (-45 / 20)
    || ACTIVE_WINDOWS !== 3 || SILENT_WINDOWS !== 6) throw new PcmContractError();
}

export interface PeerObservation {
  performanceNowMs: number;
  connectionState: RTCPeerConnectionState | null;
  trackEnabled: boolean | null;
  trackReadyState: MediaStreamTrackState | null;
}
export interface PcmPlayback {
  id: string;
  performanceStartMs: number;
  durationMs: number;
  endedObservedPerformanceMs: number | null;
}
export interface PcmEvidence {
  version: 1;
  capturedAtPerformanceMs: number;
  events: AudioMeasurementEvent[];
  playbacks: PcmPlayback[];
  peers: PeerObservation[];
  receivedMeasurementEvents: number;
  invalidMeasurementEvents: number;
  collectionGaps: number;
  helperErrorCount: number;
  transcriptEventCount: number;
}

const reasons = [
  "not_collected", "invalid_event", "collection_gap", "measurement_missing", "mixed_measurement_ids",
  "clock_ambiguous", "measurement_interrupted", "sample_gap", "transition_invalid",
  "fixture_missing", "fixture_clock_ambiguous", "input_attribution_ambiguous",
  "no_input_samples", "no_input", "no_output_samples", "no_overlap", "stop_not_observed",
] as const;
export type VoiceMissingReason = typeof reasons[number];
export interface ClipPcmMetrics {
  playbackId: string;
  inputSamples: number;
  inputAboveThresholdSamples: number;
  inputStartContextTime: number | null;
  inputStartConfirmedAtContextTime: number | null;
  missingReason: VoiceMissingReason | null;
  peerAtPlayback: PeerObservation | null;
}
export interface VoiceMetrics {
  version: 1;
  metric: typeof PCM_RULES.metric;
  measurementId: string | null;
  inputStartToReceivedPcmSilenceMs: number | null;
  missingReason: VoiceMissingReason | null;
  inputStartContextTime: number | null;
  inputStartConfirmedAtContextTime: number | null;
  outputSilenceContextTime: number | null;
  outputSilenceConfirmedAtContextTime: number | null;
  clips: { initial: ClipPcmMetrics; interruption: ClipPcmMetrics | null };
  diagnostics: {
    inputSamples: number; outputSamples: number;
    inputAboveThresholdSamples: number; outputAboveThresholdSamples: number;
    expectedSamplesPerDirection: number; missingInputSamples: number; missingOutputSamples: number;
    measurementEvents: number; anchorEvents: number; statusEvents: number;
    invalidMeasurementEvents: number; collectionGaps: number;
    helperErrorCount: number; transcriptEventCount: number;
    peerObservations: number;
    anchorOffsetSpreadMs: number | null;
    interpretation: "observations-only-cause-not-established";
  };
}
export interface RecordedVoiceMetrics { evidenceSha256: string; data: VoiceMetrics }

function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}
function count(value: unknown): value is number { return number(value) && Number.isSafeInteger(value); }
function nullable(value: unknown): value is number | null { return value === null || number(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/u.test(value); }
function reason(value: unknown): value is VoiceMissingReason | null {
  return value === null || reasons.some((reason) => reason === value);
}
function peer(value: unknown): value is PeerObservation {
  return exactKeys(value, ["performanceNowMs", "connectionState", "trackEnabled", "trackReadyState"])
    && number(value.performanceNowMs) && (value.connectionState === null || typeof value.connectionState === "string"
      && ["new", "connecting", "connected", "disconnected", "failed", "closed"].includes(value.connectionState))
    && (value.trackEnabled === null || typeof value.trackEnabled === "boolean")
    && (value.trackReadyState === null || value.trackReadyState === "live" || value.trackReadyState === "ended");
}
function playback(value: unknown): value is PcmPlayback {
  return exactKeys(value, ["id", "performanceStartMs", "durationMs", "endedObservedPerformanceMs"])
    && identifier(value.id) && number(value.performanceStartMs) && number(value.durationMs, 12_000) && value.durationMs > 0
    && nullable(value.endedObservedPerformanceMs)
    && (value.endedObservedPerformanceMs === null || value.endedObservedPerformanceMs >= value.performanceStartMs);
}

/** Rejects unrecognized fields: raw PCM, transcripts, credentials and arbitrary errors cannot be persisted. */
export function parsePcmEvidence(value: unknown): PcmEvidence {
  assertPcmContract();
  if (!exactKeys(value, ["version", "capturedAtPerformanceMs", "events", "playbacks", "peers",
    "receivedMeasurementEvents", "invalidMeasurementEvents", "collectionGaps", "helperErrorCount", "transcriptEventCount"])
    || value.version !== 1 || !number(value.capturedAtPerformanceMs)
    || !Array.isArray(value.events) || value.events.length > PCM_RULES.maxEvents || !value.events.every(isAudioMeasurementEvent)
    || !Array.isArray(value.playbacks) || value.playbacks.length > 2 || !value.playbacks.every(playback)
    || new Set(value.playbacks.map((entry) => entry.id)).size !== value.playbacks.length
    || !Array.isArray(value.peers) || value.peers.length > PCM_RULES.maxPeerObservations || !value.peers.every(peer)
    || !count(value.receivedMeasurementEvents) || !count(value.invalidMeasurementEvents)
    || value.receivedMeasurementEvents !== value.events.length + value.invalidMeasurementEvents
    || !count(value.collectionGaps) || !count(value.helperErrorCount) || !count(value.transcriptEventCount)) throw new PcmContractError();
  const events: AudioMeasurementEvent[] = value.events;
  const playbacks: PcmPlayback[] = value.playbacks;
  const peers: PeerObservation[] = value.peers;
  const capturedAtPerformanceMs = value.capturedAtPerformanceMs;
  if (peers.some((entry, index) => entry.performanceNowMs > capturedAtPerformanceMs
    || index > 0 && entry.performanceNowMs < (peers[index - 1]?.performanceNowMs ?? 0))) throw new PcmContractError();
  const evidence: PcmEvidence = {
    version: 1, capturedAtPerformanceMs, events, playbacks, peers,
    receivedMeasurementEvents: value.receivedMeasurementEvents, invalidMeasurementEvents: value.invalidMeasurementEvents,
    collectionGaps: value.collectionGaps, helperErrorCount: value.helperErrorCount, transcriptEventCount: value.transcriptEventCount,
  };
  if (inspect(evidence).fatalReason !== null) throw new PcmContractError();
  return structuredClone(evidence);
}

interface MeasurementSegment {
  input: MeasurementSample[];
  output: MeasurementSample[];
  validUntil: { input: number; output: number };
}

function inspect(evidence: PcmEvidence) {
  const input: MeasurementSample[] = [];
  const output: MeasurementSample[] = [];
  const segments: MeasurementSegment[] = [];
  const sampleSegments = new Map<MeasurementSample, MeasurementSegment>();
  const flags = new Set<VoiceMissingReason>();
  const ids = new Set(evidence.events.map((entry) => entry.measurementId));
  const first = evidence.events[0];
  const anchor = first?.type === "anchor" ? first : null;
  if (!anchor) flags.add("measurement_missing");
  if (!anchor && evidence.events.length > 0) flags.add("invalid_event");
  if (ids.size > 1) flags.add("mixed_measurement_ids");
  if (evidence.invalidMeasurementEvents) flags.add("invalid_event");
  if (evidence.collectionGaps) flags.add("collection_gap");
  let latestStatus: string | null = null;
  let previousContext = -Infinity;
  let previousPerformance = -Infinity;
  let minOffset = Infinity;
  let maxOffset = -Infinity;
  let segment: MeasurementSegment | undefined;
  for (const [index, event] of evidence.events.entries()) {
    const clock = event.clockAnchor;
    if (index > 0 && event.type === "anchor") flags.add("mixed_measurement_ids");
    if (clock.contextTime < previousContext || clock.performanceNowMs < previousPerformance
      || clock.performanceNowMs > evidence.capturedAtPerformanceMs) flags.add("clock_ambiguous");
    previousContext = clock.contextTime;
    previousPerformance = clock.performanceNowMs;
    const offset = clock.performanceNowMs - clock.contextTime * 1000;
    minOffset = Math.min(minOffset, offset);
    maxOffset = Math.max(maxOffset, offset);
    if (event.type === "status") {
      if (event.status === "measuring" && (latestStatus === "closed" || latestStatus === "error")) flags.add("invalid_event");
      latestStatus = event.status;
      if (event.status !== "measuring") flags.add("measurement_interrupted");
      if (event.status === "error") flags.add("invalid_event");
      if (event.status === "measuring") {
        segment = { input: [], output: [], validUntil: { input: Infinity, output: Infinity } };
        segments.push(segment);
      } else segment = undefined;
    } else if (event.type === "sample") {
      if (latestStatus !== "measuring" || !segment) flags.add("invalid_event");
      if (event.contextTime > clock.contextTime + 128 / (anchor?.sampleRate ?? 48_000) + 0.000001) flags.add("clock_ambiguous");
      (event.direction === "input" ? input : output).push(event);
      if (segment) {
        segment[event.direction].push(event);
        sampleSegments.set(event, segment);
      }
    }
  }
  const firstTime = Math.min(input[0]?.windowStartTime ?? Infinity, output[0]?.windowStartTime ?? Infinity);
  const lastTime = Math.max(input.at(-1)?.contextTime ?? 0, output.at(-1)?.contextTime ?? 0);
  const expected = Number.isFinite(firstTime) ? Math.round((lastTime - firstTime) / (WINDOW_MS / 1000)) : 0;
  const missing = { input: 0, output: 0 };
  for (const [direction, samples] of [["input", input], ["output", output]] as const) {
    let previous: MeasurementSample | undefined;
    let previousSegment: MeasurementSegment | undefined;
    let above = 0;
    let below = 0;
    let active = false;
    let candidate = 0;
    for (const sample of samples) {
      const currentSegment = sampleSegments.get(sample);
      const reset = currentSegment !== previousSegment;
      if (reset) { above = below = 0; active = false; candidate = 0; }
      const expectedSequence = (previous?.sequence ?? 0) + 1;
      if (sample.sequence < expectedSequence || previous && sample.windowStartTime < previous.contextTime - 0.000001) {
        flags.add("clock_ambiguous");
      }
      if (sample.sequence !== expectedSequence || previous && Math.abs(sample.windowStartTime - previous.contextTime) > 0.00013) {
        flags.add("sample_gap");
        missing[direction] += Math.max(0, sample.sequence - expectedSequence);
        // Explicit measuring transitions reset hysteresis. Unannounced missing windows do not certify later state.
        if (currentSegment && (!reset || sample.sequence !== expectedSequence)) {
          currentSegment.validUntil[direction] = Math.min(currentSegment.validUntil[direction], previous?.contextTime ?? sample.windowStartTime);
        }
      }
      if (sample.aboveThreshold) {
        above = Math.min(ACTIVE_WINDOWS, above + 1);
        below = 0;
        if (above === 1) candidate = sample.windowStartTime;
      } else {
        below = Math.min(SILENT_WINDOWS, below + 1);
        above = 0;
        if (below === 1) candidate = sample.windowStartTime;
      }
      const transition: MeasurementSample["transition"] = !active && above === ACTIVE_WINDOWS ? "start" : active && below === SILENT_WINDOWS ? "stop" : null;
      if (transition) active = transition === "start";
      if (sample.transitionTime !== null && Math.abs(sample.contextTime - sample.transitionTime
        - (sample.contextTime - sample.windowStartTime) * (sample.transition === "start" ? ACTIVE_WINDOWS : SILENT_WINDOWS)) > 0.00013) {
        flags.add("transition_invalid");
      }
      if (currentSegment && sample.contextTime <= currentSegment.validUntil[direction]
        && (sample.active !== active || sample.transition !== transition || (transition !== null
          && (sample.transitionTime === null || Math.abs(sample.transitionTime - candidate) > 0.00013)))) {
        flags.add("transition_invalid");
      }
      previous = sample;
      previousSegment = currentSegment;
    }
    missing[direction] = Math.max(missing[direction], expected - samples.length);
    if (samples.length && missing[direction] > 0) flags.add("sample_gap");
  }
  if (expected > 0 && evidence.capturedAtPerformanceMs - (lastTime * 1000 + minOffset) > PCM_RULES.maxFreshAgeMs) flags.add("sample_gap");
  const fatalReason = reasons.find((reason) => flags.has(reason) && [
    "invalid_event", "mixed_measurement_ids", "clock_ambiguous", "transition_invalid",
  ].includes(reason)) ?? null;
  return {
    input, output, measurementId: ids.size === 1 ? anchor?.measurementId ?? null : null,
    minOffset, maxOffset, expected, missing, latestStatus,
    failure: fatalReason ?? reasons.find((reason) => flags.has(reason)) ?? null,
    fatalReason, segments, sampleSegments,
  };
}

export function freshOutputPcmActive(evidence: PcmEvidence): boolean {
  const checked = inspect(evidence);
  const current = checked.segments.at(-1);
  const sample = current?.output.at(-1);
  if (checked.fatalReason || !checked.measurementId || evidence.collectionGaps || checked.latestStatus !== "measuring"
    || !sample || !current || sample.contextTime > current.validUntil.output || !sample.active || !sample.aboveThreshold) return false;
  const deliveryAgeMs = evidence.capturedAtPerformanceMs - sample.clockAnchor.performanceNowMs;
  const windowAgeAtDeliveryMs = Math.max(0, (sample.clockAnchor.contextTime - sample.contextTime) * 1000);
  return deliveryAgeMs >= 0 && deliveryAgeMs + windowAgeAtDeliveryMs <= PCM_RULES.maxFreshAgeMs;
}

export function deriveVoiceMetrics(evidence: PcmEvidence, initialId: string, interruptionId: string | null): VoiceMetrics {
  const checked = inspect(evidence);
  const interval = (time: number) => [time * 1000 + checked.minOffset, time * 1000 + checked.maxOffset] as const;
  const clip = (id: string): ClipPcmMetrics => {
    const marker = evidence.playbacks.find((entry) => entry.id === id);
    const result: ClipPcmMetrics = {
      playbackId: id, inputSamples: 0, inputAboveThresholdSamples: 0,
      inputStartContextTime: null, inputStartConfirmedAtContextTime: null,
      missingReason: checked.fatalReason ?? (evidence.collectionGaps > 0 ? "collection_gap" : null), peerAtPlayback: null,
    };
    if (!marker) { result.missingReason ??= "fixture_missing"; return result; }
    result.peerAtPlayback = evidence.peers.filter((entry) =>
      Math.abs(entry.performanceNowMs - marker.performanceStartMs) <= PCM_RULES.maxFreshAgeMs)
      .sort((a, b) => Math.abs(a.performanceNowMs - marker.performanceStartMs) - Math.abs(b.performanceNowMs - marker.performanceStartMs))[0] ?? null;
    const end = marker.performanceStartMs + marker.durationMs;
    const within = (time: number) => {
      const [low, high] = interval(time);
      return low >= marker.performanceStartMs && high <= end;
    };
    const attributed = checked.input.filter((sample) => within((sample.windowStartTime + sample.contextTime) / 2));
    result.inputSamples = attributed.length;
    result.inputAboveThresholdSamples = attributed.filter((sample) => sample.aboveThreshold).length;
    if (result.missingReason) return result;
    if (marker.endedObservedPerformanceMs === null || marker.endedObservedPerformanceMs < end
      || marker.endedObservedPerformanceMs - end > PCM_RULES.maxPlaybackOverrunMs) {
      result.missingReason = "fixture_clock_ambiguous"; return result;
    }
    if (evidence.playbacks.some((other) => other.id !== id && other.performanceStartMs < end
      && other.performanceStartMs + other.durationMs > marker.performanceStartMs)) {
      result.missingReason = "input_attribution_ambiguous"; return result;
    }
    if (!attributed.length) { result.missingReason = "no_input_samples"; return result; }
    const starts = checked.input.filter((sample) => sample.transition === "start" && sample.transitionTime !== null && within(sample.transitionTime));
    const onset = starts[0];
    if (!onset) {
      result.missingReason = result.inputAboveThresholdSamples ? "input_attribution_ambiguous" : "no_input";
      return result;
    }
    const onsetSegment = checked.sampleSegments.get(onset);
    const firstWindow = onsetSegment?.input[0];
    if (!onsetSegment || !firstWindow || interval(firstWindow.windowStartTime)[1] > marker.performanceStartMs + 0.001) {
      result.missingReason = "input_attribution_ambiguous"; return result;
    }
    if (onset.contextTime > onsetSegment.validUntil.input) {
      result.missingReason = checked.failure ?? "sample_gap"; return result;
    }
    const prior = onsetSegment.input.findLast((sample) => interval(sample.contextTime)[1] <= marker.performanceStartMs);
    if (prior?.active) { result.missingReason = "input_attribution_ambiguous"; return result; }
    result.inputStartContextTime = onset.transitionTime;
    result.inputStartConfirmedAtContextTime = onset.contextTime;
    return result;
  };
  const initial = clip(initialId);
  const interruption = interruptionId === null ? null : clip(interruptionId);
  const selected = interruption ?? initial;
  const result: VoiceMetrics = {
    version: 1, metric: PCM_RULES.metric, measurementId: checked.measurementId,
    inputStartToReceivedPcmSilenceMs: null, missingReason: checked.failure ?? selected.missingReason,
    inputStartContextTime: selected.inputStartContextTime,
    inputStartConfirmedAtContextTime: selected.inputStartConfirmedAtContextTime,
    outputSilenceContextTime: null, outputSilenceConfirmedAtContextTime: null,
    clips: { initial, interruption },
    diagnostics: {
      inputSamples: checked.input.length, outputSamples: checked.output.length,
      inputAboveThresholdSamples: checked.input.filter((sample) => sample.aboveThreshold).length,
      outputAboveThresholdSamples: checked.output.filter((sample) => sample.aboveThreshold).length,
      expectedSamplesPerDirection: checked.expected, missingInputSamples: checked.missing.input, missingOutputSamples: checked.missing.output,
      measurementEvents: evidence.receivedMeasurementEvents,
      anchorEvents: evidence.events.filter((event) => event.type === "anchor").length,
      statusEvents: evidence.events.filter((event) => event.type === "status").length,
      invalidMeasurementEvents: evidence.invalidMeasurementEvents, collectionGaps: evidence.collectionGaps,
      helperErrorCount: evidence.helperErrorCount, transcriptEventCount: evidence.transcriptEventCount, peerObservations: evidence.peers.length,
      anchorOffsetSpreadMs: Number.isFinite(checked.minOffset) && Number.isFinite(checked.maxOffset)
        ? checked.maxOffset - checked.minOffset : null,
      interpretation: "observations-only-cause-not-established",
    },
  };
  const inputStart = selected.inputStartContextTime;
  if (result.missingReason || inputStart === null) return result;
  if (!checked.output.length) { result.missingReason = "no_output_samples"; return result; }
  const atInput = checked.output.find((sample) => sample.windowStartTime <= inputStart + 0.000001 && sample.contextTime > inputStart + 0.000001);
  const start = checked.output.findLast((sample) => sample.transition === "start" && sample.transitionTime !== null && sample.transitionTime <= inputStart);
  const priorStop = checked.output.findLast((sample) => sample.transition === "stop" && sample.transitionTime !== null && sample.transitionTime <= inputStart);
  if (!atInput?.aboveThreshold || !start || priorStop && priorStop.contextTime > start.contextTime) {
    result.missingReason = "no_overlap"; return result;
  }
  const stop = checked.output.find((sample) => sample.transition === "stop" && sample.transitionTime !== null && sample.transitionTime >= inputStart);
  if (!stop || stop.transitionTime === null) { result.missingReason = "stop_not_observed"; return result; }
  result.outputSilenceContextTime = stop.transitionTime;
  result.outputSilenceConfirmedAtContextTime = stop.contextTime;
  result.inputStartToReceivedPcmSilenceMs = (stop.transitionTime - inputStart) * 1000;
  return result;
}

function isClip(value: unknown): value is ClipPcmMetrics {
  return exactKeys(value, ["playbackId", "inputSamples", "inputAboveThresholdSamples", "inputStartContextTime",
    "inputStartConfirmedAtContextTime", "missingReason", "peerAtPlayback"])
    && identifier(value.playbackId) && count(value.inputSamples) && count(value.inputAboveThresholdSamples)
    && value.inputAboveThresholdSamples <= value.inputSamples && nullable(value.inputStartContextTime)
    && nullable(value.inputStartConfirmedAtContextTime) && reason(value.missingReason)
    && (value.peerAtPlayback === null || peer(value.peerAtPlayback));
}

function assertRecordedVoiceMetrics(value: unknown): asserts value is RecordedVoiceMetrics {
  if (!exactKeys(value, ["evidenceSha256", "data"]) || typeof value.evidenceSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.evidenceSha256)) throw new PcmContractError();
  const data = value.data;
  if (!exactKeys(data, ["version", "metric", "measurementId", "inputStartToReceivedPcmSilenceMs", "missingReason",
    "inputStartContextTime", "inputStartConfirmedAtContextTime", "outputSilenceContextTime", "outputSilenceConfirmedAtContextTime",
    "clips", "diagnostics"]) || data.version !== 1 || data.metric !== PCM_RULES.metric
    || data.measurementId !== null && !identifier(data.measurementId)
    || !nullable(data.inputStartToReceivedPcmSilenceMs) || !reason(data.missingReason)
    || (data.inputStartToReceivedPcmSilenceMs === null) !== (data.missingReason !== null)
    || !nullable(data.inputStartContextTime) || !nullable(data.inputStartConfirmedAtContextTime)
    || !nullable(data.outputSilenceContextTime) || !nullable(data.outputSilenceConfirmedAtContextTime)
    || !exactKeys(data.clips, ["initial", "interruption"]) || !isClip(data.clips.initial)
    || data.clips.interruption !== null && !isClip(data.clips.interruption)) throw new PcmContractError();
  const diagnostics = data.diagnostics;
  if (!exactKeys(diagnostics, ["inputSamples", "outputSamples", "inputAboveThresholdSamples", "outputAboveThresholdSamples",
    "expectedSamplesPerDirection", "missingInputSamples", "missingOutputSamples", "measurementEvents", "anchorEvents", "statusEvents",
    "invalidMeasurementEvents", "collectionGaps", "helperErrorCount", "transcriptEventCount", "peerObservations", "anchorOffsetSpreadMs", "interpretation"])
    || diagnostics.interpretation !== "observations-only-cause-not-established"
    || !nullable(diagnostics.anchorOffsetSpreadMs)
    || Object.entries(diagnostics).some(([key, entry]) => key !== "interpretation" && key !== "anchorOffsetSpreadMs" && !count(entry))) throw new PcmContractError();
}

export function parseRecordedVoiceMetrics(value: unknown): RecordedVoiceMetrics {
  assertRecordedVoiceMetrics(value);
  return structuredClone(value);
}

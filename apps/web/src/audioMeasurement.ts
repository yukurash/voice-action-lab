import { isRecord } from "./api.ts";
import { ACTIVE_WINDOWS, RMS_THRESHOLD, SILENT_WINDOWS, THRESHOLD_DBFS, WINDOW_MS } from "./pcmWindow.ts";
import type { PcmWindowSample } from "./pcmWindow.ts";

export const AUDIO_MEASUREMENT_EVENT = "voice-action-lab:audio-measurement";
export const MAX_MEASUREMENT_RECORDS = 62_048;

export interface ClockAnchor {
  contextTime: number;
  performanceNowMs: number;
}
interface MeasurementHeader {
  version: 1;
  measurementId: string;
}
export interface MeasurementAnchor extends MeasurementHeader {
  type: "anchor";
  sampleRate: number;
  windowMs: 20;
  thresholdDbfs: -45;
  activeWindows: 3;
  silentWindows: 6;
  clockAnchor: ClockAnchor;
}
export interface MeasurementSample extends MeasurementHeader, PcmWindowSample {
  type: "sample";
  clockAnchor: ClockAnchor;
}
export interface MeasurementStatus extends MeasurementHeader {
  type: "status";
  status: "measuring" | "paused" | "closed" | "error";
  clockAnchor: ClockAnchor;
}
export type AudioMeasurementEvent = MeasurementAnchor | MeasurementSample | MeasurementStatus;

export function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function boundedNumber(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}
function isClock(value: unknown): value is ClockAnchor {
  return exactKeys(value, ["contextTime", "performanceNowMs"])
    && boundedNumber(value.contextTime, 3600) && boundedNumber(value.performanceNowMs, Number.MAX_SAFE_INTEGER);
}

const windowKeys = ["direction", "sequence", "windowStartTime", "contextTime", "rms", "aboveThreshold", "active", "transition", "transitionTime"];

function windowValues(value: Record<string, unknown>): boolean {
  return (value.direction === "input" || value.direction === "output")
    && boundedNumber(value.sequence, 60_000) && Number.isInteger(value.sequence) && value.sequence > 0
    && boundedNumber(value.windowStartTime, 3600) && boundedNumber(value.contextTime, 3600)
    && value.contextTime > value.windowStartTime
    && Math.abs(value.contextTime - value.windowStartTime - WINDOW_MS / 1000) < 0.00013
    && boundedNumber(value.rms, 16) && value.aboveThreshold === (value.rms >= RMS_THRESHOLD)
    && typeof value.active === "boolean"
    && (value.transition === null ? value.transitionTime === null
      : ((value.transition === "start" && value.active === true) || (value.transition === "stop" && value.active === false))
        && boundedNumber(value.transitionTime, value.windowStartTime));
}

export function isPcmWindowSample(value: unknown): value is PcmWindowSample {
  return exactKeys(value, windowKeys) && windowValues(value);
}

export function isAudioMeasurementEvent(value: unknown): value is AudioMeasurementEvent {
  if (!isRecord(value) || value.version !== 1 || typeof value.measurementId !== "string"
    || !/^[a-zA-Z0-9-]{1,64}$/.test(value.measurementId) || !isClock(value.clockAnchor)) return false;
  const header = ["version", "measurementId", "type", "clockAnchor"];
  if (value.type === "anchor") {
    return exactKeys(value, [...header, "sampleRate", "windowMs", "thresholdDbfs", "activeWindows", "silentWindows"])
      && boundedNumber(value.sampleRate, 192000) && value.sampleRate >= 8000
      && value.windowMs === WINDOW_MS && value.thresholdDbfs === THRESHOLD_DBFS
      && value.activeWindows === ACTIVE_WINDOWS && value.silentWindows === SILENT_WINDOWS;
  }
  if (value.type === "sample") return exactKeys(value, [...header, ...windowKeys]) && windowValues(value);
  return value.type === "status" && exactKeys(value, [...header, "status"])
    && typeof value.status === "string" && ["measuring", "paused", "closed", "error"].includes(value.status);
}

export const DEFAULT_MAINTENANCE_PORT = 3001;
export const DRAIN_TIMEOUT_MS = 660_000;
export const STATUS_POLL_INTERVAL_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 5_000;
export const DRAIN_READY_MARKER = "VOICE_ACTION_LAB_DRAIN_READY";

export interface MaintenanceStatus {
  readonly draining: boolean;
  readonly active: boolean;
}

export type MaintenanceCommand = "drain" | "resume" | "status";

export function isMaintenanceStatus(value: unknown): value is MaintenanceStatus {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2
    && Object.hasOwn(value, "draining") && Object.hasOwn(value, "active")
    && "draining" in value && typeof value.draining === "boolean"
    && "active" in value && typeof value.active === "boolean";
}

export function validatePort(value: unknown, allowZero = false): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 65_535) {
    throw new RangeError(allowZero ? "Port must be an integer from 0 to 65535." : "Port must be an integer from 1 to 65535.");
  }
  return value;
}

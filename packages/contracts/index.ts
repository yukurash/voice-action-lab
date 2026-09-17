export type ExperimentMode = "voice-only" | "cancel-actions";
export type CargoColor = "red" | "blue";
export type Destination = "left" | "right";

export type GameCommand =
  | { type: "move"; cargo: CargoColor; destination: Destination }
  | { type: "cancel" }
  | { type: "replace"; cargo: CargoColor; destination: Destination };

export type OperationStatus =
  | "queued" | "running" | "completed" | "cancelled" | "failed";

export interface Operation {
  id: string;
  callId: string;
  delegationId: string;
  epoch: number;
  cargo: CargoColor;
  destination: Destination;
  status: OperationStatus;
  createdAtMs: number;
  endedAtMs: number | null;
}

export interface LabEvent {
  sequence: number;
  atMs: number;
  kind: string;
  operationId: string | null;
  delegationId: string | null;
  details: Record<string, string | number | boolean | null>;
}

export interface GameSnapshot {
  runId: string;
  mode: ExperimentMode;
  epoch: number;
  cargo: Record<CargoColor, number>;
  operations: Operation[];
  events: LabEvent[];
  stopped: boolean;
}

export interface CommandRequest {
  callId: string;
  delegationId: string;
  command: GameCommand;
}

export interface CommandResult {
  outcome: "queued" | "cancelled" | "observed-not-applied" | "rejected";
  operationId: string | null;
  reason: string;
}

export interface SessionStatus {
  transport: "disconnected" | "connecting" | "connected" | "closing" | "error";
  source: "live" | "simulation";
  message: string;
  expiresAt: string | null;
  recording: boolean;
}

export interface BrowserState {
  game: GameSnapshot;
  session: SessionStatus;
}

export function parseGameCommand(value: unknown): GameCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Command must be an object.");
  }
  const command: Record<string, unknown> = { ...value };
  const allowed = command.type === "cancel"
    ? new Set(["type"])
    : new Set(["type", "cargo", "destination"]);
  if (Object.keys(command).some((key) => !allowed.has(key))) {
    throw new Error("Command contains unknown fields.");
  }
  if (command.type === "cancel") return { type: "cancel" };
  if (command.type !== "move" && command.type !== "replace") {
    throw new Error("Unknown command type.");
  }
  if (command.cargo !== "red" && command.cargo !== "blue") {
    throw new Error("Unknown cargo.");
  }
  if (command.destination !== "left" && command.destination !== "right") {
    throw new Error("Unknown destination.");
  }
  return {
    type: command.type,
    cargo: command.cargo,
    destination: command.destination,
  };
}

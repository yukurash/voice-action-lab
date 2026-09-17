import type { ServerRunExport } from "../src/serverExport.ts";

export function serverExportFixture(): ServerRunExport {
  const runId = "11111111-2222-4333-8444-555555555555";
  return {
    schemaVersion: 1, runId, source: "live",
    closedAt: "2030-01-01T00:00:05.000Z", exportedAt: "2030-01-01T00:00:06.000Z",
    game: {
      runId, mode: "cancel-actions", stopped: true, epoch: 1, cargo: { red: 4, blue: 0 },
      operations: [{
        id: "synthetic-operation", callId: "call:synthetic", delegationId: "delegation:synthetic", epoch: 0,
        cargo: "red", destination: "right", status: "cancelled", createdAtMs: 0, endedAtMs: 1000,
      }],
      events: [
        { sequence: 1, atMs: 0, kind: "command.observed", operationId: "synthetic-operation", delegationId: "delegation:synthetic",
          details: { commandType: "move", cargo: "red", destination: "right" } },
        { sequence: 2, atMs: 1000, kind: "step.committed", operationId: "synthetic-operation", delegationId: null, details: { cargo: "red", position: 4 } },
        { sequence: 3, atMs: 2000, kind: "final_usage_unconfirmed", operationId: null, delegationId: null, details: {} },
      ],
    },
    session: { transport: "error", recording: false },
    usage: { scope: "voice-session-only", status: "unconfirmed", metrics: null },
    settings: {
      liveModel: "gpt-live-1", backendModel: "gpt-5.5", stepIntervalMs: 1000, tickMs: 50,
      sessionLimitMs: 600000, idleLimitMs: 90000, sourceOffsetsSynchronized: false,
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
    },
  };
}

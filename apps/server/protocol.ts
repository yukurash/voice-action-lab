import { parseGameCommand } from "../../packages/contracts/index.ts";
import type { CommandRequest } from "../../packages/contracts/index.ts";
import { object } from "./auth.ts";

// Neither the voice prompt nor the tool definitions depend on the experiment mode.
export const VOICE_INSTRUCTIONS = [
  "日本語で短く自然に話してください。これは赤と青の荷物を左右へ運ぶ台車実験です。",
  "状態はテキストで提供され、カメラや画像は見ていません。",
  "荷物の移動、操作停止、訂正は必ずバックエンドに委譲してください。",
  "『待って、赤じゃなくて青を右に』のような訂正では未確定の操作を止めて新しい荷物を指定します。",
  "相づちは停止指示ではありません。ツールの受付と移動完了を区別し、完了していない移動を完了したと言わないでください。",
].join("\n");

export const BACKEND_INSTRUCTIONS = [
  "Operate only the cargo game using the provided tools. Red/blue cargo moves left/right.",
  "Use move_cargo for a move, cancel_pending for an explicit stop, and replace_cargo for a correction.",
  "For a correction combine cancellation and replacement in one replace_cargo call.",
  "If the corrected destination is omitted, preserve the destination from the user's previous request.",
  "Do not interpret acknowledgments as cancellations. Ask briefly if the intended move is ambiguous.",
  "A queued result means accepted, not completed. Follow the authoritative tool result.",
].join("\n");

const cargoParameters = {
  type: "object",
  properties: {
    cargo: { type: "string", enum: ["red", "blue"] },
    destination: { type: "string", enum: ["left", "right"] },
  },
  required: ["cargo", "destination"],
  additionalProperties: false,
};

export const GAME_TOOLS = [
  { type: "function", name: "move_cargo", description: "Queue cargo movement.", strict: true, parameters: cargoParameters },
  { type: "function", name: "cancel_pending", description: "Request stopping uncommitted game operations.", strict: true,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
  { type: "function", name: "replace_cargo", description: "Request cancellation and queue the corrected cargo movement.",
    strict: true, parameters: cargoParameters },
] as const;

export function sessionConfiguration(liveModel: string, backendModel: string) {
  return {
    model: liveModel,
    instructions: VOICE_INSTRUCTIONS,
    audio: { output: { voice: "marin" } },
    delegation: {
      type: "responses",
      responses: {
        model: backendModel,
        instructions: BACKEND_INSTRUCTIONS,
        tools: GAME_TOOLS,
        tool_choice: "auto",
        parallel_tool_calls: false,
      },
    },
  };
}

export function serviceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

export function completedTool(event: unknown): { request: CommandRequest | null; callId: string; delegationId: string } | null {
  const envelope = object(event);
  if (envelope?.type !== "response.event" || !serviceId(envelope.delegation_id)) return null;
  const nested = object(envelope.event);
  const item = object(nested?.item);
  if (nested?.type !== "response.output_item.done" || item?.type !== "function_call" || !serviceId(item.call_id)) return null;
  let request: CommandRequest | null = null;
  try {
    if (typeof item.arguments !== "string" || item.arguments.length > 2_048) throw new Error("invalid_arguments");
    const args = object(JSON.parse(item.arguments));
    if (!args || Object.hasOwn(args, "type")) throw new Error("invalid_arguments");
    const type = item.name === "move_cargo" ? "move" : item.name === "cancel_pending" ? "cancel"
      : item.name === "replace_cargo" ? "replace" : null;
    if (!type) throw new Error("unknown_tool");
    request = {
      callId: item.call_id,
      delegationId: envelope.delegation_id,
      command: parseGameCommand({ ...args, type }),
    };
  } catch {
    // Invalid completed calls still receive a bounded rejection, never raw model arguments.
  }
  return { request, callId: item.call_id, delegationId: envelope.delegation_id };
}

export function finalUsage(event: unknown): Record<string, number> | null {
  const message = object(event);
  if (message?.type !== "session.closed") return null;
  const usage = object(message.usage);
  if (!usage) return null;
  return Object.fromEntries(Object.entries(usage)
    .filter((entry): entry is [string, number] => /^[a-z][a-z0-9_]{0,60}$/.test(entry[0])
      && typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0)
    .slice(0, 32));
}

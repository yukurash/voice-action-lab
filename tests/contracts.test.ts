import assert from "node:assert/strict";
import test from "node:test";
import { parseGameCommand } from "../packages/contracts/index.ts";

test("valid move and replace commands preserve the allowlisted values", () => {
  for (const type of ["move", "replace"] as const) {
    for (const cargo of ["red", "blue"] as const) {
      for (const destination of ["left", "right"] as const) {
        const value = { type, cargo, destination };
        assert.deepEqual(parseGameCommand(value), value);
      }
    }
  }
});

test("cancel accepts no additional command fields", () => {
  assert.deepEqual(parseGameCommand({ type: "cancel" }), { type: "cancel" });
  assert.throws(() => parseGameCommand({ type: "cancel", cargo: "red" }));
});

test("invalid payloads, unknown actions and extra fields fail explicitly", () => {
  for (const value of [
    null, [], true, "cancel", 1, {},
    { type: "execute", command: "anything" },
    { type: "move", cargo: "green", destination: "right" },
    { type: "move", cargo: "red", destination: "outside" },
    { type: "move", cargo: "red", destination: "right", script: "unexpected" },
  ]) assert.throws(() => parseGameCommand(value));
});

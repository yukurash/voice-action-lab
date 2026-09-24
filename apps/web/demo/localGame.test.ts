import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalGame } from "./localGame.ts";

test("local demo is simulation-only and never wraps a stopped engine", () => {
  const game = new LocalGame("cancel-actions");
  assert.equal(game.snapshot().session.source, "simulation");
  assert.equal(game.snapshot().session.transport, "disconnected");
  game.execute({ type: "move", cargo: "red", destination: "right" });
  game.advance();
  game.stop();
  game.advance();
  assert.equal(game.elapsedMs, 3_000);
  assert.equal(game.snapshot().game.cargo.red, 1);
  assert.throws(() => game.execute({ type: "cancel" }), /停止済み/);
});

test("public demo bounds command history with an explicit reset message", () => {
  const game = new LocalGame();
  for (let index = 0; index < 100; index++) game.execute({ type: "cancel" });
  assert.throws(() => game.execute({ type: "cancel" }), /100操作/);
  assert.equal(game.snapshot().game.events.length, 200);
  assert.equal(new LocalGame().snapshot().game.events.length, 0);
});

import type { BrowserState, CommandResult, ExperimentMode, GameCommand } from "../../../packages/contracts/index.ts";
import { GameEngine } from "../../../packages/game-engine/index.ts";

export class LocalGame {
  readonly engine: GameEngine;
  elapsedMs = 0;
  #commands = 0;

  constructor(mode: ExperimentMode = "voice-only") {
    this.engine = new GameEngine({
      mode, runId: "browser-demo", now: () => this.elapsedMs, stepIntervalMs: 3_000,
    });
  }

  execute(command: GameCommand): CommandResult {
    if (this.engine.snapshot().stopped) throw new Error("停止済みです。「最初から」で新しいデモを始めてください。");
    if (this.#commands >= 100) throw new Error("デモの100操作に達しました。「最初から」でリセットしてください。");
    const id = `demo-${++this.#commands}`;
    this.engine.registerDelegation(id);
    const result = this.engine.dispatch({ callId: id, delegationId: id, command });
    if (result.outcome === "rejected") throw new Error(`操作を実行できませんでした。${result.reason}`);
    return result;
  }

  advance(): void {
    if (this.engine.snapshot().stopped) return;
    this.elapsedMs += 3_000;
    this.engine.tick();
  }

  stop(): void {
    this.engine.stop("public_demo_emergency_stop");
  }

  snapshot(): BrowserState {
    return {
      game: this.engine.snapshot(),
      session: {
        source: "simulation", transport: "disconnected", expiresAt: null,
        recording: false, message: "説明用デモ。サーバー・マイク・AIには接続していません。",
      },
    };
  }
}

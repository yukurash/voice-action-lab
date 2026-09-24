import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ExperimentMode, GameCommand } from "../../../packages/contracts/index.ts";
import { GameBoard, Glyph, Operations, Timeline } from "../src/LabPanels.tsx";
import { LocalGame } from "./localGame.ts";
import "../src/styles.css";
import "./style.css";

const modes = [
  { id: "voice-only", letter: "A", title: "操作の取消なし", description: "「待って」を記録しても、箱は動き続ける" },
  { id: "cancel-actions", letter: "B", title: "未確定の操作も取消", description: "これからの移動を止める。元の位置には戻さない" },
] as const;

function Demo() {
  const [game, setGame] = useState(() => new LocalGame());
  const [state, setState] = useState(() => game.snapshot());
  const [automatic, setAutomatic] = useState(false);
  const [notice, setNotice] = useState("「赤を右へ」→「1マス進める」を2回→「赤じゃなく青を右へ」の順で試してみてください。");
  const [error, setError] = useState<string | null>(null);
  const pending = state.game.operations.some(operation => operation.status === "queued" || operation.status === "running");
  const advance = useCallback(() => {
    game.advance();
    setState(game.snapshot());
  }, [game]);

  useEffect(() => {
    if (!automatic || !pending || state.game.stopped) return;
    const timer = setInterval(advance, 3_000);
    return () => clearInterval(timer);
  }, [automatic, pending, state.game.stopped, advance]);

  const reset = (mode: ExperimentMode) => {
    game.stop();
    const next = new LocalGame(mode);
    setGame(next);
    setState(next.snapshot());
    setAutomatic(false);
    setError(null);
    setNotice("盤面とイベントをリセットしました。「赤を右へ」から始めてください。");
  };
  const send = (command: GameCommand) => {
    try {
      const result = game.execute(command);
      setState(game.snapshot());
      setError(null);
      setNotice(result.outcome === "observed-not-applied"
        ? "A：取消意図を記録しましたが、残りの操作には適用しません。さらに1マス進めて確認できます。"
        : command.type === "cancel" ? "B：未確定の操作を取り消しました。すでに進んだ位置は残ります。"
          : command.type === "replace"
            ? state.game.mode === "voice-only" ? "A：赤は続行し、その後に青を運びます。" : "B：赤の残りを取り消し、青への指示を登録しました。"
            : "赤の移動を登録しました。「1マス進める」または自動進行で動かせます。");
    } catch (failure) {
      setAutomatic(false);
      setError(failure instanceof Error ? failure.message : "操作に失敗しました。ページを再読み込みしてください。");
    }
  };
  const stop = () => {
    game.stop();
    setState(game.snapshot());
    setAutomatic(false);
    setNotice("すべて停止しました。緊急停止はA/B共通です。「最初から」で再開できます。");
  };

  return <div className="app-shell public-demo">
    <header className="topbar">
      <a className="brand" href="#main"><span className="brand-mark"><Glyph name="box" size={23} /></span><span>Voice Action <b>Lab</b><small>画面を体験する公開デモ</small></span></a>
      <div className="topbar-right"><a className="demo-source" href="https://github.com/yukurash/voice-action-lab">GitHub</a><button className="emergency-button" onClick={stop} disabled={state.game.stopped}><Glyph name="stop" size={17} />すべて停止</button></div>
    </header>
    <main id="main">
      <section className="intro">
        <div><p className="eyebrow">INTERACTIVE UI DEMO / NO AI CONNECTION</p><h1>「待って」のあと、<span>箱は止まる？</span></h1><p className="intro-copy">検証に使った配送フィールド・操作キュー・タイムラインを、音声なしで体験できます。</p></div>
        <div className="session-clock"><span>DEMO CLOCK</span><strong>{game.elapsedMs / 1_000}<small>秒相当</small></strong><span>実測ではないデモ時間</span></div>
      </section>
      <div className="source-banner simulation"><div><strong>説明用シミュレーション — 実音声の検証ではありません</strong></div><span>マイク不要 / Azure接続なし / ログイン不要</span></div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="lab-grid">
        <section className="panel field-panel" aria-labelledby="field-heading">
          <div className="section-heading"><h2 id="field-heading">配送フィールド</h2><span className="run-id">DEMO / epoch {state.game.epoch}</span></div>
          <GameBoard state={state} stale={false} local />
          <div className="commit-note"><span className="commit-icon">↳</span><div><strong>止められるのは、これからの操作。</strong><p>検証版と同じ操作エンジンをブラウザー内で実行。ボタンは認識済みの指示を表し、音声認識やモデルの判断は再現しません。</p></div></div>
        </section>
        <section className="panel connection-panel" aria-labelledby="session-heading">
          <div className="section-heading"><h2 id="session-heading">ボタンで指示する</h2><span className="eyebrow">LOCAL ONLY</span></div>
          <fieldset className="mode-picker"><legend>01 <span>A/Bを切替（盤面をリセット）</span></legend>
            {modes.map(mode => <label className={`mode-option ${state.game.mode === mode.id ? "selected" : ""}`} key={mode.id}>
              <input type="radio" name="mode" checked={state.game.mode === mode.id} onChange={() => reset(mode.id)} />
              <span className="mode-letter">{mode.letter}</span><span className="mode-copy"><strong>{mode.title}</strong><small>{mode.description}</small></span><span className="radio-dot" />
            </label>)}
          </fieldset>
          <div className="demo-controls">
            <fieldset disabled={state.game.stopped}><legend>02 指示を選ぶ</legend>
              <button className="button primary" onClick={() => send({ type: "move", cargo: "red", destination: "right" })}>赤を右へ</button>
              <button className="button" onClick={() => send({ type: "cancel" })}>待って（取消）</button>
              <button className="button" onClick={() => send({ type: "replace", cargo: "blue", destination: "right" })}>赤じゃなく青を右へ</button>
            </fieldset>
            <button className="button" disabled={!pending || state.game.stopped || automatic} onClick={advance}>1マス進める</button>
            <label className="demo-auto"><input type="checkbox" checked={automatic} disabled={state.game.stopped} onChange={event => setAutomatic(event.target.checked)} />自動で進める（3秒ごと）</label>
            <p className="panel-footnote">自動進行のOFFはデモ時計の一時停止です。操作の「取消」とは別です。</p>
            <button className="button" onClick={() => reset(state.game.mode)}>最初から</button>
          </div>
        </section>
        <section className="panel command-panel demo-guide" aria-labelledby="guide-heading">
          <div className="section-heading"><h2 id="guide-heading">ここを見てみよう</h2><span className="eyebrow">HOW TO TRY</span></div>
          <ol><li>赤を右へ動かし、2マス進んだところで「赤じゃなく青」を押す。</li><li>Aは赤が続行。Bは赤の残りを取り消し、青が動く。</li><li>キューの「取消済み」と、タイムラインの取消イベントを確認する。</li></ol>
          <p className="demo-notice" role="status">{notice}</p>
        </section>
        <Timeline state={state} transcripts={[]} local />
        <Operations state={state} local />
      </div>
      <footer className="demo-footer"><p>公開しているのは画面と操作の仕組みだけです。音声・字幕・実測ログ・原稿は含みません。</p><p>操作と状態はこのタブのメモリ内のみ。再読み込みで消えます。マイク・録音・音声出力・モデル呼出し・データ送信は行いません。</p></footer>
    </main>
  </div>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Demo root is missing.");
createRoot(root).render(<StrictMode><Demo /></StrictMode>);

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { BrowserState, CargoColor, Destination, ExperimentMode, LabEvent, Operation } from "../../../packages/contracts/index.ts";
import { errorMessage, idleWarning } from "./api.ts";
import { useLab } from "./useLab.ts";
import { useLocalRecording } from "./useLocalRecording.ts";
import { LocalSessionPanel } from "./LocalSessionPanel.tsx";

const modes: { id: ExperimentMode; letter: string; title: string; description: string }[] = [
  { id: "voice-only", letter: "A", title: "音声だけを止める", description: "割り込み時、操作の取消は適用しない" },
  { id: "cancel-actions", letter: "B", title: "音声 ＋ 操作を取り消す", description: "未確定の操作も取り消す" },
];

const operationLabels: Record<Operation["status"], string> = {
  queued: "待機中", running: "移動中", completed: "完了", cancelled: "取消済み", failed: "失敗",
};

const phaseLabels = {
  idle: "未接続", microphone: "マイクの許可待ち", connecting: "音声接続中",
  connected: "実音声 接続中", closing: "停止・切断中", error: "接続を確認",
};

function Glyph({ name, size = 20 }: { name: "mic" | "stop" | "arrow" | "sound" | "link" | "box"; size?: number }) {
  const paths: Record<typeof name, ReactNode> = {
    mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3m-3 0h6" /></>,
    stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    sound: <><path d="m11 5-6 4H2v6h3l6 4V5Z" /><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
    link: <><path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 1)" /></>,
    box: <><path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10v9M3 8l9 5 9-5M8 5l9 5" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function relativeTime(atMs: number, origin: number): string {
  return `+${(Math.max(0, atMs - origin) / 1_000).toFixed(1)}s`;
}

function eventCategory(kind: string): { label: string; className: string } {
  if (/commit/i.test(kind)) return { label: "確定", className: "commit" };
  if (/cancel|interrupt|invalidat|epoch/i.test(kind)) return { label: "取消", className: "cancel" };
  if (/speech|voice|audio|transcript|response/i.test(kind)) return { label: "音声", className: "speech" };
  if (/operation|move|step|queue|replace|action/i.test(kind)) return { label: "操作", className: "action" };
  return { label: "状態", className: "system" };
}

function eventDescription(event: LabEvent): string {
  return Object.entries(event.details)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
}

function RemoteAudio({ stream, connected, stopping }: { stream: MediaStream | null; connected: boolean; stopping: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let disposed = false;
    element.srcObject = stream;
    setPlaying(false);
    setPlaybackError(null);
    if (stream?.getAudioTracks().length) {
      void element.play().catch((failure: unknown) => {
        if (!disposed) setPlaybackError(`音声を自動再生できません。「音声を再生」を押してください。${errorMessage(failure)}`);
      });
    }
    return () => {
      disposed = true;
      element.pause();
      element.srcObject = null;
    };
  }, [stream]);

  const resume = async () => {
    if (!ref.current) return;
    try {
      await ref.current.play();
      setPlaybackError(null);
    } catch (failure) {
      setPlaybackError(`音声を再生できません。ブラウザーの音声設定を確認してください。${errorMessage(failure)}`);
    }
  };

  return <div className="audio-status">
    <audio ref={ref} autoPlay playsInline muted={stopping}
      onPlaying={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onError={() => setPlaybackError("受信音声の再生に失敗しました。接続とブラウザーの音声設定を確認してください。")} />
    <span className={`status-dot ${playing && !stopping ? "green" : ""}`} />
    <span>{stopping ? "音声出力をミュート済み" : playing ? "受信音声の再生準備完了" : connected ? "受信音声を待機" : "音声出力は未接続"}</span>
    {playbackError && <div className="inline-error" role="alert">
      <p>{playbackError}</p>
      <button className="button small" onClick={() => void resume()}><Glyph name="sound" size={15} />音声を再生</button>
    </div>}
  </div>;
}

function Cargo({ color, position, moving }: { color: CargoColor; position: number; moving: boolean }) {
  const style: CSSProperties = { left: `${position / 6 * 100}%` };
  return <div className={`cargo-cart ${color} ${moving ? "moving" : ""}`} style={style}
    aria-label={`${color === "red" ? "赤" : "青"}の箱、位置 ${position}`}>
    <span className="cart-position">x = {position}</span>
    <svg viewBox="0 0 110 105" role="img" aria-label={color === "red" ? "赤い箱を載せた台車" : "青い箱を載せた台車"}>
      <ellipse cx="55" cy="95" rx="44" ry="6" fill="currentColor" opacity=".08" />
      <path d="m29 29 30-14 28 15-30 15-28-16Z" className="box-top" />
      <path d="M29 29v39l28 16V45L29 29Z" className="box-front" />
      <path d="m57 45 30-15v39L57 84V45Z" className="box-side" />
      <path d="m41 23 28 16v14l8-4V35L49 19Z" fill="#fff" opacity=".33" />
      <path d="m36 54 13 7m-13 0 8 4" stroke="#fff" strokeWidth="2" opacity=".75" />
      <path d="M16 75h73l5 8H23l-7-8Z" fill="#243b46" />
      <path d="M17 75 11 61H6" fill="none" stroke="#243b46" strokeWidth="4" strokeLinecap="round" />
      <circle cx="31" cy="88" r="7" fill="#243b46" /><circle cx="82" cy="88" r="7" fill="#243b46" />
      <circle cx="31" cy="88" r="3" fill="#f5f3ed" /><circle cx="82" cy="88" r="3" fill="#f5f3ed" />
    </svg>
    <span className="cart-label">{color === "red" ? "赤 RED" : "青 BLUE"}</span>
  </div>;
}

function GameBoard({ state, stale }: { state: BrowserState | null; stale: boolean }) {
  const snapshot = state?.game;
  return <section className={`game-board ${stale ? "stale" : ""}`} aria-label="サーバー状態に基づく配送フィールド">
    <div className="board-caption"><span><span className={`status-dot ${!stale && state ? "green" : ""}`} />{stale ? "更新待ち · 最後に受信した状態" : "サーバーの確定状態"}</span><span>2 TRACKS / x = 0…6</span></div>
    <div className="destination-headings"><span><span className="destination-symbol">←</span> 左へ <small>LEFT DOCK</small></span><span>右へ <small>RIGHT DOCK</small><span className="destination-symbol">→</span></span></div>
    <div className="track-field">
      <div className="dock dock-left" aria-hidden="true"><span>0</span><i /><i /><i /></div>
      <div className="dock dock-right" aria-hidden="true"><span>6</span><i /><i /><i /></div>
      {(["red", "blue"] as const).map((color, index) => <div className={`track track-${color}`} key={`${snapshot?.runId ?? "empty"}-${color}`}>
        <span className="track-number" aria-hidden="true">0{index + 1}</span>
        <div className="rail"><div className="rail-line" />
          <div className="rail-ticks" aria-hidden="true">{Array.from({ length: 7 }, (_, x) => <span key={x}><i />{x}</span>)}</div>
          {snapshot && <Cargo color={color} position={snapshot.cargo[color]}
            moving={!snapshot.stopped && snapshot.operations.some((operation) => operation.cargo === color && operation.status === "running")} />}
        </div>
      </div>)}
      {!snapshot && <div className="board-empty"><Glyph name="box" size={28} /><strong>フィールドの状態を待っています</strong><span>接続前の移動や成功は表示しません。</span></div>}
    </div>
    <div className="board-footer"><span><i className="legend-square red" /> 赤の箱</span><span><i className="legend-square blue" /> 青の箱</span><span className="board-state">{snapshot ? snapshot.stopped ? "停止中" : "実行可能" : "未接続"}<span aria-hidden="true"> / </span>位置はサーバーから更新</span></div>
  </section>;
}

function Operations({ state }: { state: BrowserState | null }) {
  const operations = state?.game.operations ?? [];
  const active = operations.filter((operation) => operation.status === "queued" || operation.status === "running").length;
  return <section className="panel operations-panel" aria-labelledby="operations-heading">
    <div className="section-heading"><h2 id="operations-heading">操作キュー <span className="count">{active}</span></h2><span className="eyebrow">OPERATIONS</span></div>
    <div className="operations-scroll">
      {operations.length ? [...operations].reverse().map((operation) => <div className="operation-row" key={operation.id}>
        <span className={`operation-cargo ${operation.cargo}`}><Glyph name="box" size={20} /></span>
        <div className="operation-copy"><strong>{operation.cargo === "red" ? "赤" : "青"}の箱 <span aria-hidden="true">→</span> {operation.destination === "left" ? "左" : "右"}</strong><span title={operation.id}>{operation.id} · epoch {operation.epoch}</span></div>
        <span className={`operation-status ${operation.status}`}>{operationLabels[operation.status]}</span>
      </div>) : <div className="empty-state"><span className="empty-line" /><p>操作はまだありません</p><span>声、またはシミュレーションで指示します。</span></div>}
    </div>
    <p className="panel-footnote">「取消済み」は未確定の残りの操作が対象。すでに確定した移動は元に戻りません。</p>
  </section>;
}

function Timeline({ state, transcripts }: { state: BrowserState | null; transcripts: ReturnType<typeof useLab>["transcripts"] }) {
  const [filter, setFilter] = useState("all");
  const events = state?.game.events ?? [];
  const origin = events[0]?.atMs ?? 0;
  const filtered = filter === "all" ? events : events.filter((event) => eventCategory(event.kind).className === filter);
  return <section className="panel timeline-panel" aria-labelledby="timeline-heading">
    <div className="section-heading"><h2 id="timeline-heading">実行タイムライン</h2><span className="eyebrow">EVENT LOG</span></div>
    <div className="timeline-controls">
      <div className="filter-group" role="group" aria-label="タイムラインの絞り込み">
        {[["all", "すべて"], ["speech", "音声"], ["action", "操作"], ["cancel", "取消"], ["commit", "確定"]].map(([id, label]) =>
          <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id ?? "all")}>{label}</button>)}
      </div>
      <span className="timeline-count">{filtered.length} events · 新しい順</span>
    </div>
    <div className="timeline-scroll" tabIndex={0} role="region" aria-label="サーバーイベント一覧">
      {filtered.length ? [...filtered].reverse().map((event) => {
        const category = eventCategory(event.kind);
        return <div className="event-row" key={`${state?.game.runId}-${event.sequence}`}>
          <time>{relativeTime(event.atMs, origin)}</time><span className={`event-category ${category.className}`}>{category.label}</span>
          <div className="event-copy"><strong>{event.kind}</strong><p>{eventDescription(event) || (event.operationId ? `operation: ${event.operationId}` : `sequence: ${event.sequence}`)}</p></div>
        </div>;
      }) : <div className="empty-state"><p>{events.length ? "この種類のイベントはありません" : "まだイベントはありません"}</p><span>サーバーが送信した音声・操作・確定イベントを表示します。</span></div>}
    </div>
    <details className="transcript-details">
      <summary>音声の一時字幕 <span>ブラウザー内のみ · {transcripts.length} 件</span></summary>
      <div className="transcript-scroll">{transcripts.length ? transcripts.map((entry) =>
        <p key={entry.id}><strong>{entry.speaker === "user" ? "あなた" : "アシスタント"}</strong>{entry.text}</p>)
        : <p>実音声の transcript.delta を受信すると表示します。</p>}</div>
      <p>字幕イベントは音声停止時刻の測定ではありません。</p>
    </details>
  </section>;
}

export function App() {
  const lab = useLab();
  const [selectedMode, setSelectedMode] = useState<ExperimentMode>("voice-only");
  const [cargo, setCargo] = useState<CargoColor>("red");
  const [destination, setDestination] = useState<Destination>("right");
  const [now, setNow] = useState(Date.now);
  const [localDeadline, setLocalDeadline] = useState<number | null>(null);
  const expiryStopped = useRef<string | null>(null);
  const recording = useLocalRecording(lab.mic, lab.remote, lab.audioContext);
  const state = lab.state;
  const serverActive = state?.session.transport === "connected" || state?.session.transport === "connecting" || state?.session.transport === "closing";
  const liveLocal = lab.phase === "connected" || lab.phase === "connecting" || lab.phase === "microphone";
  const active = serverActive || liveLocal || lab.busy;
  const actualMode = serverActive && state ? state.game.mode : selectedMode;
  const currentMode = modes.find((mode) => mode.id === actualMode) ?? modes[0];
  const source = liveLocal ? "live" : state?.session.source;
  const isSimulation = source === "simulation";
  const simulationActive = state?.session.source === "simulation" && state.session.transport === "connected" && !state.game.stopped;
  const canCommand = simulationActive && !lab.busy && lab.feed === "connected" && !lab.feedError;
  const expiresAt = (serverActive ? state?.session.expiresAt : null) ?? lab.localExpiresAt;
  const serverDeadline = expiresAt ? Date.parse(expiresAt) : null;
  const deadline = serverDeadline !== null && localDeadline !== null ? Math.min(serverDeadline, localDeadline) : serverDeadline ?? localDeadline;
  const timeLeft = deadline === null ? 600_000 : Math.min(600_000, Math.max(0, deadline - now));
  const warning = idleWarning(state);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!active && !lab.busy) setLocalDeadline(null);
  }, [active, lab.busy]);

  useEffect(() => {
    if (serverActive && state) setSelectedMode(state.game.mode);
  }, [serverActive, state?.game.mode]);

  useEffect(() => {
    if (!active || lab.phase === "closing" || deadline === null || now < deadline) return;
    const key = `${state?.game.runId ?? "startup"}:${deadline}`;
    if (expiryStopped.current === key) return;
    expiryStopped.current = key;
    void lab.end();
  }, [active, deadline, now, lab.end, lab.phase, state?.game.runId]);

  const start = (type: "simulation" | "live") => {
    setLocalDeadline(Date.now() + 600_000);
    expiryStopped.current = null;
    if (type === "live") void lab.connectLive(selectedMode);
    else void lab.startSimulation(selectedMode);
  };

  const stopAll = () => {
    recording.stop();
    void lab.end();
  };

  const connectionLabel = lab.phase !== "idle" ? phaseLabels[lab.phase]
    : state?.session.transport === "connected"
      ? isSimulation ? "シミュレーション実行中" : "サーバーに実音声セッションあり"
      : state?.session.transport === "error" ? "サーバー接続エラー" : "未接続";

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#main" aria-label="Voice Action Lab メイン画面へ"><span className="brand-mark"><Glyph name="box" size={23} /></span><span>Voice Action <b>Lab</b><small>声と操作のインタラクション実験</small></span></a>
      <div className="topbar-right"><span className="local-tag">ONE MIC. ONE SESSION.</span><button className="emergency-button" onClick={stopAll} disabled={lab.phase === "closing"}><Glyph name="stop" size={17} />すべて停止<span>緊急停止</span></button></div>
    </header>
    <main id="main">
      <section className="intro">
        <div><p className="eyebrow">INTERRUPTION / CANCELLATION</p><h1>声を止める。<span>動きは、どこまで止まる？</span></h1><p className="intro-copy">同じマイクで A → B を順番に実行。音声の割り込みと、操作の取消を見比べます。</p></div>
        <div className={`session-clock ${active && timeLeft < 60_000 ? "urgent" : ""}`}><span>SESSION LIMIT</span><strong>{active ? formatClock(timeLeft) : "10:00"}<small>{active ? "残り" : "上限"}</small></strong><span>1 回 最大 10 分 · 同時接続なし</span></div>
      </section>

      <div className={`source-banner ${isSimulation ? "simulation" : source === "live" ? "live" : "unselected"}`} role="status">
        <div><span className={`status-dot ${lab.phase === "connected" || simulationActive ? "green" : ""}`} /><strong>{isSimulation ? "シミュレーション（実音声の検証ではありません）" : source === "live" ? "実音声 · WebRTC" : "未接続 · ソース未選択"}</strong></div>
        <span>{currentMode?.letter} / {currentMode?.title}<i />{connectionLabel}</span>
      </div>
      {(lab.error || lab.feedError) && <div className="error-banner" role="alert"><div><strong>接続・操作を確認してください</strong>{lab.error && <p>{lab.error}</p>}{lab.feedError && <p>{lab.feedError}</p>}</div><button className="button small" onClick={lab.refresh}>状態を再取得</button></div>}
      {warning && <div className="warning-banner" role="alert"><strong>無操作の警告</strong><p>{warning}</p></div>}
      {active && deadline !== null && timeLeft === 0 && <div className="warning-banner" role="alert">10 分の上限、またはサーバーのセッション期限に達しました。停止・切断を実行します。</div>}

      <div className="lab-grid">
        <section className="panel field-panel" aria-labelledby="field-heading">
          <div className="section-heading"><h2 id="field-heading">配送フィールド <span className="subtle">声で箱を運ぶ</span></h2><span className="run-id" title={state?.game.runId}>RUN {state?.game.runId ? state.game.runId.slice(0, 8) : "—"} <span>/ epoch {state?.game.epoch ?? "—"}</span></span></div>
          <GameBoard state={state} stale={lab.feed !== "connected" || !!lab.feedError} />
          <div className="commit-note"><span className="commit-icon">↳</span><div><strong>止められるのは、これからの操作。</strong><p>プロトコル上の取消と、すでに確定した移動は別です。取消を送っても、確定済みの位置は巻き戻しません。</p></div></div>
        </section>

        <section className="panel connection-panel" aria-labelledby="session-heading">
          <div className="section-heading"><h2 id="session-heading">実験をはじめる</h2><span className="eyebrow">SESSION</span></div>
          <fieldset className="mode-picker" disabled={!lab.canStart}><legend>01 <span>開始前にモードを選択</span></legend>
            {modes.map((mode) => <label className={`mode-option ${selectedMode === mode.id ? "selected" : ""}`} key={mode.id}>
              <input type="radio" name="mode" value={mode.id} checked={selectedMode === mode.id} onChange={() => setSelectedMode(mode.id)} />
              <span className="mode-letter">{mode.letter}</span><span className="mode-copy"><strong>{mode.title}</strong><small>{mode.description}</small></span><span className="radio-dot" />
            </label>)}
          </fieldset>
          <div className="connect-section"><h3><span>02</span> 接続して、声で指示</h3>
            <button className="button primary connect-button" onClick={() => start("live")} disabled={!lab.canStart || !lab.config?.liveAvailable} aria-describedby="live-availability"><Glyph name="mic" size={18} />実音声に接続<Glyph name="arrow" size={18} /></button>
            <p id="live-availability" className="availability">{lab.config ? lab.config.liveAvailable ? lab.config.reason || "マイクの許可を確認してから接続します。" : `実音声は利用できません。${lab.config.reason}` : "実音声の利用可否を確認中…"}</p>
            <div className="simulation-start"><button className="button simulation-button" disabled={!lab.canStart} onClick={() => start("simulation")}>シミュレーションを開始</button><p>マイク不要 / 実音声の検証ではありません</p></div>
            <button className="button disconnect-button" disabled={!active || lab.phase === "closing"} onClick={stopAll}><Glyph name="link" size={15} />停止して切断</button>
          </div>
          <div className="connection-status">
            <div><Glyph name="mic" size={16} /><span>マイク</span><strong title={lab.micName}>{lab.micName}</strong></div>
            {lab.mic && lab.phase !== "connected" && <div>{lab.phase === "closing" ? "切断処理中・マイク送信停止中" : "接続準備中・マイク送信停止中"}</div>}
            <RemoteAudio stream={lab.remote} connected={lab.phase === "connected"} stopping={lab.phase === "closing"} />
            {lab.phase === "connected" && <div>入力・受信の活動通知は時刻のみ（音声・字幕は含みません）</div>}
            <div><span className={`status-dot ${lab.feed === "connected" && !lab.feedError ? "green" : ""}`} /><span>状態ストリーム</span><strong>{lab.feed === "connected" && !lab.feedError ? "接続済み" : "更新待ち"}</strong></div>
          </div>
          <p className="session-message">{state?.session.message || "A を停止・切断してから B を開始してください。"}</p>
        </section>

        <section className="panel command-panel" aria-labelledby="command-heading">
          <div className="section-heading"><h2 id="command-heading">試す指示</h2><span className="eyebrow">TRY SAYING</span></div>
          <div className="prompt-list"><div><span>01</span><p>「赤い箱を右に運んで」</p></div><div><span>02</span><p>途中で「待って、赤じゃなくて青を右に」</p></div><div><span>03</span><p>音声・取消・確定の違いを確認</p></div></div>
          <details className="manual-controls" open={simulationActive}>
            <summary>手動操作 <span>シミュレーション専用</span></summary>
            <fieldset disabled={!canCommand}><legend className="sr-only">シミュレーションの指示</legend>
              <div className="manual-selectors"><div><label htmlFor="command-cargo">箱</label><select id="command-cargo" value={cargo} onChange={(event) => {
                if (event.target.value === "red" || event.target.value === "blue") setCargo(event.target.value);
              }}><option value="red">赤の箱</option><option value="blue">青の箱</option></select></div>
                <div><label htmlFor="command-destination">行き先</label><select id="command-destination" value={destination} onChange={(event) => {
                  if (event.target.value === "left" || event.target.value === "right") setDestination(event.target.value);
                }}><option value="left">左 / x = 0</option><option value="right">右 / x = 6</option></select></div></div>
              <div className="manual-buttons"><button className="button small" onClick={() => void lab.sendCommand({ type: "move", cargo, destination })}>移動</button><button className="button small" onClick={() => void lab.sendCommand({ type: "replace", cargo, destination })}>指示を置換</button><button className="button small cancel-button" onClick={() => void lab.sendCommand({ type: "cancel" })}>取消を送信</button></div>
            </fieldset>
            <p className="panel-footnote">A は取消を観測しても操作には適用しません。B は未確定の操作を取り消します。</p>
          </details>
          {lab.notice && <p className="command-notice" role="status">{lab.notice}</p>}
        </section>

        <Timeline state={state} transcripts={lab.transcripts} />
        <Operations state={state} />
        <LocalSessionPanel state={state} active={active} getMeasurements={lab.getMeasurements} />

        <section className="panel recording-panel" aria-labelledby="recording-heading">
          <div className="recording-title"><h2 id="recording-heading"><span className={`status-dot ${recording.recording ? "red-dot" : ""}`} />任意のローカル録音</h2><span className="local-only">LOCAL ONLY</span></div>
          <p>マイク＋受信音声を、このブラウザーのメモリ内だけに保持。自動録音・アップロードはしません。</p>
          <div className="recording-actions">
            {!recording.recording
              ? <button className="button small" disabled={!recording.supported || lab.phase !== "connected" || !lab.remote?.getAudioTracks().length || recording.finalizing || !!recording.download} onClick={() => void recording.start()}>同意して録音を開始</button>
              : <button className="button small cancel-button" disabled={recording.finalizing} onClick={recording.stop}>{recording.finalizing ? "録音を処理中…" : "録音を停止"}</button>}
            {recording.download && <><a className="button small" href={recording.download.url} download={`voice-action-lab-local.${recording.download.extension}`}>音声をダウンロード</a><button className="text-button" onClick={recording.discard}>破棄</button><span>{(recording.download.bytes / 1_024).toFixed(0)} KB</span></>}
          </div>
          {!recording.supported && <p className="inline-error">このブラウザーはローカル録音に対応していません。</p>}
          {recording.error && <p className="inline-error" role="alert">{recording.error}</p>}
          <p className="recording-note">実音声の接続後に利用可能。再読み込みで消去されます。字幕から音声停止時間は推定しません。</p>
        </section>
      </div>
      <footer><span>VOICE ACTION LAB <b>/</b> 同じ入力で、違いを確かめる。</span><span>操作の確定はサーバーが管理 · 音声と操作は別の状態</span></footer>
    </main>
  </div>;
}

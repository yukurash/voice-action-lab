import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { BrowserState, CargoColor, LabEvent, Operation } from "../../../packages/contracts/index.ts";
import type { Transcript } from "./useLab.ts";

const operationLabels: Record<Operation["status"], string> = {
  queued: "待機中", running: "移動中", completed: "完了", cancelled: "取消済み", failed: "失敗",
};

export function Glyph({ name, size = 20 }: { name: "mic" | "stop" | "arrow" | "sound" | "link" | "box"; size?: number }) {
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

function relativeTime(milliseconds: number, origin: number): string {
  return `+${(Math.max(0, milliseconds - origin) / 1_000).toFixed(1)}s`;
}

function eventCategory(kind: string, local = false): { label: string; className: string } {
  if (/commit/i.test(kind) || (local && kind === "operation.step")) return { label: "確定", className: "commit" };
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

export function GameBoard({ state, stale, local = false }: { state: BrowserState | null; stale: boolean; local?: boolean }) {
  const snapshot = state?.game;
  return <section className={`game-board ${stale ? "stale" : ""}`} aria-label={local ? "ブラウザー内の配送フィールド" : "サーバー状態に基づく配送フィールド"}>
    <div className="board-caption"><span><span className={`status-dot ${!stale && state ? "green" : ""}`} />{stale ? "更新待ち · 最後に受信した状態" : local ? "ブラウザー内の説明用シミュレーション" : "サーバーの確定状態"}</span><span>2 TRACKS / x = 0…6</span></div>
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
    <div className="board-footer"><span><i className="legend-square red" /> 赤の箱</span><span><i className="legend-square blue" /> 青の箱</span><span className="board-state">{snapshot ? snapshot.stopped ? "停止中" : "実行可能" : "未接続"}<span aria-hidden="true"> / </span>{local ? "位置はブラウザー内で更新" : "位置はサーバーから更新"}</span></div>
  </section>;
}

export function Operations({ state, local = false }: { state: BrowserState | null; local?: boolean }) {
  const operations = state?.game.operations ?? [];
  const active = operations.filter((operation) => operation.status === "queued" || operation.status === "running").length;
  return <section className="panel operations-panel" aria-labelledby="operations-heading">
    <div className="section-heading"><h2 id="operations-heading">操作キュー <span className="count">{active}</span></h2><span className="eyebrow">OPERATIONS</span></div>
    <div className="operations-scroll">
      {operations.length ? [...operations].reverse().map((operation) => <div className="operation-row" key={operation.id}>
        <span className={`operation-cargo ${operation.cargo}`}><Glyph name="box" size={20} /></span>
        <div className="operation-copy"><strong>{operation.cargo === "red" ? "赤" : "青"}の箱 <span aria-hidden="true">→</span> {operation.destination === "left" ? "左" : "右"}</strong><span title={operation.id}>{operation.id} · epoch {operation.epoch}</span></div>
        <span className={`operation-status ${operation.status}`}>{operationLabels[operation.status]}</span>
      </div>) : <div className="empty-state"><span className="empty-line" /><p>操作はまだありません</p><span>{local ? "右側のボタンから指示します。" : "声、またはシミュレーションで指示します。"}</span></div>}
    </div>
    <p className="panel-footnote">「取消済み」は未確定の残りの操作が対象。すでに確定した移動は元に戻りません。</p>
  </section>;
}

export function Timeline({ state, transcripts, local = false }: { state: BrowserState | null; transcripts: readonly Transcript[]; local?: boolean }) {
  const [filter, setFilter] = useState("all");
  const events = state?.game.events ?? [];
  const origin = events[0]?.atMs ?? 0;
  const filtered = filter === "all" ? events : events.filter((event) => eventCategory(event.kind, local).className === filter);
  return <section className="panel timeline-panel" aria-labelledby="timeline-heading">
    <div className="section-heading"><h2 id="timeline-heading">実行タイムライン</h2><span className="eyebrow">EVENT LOG</span></div>
    <div className="timeline-controls">
      <div className="filter-group" role="group" aria-label="タイムラインの絞り込み">
        {[["all", "すべて"], ["speech", "音声"], ["action", "操作"], ["cancel", "取消"], ["commit", "確定"]].filter(([id]) => !local || id !== "speech").map(([id, label]) =>
          <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id ?? "all")}>{label}</button>)}
      </div>
      <span className="timeline-count">{filtered.length} events · 新しい順</span>
    </div>
    <div className="timeline-scroll" tabIndex={0} role="region" aria-label={local ? "ブラウザー内のイベント一覧" : "サーバーイベント一覧"}>
      {filtered.length ? [...filtered].reverse().map((event) => {
        const category = eventCategory(event.kind, local);
        return <div className="event-row" key={`${state?.game.runId}-${event.sequence}`}>
          <time>{relativeTime(event.atMs, origin)}</time><span className={`event-category ${category.className}`}>{category.label}</span>
          <div className="event-copy"><strong>{event.kind}</strong><p>{eventDescription(event) || (event.operationId ? `operation: ${event.operationId}` : `sequence: ${event.sequence}`)}</p></div>
        </div>;
      }) : <div className="empty-state"><p>{events.length ? "この種類のイベントはありません" : "まだイベントはありません"}</p><span>{local ? "操作すると説明用イベントが表示されます。音声や実測の記録ではありません。" : "サーバーが送信した音声・操作・確定イベントを表示します。"}</span></div>}
    </div>
    {local ? <p className="panel-footnote">時刻は手動／自動で進めたデモ時間です。通信遅延・音声の停止時間・検証結果を表すものではありません。</p> : <details className="transcript-details">
      <summary>音声の一時字幕 <span>ブラウザー内のみ · {transcripts.length} 件</span></summary>
      <div className="transcript-scroll">{transcripts.length ? transcripts.map((entry) =>
        <p key={entry.id}><strong>{entry.speaker === "user" ? "あなた" : "アシスタント"}</strong>{entry.text}</p>)
        : <p>実音声の transcript.delta を受信すると表示します。</p>}</div>
      <p>字幕イベントは音声停止時刻の測定ではありません。</p>
    </details>}
  </section>;
}

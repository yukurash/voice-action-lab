import { useEffect, useMemo, useRef, useState } from "react";
import type { BrowserState } from "../../../packages/contracts/index.ts";
import type { AudioMeasurementEvent, MeasurementSample } from "./audioMeasurement.ts";
import { errorMessage } from "./api.ts";
import { MAX_LOCAL_SESSION_BYTES, parseReplayDocument, sampleAt, serializeLocalSession } from "./localSession.ts";
import type { ReplayDocument } from "./localSession.ts";
import { SERVER_EXPORT_FORMAT } from "./serverExport.ts";

export function LocalSessionPanel({ state, active, getMeasurements }: {
  state: BrowserState | null;
  active: boolean;
  getMeasurements: () => readonly AudioMeasurementEvent[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<string | null>(null);
  const [replay, setReplay] = useState<ReplayDocument | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cursorMs, setCursorMs] = useState(0);
  const url = useRef<string | null>(null);
  const version = useRef(0);
  const serverReplay = replay?.format === SERVER_EXPORT_FORMAT ? replay : null;
  const serverEvents = useMemo(() => serverReplay
    ? [...serverReplay.snapshot.game.events].sort((left, right) => left.atMs - right.atMs || left.sequence - right.sequence)
    : [], [serverReplay]);
  const eventOriginMs = serverEvents[0]?.atMs ?? 0;
  const samples = useMemo(() => {
    const entries: readonly AudioMeasurementEvent[] = replay?.measurements ?? [];
    return {
      input: entries.filter((entry): entry is MeasurementSample => entry.type === "sample" && entry.direction === "input"),
      output: entries.filter((entry): entry is MeasurementSample => entry.type === "sample" && entry.direction === "output"),
    };
  }, [replay]);
  const first = Math.min(samples.input[0]?.windowStartTime ?? Infinity, samples.output[0]?.windowStartTime ?? Infinity);
  const origin = Number.isFinite(first) ? first : 0;
  const durationMs = serverReplay
    ? Math.max(0, (serverEvents.at(-1)?.atMs ?? eventOriginMs) - eventOriginMs)
    : Math.max(0, Math.max(samples.input.at(-1)?.contextTime ?? 0, samples.output.at(-1)?.contextTime ?? 0) - origin) * 1000;
  const visibleServerEvents = serverEvents.filter((event) => event.atMs <= eventOriginMs + cursorMs).slice(-12);

  useEffect(() => {
    if (active) {
      ++version.current;
      setPlaying(false);
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
      setDownload(null);
    }
  }, [active]);
  useEffect(() => () => {
    ++version.current;
    if (url.current) URL.revokeObjectURL(url.current);
  }, []);
  useEffect(() => {
    if (!playing || active) return;
    const started = performance.now();
    const from = cursorMs;
    const timer = setInterval(() => {
      const next = Math.min(durationMs, from + performance.now() - started);
      setCursorMs(next);
      if (next >= durationMs) setPlaying(false);
    }, 50);
    return () => clearInterval(timer);
  }, [active, durationMs, playing]);

  const prepare = () => {
    setError(null);
    try {
      if (active || !state) throw new Error("セッションを停止してから書き出してください。");
      const text = serializeLocalSession(state, getMeasurements());
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      setDownload(url.current);
    } catch (failure) { setError(errorMessage(failure)); }
  };
  const importFile = async (file: File) => {
    const token = ++version.current;
    setError(null);
    setPlaying(false);
    try {
      if (active) throw new Error("接続中はリプレイを読み込めません。");
      if (file.size > MAX_LOCAL_SESSION_BYTES) throw new Error("読み込みは32 MBまでです。");
      const loaded = parseReplayDocument(await file.text());
      if (version.current !== token) return;
      setReplay(loaded);
      setCursorMs(0);
    } catch (failure) {
      if (version.current === token) setError(errorMessage(failure));
    }
  };

  return <section className="panel local-session-panel" aria-labelledby="local-session-heading">
    <div className="section-heading"><h2 id="local-session-heading">計測・ローカルリプレイ</h2><span className="local-only">LOCAL ONLY</span></div>
    <p>PCMを20 msごとに測定。−45 dBFS以上が3窓で開始、未満が6窓で停止を確認します。音声波形は保存しません。</p>
    <p className="panel-footnote">計測メタデータ：{getMeasurements().length} レコード。受信PCMの活動であり、スピーカーから聞こえる時刻や字幕の時刻ではありません。</p>
    <div className="recording-actions">
      <button className="button small" disabled={active || !state?.game.stopped} onClick={prepare}>状態＋計測JSONを書き出す</button>
      {download && <a className="button small" href={download} download="voice-action-lab-local-session-v1.json">JSONをダウンロード</a>}
      <label className="local-import">ローカルJSONを読み込む
        <input type="file" accept=".json,application/json" disabled={active} onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void importFile(file);
        }} />
      </label>
    </div>
    <p className="panel-footnote">停止後に明示的に保存・読み込み。ローカル計測JSON（32 MB）とサーバー書き出し v1（2 MB）に対応。アップロードや操作の再送はしません。</p>
    <p className="panel-footnote">書き出しボタンは現在のセッション用です。発話・資格情報・サーバー識別子・イベント詳細を除去します。読み込んだファイルは変更しません。</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {replay && <div className="local-replay" aria-label="ローカルの計測リプレイ">
      <strong>ローカルリプレイ（接続・操作送信なし）</strong>
      <p>形式：{serverReplay ? "サーバー書き出し v1" : "ローカル計測アーカイブ v1"}</p>
      <p>記録元：{replay.snapshot.session.source === "live" ? "実音声" : "シミュレーション（実音声の検証ではありません）"} / {replay.snapshot.game.mode === "voice-only" ? "A" : "B"}</p>
      <p>保存時の最終位置：赤 x={replay.snapshot.game.cargo.red}、青 x={replay.snapshot.game.cargo.blue}。位置の履歴は再計算しません。</p>
      <p>操作 {replay.snapshot.game.operations.length} 件 / {serverReplay ? "保存イベント" : "匿名化イベント"} {replay.snapshot.game.events.length} 件</p>
      {serverReplay && <div className="server-export-summary">
        <p>保存時の接続状態：{serverReplay.snapshot.session.transport === "error" ? "エラー" : "切断済み"}</p>
        <p>最終利用量（音声セッション分のみ）：{serverReplay.server.usage.status === "confirmed" ? "確認済み" : serverReplay.server.usage.status === "unconfirmed" ? "未確認" : "対象外"}（ファイル記載）</p>
        {serverReplay.server.usage.metrics && <p>{Object.entries(serverReplay.server.usage.metrics).map(([key, value]) => `${key}: ${value}`).join(" / ") || "利用量の数値項目なし"}</p>}
        <p>終了 <time dateTime={serverReplay.server.closedAt}>{serverReplay.server.closedAt}</time> / 書き出し <time dateTime={serverReplay.server.exportedAt}>{serverReplay.server.exportedAt}</time></p>
        <p>設定：{serverReplay.server.settings.liveModel} / {serverReplay.server.settings.backendModel} / 移動間隔 {serverReplay.server.settings.stepIntervalMs} ms（表示のみ）</p>
        <p className="panel-footnote">この形式にはPCM計測窓がありません。入力とサーバーの時計は未同期です。イベントから可聴停止時間を推定しません。</p>
      </div>}
      <div className="recording-actions">
        <button className="button small" disabled={active || durationMs === 0} onClick={() => {
          if (cursorMs >= durationMs) setCursorMs(0);
          setPlaying((value) => !value);
        }}>{playing ? "リプレイを一時停止" : serverReplay ? "サーバーイベントをリプレイ" : "計測をリプレイ"}</button>
        <button className="text-button" disabled={active} onClick={() => {
          ++version.current;
          setPlaying(false);
          setReplay(null);
          setCursorMs(0);
        }}>リプレイを破棄</button>
        <output aria-live="off">{(cursorMs / 1000).toFixed(2)} / {(durationMs / 1000).toFixed(2)} s</output>
      </div>
      <label>{serverReplay ? "サーバーイベントの時刻" : "計測リプレイの時刻"}
        <input type="range" min={0} max={durationMs || 1} step={serverReplay ? 1 : 20} value={cursorMs} disabled={active || durationMs === 0}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (!Number.isFinite(next)) { setError("リプレイの時刻が不正です。"); return; }
            setPlaying(false);
            setCursorMs(Math.min(durationMs, Math.max(0, next)));
          }} />
      </label>
      {serverReplay ? <ol className="replay-event-list" aria-label="保存されたサーバーイベント">
        {visibleServerEvents.map((event, index) => <li key={`${event.sequence}-${index}`}>
          <time>+{((event.atMs - eventOriginMs) / 1000).toFixed(2)}s</time> <strong>{event.kind}</strong>
          {!!Object.keys(event.details).length && <code>{JSON.stringify(event.details)}</code>}
        </li>)}
        {!serverEvents.length && <li>サーバーイベントはありません。</li>}
      </ol> : (["input", "output"] as const).map((direction) => {
        const sample = sampleAt(samples[direction], origin + cursorMs / 1000);
        return <div className="measurement-row" key={direction}>
          <span>{direction === "input" ? "マイク入力" : "受信PCM"}</span>
          <meter min={0} max={1} value={Math.min(1, sample?.rms ?? 0)} aria-label={`${direction} RMS`} />
          <span>{sample ? `${sample.active ? "活動あり" : "非活動"} / RMS ${sample.rms.toFixed(5)}` : "サンプルなし"}</span>
        </div>;
      })}
      <p className="panel-footnote">再生対象は保存されたメタデータ／サーバーイベントだけです。音声再生、位置の再計算、ライブ計測イベントの発火、APIへの操作送信は行いません。読み込んだ内容は実測の真正性を保証しません。</p>
    </div>}
  </section>;
}

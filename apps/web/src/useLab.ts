import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserState, ExperimentMode, GameCommand } from "../../../packages/contracts/index.ts";
import {
  command,
  errorMessage,
  isBrowserState,
  isConfig,
  isRecord,
  isSessionAnswer,
  liveSessionReady,
  post,
  request,
} from "./api.ts";
import type { LabConfig, SessionAnswer } from "./api.ts";
import { waitForIceGathering, waitForPeerConnection } from "./webrtc.ts";

export type LocalPhase = "idle" | "microphone" | "connecting" | "connected" | "closing" | "error";
export type FeedStatus = "connecting" | "connected" | "reconnecting";
export interface Transcript {
  id: string;
  speaker: "user" | "assistant";
  text: string;
}

interface Resources {
  peer: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  mic: MediaStream | null;
  remote: MediaStream | null;
  timeout: ReturnType<typeof setTimeout> | null;
  checkReady: (() => void) | null;
  startup: AbortController | null;
}

function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "マイクの使用が許可されていません。ブラウザーのサイト設定で許可し、再度接続してください。";
    }
    if (error.name === "NotFoundError") return "使用できるマイクが見つかりません。接続を確認してください。";
    if (error.name === "NotReadableError") return "マイクを使用できません。他のアプリの使用状況を確認してください。";
    if (error.name === "OverconstrainedError") {
      return "前回と同じマイクを使用できません。接続し直してください。別のマイクへの自動切替は行いません。";
    }
  }
  return errorMessage(error);
}

export function useLab() {
  const [state, setState] = useState<BrowserState | null>(null);
  const [config, setConfig] = useState<LabConfig | null>(null);
  const [phase, setPhase] = useState<LocalPhase>("idle");
  const [feed, setFeed] = useState<FeedStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mic, setMic] = useState<MediaStream | null>(null);
  const [remote, setRemote] = useState<MediaStream | null>(null);
  const [micName, setMicName] = useState("未使用");
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [localExpiresAt, setLocalExpiresAt] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const stateRef = useRef<BrowserState | null>(null);
  const resources = useRef<Resources>({ peer: null, channel: null, mic: null, remote: null, timeout: null, checkReady: null, startup: null });
  const mounted = useRef(false);
  const generation = useRef(0);
  const locked = useRef(false);
  const liveAttempt = useRef(false);
  const observedLiveSession = useRef(false);
  const stateRevision = useRef(0);
  const micDeviceId = useRef<string | null>(null);
  const exchange = useRef<Promise<SessionAnswer> | null>(null);
  const readyExchange = useRef<Promise<BrowserState> | null>(null);
  const simulationStart = useRef<Promise<BrowserState> | null>(null);
  const stopping = useRef<Promise<void> | null>(null);
  const endRef = useRef<() => Promise<void>>(async () => {});

  const applyState = useCallback((next: BrowserState) => {
    if (!mounted.current) return;
    const previous = stateRef.current;
    const lastSequence = (snapshot: BrowserState) => snapshot.game.events.at(-1)?.sequence ?? -1;
    if (previous?.game.runId === next.game.runId && lastSequence(next) < lastSequence(previous)) return;
    stateRef.current = next;
    ++stateRevision.current;
    if (liveAttempt.current && next.session.source === "live" && !next.game.stopped
      && (next.session.transport === "connecting" || next.session.transport === "connected")) {
      observedLiveSession.current = true;
    }
    setState(next);
    resources.current.checkReady?.();
  }, []);

  const disposeMedia = useCallback(() => {
    const current = resources.current;
    current.checkReady = null;
    current.startup?.abort();
    if (current.timeout !== null) clearTimeout(current.timeout);
    if (current.channel) {
      current.channel.onmessage = null;
      current.channel.onopen = null;
      current.channel.onerror = null;
      current.channel.onclose = null;
      current.channel.close();
    }
    if (current.peer) {
      current.peer.ontrack = null;
      current.peer.onconnectionstatechange = null;
      current.peer.close();
    }
    for (const track of current.mic?.getTracks() ?? []) {
      track.onended = null;
      track.enabled = false;
      track.stop();
    }
    for (const track of current.remote?.getTracks() ?? []) track.stop();
    resources.current = { peer: null, channel: null, mic: null, remote: null, timeout: null, checkReady: null, startup: null };
    if (mounted.current) {
      setMic(null);
      setRemote(null);
      setLocalExpiresAt(null);
    }
  }, []);

  const end = useCallback((): Promise<void> => {
    if (stopping.current) return stopping.current;
    const shouldCloseLive = liveAttempt.current || stateRef.current?.session.source === "live";
    const pendingExchange = exchange.current;
    const pendingReady = readyExchange.current;
    const pendingSimulation = simulationStart.current;
    const token = ++generation.current;
    locked.current = true;
    disposeMedia();
    if (mounted.current) {
      setPhase("closing");
      setBusy(true);
    }
    const work = async () => {
      const failures: string[] = [];
      try {
        applyState(await post("/api/stop", {}, isBrowserState));
      } catch (failure) {
        failures.push(`緊急停止をサーバーで確認できませんでした。${errorMessage(failure)}`);
      }
      // A cancelled SDP request can still create a server session. Close it only after it settles.
      if (pendingExchange) {
        const settled = await Promise.allSettled([pendingExchange]);
        const result = settled[0];
        if (result?.status === "rejected" && mounted.current) {
          setNotice("接続開始処理は完了しませんでした。サーバー側のセッションも終了します。");
        }
      }
      if (pendingReady) {
        const settled = await Promise.allSettled([pendingReady]);
        if (settled[0]?.status === "rejected" && mounted.current) {
          setNotice("信頼済み音声接続の準備は完了しませんでした。サーバー側も終了します。");
        }
      }
      if (pendingSimulation) {
        const settled = await Promise.allSettled([pendingSimulation]);
        if (settled[0]?.status === "rejected" && mounted.current) {
          setNotice("シミュレーションの開始は完了しませんでした。停止状態を再確認します。");
        }
        try {
          applyState(await post("/api/stop", {}, isBrowserState));
        } catch (failure) {
          failures.push(`開始処理後の停止を確認できませんでした。${errorMessage(failure)}`);
        }
      }
      if (shouldCloseLive) {
        try {
          applyState(await post("/api/session/close", {}, isBrowserState));
        } catch (failure) {
          failures.push(`セッションの終了を確認できませんでした。${errorMessage(failure)}`);
        }
      }
      if (generation.current === token) {
        liveAttempt.current = failures.length > 0 && shouldCloseLive;
        exchange.current = null;
        readyExchange.current = null;
        simulationStart.current = null;
        locked.current = false;
        if (mounted.current) {
          setPhase(failures.length ? "error" : "idle");
          setBusy(false);
          if (failures.length) setError(failures.join(" "));
        }
      }
    };
    const result = work().finally(() => { stopping.current = null; });
    stopping.current = result;
    return result;
  }, [applyState, disposeMedia]);
  endRef.current = end;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++generation.current;
      const needsClose = liveAttempt.current;
      const pendingExchange = exchange.current;
      const pendingReady = readyExchange.current;
      disposeMedia();
      if (needsClose) {
        void (async () => {
          if (pendingExchange) await Promise.allSettled([pendingExchange]);
          if (pendingReady) await Promise.allSettled([pendingReady]);
          try {
            await post("/api/session/close", {}, isBrowserState, { keepalive: true });
          } catch (failure) {
            console.error("Voice Action Lab: server session cleanup failed.", failure);
          }
        })();
      }
    };
  }, [disposeMedia]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const abort = new AbortController();
    setConfig(null);
    const loadState = async () => {
      const before = stateRevision.current;
      try {
        const snapshot = await request("/api/state", isBrowserState, { signal: abort.signal });
        if (!disposed && stateRevision.current === before) applyState(snapshot);
      } catch (failure) {
        if (!disposed) setFeedError(errorMessage(failure));
      }
    };
    void request("/api/config", isConfig, { signal: abort.signal }).then(
      (value) => { if (!disposed) setConfig(value); },
      (failure: unknown) => { if (!disposed) setError(errorMessage(failure)); },
    );
    void loadState();
    const connectFeed = () => {
      if (disposed) return;
      setFeed(attempts ? "reconnecting" : "connecting");
      const url = new URL("/api/events", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onopen = () => {
        if (disposed) return;
        attempts = 0;
        setFeed("connected");
        setFeedError(null);
        void loadState();
      };
      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (disposed) return;
        try {
          if (typeof event.data !== "string") throw new Error("状態イベントがテキスト形式ではありません。");
          const value: unknown = JSON.parse(event.data);
          if (!isBrowserState(value)) throw new Error("状態イベントの形式が契約と一致しません。");
          applyState(value);
          setFeedError(null);
        } catch (failure) {
          setFeedError(errorMessage(failure));
        }
      };
      socket.onerror = () => {
        if (!disposed) setFeedError("状態ストリームに接続できません。サーバー・ネットワーク・所有者認証を確認してください。");
      };
      socket.onclose = () => {
        if (disposed) return;
        setFeed("reconnecting");
        setFeedError("状態ストリームが切断されました。再接続中です。表示中の位置は最新でない可能性があります。");
        ++attempts;
        retry = setTimeout(connectFeed, Math.min(1_000 * 2 ** (attempts - 1), 10_000));
      };
    };
    connectFeed();
    return () => {
      disposed = true;
      abort.abort();
      if (retry !== null) clearTimeout(retry);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
    };
  }, [applyState, refreshKey]);

  useEffect(() => {
    if (!state) return;
    if (liveAttempt.current && observedLiveSession.current && (phase === "connected" || phase === "connecting")
      && (state.session.transport === "disconnected" || state.session.transport === "error" || state.game.stopped)) {
      setNotice("サーバーが実行を終了しました。マイクと音声接続を閉じます。");
      void end();
    }
  }, [state, phase, end]);

  const canStart = !busy && feed === "connected" && !feedError && state !== null
    && !liveAttempt.current
    && (state.session.transport === "disconnected" || state.session.transport === "error")
    && !["microphone", "connecting", "connected", "closing"].includes(phase);

  const startSimulation = useCallback(async (mode: ExperimentMode) => {
    if (locked.current || !canStart) return;
    locked.current = true;
    const token = ++generation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    setTranscripts([]);
    try {
      const pending = post("/api/simulation/start", { mode }, isBrowserState);
      simulationStart.current = pending;
      const snapshot = await pending;
      if (token !== generation.current || !mounted.current) return;
      applyState(snapshot);
      setPhase("idle");
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure));
    } finally {
      if (mounted.current && token === generation.current) {
        simulationStart.current = null;
        locked.current = false;
        setBusy(false);
      }
    }
  }, [applyState, canStart]);

  const connectLive = useCallback(async (mode: ExperimentMode) => {
    if (locked.current || !canStart || !config?.liveAvailable) return;
    locked.current = true;
    liveAttempt.current = true;
    observedLiveSession.current = false;
    const token = ++generation.current;
    const current = () => mounted.current && generation.current === token;
    setBusy(true);
    setError(null);
    setNotice(null);
    setTranscripts([]);
    setPhase("microphone");
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("実音声には HTTPS（または localhost）と、マイクに対応したブラウザーが必要です。");
      }
      if (typeof RTCPeerConnection === "undefined") throw new Error("このブラウザーは WebRTC に対応していません。");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micDeviceId.current ? { deviceId: { exact: micDeviceId.current } } : true,
        video: false,
      });
      if (!current()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = stream.getAudioTracks()[0];
      if (!track) {
        stream.getTracks().forEach((entry) => entry.stop());
        throw new Error("マイクの音声トラックがありません。");
      }
      stream.getAudioTracks().forEach((captureTrack) => { captureTrack.enabled = false; });
      resources.current.mic = stream;
      micDeviceId.current = track.getSettings().deviceId ?? micDeviceId.current;
      setMicName(track.label || "許可済みのマイク");
      setMic(stream);
      setPhase("connecting");
      setNotice("マイク送信を止めたまま、ICE 候補を収集しています。");
      const startup = new AbortController();
      resources.current.startup = startup;
      const peer = new RTCPeerConnection();
      const remoteStream = new MediaStream();
      resources.current.peer = peer;
      resources.current.remote = remoteStream;
      setRemote(remoteStream);
      const fail = (message: string) => {
        if (!current()) return;
        setError(message);
        void endRef.current();
      };
      track.onended = () => fail("マイクが切断されました。音声セッションを終了します。");
      peer.ontrack = (event) => {
        if (!current()) { event.track.stop(); return; }
        if (!remoteStream.getTracks().some((entry) => entry.id === event.track.id)) {
          remoteStream.addTrack(event.track);
        }
        setRemote(new MediaStream(remoteStream.getTracks()));
      };
      peer.addTrack(track, stream);
      const channel = peer.createDataChannel("oai-events");
      resources.current.channel = channel;
      let sidebandAttached = false;
      const reportReady = () => {
        if (!current()) return;
        if (sidebandAttached && peer.connectionState === "connected" && channel.readyState === "open"
          && liveSessionReady(stateRef.current, mode)) {
          if (resources.current.timeout !== null) clearTimeout(resources.current.timeout);
          resources.current.timeout = null;
          track.enabled = true;
          locked.current = false;
          setBusy(false);
          setNotice(null);
          setPhase("connected");
        } else {
          track.enabled = false;
        }
      };
      resources.current.checkReady = reportReady;
      peer.onconnectionstatechange = () => {
        if (!current()) return;
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          fail("実音声の接続が終了または失敗しました。シミュレーションには切り替えません。");
        } else if (peer.connectionState === "disconnected") {
          track.enabled = false;
          setPhase("connecting");
          setNotice("音声接続が中断しています。再接続を待っています。");
          if (sidebandAttached && resources.current.timeout === null) {
            resources.current.timeout = setTimeout(() => fail("音声接続が復旧しませんでした。セッションを終了します。"), 15_000);
          }
        } else {
          reportReady();
        }
      };
      channel.onopen = reportReady;
      channel.onerror = () => fail("音声イベントのデータチャネルでエラーが発生しました。");
      channel.onclose = () => fail("音声イベントのデータチャネルが切断されました。");
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (!current()) return;
        if (typeof event.data !== "string") {
          setError("音声イベントを読み取れません。音声そのものはメディアトラックから再生します。");
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(event.data);
        } catch {
          setError("音声イベントの JSON が不正です。");
          return;
        }
        if (!isRecord(value) || typeof value.type !== "string") {
          setError("音声イベントの形式が不正です。");
          return;
        }
        if (value.type === "error") {
          const detail = isRecord(value.error) && typeof value.error.message === "string"
            ? value.error.message : "音声サービスからエラーが返されました。";
          fail(detail);
          return;
        }
        if (/^session\..*_transcript\.delta$/.test(value.type) && typeof value.delta === "string") {
          const speaker = /input|user/.test(value.type) ? "user" : "assistant";
          const id = `${speaker}:${typeof value.item_id === "string" ? value.item_id
            : typeof value.response_id === "string" ? value.response_id : "current"}`;
          const delta = value.delta;
          setTranscripts((previous) => {
            const existing = previous.find((entry) => entry.id === id);
            if (existing) {
              return previous.map((entry) => entry.id === id ? { ...entry, text: (entry.text + delta).slice(-1_200) } : entry);
            }
            const entry: Transcript = { id, speaker, text: delta.slice(-1_200) };
            return [...previous, entry].slice(-8);
          });
        }
      };
      const offer = await peer.createOffer();
      if (!current()) return;
      await peer.setLocalDescription(offer);
      if (!current()) return;
      await waitForIceGathering(peer, startup.signal);
      if (!current()) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("WebRTC の接続情報を作成できませんでした。");
      setNotice("ICE 候補を収集しました。マイク送信を止めたまま SDP を交換しています。");
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 30_000);
      const pending = post("/api/session", { mode, sdp }, isSessionAnswer, { signal: abort.signal });
      exchange.current = pending;
      let answer: SessionAnswer;
      try {
        answer = await pending;
      } finally {
        clearTimeout(timeout);
      }
      if (!current()) return;
      setLocalExpiresAt(answer.expiresAt);
      setNotice("マイク送信を止めたまま、WebRTC とデータチャネルの接続を待っています。");
      await Promise.all([
        peer.setRemoteDescription({ type: "answer", sdp: answer.sdp }),
        waitForPeerConnection(peer, channel, startup.signal),
      ]);
      if (!current()) return;
      setNotice("マイク送信を止めたまま、サーバーの信頼済み音声接続を準備しています。");
      const pendingReady = post("/api/session/ready", {}, isBrowserState);
      readyExchange.current = pendingReady;
      const snapshot = await pendingReady;
      if (!current()) return;
      if (!liveSessionReady(snapshot, mode)) {
        throw new Error("サーバーが選択モードの実音声セッションを準備できませんでした。マイクは送信していません。");
      }
      applyState(snapshot);
      if (peer.connectionState !== "connected" || channel.readyState !== "open"
        || !liveSessionReady(stateRef.current, mode) || stateRef.current?.game.runId !== snapshot.game.runId) {
        throw new Error("信頼済み音声接続の準備中に接続状態が変わりました。マイクは送信していません。");
      }
      sidebandAttached = true;
      reportReady();
    } catch (failure) {
      if (!current()) return;
      setError(`${microphoneError(failure)} シミュレーションへの自動切替は行いません。`);
      await endRef.current();
    }
  }, [applyState, canStart, config]);

  const sendCommand = useCallback(async (body: GameCommand) => {
    const snapshot = stateRef.current;
    if (locked.current || snapshot?.session.source !== "simulation"
      || snapshot.session.transport !== "connected" || snapshot.game.stopped || feed !== "connected" || feedError) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    const token = generation.current;
    try {
      const response = await command(body);
      if (token === generation.current) {
        applyState(response.state);
        setNotice(`${response.result.outcome}: ${response.result.reason}`);
        if (response.result.outcome === "rejected") setError(`操作が拒否されました。${response.result.reason}`);
      }
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure));
    } finally {
      if (mounted.current && generation.current === token) {
        locked.current = false;
        setBusy(false);
      }
    }
  }, [applyState, feed, feedError]);

  const refresh = useCallback(() => {
    setError(null);
    setRefreshKey((value) => value + 1);
  }, []);

  return {
    state, config, phase, feed, error, feedError, notice, busy, mic, remote, micName,
    transcripts, localExpiresAt, canStart, startSimulation, connectLive, end, sendCommand, refresh,
  };
}

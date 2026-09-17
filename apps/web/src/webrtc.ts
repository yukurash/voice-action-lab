export const ICE_GATHER_TIMEOUT_MS = 8_000;
export const PEER_CONNECT_TIMEOUT_MS = 25_000;

type IcePeer = EventTarget & Pick<RTCPeerConnection, "iceGatheringState" | "connectionState">;
type ConnectedPeer = EventTarget & Pick<RTCPeerConnection, "connectionState">;
type OpenChannel = EventTarget & Pick<RTCDataChannel, "readyState">;

function waitForState(
  targets: { target: EventTarget; events: string[] }[],
  ready: () => boolean,
  failure: () => string | null,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", check);
      for (const { target, events } of targets) {
        for (const event of events) target.removeEventListener(event, check);
      }
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (signal.aborted) {
        finish(new DOMException("音声接続の準備を停止しました。", "AbortError"));
        return;
      }
      const message = failure();
      if (message) finish(new Error(message));
      else if (ready()) finish();
    };
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);
    for (const { target, events } of targets) {
      for (const event of events) target.addEventListener(event, check);
    }
    signal.addEventListener("abort", check, { once: true });
    check();
  });
}

export function waitForIceGathering(peer: IcePeer, signal: AbortSignal): Promise<void> {
  return waitForState(
    [{ target: peer, events: ["icegatheringstatechange", "connectionstatechange"] }],
    () => peer.iceGatheringState === "complete",
    () => peer.connectionState === "failed" || peer.connectionState === "closed"
      ? "ICE 候補の収集中に音声接続が終了しました。" : null,
    signal,
    ICE_GATHER_TIMEOUT_MS,
    "ICE 候補の収集が 8 秒以内に完了しませんでした。ネットワークを確認してください。",
  );
}

export function waitForPeerConnection(peer: ConnectedPeer, channel: OpenChannel, signal: AbortSignal): Promise<void> {
  return waitForState(
    [
      { target: peer, events: ["connectionstatechange"] },
      { target: channel, events: ["open", "close", "error"] },
    ],
    () => peer.connectionState === "connected" && channel.readyState === "open",
    () => peer.connectionState === "failed" || peer.connectionState === "closed"
      || channel.readyState === "closed" || channel.readyState === "closing"
      ? "WebRTC またはデータチャネルの接続が終了しました。" : null,
    signal,
    PEER_CONNECT_TIMEOUT_MS,
    "WebRTC とデータチャネルの接続が 25 秒以内に完了しませんでした。ネットワークを確認してください。",
  );
}

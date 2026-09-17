import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api.ts";

interface RecordingResources {
  recorder: MediaRecorder;
  destination: MediaStreamAudioDestinationNode;
  sources: MediaStreamAudioSourceNode[];
}

export function useLocalRecording(mic: MediaStream | null, remote: MediaStream | null, context: AudioContext | null) {
  const [recording, setRecording] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [download, setDownload] = useState<{ url: string; extension: string; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<RecordingResources | null>(null);
  const mounted = useRef(true);
  const version = useRef(0);
  const starting = useRef(false);
  const urlRef = useRef<string | null>(null);
  const supported = typeof MediaRecorder !== "undefined" && typeof AudioContext !== "undefined";

  const stop = useCallback(() => {
    ++version.current;
    starting.current = false;
    const resource = current.current;
    if (!resource) return;
    if (resource.recorder.state !== "inactive") {
      if (mounted.current) setFinalizing(true);
      resource.recorder.stop();
    }
  }, []);

  const discard = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setDownload(null);
  }, []);

  const start = useCallback(async () => {
    if (!supported || !mic || !remote || !context || !remote.getAudioTracks().length || current.current || starting.current) return;
    starting.current = true;
    const token = ++version.current;
    setError(null);
    let destination: MediaStreamAudioDestinationNode | null = null;
    const sources: MediaStreamAudioSourceNode[] = [];
    try {
      if (token !== version.current || !mounted.current) {
        return;
      }
      if (context.state !== "running") throw new Error("録音用の音声処理を開始できませんでした。");
      destination = context.createMediaStreamDestination();
      for (const stream of [mic, remote]) {
        const source = context.createMediaStreamSource(stream);
        source.connect(destination);
        sources.push(source);
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(destination.stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      let byteLength = 0;
      const resource: RecordingResources = { recorder, destination, sources };
      current.current = resource;
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        chunks.push(event.data);
        byteLength += event.data.size;
        if (byteLength > 64 * 1024 * 1024 && recorder.state === "recording") {
          if (mounted.current) setError("ブラウザー内の録音が 64 MB を超えたため停止しました。保存または破棄してください。");
          stop();
        }
      };
      recorder.onerror = () => {
        if (mounted.current) setError("録音中にエラーが発生しました。生成された音声が不完全な可能性があります。");
        stop();
      };
      recorder.onstop = () => {
        resource.sources.forEach((source) => source.disconnect());
        resource.destination.stream.getTracks().forEach((track) => track.stop());
        if (current.current === resource) current.current = null;
        if (!mounted.current) return;
        setRecording(false);
        setFinalizing(false);
        if (!chunks.length) {
          setError("録音データが生成されませんでした。マイクと相手側の音声接続を確認してください。");
          return;
        }
        const type = recorder.mimeType || chunks[0]?.type || "audio/webm";
        const blob = new Blob(chunks, { type });
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setDownload({ url, extension: type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm", bytes: blob.size });
      };
      recorder.start(1_000);
      setRecording(true);
    } catch (failure) {
      sources.forEach((source) => source.disconnect());
      destination?.stream.getTracks().forEach((track) => track.stop());
      current.current = null;
      if (mounted.current) setError(`録音を開始できませんでした。${errorMessage(failure)}`);
    } finally {
      starting.current = false;
    }
  }, [context, mic, remote, stop, supported]);

  useEffect(() => {
    if (!mic || !remote) stop();
  }, [mic, remote, stop]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [stop]);

  return { supported, recording, finalizing, download, error, start, stop, discard };
}

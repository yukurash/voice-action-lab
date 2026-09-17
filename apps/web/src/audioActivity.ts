import { errorMessage, isActivityResponse, post } from "./api.ts";
import { AUDIO_MEASUREMENT_EVENT, MAX_MEASUREMENT_RECORDS, exactKeys, isPcmWindowSample } from "./audioMeasurement.ts";
import type { AudioMeasurementEvent, ClockAnchor, MeasurementStatus } from "./audioMeasurement.ts";
import { ACTIVE_WINDOWS, SILENT_WINDOWS, THRESHOLD_DBFS, WINDOW_MS } from "./pcmWindow.ts";

export const ACTIVITY_NOTIFY_INTERVAL_MS = 2_000;
export const MAX_ACTIVITY_OFFSET_MS = 600_000;

export class AudioActivityClock {
  private readonly startedAtMs: number;
  private lastObservedMs: number;
  private lastOffsetMs = -Infinity;

  constructor(startedAtMs: number) {
    if (!Number.isFinite(startedAtMs)) throw new Error("音声活動の開始時刻が不正です。");
    this.startedAtMs = startedAtMs;
    this.lastObservedMs = startedAtMs;
  }

  nextOffset(nowMs: number, audioDetected: boolean): number | null {
    if (!Number.isFinite(nowMs) || nowMs < this.lastObservedMs) {
      throw new Error("音声活動の時計が単調増加していません。");
    }
    this.lastObservedMs = nowMs;
    const offsetMs = Math.floor(nowMs - this.startedAtMs);
    if (!audioDetected || offsetMs > MAX_ACTIVITY_OFFSET_MS
      || offsetMs - this.lastOffsetMs < ACTIVITY_NOTIFY_INTERVAL_MS) return null;
    this.lastOffsetMs = offsetMs;
    return offsetMs;
  }
}

interface AudioSource {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
}

export class AudioActivityMonitor {
  readonly context: AudioContext;
  readonly ready: Promise<void>;
  private readonly clock: AudioActivityClock;
  private readonly onError: (message: string) => void;
  private readonly onMeasurement: (event: AudioMeasurementEvent) => void;
  private readonly onWarning: (message: string) => void;
  private readonly measurementId = crypto.randomUUID();
  private processor: AudioWorkletNode | null = null;
  private input: AudioSource | null = null;
  private output: AudioSource | null = null;
  private request: AbortController | null = null;
  private cancelInitialization: () => void = () => {};
  private initializationTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private records = 0;
  private anchored = false;
  private sending = false;
  private active = false;
  private failed = false;
  private disposed = false;

  constructor(context: AudioContext, startedAtMs: number, onError: (message: string) => void,
    onMeasurement: (event: AudioMeasurementEvent) => void, moduleUrl: string, onWarning: (message: string) => void) {
    this.context = context;
    this.clock = new AudioActivityClock(startedAtMs);
    this.onError = onError;
    this.onMeasurement = onMeasurement;
    this.onWarning = onWarning;
    context.onstatechange = () => {
      if (this.active && context.state !== "running") {
        this.fail("音声活動の検出が中断しました。ブラウザーの音声設定を確認してください。");
      }
    };
    const cancellation = new Promise<never>((_, reject) => {
      this.cancelInitialization = () => reject(new DOMException("Measurement disposed.", "AbortError"));
      this.initializationTimer = setTimeout(() => reject(new Error("音声計測の初期化が8秒でタイムアウトしました。")), 8000);
    });
    this.ready = Promise.race([this.initialize(moduleUrl), cancellation]);
    void this.ready.then(() => this.clearInitializationTimer(), (failure: unknown) => {
      this.clearInitializationTimer();
      if (!this.disposed) this.fail(`音声計測を開始できませんでした。${errorMessage(failure)}`);
    });
  }

  private async initialize(moduleUrl: string): Promise<void> {
    await Promise.all([this.context.resume(), this.context.audioWorklet.addModule(moduleUrl, { credentials: "same-origin" })]);
    if (this.disposed) throw new DOMException("Measurement disposed.", "AbortError");
    if (this.context.state !== "running") throw new Error("計測用 AudioContext が動作していません。");
    const processor = new AudioWorkletNode(this.context, "voice-action-lab-pcm-measurement", {
      numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1],
    });
    this.processor = processor;
    processor.onprocessorerror = () => this.fail("音声計測ワークレットが停止しました。");
    processor.port.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
    processor.port.onmessageerror = () => this.fail("音声計測メッセージを読み取れません。");
    processor.connect(this.context.destination);
  }

  private clearInitializationTimer(): void {
    if (this.initializationTimer !== null) clearTimeout(this.initializationTimer);
    this.initializationTimer = null;
  }

  setInput(stream: MediaStream): void {
    if (!this.disposed) this.input = this.replaceSource(this.input, stream, 0);
  }

  setOutput(stream: MediaStream): void {
    if (!this.disposed) this.output = this.replaceSource(this.output, stream, 1);
  }

  setActive(active: boolean): void {
    if (this.disposed || this.failed || this.active === active) return;
    if (!this.processor || this.context.state !== "running") {
      this.fail("音声計測を利用できません。AudioWorklet と自動再生の設定を確認してください。");
      return;
    }
    this.active = active;
    if (active && !this.anchored) {
      this.anchored = true;
      this.publish({
        version: 1, type: "anchor", measurementId: this.measurementId,
        sampleRate: this.context.sampleRate, windowMs: WINDOW_MS, thresholdDbfs: THRESHOLD_DBFS,
        activeWindows: ACTIVE_WINDOWS, silentWindows: SILENT_WINDOWS, clockAnchor: this.anchor(),
      });
    }
    this.status(active ? "measuring" : "paused");
    this.processor.port.postMessage({ enabled: active, generation: ++this.generation });
    if (!active) this.request?.abort();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.active = false;
    this.status("closed");
    this.clearInitializationTimer();
    this.cancelInitialization();
    this.request?.abort();
    this.context.onstatechange = null;
    if (this.processor) {
      this.processor.onprocessorerror = null;
      this.processor.port.onmessage = null;
      this.processor.port.onmessageerror = null;
      this.processor.port.close();
      this.processor.disconnect();
      this.processor = null;
    }
    this.disconnectSource(this.input);
    this.disconnectSource(this.output);
    this.input = null;
    this.output = null;
    return this.context.state === "closed" ? Promise.resolve() : this.context.close();
  }

  private disconnectSource(current: AudioSource | null): void {
    if (!current) return;
    current.source.disconnect();
  }

  private replaceSource(current: AudioSource | null, stream: MediaStream, index: number): AudioSource | null {
    if (current?.stream === stream) return current;
    this.disconnectSource(current);
    const tracks = stream.getAudioTracks().filter((track) => track.readyState === "live");
    if (!tracks.length) return null;
    if (!this.processor) throw new Error("音声計測ワークレットの準備が完了していません。");
    const source = this.context.createMediaStreamSource(new MediaStream(tracks));
    source.connect(this.processor, 0, index);
    return { stream, source };
  }

  private anchor(): ClockAnchor {
    return { contextTime: this.context.currentTime, performanceNowMs: performance.now() };
  }

  private publish(event: AudioMeasurementEvent): void {
    this.onMeasurement(event);
    window.dispatchEvent(new CustomEvent<AudioMeasurementEvent>(AUDIO_MEASUREMENT_EVENT, { detail: structuredClone(event) }));
  }

  private status(status: MeasurementStatus["status"]): void {
    if (this.anchored) this.publish({ version: 1, type: "status", measurementId: this.measurementId, status, clockAnchor: this.anchor() });
  }

  private receive(data: unknown): void {
    if (this.disposed || this.failed) return;
    if (exactKeys(data, ["generation", "failure", "frameDelta"]) && Number.isSafeInteger(data.generation)
      && (data.failure === "frame-discontinuity" ? Number.isSafeInteger(data.frameDelta)
        : data.failure === "processor-error" && data.frameDelta === null)) {
      this.fail(`音声計測ワークレットが停止しました (${data.failure}, frameDelta=${String(data.frameDelta)})。`);
      return;
    }
    if (!this.active) return;
    if (exactKeys(data, ["generation", "gapFrames"]) && Number.isSafeInteger(data.generation)
      && typeof data.gapFrames === "number" && Number.isSafeInteger(data.gapFrames) && data.gapFrames > 0) {
      if (data.generation !== this.generation) return;
      this.status("paused");
      this.status("measuring");
      this.onWarning("音声計測にフレーム欠落があります。欠落を無音で補完せず、この試行の音声遅延は欠測として扱います。");
      return;
    }
    try {
      if (!exactKeys(data, ["generation", "samples"]) || !Number.isSafeInteger(data.generation)) {
        throw new Error("音声計測メッセージの形式が不正です。");
      }
      if (data.generation !== this.generation) return;
      if (!Array.isArray(data.samples) || !data.samples.length || data.samples.length > 128 || !data.samples.every(isPcmWindowSample)) {
        throw new Error("音声計測サンプルの形式が不正です。");
      }
      const clockAnchor = this.anchor();
      for (const sample of data.samples) {
        if (++this.records > MAX_MEASUREMENT_RECORDS - 2048) throw new Error("音声計測が10分の保存上限に達しました。");
        this.publish({ ...sample, version: 1, type: "sample", measurementId: this.measurementId, clockAnchor });
      }
      if (this.sending) return;
      const offsetMs = this.clock.nextOffset(clockAnchor.performanceNowMs, data.samples.some((sample) => sample.active && sample.aboveThreshold));
      if (offsetMs === null) return;
      const controller = new AbortController();
      this.request = controller;
      this.sending = true;
      void post("/api/activity", { offsetMs }, isActivityResponse, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
      }).catch((failure: unknown) => {
        if (!this.disposed && !controller.signal.aborted) this.fail(`音声活動の通知に失敗しました。${errorMessage(failure)}`);
      }).finally(() => {
        if (this.request === controller) this.request = null;
        this.sending = false;
      });
    } catch (failure) {
      this.fail(errorMessage(failure));
    }
  }

  private fail(message: string): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.active = false;
    this.status("error");
    this.request?.abort();
    this.onError(`${message} 不確かな idle 判定で継続しないよう、音声接続を終了します。`);
  }
}

export function createAudioActivityMonitor(startedAtMs: number, onError: (message: string) => void,
  onMeasurement: (event: AudioMeasurementEvent) => void, moduleUrl: string, onWarning: (message: string) => void): AudioActivityMonitor {
  if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") throw new Error("このブラウザーは AudioWorklet 音声計測に対応していません。");
  const context = new AudioContext({ latencyHint: "playback" });
  try {
    if (!context.audioWorklet) throw new Error("AudioWorklet を利用できません。HTTPS とブラウザー設定を確認してください。");
    return new AudioActivityMonitor(context, startedAtMs, onError, onMeasurement, moduleUrl, onWarning);
  } catch (failure) {
    void context.close().catch((cleanupFailure: unknown) => {
      console.error("Voice Action Lab: activity context startup cleanup failed.", cleanupFailure);
    });
    throw failure;
  }
}

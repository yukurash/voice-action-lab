import { expect, test } from "@playwright/test";
import type { Page, WebSocketRoute } from "@playwright/test";
import type { BrowserState } from "../../../packages/contracts/index.ts";
import { isAudioMeasurementEvent } from "../src/audioMeasurement.ts";
import type { AudioMeasurementEvent, MeasurementSample } from "../src/audioMeasurement.ts";
import { parseLocalSession } from "../src/localSession.ts";
import { serverExportFixture } from "./serverExport.fixture.ts";

function syntheticState(): BrowserState {
  return {
    game: { runId: "synthetic-ui-test", mode: "voice-only", epoch: 0, cargo: { red: 3, blue: 3 }, operations: [], events: [], stopped: true },
    session: { source: "simulation", transport: "disconnected", message: "Synthetic test fixture", expiresAt: null, recording: false },
  };
}

async function harness(page: Page, liveAvailable = false) {
  let state = syntheticState();
  let socket: WebSocketRoute | null = null;
  const calls: { path: string; body: unknown }[] = [];
  const requests: string[] = [];
  await page.routeWebSocket("**/api/events", (connection) => {
    socket = connection;
    connection.send(JSON.stringify(state));
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    const body: unknown = route.request().postDataJSON();
    if (route.request().method() === "POST") calls.push({ path, body });
    if (path === "/api/config") {
      await route.fulfill({ json: { liveAvailable, reason: "Synthetic configuration" } });
    } else if (path === "/api/state") {
      await route.fulfill({ json: state });
    } else if (path === "/api/simulation/start") {
      const mode = body && typeof body === "object" && "mode" in body && body.mode === "cancel-actions" ? "cancel-actions" : "voice-only";
      state = { ...state, game: { ...state.game, mode, stopped: false }, session: { ...state.session, source: "simulation", transport: "connected" } };
      socket?.send(JSON.stringify(state));
      await route.fulfill({ json: state });
    } else if (path === "/api/command") {
      await route.fulfill({ json: { result: { outcome: "observed-not-applied", operationId: null, reason: "Synthetic acknowledgement" }, state } });
    } else if (path === "/api/session/ready") {
      state = { ...state, game: { ...state.game, stopped: false }, session: { ...state.session, source: "live", transport: "connected" } };
      socket?.send(JSON.stringify(state));
      await route.fulfill({ json: state });
    } else if (path === "/api/activity") {
      await route.fulfill({ json: { ok: true } });
    } else if (path === "/api/stop" || path === "/api/session/close") {
      state = { ...state, game: { ...state.game, stopped: true }, session: { ...state.session, transport: "disconnected", expiresAt: null } };
      socket?.send(JSON.stringify(state));
      await route.fulfill({ json: state });
    } else if (path === "/api/session") {
      await route.fulfill({ status: 503, json: { error: "Synthetic live failure" } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Unexpected test route" } });
    }
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "シミュレーションを開始", exact: true })).toBeEnabled();
  return {
    calls,
    requests,
    publish(next: BrowserState) {
      state = next;
      socket?.send(JSON.stringify(next));
    },
    snapshot: () => structuredClone(state),
    malformed() { socket?.send('{"game":null}'); },
  };
}

async function syntheticWebRtc(page: Page, options: {
  holdIce?: boolean; holdPeer?: boolean; holdChannel?: boolean; inputTone?: boolean; outputTone?: boolean; countContexts?: boolean;
} = {}): Promise<string[]> {
  const messages: string[] = [];
  page.on("console", (message) => {
    if (message.text().startsWith("synthetic-")) messages.push(message.text());
  });
  await page.addInitScript((settings) => {
    if (settings.countContexts) {
      class CountedContext extends AudioContext {
        constructor(options?: AudioContextOptions) {
          super(options);
          console.log("synthetic-context-created");
          if (options?.latencyHint === "playback") console.log("synthetic-meter-playback-buffer");
        }
      }
      Object.defineProperty(window, "AudioContext", { value: CountedContext });
    }
    function audioStream(tone: boolean, direction: "input" | "output"): MediaStream {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      let silence: (() => void) | null = null;
      if (tone) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0.1;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        silence = () => { gain.gain.setValueAtTime(0, context.currentTime); };
        window.addEventListener(`synthetic-silence-${direction}`, silence);
      }
      void context.resume().catch((failure: unknown) => { console.error("Synthetic audio failed.", failure); });
      const track = destination.stream.getAudioTracks()[0];
      if (!track) throw new Error("Synthetic audio track missing.");
      const report = () => console.log(`synthetic-${direction}-state ${track.enabled} ${track.readyState}`);
      window.addEventListener("synthetic-report-streams", report);
      const stop = track.stop.bind(track);
      let stopped = false;
      track.stop = () => {
        if (stopped) return;
        stopped = true;
        window.removeEventListener("synthetic-report-streams", report);
        if (silence) window.removeEventListener(`synthetic-silence-${direction}`, silence);
        stop();
        if (direction === "output") console.log("synthetic-output-stopped");
        void context.close();
      };
      return destination.stream;
    }
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async (constraints: MediaStreamConstraints) => {
        console.log(`synthetic-mic-constraints ${JSON.stringify(constraints)}`);
        const stream = audioStream(settings.inputTone === true, "input");
        const track = stream.getAudioTracks()[0];
        if (!track) throw new Error("Synthetic microphone track missing.");
        track.getSettings = () => ({ deviceId: "synthetic-fixed-microphone" });
        const report = () => console.log(`synthetic-mic-enabled ${track.enabled}`);
        window.addEventListener("synthetic-report-mic", report);
        const originalStop = track.stop.bind(track);
        track.stop = () => {
          console.log(`synthetic-mic-stopped-enabled ${track.enabled}`);
          window.removeEventListener("synthetic-report-mic", report);
          originalStop();
          console.log("synthetic-mic-stopped");
        };
        return stream;
      },
    });
    class SyntheticChannel extends EventTarget {
      readyState = "connecting";
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      constructor() {
        super();
        window.addEventListener("synthetic-transcript", () => {
          this.onmessage?.(new MessageEvent("message", {
            data: JSON.stringify({ type: "session.output_transcript.delta", delta: "Synthetic transcript without audio" }),
          }));
        });
      }
      open() {
        this.readyState = "open";
        this.dispatchEvent(new Event("open"));
        this.onopen?.();
        console.log("synthetic-channel-open");
      }
      close() {
        this.readyState = "closed";
        this.dispatchEvent(new Event("close"));
        this.onclose?.();
        console.log("synthetic-channel-closed");
      }
    }
    class SyntheticPeer extends EventTarget {
      connectionState = "new";
      iceGatheringState = "new";
      localDescription: RTCSessionDescriptionInit | null = null;
      onconnectionstatechange: (() => void) | null = null;
      ontrack: ((event: { track: MediaStreamTrack }) => void) | null = null;
      channel = new SyntheticChannel();
      constructor() {
        super();
        window.addEventListener("synthetic-complete-ice", () => this.completeIce());
        window.addEventListener("synthetic-connect-peer", () => this.connect());
        window.addEventListener("synthetic-open-channel", () => this.channel.open());
      }
      completeIce() {
        if (this.connectionState === "closed") return;
        this.iceGatheringState = "complete";
        if (this.localDescription) this.localDescription = { ...this.localDescription, sdp: "synthetic-gathered-offer" };
        this.dispatchEvent(new Event("icegatheringstatechange"));
        console.log("synthetic-ice-complete");
      }
      connect() {
        if (this.connectionState === "closed") return;
        this.connectionState = "connected";
        this.dispatchEvent(new Event("connectionstatechange"));
        this.onconnectionstatechange?.();
        console.log("synthetic-peer-connected");
      }
      addTrack(track: MediaStreamTrack, stream: MediaStream) {
        if (!stream.getAudioTracks().includes(track)) throw new Error("Real MediaStream track was not attached.");
        console.log("synthetic-track-attached");
        console.log(`synthetic-track-attached-disabled ${!track.enabled}`);
      }
      createDataChannel(name: string) {
        if (name !== "oai-events") throw new Error("Incorrect data channel name.");
        return this.channel;
      }
      async createOffer(): Promise<RTCSessionDescriptionInit> {
        return { type: "offer", sdp: "synthetic-offer" };
      }
      async setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = description;
        this.iceGatheringState = "gathering";
        this.dispatchEvent(new Event("icegatheringstatechange"));
        console.log("synthetic-ice-gathering");
        if (!settings.holdIce) this.completeIce();
      }
      async setRemoteDescription(description: RTCSessionDescriptionInit) {
        if (description.type !== "answer") throw new Error("Remote SDP must be an answer.");
        console.log("synthetic-answer-applied");
        if (settings.outputTone) {
          const track = audioStream(true, "output").getAudioTracks()[0];
          if (!track) throw new Error("Synthetic received audio track missing.");
          this.ontrack?.({ track });
        }
        if (!settings.holdPeer) this.connect();
        if (!settings.holdChannel) this.channel.open();
      }
      close() {
        this.connectionState = "closed";
        this.dispatchEvent(new Event("connectionstatechange"));
        this.onconnectionstatechange?.();
        console.log("synthetic-peer-closed");
      }
    }
    Object.defineProperty(window, "RTCPeerConnection", { value: SyntheticPeer });
  }, options);
  return messages;
}

async function expectMicEnabled(page: Page, messages: string[], enabled: boolean) {
  const before = messages.length;
  await page.evaluate(() => { window.dispatchEvent(new Event("synthetic-report-mic")); });
  await expect.poll(() => messages.slice(before).find((message) => message.startsWith("synthetic-mic-enabled ")))
    .toBe(`synthetic-mic-enabled ${enabled}`);
}

async function acceptSyntheticSession(page: Page): Promise<void> {
  await page.route("**/api/session", async (route) => {
    await route.fulfill({ json: { sdp: "synthetic-answer", expiresAt: new Date(Date.now() + 600_000).toISOString() } });
  });
}

async function captureMeasurements(page: Page) {
  const events: AudioMeasurementEvent[] = [];
  const invalid: unknown[] = [];
  page.on("console", (message) => {
    const prefix = "synthetic-measurement ";
    if (!message.text().startsWith(prefix)) return;
    const value: unknown = JSON.parse(message.text().slice(prefix.length));
    if (isAudioMeasurementEvent(value)) events.push(value);
    else invalid.push(value);
  });
  await page.addInitScript(() => {
    window.addEventListener("voice-action-lab:audio-measurement", (event) => {
      if (event instanceof CustomEvent) console.log(`synthetic-measurement ${JSON.stringify(event.detail)}`);
    });
  });
  return { events, invalid };
}

test("established stop mutes immediately but preserves peer and tracks through both close acknowledgements", async ({ page }) => {
  const captured = await captureMeasurements(page);
  const media = await syntheticWebRtc(page, { inputTone: true, outputTone: true });
  const mock = await harness(page, true);
  await acceptSyntheticSession(page);
  const stopGate: { release: () => void } = { release: () => { throw new Error("Stop gate not initialized."); } };
  const closeGate: { release: () => void } = { release: () => { throw new Error("Close gate not initialized."); } };
  const stopPending = new Promise<void>((resolve) => { stopGate.release = resolve; });
  const closePending = new Promise<void>((resolve) => { closeGate.release = resolve; });
  let stops = 0;
  let closes = 0;
  await page.route("**/api/stop", async (route) => {
    ++stops;
    const next = mock.snapshot();
    next.game.stopped = true;
    next.session.transport = "closing";
    mock.publish(next);
    await stopPending;
    await route.fulfill({ json: next });
  });
  await page.route("**/api/session/close", async (route) => {
    ++closes;
    await closePending;
    const next = mock.snapshot();
    next.game.stopped = true;
    next.game.events.push({ sequence: 1, atMs: 100, kind: "final_usage_unconfirmed", operationId: null, delegationId: null, details: {} });
    next.session.transport = "disconnected";
    mock.publish(next);
    await route.fulfill({ json: next });
  });
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect(page.locator(".source-banner")).toContainText("実音声 接続中");
  await page.getByRole("button", { name: "停止して切断", exact: true }).click();
  await expect.poll(() => stops).toBe(1);
  expect(closes).toBe(0);
  await expect(page.getByText("切断処理中・マイク送信停止中", { exact: true })).toBeVisible();
  await expect(page.locator("audio")).toHaveJSProperty("muted", true);
  await expect(page.locator("audio")).toHaveJSProperty("paused", true);
  await page.evaluate(() => { window.dispatchEvent(new Event("synthetic-report-streams")); });
  await expect.poll(() => media.includes("synthetic-input-state false live") && media.includes("synthetic-output-state false live")).toBe(true);
  expect(media).not.toContain("synthetic-peer-closed");
  expect(media).not.toContain("synthetic-channel-closed");
  expect(media).not.toContain("synthetic-mic-stopped");
  expect(media).not.toContain("synthetic-output-stopped");
  expect(captured.events.some((event) => event.type === "status" && event.status === "paused")).toBe(true);
  const samplesAtStop = captured.events.filter((event) => event.type === "sample").length;
  await page.waitForTimeout(200);
  expect(captured.events.filter((event) => event.type === "sample")).toHaveLength(samplesAtStop);
  const stale = mock.snapshot();
  stale.game.stopped = false;
  stale.session.transport = "connected";
  mock.publish(stale);
  await expectMicEnabled(page, media, false);
  stopGate.release();
  await expect.poll(() => closes).toBe(1);
  expect(media).not.toContain("synthetic-peer-closed");
  expect(media).not.toContain("synthetic-mic-stopped");
  closeGate.release();
  await expect.poll(() => media.includes("synthetic-peer-closed") && media.includes("synthetic-mic-stopped")
    && media.includes("synthetic-output-stopped")).toBe(true);
  await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeEnabled();
  await expect(page.getByText("final_usage_unconfirmed", { exact: true })).toBeVisible();
  await expect(page.getByText("final_usage_confirmed", { exact: true })).toHaveCount(0);
  expect(stops).toBe(1);
  expect(closes).toBe(1);
});

test("established close grace releases local media at exactly twenty seconds without fabricating usage", async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now + 1000));
  const media = await syntheticWebRtc(page, { inputTone: true, outputTone: true });
  const mock = await harness(page, true);
  await acceptSyntheticSession(page);
  const gate: { release: () => void } = { release: () => { throw new Error("Close deadline gate not initialized."); } };
  const pending = new Promise<void>((resolve) => { gate.release = resolve; });
  let closes = 0;
  await page.route("**/api/session/close", async (route) => {
    ++closes;
    await pending;
    await route.fulfill({ json: mock.snapshot() });
  });
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect(page.locator(".source-banner")).toContainText("実音声 接続中");
  await page.getByRole("button", { name: "停止して切断", exact: true }).click();
  await expect.poll(() => closes).toBe(1);
  await page.clock.fastForward(19_999);
  expect(media).not.toContain("synthetic-peer-closed");
  await page.clock.fastForward(1);
  await expect.poll(() => media.includes("synthetic-peer-closed") && media.includes("synthetic-mic-stopped")).toBe(true);
  await expect(page.getByRole("alert")).toContainText("20秒以内に終了応答がなかった");
  gate.release();
  await expect(page.getByRole("button", { name: /すべて停止/ })).toBeEnabled();
  await expect(page.getByRole("alert")).toContainText("最終利用量はサーバーのイベントを確認");
  expect(mock.snapshot().game.events.some((event) => event.kind === "final_usage_confirmed")).toBe(false);
  await expect(page.getByText("final_usage_confirmed", { exact: true })).toHaveCount(0);
  expect(closes).toBe(1);
});

test("native worklet emits shared-clock 20ms PCM metrics, recording shares its context, and JSON replay is offline", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (failure) => browserErrors.push(failure.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  const captured = await captureMeasurements(page);
  const media = await syntheticWebRtc(page, { inputTone: true, outputTone: true, countContexts: true });
  const mock = await harness(page, true);
  await acceptSyntheticSession(page);
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect.poll(async () => ({
    starts: new Set(captured.events.filter((event): event is MeasurementSample => event.type === "sample" && event.transition === "start")
      .map((event) => event.direction)).size,
    errors: browserErrors,
    alerts: await page.getByRole("alert").allTextContents(),
  })).toEqual({ starts: 2, errors: [], alerts: [] });
  const anchor = captured.events[0];
  expect(anchor?.type).toBe("anchor");
  if (anchor?.type !== "anchor") throw new Error("Measurement anchor missing.");
  expect(anchor).toMatchObject({ version: 1, windowMs: 20, thresholdDbfs: -45, activeWindows: 3, silentWindows: 6 });
  const samples = captured.events.filter((entry): entry is MeasurementSample => entry.type === "sample");
  const input = samples.find((sample) => sample.direction === "input");
  const output = samples.find((sample) => sample.direction === "output");
  expect(input?.contextTime).toBe(output?.contextTime);
  expect(input?.clockAnchor).toEqual(output?.clockAnchor);
  for (const sample of samples) {
    expect(sample.measurementId).toBe(anchor.measurementId);
    expect(sample.contextTime - sample.windowStartTime).toBeCloseTo(0.02, 4);
    expect(sample.clockAnchor.performanceNowMs).toBeLessThan(600_000);
  }
  const contexts = media.filter((entry) => entry === "synthetic-context-created").length;
  expect(contexts).toBe(3);
  expect(media.filter((entry) => entry === "synthetic-meter-playback-buffer")).toHaveLength(1);
  await page.getByRole("button", { name: "同意して録音を開始", exact: true }).click();
  await expect(page.getByRole("button", { name: "録音を停止", exact: true })).toBeVisible();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "録音を停止", exact: true }).click();
  await expect(page.getByRole("link", { name: "音声をダウンロード", exact: true })).toBeVisible();
  expect(media.filter((entry) => entry === "synthetic-context-created")).toHaveLength(contexts);
  await page.evaluate(() => { window.dispatchEvent(new Event("synthetic-silence-output")); });
  await expect.poll(() => captured.events.some((event) => event.type === "sample" && event.direction === "output" && event.transition === "stop")).toBe(true);
  const stop = captured.events.find((event) => event.type === "sample" && event.direction === "output" && event.transition === "stop");
  if (stop?.type !== "sample" || stop.transitionTime === null) throw new Error("Confirmed PCM stop missing.");
  expect(stop.contextTime - stop.transitionTime).toBeCloseTo(0.12, 4);
  await page.getByRole("button", { name: "停止して切断", exact: true }).click();
  await expect(page.getByRole("button", { name: "状態＋計測JSONを書き出す", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "状態＋計測JSONを書き出す", exact: true }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "JSONをダウンロード", exact: true }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Local JSON download missing.");
  let text = "";
  for await (const chunk of stream) text += String(chunk);
  await download.delete();
  const exported = parseLocalSession(text);
  expect(exported.measurements.some((event) => event.type === "sample")).toBe(true);
  expect(text).not.toContain("synthetic-fixed-microphone");
  const requestsBeforeReplay = mock.calls.length;
  const measurementsBeforeReplay = captured.events.length;
  await page.getByLabel("ローカルJSONを読み込む").setInputFiles({ name: "synthetic-local.json", mimeType: "application/json", buffer: Buffer.from(text) });
  await expect(page.getByText("ローカルリプレイ（接続・操作送信なし）", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "計測をリプレイ", exact: true }).click();
  await expect(page.getByRole("button", { name: "リプレイを一時停止", exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  await expect(page.getByLabel("ローカルの計測リプレイ").locator("output")).not.toHaveText(/^0\.00 /);
  expect(mock.calls).toHaveLength(requestsBeforeReplay);
  expect(captured.events).toHaveLength(measurementsBeforeReplay);
  expect(captured.invalid).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("forward gaps mark missing evidence; backward frames close media without manufacturing silence", async ({ page }) => {
  const captured = await captureMeasurements(page);
  await syntheticWebRtc(page);
  await page.addInitScript(() => {
    class FaultableWorklet extends AudioWorkletNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        window.addEventListener("synthetic-processor-gap", () => {
          this.port.dispatchEvent(new MessageEvent("message", {
            data: { generation: 1, gapFrames: 1024 },
          }));
        }, { once: true });
        window.addEventListener("synthetic-processor-failure", () => {
          this.port.dispatchEvent(new MessageEvent("message", {
            data: { generation: 0, failure: "frame-discontinuity", frameDelta: -128 },
          }));
        }, { once: true });
      }
    }
    Object.defineProperty(window, "AudioWorkletNode", { value: FaultableWorklet });
  });
  const mock = await harness(page, true);
  await acceptSyntheticSession(page);
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect(page.locator(".source-banner")).toContainText("実音声 接続中");
  const pauses = captured.events.filter((event) => event.type === "status" && event.status === "paused").length;
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-processor-gap")));
  await expect(page.getByText(/音声計測にフレーム欠落があります/)).toBeVisible();
  expect(captured.events.filter((event) => event.type === "status" && event.status === "paused")).toHaveLength(pauses + 1);
  await expect(page.locator(".source-banner")).toContainText("実音声 接続中");
  expect(mock.calls.some((call) => call.path === "/api/session/close")).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-processor-failure")));
  await expect(page.getByRole("alert")).toContainText("frame-discontinuity, frameDelta=-128");
  await expect.poll(() => mock.calls.filter((call) => call.path === "/api/session/close").length).toBe(1);
  expect(mock.calls.some((call) => call.path === "/api/stop")).toBe(true);
  expect(mock.calls.some((call) => call.path === "/api/simulation/start")).toBe(false);
  expect(captured.events.some((event) => event.type === "status" && event.status === "error")).toBe(true);
  expect(captured.events.some((event) => event.type === "sample" && event.transition === "stop")).toBe(false);
});

test("unsupported worklets fail explicitly, with no live or simulation fallback", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "AudioWorkletNode", { value: undefined }); });
  const mock = await harness(page, true);
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("AudioWorklet");
  expect(mock.calls.some((entry) => entry.path === "/api/session" || entry.path === "/api/simulation/start")).toBe(false);
});

test("local import rejects unexpected data and the measurement event cannot control upstream actions", async ({ page }) => {
  const mock = await harness(page);
  await page.getByLabel("ローカルJSONを読み込む").setInputFiles({
    name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"format":"voice-action-lab.local-session","version":1,"token":"synthetic-secret"}'),
  });
  await expect(page.getByRole("alert")).toContainText("ローカル保存形式");
  await expect(page.getByLabel("ローカルの計測リプレイ")).toHaveCount(0);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("voice-action-lab:audio-measurement", { detail: { type: "move", cargo: "red", destination: "right" } }));
  });
  expect(mock.calls).toEqual([]);
});

test("server export import replays recorded events locally without PCM, cloud calls or executing commands", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2030-01-01T00:00:01Z"));
  const captured = await captureMeasurements(page);
  const mock = await harness(page, true);
  const archive = serverExportFixture();
  await page.getByLabel("ローカルJSONを読み込む").setInputFiles({
    name: "synthetic-server-export.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(archive)),
  });
  const replay = page.getByLabel("ローカルの計測リプレイ");
  await expect(replay).toContainText("形式：サーバー書き出し v1");
  await expect(replay).toContainText("記録元：実音声 / B");
  await expect(replay).toContainText("保存時の接続状態：エラー");
  await expect(replay).toContainText("未確認（ファイル記載）");
  await expect(replay).toContainText("PCM計測窓がありません");
  await expect(replay.getByRole("meter")).toHaveCount(0);
  const events = replay.getByLabel("保存されたサーバーイベント");
  await expect(events.getByText("command.observed", { exact: true })).toBeVisible();
  await expect(events.getByText("step.committed", { exact: true })).toHaveCount(0);
  await replay.getByRole("button", { name: "サーバーイベントをリプレイ", exact: true }).click();
  await page.clock.fastForward(1001);
  await expect(events.getByText("step.committed", { exact: true })).toBeVisible();
  await expect(events.getByText("final_usage_unconfirmed", { exact: true })).toHaveCount(0);
  await page.clock.fastForward(1000);
  await expect(events.getByText("final_usage_unconfirmed", { exact: true })).toBeVisible();
  await expect(events.getByText("final_usage_confirmed", { exact: true })).toHaveCount(0);
  await expect(replay).toContainText("保存時の最終位置：赤 x=4、青 x=0");
  await expect(page.locator(".source-banner")).toContainText("シミュレーション（実音声の検証ではありません）");
  expect(mock.calls).toEqual([]);
  expect(mock.requests.every((path) => path === "/api/config" || path === "/api/state")).toBe(true);
  expect(captured.events).toEqual([]);
  expect(captured.invalid).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("server import does not upgrade unconfirmed usage or silently replace the loaded replay", async ({ page }) => {
  const mock = await harness(page);
  const document = serverExportFixture();
  await page.getByLabel("ローカルJSONを読み込む").setInputFiles({
    name: "valid-server.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(document)),
  });
  await expect(page.getByLabel("ローカルの計測リプレイ")).toContainText("未確認（ファイル記載）");
  const forged = { ...document, usage: { scope: "voice-session-only", status: "confirmed", metrics: {} } };
  await page.getByLabel("ローカルJSONを読み込む").setInputFiles({
    name: "invalid-server.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(forged)),
  });
  await expect(page.getByRole("alert")).toContainText("確認状態が保存されたイベントと一致しません");
  await expect(page.getByLabel("ローカルの計測リプレイ")).toContainText("未確認（ファイル記載）");
  expect(mock.calls).toEqual([]);
  expect(mock.requests.every((path) => path === "/api/config" || path === "/api/state")).toBe(true);
});

for (const source of ["input", "output"] as const) {
  test(`${source}-only media activity waits for ready, uses relative offsets, throttles, and stops on disposal`, async ({ page }) => {
    await syntheticWebRtc(page, { inputTone: source === "input", outputTone: source === "output" });
    const mock = await harness(page, true);
    await acceptSyntheticSession(page);
    const gate: { release: () => void } = { release: () => { throw new Error("Uninitialized activity ready gate."); } };
    const pending = new Promise<void>((resolve) => { gate.release = resolve; });
    let readyCalls = 0;
    await page.route("**/api/session/ready", async (route) => {
      ++readyCalls;
      const next = mock.snapshot();
      next.game.stopped = false;
      next.session.source = "live";
      next.session.transport = "connected";
      mock.publish(next);
      await pending;
      await route.fulfill({ json: next });
    });
    const activityCalls = () => mock.calls.filter((entry) => entry.path === "/api/activity");
    await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
    await expect.poll(() => readyCalls).toBe(1);
    await page.waitForTimeout(2200);
    expect(activityCalls()).toEqual([]);
    gate.release();
    await expect(page.locator(".source-banner")).toContainText("実音声 接続中");
    await expect.poll(() => activityCalls().length).toBeGreaterThanOrEqual(2);
    const offsets = activityCalls().map(({ body }) => {
      expect(body).toEqual({ offsetMs: expect.any(Number) });
      if (!body || typeof body !== "object" || !("offsetMs" in body) || typeof body.offsetMs !== "number") {
        throw new Error("Activity offset is missing.");
      }
      expect(Number.isInteger(body.offsetMs)).toBe(true);
      expect(body.offsetMs).toBeGreaterThanOrEqual(0);
      expect(body.offsetMs).toBeLessThanOrEqual(600_000);
      return body.offsetMs;
    });
    expect(offsets.every((offset, index) => index === 0 || offset - (offsets[index - 1] ?? offset) >= 2000)).toBe(true);
    await page.getByRole("button", { name: "停止して切断", exact: true }).click();
    await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeEnabled();
    const stoppedCount = activityCalls().length;
    await page.waitForTimeout(2200);
    expect(activityCalls()).toHaveLength(stoppedCount);
  });
}

test("silent media and transcript-only events never send audio activity heartbeats", async ({ page }) => {
  await syntheticWebRtc(page);
  const mock = await harness(page, true);
  await acceptSyntheticSession(page);
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect(page.locator(".source-banner")).toContainText("実音声 接続中");
  await page.evaluate(() => { window.dispatchEvent(new Event("synthetic-transcript")); });
  await page.locator(".transcript-details > summary").click();
  await expect(page.locator(".transcript-scroll")).toContainText("Synthetic transcript without audio");
  await page.waitForTimeout(2500);
  expect(mock.calls.filter((entry) => entry.path === "/api/activity")).toEqual([]);
  await page.getByRole("button", { name: "停止して切断", exact: true }).click();
  await page.getByRole("button", { name: "シミュレーションを開始", exact: true }).click();
  await expect(page.locator(".source-banner")).toContainText("シミュレーション（実音声の検証ではありません）");
  await page.waitForTimeout(2200);
  expect(mock.calls.filter((entry) => entry.path === "/api/activity")).toEqual([]);
});

test("activity authorization failures are visible, close all media, and never fall back to simulation", async ({ page }) => {
  const media = await syntheticWebRtc(page, { inputTone: true });
  const mock = await harness(page, true);
  await acceptSyntheticSession(page);
  await page.route("**/api/activity", (route) => route.fulfill({ status: 403, json: { error: "Synthetic activity denied" } }));
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("音声活動の通知に失敗しました");
  await expect(page.getByRole("alert")).toContainText("許可されていません");
  await expect.poll(() => media.includes("synthetic-mic-stopped") && media.includes("synthetic-peer-closed")).toBe(true);
  await expect.poll(() => mock.calls.some((entry) => entry.path === "/api/session/close")).toBe(true);
  expect(mock.calls.some((entry) => entry.path === "/api/simulation/start")).toBe(false);
});

test("activity reporting keeps one request in flight and ignores its acknowledgement after stop", async ({ page }) => {
  const media = await syntheticWebRtc(page, { inputTone: true });
  const mock = await harness(page, true);
  await acceptSyntheticSession(page);
  const gate: { release: () => void } = { release: () => { throw new Error("Uninitialized activity HTTP gate."); } };
  const pending = new Promise<void>((resolve) => { gate.release = resolve; });
  let activityCalls = 0;
  await page.route("**/api/activity", async (route) => {
    ++activityCalls;
    await pending;
    await route.fulfill({ json: { ok: true } });
  });
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect.poll(() => activityCalls).toBe(1);
  await page.waitForTimeout(2200);
  expect(activityCalls).toBe(1);
  await page.getByRole("button", { name: "停止して切断", exact: true }).click();
  await expect.poll(() => media.includes("synthetic-mic-stopped")).toBe(true);
  gate.release();
  await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeEnabled();
  await page.waitForTimeout(2200);
  expect(activityCalls).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(mock.calls.some((entry) => entry.path === "/api/session/close")).toBe(true);
});

test("simulation is explicit, mode locks during a run, and no positions are invented", async ({ page }) => {
  const mock = await harness(page);
  await expect(page.getByText("途中で「待って、赤じゃなくて青を右に」", { exact: true })).toBeVisible();
  await expect(page.getByText("シミュレーション（実音声の検証ではありません）", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeDisabled();
  await page.getByText("音声 ＋ 操作を取り消す", { exact: true }).click();
  await expect(page.getByRole("radio", { name: /B.*音声/ })).toBeChecked();
  await page.getByRole("button", { name: "シミュレーションを開始", exact: true }).click();
  await expect(page.getByRole("radio", { name: /A.*音声/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeDisabled();
  await expect.poll(() => mock.calls[0]).toEqual({ path: "/api/simulation/start", body: { mode: "cancel-actions" } });
  await page.getByRole("button", { name: "移動", exact: true }).click();
  await expect(page.getByRole("button", { name: "移動", exact: true })).toBeEnabled();
  await expect(page.getByLabel("赤の箱、位置 3")).toBeVisible();
  const next = mock.snapshot();
  next.game.cargo.red = 4;
  next.game.events.push({ sequence: 1, atMs: 100, kind: "step.committed", operationId: null, delegationId: null, details: { position: 4 } });
  mock.publish(next);
  await expect(page.getByLabel("赤の箱、位置 4")).toBeVisible();
  await expect(page.getByText("step.committed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消を送信", exact: true }).click();
  await expect(page.getByLabel("赤の箱、位置 4")).toBeVisible();
  await page.getByRole("button", { name: "停止して切断", exact: true }).click();
  await expect(page.getByRole("radio", { name: /A.*音声/ })).toBeEnabled();
  expect(mock.calls.some((entry) => entry.path === "/api/session")).toBe(false);
});

test("manual blue replacement sends the exact GameCommand", async ({ page }) => {
  const mock = await harness(page);
  await page.getByRole("button", { name: "シミュレーションを開始", exact: true }).click();
  await page.getByLabel("箱", { exact: true }).selectOption("blue");
  await page.getByLabel("行き先", { exact: true }).selectOption("left");
  await page.getByRole("button", { name: "指示を置換", exact: true }).click();
  await expect.poll(() => mock.calls.filter((entry) => entry.path === "/api/command")).toEqual([
    { path: "/api/command", body: { type: "replace", cargo: "blue", destination: "left" } },
  ]);
});

test("invalid state is visible and disables commands instead of defaulting to success", async ({ page }) => {
  const mock = await harness(page);
  await page.getByRole("button", { name: "シミュレーションを開始", exact: true }).click();
  mock.malformed();
  await expect(page.getByRole("alert")).toContainText("契約と一致しません");
  await expect(page.getByRole("button", { name: "移動", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /すべて停止/ })).toBeEnabled();
});

test("microphone denial closes the attempt and never starts simulation", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => { throw new DOMException("Synthetic denied permission", "NotAllowedError"); },
    });
  });
  const mock = await harness(page, true);
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("マイクの使用が許可されていません");
  await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeEnabled();
  expect(mock.calls.some((entry) => entry.path === "/api/simulation/start" || entry.path === "/api/session")).toBe(false);
  expect(mock.calls.some((entry) => entry.path === "/api/session/close")).toBe(true);
});

test("emergency stop invalidates a late microphone permission result", async ({ page }) => {
  const stopped: string[] = [];
  page.on("console", (message) => { if (message.text() === "synthetic-mic-stopped") stopped.push(message.text()); });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: () => new Promise<MediaStream>((resolve) => {
        window.addEventListener("synthetic-release-mic", () => {
          const context = new AudioContext();
          const destination = context.createMediaStreamDestination();
          const stream = destination.stream;
          const track = stream.getAudioTracks()[0];
          if (!track) throw new Error("Synthetic test track missing.");
          const stop = track.stop.bind(track);
          track.stop = () => {
            stop();
            void context.close();
            console.log("synthetic-mic-stopped");
          };
          resolve(stream);
        }, { once: true });
      }),
    });
  });
  const mock = await harness(page, true);
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect(page.getByText(/マイクの許可待ち/)).toBeVisible();
  await page.getByRole("button", { name: /すべて停止/ }).click();
  await expect(page.getByRole("button", { name: "シミュレーションを開始", exact: true })).toBeEnabled();
  await page.evaluate(() => { window.dispatchEvent(new Event("synthetic-release-mic")); });
  await expect.poll(() => stopped.length).toBe(1);
  expect(mock.calls.some((entry) => entry.path === "/api/session" || entry.path === "/api/simulation/start")).toBe(false);
});

test("a server expiry stops the run after displaying the session.message idle warning", async ({ page }) => {
  await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2030-01-01T00:00:01Z"));
  const mock = await harness(page);
  await page.getByRole("button", { name: "シミュレーションを開始", exact: true }).click();
  await expect(page.getByRole("button", { name: "移動", exact: true })).toBeEnabled();
  const next = mock.snapshot();
  next.session.expiresAt = "2030-01-01T00:00:02Z";
  next.session.message = "Synthetic idle warning";
  mock.publish(next);
  await expect(page.getByText("Synthetic idle warning", { exact: true })).toBeVisible();
  expect(mock.calls.some((entry) => entry.path === "/api/stop")).toBe(false);
  await page.clock.fastForward(1_001);
  await expect.poll(() => mock.calls.some((entry) => entry.path === "/api/stop")).toBe(true);
  await expect(page.getByRole("button", { name: "シミュレーションを開始", exact: true })).toBeEnabled();
});

test("small viewport has no horizontal overflow and reduced motion removes interpolation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await harness(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.getByLabel("赤の箱、位置 3").evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");
  await expect(page.getByRole("button", { name: /すべて停止/ })).toBeVisible();
});

test("gathered SDP precedes peer and channel readiness, and mic stays disabled until sideband succeeds", async ({ page }) => {
  const media = await syntheticWebRtc(page, { holdIce: true, holdPeer: true, holdChannel: true });
  const mock = await harness(page, true);
  const sessionBodies: unknown[] = [];
  const gate: { release: () => void } = { release: () => { throw new Error("Uninitialized sideband gate."); } };
  const pending = new Promise<void>((resolve) => { gate.release = resolve; });
  let readyCalls = 0;
  await page.route("**/api/session", async (route) => {
    sessionBodies.push(route.request().postDataJSON());
    await route.fulfill({ json: { sdp: "synthetic-answer", expiresAt: new Date(Date.now() + 600_000).toISOString() } });
  });
  await page.route("**/api/session/ready", async (route) => {
    ++readyCalls;
    expect(route.request().postDataJSON()).toEqual({});
    expect(media).toContain("synthetic-peer-connected");
    expect(media).toContain("synthetic-channel-open");
    const next = mock.snapshot();
    next.game.runId = "synthetic-live-run";
    next.game.stopped = false;
    next.session.source = "live";
    next.session.transport = "connected";
    mock.publish(next);
    await pending;
    await route.fulfill({ json: next });
  });
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect.poll(() => media.includes("synthetic-ice-gathering")).toBe(true);
  expect(sessionBodies).toEqual([]);
  await expectMicEnabled(page, media, false);
  await page.evaluate(() => { window.dispatchEvent(new Event("synthetic-complete-ice")); });
  await expect.poll(() => media.includes("synthetic-answer-applied")).toBe(true);
  expect(sessionBodies).toEqual([{ mode: "voice-only", sdp: "synthetic-gathered-offer" }]);
  expect(readyCalls).toBe(0);
  await page.evaluate(() => { window.dispatchEvent(new Event("synthetic-connect-peer")); });
  await expect.poll(() => media.includes("synthetic-peer-connected")).toBe(true);
  expect(readyCalls).toBe(0);
  await expectMicEnabled(page, media, false);
  await page.evaluate(() => { window.dispatchEvent(new Event("synthetic-open-channel")); });
  await expect.poll(() => readyCalls).toBe(1);
  await expect(page.locator(".source-banner")).toContainText("音声接続中");
  await expectMicEnabled(page, media, false);
  await expect(page.getByText("接続準備中・マイク送信停止中", { exact: true })).toBeVisible();
  expect(mock.calls.some((entry) => entry.path === "/api/stop")).toBe(false);
  await page.evaluate(() => { window.dispatchEvent(new Event("synthetic-connect-peer")); });
  gate.release();
  await expect(page.locator(".source-banner")).toContainText("実音声 接続中");
  await expectMicEnabled(page, media, true);
  expect(readyCalls).toBe(1);
  const next = mock.snapshot();
  next.game.stopped = true;
  next.session.transport = "disconnected";
  mock.publish(next);
  await expect.poll(() => media.includes("synthetic-mic-stopped") && media.includes("synthetic-peer-closed")).toBe(true);
  await expect.poll(() => mock.calls.some((entry) => entry.path === "/api/session/close")).toBe(true);
  expect(mock.calls.some((entry) => entry.path === "/api/simulation/start")).toBe(false);
});

test("stop closes local media immediately and waits for a late SDP exchange before final server cleanup", async ({ page }) => {
  const media = await syntheticWebRtc(page);
  const mock = await harness(page, true);
  const gate: { release: () => void } = { release: () => { throw new Error("Synthetic SDP gate was not initialized."); } };
  const pending = new Promise<void>((resolve) => { gate.release = resolve; });
  let sessionCalls = 0;
  await page.route("**/api/session", async (route) => {
    ++sessionCalls;
    await pending;
    await route.fulfill({ json: { sdp: "synthetic-late-answer", expiresAt: new Date(Date.now() + 600_000).toISOString() } });
  });
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect.poll(() => sessionCalls).toBe(1);
  await page.getByRole("button", { name: /すべて停止/ }).click();
  await expect.poll(() => media.includes("synthetic-mic-stopped") && media.includes("synthetic-peer-closed")).toBe(true);
  await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "シミュレーションを開始", exact: true })).toBeDisabled();
  expect(mock.calls.some((entry) => entry.path === "/api/session/close")).toBe(false);
  gate.release();
  await expect.poll(() => mock.calls.some((entry) => entry.path === "/api/session/close")).toBe(true);
  await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeEnabled();
  expect(media.includes("synthetic-answer-applied")).toBe(false);
  expect(mock.calls.some((entry) => entry.path === "/api/session/ready")).toBe(false);
  expect(mock.calls.some((entry) => entry.path === "/api/simulation/start")).toBe(false);
  expect(sessionCalls).toBe(1);
});

test("sequential live A and B use the same microphone and never enable manual commands", async ({ page }) => {
  const media = await syntheticWebRtc(page);
  const mock = await harness(page, true);
  const sessionBodies: unknown[] = [];
  await page.route("**/api/session", async (route) => {
    const body: unknown = route.request().postDataJSON();
    sessionBodies.push(body);
    const next = mock.snapshot();
    next.game.runId = `synthetic-live-${sessionBodies.length}`;
    next.game.mode = body && typeof body === "object" && "mode" in body && body.mode === "cancel-actions" ? "cancel-actions" : "voice-only";
    next.game.stopped = false;
    next.session.source = "live";
    next.session.transport = "connected";
    mock.publish(next);
    await route.fulfill({ json: { sdp: "synthetic-answer", expiresAt: new Date(Date.now() + 600_000).toISOString() } });
  });
  for (const mode of ["voice-only", "cancel-actions"] as const) {
    if (mode === "cancel-actions") await page.getByText("音声 ＋ 操作を取り消す", { exact: true }).click();
    await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
    await expect.poll(async () => ({
      connected: (await page.locator(".source-banner").innerText()).includes("実音声 接続中"),
      errors: await page.getByRole("alert").allTextContents(),
      stoppedByServer: (await page.locator(".command-notice").allTextContents()).some((text) => text.includes("サーバーが実行を終了")),
    })).toEqual({ connected: true, errors: [], stoppedByServer: false });
    await expect(page.getByRole("button", { name: "シミュレーションを開始", exact: true })).toBeDisabled();
    if (!(await page.getByRole("button", { name: "移動", exact: true }).isVisible())) {
      await page.locator(".manual-controls > summary").click();
    }
    await expect(page.getByRole("button", { name: "移動", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "停止して切断", exact: true }).click();
    await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeEnabled();
  }
  expect(sessionBodies).toEqual([
    { mode: "voice-only", sdp: "synthetic-gathered-offer" },
    { mode: "cancel-actions", sdp: "synthetic-gathered-offer" },
  ]);
  expect(mock.calls.filter((entry) => entry.path === "/api/session/ready").map((entry) => entry.body)).toEqual([{}, {}]);
  expect(media.filter((entry) => entry === "synthetic-track-attached-disabled true")).toHaveLength(2);
  expect(media.filter((entry) => entry === "synthetic-peer-closed")).toHaveLength(2);
  expect(media.filter((entry) => entry === "synthetic-mic-stopped")).toHaveLength(2);
  expect(media.filter((entry) => entry.startsWith("synthetic-mic-constraints"))).toEqual([
    'synthetic-mic-constraints {"audio":true,"video":false}',
    'synthetic-mic-constraints {"audio":{"deviceId":{"exact":"synthetic-fixed-microphone"}},"video":false}',
  ]);
});

test("ICE timeout closes every local resource without posting SDP or ready", async ({ page }) => {
  await page.clock.install();
  const media = await syntheticWebRtc(page, { holdIce: true });
  const mock = await harness(page, true);
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect.poll(() => media.includes("synthetic-ice-gathering")).toBe(true);
  await expectMicEnabled(page, media, false);
  await page.clock.fastForward(8_001);
  await expect(page.getByRole("alert")).toContainText("8 秒以内");
  await expect.poll(() => media.includes("synthetic-mic-stopped") && media.includes("synthetic-peer-closed")
    && media.includes("synthetic-channel-closed")).toBe(true);
  expect(mock.calls.some((entry) => entry.path === "/api/session" || entry.path === "/api/session/ready")).toBe(false);
  expect(media).toContain("synthetic-mic-stopped-enabled false");
});

for (const blocked of [
  { name: "peer", options: { holdPeer: true } },
  { name: "channel", options: { holdChannel: true } },
]) {
  test(`twenty-five-second ${blocked.name} timeout never attaches sideband or enables the mic`, async ({ page }) => {
    await page.clock.install();
    const media = await syntheticWebRtc(page, blocked.options);
    const mock = await harness(page, true);
    await page.route("**/api/session", async (route) => {
      await route.fulfill({ json: { sdp: "synthetic-answer", expiresAt: new Date(Date.now() + 600_000).toISOString() } });
    });
    await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
    await expect.poll(() => media.includes("synthetic-answer-applied")).toBe(true);
    await expectMicEnabled(page, media, false);
    await page.clock.fastForward(25_001);
    await expect(page.getByRole("alert")).toContainText("25 秒以内");
    await expect.poll(() => media.includes("synthetic-mic-stopped") && media.includes("synthetic-peer-closed")).toBe(true);
    expect(mock.calls.some((entry) => entry.path === "/api/session/ready")).toBe(false);
    expect(media).toContain("synthetic-mic-stopped-enabled false");
  });
}

test("failed trusted sideband setup fails explicitly and leaves the microphone disabled", async ({ page }) => {
  const media = await syntheticWebRtc(page);
  const mock = await harness(page, true);
  await page.route("**/api/session", async (route) => {
    await route.fulfill({ json: { sdp: "synthetic-answer", expiresAt: new Date(Date.now() + 600_000).toISOString() } });
  });
  let readyCalls = 0;
  await page.route("**/api/session/ready", async (route) => {
    ++readyCalls;
    await route.fulfill({ status: 503, json: { error: "Synthetic trusted sideband failure" } });
  });
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Synthetic trusted sideband failure");
  await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeEnabled();
  expect(readyCalls).toBe(1);
  expect(media).toContain("synthetic-track-attached-disabled true");
  expect(media).toContain("synthetic-mic-stopped-enabled false");
  expect(media).toContain("synthetic-peer-closed");
  expect(mock.calls.some((entry) => entry.path === "/api/session/close")).toBe(true);
  expect(mock.calls.some((entry) => entry.path === "/api/simulation/start")).toBe(false);
});

test("stopping during ready waits for late sideband attachment and never enables a closed microphone", async ({ page }) => {
  const media = await syntheticWebRtc(page);
  const mock = await harness(page, true);
  const gate: { release: () => void } = { release: () => { throw new Error("Uninitialized ready gate."); } };
  const pending = new Promise<void>((resolve) => { gate.release = resolve; });
  await page.route("**/api/session", async (route) => {
    await route.fulfill({ json: { sdp: "synthetic-answer", expiresAt: new Date(Date.now() + 600_000).toISOString() } });
  });
  let readyCalls = 0;
  await page.route("**/api/session/ready", async (route) => {
    ++readyCalls;
    const late = mock.snapshot();
    late.game.stopped = false;
    late.session.source = "live";
    late.session.transport = "connected";
    await pending;
    await route.fulfill({ json: late });
  });
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect.poll(() => readyCalls).toBe(1);
  await expectMicEnabled(page, media, false);
  await page.getByRole("button", { name: /すべて停止/ }).click();
  await expect.poll(() => media.includes("synthetic-peer-closed") && media.includes("synthetic-mic-stopped")).toBe(true);
  expect(media).toContain("synthetic-mic-stopped-enabled false");
  expect(mock.calls.some((entry) => entry.path === "/api/session/close")).toBe(false);
  await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeDisabled();
  gate.release();
  await expect.poll(() => mock.calls.some((entry) => entry.path === "/api/session/close")).toBe(true);
  await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeEnabled();
  expect(readyCalls).toBe(1);
  expect(mock.calls.some((entry) => entry.path === "/api/simulation/start")).toBe(false);
});

test("stopping during ICE gathering ignores subsequent gathering completion", async ({ page }) => {
  const media = await syntheticWebRtc(page, { holdIce: true });
  const mock = await harness(page, true);
  await page.getByRole("button", { name: "実音声に接続", exact: true }).click();
  await expect.poll(() => media.includes("synthetic-ice-gathering")).toBe(true);
  await page.getByRole("button", { name: /すべて停止/ }).click();
  await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeEnabled();
  await page.evaluate(() => { window.dispatchEvent(new Event("synthetic-complete-ice")); });
  expect(media).toContain("synthetic-mic-stopped-enabled false");
  expect(mock.calls.some((entry) => entry.path === "/api/session" || entry.path === "/api/session/ready")).toBe(false);
});

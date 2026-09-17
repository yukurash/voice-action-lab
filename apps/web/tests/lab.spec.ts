import { expect, test } from "@playwright/test";
import type { Page, WebSocketRoute } from "@playwright/test";
import type { BrowserState } from "../../../packages/contracts/index.ts";

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

async function syntheticWebRtc(page: Page, options: { holdIce?: boolean; holdPeer?: boolean; holdChannel?: boolean } = {}): Promise<string[]> {
  const messages: string[] = [];
  page.on("console", (message) => {
    if (message.text().startsWith("synthetic-")) messages.push(message.text());
  });
  await page.addInitScript((settings) => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async (constraints: MediaStreamConstraints) => {
        console.log(`synthetic-mic-constraints ${JSON.stringify(constraints)}`);
        const context = new AudioContext();
        const stream = context.createMediaStreamDestination().stream;
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
          void context.close();
          console.log("synthetic-mic-stopped");
        };
        return stream;
      },
    });
    class SyntheticChannel extends EventTarget {
      readyState = "connecting";
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
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

test("simulation is explicit, mode locks during a run, and no positions are invented", async ({ page }) => {
  const mock = await harness(page);
  await expect(page.getByText("シミュレーション（実音声の検証ではありません）", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeDisabled();
  await page.getByText("音声 ＋ 操作を取り消す", { exact: true }).click();
  await expect(page.getByRole("radio", { name: /B.*音声/ })).toBeChecked();
  await page.getByRole("button", { name: "シミュレーションを開始", exact: true }).click();
  await expect(page.getByRole("radio", { name: /A.*音声/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "実音声に接続", exact: true })).toBeDisabled();
  expect(mock.calls[0]).toEqual({ path: "/api/simulation/start", body: { mode: "cancel-actions" } });
  await page.getByRole("button", { name: "移動", exact: true }).click();
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

test("a server expiry stops the run and future idle warnings are displayed", async ({ page }) => {
  const mock = await harness(page);
  await page.getByRole("button", { name: "シミュレーションを開始", exact: true }).click();
  const next = mock.snapshot();
  next.session.expiresAt = new Date(Date.now() + 500).toISOString();
  const warning = { ...next, session: { ...next.session, idleWarning: "Synthetic idle warning" } };
  mock.publish(warning);
  await expect(page.getByText("Synthetic idle warning", { exact: true })).toBeVisible();
  await expect.poll(() => mock.calls.some((entry) => entry.path === "/api/stop")).toBe(true);
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
    await expect(page.locator(".source-banner")).toContainText("実音声 接続中");
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

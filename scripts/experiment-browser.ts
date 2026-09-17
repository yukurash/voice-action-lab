import { chromium } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { BrowserState } from "../packages/contracts/index.ts";
import { isBrowserState } from "../apps/web/src/api.ts";

export interface PlaybackMarker {
  id: string;
  contextTime: number;
  performanceTimeMs: number;
  durationSeconds: number;
  endedAt?: number;
}

interface SyntheticCapture {
  context: AudioContext;
  destination: MediaStreamAudioDestinationNode;
  silence: ConstantSourceNode;
  track: MediaStreamTrack;
  peer?: RTCPeerConnection;
}

interface ExperimentProbe {
  capture?: SyntheticCapture;
  playbacks: PlaybackMarker[];
  measurements: unknown[];
  transcripts: { type: string; receivedAtPerformanceMs: number; text: string }[];
  errors: string[];
}

declare global {
  interface Window {
    __voiceActionExperiment?: ExperimentProbe;
  }
}

export interface ExperimentBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  routes: string[];
}

export async function openExperimentBrowser(origin: string, bearer?: string): Promise<ExperimentBrowser> {
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) {
    throw new Error("invalid_experiment_origin");
  }
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : process.platform === "win32" ? { channel: "msedge" } : {}),
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  try {
    const context = await browser.newContext({
      permissions: ["microphone"],
      extraHTTPHeaders: bearer ? { Authorization: `Bearer ${bearer}`, Origin: origin } : {},
    });
    await context.route("**/*", (route) => new URL(route.request().url()).origin === origin
      ? route.continue() : route.abort());
    await context.addInitScript(() => {
      const probe: ExperimentProbe = { playbacks: [], measurements: [], transcripts: [], errors: [] };
      window.__voiceActionExperiment = probe;
      window.addEventListener("voice-action-lab:audio-measurement", (event) => {
        if (!(event instanceof CustomEvent)) return;
        const value: unknown = event.detail;
        if (probe.measurements.length >= 20_000) {
          if (!probe.errors.includes("measurement_capacity_exceeded")) probe.errors.push("measurement_capacity_exceeded");
          return;
        }
        probe.measurements.push(value);
      });
      const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (probe.capture) throw new Error("unexpected_second_microphone_capture");
        const permission = await nativeCapture(constraints);
        const original = permission.getAudioTracks()[0];
        if (!original) {
          permission.getTracks().forEach((track) => track.stop());
          throw new Error("synthetic_audio_track_missing");
        }
        const deviceId = original.getSettings().deviceId;
        const context = new AudioContext({ sampleRate: 48_000 });
        await context.resume();
        const destination = context.createMediaStreamDestination();
        const silence = context.createConstantSource();
        silence.offset.value = 0;
        silence.connect(destination);
        silence.start();
        const track = destination.stream.getAudioTracks()[0];
        if (!track) throw new Error("synthetic_destination_track_missing");
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), ...(deviceId ? { deviceId } : {}) });
        permission.getTracks().forEach((entry) => entry.stop());
        probe.capture = { context, destination, silence, track };
        return destination.stream;
      };
      const addTrack = RTCPeerConnection.prototype.addTrack;
      RTCPeerConnection.prototype.addTrack = function (this: RTCPeerConnection, ...args) {
        if (probe.capture && args[0] === probe.capture.track) probe.capture.peer = this;
        return addTrack.apply(this, args);
      };
      const createDataChannel = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function (this: RTCPeerConnection, ...args) {
        const channel = createDataChannel.apply(this, args);
        channel.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            probe.errors.push("non_json_data_channel_event");
            return;
          }
          let value: unknown;
          try {
            value = JSON.parse(event.data);
          } catch {
            probe.errors.push("invalid_data_channel_json");
            return;
          }
          if (!value || typeof value !== "object" || !("type" in value) || !("delta" in value)) return;
          if (value.type !== "session.input_transcript.delta" && value.type !== "session.output_transcript.delta") return;
          if (typeof value.delta !== "string" || value.delta.length > 2_048 || probe.transcripts.length >= 2_000) {
            probe.errors.push("transcript_capacity_exceeded");
            return;
          }
          probe.transcripts.push({ type: value.type, receivedAtPerformanceMs: performance.now(), text: value.delta });
        });
        return channel;
      };
    });
    const page = await context.newPage();
    const routes: string[] = [];
    page.on("request", (request) => {
      const target = new URL(request.url());
      if (target.origin === origin && request.method() === "POST") routes.push(target.pathname);
    });
    return { browser, context, page, routes };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function readExperimentState(page: Page): Promise<BrowserState> {
  const value: unknown = await page.evaluate(async () => {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error(`state_http_${response.status}`);
    return response.json();
  });
  if (!isBrowserState(value)) throw new Error("invalid_state_contract");
  return value;
}

export async function playFixture(page: Page, id: string, base64: string): Promise<PlaybackMarker> {
  if (base64.length > 1_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("invalid_fixture_encoding");
  return page.evaluate(async ({ id, base64 }) => {
    const probe = window.__voiceActionExperiment;
    const capture = probe?.capture;
    if (!probe || !capture || !capture.track.enabled || capture.context.state !== "running") {
      throw new Error("synthetic_microphone_not_ready");
    }
    const source = capture.context.createBufferSource();
    source.buffer = await capture.context.decodeAudioData(
      Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)).buffer,
    );
    if (source.buffer.duration > 12) throw new Error("fixture_duration_exceeded");
    source.connect(capture.destination);
    const marker: PlaybackMarker = {
      id, contextTime: capture.context.currentTime, performanceTimeMs: performance.now(),
      durationSeconds: source.buffer.duration,
    };
    probe.playbacks.push(marker);
    source.onended = () => { marker.endedAt = capture.context.currentTime; };
    source.start();
    return marker;
  }, { id, base64 });
}

export async function disposeExperimentBrowser(experiment: ExperimentBrowser): Promise<void> {
  try {
    await experiment.page.evaluate(async () => {
      const capture = window.__voiceActionExperiment?.capture;
      if (!capture) return;
      capture.peer?.close();
      capture.track.stop();
      capture.silence.stop();
      if (capture.context.state !== "closed") await capture.context.close();
    });
  } finally {
    await experiment.browser.close();
  }
}

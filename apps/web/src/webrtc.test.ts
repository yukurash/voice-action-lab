import assert from "node:assert/strict";
import { test } from "node:test";
import { ICE_GATHER_TIMEOUT_MS, PEER_CONNECT_TIMEOUT_MS, waitForIceGathering, waitForPeerConnection } from "./webrtc.ts";

class Peer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = "gathering";
  connectionState: RTCPeerConnectionState = "connecting";
}

class Channel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
}

test("ICE readiness waits for completion, including an already-complete peer", async () => {
  const peer = new Peer();
  const controller = new AbortController();
  let complete = false;
  const pending = waitForIceGathering(peer, controller.signal).then(() => { complete = true; });
  peer.dispatchEvent(new Event("icegatheringstatechange"));
  await Promise.resolve();
  assert.equal(complete, false);
  peer.iceGatheringState = "complete";
  peer.dispatchEvent(new Event("icegatheringstatechange"));
  await pending;
  assert.equal(complete, true);
  await waitForIceGathering(peer, controller.signal);
});

test("ICE gathering timeout is exactly eight seconds", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  assert.equal(ICE_GATHER_TIMEOUT_MS, 8_000);
  const pending = waitForIceGathering(new Peer(), new AbortController().signal);
  const rejected = assert.rejects(pending, /8 秒/);
  context.mock.timers.tick(8_000);
  await rejected;
});

test("transport requires both the connected peer and open data channel", async () => {
  const peer = new Peer();
  const channel = new Channel();
  let ready = false;
  const pending = waitForPeerConnection(peer, channel, new AbortController().signal).then(() => { ready = true; });
  peer.connectionState = "connected";
  peer.dispatchEvent(new Event("connectionstatechange"));
  await Promise.resolve();
  assert.equal(ready, false);
  channel.readyState = "open";
  channel.dispatchEvent(new Event("open"));
  await pending;
  assert.equal(ready, true);
  await waitForPeerConnection(peer, channel, new AbortController().signal);
});

test("transport timeout is exactly twenty-five seconds", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  assert.equal(PEER_CONNECT_TIMEOUT_MS, 25_000);
  const pending = waitForPeerConnection(new Peer(), new Channel(), new AbortController().signal);
  const rejected = assert.rejects(pending, /25 秒/);
  context.mock.timers.tick(25_000);
  await rejected;
});

test("stopping aborts ICE and transport waits immediately", async () => {
  const controller = new AbortController();
  const ice = assert.rejects(waitForIceGathering(new Peer(), controller.signal), { name: "AbortError" });
  const transport = assert.rejects(waitForPeerConnection(new Peer(), new Channel(), controller.signal), { name: "AbortError" });
  controller.abort();
  await Promise.all([ice, transport]);
  await assert.rejects(waitForIceGathering(new Peer(), controller.signal), { name: "AbortError" });
});

test("failed peers and closed channels reject instead of appearing ready", async () => {
  const peer = new Peer();
  const channel = new Channel();
  const pending = assert.rejects(waitForPeerConnection(peer, channel, new AbortController().signal), /終了/);
  channel.readyState = "closed";
  channel.dispatchEvent(new Event("close"));
  await pending;
  peer.connectionState = "failed";
  await assert.rejects(waitForIceGathering(peer, new AbortController().signal), /終了/);
});

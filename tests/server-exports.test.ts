import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import type { BrowserState } from "../packages/contracts/index.ts";
import { buildApp } from "../apps/server/app.ts";
import { HttpError } from "../apps/server/auth.ts";
import { loadConfig } from "../apps/server/config.ts";
import { createCredential } from "../apps/server/credentials.ts";
import { AzureBlobExportStore } from "../apps/server/export-store.ts";
import type { ExportBlobClient, ExportBlobContainer } from "../apps/server/export-store.ts";
import { buildRunExport, MAX_EXPORT_BYTES, ownerFingerprint, serializeRunExport } from "../apps/server/exports.ts";
import type { PrivateExportStore, RunExport } from "../apps/server/exports.ts";
import { GameEngine } from "../packages/game-engine/index.ts";
import { deriveActionMetrics } from "../packages/experiments/index.ts";

const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const origin = "http://127.0.0.1:3000";
const headers = { origin };
const tenant = "11111111-1111-1111-1111-111111111111";
const firstOwner = "22222222-2222-2222-2222-222222222222";
const secondOwner = "33333333-3333-3333-3333-333333333333";

function principal(oid: string): string {
  return Buffer.from(JSON.stringify({ auth_typ: "aad", claims: [{ typ: "tid", val: tenant }, { typ: "oid", val: oid }] })).toString("base64");
}

class MemoryExportStore implements PrivateExportStore {
  records = new Map<string, { owner: string; document: RunExport }>();
  async create(document: RunExport, owner: string): Promise<void> {
    if (this.records.has(document.runId)) throw new HttpError(409, "export_already_exists");
    this.records.set(document.runId, { owner, document: structuredClone(document) });
  }
  async read(id: string, owner: string): Promise<RunExport> {
    const item = this.records.get(id);
    if (!item) throw new HttpError(404, "export_not_found");
    if (item.owner !== owner) throw new HttpError(403, "export_owner_mismatch");
    return structuredClone(item.document);
  }
  async remove(id: string, owner: string): Promise<void> {
    await this.read(id, owner);
    this.records.delete(id);
  }
}

function settings() {
  return loadConfig({
    AZURE_STORAGE_ACCOUNT_NAME: "examplestorage",
    SOURCE_COMMIT: "a".repeat(40),
  });
}

async function setup(t: TestContext, config = settings(), store = new MemoryExportStore()) {
  const app = await buildApp(config, { exportStore: store });
  t.after(() => app.close());
  await app.ready();
  return { app, store };
}

function sampleState(): BrowserState {
  return {
    game: {
      runId, mode: "cancel-actions", epoch: 1, cargo: { red: 1, blue: 2 }, operations: [], stopped: true,
      events: [{
        sequence: 1, atMs: 1_000, kind: "final_usage_confirmed", operationId: null, delegationId: null,
        details: { seconds: 10.8, transcript: "PRIVATE_TRANSCRIPT", audio: "PRIVATE_AUDIO", prompt: "PRIVATE_PROMPT", reason: "PRIVATE_REASON" },
      }],
    },
    session: {
      transport: "disconnected", source: "live", recording: false, expiresAt: null,
      message: "PRIVATE_UPSTREAM_RESPONSE",
    },
  };
}

function document(): RunExport {
  return buildRunExport(sampleState(), settings(), "2026-09-17T12:00:00.000Z", "2026-09-17T12:00:01.000Z");
}

test("redacted export preserves cancellation and rejection metrics without preserving arbitrary reasons", () => {
  let now = 0;
  const engine = new GameEngine({ mode: "cancel-actions", runId, now: () => now });
  engine.registerDelegation("move", now);
  engine.dispatch({ callId: "move-call", delegationId: "move", command: { type: "move", cargo: "red", destination: "right" } });
  now = 10;
  engine.tick();
  engine.registerDelegation("cancel", now);
  engine.dispatch({ callId: "cancel-call", delegationId: "cancel", command: { type: "cancel" } });
  engine.dispatch({ callId: "late-call", delegationId: "move", command: { type: "move", cargo: "blue", destination: "right" } });
  engine.stop("PRIVATE_STOP_REASON");
  const state = { ...sampleState(), game: engine.snapshot() };
  const exported = buildRunExport(state, settings(), "2026-09-17T12:00:00Z", "2026-09-17T12:00:01Z");
  assert.deepEqual(deriveActionMetrics(exported.game), deriveActionMetrics(state.game));
  assert.equal(deriveActionMetrics(exported.game).pendingOperationsCancelled, 1);
  assert.equal(deriveActionMetrics(exported.game).rejections.late, 1);
  assert.ok(!JSON.stringify(exported).includes("PRIVATE_STOP_REASON"));
});

test("export configuration is optional, defaults container, and rejects URLs/invalid names or commit IDs", () => {
  assert.equal(loadConfig({}).exportStorage, null);
  assert.deepEqual(settings().exportStorage, { accountName: "examplestorage", container: "experiments" });
  assert.throws(() => loadConfig({ AZURE_STORAGE_ACCOUNT_NAME: "https://example.com/" }), /storage account/);
  assert.throws(() => loadConfig({ AZURE_STORAGE_ACCOUNT_NAME: "examplestorage", AZURE_STORAGE_CONTAINER: "bad--container" }), /container/);
  assert.throws(() => loadConfig({ SOURCE_COMMIT: "main" }), /commit hash/);
});

test("unconfigured exports explicitly return 503 even if a mock dependency is accidentally supplied", async (t) => {
  const { app, store } = await setup(t, loadConfig({}));
  for (const [method, url] of [["POST", "/api/exports"], ["GET", `/api/exports/${runId}`], ["DELETE", `/api/exports/${runId}`]] as const) {
    const response = await app.inject({ method, url, headers, ...(method === "POST" ? { payload: {} } : {}) });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, "export_not_configured");
  }
  assert.equal(store.records.size, 0);
});

test("export requires a genuinely closed run, an empty body, and valid Origin", async (t) => {
  const { app, store } = await setup(t);
  assert.equal((await app.inject({ method: "POST", url: "/api/exports", headers, payload: {} })).statusCode, 409);
  await app.inject({ method: "POST", url: "/api/simulation/start", headers, payload: { mode: "voice-only" } });
  assert.equal((await app.inject({ method: "POST", url: "/api/exports", headers, payload: {} })).statusCode, 409);
  await app.inject({ method: "POST", url: "/api/session/close", headers, payload: {} });
  assert.equal((await app.inject({ method: "POST", url: "/api/exports", payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/exports", headers, payload: { audio: "not allowed" } })).statusCode, 400);
  assert.equal(store.records.size, 0);
});

test("closed run export/download/delete preserves settings and immutable final state without public URLs", async (t) => {
  const { app, store } = await setup(t);
  await app.inject({ method: "POST", url: "/api/simulation/start", headers, payload: { mode: "cancel-actions" } });
  await app.inject({ method: "POST", url: "/api/command", headers, payload: { type: "move", cargo: "red", destination: "right" } });
  const closed: BrowserState = (await app.inject({ method: "POST", url: "/api/session/close", headers, payload: {} })).json();
  const response = await app.inject({ method: "POST", url: "/api/exports", headers, payload: {} });
  assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(response.json(), { runId: closed.game.runId, downloadPath: `/api/exports/${closed.game.runId}` });
  assert.equal((await app.inject({ method: "POST", url: "/api/exports", headers, payload: {} })).statusCode, 409);
  await app.inject({ method: "POST", url: "/api/simulation/start", headers, payload: { mode: "voice-only" } });
  const downloaded = await app.inject({ url: response.json().downloadPath });
  const exported: RunExport = downloaded.json();
  assert.equal(downloaded.statusCode, 200);
  assert.match(String(downloaded.headers["content-disposition"]), /attachment/);
  assert.equal(downloaded.headers["cache-control"], "no-store");
  assert.equal(exported.game.stopped, true);
  assert.equal(exported.game.mode, "cancel-actions");
  assert.equal(exported.source, "simulation");
  assert.equal(exported.settings.sourceCommit, "a".repeat(40));
  assert.equal(exported.settings.stepIntervalMs, 1_000);
  assert.equal(exported.usage.status, "not-applicable");
  assert.ok(!downloaded.body.includes("examplestorage"));
  assert.equal((await app.inject({ method: "DELETE", url: response.json().downloadPath, headers: { origin: "https://evil.example" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url: response.json().downloadPath, headers })).statusCode, 200);
  assert.equal(store.records.size, 0);
  assert.equal((await app.inject({ url: response.json().downloadPath })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: response.json().downloadPath, headers })).statusCode, 404);
});

test("downloads and deletion require the persisted export owner even when another owner is currently active", async (t) => {
  const config = {
    ...settings(), production: true, host: "0.0.0.0", credentialMode: "managed-identity" as const,
    allowedOrigins: ["https://lab.example"],
    auth: { mode: "easyauth" as const, trustEasyAuthProxy: true, tenantId: tenant, objectIds: [firstOwner, secondOwner] },
  };
  const { app } = await setup(t, config);
  const firstHeaders = { origin: "https://lab.example", "x-ms-client-principal": principal(firstOwner) };
  const secondHeaders = { ...firstHeaders, "x-ms-client-principal": principal(secondOwner) };
  await app.inject({ method: "POST", url: "/api/simulation/start", headers: firstHeaders, payload: { mode: "voice-only" } });
  await app.inject({ method: "POST", url: "/api/session/close", headers: firstHeaders, payload: {} });
  const created = await app.inject({ method: "POST", url: "/api/exports", headers: firstHeaders, payload: {} });
  assert.equal(created.statusCode, 201);
  const url: string = created.json().downloadPath;
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: secondHeaders })).statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url, headers: secondHeaders })).statusCode, 403);
  await app.inject({ method: "POST", url: "/api/simulation/start", headers: secondHeaders, payload: { mode: "voice-only" } });
  assert.equal((await app.inject({ url, headers: firstHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url, headers: firstHeaders })).statusCode, 200);
});

test("UUID path validation rejects unexpected paths before storage access", async (t) => {
  const { app } = await setup(t);
  for (const value of ["not-a-uuid", "bad%2Fpath", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json"]) {
    assert.equal((await app.inject({ url: `/api/exports/${value}` })).statusCode, 400);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/exports/${value}`, headers })).statusCode, 400);
  }
});

test("redaction omits transcript/audio/prompt/error text and includes only voice cumulative usage", () => {
  const exported = document();
  const text = serializeRunExport(exported).toString("utf8");
  assert.ok(!text.includes("PRIVATE_"));
  assert.ok(!text.includes("message"));
  assert.equal(exported.usage.status, "confirmed");
  assert.deepEqual(exported.usage.metrics, { seconds: 10.8 });
  assert.equal(exported.settings.sourceOffsetsSynchronized, false);
});

class MockBlob implements ExportBlobClient {
  bytes = serializeRunExport(document());
  metadata: Record<string, string> = { owner: ownerFingerprint("owner-one") };
  etag = '"version-1"';
  contentLength: number | undefined;
  downloadCount = 0;
  deleted = false;
  failStatus: number | null = null;

  async uploadData(data: Buffer, options: Parameters<ExportBlobClient["uploadData"]>[1]): Promise<void> {
    if (this.failStatus) throw { statusCode: this.failStatus, message: "PRIVATE_STORAGE_RESPONSE" };
    assert.equal(options.conditions.ifNoneMatch, "*");
    assert.equal(options.blobHTTPHeaders.blobContentType, "application/json; charset=utf-8");
    this.bytes = data;
    this.metadata = options.metadata;
  }
  async getProperties(): Promise<{ metadata: Record<string, string>; contentLength: number; etag: string }> {
    if (this.failStatus) throw { statusCode: this.failStatus, message: "PRIVATE_STORAGE_RESPONSE" };
    return { metadata: this.metadata, contentLength: this.contentLength ?? this.bytes.byteLength, etag: this.etag };
  }
  async downloadToBuffer(offset: number, count: number, options: Parameters<ExportBlobClient["downloadToBuffer"]>[2]): Promise<Buffer> {
    assert.equal(offset, 0);
    assert.equal(count, this.bytes.byteLength);
    assert.equal(options.conditions.ifMatch, this.etag);
    this.downloadCount++;
    return this.bytes;
  }
  async delete(options: Parameters<ExportBlobClient["delete"]>[0]): Promise<void> {
    assert.equal(options.conditions.ifMatch, this.etag);
    assert.equal(options.deleteSnapshots, "include");
    this.deleted = true;
  }
}

function blobStore(blob: MockBlob): AzureBlobExportStore {
  const container: ExportBlobContainer = {
    getBlockBlobClient(name) {
      assert.equal(name, `experiments/${runId}.json`);
      return blob;
    },
  };
  return new AzureBlobExportStore({ accountName: "examplestorage", container: "experiments" }, createCredential(loadConfig({})), container);
}

test("Blob adapter writes private owner metadata and uses conditional ownership-safe read/delete", async () => {
  const blob = new MockBlob();
  const store = blobStore(blob);
  await store.create(document(), "owner-one");
  assert.equal(blob.metadata.owner, ownerFingerprint("owner-one"));
  assert.ok(!blob.bytes.toString("utf8").includes("owner-one"));
  assert.deepEqual(await store.read(runId, "owner-one"), document());
  await assert.rejects(store.read(runId, "owner-two"), (error: unknown) => error instanceof HttpError && error.statusCode === 403);
  await assert.rejects(store.remove(runId, "owner-two"), (error: unknown) => error instanceof HttpError && error.statusCode === 403);
  assert.equal(blob.deleted, false);
  await store.remove(runId, "owner-one");
  assert.equal(blob.deleted, true);
});

test("Blob adapter rejects oversize exports before downloading and sanitizes storage errors", async () => {
  const blob = new MockBlob();
  const store = blobStore(blob);
  blob.contentLength = MAX_EXPORT_BYTES + 1;
  await assert.rejects(store.read(runId, "owner-one"), (error: unknown) => error instanceof HttpError && error.statusCode === 413);
  assert.equal(blob.downloadCount, 0);
  blob.contentLength = undefined;
  for (const [upstream, expected] of [[404, 404], [403, 503], [412, 409]] as const) {
    blob.failStatus = upstream;
    await assert.rejects(store.read(runId, "owner-one"), (error: unknown) => error instanceof HttpError
      && error.statusCode === expected && !error.message.includes("PRIVATE"));
  }
  blob.failStatus = 412;
  await assert.rejects(store.create(document(), "owner-one"), (error: unknown) => error instanceof HttpError && error.message === "export_already_exists");
});

test("Blob adapter rejects corrupt or wrong-run JSON and strips unexpected stored payload fields", async () => {
  const blob = new MockBlob();
  const store = blobStore(blob);
  blob.bytes = Buffer.from("PRIVATE_INVALID_JSON");
  await assert.rejects(store.read(runId, "owner-one"), (error: unknown) => error instanceof HttpError && error.message === "invalid_export_document");
  blob.bytes = Buffer.from(JSON.stringify({ ...document(), runId: firstOwner }));
  await assert.rejects(store.read(runId, "owner-one"), (error: unknown) => error instanceof HttpError && error.message === "invalid_export_document");
  blob.bytes = Buffer.from(JSON.stringify({ ...document(), audio: "PRIVATE_AUDIO", transcript: "PRIVATE_TRANSCRIPT" }));
  assert.ok(!JSON.stringify(await store.read(runId, "owner-one")).includes("PRIVATE"));
});

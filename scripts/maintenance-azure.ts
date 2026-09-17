import { AzureCliCredential } from "@azure/identity";
import type { AzureCliCredentialOptions } from "@azure/identity";
import WebSocket from "ws";
import type { ClientOptions, RawData } from "ws";
import { DRAIN_READY_MARKER, isMaintenanceStatus } from "../packages/deployment/protocol.ts";
import type { MaintenanceStatus } from "../packages/deployment/protocol.ts";
import { HEALTH_READY_MARKER, isSourceCommit } from "../packages/deployment/health.ts";
import type { RuntimeHealthResult } from "../packages/deployment/health.ts";

const ARM_ORIGIN = "https://management.azure.com";
const API_VERSION = "2025-01-01";
export const OPERATOR_LIMITS = Object.freeze({
  drainMs: 675_000,
  otherMs: 30_000,
  credentialMs: 10_000,
  armMs: 5_000,
  handshakeMs: 10_000,
  closeMs: 5_000,
  armBytes: 256 * 1024,
  frameBytes: 16 * 1024,
  outputBytes: 64 * 1024,
});

type Action = "drain" | "resume" | "status" | "health";
type ErrorCode =
  | "invalid_arguments" | "authentication_failed" | "tenant_mismatch" | "deadline_exceeded"
  | "arm_request_failed" | "arm_timeout" | "arm_rejected" | "arm_invalid_response"
  | "unsupported_revision_mode" | "container_count" | "revision_mismatch" | "image_mismatch"
  | "replica_count" | "replica_not_ready" | "exec_endpoint_invalid" | "operator_token_invalid"
  | "exec_transport_failed" | "exec_handshake_failed" | "exec_close_timeout"
  | "exec_invalid_frame" | "exec_output_limit" | "exec_proxy_error" | "exec_stderr"
  | "exec_invalid_output" | "exec_marker_missing" | "exec_state_conflict"
  | "source_commit_mismatch" | "unexpected_failure";

export class AzureMaintenanceError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

function fail(code: ErrorCode): never {
  throw new AzureMaintenanceError(code);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("arm_invalid_response");
  return value as Record<string, unknown>;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const NAME = /^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/u;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*|@sha256:[a-f0-9]{64})?$/u;
const BEARER = /^[A-Za-z0-9._~+/-]+=*$/u;

export interface AzureMaintenanceOptions {
  action: Action;
  subscription: string;
  tenant: string;
  resourceGroup: string;
  app: string;
  revision?: string;
  expectedImage?: string;
  expectedSourceCommit?: string;
}

function validateOptions(options: AzureMaintenanceOptions): void {
  if (!["drain", "resume", "status", "health"].includes(options.action)
    || !UUID.test(options.subscription) || !UUID.test(options.tenant)
    || !/^[A-Za-z0-9][A-Za-z0-9._()-]{0,89}$/u.test(options.resourceGroup) || options.resourceGroup.endsWith(".")
    || !/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u.test(options.app)
    || options.revision !== undefined && (!NAME.test(options.revision) || !options.revision.startsWith(`${options.app}--`))
    || options.expectedImage !== undefined && (!IMAGE.test(options.expectedImage) || options.expectedImage.length > 512)
    || options.expectedSourceCommit !== undefined && (options.action !== "health" || !isSourceCommit(options.expectedSourceCommit))) {
    fail("invalid_arguments");
  }
}

export function parseAzureMaintenanceArgs(argv: readonly string[]): AzureMaintenanceOptions {
  const action = argv[0];
  if (action !== "drain" && action !== "resume" && action !== "status" && action !== "health") fail("invalid_arguments");
  const allowed = new Set(["--subscription", "--tenant", "--resource-group", "--app", "--revision", "--expected-image", "--expected-source-commit"]);
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !allowed.has(key) || values.has(key) || !value || value.startsWith("--")) fail("invalid_arguments");
    values.set(key, value);
  }
  const options: AzureMaintenanceOptions = {
    action,
    subscription: values.get("--subscription") ?? "",
    tenant: values.get("--tenant") ?? "",
    resourceGroup: values.get("--resource-group") ?? "",
    app: values.get("--app") ?? "",
  };
  const revision = values.get("--revision");
  const expectedImage = values.get("--expected-image");
  const expectedSourceCommit = values.get("--expected-source-commit");
  if (revision !== undefined) options.revision = revision;
  if (expectedImage !== undefined) options.expectedImage = expectedImage;
  if (expectedSourceCommit !== undefined) options.expectedSourceCommit = expectedSourceCommit.toLowerCase();
  validateOptions(options);
  return options;
}

export interface ExecSocket {
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number) => void): this;
  on(event: "unexpected-response", listener: () => void): this;
  send(data: Buffer, callback: (error?: Error) => void): void;
  close(code: number): void;
  terminate(): void;
}

export interface AzureMaintenanceDependencies {
  credential: (options: AzureCliCredentialOptions) => Pick<AzureCliCredential, "getToken">;
  fetch: typeof fetch;
  socket: (url: URL, options: ClientOptions) => ExecSocket;
  deadline: (milliseconds: number) => AbortSignal;
}

function bounded<T>(work: () => Promise<T>, signal: AbortSignal, code: ErrorCode): Promise<T> {
  if (signal.aborted) return Promise.reject(new AzureMaintenanceError(code));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AzureMaintenanceError(code));
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => {
      if (signal.aborted) fail(code);
      return work();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function armJson(
  path: string,
  method: "GET" | "POST",
  token: string,
  signal: AbortSignal,
  dependencies: AzureMaintenanceDependencies,
): Promise<Record<string, unknown>> {
  const requestSignal = AbortSignal.any([signal, dependencies.deadline(OPERATOR_LIMITS.armMs)]);
  try {
    return await bounded(async () => {
      const response = await dependencies.fetch(`${ARM_ORIGIN}${path}?api-version=${API_VERSION}`, {
        method, redirect: "error", signal: requestSignal,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (response.status !== 200 || response.redirected) {
        await response.body?.cancel();
        fail("arm_rejected");
      }
      if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
        await response.body?.cancel();
        fail("arm_invalid_response");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > OPERATOR_LIMITS.armBytes) fail("arm_invalid_response");
          chunks.push(part.value);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          fail("arm_invalid_response");
        }
        return record(parsed);
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }, requestSignal, "arm_timeout");
  } catch (error: unknown) {
    if (signal.aborted) fail("deadline_exceeded");
    if (requestSignal.aborted) fail("arm_timeout");
    if (error instanceof AzureMaintenanceError) throw error;
    fail("arm_request_failed");
  }
}

function oneContainer(template: unknown): Record<string, unknown> {
  const value = record(template);
  if (!Array.isArray(value.containers) || value.containers.length !== 1
    || value.initContainers !== undefined && value.initContainers !== null
      && (!Array.isArray(value.initContainers) || value.initContainers.length !== 0)) {
    fail("container_count");
  }
  return record(value.containers[0]);
}

function replicaContainer(properties: Record<string, unknown>, name: string): Record<string, unknown> {
  if (Array.isArray(properties.containers) && properties.containers.length === 2 && name !== "http-auth") {
    const containers = properties.containers.map(record);
    const auth = containers.filter((container) => container.name === "http-auth");
    if (auth.length !== 1) fail("container_count");
    const sidecar = auth[0];
    if (!sidecar || sidecar.ready !== true || sidecar.started !== true || sidecar.runningState !== "Running") {
      fail("replica_not_ready");
    }
    // EasyAuth injects http-auth into replicas, not the application's declared template.
    return oneContainer({ ...properties, containers: containers.filter((container) => container !== sidecar) });
  }
  return oneContainer(properties);
}

interface Target {
  revision: string;
  image: string;
  replica: string;
  container: string;
  origin: string;
}

function resourceMatches(value: unknown, expected: string): void {
  if (typeof value !== "string" || value.toLowerCase() !== expected.toLowerCase()) fail("arm_invalid_response");
}

export function validatedExecOrigin(endpoint: unknown, location: unknown): string {
  if (typeof location !== "string" || location.length > 80) fail("exec_endpoint_invalid");
  const region = location.replaceAll(/\s/gu, "").toLowerCase();
  if (!/^[a-z0-9]{1,40}$/u.test(region)
    || typeof endpoint !== "string" || endpoint.length > 4096 || /[\s\\]/u.test(endpoint)
    || [...endpoint].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    fail("exec_endpoint_invalid");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    fail("exec_endpoint_invalid");
  }
  const expected = `https://${region}.azurecontainerapps.dev`;
  if (url.origin !== expected || url.username || url.password || url.hash) fail("exec_endpoint_invalid");
  return expected;
}

async function discoverTarget(
  options: AzureMaintenanceOptions,
  resource: string,
  arm: (path: string) => Promise<Record<string, unknown>>,
): Promise<Target> {
  const app = await arm(resource);
  resourceMatches(app.id, resource);
  const properties = record(app.properties);
  if (record(properties.configuration).activeRevisionsMode !== "Single") fail("unsupported_revision_mode");
  const appContainer = oneContainer(properties.template);
  const revision = properties.latestReadyRevisionName;
  if (typeof revision !== "string" || !NAME.test(revision) || !revision.startsWith(`${options.app}--`)) fail("arm_invalid_response");
  if (options.revision !== undefined && options.revision !== revision) fail("revision_mismatch");
  // App.template may already describe a new, unready deployment; read the selected revision's image.
  const revisionResource = `${resource}/revisions/${revision}`;
  const selected = await arm(revisionResource);
  resourceMatches(selected.id, revisionResource);
  if (selected.name !== revision || record(selected.properties).active !== true) fail("revision_mismatch");
  const selectedContainer = oneContainer(record(selected.properties).template);
  const container = selectedContainer.name;
  const image = selectedContainer.image;
  if (typeof container !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(container)
    || container !== appContainer.name || typeof image !== "string" || image.length > 512 || !IMAGE.test(image)) {
    fail("arm_invalid_response");
  }
  if (options.expectedImage !== undefined && options.expectedImage !== image) fail("image_mismatch");
  const replicas = await arm(`${revisionResource}/replicas`);
  if (!Array.isArray(replicas.value) || replicas.value.length !== 1
    || replicas.nextLink !== undefined && replicas.nextLink !== null && replicas.nextLink !== "") fail("replica_count");
  const replica = record(replicas.value[0]);
  if (typeof replica.name !== "string" || !NAME.test(replica.name) || !replica.name.startsWith(`${revision}-`)) fail("arm_invalid_response");
  resourceMatches(replica.id, `${revisionResource}/replicas/${replica.name}`);
  const replicaProperties = record(replica.properties);
  const running = replicaContainer(replicaProperties, container);
  if (running.name !== container || running.ready !== true || running.started !== true
    || replicaProperties.runningState !== "Running" || running.runningState !== "Running") fail("replica_not_ready");
  return {
    revision, image, replica: replica.name, container,
    origin: validatedExecOrigin(running.logStreamEndpoint, app.location),
  };
}

function verifyArmToken(token: string, tenant: string): void {
  if (typeof token !== "string" || token.length > 16_384 || !BEARER.test(token)) fail("authentication_failed");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) fail("authentication_failed");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    fail("authentication_failed");
  }
  if (value === null || typeof value !== "object" || !("tid" in value)
    || typeof value.tid !== "string" || value.tid.toLowerCase() !== tenant.toLowerCase()) fail("tenant_mismatch");
}

type Proof = { state: MaintenanceStatus } | { health: RuntimeHealthResult };

class OutputVerifier {
  private pending = "";
  private state: MaintenanceStatus | undefined;
  private health: RuntimeHealthResult | undefined;
  proof: Proof | undefined;
  private readonly action: Action;
  private readonly expectedCommit: string | undefined;

  constructor(options: AzureMaintenanceOptions) {
    this.action = options.action;
    this.expectedCommit = options.expectedSourceCommit?.toLowerCase();
  }

  append(text: string): void {
    this.pending += text;
    for (;;) {
      const end = this.pending.indexOf("\n");
      if (end < 0) return;
      const line = this.pending.slice(0, end).replace(/\r$/u, "");
      this.pending = this.pending.slice(end + 1);
      if (this.proof) fail("exec_invalid_output");
      if (this.action === "drain" && line === DRAIN_READY_MARKER) {
        if (!this.state?.draining || this.state.active) fail("exec_state_conflict");
        this.proof = { state: this.state };
      } else if (this.action === "health" && line === HEALTH_READY_MARKER) {
        if (!this.health) fail("exec_invalid_output");
        this.proof = { health: this.health };
      } else if (this.action === "health") {
        const match = /^\{"status":"ok","sourceCommit":"([a-f0-9]{40}|[a-f0-9]{64})"\}$/u.exec(line);
        if (!match?.[1] || this.health) fail("exec_invalid_output");
        if (this.expectedCommit !== undefined && match[1] !== this.expectedCommit) fail("source_commit_mismatch");
        this.health = { status: "ok", sourceCommit: match[1] };
      } else {
        if (!/^\{\s*"(?:draining|active)"\s*:\s*(?:true|false)\s*,\s*"(?:draining|active)"\s*:\s*(?:true|false)\s*\}$/u.test(line)) {
          fail("exec_invalid_output");
        }
        const status: unknown = JSON.parse(line);
        if (!isMaintenanceStatus(status)) fail("exec_invalid_output");
        if (this.action === "resume" && status.draining
          || this.action === "drain" && (!status.draining || this.state?.active === false && status.active)) {
          fail("exec_state_conflict");
        }
        this.state = { draining: status.draining, active: status.active };
        if (this.action !== "drain") this.proof = { state: this.state };
      }
    }
  }

  complete(): Proof {
    if (this.pending !== "") fail("exec_invalid_output");
    if (!this.proof) fail("exec_marker_missing");
    return this.proof;
  }
}

async function execute(
  url: URL,
  token: string,
  options: AzureMaintenanceOptions,
  signal: AbortSignal,
  dependencies: AzureMaintenanceDependencies,
): Promise<Proof> {
  if (signal.aborted) fail("deadline_exceeded");
  return new Promise((resolve, reject) => {
    const socket = dependencies.socket(url, {
      headers: { Authorization: `Bearer ${token}` },
      followRedirects: false,
      handshakeTimeout: OPERATOR_LIMITS.handshakeMs,
      maxPayload: OPERATOR_LIMITS.frameBytes,
      perMessageDeflate: false,
      rejectUnauthorized: true,
    });
    const verifier = new OutputVerifier(options);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let bytes = 0;
    let settled = false;
    let closing = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: AzureMaintenanceError, proof?: Proof) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      clearTimeout(closeTimer);
      socket.terminate();
      if (error) reject(error);
      else if (proof) resolve(proof);
      else reject(new AzureMaintenanceError("unexpected_failure"));
    };
    const abort = () => finish(new AzureMaintenanceError("deadline_exceeded"));
    signal.addEventListener("abort", abort, { once: true });
    socket.on("error", () => finish(new AzureMaintenanceError("exec_transport_failed")));
    socket.on("unexpected-response", () => finish(new AzureMaintenanceError("exec_handshake_failed")));
    socket.on("open", () => {
      if (settled) return;
      try {
        socket.send(Buffer.concat([Buffer.from([0, 4]), Buffer.from('{"Width":120,"Height":30}')]), (error) => {
          if (error) finish(new AzureMaintenanceError("exec_transport_failed"));
        });
      } catch {
        finish(new AzureMaintenanceError("exec_transport_failed"));
      }
    });
    socket.on("message", (data, isBinary) => {
      if (settled) return;
      try {
        const size = Array.isArray(data) ? data.reduce((total, part) => total + part.length, 0) : data.byteLength;
        bytes += size;
        if (size > OPERATOR_LIMITS.frameBytes || bytes > OPERATOR_LIMITS.outputBytes) fail("exec_output_limit");
        const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (!isBinary || frame.length === 0) fail("exec_invalid_frame");
        if (frame[0] === 2) fail("exec_proxy_error");
        if (frame[0] === 1) return;
        if (frame[0] !== 0 || frame.length < 2 || frame[1] !== 1 && frame[1] !== 2) fail("exec_invalid_frame");
        if (frame[1] === 2) {
          if (frame.length > 2) fail("exec_stderr");
          return;
        }
        verifier.append(decoder.decode(frame.subarray(2), { stream: true }));
        if (verifier.proof && !closing) {
          // Request a clean close after proof, still rejecting queued stderr/proxy errors until it closes.
          verifier.complete();
          closing = true;
          closeTimer = setTimeout(() => finish(new AzureMaintenanceError("exec_close_timeout")), OPERATOR_LIMITS.closeMs);
          socket.close(1000);
        }
      } catch (error: unknown) {
        finish(error instanceof AzureMaintenanceError ? error : new AzureMaintenanceError("exec_invalid_output"));
      }
    });
    socket.on("close", (code) => {
      if (settled) return;
      try {
        if (code !== 1000) fail("exec_transport_failed");
        verifier.append(decoder.decode());
        finish(undefined, verifier.complete());
      } catch (error: unknown) {
        finish(error instanceof AzureMaintenanceError ? error : new AzureMaintenanceError("exec_invalid_output"));
      }
    });
    if (signal.aborted) abort();
  });
}

export interface AzureMaintenanceResult {
  action: Action;
  revision: string;
  image: string;
  replica: string;
  container: string;
  state?: MaintenanceStatus;
  health?: "ok";
  sourceCommit?: string;
}

export async function runAzureMaintenance(
  options: AzureMaintenanceOptions,
  overrides: Partial<AzureMaintenanceDependencies> = {},
): Promise<AzureMaintenanceResult> {
  validateOptions(options);
  const dependencies: AzureMaintenanceDependencies = {
    credential: (settings) => new AzureCliCredential(settings),
    fetch,
    socket: (url, settings) => new WebSocket(url, settings),
    deadline: (milliseconds) => AbortSignal.timeout(milliseconds),
    ...overrides,
  };
  const signal = dependencies.deadline(options.action === "drain" ? OPERATOR_LIMITS.drainMs : OPERATOR_LIMITS.otherMs);
  let armToken: string;
  try {
    const credential = dependencies.credential({
      subscription: options.subscription, processTimeoutInMs: OPERATOR_LIMITS.credentialMs,
    });
    const access = await bounded(
      () => credential.getToken(`${ARM_ORIGIN}/.default`, { abortSignal: signal }),
      signal,
      "deadline_exceeded",
    );
    if (!Number.isFinite(access.expiresOnTimestamp) || access.expiresOnTimestamp <= Date.now()) fail("authentication_failed");
    verifyArmToken(access.token, options.tenant);
    armToken = access.token;
  } catch (error: unknown) {
    if (error instanceof AzureMaintenanceError) throw error;
    fail("authentication_failed");
  }
  const resource = `/subscriptions/${options.subscription}/resourceGroups/${encodeURIComponent(options.resourceGroup)}/providers/Microsoft.App/containerApps/${options.app}`;
  const target = await discoverTarget(options, resource, (path) => armJson(path, "GET", armToken, signal, dependencies));
  const auth = await armJson(`${resource}/getAuthtoken`, "POST", armToken, signal, dependencies);
  const operatorToken = record(auth.properties).token;
  if (typeof operatorToken !== "string" || operatorToken.length > 16_384 || !BEARER.test(operatorToken)) fail("operator_token_invalid");
  const command = options.action === "health"
    ? "node /app/packages/deployment/health.ts"
    : `node /app/packages/deployment/client.ts ${options.action}`;
  const exec = new URL(target.origin);
  exec.protocol = "wss:";
  exec.pathname = `/subscriptions/${options.subscription}/resourceGroups/${encodeURIComponent(options.resourceGroup)}/containerApps/${options.app}/revisions/${target.revision}/replicas/${target.replica}/containers/${target.container}/exec`;
  exec.search = new URLSearchParams({ command }).toString();
  let proof: Proof;
  try {
    proof = await execute(exec, operatorToken, options, signal, dependencies);
  } catch (error: unknown) {
    if (error instanceof AzureMaintenanceError) throw error;
    fail("exec_transport_failed");
  }
  const result: AzureMaintenanceResult = {
    action: options.action, revision: target.revision, image: target.image, replica: target.replica, container: target.container,
  };
  if ("state" in proof) result.state = proof.state;
  else {
    result.health = proof.health.status;
    result.sourceCommit = proof.health.sourceCommit;
  }
  return result;
}

export async function runAzureMaintenanceCli(
  argv: readonly string[],
  io = {
    stdout: (line: string) => { process.stdout.write(`${line}\n`); },
    stderr: (line: string) => { process.stderr.write(`${line}\n`); },
  },
  overrides: Partial<AzureMaintenanceDependencies> = {},
): Promise<number> {
  try {
    const result = await runAzureMaintenance(parseAzureMaintenanceArgs(argv), overrides);
    io.stdout(JSON.stringify(result));
    return 0;
  } catch (error: unknown) {
    const code = error instanceof AzureMaintenanceError ? error.code : "unexpected_failure";
    io.stderr(JSON.stringify({ error: code }));
    return code === "invalid_arguments" ? 2 : 1;
  }
}

if (import.meta.main) process.exitCode = await runAzureMaintenanceCli(process.argv.slice(2));

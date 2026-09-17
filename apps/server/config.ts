import { isAbsolute } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  production: boolean;
  auth: {
    mode: "dev" | "easyauth";
    trustEasyAuthProxy: boolean;
    tenantId: string;
    objectIds: readonly string[];
  };
  allowedOrigins: readonly string[];
  liveEnabled: boolean;
  azureEndpoint: string | null;
  liveModel: string;
  backendModel: string;
  credentialMode: "cli" | "managed-identity";
  credentialTenantId?: string;
  managedIdentityClientId?: string;
  staticDirectory?: string;
  sessionLimitMs: number;
  idleLimitMs: number;
  tickMs: number;
  stepIntervalMs: number;
  closeTimeoutMs: number;
  negotiationTimeoutMs: number;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const loopback = new Set(["127.0.0.1", "::1", "localhost"]);

export function validateConfig(config: ServerConfig): void {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error("Invalid server port.");
  }
  if (config.auth.mode === "dev") {
    if (config.production || !loopback.has(config.host)) {
      throw new Error("Development authentication requires a non-production loopback listener.");
    }
  } else if (!config.auth.trustEasyAuthProxy
    || !uuid.test(config.auth.tenantId)
    || config.auth.objectIds.length === 0
    || !config.auth.objectIds.every((id) => uuid.test(id))) {
    throw new Error("EasyAuth requires an explicitly trusted proxy and tenant/object allowlist.");
  }
  if (config.production && config.credentialMode !== "managed-identity") {
    throw new Error("Production requires managed identity.");
  }
  if (!config.allowedOrigins.length) throw new Error("At least one allowed origin is required.");
  for (const origin of config.allowedOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password
      || (url.protocol !== "https:" && !(url.protocol === "http:" && !config.production))) {
      throw new Error("Origins must be explicit HTTP(S) origins, with HTTPS in production.");
    }
  }
  if (config.liveEnabled) {
    if (!config.azureEndpoint) throw new Error("Live mode requires AZURE_OPENAI_ENDPOINT.");
    const url = new URL(config.azureEndpoint);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.openai\.azure\.com$/i.test(url.hostname)
      || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("AZURE_OPENAI_ENDPOINT must be an Azure OpenAI HTTPS resource endpoint.");
    }
  }
  if (config.liveModel !== "gpt-live-1" || config.backendModel !== "gpt-5.5") {
    throw new Error("This experiment requires gpt-live-1 and gpt-5.5 deployment names.");
  }
  if (config.staticDirectory && !isAbsolute(config.staticDirectory)) {
    throw new Error("STATIC_DIRECTORY must be absolute.");
  }
  if (!Number.isInteger(config.sessionLimitMs) || config.sessionLimitMs <= 0 || config.sessionLimitMs > 600_000
    || !Number.isInteger(config.idleLimitMs) || config.idleLimitMs <= 0 || config.idleLimitMs > 90_000
    || !Number.isInteger(config.tickMs) || config.tickMs < 20 || config.tickMs > 1_000
    || !Number.isInteger(config.stepIntervalMs) || config.stepIntervalMs < 100 || config.stepIntervalMs > 5_000
    || !Number.isInteger(config.negotiationTimeoutMs) || config.negotiationTimeoutMs < 1 || config.negotiationTimeoutMs > 60_000
    || !Number.isInteger(config.closeTimeoutMs) || config.closeTimeoutMs < 1 || config.closeTimeoutMs > 10_000) {
    throw new Error("Invalid session time limits.");
  }
}

function booleanEnv(value: string | undefined, name: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === "production";
  const authMode = env.AUTH_MODE ?? (production ? "easyauth" : "dev");
  if (authMode !== "dev" && authMode !== "easyauth") throw new Error("Invalid AUTH_MODE.");
  const credentialMode = env.AZURE_CREDENTIAL_MODE ?? (production ? "managed-identity" : "cli");
  if (credentialMode !== "cli" && credentialMode !== "managed-identity") {
    throw new Error("Invalid AZURE_CREDENTIAL_MODE.");
  }
  const config: ServerConfig = {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? "3000"),
    production,
    auth: {
      mode: authMode,
      trustEasyAuthProxy: booleanEnv(env.TRUST_EASYAUTH_PROXY, "TRUST_EASYAUTH_PROXY"),
      tenantId: env.ALLOWED_TENANT_ID ?? "",
      objectIds: (env.ALLOWED_OBJECT_IDS ?? "").split(",").map((id) => id.trim().toLowerCase()).filter(Boolean),
    },
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "http://127.0.0.1:3000").split(",").map((value) => value.trim()),
    liveEnabled: booleanEnv(env.LIVE_ENABLED, "LIVE_ENABLED"),
    azureEndpoint: env.AZURE_OPENAI_ENDPOINT ?? null,
    liveModel: env.AZURE_LIVE_MODEL ?? "gpt-live-1",
    backendModel: env.AZURE_BACKEND_MODEL ?? "gpt-5.5",
    credentialMode,
    ...(env.AZURE_TENANT_ID ? { credentialTenantId: env.AZURE_TENANT_ID } : {}),
    ...(env.AZURE_CLIENT_ID ? { managedIdentityClientId: env.AZURE_CLIENT_ID } : {}),
    ...(env.STATIC_DIRECTORY ? { staticDirectory: env.STATIC_DIRECTORY } : {}),
    sessionLimitMs: 600_000,
    idleLimitMs: 90_000,
    tickMs: 500,
    stepIntervalMs: Number(env.STEP_INTERVAL_MS ?? "1000"),
    closeTimeoutMs: 3_000,
    negotiationTimeoutMs: 45_000,
  };
  validateConfig(config);
  return config;
}

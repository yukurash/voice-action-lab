import type { FastifyRequest } from "fastify";
import type { ServerConfig } from "./config.ts";

export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, code: string) {
    super(code);
    this.statusCode = statusCode;
  }
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function ownerFromRequest(request: FastifyRequest, config: ServerConfig): string {
  if (config.auth.mode === "dev") return "loopback-developer";
  const header = request.headers["x-ms-client-principal"];
  if (typeof header !== "string" || header.length > 32_768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) {
    throw new HttpError(401, "authentication_required");
  }
  let principal: Record<string, unknown> | null;
  try {
    principal = object(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
  } catch {
    throw new HttpError(401, "invalid_principal");
  }
  if (!principal || principal.auth_typ !== "aad" || !Array.isArray(principal.claims)) {
    console.warn(JSON.stringify({
      event: "easyauth_principal_schema_rejected",
      object: principal !== null,
      fields: Object.keys(principal ?? {}).filter((key) => [
        "auth_typ", "claims", "name_typ", "role_typ", "identityProvider", "identity_provider",
        "authenticationType", "user_claims", "Claims",
      ].includes(key)),
      authType: ["aad", "Federation", "AuthenticationTypes.Federation", "Bearer", "azureactivedirectory"]
        .find((value) => principal?.auth_typ === value) ?? "unrecognized",
      claimsArray: Array.isArray(principal?.claims),
      providerHeaderIsAad: request.headers["x-ms-client-principal-idp"] === "aad",
    }));
    throw new HttpError(401, "invalid_principal");
  }
  const claims = principal.claims.map(object);
  function claim(names: readonly string[]): string {
    const values = claims.filter((entry) => entry && typeof entry.typ === "string" && names.includes(entry.typ))
      .map((entry) => entry?.val);
    if (values.length === 0 || values.some((value) => typeof value !== "string")) return "";
    const unique = new Set(values.map((value) => typeof value === "string" ? value.toLowerCase() : ""));
    return unique.size === 1 ? [...unique][0] ?? "" : "";
  }
  const tenant = claim(["tid", "http://schemas.microsoft.com/identity/claims/tenantid"]);
  const oid = claim(["oid", "http://schemas.microsoft.com/identity/claims/objectidentifier"]);
  if (tenant !== config.auth.tenantId.toLowerCase() || !config.auth.objectIds.includes(oid)) {
    throw new HttpError(403, "owner_not_allowed");
  }
  return `${tenant}:${oid}`;
}

export function validateOrigin(request: FastifyRequest, config: ServerConfig): void {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !config.allowedOrigins.includes(origin)) {
    throw new HttpError(403, "origin_not_allowed");
  }
}

export function exactBody(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const body = object(value);
  if (!body || Object.keys(body).some((key) => !keys.includes(key))
    || keys.some((key) => !(key in body))) throw new HttpError(400, "invalid_body");
  return body;
}

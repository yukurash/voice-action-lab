import type { createCredential } from "./credentials.ts";
import { HttpError, object } from "./auth.ts";
import { decodeRunExport, exportRunId, MAX_EXPORT_BYTES, ownerFingerprint, parseRunExport, serializeRunExport } from "./exports.ts";
import type { PrivateExportStore, RunExport } from "./exports.ts";

interface RequestOptions { abortSignal: AbortSignal }
interface ConditionalOptions extends RequestOptions { conditions: { ifMatch: string } }

export interface ExportBlobClient {
  uploadData(data: Buffer, options: RequestOptions & {
    conditions: { ifNoneMatch: "*" };
    metadata: Record<string, string>;
    blobHTTPHeaders: { blobContentType: string; blobContentDisposition: string };
  }): Promise<unknown>;
  getProperties(options: RequestOptions): Promise<{ metadata?: Record<string, string>; contentLength?: number; etag?: string }>;
  downloadToBuffer(offset: number, count: number, options: ConditionalOptions): Promise<Buffer>;
  delete(options: ConditionalOptions & { deleteSnapshots: "include" }): Promise<unknown>;
}

export interface ExportBlobContainer {
  getBlockBlobClient(name: string): ExportBlobClient;
}

function storageError(error: unknown, operation: "create" | "read" | "remove"): HttpError {
  if (error instanceof HttpError) return error;
  const failure = object(error);
  if (failure?.name === "AbortError" || failure?.name === "TimeoutError") return new HttpError(503, "export_storage_timeout");
  if (failure?.statusCode === 404) return operation === "create"
    ? new HttpError(503, "export_storage_not_ready") : new HttpError(404, "export_not_found");
  if (failure?.statusCode === 409 || failure?.statusCode === 412) return operation === "create"
    ? new HttpError(409, "export_already_exists") : new HttpError(409, "export_changed");
  if (failure?.statusCode === 401 || failure?.statusCode === 403) return new HttpError(503, "export_storage_access_denied");
  return new HttpError(503, "export_storage_unavailable");
}

export class AzureBlobExportStore implements PrivateExportStore {
  private getContainer: () => Promise<ExportBlobContainer>;

  constructor(
    storage: { accountName: string; container: string },
    credential: ReturnType<typeof createCredential>,
    injectedContainer?: ExportBlobContainer,
  ) {
    // Container provisioning/public access policy belongs to infrastructure, never this server.
    let container: Promise<ExportBlobContainer> | undefined;
    this.getContainer = () => {
      if (injectedContainer) return Promise.resolve(injectedContainer);
      container ??= import("@azure/storage-blob").then(({ BlobServiceClient }) => {
        const service = new BlobServiceClient(`https://${storage.accountName}.blob.core.windows.net`, credential, {
          retryOptions: { maxTries: 2, tryTimeoutInMs: 10_000 },
        });
        return service.getContainerClient(storage.container);
      });
      return container;
    };
  }

  private async blob(runId: string): Promise<ExportBlobClient> {
    return (await this.getContainer()).getBlockBlobClient(`experiments/${exportRunId(runId)}.json`);
  }

  private async owned(blob: ExportBlobClient, owner: string, signal: AbortSignal): Promise<{ etag: string; length: number }> {
    const properties = await blob.getProperties({ abortSignal: signal });
    if (properties.metadata?.owner !== ownerFingerprint(owner)) throw new HttpError(403, "export_owner_mismatch");
    if (typeof properties.etag !== "string" || !properties.etag) throw new HttpError(502, "invalid_export_metadata");
    if (typeof properties.contentLength !== "number" || !Number.isInteger(properties.contentLength) || properties.contentLength < 0) {
      throw new HttpError(502, "invalid_export_metadata");
    }
    if (properties.contentLength > MAX_EXPORT_BYTES) throw new HttpError(413, "export_too_large");
    return { etag: properties.etag, length: properties.contentLength };
  }

  async create(document: RunExport, owner: string): Promise<void> {
    try {
      const runId = exportRunId(document.runId);
      const buffer = serializeRunExport(parseRunExport(document, runId));
      await (await this.blob(runId)).uploadData(buffer, {
        abortSignal: AbortSignal.timeout(15_000), conditions: { ifNoneMatch: "*" },
        metadata: { owner: ownerFingerprint(owner), schema: "1" },
        blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8", blobContentDisposition: `attachment; filename="${runId}.json"` },
      });
    } catch (error) {
      throw storageError(error, "create");
    }
  }

  async read(runId: string, owner: string): Promise<RunExport> {
    try {
      const id = exportRunId(runId);
      const signal = AbortSignal.timeout(15_000);
      const blob = await this.blob(id);
      const { etag, length } = await this.owned(blob, owner, signal);
      const buffer = await blob.downloadToBuffer(0, length, { abortSignal: signal, conditions: { ifMatch: etag } });
      return decodeRunExport(buffer, id);
    } catch (error) {
      throw storageError(error, "read");
    }
  }

  async remove(runId: string, owner: string): Promise<void> {
    try {
      const id = exportRunId(runId);
      const signal = AbortSignal.timeout(15_000);
      const blob = await this.blob(id);
      const { etag } = await this.owned(blob, owner, signal);
      await blob.delete({ abortSignal: signal, conditions: { ifMatch: etag }, deleteSnapshots: "include" });
    } catch (error) {
      throw storageError(error, "remove");
    }
  }
}

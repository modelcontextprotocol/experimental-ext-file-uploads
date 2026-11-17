import {
  CallFailedError,
  CallToolResult,
  EXT_ID,
  FileExtensionSettings,
  FileInput,
  RpcErrorException,
  RpcError,
  UploadRequiredResult,
  UploadTarget,
  DownloadTarget,
  isUploadRequired,
} from "./types.js";
import { resolvePathTarget, validateTarget } from "./targets.js";
import { baseName, buildMultipart } from "./multipart.js";

export interface ClientOptions {
  mcpAddress: string;
  /** Operator allowlist permitting http loopback targets. */
  allowLoopbackHttp?: boolean;
  settings?: FileExtensionSettings;
  /** When false, the client does not declare the extension at all. */
  declare?: boolean;
  fetchImpl?: typeof fetch;
}

interface RpcResponse {
  result?: unknown;
  error?: RpcError;
}

/**
 * Client transfer helper for the File Uploads extension.
 * Declares the extension, validates targets, performs transfers, and
 * drives the upload_required retry flow without returning control to
 * the model mid-flow.
 */
export class FileTransferClient {
  private readonly mcpAddress: string;
  private readonly allowLoopbackHttp: boolean;
  private readonly settings: FileExtensionSettings;
  private readonly declareExt: boolean;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;
  /** Conformance counter: upload requests seen in the current logical call. */
  uploadRequestsSeen = 0;

  constructor(private readonly options: ClientOptions) {
    this.mcpAddress = options.mcpAddress;
    this.allowLoopbackHttp = options.allowLoopbackHttp ?? false;
    this.settings = options.settings ?? { upload: {}, download: {} };
    this.declareExt = options.declare !== false;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private clientMeta(): Record<string, unknown> | undefined {
    if (!this.declareExt) return undefined;
    return {
      "io.modelcontextprotocol/clientCapabilities": {
        extensions: { [EXT_ID]: this.settings },
      },
    };
  }

  async rpc(
    method: string,
    params: Record<string, unknown> = {},
    declare = true
  ): Promise<unknown> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    const meta = declare ? this.clientMeta() : undefined;
    if (meta) {
      params._meta = meta;
    }
    const res = await this.fetchImpl(this.mcpAddress, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      throw new CallFailedError("MCP endpoint answered a redirect (" + res.status + ")");
    }
    const body = (await res.json()) as RpcResponse;
    if (body.error) {
      throw new RpcErrorException(body.error);
    }
    return body.result;
  }

  async listTools(): Promise<{ tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }> {
    return (await this.rpc("tools/list", {})) as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    };
  }

  async discover(): Promise<Record<string, unknown>> {
    return (await this.rpc("server/discover", {})) as Record<string, unknown>;
  }

  /**
   * Full tools/call flow: initial call, target validation, transfers,
   * retry. `files` carries bytes for out-of-band file ids.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    files: Record<string, Uint8Array> = {}
  ): Promise<CallToolResult> {
    this.uploadRequestsSeen = 0;

    const initial = (await this.rpc("tools/call", {
      name,
      arguments: args,
    })) as CallToolResult | UploadRequiredResult;

    if (!isUploadRequired(initial)) {
      if (initial && (initial as CallToolResult).isError) {
        return initial as CallToolResult;
      }
      return initial as CallToolResult;
    }

    this.uploadRequestsSeen++;
    if (this.uploadRequestsSeen > 1) {
      throw new CallFailedError("second upload request in the logical call");
    }

    // Validate the upload request against the files in args.
    const expectedIds = collectOutOfBandFileIds(args);
    const seen = new Set<string>();
    for (const target of initial.uploads) {
      if (seen.has(target.fileId)) {
        throw new CallFailedError("upload request lists fileId twice: " + target.fileId);
      }
      seen.add(target.fileId);
      if (!expectedIds.has(target.fileId)) {
        throw new CallFailedError("upload request lists unexpected fileId: " + target.fileId);
      }
    }
    for (const id of expectedIds) {
      if (!seen.has(id)) {
        throw new CallFailedError("upload request misses fileId: " + id);
      }
    }
    if (typeof initial.requestState !== "string" || initial.requestState.length === 0) {
      throw new CallFailedError("upload request has no requestState");
    }

    // Validate every target before transferring anything.
    for (const target of initial.uploads) {
      validateTarget(target, {
        kind: "upload",
        mcpAddress: this.mcpAddress,
        allowLoopbackHttp: this.allowLoopbackHttp,
      });
    }

    // Transfer each file. Only retry when every transfer got a 2xx.
    for (const target of initial.uploads) {
      const bytes = files[target.fileId];
      if (!bytes) {
        throw new CallFailedError("no bytes provided for " + target.fileId);
      }
      await this.transfer(target, bytes);
    }

    // Retry with a new id, same tool/args, echoed requestState.
    const retry = (await this.rpc("tools/call", {
      name,
      arguments: args,
      requestState: initial.requestState,
    })) as CallToolResult | UploadRequiredResult;

    if (isUploadRequired(retry)) {
      // Second upload request: the client MUST fail the logical call.
      throw new CallFailedError("second upload request in the logical call");
    }
    return retry;
  }

  private async transfer(target: UploadTarget, bytes: Uint8Array): Promise<void> {
    if (target.expiresAt && Date.parse(target.expiresAt) < Date.now()) {
      throw new CallFailedError("target expired before transfer: " + target.fileId);
    }

    const url = this.resolveTarget(target);
    const method = target.method ?? "PUT";
    const headers: Record<string, string> = {};
    let body: Uint8Array = bytes;

    if (target.form) {
      if (method !== "POST") {
        throw new CallFailedError("form target requires POST");
      }
      const fileField = target.form.fileField;
      const built = buildMultipart({
        fields: target.form.fields,
        file: {
          fileField,
          fileName: this.fileNameFor(target.fileId),
          mimeType: this.mimeTypeFor(target.fileId),
          bytes,
        },
      });
      body = built.body;
      headers["content-type"] = built.contentType;
    } else {
      // Without form: Content-Type exactly as headers lists it; MUST NOT
      // send one that headers does not list.
      if (target.headers) {
        for (const [k, v] of Object.entries(target.headers)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }

    // Content-Length is required.
    headers["content-length"] = String(body.byteLength);

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body as unknown as never,
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      throw new CallFailedError(
        "transfer failed: target answered a redirect (" + res.status + ") for " + target.fileId
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new CallFailedError("transfer failed: target answered " + res.status);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new CallFailedError(
        "transfer failed with status " + res.status + " for " + target.fileId
      );
    }
    // MUST NOT send more bytes than declared size.
    const declared = this.sizeFor(target.fileId);
    if (declared !== undefined && bytes.byteLength > declared) {
      throw new CallFailedError("refusing to send more bytes than declared size");
    }
  }

  private resolveTarget(target: UploadTarget | DownloadTarget): string {
    if (target.path !== undefined && target.path !== null) {
      const resolved = resolvePathTarget(this.mcpAddress, target.path);
      if (resolved.protocol === "http:" && !this.isLoopback(resolved) && !this.allowLoopbackHttp) {
        throw new CallFailedError("path target over http is not permitted");
      }
      return resolved.toString();
    }
    return target.url as string;
  }

  private isLoopback(url: URL): boolean {
    const h = url.hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  }

  private fileArgs = new Map<string, FileInput>();

  /** Registers file metadata for transfer-time lookups (name, mime, size). */
  registerFiles(args: Record<string, unknown>): void {
    this.fileArgs.clear();
    const walk = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      if (Array.isArray(value)) {
        for (const v of value) walk(v);
        return;
      }
      const obj = value as Record<string, unknown>;
      if (typeof obj.id === "string" && typeof obj.mimeType === "string" && typeof obj.size === "number") {
        this.fileArgs.set(obj.id, obj as unknown as FileInput);
      }
      for (const v of Object.values(obj)) walk(v);
    };
    walk(args);
  }

  private fileNameFor(fileId: string): string {
    return this.fileArgs.get(fileId)?.name ?? "file";
  }

  private mimeTypeFor(fileId: string): string {
    return this.fileArgs.get(fileId)?.mimeType ?? "application/octet-stream";
  }

  private sizeFor(fileId: string): number | undefined {
    return this.fileArgs.get(fileId)?.size;
  }

  /**
   * Fetches every download target in a result, verifying size and digest.
   * Returns the bytes keyed by file name.
   */
  async download(result: CallToolResult): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    const meta = result._meta?.[EXT_ID] as { downloads?: DownloadTarget[] } | undefined;
    const downloads = meta?.downloads ?? [];
    for (const target of downloads) {
      validateTarget(target, {
        kind: "download",
        mcpAddress: this.mcpAddress,
        allowLoopbackHttp: this.allowLoopbackHttp,
      });
      if (target.expiresAt && Date.parse(target.expiresAt) < Date.now()) {
        throw new CallFailedError("download target expired");
      }
      const url = this.resolveTarget(target);
      const headers: Record<string, string> = {};
      if (target.headers) {
        for (const [k, v] of Object.entries(target.headers)) headers[k.toLowerCase()] = v;
      }
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        throw new CallFailedError("download failed: redirect (" + res.status + ")");
      }
      if (res.status !== 200 && res.status !== 206) {
        throw new CallFailedError("download failed with status " + res.status);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      // MUST check size and digest; discard on failure. Abort if decoded
      // bytes exceed size.
      if (buf.byteLength > target.size) {
        throw new CallFailedError("download exceeds declared size; discarding");
      }
      if (buf.byteLength !== target.size) {
        throw new CallFailedError("download size mismatch; discarding");
      }
      if (target.digest) {
        const { createHash } = await import("node:crypto");
        const actual = createHash("sha256").update(buf).digest("base64url");
        if (actual !== target.digest.value) {
          throw new CallFailedError("download digest mismatch; discarding");
        }
      }
      // MUST NOT use name as a filesystem path without reducing to a safe
      // base name.
      out.set(baseName(target.name), buf);
    }
    return out;
  }
}

/** Collects FileInput ids that have no data (out-of-band) at any depth. */
export function collectOutOfBandFileIds(args: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (
      typeof obj.id === "string" &&
      typeof obj.mimeType === "string" &&
      typeof obj.size === "number" &&
      obj.size > 0 &&
      (obj.data === undefined || obj.data === null)
    ) {
      ids.add(obj.id);
    }
    for (const v of Object.values(obj)) walk(v);
  };
  walk(args);
  return ids;
}







/** Extension identifier from the draft specification. */
export const EXT_ID = "io.modelcontextprotocol/files";

/** The value of the x-mcp-file keyword. */
export interface FileInputDescriptor {
  /** Media types or dot-prefixed extensions for a file picker. */
  accept?: string[];
  /** Maximum decoded size of each file in bytes, for inline and out-of-band transfer. */
  maxSize?: number;
}

export interface FileDigest {
  algorithm: "sha-256";
  /** base64url, no padding. */
  value: string;
}

/** A file argument value carried in Tool.inputSchema properties marked with x-mcp-file. */
export interface FileInput {
  /** 1 to 128 characters, unique within the call. */
  id: string;
  name?: string;
  /** "application/octet-stream" if unknown. */
  mimeType: string;
  /** Non-negative integer; decoded size in bytes. */
  size: number;
  digest?: FileDigest;
  /** RFC 4648 base64. Absent plus size > 0 requests an out-of-band upload. */
  data?: string | null;
}

export interface UploadForm {
  fields: { name: string; value: string }[];
  fileField: string;
}

export interface UploadTarget {
  /** The corresponding FileInput.id in the original arguments. */
  fileId: string;
  url?: string;
  path?: string;
  method?: "PUT" | "POST";
  form?: UploadForm;
  headers?: Record<string, string>;
  credentials: "omit" | "include";
  expiresAt?: string;
  _meta?: Record<string, unknown>;
}

export interface UploadRequiredResult {
  resultType: "upload_required";
  uploads: UploadTarget[];
  /** Opaque to the client, which echoes it on the retry. */
  requestState: string;
}

export interface DownloadTarget {
  name?: string;
  mimeType: string;
  size: number;
  digest?: FileDigest;
  url?: string;
  path?: string;
  headers?: Record<string, string>;
  credentials: "omit" | "include";
  expiresAt?: string;
  _meta?: Record<string, unknown>;
}

export interface ResultFilesMeta {
  downloads: DownloadTarget[];
}

/** Settings object carried under the extension identifier. */
export interface FileExtensionSettings {
  upload?: Record<string, unknown>;
  download?: Record<string, unknown>;
  /** Servers only. */
  maxInlineBytes?: number;
  revision?: string;
}

/** Client declaration shape: _meta["io.modelcontextprotocol/clientCapabilities"]. */
export interface ClientCapabilitiesMeta {
  extensions: Record<string, FileExtensionSettings>;
}

export interface CallToolResult {
  resultType?: string;
  content: Array<{ type: "text"; text: string } | { type: "resource"; resource: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcErrorException extends Error {
  constructor(public readonly error: RpcError) {
    super(`${error.code}: ${error.message}`);
    this.name = "RpcErrorException";
  }
}

/** Client-facing failure of the logical call (not a JSON-RPC error). */
export class CallFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallFailedError";
  }
}

export const MISSING_CLIENT_CAPABILITY = -32021;
export const INVALID_PARAMS = -32602;

export function isRpcError(value: unknown): value is RpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RpcError).code === "number" &&
    typeof (value as RpcError).message === "string"
  );
}

export function isUploadRequired(
  value: unknown
): value is UploadRequiredResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as UploadRequiredResult).resultType === "upload_required" &&
    Array.isArray((value as UploadRequiredResult).uploads) &&
    typeof (value as UploadRequiredResult).requestState === "string"
  );
}

/** JSON Schema instance equality: member order and number spelling do not matter. */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") {
      // 1 and 1.0 are the same instance value.
      return value === 0 ? 0 : value;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

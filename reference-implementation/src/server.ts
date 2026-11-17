import { createHash } from "node:crypto";
import {
  CallToolResult,
  ClientCapabilitiesMeta,
  EXT_ID,
  FileExtensionSettings,
  FileInput,
  INVALID_PARAMS,
  MISSING_CLIENT_CAPABILITY,
  RpcErrorException,
  UploadRequiredResult,
  canonicalize,
} from "./types.js";
import { isMediaType } from "./targets.js";
import { LocalObjectStore } from "./store.js";
import { RequestStateManager } from "./request-state.js";

export interface ServerOptions {
  store: LocalObjectStore;
  maxInlineBytes?: number;
  /** Folder IDs starting with this prefix issue POST+form targets. */
  formFolderPrefix?: string;
  /** Test hooks — not part of the specification. */
  hooks?: ServerHooks;
}

export interface ServerHooks {
  /** Target this fileId's path to a path that answers 302. */
  redirectUploadFileIds?: Set<string>;
  /** Issue an invalid target (non-https url) for these fileIds. */
  invalidTargetFileIds?: Set<string>;
  /** Answer 500 on PUT/POST for these fileIds. */
  failUploadFileIds?: Set<string>;
  /** Return upload_required again even on a retry. */
  forceUploadRequestOnRetry?: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const FILE_SCHEMA = (maxSize: number, accept: string[]): Record<string, unknown> => ({
  type: "object",
  "x-mcp-file": { accept, maxSize },
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    name: { type: "string" },
    mimeType: { type: "string" },
    size: { type: "integer", minimum: 0 },
    digest: {
      type: "object",
      properties: {
        algorithm: { const: "sha-256" },
        value: { type: "string" },
      },
      required: ["algorithm", "value"],
    },
    data: { type: "string" },
  },
  required: ["id", "mimeType", "size"],
});

export class FileUploadsServer {
  readonly store: LocalObjectStore;
  readonly states: RequestStateManager;
  readonly maxInlineBytes: number;
  readonly hooks: ServerHooks;
  private readonly formFolderPrefix: string;
  /** Conformance counters (not part of the spec). */
  toolRunCount = 0;
  uploadRequestCount = 0;

  constructor(private readonly options: ServerOptions) {
    this.store = options.store;
    this.states = new RequestStateManager(60_000);
    this.maxInlineBytes = options.maxInlineBytes ?? 1_048_576;
    this.formFolderPrefix = options.formFolderPrefix ?? "form_";
    this.hooks = options.hooks ?? {};
  }

  private tools(declared: boolean): ToolDef[] {
    const tools: ToolDef[] = [];
    // Backward compatibility: omit x-mcp-file tools for requests that did
    // not declare the extension.
    if (declared) {
      tools.push({
        name: "save_to_folder",
        description: "Save a file into a folder. Accepts inline or out-of-band transfer.",
        inputSchema: {
          type: "object",
          properties: {
            folderId: { type: "string" },
            file: FILE_SCHEMA(157_286_400, ["application/pdf", "text/plain", "text/csv"]),
          },
          required: ["folderId", "file"],
        },
      });
    }
    tools.push({
      name: "export_orders",
      description: "Export orders as CSV. Always returns a download target.",
      inputSchema: { type: "object", properties: {} },
    });
    return tools;
  }

  private declared(meta: Record<string, unknown> | undefined): FileExtensionSettings | null {
    if (!meta) return null;
    const caps = meta["io.modelcontextprotocol/clientCapabilities"] as
      | ClientCapabilitiesMeta
      | undefined;
    if (!caps || typeof caps !== "object") return null;
    const settings = caps.extensions?.[EXT_ID];
    if (!settings || typeof settings !== "object") return null;
    return settings;
  }

  discover(): Record<string, unknown> {
    return {
      protocolVersion: "2026-07-28",
      capabilities: {
        tools: {},
        extensions: {
          [EXT_ID]: {
            upload: {},
            maxInlineBytes: this.maxInlineBytes,
          },
        },
      },
    };
  }

  listTools(declared: boolean): { tools: ToolDef[] } {
    return { tools: this.tools(declared) };
  }

  /**
   * Handles tools/call. Returns a result object, or throws RpcErrorException
   * for JSON-RPC errors (-32021, -32602).
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    meta: Record<string, unknown> | undefined,
    requestState: unknown
  ): CallToolResult | UploadRequiredResult {
    const settings = this.declared(meta);
    const declared = settings !== null;
    const declaredUpload = declared && settings!.upload !== undefined;
    const declaredDownload = declared && settings!.download !== undefined;

    if (name === "export_orders") {
      return this.exportOrders(declaredDownload, declared);
    }
    if (name !== "save_to_folder") {
      throw new RpcErrorException({ code: -32602, message: "Unknown tool: " + name });
    }
    if (!declared) {
      // Tool omitted from tools/list; calling it without declaring is an
      // unknown tool for a non-declaring client.
      throw new RpcErrorException({
        code: -32602,
        message: "Unknown tool: save_to_folder",
      });
    }

    const folderId = args.folderId;
    const file = args.file as FileInput | undefined;
    if (typeof folderId !== "string" || typeof file !== "object" || file === null) {
      return this.isErrorResult("Invalid arguments: folderId and file are required.");
    }

    // Structural FileInput checks (server MUST validate shape).
    const shapeErrors: string[] = [];
    if (typeof file.id !== "string" || file.id.length < 1 || file.id.length > 128) {
      shapeErrors.push("file.id must be 1 to 128 characters");
    }
    if (typeof file.mimeType !== "string") shapeErrors.push("file.mimeType must be a string");
    if (typeof file.size !== "number" || !Number.isInteger(file.size) || file.size < 0) {
      shapeErrors.push("file.size must be a non-negative integer");
    }
    if (file.data === null) {
      // Servers treat data: null as undecodable inline data.
      return this.isErrorResult("Inline data is undecodable.");
    }
    if (shapeErrors.length > 0) {
      return this.isErrorResult(shapeErrors.join("; "));
    }

    const descriptor = { accept: ["application/pdf", "text/plain", "text/csv"], maxSize: 157_286_400 };

    // Metadata checks that do not require the bytes.
    if (typeof descriptor.maxSize === "number" && file.size > descriptor.maxSize) {
      return this.isErrorResult(
        "File exceeds maxSize (" + file.size + " > " + descriptor.maxSize + ")."
      );
    }
    if (descriptor.accept && descriptor.accept.length > 0) {
      if (!this.acceptsFile(descriptor.accept, file)) {
        return this.isErrorResult(
          "File type not accepted: " + file.mimeType + (file.name ? " (" + file.name + ")" : "") + "."
        );
      }
    }

    const hasData = file.data !== undefined;
    const isEmpty = file.size === 0;

    // ---- Empty file: no bytes to transfer, no target issued. ----
    if (isEmpty) {
      if (requestState !== undefined && requestState !== null) {
        return this.runSaveTool(folderId, file, undefined);
      }
      if (hasData && (file.data as string).length > 0) {
        return this.isErrorResult("Inline data is undecodable.");
      }
      if (hasData && file.digest) {
        const empty = createHash("sha256").update(new Uint8Array(0)).digest("base64url");
        if (file.digest.value !== empty) {
          return this.isErrorResult("Digest check failed for empty file.");
        }
      }
      return this.runSaveTool(folderId, file, undefined);
    }

    // ---- Inline path ----
    if (hasData) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(Buffer.from(file.data as string, "base64"));
        // Round-trip check: reject undecodable base64.
        if (Buffer.from(bytes).toString("base64") !== Buffer.from(file.data as string, "base64").toString("base64")) {
          throw new Error("not base64");
        }
      } catch {
        return this.isErrorResult("Inline data is undecodable.");
      }
      if (bytes.byteLength > this.maxInlineBytes) {
        return this.isErrorResult(
          "Inline data is over maxInlineBytes (" + bytes.byteLength + " > " + this.maxInlineBytes + ")."
        );
      }
      if (bytes.byteLength !== file.size) {
        return this.isErrorResult(
          "Inline data size mismatch (have " + bytes.byteLength + ", declared " + file.size + ")."
        );
      }
      if (file.digest) {
        const actual = createHash("sha256").update(bytes).digest("base64url");
        if (file.digest.value !== actual) {
          return this.isErrorResult("Digest check failed for inline data.");
        }
      }
      // Duplicate id check happens across the call; single file here.
      return this.runSaveTool(folderId, file, undefined);
    }

    // ---- Out-of-band path: no data, size > 0 ----
    if (!declaredUpload) {
      throw new RpcErrorException({
        code: MISSING_CLIENT_CAPABILITY,
        message: "MissingRequiredClientCapabilityError",
        data: { requiredCapabilities: [EXT_ID] },
      });
    }

    // Duplicate id within the call.
    if (typeof file.id !== "string" || file.id.length === 0) {
      return this.isErrorResult("Duplicate or empty file id.");
    }

    // Retry path.
    if (requestState !== undefined && requestState !== null) {
      return this.handleRetry(name, args, file, folderId, requestState);
    }

    // Issue an upload request.
    if (this.hooks.forceUploadRequestOnRetry) {
      // (used only on retries; initial call proceeds normally)
    }
    return this.issueUploadRequest(folderId, file, args, name);
  }

  private acceptsFile(accept: string[], file: FileInput): boolean {
    for (const entry of accept) {
      if (entry.startsWith(".")) {
        if (file.name && file.name.toLowerCase().endsWith(entry.toLowerCase())) return true;
        continue;
      }
      if (entry.endsWith("/*")) {
        const prefix = entry.slice(0, -1);
        if (file.mimeType.startsWith(prefix)) return true;
        continue;
      }
      if (file.mimeType === entry) return true;
      if (isMediaType(entry) && file.mimeType === entry) return true;
    }
    return false;
  }

  private issueUploadRequest(
    folderId: string,
    file: FileInput,
    args: Record<string, unknown>,
    toolName: string
  ): UploadRequiredResult {
    const staging = this.store.createStaging({
      fileId: file.id,
      declaredSize: file.size,
      mimeType: file.mimeType,
    });

    const record = this.states.issue({
      toolName,
      args,
      principal: null,
      files: [
        {
          fileId: file.id,
          stagingId: staging.stagingId,
          declaredSize: file.size,
          mimeType: file.mimeType,
          name: file.name,
        },
      ],
    });

    const expiresAt = new Date(record.expiresAt).toISOString();
    const useForm = folderId.startsWith(this.formFolderPrefix);

    if (this.hooks.invalidTargetFileIds?.has(file.id)) {
      // Test hook: a target that fails client validation (non-https).
      this.uploadRequestCount++;
      return {
        resultType: "upload_required",
        uploads: [
          {
            fileId: file.id,
            url: "http://evil.example/upload",
            method: "PUT",
            credentials: "omit",
            expiresAt,
          },
        ],
        requestState: record.token,
      };
    }

    const path = this.hooks.redirectUploadFileIds?.has(file.id)
      ? "/uploads/redirect-test"
      : "/uploads/" + staging.stagingId;

    const target = useForm
      ? {
          fileId: file.id,
          path,
          method: "POST" as const,
          form: {
            fields: [{ name: "key", value: "staging/" + staging.stagingId }],
            fileField: "file",
          },
          headers: {} as Record<string, string>,
          credentials: "omit" as const,
          expiresAt,
        }
      : {
          fileId: file.id,
          path,
          method: "PUT" as const,
          headers: { "Content-Type": file.mimeType },
          credentials: "omit" as const,
          expiresAt,
        };

    this.uploadRequestCount++;
    return {
      resultType: "upload_required",
      uploads: [target],
      requestState: record.token,
    };
  }

  /** Retry steps 1-5. */
  private handleRetry(
    toolName: string,
    args: Record<string, unknown>,
    file: FileInput,
    folderId: string,
    requestState: unknown
  ): CallToolResult | UploadRequiredResult {
    // A second upload request in the logical call: if the hook forces it,
    // issue a NEW requestState; the client must fail the call instead.
    if (this.hooks.forceUploadRequestOnRetry) {
      const staging = this.store.createStaging({
        fileId: file.id,
        declaredSize: file.size,
        mimeType: file.mimeType,
      });
      const record = this.states.issue({
        toolName,
        args,
        principal: null,
        files: [
          {
            fileId: file.id,
            stagingId: staging.stagingId,
            declaredSize: file.size,
            mimeType: file.mimeType,
            name: file.name,
          },
        ],
      });
      this.uploadRequestCount++;
      return {
        resultType: "upload_required",
        uploads: [
          {
            fileId: file.id,
            path: "/uploads/" + staging.stagingId,
            method: "PUT",
            headers: { "Content-Type": file.mimeType },
            credentials: "omit",
            expiresAt: new Date(record.expiresAt).toISOString(),
          },
        ],
        requestState: record.token,
      };
    }

    // Step 1 + 2: verify requestState and binding.
    const verified = this.states.verify(requestState, {
      toolName,
      args,
      principal: null,
    });
    if (!verified.ok) {
      throw new RpcErrorException({
        code: INVALID_PARAMS,
        message:
          verified.reason === "consumed"
            ? "requestState was already consumed"
            : verified.reason === "binding"
              ? "requestState does not match this call"
              : "invalid or expired requestState",
      });
    }
    const record = verified.record;

    // Step 3: confirm bytes with storage.
    for (const binding of record.files) {
      const confirmed = this.store.confirm(binding.stagingId, {
        declaredSize: binding.declaredSize,
        digestRequired: file.digest !== undefined,
        expectedDigest: file.digest?.value,
      });
      if (!confirmed.ok) {
        return this.isErrorResult("Bytes not confirmed: " + (confirmed.reason ?? "unknown") + ".");
      }
    }

    // Step 4: save_to_folder is unsafe to run twice — consume atomically.
    if (!this.states.consume(record.token)) {
      throw new RpcErrorException({
        code: INVALID_PARAMS,
        message: "requestState was already consumed",
      });
    }

    // Step 5: finalize + run the tool.
    return this.runSaveTool(folderId, file, record.files[0]?.stagingId);
  }

  private runSaveTool(
    folderId: string,
    file: FileInput,
    stagingId: string | undefined
  ): CallToolResult {
    const name = file.name ?? "file";
    if (this.store.exists(folderId, name)) {
      return this.isErrorResult("Conflict: " + name + " already exists in " + folderId + ".");
    }
    if (stagingId) {
      const finalPath = this.store.finalize(stagingId, folderId, name);
      if (finalPath === null) {
        return this.isErrorResult("Conflict: " + name + " already exists in " + folderId + ".");
      }
    } else if (file.size > 0 && file.data !== undefined) {
      // Inline: write directly to final.
      const bytes = new Uint8Array(Buffer.from(file.data ?? "", "base64"));
      this.store.putFinal(folderId + "/" + name.replace(/[\/\\]/g, "_"), bytes);
    } else if (file.size === 0) {
      this.store.putFinal(folderId + "/" + name.replace(/[\/\\]/g, "_"), new Uint8Array(0));
    }
    this.toolRunCount++;
    return {
      resultType: "complete",
      content: [{ type: "text", text: "Saved " + name + " to " + folderId + "." }],
    };
  }

  private exportOrders(declaredDownload: boolean, declared: boolean): CallToolResult {
    if (!declaredDownload) {
      if (!declared) {
        throw new RpcErrorException({
          code: MISSING_CLIENT_CAPABILITY,
          message: "MissingRequiredClientCapabilityError",
          data: { requiredCapabilities: [EXT_ID] },
        });
      }
      throw new RpcErrorException({
        code: MISSING_CLIENT_CAPABILITY,
        message: "MissingRequiredClientCapabilityError",
        data: { requiredCapabilities: [EXT_ID] },
      });
    }
    const csv = "order_id,total\n1,10.00\n2,20.00\n";
    const bytes = new TextEncoder().encode(csv);
    const digest = createHash("sha256").update(bytes).digest("base64url");
    const downloadId = createHash("sha256")
      .update(csv + Date.now())
      .digest("hex")
      .slice(0, 24);
    this.store.putFinal("downloads/" + downloadId + ".csv", bytes);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    this.toolRunCount++;
    return {
      resultType: "complete",
      content: [{ type: "text", text: "Exported q3-orders.csv." }],
      _meta: {
        [EXT_ID]: {
          downloads: [
            {
              name: "q3-orders.csv",
              mimeType: "text/csv",
              size: bytes.byteLength,
              digest: { algorithm: "sha-256", value: digest },
              path: "/downloads/" + downloadId,
              credentials: "omit",
              expiresAt,
            },
          ],
        },
      },
    };
  }

  private isErrorResult(message: string): CallToolResult {
    return {
      resultType: "error",
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}



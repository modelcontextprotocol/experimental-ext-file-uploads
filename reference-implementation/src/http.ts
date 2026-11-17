import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { FileUploadsServer } from "./server.js";
import { parseMultipart } from "./multipart.js";
import { EXT_ID, RpcErrorException } from "./types.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Minimal Streamable-HTTP-shaped endpoint carrying the extension's
 * JSON-RPC surface plus the transfer targets (uploads/downloads).
 * The transport is intentionally small; the extension logic is the
 * focus of this reference implementation.
 */
export class ReferenceHttpServer {
  private server: Server | null = null;
  private address = "";

  constructor(private readonly impl: FileUploadsServer) {}

  get mcpAddress(): string {
    return this.address;
  }

  async listen(port = 0): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
        }
        res.end(String(err && err.message ? err.message : err));
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    const info = this.server!.address() as AddressInfo;
    this.address = "http://127.0.0.1:" + info.port + "/mcp";
    return this.address;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }

  private async readBody(req: IncomingMessage): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    // Transfer endpoints.
    if (path === "/mcp/uploads/redirect-test") {
      res.writeHead(302, { location: "http://127.0.0.1/elsewhere" });
      res.end();
      return;
    }
    if (req.method === "PUT" && path.startsWith("/mcp/uploads/")) {
      this.handleUpload(req, res, path.slice("/mcp/uploads/".length), "raw");
      return;
    }
    if (req.method === "POST" && path.startsWith("/mcp/uploads/")) {
      this.handleUpload(req, res, path.slice("/mcp/uploads/".length), "form");
      return;
    }
    if (req.method === "GET" && path.startsWith("/mcp/downloads/")) {
      this.handleDownload(res, path.slice("/mcp/downloads/".length));
      return;
    }
    if (path !== "/mcp" || req.method !== "POST") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    const raw = await this.readBody(req);
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      this.json(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    const result = this.dispatch(message);
    if (result === undefined) {
      // Notification: no response body per JSON-RPC.
      res.writeHead(202).end();
      return;
    }
    this.json(res, 200, result);
  }

  private dispatch(
    message: JsonRpcRequest
  ): { jsonrpc: "2.0"; id: number | string | null; result?: unknown; error?: unknown } | undefined {
    const { id, method, params } = message;
    const meta = (params?._meta ?? undefined) as Record<string, unknown> | undefined;

    if (id === undefined || id === null) {
      // Notification (e.g. notifications/initialized).
      return undefined;
    }

    try {
      switch (method) {
        case "initialize":
          return { jsonrpc: "2.0", id, result: this.impl.discover() };
        case "server/discover":
          return { jsonrpc: "2.0", id, result: this.impl.discover() };
        case "tools/list": {
          const declared = this.impl.listTools.length >= 0 && this.isDeclared(meta);
          return { jsonrpc: "2.0", id, result: this.impl.listTools(declared) };
        }
        case "tools/call": {
          const name = String(params?.name ?? "");
          const args = (params?.arguments ?? {}) as Record<string, unknown>;
          const requestState = params?.requestState;
          const result = this.impl.callTool(name, args, meta, requestState);
          return { jsonrpc: "2.0", id, result };
        }
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Method not found: " + method },
          };
      }
    } catch (err) {
      if (err instanceof RpcErrorException) {
        return { jsonrpc: "2.0", id, error: err.error };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: String((err as Error)?.message ?? err) },
      };
    }
  }

  private isDeclared(meta: Record<string, unknown> | undefined): boolean {
    if (!meta) return false;
    const caps = meta["io.modelcontextprotocol/clientCapabilities"] as
      | { extensions?: Record<string, unknown> }
      | undefined;
    return Boolean(caps && caps.extensions && EXT_ID in caps.extensions);
  }

  private handleUpload(
    req: IncomingMessage,
    res: ServerResponse,
    stagingId: string,
    mode: "raw" | "form"
  ): void {
    void (async () => {
      const body = await this.readBody(req);
      let bytes = body;
      if (mode === "form") {
        const contentType = String(req.headers["content-type"] ?? "");
        try {
          const parsed = parseMultipart(body, contentType);
          if (!parsed.file) {
            res.writeHead(400).end("missing file part");
            return;
          }
          bytes = parsed.file.bytes;
        } catch (err) {
          res.writeHead(400).end(String((err as Error).message));
          return;
        }
      }

      const record = this.impl.store.getStaging(stagingId);
      const fileId = record?.fileId;

      if (fileId && this.impl.hooks.failUploadFileIds?.has(fileId)) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("injected failure");
        return;
      }

      const outcome = this.impl.store.write(stagingId, bytes);
      if (outcome.status >= 400) {
        res.writeHead(outcome.status, { "content-type": "text/plain" });
        res.end(outcome.error ?? "error");
        return;
      }
      res.writeHead(outcome.status).end();
    })().catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String((err as Error).message));
    });
  }

  private handleDownload(res: ServerResponse, downloadId: string): void {
    const safe = downloadId.replace(/[^A-Za-z0-9._-]/g, "");
    const bytes = this.impl.store.readFinal("downloads/" + safe + ".csv");
    if (!bytes) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/csv",
      "content-length": bytes.byteLength,
    });
    res.end(Buffer.from(bytes));
  }
}



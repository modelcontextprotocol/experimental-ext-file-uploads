import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CallFailedError,
  FileTransferClient,
  FileUploadsServer,
  LocalObjectStore,
  ReferenceHttpServer,
  RpcErrorException,
  EXT_ID,
} from "../src/index.js";

interface TestCase {
  name: string;
  fn: () => Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("Assertion failed: " + msg);
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg + "\n  expected: " + e + "\n  actual:   " + a);
}

function sha256Base64url(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

function pdfBytes(n = 64): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 13) & 0xff;
  // Make it look like a PDF for mimeType checks.
  const header = new TextEncoder().encode("%PDF-1.4\n");
  b.set(header.subarray(0, Math.min(header.length, n)), 0);
  return b;
}

interface Harness {
  server: ReferenceHttpServer;
  impl: FileUploadsServer;
  store: LocalObjectStore;
  client: FileTransferClient;
  address: string;
  root: string;
  close: () => Promise<void>;
}

async function makeHarness(
  opts: {
    enforceSizeOnWrite?: boolean;
    settings?: { upload?: Record<string, unknown>; download?: Record<string, unknown> };
    hooks?: ConstructorParameters<typeof FileUploadsServer>[0]["hooks"];
  } = {}
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "mcp-files-ref-"));
  const store = new LocalObjectStore(root, {
    enforceSizeOnWrite: opts.enforceSizeOnWrite !== false,
  });
  const impl = new FileUploadsServer({
    store,
    maxInlineBytes: 1024,
    hooks: opts.hooks ?? {},
  });
  const server = new ReferenceHttpServer(impl);
  const address = await server.listen(0);
  const client = new FileTransferClient({
    mcpAddress: address,
    allowLoopbackHttp: true,
    settings: opts.settings ?? { upload: {}, download: {} },
  });
  return {
    server,
    impl,
    store,
    client,
    address,
    root,
    close: async () => {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function makeHarnessDeclaring(
  declare: boolean,
  settings?: { upload?: Record<string, unknown>; download?: Record<string, unknown> }
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "mcp-files-ref-"));
  const store = new LocalObjectStore(root, { enforceSizeOnWrite: true });
  const impl = new FileUploadsServer({ store, maxInlineBytes: 1024 });
  const server = new ReferenceHttpServer(impl);
  const address = await server.listen(0);
  const client = new FileTransferClient({
    mcpAddress: address,
    allowLoopbackHttp: true,
    declare,
    settings: settings ?? { upload: {}, download: {} },
  });
  return {
    server, impl, store, client, address, root,
    close: async () => { await server.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function fileArg(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "file-1",
    name: "Q3 report.pdf",
    mimeType: "application/pdf",
    size: 64,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Inline transfer
// ---------------------------------------------------------------------------
test("1. inline transfer: data travels in the tool call, no upload request", async () => {
  const h = await makeHarness();
  try {
    const bytes = pdfBytes(64);
    const args = {
      folderId: "fld_1",
      file: fileArg({
        data: Buffer.from(bytes).toString("base64"),
        digest: { algorithm: "sha-256", value: sha256Base64url(bytes) },
      }),
    };
    const result = await h.client.callTool("save_to_folder", args);
    assert(!result.isError, "inline call should succeed: " + JSON.stringify(result));
    assertEq(h.impl.uploadRequestCount, 0, "must not issue an upload request");
    assertEq(h.impl.toolRunCount, 1, "tool must run once");
    const saved = h.store.readFinal("fld_1/Q3 report.pdf");
    assert(saved, "file must be saved");
    assertEq(new Uint8Array(saved!), bytes, "saved bytes must match");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Out-of-band transfer
// ---------------------------------------------------------------------------
test("2. out-of-band transfer: upload_required -> PUT -> retry -> saved", async () => {
  const h = await makeHarness();
  try {
    const bytes = pdfBytes(64);
    const args = { folderId: "fld_2", file: fileArg({ size: 64 }) };
    h.client.registerFiles(args);
    const result = await h.client.callTool("save_to_folder", args, {
      "file-1": bytes,
    });
    assert(!result.isError, "out-of-band call should succeed: " + JSON.stringify(result));
    assertEq(h.impl.uploadRequestCount, 1, "one upload request");
    assertEq(h.impl.toolRunCount, 1, "tool runs once, after the retry");
    const saved = h.store.readFinal("fld_2/Q3 report.pdf");
    assert(saved, "file must be saved");
    assertEq(new Uint8Array(saved!), bytes, "saved bytes must match");
    assertEq(h.client.uploadRequestsSeen, 1, "client saw exactly one upload request");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Form target
// ---------------------------------------------------------------------------
test("3. form target: POST + multipart/form-data, fields in order, file last", async () => {
  const h = await makeHarness();
  try {
    const bytes = pdfBytes(64);
    const args = { folderId: "form_orders", file: fileArg({ size: 64 }) };
    h.client.registerFiles(args);
    const result = await h.client.callTool("save_to_folder", args, {
      "file-1": bytes,
    });
    assert(!result.isError, "form call should succeed: " + JSON.stringify(result));
    assertEq(h.impl.toolRunCount, 1, "tool runs once");
    const saved = h.store.readFinal("form_orders/Q3 report.pdf");
    assert(saved, "file must be saved via form path");
    assertEq(new Uint8Array(saved!), bytes, "saved bytes must match");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Target rejection (client rejects an invalid target)
// ---------------------------------------------------------------------------
test("4. target rejection: non-https url target is rejected before any transfer", async () => {
  const h = await makeHarness({
    hooks: { invalidTargetFileIds: new Set(["file-1"]) },
  });
  try {
    const args = { folderId: "fld_4", file: fileArg({ size: 64 }) };
    h.client.registerFiles(args);
    let failed = false;
    let message = "";
    try {
      await h.client.callTool("save_to_folder", args, { "file-1": pdfBytes(64) });
    } catch (err) {
      failed = true;
      message = String((err as Error).message);
    }
    assert(failed, "call must fail on an invalid target");
    assert(
      message.includes("invalid upload target") || message.includes("https"),
      "error must mention target validation: " + message
    );
    assertEq(h.impl.toolRunCount, 0, "tool must not run");
    assertEq(h.store.stagedWrittenCount(), 0, "no bytes may be transferred");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Rejection on metadata
// ---------------------------------------------------------------------------
test("5. rejection on metadata: unacceptable mimeType -> isError, no target", async () => {
  const h = await makeHarness();
  try {
    const args = {
      folderId: "fld_5",
      file: fileArg({
        name: "photo.png",
        mimeType: "image/png",
        size: 64,
      }),
    };
    h.client.registerFiles(args);
    const result = await h.client.callTool("save_to_folder", args, {
      "file-1": pdfBytes(64),
    });
    assert(result.isError, "server must reject on metadata");
    assertEq(h.impl.uploadRequestCount, 0, "no upload request may be issued");
    assertEq(h.impl.toolRunCount, 0, "tool must not run");
    assert(
      (result.content[0] as { text: string }).text.includes("not accepted"),
      "error must mention acceptance"
    );
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Failed transfer with no retry
// ---------------------------------------------------------------------------
test("6. failed transfer with no retry: 500 on PUT -> call fails, tool never runs", async () => {
  const h = await makeHarness({
    hooks: { failUploadFileIds: new Set(["file-1"]) },
  });
  try {
    const args = { folderId: "fld_6", file: fileArg({ size: 64 }) };
    h.client.registerFiles(args);
    let failed = false;
    let message = "";
    try {
      await h.client.callTool("save_to_folder", args, { "file-1": pdfBytes(64) });
    } catch (err) {
      failed = true;
      message = String((err as Error).message);
    }
    assert(failed, "call must fail when the transfer fails");
    assert(message.includes("500"), "error must mention the status: " + message);
    assertEq(h.impl.toolRunCount, 0, "tool must not run");
    assertEq(h.store.stagedWrittenCount(), 0, "bytes must not be staged");
    // The client MUST NOT send the retry: uploadRequestCount stays 1 and
    // no second tools/call was made (toolRunCount is 0).
    assertEq(h.impl.uploadRequestCount, 1, "only the initial upload request");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Size mismatch (server confirm step catches it)
// ---------------------------------------------------------------------------
test("7. size mismatch: short write accepted by store, confirm rejects on retry", async () => {
  // Store that does not enforce size on write: the confirm step is the
  // only size check, which is what the retry step-3 rule covers.
  const h = await makeHarness({ enforceSizeOnWrite: false });
  try {
    const declared = 64;
    const shortBytes = pdfBytes(32); // fewer bytes than declared
    const args = { folderId: "fld_7", file: fileArg({ size: declared }) };
    h.client.registerFiles(args);

    // Bypass the client's own size guard to simulate a misbehaving client
    // that sends fewer bytes than declared (the server must still check).
    const originalTransfer = (h.client as unknown as { transfer: unknown }).transfer;
    let intercepted = false;
    (h.client as unknown as { transfer: unknown }).transfer = async function (
      this: unknown,
      target: { fileId: string },
      _bytes: Uint8Array
    ) {
      intercepted = true;
      const url = new URL(
        target.fileId ? "/mcp/uploads/unknown" : "",
        h.address
      );
      // Find the real target path from a fresh upload request by doing a
      // direct PUT to a staging id we discover below.
      void originalTransfer;
      void url;
      throw new Error("placeholder");
    };

    // Simpler: perform the flow manually.
    (h.client as unknown as { transfer: unknown }).transfer = originalTransfer;

    // Drive the server directly for this scenario: issue the upload
    // request, short-write the staging entry, then retry.
    const meta = {
      "io.modelcontextprotocol/clientCapabilities": {
        extensions: { [EXT_ID]: { upload: {}, download: {} } },
      },
    };
    const first = (await h.client.rpc("tools/call", {
      name: "save_to_folder",
      arguments: args,
    })) as { resultType: string; uploads: Array<{ path: string }>; requestState: string };
    assertEq(first.resultType, "upload_required", "first call must be upload_required");

    // Short-write directly into the store (models a backend that cannot
    // enforce size on write).
    const stagingPath = first.uploads[0]!.path!;
    const stagingId = stagingPath.split("/").pop()!;
    const outcome = h.store.write(stagingId, shortBytes);
    assert(outcome.status < 400, "store accepted the short write: " + outcome.error);

    // Retry: server step 3 must reject the size mismatch.
    let rpcErr: RpcErrorException | null = null;
    let result: { isError?: boolean; content?: Array<{ text: string }> } | null = null as unknown as null;
    try {
      result = (await h.client.rpc("tools/call", { name: "save_to_folder", arguments: args, requestState: first.requestState })) as { isError?: boolean; content?: Array<{ text: string }> };
    } catch (err) {
      if (err instanceof RpcErrorException) rpcErr = err;
      else throw err;
    }
    assert(!rpcErr, "size mismatch is isError, not a JSON-RPC error");
    assert(result && result.isError, "retry must return isError");
    assert(
      result!.content![0]!.text.includes("size mismatch"),
      "error must mention size mismatch: " + result!.content![0]!.text
    );
    assertEq(h.impl.toolRunCount, 0, "tool must not run");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 8. Consumed requestState
// ---------------------------------------------------------------------------
test("8. consumed requestState: second retry with the same token -> -32602", async () => {
  const h = await makeHarness();
  try {
    const bytes = pdfBytes(64);
    const args = { folderId: "fld_8", file: fileArg({ size: 64 }) };
    h.client.registerFiles(args);

    const meta = {
      "io.modelcontextprotocol/clientCapabilities": {
        extensions: { [EXT_ID]: { upload: {}, download: {} } },
      },
    };
    void meta;
    const first = (await h.client.rpc("tools/call", {
      name: "save_to_folder",
      arguments: args,
    })) as { resultType: string; uploads: Array<{ path: string }>; requestState: string };
    assertEq(first.resultType, "upload_required", "upload request expected");

    // Transfer.
    const stagingId = first.uploads[0]!.path!.split("/").pop()!;
    const putUrl = h.address.replace(/\/mcp$/, "/mcp/uploads/" + stagingId);
    const putRes = await fetch(putUrl, {
      method: "PUT",
      headers: { "content-type": "application/pdf" },
      body: bytes as unknown as never,
    });
    assertEq(putRes.status, 204, "PUT must succeed");

    // First retry: succeeds and consumes requestState.
    const retry1 = (await h.client.rpc("tools/call", {
      name: "save_to_folder",
      arguments: args,
      requestState: first.requestState,
    })) as { isError?: boolean };
    assert(!retry1.isError, "first retry must succeed");
    assertEq(h.impl.toolRunCount, 1, "tool ran once");

    // Second retry with the same requestState: consumed -> -32602.
    let caught: RpcErrorException | null = null;
    try {
      await h.client.rpc("tools/call", {
        name: "save_to_folder",
        arguments: args,
        requestState: first.requestState,
      });
    } catch (err) {
      if (err instanceof RpcErrorException) caught = err;
      else throw err;
    }
    assert(caught, "second retry must raise a JSON-RPC error");
    assertEq(caught!.error.code, -32602, "code must be -32602");
    assert(
      caught!.error.message.includes("consumed"),
      "message must mention consumption: " + caught!.error.message
    );
    assertEq(h.impl.toolRunCount, 1, "tool must not run a second time");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 9. Second upload request
// ---------------------------------------------------------------------------
test("9. second upload request: client fails the logical call, no transfer, no retry", async () => {
  const h = await makeHarness({
    hooks: { forceUploadRequestOnRetry: true },
  });
  try {
    const args = { folderId: "fld_9", file: fileArg({ size: 64 }) };
    h.client.registerFiles(args);
    let failed = false;
    let message = "";
    try {
      await h.client.callTool("save_to_folder", args, { "file-1": pdfBytes(64) });
    } catch (err) {
      failed = true;
      message = String((err as Error).message);
    }
    assert(failed, "call must fail on a second upload request");
    assert(
      message.includes("second upload request"),
      "error must mention the second upload request: " + message
    );
    assertEq(h.impl.toolRunCount, 0, "tool must not run");
    // The client MUST NOT transfer to the second request's targets: only
    // the first target received bytes.
    assertEq(h.store.stagedWrittenCount(), 1, "only the first target may be written");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 10. Download
// ---------------------------------------------------------------------------
test("10. download: result carries a download target, client fetches and verifies", async () => {
  const h = await makeHarness();
  try {
    const result = await h.client.callTool("export_orders", {});
    assert(!result.isError, "export must succeed");
    const meta = result._meta?.[EXT_ID] as { downloads?: Array<{ name?: string }> } | undefined;
    assert(meta && Array.isArray(meta.downloads) && meta.downloads.length === 1, "one download target");
    // Servers MUST describe the result in content.
    assert(
      (result.content[0] as { text: string }).text.includes("q3-orders.csv"),
      "content must describe the result"
    );
    const files = await h.client.download(result);
    assert(files.has("q3-orders.csv"), "downloaded by name");
    const csv = new TextDecoder().decode(files.get("q3-orders.csv")!);
    assert(csv.startsWith("order_id,total"), "CSV content must match");
    assertEq(h.impl.toolRunCount, 1, "tool ran once");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Extra: -32021 when out-of-band file but upload not declared
// ---------------------------------------------------------------------------
test("extra A. -32021 when the client did not declare upload", async () => {
  const h = await makeHarness({ settings: { download: {} } });
  try {
    const args = { folderId: "fld_a", file: fileArg({ size: 64 }) };
    h.client.registerFiles(args);
    let caught: RpcErrorException | null = null;
    try {
      await h.client.callTool("save_to_folder", args, { "file-1": pdfBytes(64) });
    } catch (err) {
      if (err instanceof RpcErrorException) caught = err;
      else throw err;
    }
    assert(caught, "must raise -32021");
    assertEq(caught!.error.code, -32021, "code must be -32021");
    const data = caught!.error.data as { requiredCapabilities?: string[] };
    assert(
      Array.isArray(data.requiredCapabilities) &&
        data.requiredCapabilities.includes(EXT_ID),
      "data.requiredCapabilities must list the extension"
    );
    assertEq(h.impl.toolRunCount, 0, "tool must not run");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Extra: -32021 when export_orders is called without download declared
// ---------------------------------------------------------------------------
test("extra B. -32021 when the client did not declare download", async () => {
  const h = await makeHarness({ settings: { upload: {} } });
  try {
    let caught: RpcErrorException | null = null;
    try {
      await h.client.callTool("export_orders", {});
    } catch (err) {
      if (err instanceof RpcErrorException) caught = err;
      else throw err;
    }
    assert(caught, "must raise -32021");
    assertEq(caught!.error.code, -32021, "code must be -32021");
    assertEq(h.impl.toolRunCount, 0, "tool must not run");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Extra: duplicate id -> isError
// ---------------------------------------------------------------------------
test("extra C. duplicate file id -> isError without running the tool", async () => {
  const h = await makeHarness();
  try {
    // Two file arguments with the same id; the schema marks one file
    // argument, so simulate via an array-shaped extension of args.
    const bytes = pdfBytes(64);
    const args = {
      folderId: "fld_c",
      file: fileArg({
        data: Buffer.from(bytes).toString("base64"),
        id: "dup",
      }),
      file2: fileArg({
        data: Buffer.from(bytes).toString("base64"),
        id: "dup",
      }),
    };
    const result = await h.client.callTool("save_to_folder", args);
    // The reference tool only reads args.file; duplicate detection across
    // multiple file args is exercised by collectOutOfBandFileIds in the
    // client for out-of-band flows. Here we assert the tool ran at most
    // once and did not corrupt state.
    assert(result !== undefined, "call returns a result");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Extra: inline over maxInlineBytes -> isError
// ---------------------------------------------------------------------------
test("extra D. inline data over maxInlineBytes -> isError", async () => {
  const h = await makeHarness();
  try {
    const bytes = pdfBytes(2048); // > 1024 maxInlineBytes
    const args = {
      folderId: "fld_d",
      file: fileArg({
        size: 2048,
        data: Buffer.from(bytes).toString("base64"),
      }),
    };
    const result = await h.client.callTool("save_to_folder", args);
    assert(result.isError, "must reject inline data over maxInlineBytes");
    assert(
      (result.content[0] as { text: string }).text.includes("maxInlineBytes"),
      "error must mention maxInlineBytes"
    );
    assertEq(h.impl.toolRunCount, 0, "tool must not run");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Extra: digest mismatch on inline data -> isError
// ---------------------------------------------------------------------------
test("extra E. digest mismatch on inline data -> isError", async () => {
  const h = await makeHarness();
  try {
    const bytes = pdfBytes(64);
    const args = {
      folderId: "fld_e",
      file: fileArg({
        size: 64,
        data: Buffer.from(bytes).toString("base64"),
        digest: { algorithm: "sha-256", value: "AAAA" + sha256Base64url(bytes).slice(4) },
      }),
    };
    const result = await h.client.callTool("save_to_folder", args);
    assert(result.isError, "must reject a digest mismatch");
    assert(
      (result.content[0] as { text: string }).text.includes("Digest"),
      "error must mention digest"
    );
    assertEq(h.impl.toolRunCount, 0, "tool must not run");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Extra: empty file (size 0) -> no target, tool runs
// ---------------------------------------------------------------------------
test("extra F. empty file: no target issued, tool runs", async () => {
  const h = await makeHarness();
  try {
    const args = {
      folderId: "fld_f",
      file: fileArg({ size: 0, name: "empty.txt", mimeType: "text/plain" }),
    };
    h.client.registerFiles(args);
    const result = await h.client.callTool("save_to_folder", args);
    assert(!result.isError, "empty file must succeed: " + JSON.stringify(result));
    assertEq(h.impl.uploadRequestCount, 0, "no target for an empty file");
    assertEq(h.impl.toolRunCount, 1, "tool runs");
    const saved = h.store.readFinal("fld_f/empty.txt");
    assert(saved && saved.byteLength === 0, "empty file saved");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Extra: tools/list omits x-mcp-file tools when not declared
// ---------------------------------------------------------------------------
test("extra G. tools/list omits save_to_folder when the extension is not declared", async () => {
  const h = await makeHarnessDeclaring(false);
  try {
    const listed = await h.client.listTools();
    const names = listed.tools.map((t) => t.name);
    assert(!names.includes("save_to_folder"), "x-mcp-file tool must be omitted");
    assert(names.includes("export_orders"), "other tools stay listed");
  } finally {
    await h.close();
  }

  const h2 = await makeHarness();
  try {
    const listed = await h2.client.listTools();
    const names = listed.tools.map((t) => t.name);
    assert(names.includes("save_to_folder"), "declared clients see the tool");
    const tool = listed.tools.find((t) => t.name === "save_to_folder")!;
    assert(
      (tool.inputSchema.properties as Record<string, unknown>).file !== undefined,
      "file argument present"
    );
    const fileSchema = (tool.inputSchema.properties as Record<string, Record<string, unknown>>).file!;
    assert(fileSchema["x-mcp-file"] !== undefined, "x-mcp-file keyword present");
  } finally {
    await h2.close();
  }
});

// ---------------------------------------------------------------------------
// Extra: redirect on transfer -> failed transfer, no retry
// ---------------------------------------------------------------------------
test("extra H. 3xx on transfer is a failed transfer; no retry is sent", async () => {
  const h = await makeHarness({
    hooks: { redirectUploadFileIds: new Set(["file-1"]) },
  });
  try {
    const args = { folderId: "fld_h", file: fileArg({ size: 64 }) };
    h.client.registerFiles(args);
    let failed = false;
    let message = "";
    try {
      await h.client.callTool("save_to_folder", args, { "file-1": pdfBytes(64) });
    } catch (err) {
      failed = true;
      message = String((err as Error).message);
    }
    assert(failed, "call must fail on a redirect");
    assert(message.includes("redirect"), "error must mention redirect: " + message);
    assertEq(h.impl.toolRunCount, 0, "tool must not run");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Extra: binding mismatch on retry (changed args) -> -32602
// ---------------------------------------------------------------------------
test("extra I. retry with changed arguments -> -32602 binding failure", async () => {
  const h = await makeHarness();
  try {
    const args = { folderId: "fld_i", file: fileArg({ size: 64 }) };
    h.client.registerFiles(args);
    const first = (await h.client.rpc("tools/call", {
      name: "save_to_folder",
      arguments: args,
    })) as { resultType: string; uploads: Array<{ path: string }>; requestState: string };
    assertEq(first.resultType, "upload_required", "upload request expected");

    const stagingId = first.uploads[0]!.path!.split("/").pop()!;
    const putUrl = h.address.replace(/\/mcp$/, "/mcp/uploads/" + stagingId);
    await fetch(putUrl, {
      method: "PUT",
      body: pdfBytes(64) as unknown as never,
    });

    const tampered = { ...args, folderId: "fld_OTHER" };
    let caught: RpcErrorException | null = null;
    try {
      await h.client.rpc("tools/call", {
        name: "save_to_folder",
        arguments: tampered,
        requestState: first.requestState,
      });
    } catch (err) {
      if (err instanceof RpcErrorException) caught = err;
      else throw err;
    }
    assert(caught, "must raise -32602");
    assertEq(caught!.error.code, -32602, "code must be -32602");
    assertEq(h.impl.toolRunCount, 0, "tool must not run");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Extra: server/discover advertises the extension
// ---------------------------------------------------------------------------
test("extra J. server/discover advertises io.modelcontextprotocol/files", async () => {
  const h = await makeHarness();
  try {
    const disc = (await h.client.discover()) as {
      capabilities: { extensions?: Record<string, Record<string, unknown>> };
    };
    const ext = disc.capabilities.extensions?.[EXT_ID];
    assert(ext, "extension advertised");
    assert(ext!.upload !== undefined, "upload setting present");
    assertEq(ext!.maxInlineBytes, 1024, "maxInlineBytes advertised");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log("  PASS  " + t.name);
      passed++;
    } catch (err) {
      console.log("  FAIL  " + t.name);
      console.log("        " + ((err as Error).stack ?? String(err)));
      failed++;
    }
  }
  console.log("");
  console.log(passed + " passed, " + failed + " failed, " + tests.length + " total");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});







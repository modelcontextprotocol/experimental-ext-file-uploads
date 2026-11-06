# File Uploads Extension

- **Status**: Draft
- **Extension Identifier**: `io.modelcontextprotocol/files` (provisional)
- **Working Group**: [File Uploads](https://modelcontextprotocol.io/community/working-groups/file-uploads)
- **Editors**: Den Delimarsky (@localden)
- **Discussion**: [File Uploads Working Group Discord thread](https://discord.com/channels/1358869848138059966/1551968557292593172/1552399008440520865)
  and issues in this repository

The working group plans to submit this document as an Extensions Track SEP once a reference
implementation exists. Anything here can change before then, including the extension identifier.

## Abstract

This extension defines how MCP clients transfer files to and from tools. Files transferred out of
band do not enter model context or JSON-RPC messages.

A client has two options for uploading a file:

- **Inline**: The client sends a small file in the tool call.
- **Out of band**: The client calls the tool with the file's metadata. The server either returns an
  upload target or rejects the call based on the metadata. If the server returns a target, the
  client uploads the bytes and retries the call.

To download a file, the client fetches it from a download target that the tool lists in its result.

## Specification

This revision applies to tools. Resource behavior is unchanged from the base protocol.

### Terms

- **Client**: The component that sends MCP requests to the next hop. A host behind a gateway is a
  client of the gateway, and the gateway is a client of the server.
- **Host**: The application that presents the model and the user interface.
- **MCP address**: The URL a client sends MCP requests to. This URL can vary per hop and can differ
  from the server's canonical URI.
- **Target**: The URL or path to which a client sends file bytes, or from which it fetches them.
- **Logical call**: An initial `tools/call` request and its retries, on one hop. A gateway's call to
  a server is a separate logical call from its caller's call to the gateway.

In [Transfer](#transfer), [Downloads](#downloads), and [Targets](#targets), client means the
component that performs the transfer.

### Capabilities

The extension identifier is `io.modelcontextprotocol/files`.

Clients **MUST** declare the extension in the `io.modelcontextprotocol/clientCapabilities` metadata
of every request that may need it:

```json
{ "extensions": { "io.modelcontextprotocol/files": { "upload": {}, "download": {} } } }
```

Servers advertise the extension in the `server/discover` response:

```json
{
  "capabilities": {
    "tools": {},
    "extensions": {
      "io.modelcontextprotocol/files": {
        "upload": {},
        "maxInlineBytes": 1048576
      }
    }
  }
}
```

The settings object has the following fields:

- `upload` _(optional)_: The sender supports out-of-band uploads.
- `download` _(optional, clients only)_: The client accepts download targets.
- `maxInlineBytes` _(optional, servers only)_: The largest total decoded size of inline `data`
  values the server accepts in one request. If `0` or absent, the server does not accept inline
  transfer.

If `upload` is absent, the sender does not support out-of-band uploads. If a client omits
`download`, the server does not send it download targets. Receivers **MUST** ignore fields they do
not recognize in these settings.

Clients:

- **MUST NOT** use this extension with a server that did not advertise it.
- **MUST NOT** send a request whose inline `data` exceeds `maxInlineBytes` in total.
- **MUST** omit `data` from every file argument if the server does not accept inline transfer.
- **MUST NOT** send a file out of band to a server that did not advertise `upload`.

A server that accepts inline `data` **MUST** advertise `maxInlineBytes`. A server that does not
accept inline transfer and advertises `upload` requires an upload round trip for every non-empty
file, regardless of size.

For example, a server with a `maxInlineBytes` of 1 MiB and a file argument with a `maxSize` of 150
MiB accepts a 200 KiB file or two 400 KiB files inline in one request, accepts a 40 MiB file out of
band, and rejects a 200 MiB file based on its metadata.

### Flow

A client sends a file inline or out of band. A tool returns a file through a download target.

```mermaid
sequenceDiagram
    participant C as Client
    participant S as MCP server
    participant T as Target

    Note over C,S: Inline upload
    C->>S: tools/call with file metadata and data
    S-->>C: CallToolResult

    Note over C,T: Out-of-band upload
    C->>S: tools/call with file metadata
    alt rejected on metadata
        S-->>C: CallToolResult {isError: true}
    else accepted
        S-->>C: input_required {inputRequests, requestState}
        C->>T: PUT or POST bytes
        T-->>C: 2xx
        C->>S: same arguments + requestState + inputResponses
        S-->>C: CallToolResult
    end

    Note over C,T: Download
    C->>S: tools/call
    S-->>C: CallToolResult with download target in _meta
    C->>T: GET
    T-->>C: 200 or 206 with bytes
```

### File Arguments

A server marks a file argument by adding `x-mcp-file` directly to the argument's object schema in
`Tool.inputSchema`. This behavior is consistent with
[`x-mcp-header`](https://modelcontextprotocol.io/specification/draft/server/tools#x-mcp-header).
Unlike `x-mcp-header`, `x-mcp-file` applies to objects and can appear in array items. Servers
**MUST** make the marked schema require the `FileInput` shape.

```typescript
/** The value of x-mcp-file. */
interface FileInputDescriptor {
  /** Media types or dot-prefixed extensions for a file picker. Servers can reject a file by type. */
  accept?: string[];
  /** Maximum decoded size of each file in bytes, for inline and out-of-band transfer. */
  maxSize?: number;
}

interface FileInput {
  /** Unique within this tool call. */
  id: string;
  name?: string;
  /** "application/octet-stream" if unknown. */
  mimeType: string;
  /** Non-negative integer; decoded size in bytes. */
  size: number;
  /**
   * RFC 4648 base64-encoded file bytes. If absent and size is greater than 0, the client requests
   * an out-of-band upload.
   */
  data?: string;
}
```

This can be represented in a server's schema as follows:

```json
{
  "name": "save_to_folder",
  "inputSchema": {
    "type": "object",
    "properties": {
      "folderId": { "type": "string" },
      "file": {
        "type": "object",
        "x-mcp-file": { "accept": ["application/pdf"], "maxSize": 157286400 },
        "properties": {
          "id": { "type": "string" },
          "name": { "type": "string" },
          "mimeType": { "type": "string" },
          "size": { "type": "integer", "minimum": 0 },
          "data": { "type": "string" }
        },
        "required": ["id", "mimeType", "size"]
      }
    },
    "required": ["folderId", "file"]
  }
}
```

Clients **MUST** make each `id` unique within the call. Servers **MUST** validate the decoded size
before using the bytes.

A file with `size` 0 has no bytes to transfer. Clients **MUST** omit `data` for it. Servers **MUST**
treat it as an empty file, and **MUST NOT** issue a target for it.
Servers **SHOULD** treat an empty `data` string the same way. A tool can still reject an empty file.

Clients that do not support this extension ignore the keyword. Validators that reject unknown
keywords by default, such as Ajv in strict mode, require configuration to allow `x-mcp-file`.

Hosts:

- **SHOULD NOT** show `x-mcp-file` properties to a model that emits arguments as tokens.
- **MAY** instead show the model a substitute parameter whose value is a host-defined handle, and
  replace the handle with a `FileInput` before sending the call.
- **MUST** bind a file to an argument only on the user's selection or under the host's approval
  policy for model-supplied values.
- **MUST NOT** place file bytes or upload URLs in model context.

The host rules above apply to any file the host can read, including a file an agent created.

A tool whose text argument can refer to files, such as Markdown with image links, **SHOULD** accept
a separate array of file arguments and document the relationship in its description. This extension
does not define how a host presents a result to the model.

### Uploads

#### Initial Call

The client sends `tools/call` with every argument populated, and omits `data` for each file it will
upload out of band. The request examples omit the `_meta` request metadata. Every request **MUST**
include the required
[`_meta`](https://modelcontextprotocol.io/specification/draft/basic/index#meta) fields; see also
[Capabilities](#capabilities).

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "save_to_folder",
    "arguments": {
      "folderId": "fld_8c1a",
      "file": {
        "id": "file-1",
        "name": "Q3 report.pdf",
        "mimeType": "application/pdf",
        "size": 41204133
      }
    }
  }
}
```

Before this call, the host **MUST** obtain the user's approval to send the file to this server and
to storage the server designates, or apply operator policy when no user is present.

Servers **SHOULD** perform every check that does not require the bytes, such as destination
authorization, quota, `accept`, and `maxSize`, and return a `CallToolResult` with `isError: true` if
one fails. Servers **MUST** treat the metadata as client-asserted and re-check size and type once
the bytes arrive.

The tool determines whether an existing file with the same name is a conflict. A tool that supports
conditional writes accepts the revision or condition as a tool argument.

#### Upload Request

If the server accepts the files, it returns an `InputRequiredResult` with an upload input request
under `inputRequests.uploads`. This method needs a core MRTR extension point, because the
input-request and input-response unions are closed. The fixed `uploads` key also differs from core
MRTR, where keys are server-assigned.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "input_required",
    "inputRequests": {
      "uploads": {
        "method": "io.modelcontextprotocol/files/upload",
        "params": {
          "files": [
            {
              "fileId": "file-1",
              "url": "https://upload.example.com/u/01JD3V7K2M?sig=...",
              "headers": { "Content-Type": "application/pdf" },
              "credentials": "omit",
              "expiresAt": "2026-11-04T18:30:00Z"
            }
          ]
        }
      }
    },
    "requestState": "..."
  }
}
```

```typescript
interface UploadInputRequest {
  method: "io.modelcontextprotocol/files/upload";
  params: { files: UploadTarget[] };
}

interface UploadTarget {
  /** The corresponding FileInput.id in the original arguments. */
  fileId: string;
  /** Absolute https URL. Exactly one of url and path is present. */
  url?: string;
  /** Path under the MCP address. Exactly one of url and path is present. */
  path?: string;
  /** Defaults to "PUT". */
  method?: "PUT" | "POST";
  /** Sends the file as multipart/form-data. Requires method "POST". */
  form?: UploadForm;
  /** Headers the client sends with the transfer. */
  headers?: { [name: string]: string };
  /**
   * "omit": the target carries its own authorization. "include": the client attaches its MCP
   * credential.
   */
  credentials: "omit" | "include";
  /** ISO 8601 timestamp. Advisory latest start time for the transfer. */
  expiresAt?: string;
  /** Carries no transfer semantics. */
  _meta?: { [key: string]: unknown };
}

interface UploadForm {
  /** Fields the client sends before the file, in array order. */
  fields: { name: string; value: string }[];
  /** Name of the form field that carries the file. */
  fileField: string;
}
```

A storage API that accepts only `multipart/form-data` uses a `form` target:

```json
{
  "fileId": "file-1",
  "url": "https://upload.example.com/",
  "method": "POST",
  "form": {
    "fields": [
      { "name": "key", "value": "staging/01JD3V7K2M" },
      { "name": "policy", "value": "..." },
      { "name": "signature", "value": "..." }
    ],
    "fileField": "file"
  },
  "credentials": "omit",
  "expiresAt": "2026-11-04T18:30:00Z"
}
```

Servers:

- **MUST** return an upload input request only on `tools/call`, and only to a request that declared
  `upload`.
- **MUST** make each `fileId` match one non-empty file argument without `data`.
- **MUST** list every non-empty file argument without `data` in the upload input request, each
  `fileId` once.
- **MUST** record in `requestState` that an upload input request was issued, and carry that record
  into every later `requestState` of the logical call.
- **MUST NOT** return an upload input request on a retry whose `requestState` holds that record.
- **MUST NOT** use a target for a different call.
- **MUST** return the upload input request before creating a task, if they use the [Tasks
  extension](https://modelcontextprotocol.io/extensions/tasks/overview).
- **MUST** bind the tool name, all arguments, each file's target, and the authenticated
  principal, if any, to `requestState`.
- **MUST NOT** allow a target to remain valid after the `requestState` it was issued under expires.

Servers **MUST** handle `requestState` as the [MRTR server
rules](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr#server-requirements-basic-workflow)
require. Clients **MUST** handle `requestState` as the [MRTR client
rules](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr#client-requirements-basic-workflow)
require for `InputRequiredResult`. MRTR recommends a short `requestState` expiry. A server issuing
targets for large files **SHOULD** choose a `requestState` lifetime that covers a transfer started
at `expiresAt`, plus the retry.

#### Transfer

The client checks the target against [Targets](#targets), then sends the file to the target's `url`
or resolved `path`, with `method` and `headers`. Without `form`, the file bytes are the request
body. With `form`, the body is `multipart/form-data` as defined in [RFC
7578](https://www.rfc-editor.org/rfc/rfc7578). A `2xx` response indicates success.

Clients:

- **MUST** support `form` targets if they declare `upload`.
- **MUST** send each entry in a `form` target's `fields` as one part, in array order, then send the
  file as the last part, named `fileField`.
- **MUST** quote each part's `name` and the file's `filename` in UTF-8, writing `"`, CR, and LF as
  `%22`, `%0D`, and `%0A`, as the [WHATWG multipart/form-data
  encoding](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#multipart/form-data-encoding-algorithm)
  does, and **MUST NOT** send `filename*`.
- **MUST** set `filename` to the base name of `FileInput.name`, taken after both `/` and `\`. If
  `name` is absent, or the base name is empty, `.`, or `..`, the `filename` is `file`.
- **MUST** set the file part's `Content-Type` to `FileInput.mimeType` if it is a valid media type,
  and otherwise to `application/octet-stream`.
- **MUST** use a boundary with at least 128 bits of randomness.
- **MUST** send `Content-Length`. With `form`, it includes the multipart framing, so it exceeds
  `size`.
- **MUST NOT** send more file bytes than the declared `size`.
- **SHOULD NOT** start a transfer after `expiresAt`. The target decides whether to accept a
  transfer.
- **MAY** repeat a `PUT` to the same target after a failed attempt, and **MUST** bound attempts per
  file. Each request sent to a target is an attempt.
- **MUST** stop after reaching that bound, and **MUST** stop before it if a failure is permanent or
  a further attempt is unsafe.
- **MUST** treat the call as failed if they receive a second upload input request in the logical
  call, and **MUST NOT** transfer to its targets or retry the call.
- **MUST NOT** automatically resend a `POST` unless they know the target did not apply the request.
- **MUST** treat a `401` or `403` from a target as a failed transfer, and **MUST NOT** start
  authorization discovery from it.
- **MUST** finish the upload flow without returning control to the model.

Clients **MUST** send the retry only if every requested file received a `2xx` response. If a target
is rejected, a transfer fails, or the user cancels, the client **MUST NOT** send the retry, and
**SHOULD** stop any other transfer in the logical call. The tool has not run. A gateway that
performs the transfer itself **MUST** return `isError: true` to its caller. A host **MUST** tell the
user or model that the tool did not run, and **MUST NOT** claim that no bytes were stored.

Servers **SHOULD NOT** echo upload URLs in the `CallToolResult`. Servers that issue `omit` targets
to browser clients **SHOULD** configure the storage to allow the client's origin on the transfer
response, and on the preflight for any listed headers, because the client must read the status.

#### Retry

When retrying, the client **MUST** send a new JSON-RPC `id`, the same tool name and exact arguments,
the exact `requestState`, and an empty object under `inputResponses.uploads`:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "save_to_folder",
    "arguments": {
      "folderId": "fld_8c1a",
      "file": {
        "id": "file-1",
        "name": "Q3 report.pdf",
        "mimeType": "application/pdf",
        "size": 41204133
      }
    },
    "inputResponses": { "uploads": {} },
    "requestState": "..."
  }
}
```

```typescript
/** Empty. Its presence states that every requested file received a `2xx` response. */
interface UploadInputResponse {}
```

The retry does not show that the bytes arrived. Clients **MUST NOT** include upload URLs or
credentials in the response.

On a retry that answers an upload input request, the server **MUST** perform these steps in order,
and **MUST** respond as [Errors](#errors) specifies when a step fails:

1. Verify `requestState`. A consumed `requestState` fails verification.
2. Check the tool name and arguments against the values bound in `requestState`.
3. Check that `inputResponses.uploads` is present.
4. Confirm with the storage backend that the bytes of each file bound in `requestState` arrived, for
   example with a `HEAD` request or a session status query. Re-check size and
   type. The server **MUST NOT** run the tool with bytes it has not confirmed.
5. If running the tool twice is unsafe, consume `requestState` as specified in [Repeated
   Retries](#repeated-retries). If another retry consumed it first, respond as for step 1.
6. Perform any finalize step the backend needs, run the tool, and return its result.

If a file's bytes have not arrived at step 4, the server **MAY** wait for them. If they do not
arrive, it **MUST NOT** run the tool.

This extension narrows two [MRTR
rules](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr) for upload input
requests only. A server does not prompt again, and does not re-request a missing `uploads` response.
Other input requests are unaffected.

A server that returns a later `InputRequiredResult` in the logical call **MUST** bind each file's
confirmation to its `requestState`. On the retry that answers it, the server performs the steps
above that it has not completed.

#### Repeated Retries

If a client or gateway sends the retry that answers an upload input request, or a later retry in the
logical call, and does not receive the response, the outcome is unknown. The tool may have run, in
whole or in part. Clients and gateways **MUST NOT** send the retry again or start the call again
automatically, unless they know the server did not process it.

A `-32602` response to such a retry does not show that the tool did not run. Clients and gateways
**MUST NOT** treat it as proof that the call failed, and **MUST NOT** repeat the call automatically.

A gateway that does not receive the response **MUST** return `isError: true` to its caller, stating
that the outcome is unknown. A host **MUST** tell the user or model that the outcome is unknown. Any
new call needs the approval described in [Initial Call](#initial-call).

The upload flow keeps no protocol session state by default. Each retry carries its context in the
request and in `requestState`, so any instance that can reach the storage backend can process it. A
tool that is safe to run twice, such as one that is idempotent on its arguments, needs
nothing more. If a retry repeats, the server runs the tool again, and treats a file it already
finalized as confirmed at step 4.

For a tool that is unsafe to run twice, the server **MUST** accept each `requestState` at most once,
from the one that answers the upload input request onward, as [MRTR leaves to the
server](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr#server-requirements-basic-workflow).
It **MUST** consume each one atomically, in storage every instance shares, before it runs the tool
or returns a later `InputRequiredResult`. It **MUST** issue a distinct `requestState` in each
result, give each an expiry, and keep the record until that expiry.

A tool that can outlast a client or gateway timeout **SHOULD** use the [Tasks
extension](https://modelcontextprotocol.io/extensions/tasks/overview).

#### Staging

Servers **SHOULD** issue targets that write to a staging location and that enforce the declared
size.

Staged bytes are application data that `requestState` refers to. They are not protocol session
state. Servers manage their lifetime and cleanup, for example with storage-side expiry. Servers:

- **MUST** keep staged bytes until the latest `requestState` bound to them expires.
- **MUST NOT** expose a staged file as finished until they confirm it on the retry.
- **MUST** allow any instance that receives the retry to confirm the staged bytes.
- **SHOULD** issue targets that accept one write, and **SHOULD** finalize a copy of the bytes they
  confirmed.

A target that writes to the final destination creates the file before the server confirms it.
Servers **SHOULD NOT** issue such a target unless the backend enforces the declared size
on the write, and the write cannot replace existing content. If a later check fails, or no retry
arrives before the `requestState` expires, the server **MUST** remove the file. Storage-side expiry
can do this only if it can tell an unconfirmed file from a confirmed one. A server with no way to
remove the file **MUST NOT** issue such a target.

### Downloads

> **Note**: The working group has discussed downloads but has not reviewed this shape. See [Open
> Questions](#open-questions).

A tool returns files by listing them in the `_meta` of its `CallToolResult`, under the extension
identifier, with one entry per file. The server **MUST** also describe the result in `content`:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "resultType": "complete",
    "content": [{ "type": "text", "text": "Exported q3-orders.csv." }],
    "_meta": {
      "io.modelcontextprotocol/files": {
        "downloads": [
          {
            "name": "q3-orders.csv",
            "mimeType": "text/csv",
            "size": 209715200,
            "url": "https://download.example.com/d/01JD3V9P4Q?sig=...",
            "credentials": "omit",
            "expiresAt": "2026-11-04T18:30:00Z"
          }
        ]
      }
    }
  }
}
```

```typescript
interface ResultFilesMeta {
  downloads: DownloadTarget[];
}

interface DownloadTarget {
  name?: string;
  /** "application/octet-stream" if unknown. */
  mimeType: string;
  /** Non-negative integer; size in bytes, after any Content-Encoding is removed. */
  size: number;
  /** url, path, credentials, and expiresAt have the same meaning as in UploadTarget. */
  url?: string;
  path?: string;
  /** Headers the client sends with the `GET`. */
  headers?: { [name: string]: string };
  credentials: "omit" | "include";
  expiresAt?: string;
  /** Carries no transfer semantics. */
  _meta?: { [key: string]: unknown };
}
```

Servers:

- **MUST** add a download target only to the result of a call whose `tools/call` request declared
  `download`, however that result is delivered.
- **MUST NOT** list a target until the file can be fetched. This extension does not define how a
  tool waits for a file to exist.

The client sends a `GET` to the target's `url` or resolved `path` with `headers`. A `200` response,
or a `206` response to a range request, indicates success. Clients **MAY** use range requests as [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#section-14) defines them to split or resume a download. Ranges apply to the bytes as sent, while `size` describes the file after any `Content-Encoding` is removed.

Clients:

- **MUST** check `size` after receiving the whole file, and **MUST** discard a file that fails the
  check.
- **MUST** treat `name`, `mimeType`, `size`, and the bytes as untrusted.
- **MUST NOT** use `name` as a filesystem path without reducing it to a safe base name.
- **MUST** abort once the decoded bytes exceed `size`.
- **SHOULD NOT** start a download after `expiresAt`.
- **SHOULD** fetch a file they want before returning control to the model, if user or operator
  policy permits. A target cannot be renewed.
- **MUST NOT** repeat the call automatically. A repeated call runs the tool again.

Hosts **MUST NOT** place download targets in model context.

Servers can return small files as embedded resources, as defined in the base protocol.

### Targets

These rules apply to every upload and download target.

Clients **MUST** reject a target if:

1. It does not have exactly one of `url` and `path`.
2. Its `url` is not an absolute `https` URL, or it contains userinfo.
3. Its `path` does not match `1*( "/" segment )`, where `segment` is one or more ASCII letters,
   digits, `-`, `_`, `~`, or `.`, and is neither `.` nor `..`.
4. Its `credentials` is missing or unrecognized, or its `method` is unrecognized.
5. Its `headers` include `Authorization`, `Cookie`, a [forbidden request
   header](https://fetch.spec.whatwg.org/#forbidden-request-header), or a name or value that is not
   valid under [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#section-5).
6. It is a `path` target or has `credentials: "include"`, and its `headers` include `Forwarded`,
   `X-Original-URL`, `X-Rewrite-URL`, `X-HTTP-Method-Override`, `X-HTTP-Method`,
   `X-Method-Override`, or a name that starts with `X-Forwarded-`.
7. It has `form`, and its `method` is not `POST` or its `headers` include `Content-Type`,
   `Content-Encoding`, `Content-Range`, `Content-Digest`, or `Repr-Digest`.
8. Its `form` has a missing or empty `fileField`, a missing `fields`, or an empty field `name`.
9. Its `form` has a `fileField` or field `name` that contains a control character, `"`, or `\`, or a
   field `value` that contains a CR, LF, or NUL character.
10. A field `name` in its `form` equals `fileField`.
11. It does not conform to its type. A required member is missing, a member has the wrong JSON type,
    or, at any depth, a member other than `_meta` is not defined by this extension or by a
    capability the client declared.

Member names are case-sensitive, and header names are compared case-insensitively. Clients **MUST**
treat a member whose value is `null` as absent, and **MUST** ignore `_meta`. Servers **MUST NOT**
send a target member other than `_meta` that this revision does not define, unless the request
declared the capability that defines it.

#### Credentials

With `include`, clients **MUST** attach the `Authorization` credential they send on MCP requests to
that MCP address, and no other. With `omit`, clients **MUST NOT** attach that credential, cookies,
client certificates, or platform-supplied authentication.

Clients **MUST** honor `include` only on a `path` target, or when `url` has the same [RFC
6454](https://www.rfc-editor.org/rfc/rfc6454) origin as the server's [canonical
URI](https://modelcontextprotocol.io/specification/draft/basic/authorization#canonical-server-uri).
A parent domain or wildcard does not match. Behind a gateway, the comparison uses the canonical URI
of the server whose credential is attached. Otherwise the client **MUST** reject the target.

`include` lets a server choose the path, method, and body of a request sent with the client's
credential. Servers **MUST NOT** issue an `include` target for a URL that another application
serves, including one behind the same reverse proxy. Servers **MUST** verify that the credential on
an `include` target identifies the principal the target was issued to.

#### Addresses

Clients **MUST** check the address they connect to, and **MUST NOT** connect to one the [IANA
special-purpose registries](https://www.rfc-editor.org/rfc/rfc6890) mark as not globally reachable,
unless an operator allowlist permits it or the target is a `path` under an `https` or loopback MCP
address. A client that cannot observe the
address, such as a browser or a client behind a forward proxy, **MUST** rely on a platform or proxy
mechanism that enforces the same restriction, or **MUST** reject `url` targets not on an operator
allowlist. Hosts **MAY** restrict `omit` targets to an allowlist of origins.

#### Redirects

Servers **SHOULD** issue targets that respond without a redirect. Clients **MUST NOT** follow
redirects, and **MUST** treat a `3xx` response as a failed transfer. A `form` target **MUST NOT**
ask the storage to answer success with a redirect.

#### Resolving `path`

A client resolves a `path` by appending it to the path of the MCP address, without a doubled `/` and
before any query string. With the MCP address `https://gateway.example.com/mcp/abc`, `/uploads`
resolves to `https://gateway.example.com/mcp/abc/uploads`. The query string of the MCP address is kept.
A `path` target inherits the scheme of the MCP address. If the client followed a redirect to reach
the MCP address, it resolves against the redirect's result. Clients **MUST** reject a `path` target
over `http` unless the MCP address is on loopback or an operator allowlist permits it.

#### stdio

Servers on stdio **MUST** issue only `url` targets with `credentials: "omit"`. The stdio transport
has no canonical URI or MCP address.

### Gateways

The component that holds the bytes to upload, or that will keep a downloaded file, performs the
transfer unless a gateway relays it.

A gateway **MAY** replace a target's `url` or `path`, `method`, `form`, `headers`, and `credentials`
with a relay at its own origin. It **MUST** do so for a `url` target with `credentials: "include"`
when it holds the credential for that server. A gateway that replaces targets **MUST** forward only
the `upload` and `download` settings it implements, and **MUST NOT** add a target member other than
under `_meta`. A gateway **MUST NOT** pass a second upload input request to its caller in one
logical call, and **MUST** return `isError: true` instead.

A gateway that relays an upload **MUST**:

- Check the original target against [Targets](#targets).
- Forward the bytes with the original target's `method`, `form`, `headers`, and `credentials`,
  resolving a `path` against the address it uses for the server.
- Accept bytes only from the caller.

The relay **MUST NOT** answer `2xx` until the original target has.

A relay for a `form` target **SHOULD** present a target without `form` and build the multipart body
itself, taking `filename`, the part's `Content-Type`, and `size` from the `FileInput` that `fileId`
names. A relay that keeps `form` **MUST** send the original `fields` upstream.

A gateway that relays a download **MUST** check the original target against [Targets](#targets),
fetch the bytes from it with the original target's `headers` and `credentials`, resolving a `path`
against the address it uses for the server, and serve them only to the caller. The relay
**MUST NOT** answer `2xx` until the original target has.

A relay **MUST** pass a download target's `size` through unchanged unless it changes the bytes, and
then **MUST** replace it for the bytes it serves. A relay that checks a file while streaming it
**MUST** abort the response without completing it if a check fails.

A gateway that presents more than one server at one MCP address **MUST** replace every `path`
target. Any other gateway that passes a `path` target through unchanged **MUST** route everything
under that MCP address to that one server, **MUST NOT** forward the caller's credential upstream,
and **MUST** attach its own credential for the server when the target has `credentials: "include"`.

### Errors

Servers **MUST** respond to the following conditions as shown. The `requestState`,
`inputResponses.uploads`, and bytes conditions apply to a retry that answers an upload input
request. `isError: true` means a `CallToolResult` with `isError` set to `true`. `-32021` is
[`MissingRequiredClientCapabilityError`](https://modelcontextprotocol.io/specification/draft/schema#missingrequiredclientcapabilityerror).

| Condition                                                                            | Response                                                                                             |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Inline `data` exceeds `maxInlineBytes` in total, or the server does not accept it    | JSON-RPC `-32602`, reason `inline_too_large`                                                         |
| Non-empty file omits `data`, server has `upload`, request did not declare it         | `-32021` with `data.requiredCapabilities` listing the missing capability                             |
| Server knows the tool can only return a download, request did not declare `download` | `-32021` as above, before running the tool                                                           |
| Server cannot accept a file inline or out of band                                    | `isError: true`                                                                                      |
| Inline data cannot be decoded, or fails the size check                               | `isError: true`                                                                                      |
| Duplicate `id` values in file arguments                                              | `isError: true`                                                                                      |
| `requestState` fails verification or was already consumed                            | JSON-RPC `-32602`                                                                                    |
| Tool name or arguments differ from `requestState`                                    | JSON-RPC `-32602`                                                                                    |
| `inputResponses.uploads` is missing or is not an object                              | JSON-RPC `-32602`                                                                                    |
| Bytes have not arrived                                                               | `isError: true`, without running the tool                                                            |
| Bytes arrived but fail a check                                                       | `isError: true`, without running the tool                                                            |

The error's `data` carries the reason under the extension identifier:

```json
{
  "code": -32602,
  "message": "Invalid params",
  "data": { "io.modelcontextprotocol/files": { "reason": "inline_too_large" } }
}
```

`inline_too_large` is an exception to
[SEP-1303](https://modelcontextprotocol.io/seps/1303-input-validation-errors-as-tool-execution-errors).
A client that receives this error **MAY** repeat the call without `data` if it declared `upload` and
the server advertised it.

## Backward Compatibility

This extension is optional. A client that does not declare it never receives an upload input request
or a download target. Tools that accept file content inline today, such as base64 strings, continue
to work, as they do not depend on the upload or download flows. A tool that adopts `x-mcp-file`
changes its `inputSchema`, so a client without this extension sees an object argument it cannot
populate correctly.

SDKs require an MRTR extension point to support the upload input request.

## Security Implications

Clients and servers **MUST** redact target URLs, target headers, `form` fields, and inline
`data` in logs, traces, and error reports.

### Server-Directed Requests

A client that does not enforce [Targets](#targets) is exposed to server-side request forgery and can
leak the user's credential. Operators **SHOULD NOT** enable this extension behind a gateway that
does not implement it. Such a gateway cannot meet the rules in [Targets](#targets).

Enforcing [Targets](#targets) does not stop a malicious server from sending a request of its choice
to a public address, from the client's network position. With `form`, the server controls most of
the request body. Targets do not protect services that trust a client's address, or form handlers
without their own request-forgery defense. Whether a client sends the retry also tells the server
whether every target accepted the request. Host approval happens before the target is known, so it
does not cover this risk. Hosts **SHOULD** restrict `omit` targets to an allowlist of origins where
an operator can provide one, and **SHOULD** do so for `form` targets in unattended use.

### Exfiltration

A malicious server can specify any public URL as an `omit` target and receive the file at that URL.
`POST` reaches more existing endpoints than `PUT`, and `form` also reaches HTML form handlers. The
host approval required before the initial call mitigates this risk and applies to agent-created
files. A compromised agent can write sensitive data to a file and try to send it.

### Binding

Binding the principal, tool name, arguments, and upload targets to `requestState` prevents a client
from uploading under one call's authorization and attaching the file to another call or destination.

### Writable Targets

This extension has no content digest, so a server cannot detect same-size bytes written through a
leaked target. A target that stays writable lets anyone holding it replace the file, and pre-signed
URLs often cannot be revoked. Servers rely on short lifetimes, targets that accept one write, or a
copy of the confirmed bytes.

### Secret URLs

A URL that carries its own authorization is a secret for as long as it is valid. Servers **SHOULD**
issue such URLs with the shortest lifetime that covers the expected transfer.

### Staged Files

User files remain in staging until the server or storage-side expiry removes them.

### Downloaded Files

A download target needs no user approval, so a result can make a client send a `GET` of the server's
choosing, with the server's headers, and the request tells the server the client acted on the
result. A downloaded file can contain instructions aimed at the model, or content that harms an
application that opens it. Hosts **SHOULD** treat downloaded files as untrusted tool output, and
**SHOULD** apply a storage limit per result as well as per file.

### File Contents

Servers **SHOULD** follow [OWASP ASVS 5.0
V5](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x14-V5-File-Handling.md) for the formats they
accept.

## Reference Implementation

The reference implementation will include a TypeScript SDK branch with the upload input request and
a client transfer helper, a reference server in front of an object store, and conformance scenarios
for inline transfer, out-of-band transfer, a `form` target, target rejection, rejection on metadata,
a failed transfer with no retry, a size mismatch, a consumed `requestState`, a second upload input
request, and a download.

## Open Questions

1. **MRTR extensibility.** How should the specification enable extension-defined input requests?
   Repeated retries may belong in the same change, and it should let an extension limit repeats of
   its own input requests.
2. **Finalize.** Some backends return a commit handle in the transfer's HTTP response, such as an
   ETag or block ID, and the retry has no field for it. Owners of backends with an explicit commit
   step are asked to confirm whether finalizing on the retry works. An optional per-file field in
   `UploadInputResponse` can be added if needed.
3. **Tools behind an executor.** Gateways that expose a single generic tool hide the inner tool's
   schema, including `x-mcp-file`. The executor could declare its own file argument and map it to
   the inner call. The group needs to answer this before the extension leaves the experimental
   phase.
4. **Resources.** Should a later revision apply this flow to resources?
5. **`omit` binding.** Should `omit` targets be bound to an origin or allowlist, and should wildcard
   hosts be allowed?
6. **Failure signal.** A server learns of a failed transfer only when no retry arrives. Should a
   client be able to tell the server it gave up, so the server can release quota and clean up early?
   A later revision can add this behind a capability.
7. **Download shape.** This draft lists download targets in result `_meta`. Should it use
   `resource_link` instead? How a tool returns a file that takes a long time to generate is also
   open, and so is whether [Targets](#targets) should treat the two directions alike, including for
   redirects.
8. **Integrity.** This draft has no content digest. A required digest would detect same-size
   replacement and tampered downloads, but it makes clients read each file twice, browsers cannot
   hash a large file natively, and most backends need a full server read. Should a later revision
   add one, and should it be required or optional?

## Future Work

- **Chunked and resumable uploads**, for backends with per-request size limits and for interrupted
  transfers, once a standard is established.
- **Elicitation forms.** Out-of-band upload for `x-mcp-file` fields in `elicitation/create`.
- **More authorization methods**, including storage that needs a credential separate from the MCP
  one, and HTTP Message Signatures.
- **Promotion to the specification**, after the group has validated the extension in use.

## Acknowledgments

This draft builds on
[SEP-2356](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2356) and
[SEP-2631](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631), and on
collaboration in the
[File Uploads Working Group](https://modelcontextprotocol.io/community/working-groups/file-uploads)
and review from implementers.

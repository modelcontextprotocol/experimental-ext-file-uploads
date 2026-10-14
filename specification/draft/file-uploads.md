# File Uploads Extension

- **Status**: Experimental draft, not yet proposed as a SEP
- **Extension Identifier**: `io.modelcontextprotocol/files`
- **Working Group**: [File Uploads](https://modelcontextprotocol.io/community/working-groups/file-uploads)
- **Editors**: Den Delimarsky (@localden)
- **Discussion**: [Files WG Discord thread](https://discord.com/channels/1358869848138059966/1551968557292593172/1552399008440520865)
  and issues in this repository

This document is the working draft of the extension. It is written in SEP form so that it can
be submitted as an Extensions Track SEP once a reference implementation exists and the
working group is satisfied with it. Until then everything here is subject to change.

## Abstract

This extension lets a client hand a file to a tool without routing the
bytes through the model or through JSON-RPC. A server marks file-valued tool arguments with
the `x-mcp-file` JSON Schema keyword from
[SEP-2356](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2356). When the
client calls such a tool it sends the file's metadata first, alongside the other arguments.
The server either rejects the call on that metadata alone, or answers with an
[`InputRequiredResult`](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr)
carrying a `files/upload` input request that names an HTTPS upload target. The client sends
the bytes to that target and retries the same `tools/call` with the server-issued file URI in
the argument. Small files skip the exchange and travel inline as RFC 2397 `data:` URIs.

The whole exchange lives inside one `tools/call` and its retry. There are no new top-level
methods, no session state, and nothing a gateway has to special-case beyond result types it
already forwards. The extension is negotiated per request through `clientCapabilities` and
advertised by servers in `server/discover`.

This revision covers client-to-server transfer only. Server-to-client transfer (downloads),
resumable uploads, and file inputs on the elicitation surface are deferred and listed under
[Future Work](#future-work).

## Motivation

MCP has no interoperable way to get a file from the user to a tool. The pieces that exist
(`EmbeddedResource`, `BlobResourceContents`, base64 strings in arguments) all put the bytes
inside a JSON-RPC message, which means they also pass through whatever assembled that
message. For a host where the model emits tool arguments as tokens, that is the context
window. The practical result is that remote MCP servers cap file arguments at a few megabytes
and anything larger fails.

The Files Working Group collected the cases this blocks at its
[October 2, 2026 meeting](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3412):

- A user asks an assistant to save a 40 MB PDF from the conversation into a cloud-storage
  folder.
- An agent pulls a 200 MB CSV into a code sandbox exposed as an MCP server.
- An agent uploads a 50 MB deck as a new revision of an existing document and keeps the link.
- An enterprise agent uploads on a user's behalf, with or without the user present, to one of
  many sites or drives, so the call that hands back an upload target has to carry the
  destination and other parameters.

The same meeting recorded the constraints a solution has to meet from the host side: one
model turn per upload; file contents and credentials never enter the context window; small
files stay in band to keep latency down; large files go out of band to avoid base64; it has
to work when a gateway, rather than the host, holds the OAuth credentials; and file pointers
on the wire have to be marked explicitly so a deterministic proxy can find them.

Two earlier proposals addressed parts of this. SEP-2356 defined how a server declares "this
argument is a file" and an inline `data:` encoding, and deliberately stopped there.
[SEP-2631](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631) added
out-of-band transfer through new `files/authorizeUpload` and `files/authorizeDownload`
methods. The working group found two problems with 2631 as written: bytes move before the
server has seen the rest of the call, so uploads that permissions, quota, or data residency
would reject still consume bandwidth and may land in the wrong region; and new top-level
methods are invisible to gateways and SDKs that only pass through request types they know.
This draft keeps 2356's declaration model and 2631's descriptor shapes, and moves the
negotiation into the multi-round-trip request pattern that the `2026-07-28` revision already
requires for server-to-client interaction.

## Specification

### Extension Identifier

`io.modelcontextprotocol/files`

### Negotiation

A client that can perform out-of-band uploads declares the extension in the
`io.modelcontextprotocol/clientCapabilities` request metadata:

```json
{
  "extensions": {
    "io.modelcontextprotocol/files": {
      "maxInlineBytes": 1048576
    }
  }
}
```

| Field            | Type   | Description                                                                                      |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `maxInlineBytes` | number | Largest decoded file the client is willing to send inline as a `data:` URI. Optional; default 0. |

A server that accepts out-of-band uploads advertises the extension in its `server/discover`
capabilities:

```json
{
  "capabilities": {
    "tools": {},
    "extensions": {
      "io.modelcontextprotocol/files": {
        "maxInlineBytes": 262144,
        "maxUploadBytes": 262144000,
        "uploadOrigins": ["https://upload.example.com"]
      }
    }
  }
}
```

| Field            | Type     | Description                                                                                                                  |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `maxInlineBytes` | number   | Largest decoded file the server accepts inline. Optional; if omitted the per-field `maxSize` governs.                        |
| `maxUploadBytes` | number   | Largest file the server accepts through an upload target. Optional.                                                          |
| `uploadOrigins`  | string[] | HTTPS origins the server's upload targets will use. Optional. See [Upload target restrictions](#upload-target-restrictions). |

A client that has not declared the extension on a request **MUST NOT** receive a
`files/upload` input request in response to it. A server that needs a file larger than the
inline limits from such a client **SHOULD** fail the call with an explanatory tool error, or
fall back to URL-mode elicitation as described in SEP-2356.

### Declaring file arguments

Servers mark file-valued tool arguments with the `x-mcp-file` keyword exactly as SEP-2356
specifies it: on a property of the form `{"type": "string", "format": "uri"}` inside
`Tool.inputSchema`, with an optional descriptor.

```json
{
  "name": "save_to_folder",
  "description": "Save a file into a folder in the user's drive.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "folderId": { "type": "string" },
      "fileName": { "type": "string" },
      "file": {
        "type": "string",
        "format": "uri",
        "x-mcp-file": {
          "accept": ["application/pdf", "image/*"],
          "maxSize": 262144000
        }
      }
    },
    "required": ["folderId", "fileName", "file"]
  }
}
```

```typescript
interface FileInputDescriptor {
  /** Media types or dot-prefixed extensions the host should filter to. Picker hint only. */
  accept?: string[];
  /** Largest decoded file, in bytes, the server will accept for this argument by any path. */
  maxSize?: number;
}
```

This draft changes one thing about the descriptor relative to SEP-2356: `maxSize` is the
server's per-argument limit regardless of transfer path, as SEP-2631 proposed, rather than an
inline-only limit. The inline ceiling is the smaller of `maxSize` and the negotiated
`maxInlineBytes` values.

The keyword applies unchanged to array items (`{"type": "array", "items": {"type": "string",
"format": "uri", "x-mcp-file": {...}}}`) for tools that take several files.

All host-side rules from SEP-2356 apply: hosts **SHOULD NOT** show `x-mcp-file` properties
to a model that emits arguments as tokens, **MUST** bind a file to the slot only on an
affirmative user selection or under their existing approval policy for model-supplied
values, and **MUST NOT** place file bytes in model context.

### File argument values

An `x-mcp-file` argument carries a URI string in one of two forms:

- An RFC 2397 `data:` URI, encoded as SEP-2356 specifies. Used when the decoded size is at or
  below the inline ceiling.
- A **file URI** issued by the server in a `files/upload` input request. Used after an
  out-of-band upload.

File URIs are opaque to the client. Clients **MUST NOT** parse, dereference, resolve, or
hand a file URI to any URI handler, including when the value happens to use a scheme the
platform recognizes. Servers **SHOULD** mint file URIs under the `mcp-file:` scheme so that
hosts and proxies can recognize them syntactically. A file URI identifies one immutable byte
sequence; servers **MUST** issue a new URI for different bytes.

Servers **MUST** reject any other scheme in an `x-mcp-file` argument and **MUST NOT**
dereference it.

### Upload flow

#### 1. Initial call with file metadata

When a bound file exceeds the inline ceiling, the client sends `tools/call` with every
argument populated except the file argument, and describes the pending file in request
metadata under the extension identifier:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "save_to_folder",
    "arguments": {
      "folderId": "fld_8c1a",
      "fileName": "Q3 report.pdf"
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {
        "extensions": {
          "io.modelcontextprotocol/files": { "maxInlineBytes": 1048576 }
        }
      },
      "io.modelcontextprotocol/files": {
        "pending": {
          "/file": [
            {
              "name": "Q3 report.pdf",
              "mimeType": "application/pdf",
              "size": 41204133,
              "digest": {
                "algorithm": "sha-256",
                "value": "uU0nuZNNPgilLlLX2n2r-sSE7-N6U4D6ZVe-_rYh2sU"
              }
            }
          ]
        }
      }
    }
  }
}
```

`pending` is keyed by a JSON Pointer ([RFC 6901](https://www.rfc-editor.org/rfc/rfc6901))
into `arguments` identifying the `x-mcp-file` property. The value is a list of
`FileMetadata` objects, length one for a scalar property and one entry per file for an array
property, in argument order.

```typescript
interface FileMetadata {
  name?: string;
  mimeType: string; // application/octet-stream if unknown
  size: number; // decoded bytes
  digest?: FileDigest; // SHOULD be sent when the client can compute it
}

interface FileDigest {
  algorithm: "sha-256" | string;
  value: string; // base64url, no padding
}
```

The server now has everything the tool call will carry except the bytes. It **SHOULD**
perform all validation it can at this point (authorization for the destination, quota,
`accept` and `maxSize`, name collisions) and fail fast with a `CallToolResult` where
`isError` is `true`, following
[SEP-1303](https://modelcontextprotocol.io/seps/1303-input-validation-errors-as-tool-execution-errors), if the upload would
be refused.

#### 2. Upload target

If the server will accept the file, it responds with an `InputRequiredResult` containing one
`files/upload` input request per pending file:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "input_required",
    "inputRequests": {
      "u1": {
        "method": "files/upload",
        "params": {
          "argument": "/file",
          "index": 0,
          "file": {
            "uri": "mcp-file:01JD3V7K2M",
            "name": "Q3 report.pdf",
            "mimeType": "application/pdf",
            "size": 41204133
          },
          "upload": {
            "url": "https://upload.example.com/u/01JD3V7K2M?sig=...",
            "method": "PUT",
            "headers": { "Content-Type": "application/pdf" },
            "credentials": "omit",
            "expiresAt": "2026-10-14T18:30:00Z"
          }
        }
      }
    },
    "requestState": "..."
  }
}
```

```typescript
interface FilesUploadRequest {
  method: "files/upload";
  params: {
    /** JSON Pointer into arguments, matching a key the client sent in `pending`. */
    argument: string;
    /** Position within that pending list. */
    index: number;
    /** The file URI the client will place in the argument, plus echoed metadata. */
    file: { uri: string; name?: string; mimeType?: string; size?: number };
    upload: UploadTarget;
  };
}

interface UploadTarget {
  /** Absolute https URL. */
  url: string;
  method: "PUT" | "POST";
  /** Headers the client MUST send verbatim. MUST NOT include Authorization. */
  headers?: { [name: string]: string };
  /**
   * If present, the client sends multipart/form-data: `fields` as form fields in order,
   * then the file bytes under `fileField`. If absent, the request body is the raw bytes.
   */
  form?: { fileField: string; fields?: { [name: string]: string } };
  /**
   * "omit": the URL is self-authorizing; the client MUST NOT attach MCP credentials.
   * "include": the client attaches the same Authorization it presents to the MCP
   * endpoint. Permitted only for same-origin targets; see Upload target restrictions.
   */
  credentials: "omit" | "include";
  /** RFC 3339 timestamp after which the target SHOULD be treated as dead. */
  expiresAt?: string;
}
```

Servers **SHOULD** carry whatever they need to correlate the retry (the issued file URIs,
the validated arguments, an expiry) in `requestState`, integrity-protected as the MRTR
pattern requires, so that the retry can be served by any instance.

#### 3. Transfer

For each `files/upload` request the client:

1. Applies the [upload target restrictions](#upload-target-restrictions). A target that fails
   them **MUST NOT** be contacted; the client treats the input request as unsatisfiable.
2. Sends one HTTPS request to `upload.url` with `upload.method`, the listed `headers`, and
   either the raw bytes or the multipart body described by `form`. When `credentials` is
   `"omit"` the client **MUST NOT** send an `Authorization` header or cookies. When it is
   `"include"` the client sends the credential it would present to the MCP endpoint for this
   server and nothing else.
3. Treats any `2xx` response as success. Any other outcome is a failed upload.

The party that performs step 2 is whichever component holds the bytes and, for
`credentials: "include"`, the credential. In a gateway deployment that is typically the
gateway; the host forwards the `InputRequiredResult` unchanged and the gateway satisfies the
`files/upload` requests before the retry reaches the server. Nothing in the exchange requires
the model or the host UI to see the target URL.

#### 4. Retry with file URIs

The client retries `tools/call` with the original arguments, the file argument now set to
the issued file URI (or an array of them), an `inputResponses` entry for each `files/upload`
key, and `requestState` echoed verbatim:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "save_to_folder",
    "arguments": {
      "folderId": "fld_8c1a",
      "fileName": "Q3 report.pdf",
      "file": "mcp-file:01JD3V7K2M"
    },
    "inputResponses": {
      "u1": { "uri": "mcp-file:01JD3V7K2M", "status": "uploaded" }
    },
    "requestState": "...",
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "...": "..."
    }
  }
}
```

```typescript
interface FilesUploadResult {
  uri: string;
  status: "uploaded" | "failed";
  /** Present when status is "failed"; free text for logs, not shown to the model. */
  error?: string;
}
```

On receipt the server verifies `requestState`, confirms that each file URI in the arguments
was issued under that state and that the bytes arrived (and match `digest` when one was
given), performs any storage-side finalize step, runs the tool, and returns an ordinary
`CallToolResult`. The model sees that result and nothing of the exchange that produced it.

If an upload is reported `failed`, did not arrive, or the target expired, the server
**SHOULD** return a fresh `InputRequiredResult` with new targets when a retry is plausible,
and otherwise a tool error. Servers **MUST NOT** run the tool with a file argument whose
bytes they have not confirmed.

#### Sequence

```mermaid
sequenceDiagram
    participant H as Host or gateway
    participant S as MCP server
    participant T as Upload target

    H->>S: tools/call {args without file, _meta.files.pending}
    alt rejected on metadata
        S-->>H: CallToolResult {isError: true}
    else accepted
        S-->>H: InputRequiredResult {files/upload: target, file URI; requestState}
        H->>T: PUT bytes (credentials per target)
        T-->>H: 2xx
        H->>S: tools/call {args with file URI, inputResponses, requestState}
        S-->>H: CallToolResult
    end
```

For a file at or below the inline ceiling the client skips all of this and sends a single
`tools/call` with a `data:` URI in the argument.

### Upload target restrictions

The upload target is chosen by the server, and in the `credentials: "include"` case the
client attaches a user credential to a request the server directed. Clients and gateways
therefore enforce the following independently of anything the server returns:

1. `upload.url` **MUST** be an absolute `https` URL. Clients **MUST** reject any other
   scheme.
2. Clients **MUST** reject targets whose host resolves to a loopback, link-local, private
   ([RFC 1918](https://www.rfc-editor.org/rfc/rfc1918), [RFC 4193](https://www.rfc-editor.org/rfc/rfc4193)),
   or otherwise non-globally-routable address, unless the MCP server itself was reached at
   such an address.
3. Clients **MUST** restrict targets to an origin set established out of band for that
   server: an operator or registry allowlist where one exists, and otherwise the MCP
   endpoint's own origin. The server's advertised `uploadOrigins` **MAY** narrow that set and
   **MUST NOT** widen it; a client with no out-of-band allowlist **MAY** treat
   `uploadOrigins` as advisory input to a user- or operator-facing consent decision but
   **MUST NOT** treat it as sufficient on its own.
4. `credentials: "include"` is honored only when the target's origin equals the MCP
   endpoint's origin. For any other origin the client **MUST** behave as if `credentials`
   were `"omit"`, and **MAY** refuse the target.
5. Clients **MUST NOT** follow HTTP redirects from an upload target.

These rules exist so that a compromised or malicious server cannot use a host or gateway as
a request proxy into networks it cannot otherwise reach, and cannot harvest a user's MCP
credential by pointing an upload at itself under another name.

### Error handling

- Validation failures the model can act on (wrong type, too large, destination not
  writable, quota) are tool errors: `CallToolResult` with `isError: true` and text naming the
  argument and the constraint, per SEP-1303.
- A retry whose `requestState` fails verification, or whose `inputResponses` is structurally
  malformed, is a JSON-RPC `-32602`.
- A retry that references a file URI the server did not issue under the presented
  `requestState` **MUST** be rejected; servers **SHOULD** use a tool error so the host can
  restart the flow.
- Digest mismatch after upload **SHOULD** be reported distinctly from other failures.

Servers, clients, gateways, and SDKs **MUST** treat `data:` values in `x-mcp-file` arguments
and upload target URLs as sensitive in logs and telemetry, redacting bytes and query strings.

### Changes to the core specification

The MRTR pattern currently enumerates the request types permitted in `inputRequests`
(`elicitation/create`, `sampling/createMessage`, `roots/list`). This extension requires one
sentence added to that list: a server **MAY** also include a request type defined by an
extension the client declared on the originating request. No other core text changes.

## Rationale

### Why multi-round-trip requests instead of `files/*` methods

SEP-2631 put upload negotiation in a separate `files/authorizeUpload` call made before
`tools/call`. That ordering means the server authorizes bytes without seeing the arguments
they belong to, so it cannot check the destination, apply quota, or pick a storage region
until after the transfer. It also means two requests that the protocol does not tie together;
a server has to invent its own correlation, and an intermediary has to learn a new method.

Folding the negotiation into `InputRequiredResult` fixes all three. The server sees the full
call before issuing a target. The issued file URI, the validated arguments, and the expiry
ride in `requestState`, so the retry is self-contained and any instance can serve it. And
the only wire artifacts are a `tools/call`, a result, and another `tools/call`, which every
gateway and SDK built for `2026-07-28` already forwards.

The working group considered and set aside a dedicated primitive for files. Tools plus MRTR
cover the collected use cases; a new primitive can come later if they stop doing so.

### Why metadata rides in `_meta` on the first call

The file argument's schema is a URI string, so it cannot hold a metadata object, and
inventing a placeholder URI that encodes name and size would be a second wire format for the
same information. Request `_meta` under the extension's own key is already where
per-request extension data lives, it survives SDK argument validation, and it keeps
`arguments` schema-valid on both the initial call and the retry. This is listed under
[Open Questions](#open-questions) in case reviewers prefer a different placement.

### Why keep `x-mcp-file` and `data:`

SEP-2356's reasoning for an inline schema keyword over a sidecar map, and for `data:` as the
inline carrier, still holds and is not repeated here. Reusing both means a server written
against 2356 gains out-of-band transfer by declaring the extension and handling one new
input request type; its tool schemas do not change.

### Why `credentials: omit | include` and the same-origin rule

The working group heard two firm and opposite requirements: storage providers that issue
pre-signed URLs and do not want a bearer token anywhere near them, and enterprise
deployments where pre-authorized URLs are unacceptable and the data plane has to be
authorized with the same token as the control plane. A per-target flag covers both without
the client guessing. Restricting `include` to the MCP endpoint's origin is the narrowest rule
that serves the enterprise case (the server fronts its own upload path) while guaranteeing
the token never reaches a third party. Widening it, for example to any origin listed in the
server's Protected Resource Metadata, is an open question.

A third mode, where the upload target needs a credential distinct from the MCP one (a
storage provider with its own OAuth), is real but deferred; it likely composes with URL-mode
elicitation or a second authorization flow and does not change the shapes here.

### Why a single request and no resumability in this revision

No resumable-upload protocol has broad enough adoption to mandate. tus and the
[httpbis resumable upload draft](https://datatracker.ietf.org/doc/draft-ietf-httpbis-resumable-upload/)
are both candidates; pinning an extension to an Internet-Draft is premature. A single PUT or
POST handles files into the low hundreds of megabytes on ordinary connections, which covers
the collected use cases. Resumability can be added as a negotiated `UploadTarget` variant
without touching anything specified here.

### Why host-enforced target restrictions rather than server-declared ones

A server-declared allowlist is chosen by the same party that chooses the URL, so on its own
it constrains nothing. The restrictions section makes the client or gateway the enforcing
party and lets `uploadOrigins` only narrow. This matches how hosts already treat other
server-supplied URLs (OAuth metadata, URL-mode elicitation) and is the control that makes
`credentials: "include"` safe to offer at all.

### Why uploads only

Downloads touch different host code paths (how a result reaches the user and the model), do
not have the metadata-first problem, and already have partial answers in `resource_link`,
`EmbeddedResource`, and
[SEP-2532](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2532). The
working group is treating them as the same track, and the `UploadTarget` shape is written so
a `DownloadTarget` can mirror it, but specifying both at once would double the review surface
for the first revision.

### Prior art

- SEP-2356 (declaration keyword, inline encoding, host-side rules), closed in favor of 2631
  and revived here for the parts this draft depends on.
- SEP-2631 (file URIs, digest, upload and download descriptors, `maxSize` semantics), which
  this draft expects to supersede for the upload direction.
- SEP-2532 (resource streaming) and SEP-2571 (resource submission), adjacent work in the same
  group.
- OpenAI Apps SDK `openai/fileParams`, a vendor `_meta` hint naming file-valued parameters.
- Storage-provider APIs that already separate "create upload session" from "send bytes"
  (Google Drive resumable upload, Box upload sessions, Dropbox temporary upload links,
  S3 and GCS signed URLs). The `files/upload` input request is shaped so a server can wrap
  any of these.

## Backward Compatibility

The extension is additive and off by default. A client that does not declare it never sees a
`files/upload` input request. A server that does not advertise it receives `data:` URIs up
to whatever `maxSize` it declares, exactly as under SEP-2356, or no file support at all.
Tools that today take ad hoc base64 or URL string arguments keep working and gain nothing
until their authors adopt `x-mcp-file`.

The one core edit (permitting extension-defined request types in `inputRequests` when the
client declared the extension) does not change behavior for any existing client or server.

## Security Implications

The threat model has three parties that do not fully trust each other: the user (represented
by the host), the MCP server, and whatever storage sits behind the upload target.

**Server-directed requests from the client.** The upload target is an instruction from the
server to make an HTTP request. [Upload target restrictions](#upload-target-restrictions)
bound where that request can go and what credential it can carry. Implementations that relax
those rules reintroduce server-side request forgery through the client or gateway and
credential disclosure to third-party origins.

**User consent and file provenance.** Everything SEP-2356 says about host-side file access
applies: the host binds a file to an `x-mcp-file` slot only on explicit user selection for
that server and tool, or forwards a model-supplied `data:` value under its existing approval
policy without dereferencing it. Hosts **SHOULD** show the user the file identity, size, and
destination server before the initial call, since after that point the transfer proceeds
without further interaction. The server receives no provenance signal and **MUST NOT** assume
a file was user-selected rather than model-authored.

**Replay and substitution.** `requestState` binds the issued file URIs to the validated
arguments, the principal, and an expiry; servers **MUST** integrity-protect it as the MRTR
pattern requires and **MUST** refuse file URIs not issued under the presented state. Without
this a client could upload under one call's authorization and attach the file to another.
Digests, when the client supplies them, let the server detect byte substitution between
metadata and upload.

**Untrusted content.** Servers are receiving arbitrary bytes and **MUST** apply the file
handling controls appropriate to the formats they accept;
[OWASP ASVS 5.0 V5](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x14-V5-File-Handling.md)
is the reference. Tool results derived from uploaded content are untrusted with respect to
the model and hosts **MUST** present them as data.

**Logging.** Upload URLs frequently embed signatures; `data:` values embed user bytes. Both
**MUST** be redacted in logs, traces, and error reports at every hop.

## Reference Implementation

To be built in this repository before the draft is submitted as a SEP. The plan is a TypeScript SDK branch adding
the `files/upload` input request type and client-side transfer helper, a reference server
that fronts an S3-compatible store, and a conformance scenario covering inline, out-of-band,
early rejection, expired target, and digest mismatch.

## Open Questions

1. **Placement of pending-file metadata.** Request `_meta` under the extension key (as
   specified), a reserved placeholder URI in the argument slot, or a sibling field on
   `CallToolRequestParams`.
2. **Multipart in the first revision.** Raw-body PUT/POST covers signed-URL stores; several
   provider APIs want `multipart/form-data` with extra fields. The `form` member is included
   above; reviewers may prefer to defer it.
3. **Scope of `credentials: "include"`.** Same origin as the MCP endpoint (as specified), or
   any origin the server's Protected Resource Metadata names as the same protected resource.
4. **Mandating the `mcp-file:` scheme** for issued file URIs versus leaving the scheme to the
   server with opacity rules only.
5. **Per-argument transfer mode.** SEP-2631's `transferModes` let a server force out-of-band
   for a specific field. This draft relies on `maxInlineBytes` and `maxSize` instead; a server
   that never wants inline sets `maxInlineBytes: 0`.
6. **Explicit finalize.** Some backends need a commit call after the bytes land. As written
   the server performs it while handling the retry; reviewers from those backends should
   confirm that is sufficient.
7. **Elicitation-surface uploads.** An `x-mcp-file` field inside an `elicitation/create`
   form is itself delivered through `inputRequests`; supporting out-of-band upload there
   means a nested negotiation. This draft leaves elicitation file fields inline-only.
8. **Client-reported upload evidence.** Whether `FilesUploadResult` should carry the
   target's response status, `ETag`, or body for stores that need it to finalize.

## Future Work

- **Downloads.** A `DownloadTarget` mirroring `UploadTarget`, attached to `resource_link`
  content or returned through a `files/download` input request on `resources/read`, with the
  same origin and credential rules.
- **Resumable and chunked transfer** as an additional negotiated target type once a standard
  settles.
- **Third-party storage credentials**, where the upload target needs an authorization the
  MCP credential does not cover.
- **Promotion to the core specification** after the extension has shipped in SDKs and at
  least two independent hosts, per the working group's October 2 decision to validate in use
  first.

## Acknowledgments

This draft consolidates work by Olivier Chafik (SEP-2356) and Casey Chow (SEP-2631), and the
discussion at the Files Working Group's October 2, 2026 meeting with Wil St. Charles, Kurtis
Van Gent, Thomas Sarlandie, and Kryspin Ziemski. Thomas Sarlandie proposed modeling the
upload as a multi-round-trip request. Patrick Rodgers' SEP-2532 informed the deferred
download direction.

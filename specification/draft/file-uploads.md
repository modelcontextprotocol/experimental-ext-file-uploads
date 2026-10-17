# File Uploads Extension

- **Status**: Proposed experimental revision; depends on a base MRTR extension point, not currently interoperable
- **Extension Identifier**: `io.modelcontextprotocol/files` (provisional)
- **Working Group**: [File Uploads](https://modelcontextprotocol.io/community/working-groups/file-uploads)
- **Editors**: Den Delimarsky (@localden)
- **Discussion**: [File Uploads Working Group Discord thread](https://discord.com/channels/1358869848138059966/1551968557292593172/1552399008440520865)
  and issues in this repository

The working group writes this draft in SEP form so it can submit it as an Extensions Track SEP once a reference implementation exists. Anything here can change before then, including the extension identifier.

## Abstract

This proposed revision defines a structured file argument containing an opaque client-generated
ID, media type, decoded byte size and SHA-256 digest, with an optional base64 `data` field.
Every argument marked `x-mcp-file` uses that shape. Present `data` carries an inline file;
absent `data` asks the server to arrange an out-of-band upload after seeing the intended tool,
destination and complete metadata. No placeholder, file URI or separate pending-metadata map
is needed.

The proposed upload member reuses `InputRequiredResult`. After uploading, the client retries
with exactly the same tool arguments, opaque `requestState`, and correlated `inputResponses`
containing per-file completion statuses. The server verifies stored bytes before execution.

**This is a proposed wire change, not a description of current MCP support.** The base MRTR
input-request union needs an extension point before this upload member is valid. This revision
selects that direction for review rather than simultaneously defining two wire profiles.
It replaces this draft's earlier `upload_required` result and URI-substitution design.
Downloads and resumable transfer remain future work.

## Motivation

MCP has no interoperable way to get a file from a user to a tool. The existing options
(`EmbeddedResource`, `BlobResourceContents`, base64 strings in arguments) put the bytes inside a
JSON-RPC message. When the model emits tool arguments as tokens, the bytes pass through its
context window, and large uploads to remote MCP servers fail.

The File Uploads Working Group collected the cases this blocks at its
[October 2, 2026 meeting](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3412):

- A user asks an assistant to save a 40 MB PDF from the conversation into a cloud-storage folder.
- An agent pulls a 200 MB CSV into its code sandbox.
- An agent uploads a 50 MB deck as a new revision of an existing document and keeps the link.
- An enterprise agent uploads or downloads on a user's behalf, with or without the user present,
  to one of many sites or drives, so the call that returns an upload target has to carry the
  destination.

The same meeting recorded the host-side constraints:

- One model turn per upload.
- File contents and credentials never enter the context window.
- Small files stay in band to keep latency down.
- Large files go out of band to avoid base64.
- Uploads work when a gateway holds the OAuth credentials instead of the host.
- File pointers on the wire carry a marker a deterministic proxy can find.

SEP-2356 defined how a server declares a file argument and an inline `data:` encoding, and sent
larger files to URL-mode elicitation instead of defining an upload protocol. It closed without
merging. [SEP-2631](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631) added
out-of-band transfer through new `files/authorizeUpload` and `files/authorizeDownload` methods.
Thomas Sarlandie called ordering SEP-2631's biggest flaw. Bytes move before the server sees the
rest of the call, so uploads that permissions, quota, or data residency rules would reject still
consume bandwidth and can land in the wrong region. The group agreed on metadata first, then the
upload target, then bytes, then finalize, and agreed to build on multi-round-trip requests (MRTR)
and existing primitives before adding new ones.

## Specification

In this document, _client_ is the component that speaks MCP to the server: the host, or a
gateway acting for it. _Host_ is the application that presents the model and the user interface.

### Extension identifier

`io.modelcontextprotocol/files`

### Negotiation

The extension identifier and method below are provisional. Clients declare this exact proposed
profile in `io.modelcontextprotocol/clientCapabilities` on every participating request:

```json
{"extensions":{"io.modelcontextprotocol/files":{
  "fileArguments":"object-v1","upload":"mrtr-v1","inline":["base64"]
}}}
```

Servers advertise the same profile in `server/discover`, together with `maxInlineBytes`:

```json
{
  "capabilities": {
    "tools": {},
    "extensions": {
      "io.modelcontextprotocol/files": {
        "fileArguments": "object-v1",
        "upload": "mrtr-v1",
        "inline": [
          "base64"
        ],
        "maxInlineBytes": 1048576
      }
    }
  }
}
```

`maxInlineBytes` is required and is the maximum aggregate decoded inline size per call.
Zero explicitly disables inline transfer. An absent field or mismatched profile is not support.
Clients **MUST NOT** dispatch this file-object contract unless the server advertises it;
servers **MUST NOT** issue upload input requests unless the client declares the exact profile.
The base MRTR extension point and SDK dispatch support are additional prerequisites: these
capabilities do not override current core restrictions.

Servers **MUST** reject unsupported or oversized inline values as tool input errors, without
silently treating their bytes as absent. The host chooses inline versus out-of-band before
dispatch; switching paths requires a new logical call because `arguments` stay unchanged.

### File arguments

A tool marks each file-value schema with `x-mcp-file`. The marked schema **MUST** require the
object shape defined in [file-input.schema.json](examples/file-input.schema.json), including
array item schemas. Required properties are `id`, `mimeType`, `size` and `digest`. `name` and
`data` are optional. A conforming marked schema may tighten constraints, but **MUST NOT**
permit another representation or weaken required fields and their types. The host recognizes
file fields by the marker, not by guessing from an object's property names.

```typescript
interface FileInput {
  /** Opaque client-generated ID, unique per file argument occurrence in this logical call. */
  id: string;
  /** Display name only; never a storage path or identity. */
  name?: string;
  /** "application/octet-stream" when unknown. */
  mimeType: string;
  /** Decoded bytes, integer 0..2^53-1. */
  size: number;
  digest: { algorithm: "sha-256"; value: string /* canonical base64url, no padding */ };
  /** Canonical RFC 4648 standard base64 with padding when needed. */
  data?: string;
}

interface FileInputDescriptor {
  /** File-picker hint, not proof of content type. */
  accept?: string[];
  /** Maximum decoded size per file on every transfer path. */
  maxSize?: number;
}
```

The ID contains 1..128 ASCII letters, digits, `_` or `-`. It is a correlation label, not a URI,
filename, authorization, storage address, or server-reusable reference. Duplicate IDs in a
call **MUST** be rejected, even when two argument occurrences refer to identical bytes.
The host may assign different IDs to the same selected bytes used in different arguments.
There is no cross-call reuse implied by an ID or digest.

If `data` is present, the file is inline. `data: ""` represents an empty inline file; `null`
is invalid. If `data` is absent, bytes require an upload. Servers **MUST** verify canonical
base64, decoded size, SHA-256 digest and content policy. JSON Schema's `contentEncoding`
annotation alone does not perform these checks. Hash the original bytes, not base64 characters;
`size` counts those same original bytes. This revision requires a digest even for inline data.

For example, the `files.items` property of [this complete tool schema](examples/tool.json)
requires the canonical object and carries `x-mcp-file: {accept: ["text/plain"], maxSize: 65536}`.
[inline-call.json](examples/inline-call.json) contains a complete inline call with real bytes
and digest; [empty-inline-call.json](examples/empty-inline-call.json) demonstrates presence
rather than truthiness of `data`.

Hosts **MUST** populate file metadata and bytes from a selected or policy-approved local file,
and obtain approval for sending it to this server and the server-designated storage. They
**SHOULD NOT** expose file schemas directly to a model generating arguments as tokens.
A host may expose a short local selector, then resolve it and construct the complete object
before dispatch. This projection is outside the wire contract. File bytes, upload targets,
credentials and state **MUST NOT** enter model context. The host retains the authoritative
arguments for retries instead of asking the model to reconstruct them.

This profile supports statically reachable file fields under object `properties` and array
`items`. Unresolved references and schema compositions containing file markers are unsupported;
hosts **MUST** fail explicitly rather than guess a traversal. Wrapper/executor tools need an
explicitly exposed inner schema or another negotiated discovery contract before a host can
perform this handling; this revision does not solve hidden inner-tool discovery.

### Upload flow

```mermaid
sequenceDiagram
    participant C as Client
    participant S as MCP server
    participant T as Upload target
    C->>S: tools/call with file objects; data absent for OOB
    alt rejected on metadata
        S-->>C: CallToolResult {isError: true}
    else upload needed
        S-->>C: input_required + files/upload + requestState
        C->>T: PUT raw bytes
        T-->>C: 2xx
        C->>S: same arguments + requestState + inputResponses
        S->>T: Confirm stored bytes and integrity
        S-->>C: CallToolResult
    end
```

#### Initial call

The client sends complete tool arguments with all file metadata inside the corresponding
file objects. It omits `data` for each out-of-band file. No `pending` metadata appears in
request `_meta`; ordinary MCP protocol/client/capability metadata is still required.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "save_to_folder",
    "arguments": {
      "folderId": "fld_eu_123",
      "files": [
        {
          "id": "file-1",
          "name": "hello.txt",
          "mimeType": "text/plain",
          "size": 5,
          "digest": {
            "algorithm": "sha-256",
            "value": "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ"
          }
        },
        {
          "id": "file-2",
          "name": "notes.txt",
          "mimeType": "text/plain",
          "size": 12,
          "digest": {
            "algorithm": "sha-256",
            "value": "-VexlSmQaWGTPFww-HE8UAqbtdnQaVxA1IyXomo1lOw"
          }
        }
      ]
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "file-example-host",
        "version": "0.1.0"
      },
      "io.modelcontextprotocol/clientCapabilities": {
        "extensions": {
          "io.modelcontextprotocol/files": {
            "fileArguments": "object-v1",
            "upload": "mrtr-v1",
            "inline": [
              "base64"
            ]
          }
        }
      }
    }
  }
}
```

The server **SHOULD** reject unauthorized destination, quota, residency, name collision or
declared-size/type violations before allocating upload targets. It **MUST** treat all metadata
as client-asserted, including digest, and **MUST NOT** infer trust from schema validation.
An all-inline call can complete immediately after verification. Mixed inline and absent-data
files are permitted, subject to aggregate inline and per-file limits.

#### Upload input request

For files whose bytes are still needed, the server returns `InputRequiredResult` with the
input-request key `uploads` and the proposed namespaced upload member. This profile assigns
that key to one batched upload request per round; it is not a globally reserved MCP key.
Other input requests use different keys. The matching input response uses the same `uploads`
key; each `fileId` identifies one file argument occurrence in this invocation:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "input_required",
    "requestState": "opaque-invocation-state-1",
    "inputRequests": {
      "uploads": {
        "method": "io.modelcontextprotocol/files/upload",
        "params": {
          "files": [
            {
              "fileId": "file-1",
              "url": "https://upload.example.com/u/1",
              "headers": {
                "Content-Type": "text/plain"
              },
              "credentials": "omit",
              "expiresAt": "2026-10-16T23:05:00Z"
            },
            {
              "fileId": "file-2",
              "url": "https://upload.example.com/u/2",
              "headers": {
                "Content-Type": "text/plain"
              },
              "credentials": "omit",
              "expiresAt": "2026-10-16T23:05:00Z"
            }
          ]
        }
      }
    }
  }
}
```

```typescript
interface UploadInputParams {
  files: UploadTarget[];
}
interface UploadTarget {
  fileId: string;
  url: string;
  headers?: { [name: string]: string };
  credentials: "omit" | "include";
  /** RFC 3339 UTC deadline, no later than this request state's validity. */
  expiresAt: string;
}
```

The method `io.modelcontextprotocol/files/upload` is proposed here; it is not currently a
permitted core MRTR member. Each target **MUST** identify one non-inline file in the original
arguments by `fileId`, which equals that file object's `id`. A batch **MUST NOT** contain
duplicate `fileId` values. Each file has at most one outstanding target in a round.
The client **MUST** reject unknown, inline, duplicate or mismatched file targets before sending
bytes. It **MUST** bind each target to its original selected-file metadata and recheck that
local bytes match before transfer. It **MUST NOT** follow a target for model-supplied arbitrary
paths or silently select a different file.

The server **MUST** bind the authenticated principal, logical invocation ID, tool name, full
arguments including metadata, file IDs and their argument locations, each file's currently
issued target and backend staging object, input-request keys, round and expiry to
integrity-protected `requestState` or server-side state. The server uses the echoed state and
`fileId` to resolve exactly one currently authorized target and staging object. A `fileId` alone
does not identify a transfer across invocations or grant access. Backend transfer handles stay
internal to the server and are not included in the client response.
There is no file-value exclusion from the argument digest. State is opaque to the client.
Changing any argument, including `data` presence, starts a new invocation and requires new
authorization. A Tasks server **MUST** resolve required uploads before creating the task.

Targets **SHOULD** write to staging and enforce size. Final-destination targets **MUST** enforce
declared size and digest where supported. Expired/abandoned staging **SHOULD** be reclaimed.
Request expiry applies to the retry as well as transfer; a client must finish before the
deadline, not merely begin PUT. Expired state requires a new logical invocation.

#### Transfer

The client applies [Upload targets](#upload-targets) to each URL and sends raw bytes with PUT.
Inline base64 is a JSON encoding only; HTTP uploads carry decoded bytes. A `2xx` response permits
a completion report, but does not prove to the server that valid bytes exist. Clients **MUST**
send no more than declared size and bound concurrency and total work per invocation.
For retryable transfer failures, the client **MUST** stop after at most three total HTTP
transfer attempts per file per logical invocation (the initial attempt plus up to two retries),
counted across any MRTR rounds and replacement targets. Retry only while safe, authorized and
before expiry, with bounded backoff; permanent failure or unsafe retry ends attempts immediately.
They **MUST NOT** follow redirects or continue past target expiry.

A gateway holding the MCP credential but not the bytes can relay an `include` upload under
the existing canonical-origin/path rules or pass an `omit` target to the host. Browser-target
storage **SHOULD** support the required CORS preflight. Upload handling and retry proceed
without another model turn; results and logs **MUST NOT** reveal transfer credentials or URLs.

#### Retry and per-file outcomes

The client retries with a new JSON-RPC ID, the exact same `name` and JSON value of `arguments`,
the exact opaque `requestState`, and the result under `inputResponses.uploads`, matching the
latest outstanding `inputRequests.uploads`:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "save_to_folder",
    "arguments": {
      "folderId": "fld_eu_123",
      "files": [
        {
          "id": "file-1",
          "name": "hello.txt",
          "mimeType": "text/plain",
          "size": 5,
          "digest": {
            "algorithm": "sha-256",
            "value": "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ"
          }
        },
        {
          "id": "file-2",
          "name": "notes.txt",
          "mimeType": "text/plain",
          "size": 12,
          "digest": {
            "algorithm": "sha-256",
            "value": "-VexlSmQaWGTPFww-HE8UAqbtdnQaVxA1IyXomo1lOw"
          }
        }
      ]
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "file-example-host",
        "version": "0.1.0"
      },
      "io.modelcontextprotocol/clientCapabilities": {
        "extensions": {
          "io.modelcontextprotocol/files": {
            "fileArguments": "object-v1",
            "upload": "mrtr-v1",
            "inline": [
              "base64"
            ]
          }
        }
      }
    },
    "requestState": "opaque-invocation-state-1",
    "inputResponses": {
      "uploads": {
        "resultType": "complete",
        "files": [
          {
            "fileId": "file-1",
            "status": "completed"
          },
          {
            "fileId": "file-2",
            "status": "completed"
          }
        ]
      }
    }
  }
}
```

```typescript
interface UploadInputResponse extends Result {
  /** The input request was answered; individual files can still have failed. */
  resultType: "complete";
  files: {
    fileId: string;
    status: "completed" | "failed";
  }[];
}
```

`completed` means the client observed successful HTTP transfer. `failed` is terminal for that
file in this logical invocation: retryable failures exhausted the three-attempt budget, or an
earlier permanent failure or unsafe retry prevented completion. Three attempts means three
HTTP transfers, not three MCP calls or three retries. Reporting failure does not authorize more
upload attempts. A host that abandons the call sends no continuation; the server reclaims
staging on expiry. The result object follows MRTR's result shape: `resultType: "complete"`
means the upload input request has been answered, not that all reported files succeeded.
Detailed backend responses, URLs and headers are not echoed. A storage receipt/commit-token
profile is separate work; this version supports backends the server can independently verify
and finalize. No arbitrary client response header is trusted as proof.

Servers **MUST** reject duplicate or unknown file IDs, unknown statuses, and entries not bound
to an outstanding target for that file in the echoed state and input-request key. Missing
entries are unresolved, not success. [partial-retry.json](examples/partial-retry.json) shows a
mixed outcome report.

Before execution, the server:

1. Verifies principal, state integrity, expiry, invocation identity, tool name and every original
   argument; invalid state or changed arguments return JSON-RPC error `-32602`.
2. Validates the correlated input response. Any `failed` entry ends the invocation with a tool
   execution error; the server **MUST NOT** run the tool or reissue that file in this invocation
   and **SHOULD** reclaim staged uploads. A separately authorized new invocation is independent.
3. Independently confirms each completed upload with its backend, compares actual decoded
   size and digest, and rechecks actual content/type and other authorization requirements.
   Invalid bytes produce a tool error and **MUST NOT** be consumed by the tool.
4. If no report failed but a report is missing or bytes are not yet visible, returns a further
   `InputRequiredResult` for only unresolved files, or a bounded terminal tool error. It binds
   verified files into the next state so they need not be uploaded again. The client echoes
   the newest state and responds under `uploads` on the next retry. This does not reset any
   file's transfer-attempt budget.
5. Finalizes verified objects, atomically claims the logical invocation, executes once and
   retains its terminal result for authenticated identical retries until invocation expiry.

When requesting an unresolved file again, the server **SHOULD** preserve a still-valid target.
A client that already observed successful PUT may repeat its `completed` report without another
PUT only if the target descriptor for that `fileId` is identical to the one it used. The server
**MUST** keep an unchanged target descriptor bound to the same staging object in this invocation.
If the descriptor changes, the server **MUST** issue a fresh `requestState` and atomically supersede
the previous round; the old target **MUST** be revoked or isolated so that late writes cannot
satisfy or overwrite the replacement. A completion associated with the old state **MUST NOT**
satisfy the new round. If the server cannot enforce these rules, it **MUST** fail the invocation
instead of replacing the target. The server **MUST NOT** re-request a verified file while keeping
the same invocation's state.

Concurrent or repeated completion reports **MUST NOT** execute the logical tool twice.
The server **MUST** retain a completion/execution record through the state lifetime; after
execution starts, duplicate retries return a retained result or a retryable state-only
`InputRequiredResult` while the original execution is still running. After a crash with an
unknown outcome, it **MUST NOT** blindly execute again; it must reconcile the operation or
return an indeterminate-outcome error. This requires durable coordination for distributed or
crash-resilient implementations, not only a signed state token. Consumed uploads **MUST** reject
further PUTs. A target or staged object from an earlier invocation, principal or destination
**MUST NOT** satisfy a later one.

Success reports alone never satisfy a file argument. Execution requires all inline files and
all out-of-band file occurrences to be verified. A file object without `data` remains unchanged
even after successful upload: its verified bytes are resolved from invocation-bound state.

Additional elicitation can use the same envelope once core support exists. Independent inputs
may share a response; an input that could alter destination/authorization **MUST** be resolved
before issuing targets. A revised destination is a new logical call, never an argument rewrite
under an existing target. Mixed-input scheduling remains outside this profile's reference scope.

### Upload targets

The server chooses the upload target, and with `credentials: "include"` the client attaches a
user credential to a request the server directed. These rules apply to every target:

1. Clients **MUST** reject a `url` that is not an absolute `https` URL.
2. Clients **MUST NOT** connect to an address that the
   [IANA special-purpose registries](https://www.rfc-editor.org/rfc/rfc6890) mark as not
   globally reachable, checked on the address they connect to, unless an operator allowlist
   permits it. Clients **MUST NOT** follow redirects.
3. Clients **MUST** reject a target whose `headers` include `Authorization`, `Cookie`, a
   [forbidden request header](https://fetch.spec.whatwg.org/#forbidden-request-header), or a
   name or value that is not valid under [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#section-5).
4. Clients **MUST** honor `credentials: "include"` only when `url` has the same origin as the MCP
   server's
   [canonical URI](https://modelcontextprotocol.io/specification/draft/basic/authorization/index#canonical-server-uri)
   and a path equal to the canonical path or starting with it followed by `/`. In a gateway
   deployment this is the canonical URI of the server whose credential is attached. Otherwise
   the client **MUST** treat the target as `"omit"` or refuse it.

On stdio there is no canonical URI, so only `omit` targets apply.

## Rationale

### Why an upload input request

Tool context must arrive before storage selection. This revision uses the existing
`InputRequiredResult` envelope and a new upload member, rather than another general-purpose
input-required result. It can share orchestration with other MRTR inputs and keeps full
arguments stable. The [current MRTR rules](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr)
allow only three built-in input-request methods; [issue #2919](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2919)
discusses opening that union. Both request dispatch and response validation need an agreed
extension contract. This proposed files capability cannot supply that core permission by itself.

The earlier `upload_required` result avoids that core dependency, at the cost of separate
result handling. If the group chooses it for near-term deployment, it needs an explicitly
negotiated profile with the same file objects and unchanged arguments but a separately defined
completion channel. It must not silently reinterpret these `inputResponses` as valid under
the earlier draft. This revision specifies only the MRTR profile for review.

### Why a structured object and optional base64 data

Co-locating size and digest with file identity avoids a second metadata map and lets generic
schema validators check their presence and types. The extension imposes a canonical argument
shape using ordinary JSON Schema; `x-mcp-file` identifies the special host handling. A client
ID correlates uploads without a custom URI scheme. A separate display name avoids using a
filename as identity. Binding the target to the current invocation state and file ID avoids
introducing a second public identifier for the same transfer.

Optional `data` gives one binary-safe inline representation with no sentinel. Standard padded
base64 works for every media type; it avoids a second raw-text encoding and the duplicated
media type/escaping rules of a data URI. An empty string has an unambiguous meaning. Requiring
the digest upfront costs a hash pass or host-maintained hash before calling the tool; this
revision accepts that cost to bind both transfer paths to the same immutable bytes.

### Why `omit` and `include`

The working group heard that sending the user's credential has to be optional, so a token never
reaches third-party storage, and that some enterprise deployments reject pre-signed URLs and
want the data plane authorized with the same token as the control plane. A per-target flag
covers both. Tying `include` to the server's canonical URI keeps the token within the resource
it was issued for. The group has not finished listing the authorization methods it needs to
support, and this pair is a starting point.

### Prior art

- SEP-2356, for the declaration keyword, inline encoding, and host rules.
- SEP-2631, for file URIs, digests, transfer descriptors, and the `maxSize` change.
- [SEP-2532](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2532) (resource
  streaming), which Patrick Rodgers offered as a way to get file bytes from a server.
- Storage APIs that separate creating an upload from sending the bytes (pre-signed URLs and
  upload sessions).

## Backward Compatibility

This is an experimental breaking revision of the earlier files draft. URI-string file fields,
pending `_meta`, `upload_required`, server-issued file URIs in arguments and automatic URI
substitution are not this profile. The exact profile values above prevent silent mixing.
Existing unrelated tools keep their schemas. A server exposing this file-object tool to a
client without the profile must provide a separate compatible tool or reject the unsupported
operation; it must not ask a model to synthesize base64 as a fallback.

Unmodified MCP/RMCP cannot dispatch the proposed new input-request member today. An experimental
SDK patch can demonstrate it, but is not interoperability or evidence of core adoption. Tool
schema compilers that reject unknown keywords need support for the `x-mcp-file` annotation.

## Security Implications

[Upload targets](#upload-targets) retains the earlier draft's HTTPS, connected-address, redirect,
header and canonical-credential boundaries. File IDs and names are untrusted labels;
none grants authorization. State binds every file to its specific principal, tool, arguments,
destination and invocation. Duplicate or racing retries require server-side execution records.

Servers validate received bytes, not only claimed size/digest, and apply content policy before
execution. A digest identifies expected content; it does not prove safety or authority. Bound
body sizes, record counts and retry work even for authenticated clients. Treat names as display
metadata, never as trusted paths. Reclaim expired and abandoned uploads. Identical public error
messages for unknown and inaccessible state avoid disclosing another user's file existence.

Hosts and servers **MUST** keep inline bytes, transfer URLs, headers, credentials and opaque
request state out of model context, logs, traces and error details. `_meta` is not a privacy
mechanism by itself; model projection and redaction must be enforced by the implementation.
Server `CallToolResult` content should expose a safe operation summary and intended user-facing
result only. Servers **SHOULD** follow
[OWASP ASVS 5.0 V5](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x14-V5-File-Handling.md)
for accepted file formats.

## Reference Implementation

This revision contains [machine-readable schemas and wire examples](examples/), not a runtime
implementation. A reference implementation must cover object-schema validation, inline and
out-of-band uploads, unchanged arguments, partial completion, negative outcomes, expired and
forged state, mismatched IDs, byte-integrity failures and duplicate finalization. A patched SDK
experiment must be labeled and tested separately from unmodified-core compatibility.

Real OAuth, browser CORS, cloud-store finalization, large streaming transfers, persistence,
cross-replica execution coordination and mixed-input orchestration need integration tests
before production use. Static examples do not validate those properties.

## Open Questions

1. **Envelope and core dependency.** Adopt the MRTR extension mechanism with this profile, or
   define a separate `upload_required` profile and explicit migration? This draft recommends
   MRTR and does not claim the new member is valid in current core.
2. **Mandatory digest.** Is requiring a precomputed SHA-256 acceptable for large browser files,
   or is a weaker, explicitly negotiated profile needed? This revision requires it.
3. **Names and correlation.** Are `id`, `data`, `fileId` and the two outcome
   strings the right public names? An opaque ID avoids implying that a filename is a URI.
4. **Backend receipts.** Define a narrow typed receipt profile for backends requiring client
   commit handles; do not relay arbitrary response headers or URLs as proof.
5. **Authorization methods.** Credential audiences, separate storage credentials, same-origin
   sibling paths and cross-origin targets need focused review. This patch retains the previous
   target policy and does not broaden credential forwarding.
6. **Wrapper/executor discovery.** How can a host obtain the effective file schema when an
   executor hides the inner tool? This draft limits itself to explicitly available schemas.
7. **Typed outputs/resources.** Define download detection and materialization separately;
   generic URLs and familiar object-property names are not sufficient file markers.

## Future Work

- **Downloads.** A download target that mirrors `UploadTarget`, with the same rules.
- **Chunked and resumable transfer**, for backends with per-request size limits and for
  interrupted transfers, once a standard settles.
- **Elicitation forms.** Out-of-band upload for `x-mcp-file` fields in `elicitation/create`.
- **Promotion to the specification**, after the working group has validated the extension in
  use, per its October 2 decision.

## Acknowledgments

This draft builds on SEP-2356 by Olivier Chafik and SEP-2631 by Casey Chow, and on the File
Uploads Working Group's October 2, 2026 meeting with Wil St. Charles, Kurtis Van Gent, Thomas
Sarlandie, and Kryspin Ziemski. Thomas Sarlandie proposed modeling the upload as a
multi-round-trip request.

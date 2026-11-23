# File Uploads and Downloads conformance cases

These conformance cases cover `io.modelcontextprotocol/files` on MCP 2026-07-28 and later. They follow the draft's [Reference Implementation][reference] section. Server and client cases run separately.

| Test case | Input or action | Expected behavior |
| --- | --- | --- |
| [S01][cap] · Inline upload | Use a server that advertises a positive `maxInlineBytes`. Send a valid non-empty inline file within that limit. Omit the extension declaration from the call. | The server accepts the call and uses the decoded bytes. |
| [S06][upload-request], [C06][retry] · Out-of-band upload | Declare `upload`. Send metadata for non-empty files without `data`. Complete the requested uploads. | The server returns a matching target for each file. The client uses those targets and retries with a new JSON-RPC `id`. It keeps the tool name, arguments and settings. It echoes `requestState` exactly. |
| [C07][transfer] · Form upload | Return a valid POST `form` target with ordered fields and `fileField: "payload"`. | The client sends the multipart fields in order. It sends the file part named `payload` last. |
| [C13][targets] · Invalid target | Return an HTTP target outside loopback. Use a reachable address that the address rules allow. | The client rejects the target before it starts a transfer. |
| [S05][initial] · Invalid metadata | Declare `upload`. Send metadata for a non-empty file with `mimeType: "application/octet-stream"`. Omit `data`. | The server should return `isError: true` before it offers an upload target. A missed SHOULD is a warning. |
| [C10][transfer] · Failed transfer | Make every HTTP attempt for one requested upload fail. | The client sends no `tools/call` retry. |
| [S12][retry] · Short write | Declare `upload`. Call with `size: 3` and no `data`. Upload 2 bytes to test storage that accepts the short write. Retry with unchanged arguments and the `requestState` from the upload request. | The server returns `isError: true` before it runs the tool. |
| [S15][repeated] · Consumed `requestState` | Run this case only when the fixture has an unsafe save profile. Complete the retry. Retry with the original arguments and consumed state. Use a new JSON-RPC `id`. | The replay returns `-32602`. The tool runs once. |
| [C11][transfer] · Second upload request | Complete an upload. Answer the client's retry with another `upload_required` result. | The client ends the call without another transfer or retry. |
| [S20][downloads], [C19][downloads] · Download | Declare `download` on each call. Test the server with an unavailable file. Serve valid bytes to the client. Repeat with a short body and with a wrong digest. | The server withholds the target until the file is fetchable. The client accepts the valid transfer. It discards each file that fails the size or digest check. |

## Fixtures

| Tool | Use |
| --- | --- |
| `save_to_folder` | Accept one marked file argument. Report the byte count and digest. For S05, set `x-mcp-file.accept` to `["text/plain"]`. Reject other types in that profile. In the unsafe profile, append a record each time the tool runs. |
| `save_files` | Accept several directly marked file arguments. Exercise target assignment and failure of one upload. |
| `export_orders` | Offer a target for a known file. Control when the file becomes fetchable. |

Use synthetic files and mock HTTP targets for client tests. Use server-issued targets for server tests. For S12, back the target with test storage that accepts a short write and reports the actual byte count.

For out-of-band uploads, the server advertises `upload` and the client declares it. For client downloads, request a file and allow the fetch in the fixture policy.

[reference]: ../specification/draft/file-uploads.md#reference-implementation
[cap]: ../specification/draft/file-uploads.md#capabilities
[upload-request]: ../specification/draft/file-uploads.md#upload-request
[retry]: ../specification/draft/file-uploads.md#retry
[transfer]: ../specification/draft/file-uploads.md#transfer
[targets]: ../specification/draft/file-uploads.md#targets
[initial]: ../specification/draft/file-uploads.md#initial-call
[repeated]: ../specification/draft/file-uploads.md#repeated-retries
[downloads]: ../specification/draft/file-uploads.md#downloads

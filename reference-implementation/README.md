# Reference Implementation: File Uploads and Downloads Extension

A working TypeScript reference implementation of the
[`io.modelcontextprotocol/files`](../specification/draft/file-uploads.md) draft extension.

It implements the full upload flow (inline and out-of-band), the download flow,
target validation, the `requestState` lifecycle, and the conformance scenarios
listed in the draft's [Reference Implementation](../specification/draft/file-uploads.md#reference-implementation)
section — plus extras for the error table.

## Layout

| Path | Role |
| --- | --- |
| `src/types.ts` | `FileInput`, `UploadTarget`, `UploadRequiredResult`, `DownloadTarget`, JSON Schema instance equality |
| `src/targets.ts` | Target validation (all five client MUST-reject rules), `path` resolution |
| `src/store.ts` | Local object store: staging, one-write, confirm (size + digest), finalize |
| `src/request-state.ts` | `requestState` issue / verify / atomic consume with expiry |
| `src/multipart.ts` | `multipart/form-data` encoding (WHATWG filename rules) and parsing |
| `src/server.ts` | Extension logic: capabilities, `upload_required`, retry steps 1–5, error table |
| `src/client.ts` | Client transfer helper: declare, validate targets, transfer, retry, download |
| `src/http.ts` | Minimal HTTP endpoint carrying JSON-RPC + upload/download targets |
| `test/conformance.ts` | 20 scenarios (the 10 from the draft + 10 extras) |

## Running

```bash
npm install
npm test        # 20 conformance scenarios
npm run typecheck
```

## Conformance scenarios

The draft names ten scenarios. This implementation covers all of them, plus
extras for the [Errors](../specification/draft/file-uploads.md#error) table and
security rules:

| # | Draft scenario | Test |
| --- | --- | --- |
| 1 | Inline transfer | `1. inline transfer` |
| 2 | Out-of-band transfer | `2. out-of-band transfer` |
| 3 | A `form` target | `3. form target` |
| 4 | Target rejection | `4. target rejection` |
| 5 | Rejection on metadata | `5. rejection on metadata` |
| 6 | Failed transfer with no retry | `6. failed transfer with no retry` |
| 7 | Size mismatch | `7. size mismatch` |
| 8 | Consumed `requestState` | `8. consumed requestState` |
| 9 | A second upload request | `9. second upload request` |
| 10 | Download | `10. download` |
| A | Missing `upload` capability | `-32021` |
| B | Missing `download` capability | `-32021` |
| D | Inline over `maxInlineBytes` | `isError` |
| E | Digest mismatch | `isError` |
| F | Empty file (size 0) | no target, tool runs |
| G | Backward compatibility | `tools/list` omits `x-mcp-file` tools |
| H | Redirects | `3xx` = failed transfer, no retry |
| I | Binding mismatch on retry | `-32602` |
| J | Capability advertisement | `server/discover` |

## What this implementation demonstrates

- **Bytes never enter JSON-RPC.** Inline `data` is base64 inside `tools/call`
  only for small files; out-of-band transfers go straight to a target.
- **`upload_required` + MRTR retry.** The server returns a target list and an
  opaque `requestState`; the client uploads and retries with the same
  arguments and the echoed token.
- **Retry steps 1–5 in order.** Verify `requestState`, check the binding
  (JSON Schema instance equality), confirm bytes with storage, consume
  atomically (the tool is unsafe to run twice), then finalize and run.
- **Staging.** Targets write to a staging location, one write per entry.
  Finalize copies confirmed bytes into `final/` only on the retry.
- **Target validation.** All five client MUST-reject rules from the draft,
  including `path` resolution against the MCP address and the stdio rule
  (HTTP loopback only under an operator allowlist).
- **`multipart/form-data`.** Fields in array order, file last, WHATWG
  filename encoding, ≥128-bit boundary randomness, no `filename*`.
- **Error table.** `-32021` for missing capabilities, `-32602` for
  `requestState` failures, `isError: true` for metadata / size / digest /
  byte-confirmation failures — the tool never runs on a rejected call.

## Simplifications (documented for reviewers)

- The HTTP transport is a minimal JSON-RPC endpoint, not a full
  Streamable HTTP implementation. The extension logic is the focus.
- The object store is local filesystem, standing in for any storage API
  that can accept a PUT/POST and answer a confirm (HEAD / status query).
- `save_to_folder` is treated as unsafe to run twice, so `requestState` is
  consumed atomically before the tool runs. An idempotent tool would skip
  consumption per [Repeated Retries](../specification/draft/file-uploads.md#repeated-retries).
- Authentication is not exercised; `principal` binding is present in
  `requestState` but always `null` in tests.

## Open questions this implementation touches

1. **Finalize** — the store finalizes on the retry (step 5); no commit
   handle is carried in the retry. Scenario 7 shows the confirm step
   catching a size mismatch before finalize.
2. **Failure signal** — a failed transfer simply never retries; the server
   learns only by expiry (no early-abort signal), matching Open Question 5.
3. **Integrity** — `digest` is verified when present in the schema
   (scenarios E and 7); it remains optional per Open Question 7.

## License

Apache-2.0. See [`../LICENSE`](../LICENSE).

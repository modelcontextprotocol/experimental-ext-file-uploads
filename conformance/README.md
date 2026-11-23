# File Uploads conformance

The [test cases](test-cases.md) describe the four scenarios. The suite runs them on MCP `2026-07-28` and validates the JSON-RPC messages it sees. The [scenarios](src/scenarios/files/) and [fixtures](examples/) are TypeScript files in this repository.

Run these commands from the repository root with npm and Node.js 22.12+ on the 22.x line or Node.js 24+.

```sh
npm ci --prefix conformance
node conformance/run.mjs
```

Run all four scenarios against the SDK fixtures.

```sh
node conformance/run.mjs sdk typescript
node conformance/run.mjs sdk go ../go-sdk
```

The TypeScript run uses SDK 2.4.0 for discovery, tool listing, and HTTP transport. The fixture handles the extension-defined `upload_required` result over the SDK transport. The Go run builds the client and server fixtures from the supplied Go SDK checkout, which needs the File Uploads changes.

To test a different implementation, run a named scenario. The runner appends the mock server URL to the client command and sets `MCP_CONFORMANCE_SCENARIO`, `MCP_CONFORMANCE_PROTOCOL_VERSION`, and `MCP_CONFORMANCE_CONTEXT`.

```sh
node conformance/run.mjs list
node conformance/run.mjs server --url http://127.0.0.1:8080/mcp --scenario file-uploads-server-upload
node conformance/run.mjs client --scenario file-uploads-client-download -- /path/to/client
```

The default timeout is 30 seconds for a client process or a full server scenario. Set `--timeout <ms>` to use a different timeout. Set `--output-dir <directory>` to save the checks to `checks.json` in a new run directory. The report includes client process failures and server scenario timeouts.

The HTTP test helpers and [pinned wire schema](src/spec-types/draft.schema.json) come from [MCP Conformance at `96a6f94`](https://github.com/modelcontextprotocol/conformance/tree/96a6f9478b7f2e125cf0360a213383cf57533893). See the [Conformance license](CONFORMANCE-LICENSE).

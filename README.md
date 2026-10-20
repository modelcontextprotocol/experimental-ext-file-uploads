# experimental-ext-file-uploads

Experimental MCP extension for sending files from a client to a tool out of band, so the bytes
stay out of model context and out of JSON-RPC messages. Maintained by the
[File Uploads Working Group](https://modelcontextprotocol.io/community/working-groups/file-uploads).

> [!IMPORTANT]
> This is an [experimental extension](https://modelcontextprotocol.io/extensions/overview#experimental-extensions).
> It is not part of the MCP specification and has not been proposed as a SEP. Expect breaking
> changes while the working group iterates.

## Overview

A server marks file arguments in a tool's input schema. Each file argument contains its metadata
and optional base64 data. When data is absent, the server rejects the call or requests an upload.
The client uploads the bytes and retries with unchanged arguments and per-file outcomes.

The draft is in [`specification/draft/file-uploads.md`](specification/draft/file-uploads.md).
The reference implementation will live in this repository.

## Background

- [Working group meeting notes, October 2, 2026](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3412)
- [SEP-2356: Declarative File Inputs](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2356)
  (closed), source of the `x-mcp-file` keyword and inline encoding
- [SEP-2631: File Objects and Transfer](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631),
  prior art for file URIs and transfer descriptors
- [SEP-2532: Resource Streaming](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2532),
  related work on getting file bytes from a server

## Participating

The working group meets weekly and discusses this work in its thread on the
[MCP Discord](https://modelcontextprotocol.io/community/communication#discord). Open an issue or
pull request here for anything specific to the draft.

We want to hear whether the flow fits your storage backend's upload API, which
[open questions](specification/draft/file-uploads.md#open-questions) block you, and whether
anything in the security model would stop you from deploying it.

## License

Apache 2.0. See [LICENSE](LICENSE).

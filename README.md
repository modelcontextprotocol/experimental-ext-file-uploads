# experimental-ext-file-uploads

Experimental MCP extension for handing files from a client to a tool without routing the
bytes through the model or through JSON-RPC. Maintained by the
[File Uploads Working Group](https://modelcontextprotocol.io/community/working-groups/file-uploads).

> [!IMPORTANT]
> This is an [experimental extension](https://modelcontextprotocol.io/extensions/overview#experimental-extensions).
> It is not part of the MCP specification, has not been proposed as a SEP, and will change
> without notice while the working group iterates on it. Do not ship it in production clients
> or servers.

## What this is

A server marks file-valued tool arguments in its input schema. When a client calls such a
tool with a file that is too large to inline, it sends the file's metadata with the other
arguments; the server either rejects the call on that basis or answers with an upload target
inside a multi-round-trip `InputRequiredResult`; the client sends the bytes out of band and
retries the call with the server-issued file URI. Small files travel inline as `data:` URIs.
No new top-level methods, no session state.

The working draft is in [`specification/draft/file-uploads.md`](specification/draft/file-uploads.md).
A reference implementation will live in this repository alongside it.

## Background

- [Files Working Group meeting notes, October 2, 2026](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3412),
  where the group settled the problem statement, the metadata-first ordering, and the
  decision to build on multi-round-trip requests and ship as an extension first.
- [SEP-2356: Declarative File Inputs](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2356)
  (closed), which this draft reuses for the `x-mcp-file` keyword and inline encoding.
- [SEP-2631: File Objects and Transfer](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631),
  prior art for file URIs and transfer descriptors, which this work is expected to supersede
  for the upload direction.
- [SEP-2532: Resource Streaming](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2532),
  adjacent work on the download direction.

## Participating

Discussion happens in the Files WG thread on the
[MCP Discord](https://modelcontextprotocol.io/community/communication#discord) and in issues
and pull requests here. The group meets weekly; notes are posted as GitHub Discussions in the
main specification repository.

Feedback that is most useful right now: whether the flow in the draft maps onto your storage
backend's upload API, which of the [open questions](specification/draft/file-uploads.md#open-questions)
matter to you, and anything in the security model that would stop you from deploying it.

## License

Apache 2.0, see [LICENSE](LICENSE).

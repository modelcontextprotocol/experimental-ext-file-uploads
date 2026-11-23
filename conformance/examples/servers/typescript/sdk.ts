import {
  classifyInboundRequest,
  createMcpHandler,
  isJsonContentType,
  PerRequestHTTPServerTransport,
  Server,
  type ListToolsResult,
  type Result
} from '@modelcontextprotocol/server';
import express, { type ErrorRequestHandler } from 'express';
import { JsonRpcError } from '../../../src/connection';
import type { RequestHandlers } from '../../../src/mock-server';
import {
  listenFixture,
  withRequiredDraftResultFields,
  type StatelessMockOptions
} from '../../../src/mock-server/stateless';
import { CLIENT_CAPABILITIES_META } from '../../../src/scenarios/files/common';
import { DRAFT_PROTOCOL_VERSION, type SpecVersion } from '../../../src/types';

const BASE64_PREFIX = '=?base64?';
const BASE64_VALUE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function mcpNameMatches(header: string | undefined, name: unknown): boolean {
  if (header === undefined || typeof name !== 'string') return false;
  if (!header.startsWith(BASE64_PREFIX) || !header.endsWith('?=')) {
    return header === name;
  }
  const encoded = header.slice(BASE64_PREFIX.length, -2);
  if (!BASE64_VALUE.test(encoded)) return false;
  try {
    return (
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(encoded, 'base64')
      ) === name
    );
  } catch {
    return false;
  }
}

/** Serve the common fixture over the published TypeScript SDK. Core methods
 * use Server and createMcpHandler. The Files result uses the public per-request
 * transport because the core tool result codec does not accept upload_required. */
export function serveTypeScriptSdk(
  handlers: RequestHandlers,
  _version: SpecVersion = DRAFT_PROTOCOL_VERSION,
  options: StatelessMockOptions = {}
) {
  const app = express();
  options.mountRoutes?.(app);
  const core = createMcpHandler(
    () => {
      const server = new Server(
        { name: 'typescript-file-uploads-fixture', version: '1' },
        { capabilities: { tools: {}, ...options.capabilities } }
      );
      server.setRequestHandler('tools/list', async (request, ctx) => {
        const params = {
          ...request.params,
          _meta: {
            ...request.params?._meta,
            [CLIENT_CAPABILITIES_META]: server.getClientCapabilities()
          }
        };
        return (await handlers['tools/list'](params, {
          jsonrpc: '2.0',
          id: ctx.mcpReq.id,
          method: 'tools/list',
          params
        })) as ListToolsResult;
      });
      return server;
    },
    { legacy: 'reject' }
  );

  app.post('/mcp', express.json(), async (req, res) => {
    const headers = new Headers();
    for (const [name, values] of Object.entries(req.headersDistinct)) {
      for (const value of values ?? []) headers.append(name, value);
    }
    const request = new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers
    });
    const body: unknown = req.body;
    const protocolVersionHeader =
      headers.get('MCP-Protocol-Version') ?? undefined;
    const mcpMethodHeader = headers.get('Mcp-Method') ?? undefined;
    const mcpNameHeader = headers.get('Mcp-Name') ?? undefined;
    const outcome = classifyInboundRequest({
      httpMethod: 'POST',
      protocolVersionHeader,
      mcpMethodHeader,
      mcpNameHeader,
      body
    });
    // The classifier checks the envelope. Send header errors to the SDK HTTP handler.
    const response =
      outcome.kind === 'modern' &&
      outcome.messageKind === 'request' &&
      outcome.message.method === 'tools/call' &&
      protocolVersionHeader === DRAFT_PROTOCOL_VERSION &&
      mcpMethodHeader !== undefined &&
      mcpNameMatches(mcpNameHeader, outcome.message.params?.name) &&
      isJsonContentType(headers.get('Content-Type'))
        ? await serveToolCall(outcome, request, handlers)
        : await core.fetch(request, { parsedBody: body });
    res.status(response.status);
    for (const [name, value] of response.headers) res.setHeader(name, value);
    res.end(await response.text());
  });
  const onError: ErrorRequestHandler = (error, _req, res, next) => {
    const message = 'The SDK fixture could not process the request.';
    if (res.headersSent) {
      next(new Error(message));
      return;
    }
    const status = error?.status === 400 ? 400 : 500;
    res.status(status).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: status === 400 ? -32700 : -32603, message }
    });
  };
  app.use(onError);
  return listenFixture(app, options.host);
}

async function serveToolCall(
  outcome: Extract<
    ReturnType<typeof classifyInboundRequest>,
    { kind: 'modern'; messageKind: 'request' }
  >,
  request: Request,
  handlers: RequestHandlers
): Promise<Response> {
  const transport = new PerRequestHTTPServerTransport({
    classification: outcome.classification,
    responseMode: 'json'
  });
  const { message } = outcome;
  const envelope = { jsonrpc: '2.0' as const, id: message.id };
  async function sendResult() {
    try {
      const result = await handlers['tools/call'](
        message.params ?? {},
        message
      );
      await transport.send({
        ...envelope,
        result: withRequiredDraftResultFields('tools/call', result) as Result
      });
    } catch (error) {
      await transport.send({
        ...envelope,
        error:
          error instanceof JsonRpcError
            ? { code: error.code, message: error.message, data: error.data }
            : { code: -32603, message: 'Internal error.' }
      });
    }
  }
  transport.onmessage = () => {
    void sendResult().catch(() => transport.close());
  };
  await transport.start();
  try {
    return await transport.handleMessage(message, { request });
  } finally {
    await transport.close();
  }
}

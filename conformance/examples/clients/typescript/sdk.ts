import {
  Client,
  StreamableHTTPClientTransport,
  type ClientCapabilities,
  type JSONRPCMessage,
  type JSONRPCRequest
} from '@modelcontextprotocol/client';
import {
  JsonRpcError,
  withRequestMeta,
  type ConnectOptions
} from '../../../src/connection';
import {
  CLIENT_CAPABILITIES_META,
  record
} from '../../../src/scenarios/files/common';
import { DRAFT_PROTOCOL_VERSION, type SpecVersion } from '../../../src/types';

/** The published SDK handles discovery and listing. Its public transport
 * carries the extension-defined result while the fixture drives the transfer. */
export async function connectTypeScriptSdk(
  serverUrl: string,
  version: SpecVersion = DRAFT_PROTOCOL_VERSION,
  options: ConnectOptions = {}
) {
  const endpoint = new URL(serverUrl);
  const capabilities = options.capabilities ?? {};
  const client = new Client(
    { name: 'typescript-file-uploads-fixture', version: '1' },
    {
      versionNegotiation: { mode: { pin: version } },
      capabilities: capabilities as ClientCapabilities
    }
  );
  const connection = new StreamableHTTPClientTransport(endpoint);
  try {
    await client.connect(connection);
  } catch (error) {
    await connection.close();
    throw error;
  }
  let nextId = 0;

  async function requestWithEndpoint<R>(
    method: string,
    params?: Record<string, unknown>,
    extraHeaders?: Record<string, string>
  ): Promise<{ result: R; endpoint: string }> {
    if (method === 'tools/list') {
      return { result: (await client.listTools()) as R, endpoint: serverUrl };
    }
    let responseUrl = serverUrl;
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: extraHeaders },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        responseUrl = response.url || serverUrl;
        return response;
      }
    });
    const id = 'files-' + ++nextId;
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params: withRequestMeta(
        {
          ...params,
          _meta: {
            [CLIENT_CAPABILITIES_META]: capabilities,
            ...record(params?._meta)
          }
        },
        version
      ) as JSONRPCRequest['params']
    };
    await transport.start();
    const signal = AbortSignal.timeout(10000);
    try {
      const response = await new Promise<JSONRPCMessage>((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('SDK request timed out.')),
          { once: true }
        );
        transport.onerror = () => reject(new Error('SDK transport failed.'));
        transport.onmessage = (message) => {
          if ('id' in message && message.id === id) resolve(message);
        };
        void transport.send(request, { requestSignal: signal }).catch(() => {
          reject(new Error('SDK transport failed.'));
        });
      });
      if ('error' in response) {
        throw new JsonRpcError(
          response.error.code,
          'File Uploads tool request failed.'
        );
      }
      if (!('result' in response))
        throw new Error('SDK response has no result.');
      return { result: response.result as R, endpoint: responseUrl };
    } finally {
      await transport.close();
    }
  }

  return {
    async request<R>(
      method: string,
      params?: Record<string, unknown>,
      extraHeaders?: Record<string, string>
    ) {
      return (await requestWithEndpoint<R>(method, params, extraHeaders))
        .result;
    },
    requestWithEndpoint,
    notifications: [],
    async discover() {
      return { capabilities: client.getServerCapabilities() };
    },
    close: () => client.close()
  };
}

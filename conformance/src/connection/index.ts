import type { JSONRPCNotification } from '../jsonrpc';
import type { SpecVersion } from '../types';

export interface ConnectOptions {
  capabilities?: Record<string, unknown>;
  clientInfo?: { name: string; version: string };
  redactWirePayloads?: boolean;
  requireMatchingResponseId?: boolean;
  signal?: AbortSignal;
}

export interface Connection {
  request<R = unknown>(
    method: string,
    params?: Record<string, unknown>,
    extraHeaders?: Record<string, string>
  ): Promise<R>;
  requestWithEndpoint?<R = unknown>(
    method: string,
    params?: Record<string, unknown>,
    extraHeaders?: Record<string, string>
  ): Promise<{ result: R; endpoint: string }>;
  readonly notifications: JSONRPCNotification[];
  discover(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface RunContext {
  serverUrl: string;
  specVersion: SpecVersion;
  signal?: AbortSignal;
  connect(opts?: ConnectOptions): Promise<Connection>;
}

export class JsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export {
  buildStandardHeaders,
  connectStateless,
  sendStatelessRequest,
  withRequestMeta
} from './stateless';

import type { JSONRPCRequest } from '../jsonrpc';
import type { SpecVersion } from '../types';

export type RequestHandlers = Record<
  string,
  (
    params: Record<string, unknown>,
    request: JSONRPCRequest
  ) => unknown | Promise<unknown>
>;

export interface MockServer {
  url: string;
  baseUrl: string;
  /** Requests in arrival order, excluding server/discover. */
  readonly recorded: JSONRPCRequest[];
  close(): Promise<void>;
}

export interface ScenarioContext {
  specVersion: SpecVersion;
}

export { createServerStateless } from './stateless';

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCRequest extends JSONRPCNotification {
  id: number | string;
}

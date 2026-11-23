import http from 'node:http';
import { describe, expect, test } from 'vitest';
import { DRAFT_PROTOCOL_VERSION } from '../types';
import { takeWireViolations } from '../validation/wire-schema';
import { connectStateless } from './stateless';

describe('File Uploads stateless connection', () => {
  test.each(['JSON', 'SSE'] as const)(
    'rejects mixed request and result members in %s replies',
    async (format) => {
      const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const { id } = JSON.parse(raw);
        const reply = {
          jsonrpc: '2.0',
          id,
          result: { resultType: 'complete', content: [] }
        };
        if (format === 'JSON') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...reply, method: 'tools/call' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(
            'data: ' +
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                result: reply.result
              }) +
              '\n\n'
          );
          res.end('data: ' + JSON.stringify(reply) + '\n\n');
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      const { port } = server.address() as { port: number };
      try {
        const conn = await connectStateless(`http://127.0.0.1:${port}/mcp`);
        await expect(
          conn.request('tools/call', { name: 'fixture' })
        ).rejects.toThrow('Expected a JSON-RPC response envelope');
      } finally {
        takeWireViolations();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

  test.each([
    'rpc error',
    'unexpected JSON',
    'non-JSON',
    'SSE request'
  ] as const)('redacts peer payloads in the %s exception', async (variant) => {
    const marker = 'sensitive-file-state';
    const server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { id } = JSON.parse(raw);
      const base = { jsonrpc: '2.0', id };
      if (variant === 'non-JSON') {
        res.writeHead(502, { 'Content-Type': 'text/plain; marker=' + marker });
        res.end(marker);
      } else if (variant === 'SSE request') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          'data: ' +
            JSON.stringify({ ...base, id: 'server', method: marker }) +
            '\n\n'
        );
        res.end(
          'data: ' +
            JSON.stringify({
              ...base,
              result: {
                resultType: 'complete',
                tools: [],
                ttlMs: 0,
                cacheScope: 'private'
              }
            }) +
            '\n\n'
        );
      } else {
        res.writeHead(variant === 'rpc error' ? 400 : 502, {
          'Content-Type': 'application/json'
        });
        res.end(
          JSON.stringify({
            ...base,
            error:
              variant === 'rpc error'
                ? {
                    code: -32602,
                    message: marker,
                    data: { requestState: marker }
                  }
                : marker
          })
        );
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const { port } = server.address() as { port: number };
    try {
      const conn = await connectStateless(
        `http://127.0.0.1:${port}/mcp`,
        DRAFT_PROTOCOL_VERSION,
        { redactWirePayloads: true, requireMatchingResponseId: true }
      );
      const request = conn.request('tools/list');
      if (variant === 'rpc error' || variant === 'SSE request') {
        await expect(request).rejects.toMatchObject({
          code: variant === 'rpc error' ? -32602 : -32600,
          data: undefined
        });
      }
      await expect(request).rejects.toBeInstanceOf(Error);
      const error = await request.catch((error: Error) => error);
      expect(String(error)).not.toContain(marker);
    } finally {
      takeWireViolations();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

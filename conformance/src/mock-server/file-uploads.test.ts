import { describe, expect, it, vi } from 'vitest';
import { sendStatelessRequest } from '../connection/stateless';
import { DRAFT_PROTOCOL_VERSION } from '../types';
import { createServerStateless } from './stateless';

describe('File Uploads mock server redaction', () => {
  it('redacts malformed JSON from the response and parser logs', async () => {
    const srv = await createServerStateless({}, DRAFT_PROTOCOL_VERSION, {
      redactWirePayloads: true,
      mountRoutes: (app) => {
        app.set('env', 'development');
      }
    });
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const marker = 'opaque-file-request-state';
      const res = await fetch(srv.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'x' + marker
      });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).not.toContain(marker);
      expect(JSON.parse(body)).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Could not process the request body.' }
      });
      expect(logError).not.toHaveBeenCalled();
    } finally {
      logError.mockRestore();
      await srv.close();
    }
  });

  it('redacts unexpected handler errors when wire redaction is enabled', async () => {
    const srv = await createServerStateless(
      {
        'tools/list': () => {
          throw new Error('opaque-file-request-state');
        }
      },
      DRAFT_PROTOCOL_VERSION,
      { redactWirePayloads: true }
    );
    try {
      const { status, body } = await sendStatelessRequest(
        srv.url,
        'tools/list'
      );
      expect(status).toBe(500);
      expect(body?.error).toEqual({ code: -32603, message: 'Internal error.' });
    } finally {
      await srv.close();
    }
  });
});

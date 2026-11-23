import express from 'express';
import { describe, expect, it } from 'vitest';
import {
  buildStandardHeaders,
  sendStatelessRequest,
  withRequestMeta
} from '../connection/stateless';
import { createServerStateless } from '../mock-server';
import { DRAFT_PROTOCOL_VERSION, FILES_EXTENSION_ID } from '../types';
import {
  takeWireViolations,
  validateWireMessage,
  wireSchemaChecks,
  wireSchemaErrors
} from './wire-schema';

const stagedUploadResult = {
  resultType: 'upload_required',
  uploads: [{ fileId: 'file-1', path: '/upload', credentials: 'omit' }],
  requestState: 'opaque-state'
};

function serveWireResult(result: unknown) {
  return createServerStateless({}, DRAFT_PROTOCOL_VERSION, {
    host: '127.0.0.1',
    mountRoutes: (app) => {
      app.post('/mcp', express.json(), (req, res) => {
        res.json({ jsonrpc: '2.0', id: req.body.id, result });
      });
    }
  });
}

describe('File Uploads wire schema', () => {
  it('rejects mixed JSON-RPC envelopes before classifying them', () => {
    const call = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: withRequestMeta({ name: 'save_to_folder' })
    };
    const error = { code: -32602, message: 'Invalid arguments' };
    for (const message of [
      { ...call, result: stagedUploadResult },
      { ...call, error },
      { jsonrpc: '2.0', id: 2, result: stagedUploadResult, error }
    ]) {
      expect(wireSchemaErrors(DRAFT_PROTOCOL_VERSION, message)).toEqual([
        'JSONRPCMessage: invalid JSON-RPC response envelope'
      ]);
    }
  });

  it('validates the upload_required envelope while leaving extension fields to the scenario', () => {
    const upload = {
      jsonrpc: '2.0',
      id: 3,
      result: stagedUploadResult
    };
    expect(
      wireSchemaErrors(DRAFT_PROTOCOL_VERSION, upload, 'tools/call')
    ).toEqual([]);
    expect(
      wireSchemaErrors(
        DRAFT_PROTOCOL_VERSION,
        { ...upload, result: { resultType: 'upload_required' } },
        'tools/call'
      )
    ).toEqual([]);
    expect(
      wireSchemaErrors(
        DRAFT_PROTOCOL_VERSION,
        { ...upload, id: false },
        'tools/call'
      )
    ).not.toEqual([]);
  });

  it('restricts upload_required to tools/call on supported revisions', () => {
    const upload = { jsonrpc: '2.0', id: 3, result: stagedUploadResult };
    expect(
      wireSchemaErrors(DRAFT_PROTOCOL_VERSION, upload, 'tools/list')
    ).toEqual([expect.stringContaining('upload_required requires tools/call')]);
    expect(wireSchemaErrors('2025-11-25', upload, 'tools/call')).toEqual([
      expect.stringContaining('MCP 2026-07-28 or later')
    ]);
    // A response with the core tool fields still cannot use an ineligible discriminator.
    expect(
      wireSchemaErrors(
        '2025-11-25',
        { ...upload, result: { ...stagedUploadResult, content: [] } },
        'tools/call'
      )
    ).not.toEqual([]);
  });

  it.each([
    ['absent', {}, 'FAILURE'],
    [
      'download only',
      { extensions: { [FILES_EXTENSION_ID]: { download: {} } } },
      'FAILURE'
    ],
    [
      'upload',
      { extensions: { [FILES_EXTENSION_ID]: { upload: {} } } },
      'SUCCESS'
    ]
  ] as const)(
    'checks upload_required against the request extension settings (%s)',
    async (_name, capabilities, status) => {
      const fixture = await serveWireResult(stagedUploadResult);
      try {
        await sendStatelessRequest(fixture.url, 'tools/call', {
          name: 'save_to_folder',
          _meta: { 'io.modelcontextprotocol/clientCapabilities': capabilities }
        });
        const [check] = wireSchemaChecks(DRAFT_PROTOCOL_VERSION);
        expect(check).toMatchObject({ id: 'wire-schema-valid', status });
        if (status === 'FAILURE') {
          expect(check.errorMessage).toContain(
            'the tools/call request must declare upload support'
          );
          expect(JSON.stringify(check)).not.toContain(
            stagedUploadResult.requestState
          );
        }
      } finally {
        await fixture.close();
      }
    }
  );

  it('dispatches a valid tools/call with deeply nested arguments', async () => {
    const fixture = await createServerStateless(
      {
        'tools/call': () => ({
          content: [{ type: 'text', text: 'Dispatched' }]
        })
      },
      DRAFT_PROTOCOL_VERSION,
      { host: '127.0.0.1' }
    );
    try {
      const value = JSON.parse('['.repeat(4000) + 'null' + ']'.repeat(4000));
      const params = withRequestMeta({ name: 'nested', arguments: { value } });
      const response = await fetch(fixture.url, {
        method: 'POST',
        headers: buildStandardHeaders('tools/call', params),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params
        })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { content: [{ type: 'text', text: 'Dispatched' }] }
      });
      expect(wireSchemaChecks(DRAFT_PROTOCOL_VERSION)).toEqual([
        expect.objectContaining({
          status: 'SUCCESS',
          details: { messagesValidated: 2, violations: [] }
        })
      ]);
    } finally {
      await fixture.close();
    }
  });

  it('redacts File Uploads payloads before recording invalid envelopes', () => {
    const secrets = {
      url: 'https://storage.example/upload?sig=synthetic-signature',
      header: 'synthetic-header-value',
      field: 'synthetic-form-value',
      state: 'synthetic-request-state',
      data: 'c3ludGhldGljIGZpbGU='
    };
    validateWireMessage(
      DRAFT_PROTOCOL_VERSION,
      {
        jsonrpc: '2.0',
        id: false,
        result: {
          resultType: 'upload_required',
          uploads: [
            {
              fileId: 'file-1',
              url: secrets.url,
              headers: { 'X-Storage-Token': secrets.header },
              form: { fields: [{ name: 'policy', value: secrets.field }] }
            }
          ],
          requestState: secrets.state
        }
      },
      {
        origin: 'implementation',
        context: 'upload response',
        requestMethod: 'tools/call'
      }
    );
    validateWireMessage(
      DRAFT_PROTOCOL_VERSION,
      {
        jsonrpc: '2.0',
        id: false,
        method: 'tools/call',
        params: withRequestMeta({
          name: 'save_to_folder',
          arguments: {
            file: {
              id: 'file-1',
              mimeType: 'text/plain',
              size: 14,
              data: secrets.data
            }
          }
        })
      },
      { origin: 'implementation', context: 'undeclared inline request' }
    );
    validateWireMessage(
      DRAFT_PROTOCOL_VERSION,
      {
        jsonrpc: '2.0',
        id: false,
        result: {
          resultType: 'complete',
          content: [{ type: 'text', text: secrets.url }],
          _meta: { [FILES_EXTENSION_ID]: { downloads: [{ url: secrets.url }] } }
        }
      },
      {
        origin: 'implementation',
        context: 'download response',
        requestMethod: 'tools/call'
      }
    );

    const { violations } = takeWireViolations();
    expect(violations).toHaveLength(3);
    for (const violation of violations) {
      expect(violation.message).toBe('[File Uploads payload redacted]');
      expect(violation.errors.join(' ')).toContain('RequestId');
    }
    const details = JSON.stringify(violations);
    for (const secret of Object.values(secrets))
      expect(details).not.toContain(secret);
  });

  it('redacts a malformed reply when the request identifies File Uploads', async () => {
    const state = 'synthetic-state-echoed-as-result-type';
    const fixture = await serveWireResult({ resultType: state });
    try {
      const response = await sendStatelessRequest(fixture.url, 'tools/call', {
        name: 'save_to_folder',
        requestState: state,
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: { [FILES_EXTENSION_ID]: { upload: {} } }
          }
        }
      });
      expect(response.body?.result?.resultType).toBe(state);
      const [check] = wireSchemaChecks(DRAFT_PROTOCOL_VERSION);
      expect(check.status).toBe('FAILURE');
      expect(check.errorMessage).toContain('CallToolResult');
      expect(JSON.stringify(check)).not.toContain(state);
    } finally {
      await fixture.close();
    }
  });
});

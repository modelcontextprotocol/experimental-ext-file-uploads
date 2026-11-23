import { describe, expect, it, vi } from 'vitest';
import { buildStandardHeaders, withRequestMeta } from '../../../src/connection';
import {
  CLIENT_CAPABILITIES_META,
  UPLOAD_SETTINGS,
  fileCapabilities
} from '../../../src/scenarios/files/common';
import { DRAFT_PROTOCOL_VERSION } from '../../../src/types';
import { serveTypeScriptSdk } from './sdk';

const uploadRequired = {
  resultType: 'upload_required',
  requestState: 'fixture-state',
  uploads: [{ fileId: 'file', path: '/storage/file', credentials: 'omit' }]
};

async function callFixture(name: string, header: string, value: string | null) {
  const save = vi.fn(() => uploadRequired);
  const fixture = await serveTypeScriptSdk(
    { 'tools/list': () => ({ tools: [] }), 'tools/call': save },
    DRAFT_PROTOCOL_VERSION,
    { host: '127.0.0.1' }
  );
  try {
    const method = 'tools/call';
    const params = withRequestMeta({
      name,
      _meta: { [CLIENT_CAPABILITIES_META]: fileCapabilities(UPLOAD_SETTINGS) }
    });
    const headers = new Headers(buildStandardHeaders(method, params));
    if (value === null) headers.delete(header);
    else headers.set(header, value);
    const response = await fetch(fixture.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    return { status: response.status, body: await response.json(), save };
  } finally {
    await fixture.close();
  }
}

describe('TypeScript SDK fixture headers', () => {
  it.each([
    ['MCP-Protocol-Version', null],
    ['Mcp-Method', null],
    ['Mcp-Name', null],
    ['Mcp-Name', 'another-tool'],
    ['Mcp-Name', '=?base64?bad-value?=']
  ])('rejects %s %s before calling the tool', async (header, value) => {
    const { status, body, save } = await callFixture(
      'save_to_folder',
      header,
      value
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ id: 1, error: { code: -32020 } });
    expect(save).not.toHaveBeenCalled();
  });

  it('accepts an encoded matching tool name and returns upload_required', async () => {
    const name = 'résumé';
    const encoded = '=?base64?' + Buffer.from(name).toString('base64') + '?=';
    const { status, body, save } = await callFixture(name, 'Mcp-Name', encoded);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: 1, result: uploadRequired });
    expect(save).toHaveBeenCalledOnce();
  });
});

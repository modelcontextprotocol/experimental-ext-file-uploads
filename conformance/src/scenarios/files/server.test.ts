import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { startFileUploadsServer } from '../../../examples/servers/typescript/file-uploads-server';
import {
  buildStandardHeaders,
  sendStatelessRequest,
  withRequestMeta
} from '../../connection';
import { createServerStateless } from '../../mock-server';
import { runServerConformanceTest } from '../../runner';
import { DRAFT_PROTOCOL_VERSION, type ConformanceCheck } from '../../types';
import { withWireRecorder } from '../../validation/wire-schema';
import {
  CLIENT_CAPABILITIES_META,
  DOWNLOAD_SETTINGS,
  FILES_EXTENSION_ID,
  UPLOAD_SETTINGS,
  declaredFiles,
  fileCapabilities,
  fileSummary,
  markedFile,
  readDownloadTarget,
  readUploadRequest,
  resolveTarget,
  type FileInput
} from './common';
import { ORDER_BYTES, ORDER_MIME_TYPE } from './samples';

function withoutSuccess(checks: ConformanceCheck[]) {
  return Object.fromEntries(
    checks
      .filter(({ status }) => status !== 'SUCCESS')
      .map(({ id, status }) => [id, status])
  );
}

async function runFixture(
  scenario: 'upload' | 'download',
  options?: Parameters<typeof startFileUploadsServer>[0]
) {
  const server = await startFileUploadsServer(options);
  try {
    const { checks } = await runServerConformanceTest(
      server.url,
      'file-uploads-server-' + scenario
    );
    expect(checks.find(({ id }) => id === 'wire-schema-valid')?.status).toBe(
      'SUCCESS'
    );
    expect(checks.every(({ specReferences }) => specReferences?.length)).toBe(
      true
    );
    return checks;
  } finally {
    await server.close();
  }
}

describe('File Uploads server scenarios', () => {
  it.each([
    ['upload', 9],
    ['download', 3]
  ] as const)('passes against the %s fixture', async (scenario, count) => {
    const checks = await runFixture(scenario);
    expect(checks).toHaveLength(count);
    expect(withoutSuccess(checks)).toEqual({});
  });

  it('resolves upload and download path targets against a redirected MCP endpoint', async () => {
    const fixture = await startFileUploadsServer();
    const finalEndpoint = fixture.url + '?fixture=redirected';
    const redirector = createServer((req, res) => {
      req.resume();
      res.writeHead(307, { Location: finalEndpoint }).end();
    });
    try {
      redirector.listen(0, '127.0.0.1');
      await once(redirector, 'listening');
      const address = redirector.address() as { port: number };
      const initialEndpoint = 'http://127.0.0.1:' + address.port + '/entry';
      for (const [scenario, count] of [
        ['upload', 9],
        ['download', 3]
      ] as const) {
        const { checks } = await runServerConformanceTest(
          initialEndpoint,
          'file-uploads-server-' + scenario
        );
        expect(checks).toHaveLength(count);
        expect(withoutSuccess(checks)).toEqual({});
      }
    } finally {
      redirector.closeAllConnections();
      await new Promise<void>((resolve) => redirector.close(() => resolve()));
      await fixture.close();
    }
  });

  it('honors both inline size limits and skips staged probes for inline-only servers', async () => {
    const received: { size: number; declared: boolean }[] = [];
    const tool = {
      name: 'save_to_folder',
      inputSchema: {
        type: 'object',
        properties: {
          file: { ...markedFile(), 'x-mcp-file': { maxSize: 1 } }
        }
      }
    };
    const fixture = await createServerStateless(
      {
        'tools/list': () => ({ tools: [tool] }),
        'tools/call': (params) => {
          const { file } = params.arguments as { file: FileInput };
          const bytes = Buffer.from(file.data!, 'base64');
          received.push({
            size: bytes.length,
            declared: declaredFiles(params) !== undefined
          });
          return bytes.length === 1
            ? {
                content: [],
                structuredContent: { files: { [file.id]: fileSummary(bytes) } }
              }
            : { content: [], isError: true };
        }
      },
      DRAFT_PROTOCOL_VERSION,
      {
        host: '127.0.0.1',
        capabilities: fileCapabilities({ maxInlineBytes: 16 })
      }
    );
    try {
      const { checks } = await runServerConformanceTest(
        fixture.url,
        'file-uploads-server-upload'
      );
      expect(
        checks.find(({ id }) => id === 'files-s01-inline-without-declaration')
          ?.status
      ).toBe('SUCCESS');
      expect(received).toEqual([
        { size: 1, declared: true },
        { size: 1, declared: false }
      ]);
      const staged = checks.filter(({ id }) =>
        /^files-s(05|06|12|15)-/.test(id)
      );
      expect(staged.map(({ status }) => status)).toEqual(
        Array(7).fill('SKIPPED')
      );
    } finally {
      await fixture.close();
    }
  });

  it('fits the S06 files to the independently advertised size limits', async () => {
    const checks = await runFixture('upload', {
      saveFilesMaxSizes: { first: 1, second: 2, empty: 0 }
    });
    expect(withoutSuccess(checks)).toEqual({});
  });

  it('reports S06 as untestable when a nonempty sample cannot fit', async () => {
    const checks = await runFixture('upload', {
      saveFilesMaxSizes: { second: 0 }
    });
    expect(withoutSuccess(checks)).toEqual({
      'files-s06-upload-targets': 'FAILURE',
      'files-s06-upload-retry': 'FAILURE'
    });
    for (const check of checks.filter(({ id }) =>
      id.startsWith('files-s06-')
    )) {
      expect(check).toMatchObject({
        details: { untestable: true },
        errorMessage: expect.stringContaining('save_files second argument')
      });
    }
  });

  it.each([{ tools: null }, { tools: [null] }])(
    'reports untestable checks for a malformed tools list (%j)',
    async ({ tools }) => {
      const fixture = await withWireRecorder(() =>
        createServerStateless(
          {
            'tools/list': () => ({ tools })
          },
          DRAFT_PROTOCOL_VERSION,
          {
            host: '127.0.0.1',
            capabilities: fileCapabilities({ upload: {}, maxInlineBytes: 16 })
          }
        )
      );
      try {
        const { checks } = await runServerConformanceTest(
          fixture.url,
          'file-uploads-server-upload'
        );
        expect(checks).toHaveLength(9);
        expect(
          checks.find(({ id }) => id === 'wire-schema-valid')?.status
        ).toBe('FAILURE');
        for (const check of checks.filter(({ id }) =>
          id.startsWith('files-')
        )) {
          expect(check).toMatchObject({
            status: check.id.startsWith('files-s05-') ? 'WARNING' : 'FAILURE',
            details: { untestable: true }
          });
          expect(check.specReferences?.length).toBeGreaterThan(0);
        }
      } finally {
        await fixture.close();
      }
    }
  );

  it.each([
    [
      'require-inline-declaration',
      { 'files-s01-inline-without-declaration': 'FAILURE' }
    ],
    ['defer-metadata-validation', { 'files-s05-metadata-rejected': 'WARNING' }],
    [
      'omit-upload-target',
      {
        'files-s06-upload-targets': 'FAILURE',
        'files-s06-upload-retry': 'FAILURE'
      }
    ],
    [
      'duplicate-upload-target',
      {
        'files-s06-upload-targets': 'FAILURE',
        'files-s06-upload-retry': 'FAILURE'
      }
    ],
    [
      'invalid-request-state',
      {
        'files-s06-upload-targets': 'FAILURE',
        'files-s06-upload-retry': 'FAILURE'
      }
    ],
    [
      'run-after-short-write',
      { 'files-s12-short-write-no-tool-run': 'FAILURE' }
    ],
    [
      'return-success-after-short-write',
      {
        'files-s12-short-write-rejected': 'FAILURE',
        'files-s12-short-write-no-tool-run': 'FAILURE'
      }
    ],
    [
      'allow-state-replay',
      {
        'files-s15-consumed-state-rejected': 'FAILURE',
        'files-s15-tool-runs-once': 'FAILURE'
      }
    ]
  ] as const)(
    'detects an upload fixture that opts to %s',
    async (fault, expected) => {
      expect(withoutSuccess(await runFixture('upload', { fault }))).toEqual(
        expected
      );
    }
  );

  it('fails S12 as untestable when storage rejects the short write', async () => {
    const checks = await runFixture('upload', { acceptShortWrites: false });
    expect(checks.filter(({ id }) => id.startsWith('files-s12-'))).toEqual([
      expect.objectContaining({
        status: 'FAILURE',
        details: expect.objectContaining({ untestable: true })
      }),
      expect.objectContaining({
        status: 'FAILURE',
        details: expect.objectContaining({ untestable: true })
      })
    ]);
  });

  it('skips S15 only when the fixture has no unsafe profile', async () => {
    const checks = await runFixture('upload', { unsafeSave: false });
    expect(withoutSuccess(checks)).toEqual({
      'files-s15-consumed-state-rejected': 'SKIPPED',
      'files-s15-tool-runs-once': 'SKIPPED'
    });
  });

  it('rejects a replay error carrying the original successful retry ID in S15', async () => {
    const originalFetch = globalThis.fetch;
    let successfulRetryId: number | undefined;
    let replayId: number | undefined;
    const fetchStub = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url, init) => {
        const response = await originalFetch(url, init);
        if (typeof init?.body !== 'string') return response;
        const request = JSON.parse(init.body);
        if (
          request.method !== 'tools/call' ||
          request.params?.arguments?.folderId !== 'unsafe' ||
          typeof request.params.requestState !== 'string'
        ) {
          return response;
        }
        const reply = await response.clone().json();
        if (reply.error?.code === -32602) {
          replayId = request.id;
          return Response.json({ ...reply, id: successfulRetryId });
        }
        successfulRetryId = reply.id;
        return response;
      });
    try {
      const checks = await runFixture('upload');
      expect(successfulRetryId).toEqual(expect.any(Number));
      expect(replayId).toEqual(expect.any(Number));
      expect(replayId).not.toBe(successfulRetryId);
      expect(withoutSuccess(checks)).toEqual({
        'files-s15-consumed-state-rejected': 'FAILURE'
      });
    } finally {
      fetchStub.mockRestore();
    }
  });

  it('rejects a download target issued before the file becomes available', async () => {
    expect(
      withoutSuccess(
        await runFixture('download', {
          fault: 'advertise-unavailable-download'
        })
      )
    ).toEqual({
      'files-s20-withhold-unavailable-download': 'FAILURE'
    });
  });

  it('accepts a pending S20 export that withholds its download target', async () => {
    expect(
      withoutSuccess(await runFixture('download', { pendingExport: true }))
    ).toEqual({});
  });

  it('serves the orders download only after a ready export', async () => {
    const fixture = await startFileUploadsServer();
    const targetUrl = fixture.url + '/storage/orders';
    const exportOrders = (available: boolean) =>
      sendStatelessRequest(fixture.url, 'tools/call', {
        name: 'export_orders',
        arguments: { available },
        _meta: {
          [CLIENT_CAPABILITIES_META]: fileCapabilities(DOWNLOAD_SETTINGS)
        }
      });
    try {
      expect((await fetch(targetUrl)).status).toBe(404);
      expect((await exportOrders(false)).body?.result?.isError).toBe(true);
      expect((await fetch(targetUrl)).status).toBe(404);
      expect((await exportOrders(true)).body?.result?.resultType).toBe(
        'complete'
      );
      const response = await fetch(targetUrl);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(ORDER_BYTES.toString());
    } finally {
      await fixture.close();
    }
  });

  it.each([
    ['full ranged download', 'bytes=0-', ORDER_BYTES, 'SUCCESS'],
    ['unsolicited 206', undefined, ORDER_BYTES, 'FAILURE'],
    [
      'short ranged download',
      'bytes=0-',
      ORDER_BYTES.subarray(0, -1),
      'FAILURE'
    ]
  ] as const)('grades a %s in S20', async (_case, range, bytes, expected) => {
    let requestedRange: string | undefined;
    const fixture = await createServerStateless(
      {
        'tools/list': () => ({
          tools: [{ name: 'export_orders', inputSchema: { type: 'object' } }]
        }),
        'tools/call': ({ arguments: args }) => {
          if (!(args as { available: boolean }).available)
            return { content: [] };
          return {
            content: [{ type: 'text', text: 'Exported fixture orders.' }],
            _meta: {
              [FILES_EXTENSION_ID]: {
                downloads: [
                  {
                    ...fileSummary(ORDER_BYTES),
                    mimeType: ORDER_MIME_TYPE,
                    path: '/orders',
                    credentials: 'omit',
                    ...(range && { headers: { Range: range } })
                  }
                ]
              }
            }
          };
        }
      },
      DRAFT_PROTOCOL_VERSION,
      {
        host: '127.0.0.1',
        capabilities: fileCapabilities({}),
        mountRoutes(app) {
          app.get('/mcp/orders', (req, res) => {
            requestedRange = req.get('Range');
            res
              .set(
                'Content-Range',
                'bytes 0-' + (bytes.length - 1) + '/' + ORDER_BYTES.length
              )
              .status(206)
              .type(ORDER_MIME_TYPE)
              .end(bytes);
          });
        }
      }
    );
    try {
      const { checks } = await runServerConformanceTest(
        fixture.url,
        'file-uploads-server-download'
      );
      expect(requestedRange).toBe(range);
      expect(
        checks.find(({ id }) => id === 'files-s20-fetchable-download')?.status
      ).toBe(expected);
    } finally {
      await fixture.close();
    }
  });

  it('cancels a download in progress when the server scenario times out', async () => {
    const closed = vi.fn();
    const fixture = await startFileUploadsServer(
      {},
      (handlers, version, options) =>
        createServerStateless(handlers, version, {
          ...options,
          mountRoutes(app) {
            app.get('/mcp/storage/orders', (_req, res) => {
              res.once('close', closed);
              res.type(ORDER_MIME_TYPE).write(ORDER_BYTES.subarray(0, -1));
            });
            options?.mountRoutes?.(app);
          }
        })
    );
    try {
      const { checks } = await runServerConformanceTest(
        fixture.url,
        'file-uploads-server-download',
        750
      );
      expect(withoutSuccess(checks)).toEqual({ 'scenario-timeout': 'FAILURE' });
      await expect.poll(() => closed.mock.calls.length).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it('cancels S20 downloads when decoded bytes exceed the export size', async () => {
    const originalFetch = globalThis.fetch;
    const cancelled = vi.fn();
    const readAfterLimit = vi.fn();
    const fetchStub = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url, init) => {
        if (!String(url).endsWith('/mcp/storage/orders'))
          return originalFetch(url, init);
        const stream = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              controller.enqueue(ORDER_BYTES);
              controller.enqueue(Uint8Array.of(0));
            },
            pull(controller) {
              readAfterLimit();
              controller.close();
            },
            cancel: cancelled
          },
          { highWaterMark: 0 }
        );
        return Promise.resolve(new Response(stream));
      });
    try {
      expect(withoutSuccess(await runFixture('download'))).toEqual({
        'files-s20-fetchable-download': 'FAILURE'
      });
      expect(cancelled).toHaveBeenCalledOnce();
      expect(readAfterLimit).not.toHaveBeenCalled();
    } finally {
      fetchStub.mockRestore();
    }
  });

  it('joins path targets to the escaped endpoint path and preserves its query', () => {
    const url = resolveTarget(
      { path: '/storage/orders', credentials: 'omit' },
      'https://gateway.example/tenant%2Ffiles/mcp///?route=%2F&label=a%20b'
    );
    expect(url?.href).toBe(
      'https://gateway.example/tenant%2Ffiles/mcp/storage/orders?route=%2F&label=a%20b'
    );
  });

  it('binds an unsafe upload retry to its capability and JSON arguments', async () => {
    const fixture = await startFileUploadsServer();
    const name = 'save_to_folder';
    const args = {
      folderId: 'unsafe',
      file: { id: 'test', mimeType: 'text/plain', size: 3 },
      options: { sequence: [0, 1] }
    };
    const uploadMeta = {
      [CLIENT_CAPABILITIES_META]: fileCapabilities(UPLOAD_SETTINGS)
    };
    const call = (params: Record<string, unknown>) =>
      sendStatelessRequest(fixture.url, 'tools/call', params);
    const runs = async () =>
      (
        await call({
          name: 'file_uploads_fixture_status',
          arguments: { folderId: args.folderId, fileId: args.file.id }
        })
      ).body?.result?.structuredContent;
    try {
      const staged = await call({ name, arguments: args, _meta: uploadMeta });
      const result = readUploadRequest(staged.body?.result, [args.file.id]);
      expect(result).toBeDefined();
      const { requestState, uploads } = result!;
      const transfer = await fetch(fixture.url + uploads[0].path, {
        method: 'PUT',
        body: 'abc'
      });
      expect(transfer.status).toBe(204);

      const retry = { name, arguments: args, requestState };
      const undeclared = await call(retry);
      expect(undeclared.status).toBe(400);
      expect(undeclared.body?.error).toMatchObject({
        code: -32021,
        data: { requiredCapabilities: fileCapabilities(UPLOAD_SETTINGS) }
      });
      const changed = await call({
        ...retry,
        _meta: uploadMeta,
        arguments: { ...args, options: { sequence: [1, 0] } }
      });
      expect(changed.body?.error?.code).toBe(-32602);
      const malformed = await call({
        ...retry,
        _meta: uploadMeta,
        arguments: { folderId: args.folderId }
      });
      expect(malformed.body?.error?.code).toBe(-32602);
      const wrongTool = await call({
        ...retry,
        name: 'export_orders',
        arguments: { available: true },
        _meta: {
          [CLIENT_CAPABILITIES_META]: fileCapabilities(DOWNLOAD_SETTINGS)
        }
      });
      expect(wrongTool.body?.error?.code).toBe(-32602);
      expect(await runs()).toMatchObject({ runs: 0 });

      const params = withRequestMeta({
        ...retry,
        _meta: uploadMeta,
        arguments: {
          options: args.options,
          file: args.file,
          folderId: args.folderId
        }
      });
      // JSON.stringify serializes -0 as 0, so write the alternate spelling on the wire.
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: 'signed-zero',
        method: 'tools/call',
        params
      }).replace('"sequence":[0,1]', '"sequence":[-0,1]');
      const completed = await fetch(fixture.url, {
        method: 'POST',
        headers: buildStandardHeaders('tools/call', params),
        body: payload
      });
      expect(await completed.json()).toMatchObject({
        result: { resultType: 'complete' }
      });
      const replay = await call({ ...retry, _meta: uploadMeta });
      expect(replay.body?.error?.code).toBe(-32602);
      expect(await runs()).toMatchObject({ runs: 1, storedSize: 3 });
    } finally {
      await fixture.close();
    }
  });

  it.each([
    [
      'upload',
      'save_to_folder',
      {
        folderId: 'unsafe',
        file: { id: 'test', mimeType: 'text/plain', size: 3 }
      }
    ],
    ['download', 'export_orders', { available: true }]
  ] as const)(
    'returns HTTP 400 for missing %s capability',
    async (capability, name, args) => {
      const fixture = await startFileUploadsServer();
      try {
        const result = await sendStatelessRequest(fixture.url, 'tools/call', {
          name,
          arguments: args
        });
        expect(result.status).toBe(400);
        expect(result.body?.error).toMatchObject({
          code: -32021,
          data: { requiredCapabilities: fileCapabilities({ [capability]: {} }) }
        });
        expect(result.body?.id).toBe(result.requestId);
      } finally {
        await fixture.close();
      }
    }
  );

  it.each([
    ['text', 'FAILURE'],
    ['text after a colon', 'FAILURE'],
    ['structuredContent', 'FAILURE'],
    ['an origin-relative address', 'FAILURE'],
    ['pending text', 'FAILURE'],
    ['pending structuredContent', 'FAILURE'],
    ['pending nested export details', 'SUCCESS'],
    ['a resource link', 'SUCCESS'],
    ['a distinct path with the same prefix', 'SUCCESS']
  ] as const)(
    'checks S20 for the issued address in %s',
    async (placement, status) => {
      const target = {
        path: '/storage/orders',
        credentials: 'omit',
        mimeType: ORDER_MIME_TYPE,
        ...fileSummary(ORDER_BYTES)
      };
      const fixture = await createServerStateless(
        {
          'tools/list': () => ({
            tools: [{ name: 'export_orders', inputSchema: { type: 'object' } }]
          }),
          'tools/call': (params) => {
            if (!(params.arguments as { available: boolean }).available) {
              if (placement === 'pending text') {
                return {
                  content: [{ type: 'text', text: 'Pending at ' + targetUrl }]
                };
              }
              if (placement === 'pending structuredContent') {
                return {
                  content: [],
                  structuredContent: { pending: { href: target.path } }
                };
              }
              if (placement === 'pending nested export details') {
                let section: object = { status: 'queued' };
                for (let i = 0; i < 3600; i++) section = { section };
                return {
                  content: [],
                  structuredContent: {
                    details: { url: '/export/status', section }
                  }
                };
              }
              return { content: [], isError: true };
            }
            let text =
              'Exported orders. Related guide at /storage/orders-guide.';
            if (placement === 'text') text = 'Download from ' + targetUrl + '.';
            if (placement === 'text after a colon') text = 'URL:' + targetUrl;
            return {
              content:
                placement === 'a resource link'
                  ? [
                      {
                        type: 'resource_link',
                        uri: 'urn:fixture:orders-export',
                        name: 'Orders export',
                        description: 'Exported the fixture orders.'
                      }
                    ]
                  : [{ type: 'text', text }],
              ...(placement === 'structuredContent' && {
                structuredContent: { export: { href: target.path } }
              }),
              ...(placement === 'an origin-relative address' && {
                structuredContent: {
                  export: { href: new URL(targetUrl).pathname }
                }
              }),
              _meta: { [FILES_EXTENSION_ID]: { downloads: [target] } }
            };
          }
        },
        DRAFT_PROTOCOL_VERSION,
        {
          host: '127.0.0.1',
          capabilities: fileCapabilities({}),
          mountRoutes: (app) => {
            app.get('/mcp' + target.path, (_req, res) =>
              res.status(200).end(ORDER_BYTES)
            );
          }
        }
      );
      const targetUrl = fixture.url + target.path;
      const pending = placement.startsWith('pending ');
      try {
        const { checks } = await runServerConformanceTest(
          fixture.url,
          'file-uploads-server-download'
        );
        expect(
          checks.find(({ id }) => id === 'files-s20-fetchable-download')?.status
        ).toBe(pending ? 'SUCCESS' : status);
        expect(
          checks.find(
            ({ id }) => id === 'files-s20-withhold-unavailable-download'
          )?.status
        ).toBe(pending ? status : 'SUCCESS');
        expect(
          checks.find(({ id }) => id === 'wire-schema-valid')?.status
        ).toBe('SUCCESS');
      } finally {
        await fixture.close();
      }
    }
  );
});

describe('File Uploads targets', () => {
  it('treats null target members as absent and leaves opaque metadata intact', () => {
    const target = {
      url: null,
      path: '/storage/file',
      credentials: 'omit',
      headers: { 'X-Transfer': 'fixture', 'X-Unused': null },
      _meta: { note: null }
    };
    const normalized = {
      path: '/storage/file',
      credentials: 'omit',
      headers: { 'X-Transfer': 'fixture' },
      _meta: { note: null }
    };
    const download = { mimeType: 'text/plain', size: 3 };
    expect(readDownloadTarget({ ...target, ...download })).toEqual({
      ...normalized,
      ...download
    });

    const form = {
      fields: [{ name: 'key', value: 'test' }],
      fileField: 'payload'
    };
    const request = readUploadRequest(
      {
        resultType: 'upload_required',
        requestState: 'test-state',
        uploads: [
          {
            ...target,
            fileId: 'file',
            method: 'POST',
            form: {
              ...form,
              fields: [{ ...form.fields[0], unused: null }],
              unused: null
            }
          }
        ]
      },
      ['file']
    );
    expect(request?.uploads).toEqual([
      {
        ...normalized,
        fileId: 'file',
        method: 'POST',
        form
      }
    ]);
  });

  it.each([
    ['2031-01-02t03:04:05z', true],
    ['2016-12-31T23:59:60Z', true],
    ['2017-01-01t00:59:60.5+01:00', true],
    ['2032-02-29T03:04:59.99999999999999999999-00:30', true],
    ['2031-01-02T03:04Z', false],
    ['2031-01-02T03:04:05', false],
    ['2031-01-02T03:04:05+0100', false],
    ['2031-02-29T03:04:05Z', false],
    ['2031-01-02T03:04:05Z\n', false],
    ['2016-12-30T23:59:60Z', false],
    ['2016-12-31T23:58:60Z', false]
  ] as const)('validates the RFC 3339 timestamp %j', (expiresAt, valid) => {
    const target = { path: '/storage/file', credentials: 'omit', expiresAt };
    const expected = valid ? expiresAt : undefined;
    expect(
      readUploadRequest(
        {
          resultType: 'upload_required',
          requestState: 'test-state',
          uploads: [{ ...target, fileId: 'file' }]
        },
        ['file']
      )?.uploads[0].expiresAt
    ).toBe(expected);
    const download = { ...target, mimeType: 'text/plain', size: 3 };
    expect(readDownloadTarget(download)?.expiresAt).toBe(expected);
  });
});

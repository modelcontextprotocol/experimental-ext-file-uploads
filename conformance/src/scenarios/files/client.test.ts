import { rename, rm, symlink } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { MIMEType } from 'node:util';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  runFilesDownloadClient,
  runFilesUploadClient
} from '../../../examples/clients/typescript/file-uploads';
import {
  buildStandardHeaders,
  connectStateless,
  sendStatelessRequest,
  withRequestMeta,
  type Connection
} from '../../connection';
import { runClientConformanceTest } from '../../runner';
import { DRAFT_PROTOCOL_VERSION } from '../../types';
import { wireSchemaChecks } from '../../validation/wire-schema';
import { FileUploadsClientUploadScenario } from './client-upload';
import { FileUploadsClientDownloadScenario } from './client-download';
import {
  CLIENT_CAPABILITIES_META,
  DOWNLOAD_SETTINGS,
  UPLOAD_SETTINGS,
  fileCapabilities,
  uploadBody,
  type UploadTarget
} from './common';
import {
  downloadFilename,
  ORDER_BYTES,
  sampleCall,
  UPLOAD_CASES
} from './samples';

const C06_BYTES = 'files-c06-upload-by-file-id';
const C06_RETRY = 'files-c06-retry-after-transfers';
const C06_SETTINGS = 'files-c06-original-call-and-settings';
const C07 = 'files-c07-form-field-order';
const C10 = 'files-c10-no-retry-after-failure';
const C11 = 'files-c11-stop-after-second-upload-request';
const C13 = 'files-c13-reject-non-loopback-http';
const hasNonLoopbackIPv4 = Object.values(networkInterfaces())
  .flat()
  .some((info) => info?.family === 'IPv4' && !info.internal);

async function runExample(
  scenario: string,
  client: (url: string) => Promise<void>,
  failures: string[] = []
) {
  const expectedFailureSlugs = [
    ...failures,
    ...(!hasNonLoopbackIPv4 && scenario.endsWith('-upload') ? [C13] : [])
  ];
  const { checks: results, clientError } = await runClientConformanceTest(
    scenario,
    async (url, env) => {
      const previousContext = process.env.MCP_CONFORMANCE_CONTEXT;
      process.env.MCP_CONFORMANCE_CONTEXT = env.MCP_CONFORMANCE_CONTEXT;
      try {
        await client(url);
      } finally {
        if (previousContext === undefined)
          delete process.env.MCP_CONFORMANCE_CONTEXT;
        else process.env.MCP_CONFORMANCE_CONTEXT = previousContext;
      }
    }
  );
  if (clientError && expectedFailureSlugs.length === 0) throw clientError;
  const checks = results.filter(({ id }) => id.startsWith('files-'));
  expect(checks.length).toBeGreaterThan(0);
  expect(results.filter(({ id }) => id.startsWith('wire-schema'))).toEqual([
    expect.objectContaining({ id: 'wire-schema-valid', status: 'SUCCESS' })
  ]);
  expect(
    checks
      .filter(({ status }) => status !== 'SUCCESS')
      .map(({ id }) => id)
      .sort()
  ).toEqual(expectedFailureSlugs.sort());
  expect(checks.every(({ specReferences }) => specReferences?.length)).toBe(
    true
  );
  return checks;
}

interface UploadRequest {
  requestState: string;
  uploads: UploadTarget[];
}

async function probeUpload(
  drive: (
    conn: Connection,
    urls: Awaited<ReturnType<FileUploadsClientUploadScenario['start']>>
  ) => Promise<void>,
  listBeforeCall = true
) {
  const scenario = new FileUploadsClientUploadScenario();
  const urls = await scenario.start({ specVersion: DRAFT_PROTOCOL_VERSION });
  const conn = await connectStateless(urls.serverUrl, DRAFT_PROTOCOL_VERSION, {
    capabilities: fileCapabilities(UPLOAD_SETTINGS)
  });
  try {
    if (listBeforeCall) await conn.request('tools/list');
    await drive(conn, urls);
    return scenario.getChecks();
  } finally {
    await conn.close();
    await scenario.stop();
  }
}

function putTarget(serverUrl: string, target: UploadTarget, body: string) {
  return fetch(serverUrl + target.path, { method: 'PUT', body });
}

async function completeRawUpload(conn: Connection, serverUrl: string) {
  const call = sampleCall('raw');
  const { uploads, requestState } = await conn.request<UploadRequest>(
    'tools/call',
    call
  );
  for (const target of uploads) {
    const { bytes } = Object.values(UPLOAD_CASES.raw.files).find(
      ({ file }) => file.id === target.fileId
    )!;
    expect((await putTarget(serverUrl, target, bytes.toString())).status).toBe(
      204
    );
  }
  await conn.request('tools/call', { ...call, requestState });
}

async function requestSecondUpload(conn: Connection, serverUrl: string) {
  const call = sampleCall('second');
  const first = await conn.request<UploadRequest>('tools/call', call);
  expect((await putTarget(serverUrl, first.uploads[0], 'abc')).status).toBe(
    204
  );
  expect(
    await conn.request('tools/call', {
      ...call,
      requestState: first.requestState
    })
  ).toMatchObject({ resultType: 'upload_required' });
}

async function reportSecondUpload(reportUrl: string, failed: boolean) {
  const response = await fetch(reportUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ case: 'second', failed })
  });
  expect(response.status).toBe(204);
}

describe('File Uploads client scenarios', () => {
  it.each(['upload', 'download'] as const)(
    'returns HTTP 400 and the missing %s capability',
    async (capability) => {
      const upload = capability === 'upload';
      const scenario = upload
        ? new FileUploadsClientUploadScenario()
        : new FileUploadsClientDownloadScenario();
      const { serverUrl } = await scenario.start({
        specVersion: DRAFT_PROTOCOL_VERSION
      });
      try {
        const otherCapability = upload ? DOWNLOAD_SETTINGS : UPLOAD_SETTINGS;
        const call = upload
          ? sampleCall('raw')
          : { name: 'export_orders', arguments: { variant: 'valid' } };
        const { status, body } = await sendStatelessRequest(
          serverUrl,
          'tools/call',
          {
            ...call,
            _meta: {
              [CLIENT_CAPABILITIES_META]: fileCapabilities(otherCapability)
            }
          }
        );
        expect(status).toBe(400);
        expect(body).toMatchObject({
          error: {
            code: -32021,
            data: {
              requiredCapabilities: fileCapabilities({ [capability]: {} })
            }
          }
        });
        expect(body).not.toHaveProperty('result');
      } finally {
        await scenario.stop();
      }
    }
  );

  it('passes the grouped upload checks with the everything-client', async () => {
    const name = 'file-uploads-client-upload';
    const checks = await runExample(name, runFilesUploadClient);
    expect(checks).toHaveLength(9);
    expect(checks.find(({ id }) => id === C10)).toMatchObject({
      status: 'SUCCESS',
      details: { httpAttempts: 2, toolsCallRetries: 0 }
    });
    if (!hasNonLoopbackIPv4) {
      expect(checks.find(({ id }) => id === C13)?.details?.untestable).toBe(
        true
      );
    }
  });

  it('redacts actual File Uploads state in a malformed request with no extension markers', async () => {
    await probeUpload(async (conn, { serverUrl }) => {
      const { requestState } = await conn.request<UploadRequest>(
        'tools/call',
        sampleCall('raw')
      );
      const params = withRequestMeta({ name: 'save_files', requestState });
      const response = await fetch(serverUrl, {
        method: 'POST',
        headers: buildStandardHeaders('tools/call', params),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: false,
          method: 'tools/call',
          params
        })
      });
      await response.json();

      const checks = wireSchemaChecks(DRAFT_PROTOCOL_VERSION);
      expect(checks.find(({ id }) => id === 'wire-schema-valid')).toMatchObject(
        {
          status: 'FAILURE',
          errorMessage: expect.stringContaining(
            '[File Uploads payload redacted]'
          )
        }
      );
      expect(JSON.stringify(checks)).not.toContain(
        JSON.parse(requestState).nonce
      );
    });
  });

  it.each([
    ['swap-upload-bytes', [C06_BYTES, C06_RETRY]],
    ['modify-request-state', ['files-c06-exact-request-state']],
    ['change-retry-settings', ['files-c06-original-call-and-settings']],
    ['reverse-form-fields', ['files-c07-form-field-order']],
    ['transfer-second-request', [C11]]
  ] as const)(
    'detects an upload client that opts to %s',
    async (fault, checkIds) => {
      const checks = await runExample(
        'file-uploads-client-upload',
        (url) => runFilesUploadClient(url, fault),
        [...checkIds]
      );
      for (const checkId of checkIds) {
        expect(checks.find(({ id }) => id === checkId)?.status).toBe('FAILURE');
      }
    }
  );

  it('matches C06 targets to client-generated file IDs', async () => {
    const checks = await probeUpload(async (conn, { serverUrl }) => {
      const { first, second } = UPLOAD_CASES.raw.files;
      const call = {
        ...sampleCall('raw'),
        arguments: {
          folderId: 'raw',
          first: { ...first.file, id: 'client/first' },
          second: { ...second.file, id: 'client/second' }
        }
      };
      const result = await conn.request<UploadRequest>('tools/call', call);
      expect(result.uploads.map(({ fileId }) => fileId)).toEqual([
        'client/second',
        'client/first'
      ]);
      const bytes = new Map([
        ['client/first', first.bytes],
        ['client/second', second.bytes]
      ]);
      for (const target of result.uploads) {
        expect(
          (
            await putTarget(
              serverUrl,
              target,
              bytes.get(target.fileId)!.toString()
            )
          ).status
        ).toBe(204);
      }
      await conn.request('tools/call', {
        ...call,
        requestState: result.requestState
      });
    });
    expect(
      checks
        .filter(({ id }) => id.startsWith('files-c06-'))
        .map(({ status }) => status)
    ).toEqual(Array(5).fill('SUCCESS'));
  });

  it('rejects an extra nonempty staged argument and accepts an empty file without a target', async () => {
    await probeUpload(async (conn) => {
      const call = sampleCall('raw');
      const empty = { id: 'extra', mimeType: 'text/plain', size: 3 };
      await expect(
        conn.request('tools/call', {
          ...call,
          arguments: { ...call.arguments, empty }
        })
      ).rejects.toMatchObject({ code: -32602 });

      const result = await conn.request<UploadRequest>('tools/call', {
        ...call,
        arguments: { ...call.arguments, empty: { ...empty, size: 0 } }
      });
      expect(result.uploads.map(({ fileId }) => fileId)).toEqual([
        'second',
        'first'
      ]);
    });
  });

  it('rejects compressed C06 uploads even when the decompressed bytes match', async () => {
    const checks = await probeUpload(async (conn, { serverUrl }) => {
      const call = sampleCall('raw');
      const result = await conn.request<UploadRequest>('tools/call', call);
      const first = result.uploads.find(({ fileId }) => fileId === 'first')!;
      const second = result.uploads.find(({ fileId }) => fileId === 'second')!;
      const { first: firstFile, second: secondFile } = UPLOAD_CASES.raw.files;
      const compressed = await fetch(serverUrl + first.path, {
        method: 'PUT',
        headers: { 'Content-Encoding': 'gzip' },
        body: Uint8Array.from(gzipSync(firstFile.bytes))
      });
      expect(compressed.status).toBe(415);
      expect(
        (await putTarget(serverUrl, second, secondFile.bytes.toString())).status
      ).toBe(204);
      await conn.request('tools/call', {
        ...call,
        requestState: result.requestState
      });
    });
    expect(checks.find(({ id }) => id === C06_BYTES)?.status).toBe('FAILURE');
    expect(checks.find(({ id }) => id === C06_RETRY)?.status).toBe('FAILURE');
  });

  it('keeps C06 failed when valid bytes arrive after the retry', async () => {
    const checks = await probeUpload(async (conn, { serverUrl }) => {
      const call = sampleCall('raw');
      const result = await conn.request<UploadRequest>('tools/call', call);
      const files = Object.values(UPLOAD_CASES.raw.files);
      for (const target of result.uploads) {
        const { bytes } = files.find(({ file }) => file.id === target.fileId)!;
        expect(
          (await putTarget(serverUrl, target, 'x'.repeat(bytes.length))).status
        ).toBe(400);
      }
      await conn.request('tools/call', {
        ...call,
        requestState: result.requestState
      });
      for (const target of result.uploads) {
        const { bytes } = files.find(({ file }) => file.id === target.fileId)!;
        expect(
          (await putTarget(serverUrl, target, bytes.toString())).status
        ).toBe(204);
      }
    });
    expect(checks.find(({ id }) => id === C06_BYTES)?.status).toBe('FAILURE');
    expect(checks.find(({ id }) => id === C06_RETRY)?.status).toBe('FAILURE');
  });

  it('requires C06 to declare upload on tools/list before the original call', async () => {
    const checks = await probeUpload(async (conn, { serverUrl }) => {
      await completeRawUpload(conn, serverUrl);
      await conn.request('tools/list');
    }, false);
    expect(checks.find(({ id }) => id === C06_RETRY)?.status).toBe('SUCCESS');
    expect(checks.find(({ id }) => id === C06_SETTINGS)?.status).toBe(
      'FAILURE'
    );
  });

  it('accepts C06 when a declared tools/list precedes the upload among other listings', async () => {
    const checks = await probeUpload(async (conn, { serverUrl }) => {
      const undeclared = { _meta: { [CLIENT_CAPABILITIES_META]: {} } };
      expect(await conn.request('tools/list', undeclared)).toMatchObject({
        tools: []
      });
      await conn.request('tools/list');
      await completeRawUpload(conn, serverUrl);
      await conn.request('tools/list', undeclared);
    }, false);
    expect(checks.find(({ id }) => id === C06_SETTINGS)?.status).toBe(
      'SUCCESS'
    );
  });

  it('counts a bare save_files call after the next tool probe starts in C06', async () => {
    const checks = await probeUpload(async (conn, { serverUrl }) => {
      await completeRawUpload(conn, serverUrl);
      await conn.request('tools/call', sampleCall('form'));
      await expect(
        conn.request('tools/call', { name: 'save_files' })
      ).rejects.toMatchObject({ code: -32602 });
    });
    expect(checks.find(({ id }) => id === C06_BYTES)?.status).toBe('SUCCESS');
    expect(checks.find(({ id }) => id === C06_RETRY)?.status).toBe('FAILURE');
  });

  it.each([
    ['valid framing', 204, 'SUCCESS'],
    ['a quoted parameter with filename-like text', 204, 'SUCCESS'],
    ['a missing closing CRLF delimiter prefix', 400, 'FAILURE'],
    ['a bare LF in a part header', 400, 'FAILURE'],
    ['duplicate disposition headers', 400, 'FAILURE'],
    ['conflicting file part Content-Type headers', 400, 'FAILURE'],
    ['conflicting HTTP Content-Type headers', 400, 'FAILURE'],
    ['a text field with filename', 400, 'FAILURE'],
    ['a text field with filename*', 400, 'FAILURE']
  ] as const)(
    'checks multipart form data with %s',
    async (variant, status, grade) => {
      const checks = await probeUpload(async (conn, { serverUrl }) => {
        const {
          uploads: [target]
        } = await conn.request<UploadRequest>('tools/call', sampleCall('form'));
        const { file, bytes } = UPLOAD_CASES.form.files.file;
        const { body, headers } = uploadBody(target, file, bytes);
        const boundary = new MIMEType(headers.get('Content-Type')!).params.get(
          'boundary'
        )!;
        const marker = '--' + boundary;
        let payload = Buffer.from(body).toString('utf8');
        if (variant === 'conflicting HTTP Content-Type headers') {
          const statusCode = await new Promise<number | undefined>(
            (resolve, reject) => {
              const request = httpRequest(
                serverUrl + target.path,
                {
                  method: 'POST',
                  headers: [
                    ...Array.from(headers).flat(),
                    'Content-Type',
                    'text/plain'
                  ]
                },
                (response) => {
                  response.resume();
                  resolve(response.statusCode);
                }
              );
              request.on('error', reject).end(payload);
            }
          );
          expect(statusCode).toBe(status);
          return;
        }
        if (variant === 'valid framing') {
          headers.set(
            'Content-Type',
            `multipart/form-data; fixture="boundary=other"; boundary="${boundary}"`
          );
          payload =
            'preamble containing ' +
            marker +
            '\r\n' +
            payload.split(marker + '\r\n').join(marker + ' \t\r\n') +
            'epilogue';
        } else if (variant === 'a missing closing CRLF delimiter prefix') {
          payload = payload.replace('\r\n' + marker + '--', marker + '--');
        } else if (variant === 'a bare LF in a part header') {
          payload = payload.replace('\r\n\r\n', '\n\r\n\r\n');
        } else if (variant === 'duplicate disposition headers') {
          payload = payload.replace(
            'Content-Disposition:',
            'Content-Disposition: form-data; name="policy"\r\nContent-Disposition:'
          );
        } else if (variant === 'conflicting file part Content-Type headers') {
          payload = payload.replace(
            'Content-Type: text/plain\r\n',
            'Content-Type: text/plain\r\nContent-Type: application/octet-stream\r\n'
          );
        } else if (variant === 'a text field with filename') {
          payload = payload.replace(
            'name="policy"',
            'name="policy"; FiLeNaMe="field.txt"'
          );
        } else if (variant === 'a text field with filename*') {
          payload = payload.replace(
            'name="policy"',
            'name="policy"; filename*=UTF-8\'\'field.txt'
          );
        } else {
          payload = payload.replace(
            'name="policy"',
            'name="policy"; note="text; filename=field.txt"'
          );
        }
        headers.set('Content-Length', String(Buffer.byteLength(payload)));
        expect(
          (
            await fetch(serverUrl + target.path, {
              method: 'POST',
              headers,
              body: payload
            })
          ).status
        ).toBe(status);
      });
      expect(checks.find(({ id }) => id === C07)?.status).toBe(grade);
    }
  );

  it('detects reusing the original JSON-RPC ID on a retry', async () => {
    const checks = await probeUpload(async (_conn, { serverUrl }) => {
      const call = sampleCall('raw');
      const params = withRequestMeta({
        ...call,
        _meta: { [CLIENT_CAPABILITIES_META]: fileCapabilities(UPLOAD_SETTINGS) }
      });
      const send = (requestState?: string) =>
        fetch(serverUrl, {
          method: 'POST',
          headers: buildStandardHeaders('tools/call', params),
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'repeated-id',
            method: 'tools/call',
            params: { ...params, requestState }
          })
        });
      const { result } = (await (await send()).json()) as {
        result: UploadRequest;
      };
      for (const target of result.uploads) {
        const { bytes } = Object.values(UPLOAD_CASES.raw.files).find(
          ({ file }) => file.id === target.fileId
        )!;
        expect(
          (await putTarget(serverUrl, target, bytes.toString())).status
        ).toBe(204);
      }
      expect((await send(result.requestState)).status).toBe(200);
    });
    expect(checks.find(({ id }) => id === C06_RETRY)?.status).toBe('SUCCESS');
    expect(
      checks.find(({ id }) => id === 'files-c06-fresh-json-rpc-id')?.status
    ).toBe('FAILURE');
  });

  it('detects a tools/call retry when both permitted HTTP attempts failed', async () => {
    const checks = await runExample(
      'file-uploads-client-upload',
      (url) => runFilesUploadClient(url, 'retry-failed-upload'),
      [C10]
    );
    expect(checks.find(({ id }) => id === C10)).toMatchObject({
      status: 'FAILURE',
      details: { httpAttempts: 2, toolsCallRetries: 1 }
    });
  });

  it.each(['no transfer', 'a POST'] as const)(
    'marks C10 untestable after %s with no retry',
    async (attempt) => {
      const checks = await probeUpload(async (conn, { serverUrl }) => {
        const { uploads } = await conn.request<UploadRequest>(
          'tools/call',
          sampleCall('failed')
        );
        if (attempt === 'a POST') {
          const failed = uploads.find(({ fileId }) => fileId === 'first')!;
          const response = await fetch(serverUrl + failed.path, {
            method: 'POST',
            body: 'abc'
          });
          expect(response.status).toBe(503);
        }
      });
      expect(checks.find(({ id }) => id === C10)).toMatchObject({
        status: 'FAILURE',
        details: { untestable: true }
      });
    }
  );

  it('counts a C10 tools/call retry with neither arguments nor requestState', async () => {
    const checks = await probeUpload(async (conn, { serverUrl }) => {
      const request = await conn.request<UploadRequest>(
        'tools/call',
        sampleCall('failed')
      );
      const failed = request.uploads.find(({ fileId }) => fileId === 'first')!;
      expect((await putTarget(serverUrl, failed, 'abc')).status).toBe(503);
      await expect(
        conn.request('tools/call', { name: 'save_files' })
      ).rejects.toMatchObject({ code: -32602 });
    });
    expect(checks.find(({ id }) => id === C10)).toMatchObject({
      status: 'FAILURE',
      details: { httpAttempts: 1, toolsCallRetries: 1 }
    });
  });

  it('counts an unidentified C10 retry after the next upload probe starts', async () => {
    const checks = await probeUpload(async (conn, { serverUrl }) => {
      const request = await conn.request<UploadRequest>(
        'tools/call',
        sampleCall('failed')
      );
      const failed = request.uploads.find(({ fileId }) => fileId === 'first')!;
      expect((await putTarget(serverUrl, failed, 'abc')).status).toBe(503);

      const form = await conn.request<UploadRequest>(
        'tools/call',
        sampleCall('form')
      );
      const { file, bytes } = UPLOAD_CASES.form.files.file;
      const [target] = form.uploads;
      const transferred = await fetch(serverUrl + target.path, {
        ...uploadBody(target, file, bytes),
        method: 'POST'
      });
      expect(transferred.status).toBe(204);
      await expect(
        conn.request('tools/call', { name: 'save_files' })
      ).rejects.toMatchObject({ code: -32602 });
    });
    expect(
      checks.find(({ id }) => id === 'files-c07-form-field-order')?.status
    ).toBe('SUCCESS');
    expect(checks.find(({ id }) => id === C10)).toMatchObject({
      status: 'FAILURE',
      details: { httpAttempts: 1, toolsCallRetries: 1 }
    });
  });

  it('marks C11 untestable when the retry never receives a second upload request', async () => {
    const checks = await probeUpload(async (conn, { serverUrl, context }) => {
      const call = sampleCall('second');
      const request = await conn.request<UploadRequest>('tools/call', call);
      expect(
        (await putTarget(serverUrl, request.uploads[0], 'abc')).status
      ).toBe(204);
      await expect(
        conn.request('tools/call', {
          ...call,
          requestState: request.requestState,
          _meta: { [CLIENT_CAPABILITIES_META]: {} }
        })
      ).rejects.toMatchObject({ code: -32021 });
      await fetch(context.reportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case: 'second', failed: true })
      });
    });
    expect(checks.find(({ id }) => id === C11)).toMatchObject({
      status: 'FAILURE',
      details: { untestable: true }
    });
  });

  it('counts an unidentified C11 retry after the form probe starts', async () => {
    const checks = await probeUpload(async (conn, { serverUrl, context }) => {
      await requestSecondUpload(conn, serverUrl);
      await reportSecondUpload(context.reportUrl, true);

      const form = await conn.request<UploadRequest>(
        'tools/call',
        sampleCall('form')
      );
      const { file, bytes } = UPLOAD_CASES.form.files.file;
      const [target] = form.uploads;
      const transferred = await fetch(serverUrl + target.path, {
        ...uploadBody(target, file, bytes),
        method: 'POST'
      });
      expect(transferred.status).toBe(204);
      await expect(
        conn.request('tools/call', { name: 'save_to_folder' })
      ).rejects.toMatchObject({ code: -32602 });
    });
    expect(checks.find(({ id }) => id === C07)?.status).toBe('SUCCESS');
    expect(checks.find(({ id }) => id === C11)?.status).toBe('FAILURE');
  });

  it('keeps C11 failed when a later report contradicts a successful call', async () => {
    const checks = await probeUpload(async (conn, { serverUrl, context }) => {
      await requestSecondUpload(conn, serverUrl);
      await reportSecondUpload(context.reportUrl, false);
      await reportSecondUpload(context.reportUrl, true);
    });
    expect(checks.find(({ id }) => id === C11)).toMatchObject({
      status: 'FAILURE',
      errorMessage: expect.stringContaining('reported a successful call')
    });
  });

  it.each([
    ['tool name', { name: 'other_save' }],
    ['arguments', { arguments: { folderId: 'second' } }],
    [
      'settings',
      {
        _meta: {
          [CLIENT_CAPABILITIES_META]: fileCapabilities({
            ...UPLOAD_SETTINGS,
            download: {}
          })
        }
      }
    ]
  ] as const)(
    'withholds the second C11 upload request when the retry changes the %s',
    async (_field, changes) => {
      const checks = await probeUpload(async (conn, { serverUrl }) => {
        const call = sampleCall('second');
        const request = await conn.request<UploadRequest>('tools/call', call);
        expect(
          (await putTarget(serverUrl, request.uploads[0], 'abc')).status
        ).toBe(204);
        await expect(
          conn.request('tools/call', {
            ...call,
            ...changes,
            requestState: request.requestState
          })
        ).rejects.toMatchObject({ code: -32602 });
      });
      expect(checks.find(({ id }) => id === C11)).toMatchObject({
        status: 'FAILURE',
        details: { untestable: true }
      });
    }
  );

  it.skipIf(!hasNonLoopbackIPv4)(
    'fails C13 when a client reports success without contacting the target',
    async () => {
      const checks = await probeUpload(async (conn, { context }) => {
        const request = await conn.request<UploadRequest>(
          'tools/call',
          sampleCall('invalid')
        );
        const address = new URL(request.uploads[0].url!).hostname;
        expect(context.allowedTransferAddresses).toContain(address);
        const response = await fetch(context.reportUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            case: 'invalid',
            address,
            addressAllowed: true,
            failed: false
          })
        });
        expect(response.status).toBe(204);
      });
      expect(checks.find(({ id }) => id === C13)).toMatchObject({
        status: 'FAILURE',
        errorMessage: 'The client reported success for the invalid target call.'
      });
    }
  );

  it.skipIf(!hasNonLoopbackIPv4)(
    'counts a C13 transfer attempt with a changed query',
    async () => {
      const checks = await probeUpload(async (conn, { context }) => {
        const request = await conn.request<UploadRequest>(
          'tools/call',
          sampleCall('invalid')
        );
        const url = new URL(request.uploads[0].url!);
        expect(context.allowedTransferAddresses).toContain(url.hostname);
        await fetch(context.reportUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            case: 'invalid',
            address: url.hostname,
            addressAllowed: true
          })
        });
        url.searchParams.set('fixture', 'query');
        expect((await fetch(url, { method: 'PUT', body: 'abc' })).status).toBe(
          404
        );
      });
      expect(checks.find(({ id }) => id === C13)).toMatchObject({
        status: 'FAILURE',
        errorMessage:
          'The client contacted or retried the non-loopback HTTP target.'
      });
    }
  );

  it.skipIf(!hasNonLoopbackIPv4)(
    'detects a transfer to the reachable non-loopback HTTP target',
    async () => {
      const checks = await runExample(
        'file-uploads-client-upload',
        (url) => runFilesUploadClient(url, 'allow-non-loopback-http'),
        [C13]
      );
      const invalid = checks.find(({ id }) => id === C13);
      expect(invalid?.status).toBe('FAILURE');
      expect(invalid?.details?.untestable).toBeUndefined();
    }
  );

  it.skipIf(!hasNonLoopbackIPv4)(
    'fails C13 as untestable if address policy blocks the destination',
    async () => {
      const checks = await runExample(
        'file-uploads-client-upload',
        (url) => runFilesUploadClient(url, 'block-invalid-address'),
        [C13]
      );
      expect(checks.find(({ id }) => id === C13)).toMatchObject({
        status: 'FAILURE',
        details: { untestable: true }
      });
    }
  );

  it('passes the download checks with the everything-client', async () => {
    const name = 'file-uploads-client-download';
    expect(await runExample(name, runFilesDownloadClient)).toHaveLength(3);
  });

  it('cancels an oversized download at the first excess decoded byte', async () => {
    const originalFetch = globalThis.fetch;
    const cancelled = vi.fn();
    const readAfterLimit = vi.fn();
    const fetchStub = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url, init) => {
        const response = await originalFetch(url, init);
        if (!String(url).endsWith('/mcp/downloads/short')) return response;
        await response.body?.cancel();
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
        return new Response(stream, { headers: response.headers });
      });
    try {
      await runExample('file-uploads-client-download', runFilesDownloadClient);
      expect(cancelled).toHaveBeenCalledOnce();
      expect(readAfterLimit).not.toHaveBeenCalled();
    } finally {
      fetchStub.mockRestore();
    }
  });

  it('requires download on tools/list even when all C19 transfers are correct', async () => {
    const originalFetch = globalThis.fetch;
    const transfers: string[] = [];
    const fetchStub = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url, init) => {
        if (typeof init?.body === 'string') {
          const request = JSON.parse(init.body);
          if (request.method === 'tools/list') {
            request.params._meta[CLIENT_CAPABILITIES_META] = {};
            return originalFetch(url, {
              ...init,
              body: JSON.stringify(request)
            });
          }
        }
        if (String(url).includes('/mcp/downloads/'))
          transfers.push(String(url));
        return originalFetch(url, init);
      });
    try {
      const checks = await runExample(
        'file-uploads-client-download',
        runFilesDownloadClient,
        [
          'files-c19-accept-valid-download',
          'files-c19-discard-short-download',
          'files-c19-discard-wrong-digest'
        ]
      );
      expect(transfers).toHaveLength(3);
      for (const check of checks) {
        expect(check.errorMessage).toMatch(
          /tools\/list with download declared/
        );
      }
    } finally {
      fetchStub.mockRestore();
    }
  });

  it('accepts C19 when a declared tools/list precedes the downloads among other listings', async () => {
    await runExample('file-uploads-client-download', async (url) => {
      expect((await sendStatelessRequest(url, 'tools/list')).status).toBe(200);
      await runFilesDownloadClient(url);
      expect((await sendStatelessRequest(url, 'tools/list')).status).toBe(200);
    });
  });

  it.each(['upload', 'download'] as const)(
    'rejects a mismatched %s result ID before transferring',
    async (role) => {
      const scenario =
        role === 'upload'
          ? new FileUploadsClientUploadScenario()
          : new FileUploadsClientDownloadScenario();
      const { serverUrl, context } = await scenario.start({
        specVersion: DRAFT_PROTOCOL_VERSION
      });
      vi.stubEnv('MCP_CONFORMANCE_CONTEXT', JSON.stringify(context));
      const originalFetch = globalThis.fetch;
      let transfers = 0;
      const fetchStub = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (url, init) => {
          if (String(url).startsWith(serverUrl + '/')) transfers++;
          const response = await originalFetch(url, init);
          if (
            typeof init?.body === 'string' &&
            JSON.parse(init.body).method === 'tools/call'
          ) {
            return Response.json({
              ...(await response.json()),
              id: 'wrong-id'
            });
          }
          return response;
        });
      try {
        const run =
          role === 'upload' ? runFilesUploadClient : runFilesDownloadClient;
        await expect(run(serverUrl)).rejects.toThrow(
          'response ID did not match'
        );
        expect(transfers).toBe(0);
      } finally {
        fetchStub.mockRestore();
        vi.unstubAllEnvs();
        await scenario.stop();
      }
    }
  );

  it('detects retaining files with the wrong size and the wrong digest', async () => {
    const checks = await runExample(
      'file-uploads-client-download',
      (url) => runFilesDownloadClient(url, true),
      ['files-c19-discard-short-download', 'files-c19-discard-wrong-digest']
    );
    expect(checks.map(({ status }) => status)).toEqual([
      'SUCCESS',
      'FAILURE',
      'FAILURE'
    ]);
  });

  it('detects invalid downloads retained as temporary files in the C19 scratch root', async () => {
    const checks = await runExample(
      'file-uploads-client-download',
      async (url) => {
        const { downloadDirectory } = JSON.parse(
          process.env.MCP_CONFORMANCE_CONTEXT!
        );
        await runFilesDownloadClient(url, true);
        for (const variant of ['short', 'wrong-digest']) {
          await rename(
            join(downloadDirectory, variant, downloadFilename),
            join(downloadDirectory, variant + '.part')
          );
        }
      },
      ['files-c19-discard-short-download', 'files-c19-discard-wrong-digest']
    );
    expect(checks.map(({ status }) => status)).toEqual([
      'SUCCESS',
      'FAILURE',
      'FAILURE'
    ]);
  });

  it.each([
    ['remove', []],
    ['replace', ['files-c19-discard-short-download']]
  ] as const)(
    'checks C19 when clients %s an empty variant directory',
    async (action, failures) => {
      const checks = await runExample(
        'file-uploads-client-download',
        async (url) => {
          const { downloadDirectory } = JSON.parse(
            process.env.MCP_CONFORMANCE_CONTEXT!
          );
          await runFilesDownloadClient(url);
          const short = join(downloadDirectory, 'short');
          await rm(short, { recursive: true });
          if (action === 'replace') {
            await symlink(
              join(downloadDirectory, 'wrong-digest'),
              short,
              'junction'
            );
          }
        },
        [...failures]
      );
      expect(checks.map(({ status }) => status)).toEqual([
        'SUCCESS',
        action === 'replace' ? 'FAILURE' : 'SUCCESS',
        'SUCCESS'
      ]);
    }
  );
});

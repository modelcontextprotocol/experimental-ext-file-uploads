import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectStateless } from '../../../src/connection';
import { DRAFT_PROTOCOL_VERSION } from '../../../src/types';
import {
  CLIENT_CAPABILITIES_META,
  DOWNLOAD_SETTINGS,
  UPLOAD_SETTINGS,
  downloadEntries,
  fileCapabilities,
  fileSettings,
  isLoopback,
  readDownloadBytes,
  readDownloadTarget,
  readUploadRequest,
  resolveTarget,
  sha256,
  uploadBody,
  type FileInput,
  type UploadTarget
} from '../../../src/scenarios/files/common';
import {
  DOWNLOAD_CASES,
  UPLOAD_CASES,
  downloadFilename,
  sampleCall,
  type UploadCase
} from '../../../src/scenarios/files/samples';

const MAX_FIXTURE_DOWNLOAD_BYTES = 64 * 1024;

type UploadFault =
  | 'swap-upload-bytes'
  | 'modify-request-state'
  | 'change-retry-settings'
  | 'reverse-form-fields'
  | 'retry-failed-upload'
  | 'transfer-second-request'
  | 'allow-non-loopback-http'
  | 'block-invalid-address';

function fixtureContext() {
  return JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT ?? '{}') as {
    reportUrl?: string;
    allowedTransferAddresses?: string[];
    downloadDirectory?: string;
  };
}

export async function runFilesUploadClient(
  serverUrl: string,
  fault?: UploadFault,
  connect = connectStateless
) {
  const { reportUrl, allowedTransferAddresses = [] } = fixtureContext();
  if (!reportUrl) throw new Error('Missing upload fixture reportUrl.');
  const conn = await connect(serverUrl, DRAFT_PROTOCOL_VERSION, {
    capabilities: fileCapabilities(UPLOAD_SETTINGS),
    redactWirePayloads: true,
    requireMatchingResponseId: true
  });
  const addressAllowed = (url: URL, endpoint: string) =>
    (url.origin === new URL(endpoint).origin && isLoopback(url.hostname)) ||
    (fault !== 'block-invalid-address' &&
      allowedTransferAddresses.includes(url.hostname));

  const report = async (value: object) => {
    const response = await fetch(reportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
      redirect: 'error'
    });
    if (!response.ok) throw new Error('Could not submit fixture report.');
  };

  const transfer = async (
    target: UploadTarget,
    file: FileInput,
    bytes: Buffer,
    endpoint: string
  ) => {
    const url =
      fault === 'allow-non-loopback-http' && target.url
        ? new URL(target.url)
        : resolveTarget(target, endpoint);
    if (!url || !addressAllowed(url, endpoint) || bytes.length > file.size)
      return false;
    try {
      const response = await fetch(url, {
        ...uploadBody(target, file, bytes),
        method: target.method ?? 'PUT',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(3000)
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  };

  try {
    if (!fileSettings((await conn.discover()).capabilities)?.upload)
      throw new Error('Upload was not advertised.');
    await conn.request('tools/list');
    for (const profile of Object.keys(UPLOAD_CASES) as UploadCase[]) {
      const call = sampleCall(profile);
      const files = Object.values(UPLOAD_CASES[profile].files);
      const ids = files.map(({ file }) => file.id);
      const { result, endpoint } = await conn.requestWithEndpoint<
        Record<string, unknown>
      >('tools/call', call);
      const request = readUploadRequest(result, ids);
      if (!request) {
        if (
          profile === 'invalid' &&
          !allowedTransferAddresses.length &&
          result.isError === true
        )
          continue;
        throw new Error('Expected a valid upload request.');
      }
      let transferred = true;
      for (const target of request.uploads) {
        const { file, bytes } = files.find(
          ({ file }) => file.id === target.fileId
        )!;
        if (fault === 'reverse-form-fields' && target.form)
          target.form.fields.reverse();
        // Use different same-length bytes to show the mock checks file data
        // independently of target success and the retry shape.
        const body =
          fault === 'swap-upload-bytes' && profile === 'raw'
            ? Buffer.alloc(bytes.length, 0x78)
            : bytes;
        let uploaded = await transfer(target, file, body, endpoint);
        if (profile === 'invalid' && target.url) {
          const url = new URL(target.url);
          await report({
            case: 'invalid',
            address: url.hostname,
            addressAllowed: addressAllowed(url, endpoint),
            failed: !uploaded
          });
        }
        // The failed profile exercises a bounded HTTP PUT retry. Both
        // attempts get 503, so the tool call must still end without retrying.
        if (!uploaded && profile === 'failed')
          uploaded = await transfer(target, file, body, endpoint);
        // These negative fixtures deliberately continue after storage rejects
        // a malformed upload so the remaining probes can still run.
        if (
          !uploaded &&
          ((fault === 'swap-upload-bytes' && profile === 'raw') ||
            (fault === 'reverse-form-fields' && profile === 'form'))
        )
          continue;
        if (!uploaded) {
          transferred = false;
          break;
        }
      }
      if (
        !transferred &&
        !(fault === 'retry-failed-upload' && profile === 'failed')
      ) {
        if (profile === 'failed' || profile === 'invalid') continue;
        throw new Error('An expected successful fixture upload failed.');
      }

      const retry = {
        ...call,
        requestState:
          fault === 'modify-request-state' && profile === 'raw'
            ? request.requestState.trim()
            : request.requestState,
        ...(fault === 'change-retry-settings' &&
          profile === 'raw' && {
            _meta: {
              [CLIENT_CAPABILITIES_META]: fileCapabilities({
                ...UPLOAD_SETTINGS,
                download: {}
              })
            }
          })
      };
      const { result: completed, endpoint: retryEndpoint } =
        await conn.requestWithEndpoint<Record<string, unknown>>(
          'tools/call',
          retry
        );
      if (completed.resultType === 'upload_required') {
        if (fault === 'transfer-second-request') {
          const next = readUploadRequest(completed, ids);
          if (next) {
            for (const target of next.uploads) {
              const { file, bytes } = files.find(
                ({ file }) => file.id === target.fileId
              )!;
              await transfer(target, file, bytes, retryEndpoint);
            }
            await conn.request('tools/call', {
              ...call,
              requestState: next.requestState
            });
          }
          await report({ case: 'second', failed: false });
        } else {
          await report({ case: 'second', failed: true });
        }
        continue;
      }
      if (completed.resultType !== 'complete' || completed.isError === true) {
        throw new Error('The fixture upload did not complete.');
      }
    }
  } finally {
    await conn.close();
  }
}

export async function runFilesDownloadClient(
  serverUrl: string,
  keepInvalid = false,
  connect = connectStateless
) {
  const { downloadDirectory } = fixtureContext();
  if (!downloadDirectory) throw new Error('Missing fixture downloadDirectory.');
  const conn = await connect(serverUrl, DRAFT_PROTOCOL_VERSION, {
    capabilities: fileCapabilities(DOWNLOAD_SETTINGS),
    redactWirePayloads: true,
    requireMatchingResponseId: true
  });
  try {
    if (!fileSettings((await conn.discover()).capabilities))
      throw new Error('File Uploads was not advertised.');
    await conn.request('tools/list');
    for (const variant of DOWNLOAD_CASES) {
      const { result, endpoint } = await conn.requestWithEndpoint(
        'tools/call',
        {
          name: 'export_orders',
          arguments: { variant }
        }
      );
      const entries = downloadEntries(result);
      const target =
        Array.isArray(entries) && entries.length === 1
          ? readDownloadTarget(entries[0])
          : undefined;
      const url = target && resolveTarget(target, endpoint);
      if (
        !target ||
        !url ||
        url.origin !== new URL(endpoint).origin ||
        target.size > MAX_FIXTURE_DOWNLOAD_BYTES
      )
        throw new Error('Invalid fixture download target.');
      let bytes: Buffer | undefined;
      try {
        const response = await fetch(url, {
          headers: target.headers,
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(3000)
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error('Expected HTTP 200 from the fixture download.');
        }
        bytes = await readDownloadBytes(response, target.size);
      } catch {
        throw new Error('The fixture download failed.');
      }
      if (!bytes) continue;
      const verified =
        bytes.length === target.size &&
        (!target.digest || sha256(bytes) === target.digest.value);
      if (verified || keepInvalid) {
        await writeFile(
          join(downloadDirectory, variant, downloadFilename),
          bytes,
          { flag: 'wx', mode: 0o600 }
        );
      }
    }
  } finally {
    await conn.close();
  }
}

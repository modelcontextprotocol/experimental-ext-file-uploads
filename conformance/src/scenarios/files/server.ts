import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  JsonRpcError,
  type Connection,
  type RunContext
} from '../../connection';
import {
  DRAFT_PROTOCOL_VERSION,
  type ClientScenario,
  type ConformanceCheck
} from '../../types';
import {
  CLIENT_CAPABILITIES_META,
  DOWNLOAD_SETTINGS,
  FILES_SOURCE,
  UPLOAD_SETTINGS,
  downloadEntries,
  fileCapabilities,
  fileCheck,
  fileSettings,
  fileSummary,
  filesReference,
  missingFixture,
  readDownloadBytes,
  readDownloadTarget,
  readUploadRequest,
  record,
  resolveTarget,
  sha256,
  uploadBody,
  type DownloadTarget,
  type FileCheck,
  type FileInput,
  type UploadTarget
} from './common';
import { ORDER_BYTES } from './samples';

const S01: FileCheck = {
  id: 'files-s01-inline-without-declaration',
  name: 'Inline upload without a declaration',
  description:
    'The server accepts inline data within its advertised limit and uses the decoded bytes.',
  specReferences: [
    filesReference('capabilities'),
    filesReference('file-arguments')
  ]
};
const S05: FileCheck = {
  id: 'files-s05-metadata-rejected',
  name: 'Rejected upload metadata',
  description:
    'The server should return a tool error for a disallowed MIME type before offering a target.',
  specReferences: [filesReference('initial-call')],
  severity: 'WARNING'
};
const S06_TARGETS: FileCheck = {
  id: 'files-s06-upload-targets',
  name: 'Upload targets by file ID',
  description:
    'The upload request contains string requestState and exactly one valid target for each non-empty file without inline data.',
  specReferences: [filesReference('upload-request'), filesReference('targets')]
};
const S06_RETRY: FileCheck = {
  id: 'files-s06-upload-retry',
  name: 'Completed out-of-band upload',
  description:
    'The server uses the uploaded bytes when the client retries with the original call and state.',
  specReferences: [filesReference('retry')]
};
const S12_ERROR: FileCheck = {
  id: 'files-s12-short-write-rejected',
  name: 'Short write rejected',
  description:
    'The server returns a tool error when storage confirms two of three declared bytes.',
  specReferences: [filesReference('retry'), filesReference('errors')]
};
const S12_RUNS: FileCheck = {
  id: 'files-s12-short-write-no-tool-run',
  name: 'Short write tool runs',
  description:
    'The save tool does not run when storage has fewer bytes than the call declared.',
  specReferences: [filesReference('retry'), filesReference('errors')]
};
const S15_ERROR: FileCheck = {
  id: 'files-s15-consumed-state-rejected',
  name: 'Consumed request state',
  description:
    'Replaying the consumed state for an unsafe save returns JSON-RPC -32602.',
  specReferences: [filesReference('repeated-retries'), filesReference('errors')]
};
const S15_RUNS: FileCheck = {
  id: 'files-s15-tool-runs-once',
  name: 'Unsafe save tool runs',
  description: 'The original retry and its replay result in one unsafe save.',
  specReferences: [filesReference('repeated-retries')]
};
const S20_UNAVAILABLE: FileCheck = {
  id: 'files-s20-withhold-unavailable-download',
  name: 'Unavailable download',
  description:
    'The server withholds the target while the file cannot be fetched.',
  specReferences: [filesReference('downloads')]
};
const S20_READY: FileCheck = {
  id: 'files-s20-fetchable-download',
  name: 'Ready download',
  description:
    'The server describes the export and returns a fetchable download in the extension result metadata.',
  specReferences: [filesReference('downloads'), filesReference('targets')]
};

const UPLOAD_CHECKS = [
  S01,
  S05,
  S06_TARGETS,
  S06_RETRY,
  S12_ERROR,
  S12_RUNS,
  S15_ERROR,
  S15_RUNS
];

function blocked(checks: FileCheck[], reason: string): ConformanceCheck[] {
  return checks.map((check) => missingFixture(check, reason));
}

function skip(check: FileCheck, reason: string): ConformanceCheck {
  return { ...fileCheck(check), status: 'SKIPPED', errorMessage: reason };
}

function toolCallParams(
  name: string,
  args: Record<string, unknown>,
  settings?: Record<string, unknown>,
  requestState?: string
) {
  return {
    name,
    arguments: args,
    ...(settings && {
      _meta: { [CLIENT_CAPABILITIES_META]: fileCapabilities(settings) }
    }),
    ...(requestState !== undefined && { requestState })
  };
}

function call(
  conn: Connection,
  name: string,
  args: Record<string, unknown>,
  settings?: Record<string, unknown>,
  requestState?: string
) {
  return conn.request<Record<string, unknown>>(
    'tools/call',
    toolCallParams(name, args, settings, requestState)
  );
}

async function callForTarget(
  conn: Connection,
  serverUrl: string,
  name: string,
  args: Record<string, unknown>,
  settings: Record<string, unknown>
) {
  const params = toolCallParams(name, args, settings);
  if (conn.requestWithEndpoint) {
    return conn.requestWithEndpoint<Record<string, unknown>>(
      'tools/call',
      params
    );
  }
  const result = await conn.request<Record<string, unknown>>(
    'tools/call',
    params
  );
  return { result, endpoint: serverUrl };
}

function newFile(bytes: Buffer, mimeType = 'text/plain'): FileInput {
  const id = randomUUID();
  return { id, name: id + '.txt', mimeType, size: bytes.length };
}

function savedFiles(
  result: Record<string, unknown>,
  files: Record<string, Buffer>
): boolean {
  const summaries = record(record(result.structuredContent)?.files);
  return (
    result.resultType === 'complete' &&
    result.isError !== true &&
    !!summaries &&
    Object.entries(files).every(([id, bytes]) =>
      isDeepStrictEqual(summaries[id], fileSummary(bytes))
    )
  );
}

function markedArguments(tool: Record<string, unknown> | undefined) {
  const properties = record(record(tool?.inputSchema)?.properties);
  return (name: string) => record(record(properties?.[name])?.['x-mcp-file']);
}

function fileSizeLimit(
  descriptor: Record<string, unknown>
): number | undefined {
  const { maxSize } = descriptor;
  if (maxSize === undefined) return Infinity;
  if (typeof maxSize === 'number' && Number.isInteger(maxSize) && maxSize >= 0)
    return maxSize;
}

async function listTools(conn: Connection, settings: Record<string, unknown>) {
  const list = await conn.request('tools/list', {
    _meta: { [CLIENT_CAPABILITIES_META]: fileCapabilities(settings) }
  });
  const tools = record(list)?.tools;
  if (
    !Array.isArray(tools) ||
    !tools.every(
      (tool): tool is Record<string, unknown> =>
        typeof record(tool)?.name === 'string'
    )
  ) {
    throw new Error('tools/list must return an array of named tools.');
  }
  return tools;
}

function isToolError(result: Record<string, unknown>): boolean {
  return result.resultType === 'complete' && result.isError === true;
}

// Path targets belong to the final MCP endpoint. The server hostname the
// operator selected with --url is the allowlist for absolute fixture URLs.
function fixtureTarget(
  target: UploadTarget | DownloadTarget,
  endpoint: string,
  serverUrl: string
): URL | undefined {
  const url = resolveTarget(target, endpoint);
  if (
    target.path !== undefined ||
    url?.hostname === new URL(serverUrl).hostname
  )
    return url;
}

function transferSignal(deadline?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(3000);
  return deadline ? AbortSignal.any([deadline, timeout]) : timeout;
}

async function upload(
  url: URL | undefined,
  target: UploadTarget,
  file: FileInput,
  bytes: Buffer,
  deadline?: AbortSignal
) {
  if (!url) return false;
  try {
    const response = await fetch(url, {
      ...uploadBody(target, file, bytes),
      method: target.method ?? 'PUT',
      credentials: 'omit',
      redirect: 'error',
      signal: transferSignal(deadline)
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function inlineUpload(
  conn: Connection,
  maxInlineBytes: unknown,
  fileDescriptor: Record<string, unknown> | undefined
) {
  if (maxInlineBytes === undefined || maxInlineBytes === 0) {
    return skip(S01, 'The advertised profile disables inline transfer.');
  }
  if (
    typeof maxInlineBytes !== 'number' ||
    !Number.isInteger(maxInlineBytes) ||
    maxInlineBytes < 1
  ) {
    return fileCheck(S01, 'Discovery returned an invalid maxInlineBytes.');
  }
  if (!fileDescriptor)
    return missingFixture(
      S01,
      'save_to_folder must advertise a marked file argument.'
    );

  const maxSize = fileSizeLimit(fileDescriptor);
  if (maxSize === undefined || maxSize === 0) {
    return missingFixture(
      S01,
      'The marked file argument needs a valid size limit that permits a non-empty inline file.'
    );
  }
  const bytes = Buffer.from('abc').subarray(
    0,
    Math.min(maxInlineBytes, maxSize)
  );
  const data = bytes.toString('base64');
  const control = { ...newFile(bytes), data };
  const baseline = await call(
    conn,
    'save_to_folder',
    { folderId: 'inline', file: control },
    {}
  ).catch(() => undefined);
  if (!baseline || !savedFiles(baseline, { [control.id]: bytes })) {
    return missingFixture(
      S01,
      'The declared inline control call must save the decoded bytes.'
    );
  }

  const file = { ...newFile(bytes), data };
  try {
    const result = await call(conn, 'save_to_folder', {
      folderId: 'inline',
      file
    });
    return fileCheck(
      S01,
      savedFiles(result, { [file.id]: bytes })
        ? undefined
        : 'The tool did not confirm the decoded byte count and digest.'
    );
  } catch {
    return fileCheck(
      S01,
      'The inline call without the extension declaration returned an error.'
    );
  }
}

async function rejectMetadata(conn: Connection, accept: unknown) {
  if (!isDeepStrictEqual(accept, ['text/plain'])) {
    return missingFixture(
      S05,
      'save_to_folder must advertise and enforce x-mcp-file.accept of ["text/plain"].'
    );
  }
  const file = newFile(Buffer.from('abc'), 'application/octet-stream');
  try {
    const result = await call(
      conn,
      'save_to_folder',
      { folderId: 'metadata', file },
      UPLOAD_SETTINGS
    );
    return fileCheck(
      S05,
      isToolError(result) && result.uploads === undefined
        ? undefined
        : 'The server did not return isError: true before issuing any upload target.'
    );
  } catch {
    return fileCheck(
      S05,
      'The metadata probe should return a tool result with isError: true.'
    );
  }
}

async function multipleUploads(
  conn: Connection,
  ctx: RunContext,
  markedArgument: ReturnType<typeof markedArguments>
): Promise<ConformanceCheck[]> {
  const samples = {
    first: Buffer.from('abc'),
    second: Buffer.from('second file'),
    empty: Buffer.alloc(0)
  };
  const checksToRun = [S06_TARGETS, S06_RETRY];
  const bytes: Buffer[] = [];
  for (const [name, sample] of Object.entries(samples)) {
    const descriptor = markedArgument(name);
    if (!descriptor) {
      return blocked(
        checksToRun,
        `save_files must advertise a marked ${name} argument.`
      );
    }
    const limit = fileSizeLimit(descriptor);
    if (limit === undefined || (limit === 0 && sample.length > 0)) {
      return blocked(
        checksToRun,
        `The save_files ${name} argument has a size limit that cannot support the fixture file.`
      );
    }
    bytes.push(sample.subarray(0, Math.min(sample.length, limit)));
  }
  const files = bytes.map((body) => newFile(body));
  const args = Object.fromEntries(
    Object.keys(samples).map((name, i) => [name, files[i]])
  );
  let initial: Awaited<ReturnType<typeof callForTarget>>;
  try {
    initial = await callForTarget(
      conn,
      ctx.serverUrl,
      'save_files',
      args,
      UPLOAD_SETTINGS
    );
  } catch {
    return [
      fileCheck(S06_TARGETS, 'The initial save_files call failed.'),
      missingFixture(S06_RETRY, 'The server did not issue an upload request.')
    ];
  }

  const request = readUploadRequest(
    initial.result,
    files.filter(({ size }) => size > 0).map(({ id }) => id)
  );
  if (
    !request ||
    request.uploads.some((target) => !resolveTarget(target, initial.endpoint))
  ) {
    return [
      fileCheck(
        S06_TARGETS,
        'Expected string requestState and one valid target per non-empty file ID.'
      ),
      missingFixture(
        S06_RETRY,
        'The server did not issue a valid upload request.'
      )
    ];
  }
  const checks = [fileCheck(S06_TARGETS)];
  for (const target of request.uploads) {
    const index = files.findIndex(({ id }) => id === target.fileId);
    const url = fixtureTarget(target, initial.endpoint, ctx.serverUrl);
    if (!(await upload(url, target, files[index], bytes[index], ctx.signal))) {
      checks.push(
        missingFixture(
          S06_RETRY,
          'The issued path or allowlisted URL must accept the fixture bytes.'
        )
      );
      return checks;
    }
  }
  try {
    const result = await call(
      conn,
      'save_files',
      args,
      UPLOAD_SETTINGS,
      request.requestState
    );
    const expected = Object.fromEntries(
      files.map(({ id }, i) => [id, bytes[i]])
    );
    checks.push(
      fileCheck(
        S06_RETRY,
        savedFiles(result, expected)
          ? undefined
          : 'The retry did not confirm the byte count and digest of the saved files.'
      )
    );
  } catch {
    checks.push(
      fileCheck(
        S06_RETRY,
        'The server rejected the retry after every upload succeeded.'
      )
    );
  }
  return checks;
}

async function fixtureStatus(
  conn: Connection,
  folderId: string,
  fileId: string
) {
  try {
    const result = await call(
      conn,
      'file_uploads_fixture_status',
      { folderId, fileId },
      UPLOAD_SETTINGS
    );
    const status = record(result.structuredContent);
    if (
      result.resultType === 'complete' &&
      result.isError !== true &&
      status &&
      typeof status.runs === 'number' &&
      Number.isInteger(status.runs) &&
      status.runs >= 0
    ) {
      return {
        runs: status.runs,
        storedSize: status.storedSize,
        unsafeSave: status.unsafeSave
      };
    }
  } catch {
    // The probe reports the missing fixture using the dependent check IDs.
  }
}

async function stageSave(
  conn: Connection,
  ctx: RunContext,
  folderId: string,
  file: FileInput,
  body: Buffer
) {
  const args = { folderId, file };
  try {
    const { result, endpoint } = await callForTarget(
      conn,
      ctx.serverUrl,
      'save_to_folder',
      args,
      UPLOAD_SETTINGS
    );
    const request = readUploadRequest(result, [file.id]);
    if (!request) return undefined;
    const target = request.uploads[0];
    if (
      await upload(
        fixtureTarget(target, endpoint, ctx.serverUrl),
        target,
        file,
        body,
        ctx.signal
      )
    ) {
      return () =>
        call(
          conn,
          'save_to_folder',
          args,
          UPLOAD_SETTINGS,
          request.requestState
        );
    }
  } catch {
    // The caller reports which profile could not be staged.
  }
}

async function shortWrite(
  conn: Connection,
  ctx: RunContext
): Promise<ConformanceCheck[]> {
  const checks = [S12_ERROR, S12_RUNS];
  const file = newFile(Buffer.from('abc'));
  const before = await fixtureStatus(conn, 'short-write', file.id);
  if (!before)
    return blocked(
      checks,
      'The short-write profile requires file_uploads_fixture_status.'
    );

  const retry = await stageSave(
    conn,
    ctx,
    'short-write',
    file,
    Buffer.from('ab')
  );
  if (!retry)
    return blocked(
      checks,
      'Short-write storage must return 2xx after accepting two of the three declared bytes.'
    );
  const staged = await fixtureStatus(conn, 'short-write', file.id);
  if (staged?.storedSize !== 2) {
    return blocked(
      checks,
      'The short-write profile must report that storage holds exactly two bytes before retry.'
    );
  }

  const result = await retry().catch(() => undefined);
  const after = await fixtureStatus(conn, 'short-write', file.id);
  return [
    fileCheck(
      S12_ERROR,
      result && isToolError(result)
        ? undefined
        : 'Expected a completed tool result with isError: true for the short write.'
    ),
    after
      ? fileCheck(
          S12_RUNS,
          after.runs === before.runs
            ? undefined
            : 'The short-write probe ran the save tool.'
        )
      : missingFixture(
          S12_RUNS,
          'Could not read the save run count after the retry.'
        )
  ];
}

async function consumedState(
  conn: Connection,
  ctx: RunContext
): Promise<ConformanceCheck[]> {
  const checks = [S15_ERROR, S15_RUNS];
  const bytes = Buffer.from('abc');
  const file = newFile(bytes);
  const before = await fixtureStatus(conn, 'unsafe', file.id);
  if (before?.unsafeSave === false)
    return checks.map((check) =>
      skip(check, 'The fixture declares no unsafe save profile.')
    );
  if (before?.unsafeSave !== true)
    return blocked(
      checks,
      'The fixture must report whether it has an unsafe save profile.'
    );

  const retry = await stageSave(conn, ctx, 'unsafe', file, bytes);
  const completed = await retry?.().catch(() => undefined);
  if (!retry || !completed || !savedFiles(completed, { [file.id]: bytes })) {
    return blocked(
      checks,
      'The unsafe save must complete successfully before its state can be replayed.'
    );
  }

  let code: number | undefined;
  try {
    await retry();
  } catch (e) {
    if (e instanceof JsonRpcError) code = e.code;
  }
  const after = await fixtureStatus(conn, 'unsafe', file.id);
  return [
    fileCheck(
      S15_ERROR,
      code === -32602
        ? undefined
        : 'Replaying consumed requestState must return JSON-RPC -32602 with the replay request ID.'
    ),
    after
      ? fileCheck(
          S15_RUNS,
          after.runs === before.runs + 1
            ? undefined
            : 'The unsafe save did not run exactly once across the initial call, retry, and replay.'
        )
      : missingFixture(
          S15_RUNS,
          'Could not read the unsafe save run count after replay.'
        )
  ];
}

export class FileUploadsServerUploadScenario implements ClientScenario {
  name = 'file-uploads-server-upload';
  readonly source = FILES_SOURCE;
  description =
    'Exercises inline and staged uploads on MCP 2026-07-28 (S01, S05, S06, S12, S15). The fixture exposes save_to_folder with folderId and a marked text/plain file, and save_files with marked first, second, and empty file arguments. Successful saves return structuredContent.files keyed by file ID with size and SHA-256 digest objects. The short-write folder accepts a two-byte write and the unsafe folder records each save. file_uploads_fixture_status accepts folderId and fileId and returns structuredContent with runs, storedSize when staged, and unsafeSave for the unsafe profile. Storage targets use the test server hostname.';

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    if (ctx.specVersion !== DRAFT_PROTOCOL_VERSION)
      return blocked(UPLOAD_CHECKS, 'File Uploads requires MCP 2026-07-28.');
    const conn = await ctx.connect({
      redactWirePayloads: true,
      requireMatchingResponseId: true
    });
    try {
      let settings: Record<string, unknown> | undefined;
      let tools: Record<string, unknown>[];
      try {
        settings = fileSettings((await conn.discover()).capabilities);
        if (!settings)
          return blocked(
            UPLOAD_CHECKS,
            'Discovery must advertise io.modelcontextprotocol/files.'
          );
        tools = await listTools(
          conn,
          record(settings.upload) ? UPLOAD_SETTINGS : {}
        );
      } catch {
        return blocked(
          UPLOAD_CHECKS,
          'Discovery and tools/list must succeed on the File Uploads fixture.'
        );
      }

      const save = markedArguments(
        tools.find(({ name }) => name === 'save_to_folder')
      )('file');
      const checks = [await inlineUpload(conn, settings.maxInlineBytes, save)];
      if (settings.upload === undefined) {
        return [
          ...checks,
          ...UPLOAD_CHECKS.slice(1).map((check) =>
            skip(check, 'The server did not advertise out-of-band upload.')
          )
        ];
      }
      if (!record(settings.upload)) {
        return [
          ...checks,
          ...blocked(
            UPLOAD_CHECKS.slice(1),
            'Discovery must advertise upload for the staged upload fixture.'
          )
        ];
      }
      checks.push(await rejectMetadata(conn, save?.accept));
      const multi = markedArguments(
        tools.find(({ name }) => name === 'save_files')
      );
      checks.push(...(await multipleUploads(conn, ctx, multi)));
      checks.push(
        ...(save
          ? [
              ...(await shortWrite(conn, ctx)),
              ...(await consumedState(conn, ctx))
            ]
          : blocked(
              [S12_ERROR, S12_RUNS, S15_ERROR, S15_RUNS],
              'save_to_folder must advertise a marked file argument.'
            ))
      );
      return checks;
    } finally {
      await conn.close();
    }
  }
}

function containsTarget(value: unknown, issuedAddress?: RegExp): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (typeof entry === 'string' && issuedAddress?.test(entry)) return true;
    if (Array.isArray(entry)) {
      for (const item of entry) pending.push(item);
    }
    const object = record(entry);
    if (!object) continue;
    if (
      (typeof object.url === 'string' || typeof object.path === 'string') &&
      readDownloadTarget(object)
    ) {
      return true;
    }
    for (const [key, item] of Object.entries(object)) {
      if (issuedAddress?.test(key)) return true;
      pending.push(item);
    }
  }
  return false;
}

function downloadAddressPattern(
  target: DownloadTarget,
  resolved: URL,
  endpoint: string
): RegExp {
  const addresses = new Set([
    target.url ?? target.path ?? resolved.href,
    resolved.href
  ]);
  if (resolved.origin === new URL(endpoint).origin) {
    addresses.add(resolved.pathname + resolved.search + resolved.hash);
  }
  const literals = [...addresses].map((address) =>
    address.replace(/[.*+?$^{}()|[\]\\]/g, '\\$&')
  );
  // Match an address in prose or a URI field without matching path prefixes.
  return new RegExp(
    '(?:^|[\\s<>"\'\\x60(\\[{=:])(?:' +
      literals.join('|') +
      ')(?=$|[\\s<>"\'\\x60)\\]}]|[.,;:!?](?=$|\\s))'
  );
}

function describesExport(block: unknown): boolean {
  const content = record(block);
  const nonempty = (value: unknown) =>
    typeof value === 'string' && value.trim() !== '';
  switch (content?.type) {
    case 'text':
      return nonempty(content.text);
    case 'resource_link':
      return [content.description, content.title, content.name].some(nonempty);
    case 'resource': {
      const resource = record(content.resource);
      return nonempty(resource?.text) || nonempty(resource?.blob);
    }
    case 'image':
    case 'audio':
      return nonempty(content.data);
    default:
      return false;
  }
}

async function checkReadyDownload(
  conn: Connection,
  ctx: RunContext
): Promise<{ check: ConformanceCheck; issuedAddress?: RegExp }> {
  let issuedAddress: RegExp | undefined;
  const ready = (detail?: string) => ({
    check: fileCheck(S20_READY, detail),
    issuedAddress
  });
  try {
    const { result, endpoint } = await callForTarget(
      conn,
      ctx.serverUrl,
      'export_orders',
      { available: true },
      DOWNLOAD_SETTINGS
    );
    const entries = downloadEntries(result);
    const target =
      Array.isArray(entries) && entries.length === 1
        ? readDownloadTarget(entries[0])
        : undefined;
    const url = target && resolveTarget(target, endpoint);
    if (target && url) {
      issuedAddress = downloadAddressPattern(target, url, endpoint);
    }
    const described =
      Array.isArray(result.content) && result.content.some(describesExport);
    if (
      result.resultType !== 'complete' ||
      result.isError === true ||
      !target ||
      !described
    ) {
      return ready(
        'Expected an export description and one download target in the extension result metadata.'
      );
    }
    if (!url) return ready('The ready export returned an invalid target.');
    if (
      containsTarget(result.content, issuedAddress) ||
      containsTarget(result.structuredContent, issuedAddress)
    ) {
      return ready(
        'The download target appeared in content or structuredContent.'
      );
    }
    if (!fixtureTarget(target, endpoint, ctx.serverUrl)) {
      return {
        check: missingFixture(
          S20_READY,
          'The download must use a path or an allowlisted URL.'
        ),
        issuedAddress
      };
    }
    const headers = new Headers(target.headers);
    const response = await fetch(url, {
      headers,
      credentials: 'omit',
      redirect: 'error',
      signal: transferSignal(ctx.signal)
    });
    const rangedResponse = response.status === 206 && headers.has('Range');
    if (response.status !== 200 && !rangedResponse) {
      await response.body?.cancel();
      return ready(
        'Expected HTTP 200 or HTTP 206 in response to a range request.'
      );
    }
    const bytes = await readDownloadBytes(
      response,
      Math.min(target.size, ORDER_BYTES.length)
    );
    return ready(
      bytes?.equals(ORDER_BYTES) &&
        bytes.length === target.size &&
        (!target.digest || sha256(bytes) === target.digest.value)
        ? undefined
        : 'The target did not serve the ready export with the advertised size and digest.'
    );
  } catch {
    return ready('The ready export call or download failed.');
  }
}

export class FileUploadsServerDownloadScenario implements ClientScenario {
  name = 'file-uploads-server-download';
  readonly source = FILES_SOURCE;
  description =
    'Exercises download availability on MCP 2026-07-28 (S20). export_orders takes available: false for an unavailable export and available: true for the ready export. The ready target serves the CSV id,total\\n1,3\\n on the test server hostname.';

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks = [S20_UNAVAILABLE, S20_READY];
    if (ctx.specVersion !== DRAFT_PROTOCOL_VERSION)
      return blocked(checks, 'File Uploads requires MCP 2026-07-28.');
    const conn = await ctx.connect({
      redactWirePayloads: true,
      requireMatchingResponseId: true
    });
    try {
      try {
        const settings = fileSettings((await conn.discover()).capabilities);
        if (
          !settings ||
          !(await listTools(conn, DOWNLOAD_SETTINGS)).some(
            ({ name }) => name === 'export_orders'
          )
        ) {
          return blocked(
            checks,
            'Discovery must advertise File Uploads and tools/list must include export_orders.'
          );
        }
      } catch {
        return blocked(
          checks,
          'Discovery and tools/list must succeed on the download fixture.'
        );
      }
      let pending: Record<string, unknown> | undefined;
      try {
        pending = await call(
          conn,
          'export_orders',
          { available: false },
          DOWNLOAD_SETTINGS
        );
      } catch {
        // Still exercise the ready export when the unavailable probe fails.
      }
      const ready = await checkReadyDownload(conn, ctx);
      if (!pending) {
        return [
          missingFixture(
            S20_UNAVAILABLE,
            'export_orders must accept the unavailable export probe.'
          ),
          ready.check
        ];
      }
      const entries = downloadEntries(pending);
      return [
        fileCheck(
          S20_UNAVAILABLE,
          (entries === undefined ||
            (Array.isArray(entries) && entries.length === 0)) &&
            !containsTarget(pending.content, ready.issuedAddress) &&
            !containsTarget(pending.structuredContent, ready.issuedAddress)
            ? undefined
            : 'The unavailable export must withhold download targets.'
        ),
        ready.check
      ];
    } finally {
      await conn.close();
    }
  }
}

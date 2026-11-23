import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { MIMEType } from 'node:util';
import express from 'express';
import { JsonRpcError } from '../../connection';
import {
  createServerStateless,
  type MockServer,
  type ScenarioContext
} from '../../mock-server';
import type { JSONRPCRequest } from '../../jsonrpc';
import {
  DRAFT_PROTOCOL_VERSION,
  type ConformanceCheck,
  type Scenario
} from '../../types';
import {
  FILES_SOURCE,
  declaredFiles,
  fileCapabilities,
  fileCheck,
  filesReference,
  isLoopback,
  missingFixture,
  readFileInput,
  record,
  requireFileCapability,
  sameJsonValue,
  type FileCheck,
  type UploadTarget
} from './common';
import {
  FORM_FIELDS,
  FORM_FILE_FIELD,
  UPLOAD_CASES,
  saveTools,
  type UploadCase
} from './samples';

const C06_BYTES: FileCheck = {
  id: 'files-c06-upload-by-file-id',
  name: 'Bytes sent to the matching targets',
  description:
    'The client uploads the original bytes to each file ID’s target before retrying.',
  specReferences: [filesReference('transfer')]
};
const C06_RETRY: FileCheck = {
  id: 'files-c06-retry-after-transfers',
  name: 'Retry after successful uploads',
  description: 'The client retries the tool once after every upload succeeds.',
  specReferences: [filesReference('transfer')]
};
const C06_ID: FileCheck = {
  id: 'files-c06-fresh-json-rpc-id',
  name: 'Fresh JSON-RPC ID',
  description: 'The retry uses a new JSON-RPC ID.',
  specReferences: [filesReference('retry')]
};
const C06_STATE: FileCheck = {
  id: 'files-c06-exact-request-state',
  name: 'Exact requestState echo',
  description: 'The retry echoes the opaque requestState exactly.',
  specReferences: [filesReference('retry')]
};
const C06_SETTINGS: FileCheck = {
  id: 'files-c06-original-call-and-settings',
  name: 'Original call and settings',
  description:
    'The client declares upload for tools/list and tools/call and preserves the tool name, arguments, and extension settings on retry.',
  specReferences: [filesReference('capabilities'), filesReference('retry')]
};
const C07: FileCheck = {
  id: 'files-c07-form-field-order',
  name: 'Multipart upload',
  description:
    'The client sends the form fields in order, then the payload file part.',
  specReferences: [filesReference('transfer')]
};
const C10: FileCheck = {
  id: 'files-c10-no-retry-after-failure',
  name: 'Failed upload',
  description:
    'The client sends no tools/call retry when a requested transfer fails.',
  specReferences: [filesReference('transfer')]
};
const C11: FileCheck = {
  id: 'files-c11-stop-after-second-upload-request',
  name: 'Second upload request',
  description:
    'The client fails the logical call without transferring to the second target or retrying again.',
  specReferences: [filesReference('transfer')]
};
const C13: FileCheck = {
  id: 'files-c13-reject-non-loopback-http',
  name: 'Non-loopback HTTP upload target',
  description:
    'The client rejects a reachable, address-allowed HTTP target outside loopback before transfer.',
  specReferences: [filesReference('targets'), filesReference('addresses')]
};

const C06 = [C06_BYTES, C06_RETRY, C06_ID, C06_STATE, C06_SETTINGS];
const TRANSFER = '/mcp/uploads';
const SECOND_TARGET = TRANSFER + '/second-again/file';
const REPORTS = '/mcp/fixture-report';

interface TransferAttempt {
  method: string;
  contentType?: string;
  contentLength?: string;
  bytes: Buffer;
}

interface UploadProbe {
  initial: JSONRPCRequest;
  targets: UploadTarget[];
  requestState: string;
  listedWithUpload: boolean;
  retry?: { request: JSONRPCRequest; allUploadsFinished: boolean };
  secondRequestState?: string;
}

function uploadTargets(
  profile: UploadCase,
  params: Record<string, unknown>
): UploadTarget[] | undefined {
  const { name, files } = UPLOAD_CASES[profile];
  const args = record(params.arguments);
  if (params.name !== name || args?.folderId !== profile) return undefined;

  const ids = new Set<string>();
  const targets: UploadTarget[] = [];
  for (const [argument, { file }] of Object.entries(files)) {
    const input = readFileInput(args[argument]);
    if (
      !input ||
      ids.has(input.id) ||
      input.size !== file.size ||
      input.mimeType !== file.mimeType ||
      input.data !== undefined ||
      (profile === 'form' && input.name !== file.name)
    ) {
      return undefined;
    }
    ids.add(input.id);
    targets.push({
      fileId: input.id,
      path: '/uploads/' + profile + '/' + argument,
      credentials: 'omit'
    });
  }
  if (name === 'save_files' && args.empty !== undefined) {
    // This fixture reserves the optional marked argument for a zero-byte file.
    const empty = readFileInput(args.empty);
    if (
      !empty ||
      empty.size !== 0 ||
      empty.data !== undefined ||
      ids.has(empty.id)
    )
      return undefined;
  }
  // Reverse the argument order so clients must match targets by fileId.
  return targets.reverse();
}

function hasFreshId(first: JSONRPCRequest, retry: JSONRPCRequest): boolean {
  return (
    retry.id !== first.id &&
    (typeof retry.id === 'string' || Number.isInteger(retry.id))
  );
}

function repeatsCall(first: JSONRPCRequest, retry: JSONRPCRequest): boolean {
  return (
    retry.params?.name === first.params?.name &&
    sameJsonValue(retry.params?.arguments, first.params?.arguments) &&
    sameJsonValue(declaredFiles(retry.params), declaredFiles(first.params))
  );
}

function dispositionParameters(header: string) {
  const prefix = /^content-disposition:[ \t]*form-data[ \t]*/i.exec(header);
  if (!prefix) return undefined;
  // Match complete parameters, so semicolons in quoted values cannot be
  // mistaken for parameter separators. Keep unquoted values distinct.
  const parameter =
    /;[ \t]*([!#$%&'*+.^_\x60|~\w-]+)[ \t]*=[ \t]*(?:"((?:[^"\\]|\\.)*)"|[!#$%&'*+.^_\x60|~\w-]+)[ \t]*/gy;
  const parameters = new Map<string, string | undefined>();
  parameter.lastIndex = prefix[0].length;
  while (parameter.lastIndex < header.length) {
    const match = parameter.exec(header);
    if (!match) return undefined;
    const [, rawName, quotedValue] = match;
    const name = rawName.toLowerCase();
    if (parameters.has(name)) return undefined;
    parameters.set(name, quotedValue);
  }
  return parameters;
}

function validForm(attempt: TransferAttempt): boolean {
  if (
    !attempt.contentType ||
    attempt.method !== 'POST' ||
    Number(attempt.contentLength) !== attempt.bytes.length
  )
    return false;
  let boundary: string | null;
  try {
    const type = new MIMEType(attempt.contentType);
    if (type.essence !== 'multipart/form-data') return false;
    boundary = type.params.get('boundary');
  } catch {
    return false;
  }
  if (
    !boundary ||
    !/^[\w'()+_,./:=? -]{0,69}[\w'()+_,./:=?-]$/.test(boundary)
  ) {
    return false;
  }

  const body = attempt.bytes.toString('utf8');
  const escapedBoundary = boundary.replace(/[.*+?$^{}()|[\]\\]/g, '\\$&');
  const delimiter = new RegExp(
    '(?:^|\\r\\n)--' + escapedBoundary + '(--)?[ \\t]*(?:\\r\\n|$)',
    'g'
  );
  const parts: string[] = [];
  let start: number | undefined;
  let closed = false;
  for (const match of body.matchAll(delimiter)) {
    if (start !== undefined) parts.push(body.slice(start, match.index));
    if (match[1]) {
      closed = true;
      break;
    }
    start = match.index + match[0].length;
  }
  if (!closed || parts.length !== FORM_FIELDS.length + 1) return false;

  const decoded = parts.map((part) => {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) return undefined;
    const headers = part.slice(0, split).split('\r\n');
    if (headers.some((header) => /[\r\n]/.test(header))) return undefined;
    const dispositions = headers.filter((header) =>
      /^content-disposition:/i.test(header)
    );
    if (dispositions.length !== 1) return undefined;
    const parameters = dispositionParameters(dispositions[0]);
    if (!parameters) return undefined;
    return {
      parameters,
      headers,
      value: part.slice(split + 4)
    };
  });
  if (
    !FORM_FIELDS.every(({ name, value }, index) => {
      const part = decoded[index];
      return (
        part?.parameters.get('name') === name &&
        !part.parameters.has('filename') &&
        !part.parameters.has('filename*') &&
        part.value === value
      );
    })
  )
    return false;

  const file = decoded[decoded.length - 1];
  if (!file) return false;
  const contentTypes = file.headers.filter((header) =>
    /^content-type:/i.test(header)
  );
  return (
    file.parameters.get('name') === FORM_FILE_FIELD &&
    file.parameters.get('filename') === 'ordérs%22%0D%0A.txt' &&
    !file.parameters.has('filename*') &&
    contentTypes.length === 1 &&
    /^content-type:\s*text\/plain\s*$/i.test(contentTypes[0]) &&
    file.value === UPLOAD_CASES.form.files.file.bytes.toString('utf8')
  );
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

// A separate listener bound to an address on this machine makes a broken
// scheme check observable without sending a request to another machine.
async function nonLoopbackTarget(
  onContact: () => void
): Promise<{ server: Server; url: URL } | undefined> {
  for (const info of Object.values(networkInterfaces()).flat()) {
    if (
      !info ||
      info.family !== 'IPv4' ||
      info.internal ||
      isLoopback(info.address)
    )
      continue;
    const targetPath = '/upload/' + randomUUID();
    let grading = false;
    const server = createServer((req, res) => {
      if (grading) onContact();
      req.resume();
      res
        .writeHead(req.url === '/health' || req.url === targetPath ? 204 : 404)
        .end();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, info.address, resolve);
      });
      const address = server.address();
      if (address && typeof address === 'object') {
        const url = new URL(
          'http://' + info.address + ':' + address.port + targetPath
        );
        const response = await fetch(new URL('/health', url), {
          redirect: 'error',
          signal: AbortSignal.timeout(1500)
        });
        if (response.status === 204) {
          grading = true;
          return { server, url };
        }
      }
    } catch {
      // Try another local interface if this address is unavailable.
    }
    await closeServer(server);
  }
}

export class FileUploadsClientUploadScenario implements Scenario {
  name = 'file-uploads-client-upload';
  readonly source = FILES_SOURCE;
  description =
    'Exercises raw and multipart uploads, failed transfers, repeated upload requests, and invalid targets on MCP 2026-07-28 (C06, C07, C10, C11, C13). Call save_files for the raw and failed folderId profiles, and save_to_folder for form, second, and invalid. Run one logical call at a time with the synthetic files in samples.ts. The fixture context supplies reportUrl and allowedTransferAddresses. Report whether the logical call failed for cases second and invalid. For case invalid, also report address and addressAllowed for the issued target, applying the allowlist independently of the scheme.';

  private mock?: MockServer;
  private invalidTarget?: Awaited<ReturnType<typeof nonLoopbackTarget>>;
  private invalidContacts = 0;
  private invalidAddressConfirmed = false;
  private invalidFailed?: boolean;
  private secondFailed?: boolean;
  private probes = new Map<UploadCase, UploadProbe>();
  private successful = new Set<string>();
  private listedWithUpload = false;
  private failedAttempts = 0;
  private secondContacts = 0;

  async start(ctx: ScenarioContext) {
    if (ctx.specVersion !== DRAFT_PROTOCOL_VERSION)
      throw new Error('File Uploads requires MCP 2026-07-28.');
    this.invalidContacts = 0;
    this.invalidAddressConfirmed = false;
    this.invalidFailed = undefined;
    this.secondFailed = undefined;
    this.probes.clear();
    this.successful.clear();
    this.listedWithUpload = false;
    this.failedAttempts = 0;
    this.secondContacts = 0;
    this.invalidTarget = await nonLoopbackTarget(() => this.invalidContacts++);
    try {
      this.mock = await createServerStateless(
        {
          'tools/list': (params) => {
            const settings = declaredFiles(params);
            this.listedWithUpload ||= !!record(settings?.upload);
            return { tools: settings ? saveTools() : [] };
          },
          'tools/call': (params, request) => this.callTool(params, request)
        },
        ctx.specVersion,
        {
          capabilities: fileCapabilities({ upload: {} }),
          redactWirePayloads: true,
          host: '127.0.0.1',
          mountRoutes: (app) => this.mountRoutes(app)
        }
      );
      return {
        serverUrl: this.mock.url,
        context: {
          reportUrl: this.mock.baseUrl + REPORTS,
          allowedTransferAddresses: this.invalidTarget
            ? [this.invalidTarget.url.hostname]
            : []
        }
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    if (this.mock) await this.mock.close();
    if (this.invalidTarget) await closeServer(this.invalidTarget.server);
    this.mock = undefined;
    this.invalidTarget = undefined;
  }

  private mountRoutes(app: express.Application) {
    app.all(TRANSFER + '/failed/first', (req, res) => {
      if (req.method === 'PUT' && this.probes.has('failed'))
        this.failedAttempts++;
      req.resume();
      // PUT retries are permitted. Every attempt at this target fails.
      res.status(503).end();
    });
    app.all(SECOND_TARGET, (req, res) => {
      this.secondContacts++;
      req.resume();
      res.status(204).end();
    });
    app.all(
      TRANSFER + '/:profile/:argument',
      (req, res, next) => {
        const encoding = req.get('Content-Encoding')?.toLowerCase();
        if (encoding === undefined || encoding === 'identity') return next();
        req.resume();
        res.status(415).end();
      },
      express.raw({ type: () => true, inflate: false, limit: '64kb' }),
      (req, res) => {
        const profile = req.params.profile as UploadCase;
        const probe = this.probes.get(profile);
        const targetPath = req.path.slice('/mcp'.length);
        if (!probe?.targets.some(({ path }) => path === targetPath)) {
          res.status(404).end();
          return;
        }
        const contentTypes = req.headersDistinct['content-type'];
        const transfer = {
          method: req.method,
          contentType: contentTypes?.length === 1 ? contentTypes[0] : undefined,
          contentLength: req.get('Content-Length'),
          bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
        };
        const expected = Object.entries(UPLOAD_CASES[profile].files).find(
          ([argument]) => argument === req.params.argument
        )?.[1].bytes;
        const valid =
          profile === 'form'
            ? validForm(transfer)
            : transfer.method === 'PUT' &&
              expected !== undefined &&
              transfer.bytes.equals(expected);
        if (valid) res.on('finish', () => this.successful.add(req.path));
        res.status(valid ? 204 : 400).end();
      }
    );
    app.post(REPORTS, express.json(), (req, res) => {
      if (
        req.body?.case === 'invalid' &&
        this.probes.has('invalid') &&
        req.body.address === this.invalidTarget?.url.hostname
      ) {
        this.invalidAddressConfirmed = req.body.addressAllowed === true;
        if (typeof req.body.failed === 'boolean') {
          this.invalidFailed = this.invalidFailed !== false && req.body.failed;
        }
      }
      if (
        req.body?.case === 'second' &&
        typeof req.body.failed === 'boolean' &&
        this.probes.get('second')?.secondRequestState !== undefined
      ) {
        this.secondFailed = this.secondFailed !== false && req.body.failed;
      }
      res.status(204).end();
    });
  }

  private profile(params: unknown): UploadCase | undefined {
    const args = record(params);
    if (typeof args?.requestState === 'string') {
      for (const [profile, probe] of this.probes) {
        if (
          args.requestState === probe.requestState ||
          args.requestState === probe.secondRequestState
        )
          return profile;
      }
    }
    const profile = record(args?.arguments)?.folderId;
    if (
      typeof profile === 'string' &&
      Object.prototype.hasOwnProperty.call(UPLOAD_CASES, profile)
    ) {
      return profile as UploadCase;
    }
  }

  private uploadsFinished(probe: UploadProbe): boolean {
    return probe.targets.every(({ path }) =>
      this.successful.has('/mcp' + path)
    );
  }

  private callTool(params: Record<string, unknown>, request: JSONRPCRequest) {
    const profile = this.profile(params);
    if (!profile)
      throw new JsonRpcError(-32602, 'Unknown File Uploads fixture profile');
    const probe = this.probes.get(profile);
    if (probe) {
      probe.retry ??= {
        request,
        allUploadsFinished: this.uploadsFinished(probe)
      };
    }
    requireFileCapability(declaredFiles(params), 'upload');
    if (!probe) {
      const targets = uploadTargets(profile, params);
      if (!targets || params.requestState !== undefined) {
        throw new JsonRpcError(
          -32602,
          'Invalid initial File Uploads fixture arguments'
        );
      }
      const requestState = ' {\n  "nonce": "' + randomUUID() + '"\n}\t';
      if (profile === 'form') {
        targets[0].method = 'POST';
        targets[0].form = { fields: FORM_FIELDS, fileField: FORM_FILE_FIELD };
      }
      if (profile === 'invalid') {
        if (!this.invalidTarget)
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'The local non-loopback receiver is unavailable.'
              }
            ]
          };
        delete targets[0].path;
        targets[0].url = this.invalidTarget.url.href;
      }
      this.probes.set(profile, {
        initial: request,
        targets,
        requestState,
        listedWithUpload: this.listedWithUpload
      });
      return { resultType: 'upload_required', requestState, uploads: targets };
    }
    if (profile === 'second' && probe.retry?.request === request) {
      if (
        !probe.retry.allUploadsFinished ||
        params.requestState !== probe.requestState ||
        !hasFreshId(probe.initial, request) ||
        !repeatsCall(probe.initial, request)
      ) {
        throw new JsonRpcError(
          -32602,
          'Invalid first retry for the second upload request fixture.'
        );
      }
      probe.secondRequestState = randomUUID();
      return {
        resultType: 'upload_required',
        requestState: probe.secondRequestState,
        uploads: [
          {
            fileId: probe.targets[0].fileId,
            path: '/uploads/second-again/file',
            credentials: 'omit'
          }
        ]
      };
    }
    return { content: [{ type: 'text', text: 'Received fixture upload.' }] };
  }

  private recordedCalls(profile: UploadCase): number {
    let active: UploadCase | undefined;
    const probe = this.probes.get(profile);
    const anchor =
      profile === 'raw' || profile === 'failed'
        ? probe?.initial
        : profile === 'second' && probe?.secondRequestState !== undefined
          ? probe.retry?.request
          : undefined;
    // Both profiles call save_files. Once C10 starts, a bare save_files call
    // can belong to that failed transfer rather than the earlier raw flow.
    const nextSameTool =
      profile === 'raw' ? this.probes.get('failed')?.initial : undefined;
    let probeStarted = false;
    let count = 0;
    for (const request of this.mock?.recorded ?? []) {
      if (request.method !== 'tools/call') continue;
      const observed = this.profile(request.params);
      if (observed && this.probes.get(observed)?.initial === request) {
        active = observed;
      }
      if (request === anchor) probeStarted = true;
      if (request === nextSameTool) probeStarted = false;
      // A malformed retry can lose both its folderId and its requestState.
      const possibleLateRetry =
        probeStarted &&
        !observed &&
        request.params?.name === UPLOAD_CASES[profile].name;
      if ((observed ?? active) === profile || possibleLateRetry) count++;
    }
    return count;
  }

  private rawChecks(): ConformanceCheck[] {
    const probe = this.probes.get('raw');
    if (!probe)
      return C06.map((definition) =>
        missingFixture(
          definition,
          'Call save_files with the raw profile, both fixture files, and upload declared.'
        )
      );
    const { initial: first, retry } = probe;
    const second = retry?.request;
    const correctBytes =
      retry?.allUploadsFinished ?? this.uploadsFinished(probe);
    return [
      fileCheck(
        C06_BYTES,
        correctBytes
          ? undefined
          : 'Both targets must receive the expected raw bytes via PUT before the tool call retry.'
      ),
      fileCheck(
        C06_RETRY,
        retry?.allUploadsFinished && this.recordedCalls('raw') === 2
          ? undefined
          : 'Expected one retry after both HTTP targets responded successfully.'
      ),
      fileCheck(
        C06_ID,
        second && hasFreshId(first, second)
          ? undefined
          : 'The retry must have a different JSON-RPC ID.'
      ),
      fileCheck(
        C06_STATE,
        second?.params?.requestState === probe.requestState
          ? undefined
          : 'The retry must echo the exact requestState.'
      ),
      fileCheck(
        C06_SETTINGS,
        probe.listedWithUpload && second && repeatsCall(first, second)
          ? undefined
          : 'Expected upload on tools/list before the call and the same tool, arguments, and settings on retry.'
      )
    ];
  }

  private formCheck(): ConformanceCheck {
    const probe = this.probes.get('form');
    if (!probe)
      return missingFixture(
        C07,
        'Call save_to_folder with the form profile and upload declared.'
      );
    return fileCheck(
      C07,
      this.uploadsFinished(probe)
        ? undefined
        : 'Expected a multipart POST with ordered fields and a final payload part with the fixture bytes.'
    );
  }

  private failedTransferCheck(): ConformanceCheck {
    if (!this.probes.has('failed'))
      return missingFixture(
        C10,
        'Call save_files with the failed profile and upload declared.'
      );
    const toolsCallRetries = this.recordedCalls('failed') - 1;
    if (toolsCallRetries === 0 && this.failedAttempts === 0)
      return missingFixture(
        C10,
        'The client did not attempt the PUT that always returns HTTP 503.'
      );
    return {
      ...fileCheck(
        C10,
        toolsCallRetries === 0
          ? undefined
          : 'An additional tools/call followed the failed-upload probe without a successful transfer for every file.'
      ),
      details: { httpAttempts: this.failedAttempts, toolsCallRetries }
    };
  }

  private secondRequestCheck(): ConformanceCheck {
    if (this.probes.get('second')?.secondRequestState === undefined) {
      return missingFixture(
        C11,
        'Complete the first transfer and send a valid retry to receive the second upload_required result.'
      );
    }
    if (
      this.secondContacts > 0 ||
      this.recordedCalls('second') > 2 ||
      this.secondFailed === false
    ) {
      return fileCheck(
        C11,
        'The client contacted the second target, retried again, or reported a successful call.'
      );
    }
    if (this.secondFailed !== true)
      return missingFixture(
        C11,
        'Report the logical call outcome after receiving the second upload request.'
      );
    return fileCheck(C11);
  }

  private invalidTargetCheck(): ConformanceCheck {
    if (!this.invalidTarget)
      return missingFixture(
        C13,
        'A reachable local non-loopback IPv4 listener is required.'
      );
    if (!this.probes.has('invalid'))
      return missingFixture(
        C13,
        'Call save_to_folder with the invalid profile and upload declared.'
      );
    if (this.invalidContacts > 0 || this.recordedCalls('invalid') > 1) {
      return fileCheck(
        C13,
        'The client contacted or retried the non-loopback HTTP target.'
      );
    }
    if (this.invalidFailed === false) {
      return fileCheck(
        C13,
        'The client reported success for the invalid target call.'
      );
    }
    if (!this.invalidAddressConfirmed)
      return missingFixture(
        C13,
        'Confirm the client address rule permits the issued target independently of its HTTP scheme.'
      );
    if (this.invalidFailed !== true) {
      return missingFixture(
        C13,
        'Report whether the invalid target caused the logical call to fail.'
      );
    }
    return fileCheck(C13);
  }

  getChecks(): ConformanceCheck[] {
    return [
      ...this.rawChecks(),
      this.formCheck(),
      this.failedTransferCheck(),
      this.secondRequestCheck(),
      this.invalidTargetCheck()
    ];
  }
}

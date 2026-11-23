import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { JsonRpcError } from '../../connection';
import {
  FILES_EXTENSION_ID,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  type ConformanceCheck,
  type SpecReference
} from '../../types';
import { untestableCheck } from '../untestable';

export { FILES_EXTENSION_ID };
export const FILES_SOURCE = { extensionId: FILES_EXTENSION_ID } as const;
export const CLIENT_CAPABILITIES_META =
  'io.modelcontextprotocol/clientCapabilities';
export const UPLOAD_SETTINGS = { upload: {} };
export const DOWNLOAD_SETTINGS = { download: {} };

const DRAFT =
  'https://github.com/modelcontextprotocol/experimental-ext-file-uploads/blob/8a859b8f268926fe4beb84d78565e7cc6f9fa617/specification/draft/file-uploads.md';

export function filesReference(section: string): SpecReference {
  return { id: 'file-uploads-' + section, url: DRAFT + '#' + section };
}

export interface FileCheck {
  id: string;
  name: string;
  description: string;
  specReferences: SpecReference[];
  severity?: 'FAILURE' | 'WARNING';
}

export function fileCheck(
  definition: FileCheck,
  errorMessage?: string
): ConformanceCheck {
  const { severity = 'FAILURE', ...check } = definition;
  return {
    ...check,
    status: errorMessage === undefined ? 'SUCCESS' : severity,
    timestamp: new Date().toISOString(),
    errorMessage
  };
}

export function missingFixture(
  definition: FileCheck,
  reason: string
): ConformanceCheck {
  return untestableCheck(
    definition.id,
    definition.name,
    definition.description,
    reason,
    definition.specReferences,
    definition.severity
  );
}

export function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

/** Compare parsed JSON values using JSON Schema instance equality. */
export function sameJsonValue(left: unknown, right: unknown): boolean {
  const pairs: [unknown, unknown][] = [[left, right]];
  while (pairs.length > 0) {
    const [a, b] = pairs.pop()!;
    // JavaScript's strict equality treats both spellings of numeric zero alike.
    if (a === b) continue;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
        return false;
      for (let i = 0; i < a.length; i++) pairs.push([a[i], b[i]]);
      continue;
    }
    const aObject = record(a);
    const bObject = record(b);
    if (!aObject || !bObject) return false;
    const keys = Object.keys(aObject);
    if (keys.length !== Object.keys(bObject).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(bObject, key)) return false;
      pairs.push([aObject[key], bObject[key]]);
    }
  }
  return true;
}

export function fileSettings(
  capabilities: unknown
): Record<string, unknown> | undefined {
  return record(record(record(capabilities)?.extensions)?.[FILES_EXTENSION_ID]);
}

export function declaredFiles(
  params: unknown
): Record<string, unknown> | undefined {
  return fileSettings(
    record(record(params)?._meta)?.[CLIENT_CAPABILITIES_META]
  );
}

export function fileCapabilities(settings: Record<string, unknown>) {
  return { extensions: { [FILES_EXTENSION_ID]: settings } };
}

export function requireFileCapability(
  settings: Record<string, unknown> | undefined,
  capability: 'upload' | 'download'
) {
  if (!record(settings?.[capability])) {
    throw new JsonRpcError(
      MISSING_REQUIRED_CLIENT_CAPABILITY,
      'The ' + capability + ' capability is required.',
      { requiredCapabilities: fileCapabilities({ [capability]: {} }) }
    );
  }
}

export interface FileInput {
  id: string;
  name?: string;
  mimeType: string;
  size: number;
  data?: string;
}

export function readFileInput(value: unknown): FileInput | undefined {
  const file = record(value);
  if (
    file &&
    typeof file.id === 'string' &&
    file.id.length >= 1 &&
    [...file.id].length <= 128 &&
    typeof file.mimeType === 'string' &&
    typeof file.size === 'number' &&
    Number.isInteger(file.size) &&
    file.size >= 0 &&
    (file.data === undefined || typeof file.data === 'string')
  ) {
    return file as unknown as FileInput;
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

export function fileSummary(bytes: Uint8Array) {
  return {
    size: bytes.length,
    digest: { algorithm: 'sha-256', value: sha256(bytes) }
  };
}

export function markedFile(
  descriptor: { accept?: string[]; maxSize?: number } = {}
) {
  return {
    type: 'object',
    'x-mcp-file': descriptor,
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 128 },
      name: { type: 'string' },
      mimeType: { type: 'string' },
      size: { type: 'integer', minimum: 0 },
      data: { type: 'string' }
    },
    required: ['id', 'mimeType', 'size']
  };
}

const calendarDate = z.iso.date();
const zonedTimestamp =
  /^(\d{4}-\d{2}-\d{2})[Tt]((?:[01]\d|2[0-3]):[0-5]\d):([0-5]\d|60)(?:\.\d+)?([Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isRfc3339Timestamp(value: string): boolean {
  const match = zonedTimestamp.exec(value);
  if (!match || match[0] !== value) return false;
  const [, date, time, seconds, zone] = match;
  if (!calendarDate.safeParse(date).success) return false;
  if (seconds !== '60') return true;

  // A leap second can occur at the end of a UTC month. Apply the offset
  // to the preceding second and check where the clock next turns over.
  const nextSecond = new Date(
    Date.parse(`${date}T${time}:59${zone.toUpperCase()}`) + 1000
  );
  return (
    nextSecond.getUTCDate() === 1 &&
    nextSecond.getUTCHours() === 0 &&
    nextSecond.getUTCMinutes() === 0 &&
    nextSecond.getUTCSeconds() === 0
  );
}

// Targets treat null members as absent. Apply this to each schema-defined
// object so array entries and opaque _meta values keep their original meaning.
function withoutNullMembers(value: unknown): unknown {
  const object = record(value);
  return object
    ? Object.fromEntries(
        Object.entries(object).filter(([, member]) => member !== null)
      )
    : value;
}

const targetFields = {
  url: z.string().optional(),
  path: z.string().optional(),
  headers: z
    .preprocess(withoutNullMembers, z.record(z.string(), z.string()))
    .optional(),
  credentials: z.enum(['omit', 'include']),
  // RFC 3339 permits lowercase t and z. Keep the original value after checking it.
  expiresAt: z.string().refine(isRfc3339Timestamp).optional(),
  _meta: z.record(z.string(), z.unknown()).optional()
};

// File Uploads forbids control characters in multipart names and CR, LF,
// and NUL in field values.
// eslint-disable-next-line no-control-regex
const formName = z.string().regex(/^[^\u0000-\u001f\u007f"\\]+$/);
// eslint-disable-next-line no-control-regex
const formValue = z.string().regex(/^[^\r\n\u0000]*$/);

const uploadTarget = z
  .preprocess(
    withoutNullMembers,
    z.strictObject({
      ...targetFields,
      fileId: z.string(),
      method: z.enum(['PUT', 'POST']).optional(),
      form: z
        .preprocess(
          withoutNullMembers,
          z.strictObject({
            fields: z.array(
              z.preprocess(
                withoutNullMembers,
                z.strictObject({
                  name: formName,
                  value: formValue
                })
              )
            ),
            fileField: formName
          })
        )
        .optional()
    })
  )
  .refine(
    ({ method, form, headers }) =>
      !form ||
      (method === 'POST' &&
        form.fields.every(({ name }) => name !== form.fileField) &&
        Object.keys(headers ?? {}).every(
          (header) =>
            !/^(content-type|content-encoding|content-range|content-digest|repr-digest)$/i.test(
              header
            )
        ))
  );

const downloadTarget = z.preprocess(
  withoutNullMembers,
  z.strictObject({
    ...targetFields,
    name: z.string().optional(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    digest: z
      .preprocess(
        withoutNullMembers,
        z.strictObject({
          algorithm: z.literal('sha-256'),
          value: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
        })
      )
      .optional()
  })
);

export type UploadTarget = z.infer<typeof uploadTarget>;
export type DownloadTarget = z.infer<typeof downloadTarget>;

export function readUploadRequest(result: unknown, fileIds: readonly string[]) {
  const body = record(result);
  if (
    body?.resultType !== 'upload_required' ||
    typeof body.requestState !== 'string'
  ) {
    return undefined;
  }
  const uploads = z.array(uploadTarget).safeParse(body.uploads);
  if (!uploads.success || uploads.data.length !== fileIds.length)
    return undefined;
  const actualIds = new Set(uploads.data.map(({ fileId }) => fileId));
  if (!fileIds.every((id) => actualIds.has(id))) return undefined;
  return { uploads: uploads.data, requestState: body.requestState };
}

export function downloadEntries(result: unknown): unknown {
  return record(record(record(result)?._meta)?.[FILES_EXTENSION_ID])?.downloads;
}

export function readDownloadTarget(
  target: unknown
): DownloadTarget | undefined {
  const parsed = downloadTarget.safeParse(target);
  return parsed.success ? parsed.data : undefined;
}

export function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

export function resolveTarget(
  target: Pick<UploadTarget, 'url' | 'path' | 'headers' | 'credentials'>,
  serverUrl: string
): URL | undefined {
  const mcp = new URL(serverUrl);
  if ((target.url === undefined) === (target.path === undefined))
    return undefined;
  const headers = Object.entries(target.headers ?? {});
  for (const [name, value] of headers) {
    if (
      !/^[!#$%&'*+.^_\x60|~0-9a-z-]+$/i.test(name) ||
      // eslint-disable-next-line no-control-regex
      /[\x00-\x08\x0a-\x1f\x7f]/.test(value) ||
      /^(authorization|cookie|accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i.test(
        name
      )
    )
      return undefined;
    if (
      (target.path !== undefined || target.credentials === 'include') &&
      /^(forwarded|x-original-url|x-rewrite-url|x-http-method-override|x-http-method|x-method-override|x-forwarded-.*)$/i.test(
        name
      )
    )
      return undefined;
  }
  if (target.path !== undefined) {
    if (
      !/^(\/[a-z0-9_~.-]+)+$/i.test(target.path) ||
      target.path
        .split('/')
        .some((segment) => segment === '.' || segment === '..')
    ) {
      return undefined;
    }
    if (
      mcp.protocol !== 'https:' &&
      (mcp.protocol !== 'http:' || !isLoopback(mcp.hostname))
    )
      return undefined;
    mcp.pathname = mcp.pathname.replace(/\/+$/, '') + target.path;
    return mcp;
  }
  if (!target.url || !/^https?:\/\//i.test(target.url)) return undefined;
  try {
    const url = new URL(target.url);
    if (
      url.username ||
      url.password ||
      (url.protocol === 'http:' && !isLoopback(url.hostname)) ||
      (target.credentials === 'include' && url.origin !== mcp.origin)
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

/** Read decoded bytes within the given limit, cancelling an oversized response. */
export async function readDownloadBytes(
  response: Response,
  maxBytes: number
): Promise<Buffer | undefined> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      if (value.byteLength > maxBytes - length) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

export function uploadBody(
  target: UploadTarget,
  file: FileInput,
  bytes: Buffer
) {
  const headers = new Headers(target.headers);
  if (!target.form) return { headers, body: Uint8Array.from(bytes) };

  const boundary = randomBytes(16).toString('hex');
  const segments: Buffer[] = target.form.fields.map(({ name, value }) =>
    Buffer.from(
      '--' +
        boundary +
        '\r\nContent-Disposition: form-data; name="' +
        name +
        '"\r\n\r\n' +
        value +
        '\r\n'
    )
  );
  const baseName = file.name?.split(/[/\\]/).pop();
  const filename = (
    !baseName || baseName === '.' || baseName === '..' ? 'file' : baseName
  ).replace(
    /["\r\n]/g,
    (char) =>
      '%' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
  );
  segments.push(
    Buffer.from(
      '--' +
        boundary +
        '\r\nContent-Disposition: form-data; name="' +
        target.form.fileField +
        '"; filename="' +
        filename +
        '"\r\nContent-Type: ' +
        file.mimeType +
        '\r\n\r\n'
    ),
    bytes,
    Buffer.from('\r\n--' + boundary + '--\r\n')
  );
  const body = Buffer.concat(segments);
  headers.set('Content-Type', 'multipart/form-data; boundary=' + boundary);
  headers.set('Content-Length', String(body.length));
  return { headers, body };
}

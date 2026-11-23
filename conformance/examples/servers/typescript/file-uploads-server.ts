import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { JsonRpcError } from '../../../src/connection';
import { createServerStateless } from '../../../src/mock-server';
import { DRAFT_PROTOCOL_VERSION } from '../../../src/types';
import {
  FILES_EXTENSION_ID,
  declaredFiles,
  fileCapabilities,
  fileSummary,
  readFileInput,
  record,
  requireFileCapability,
  sameJsonValue,
  type FileInput,
  type UploadTarget
} from '../../../src/scenarios/files/common';
import {
  ORDER_BYTES,
  ORDER_MIME_TYPE,
  saveTools
} from '../../../src/scenarios/files/samples';

type ServerFault =
  | 'require-inline-declaration'
  | 'defer-metadata-validation'
  | 'omit-upload-target'
  | 'duplicate-upload-target'
  | 'invalid-request-state'
  | 'run-after-short-write'
  | 'return-success-after-short-write'
  | 'allow-state-replay'
  | 'advertise-unavailable-download';

interface StorageEntry {
  size: number;
  expiresAt: number;
  allowShortWrite: boolean;
  bytes?: Buffer;
}

interface PendingSave {
  name: string;
  args: Record<string, unknown>;
  targets: Map<string, StorageEntry>;
  expiresAt: number;
  consumed: boolean;
}

const EXTRA_TOOLS = [
  {
    name: 'file_uploads_fixture_status',
    description: 'Report the fixture’s stored byte count and save invocations.',
    inputSchema: {
      type: 'object',
      properties: { folderId: { type: 'string' }, fileId: { type: 'string' } },
      required: ['folderId', 'fileId']
    }
  },
  {
    name: 'export_orders',
    description: 'Export the CSV when the fixture makes it available.',
    inputSchema: {
      type: 'object',
      properties: { available: { type: 'boolean' } },
      required: ['available']
    }
  }
];

function toolError(text: string) {
  return { isError: true, content: [{ type: 'text', text }] };
}

function inlineBytes(file: FileInput): Buffer | undefined {
  if (file.data === undefined)
    return file.size === 0 ? Buffer.alloc(0) : undefined;
  const bytes = Buffer.from(file.data, 'base64');
  if (bytes.toString('base64') === file.data && bytes.length === file.size)
    return bytes;
}

export async function startFileUploadsServer(
  options: {
    fault?: ServerFault;
    unsafeSave?: boolean;
    acceptShortWrites?: boolean;
    saveFilesMaxSizes?: Partial<Record<string, number>>;
    pendingExport?: boolean;
  } = {},
  serve = createServerStateless
) {
  const {
    fault,
    unsafeSave = true,
    acceptShortWrites = true,
    saveFilesMaxSizes,
    pendingExport = false
  } = options;
  const storage = new Map<string, StorageEntry>();
  const statusEntries = new Map<string, StorageEntry>();
  const pending = new Map<string, PendingSave>();
  const writes = new Map<string, Buffer[]>();
  let ordersReady = false;
  const maxInlineBytes = 1024;
  const statusKey = (folderId: unknown, fileId: unknown) =>
    JSON.stringify([folderId, fileId]);

  function save(
    name: string,
    args: Record<string, unknown>,
    input: FileInput[],
    targets?: PendingSave['targets']
  ) {
    const contents: Record<
      string,
      ReturnType<typeof fileSummary>
    > = Object.create(null);
    const write = new Map<string, Buffer>();
    for (const file of input) {
      const bytes = targets?.get(file.id)?.bytes ?? inlineBytes(file);
      if (
        !bytes ||
        (name === 'save_to_folder' &&
          (file.mimeType !== 'text/plain' || !isUtf8(bytes)))
      ) {
        return toolError('File bytes failed confirmation.');
      }
      const badSize = bytes.length !== file.size;
      if (
        badSize &&
        fault !== 'run-after-short-write' &&
        fault !== 'return-success-after-short-write'
      ) {
        return toolError('The stored file is shorter than declared.');
      }
      const key = statusKey(args.folderId, file.id);
      write.set(key, bytes);
      contents[file.id] = fileSummary(bytes);
      if (badSize && fault === 'run-after-short-write') {
        const records = writes.get(key) ?? [];
        writes.set(key, [...records, bytes]);
        return toolError('The stored file is shorter than declared.');
      }
    }
    for (const [key, bytes] of write) {
      const records = writes.get(key) ?? [];
      writes.set(key, [...records, bytes]);
    }
    return {
      content: [{ type: 'text', text: 'Saved fixture files.' }],
      structuredContent: { files: contents }
    };
  }

  return serve(
    {
      'tools/list': (params) => ({
        tools: declaredFiles(params)
          ? [...saveTools(saveFilesMaxSizes), ...EXTRA_TOOLS]
          : EXTRA_TOOLS
      }),
      'tools/call': (params) => {
        const name = params.name;
        const args = record(params.arguments) ?? {};
        const settings = declaredFiles(params);
        const { requestState: retryState } = params;
        const state =
          typeof retryState === 'string' ? pending.get(retryState) : undefined;
        if (
          retryState !== undefined &&
          (!state ||
            state.consumed ||
            state.expiresAt <= Date.now() ||
            state.name !== name ||
            !sameJsonValue(state.args, args))
        ) {
          throw new JsonRpcError(-32602, 'Invalid or consumed request state.');
        }
        if (name === 'file_uploads_fixture_status') {
          const key = statusKey(args.folderId, args.fileId);
          return {
            content: [],
            structuredContent: {
              runs: writes.get(key)?.length ?? 0,
              storedSize: statusEntries.get(key)?.bytes?.length,
              ...(args.folderId === 'unsafe' && { unsafeSave })
            }
          };
        }
        if (name === 'export_orders') {
          requireFileCapability(settings, 'download');
          if (typeof args.available !== 'boolean') {
            throw new JsonRpcError(
              -32602,
              'Export availability must be a boolean.'
            );
          }
          if (
            args.available === false &&
            fault !== 'advertise-unavailable-download'
          ) {
            return pendingExport
              ? { resultType: 'input_required', requestState: randomUUID() }
              : toolError('The export is unavailable.');
          }
          if (args.available) ordersReady = true;
          return {
            content: [{ type: 'text', text: 'Exported fixture orders.' }],
            _meta: {
              [FILES_EXTENSION_ID]: {
                downloads: [
                  {
                    name: 'orders.csv',
                    mimeType: ORDER_MIME_TYPE,
                    ...fileSummary(ORDER_BYTES),
                    path:
                      args.available === true
                        ? '/storage/orders'
                        : '/storage/orders-unavailable',
                    credentials: 'omit'
                  }
                ]
              }
            }
          };
        }

        if (name !== 'save_to_folder' && name !== 'save_files')
          throw new JsonRpcError(-32602, 'Unknown fixture tool.');
        const fileArguments =
          name === 'save_to_folder'
            ? ['file']
            : [
                'first',
                'second',
                ...(args.empty === undefined ? [] : ['empty'])
              ];
        const input = fileArguments.map((argument) =>
          readFileInput(args[argument])
        );
        if (input.some((file) => !file))
          return toolError('Invalid file input.');
        const files = input as FileInput[];
        if (new Set(files.map(({ id }) => id)).size !== files.length)
          return toolError('Duplicate file ID.');
        if (
          name === 'save_files' &&
          saveFilesMaxSizes &&
          files.some(
            ({ size }, i) =>
              size > (saveFilesMaxSizes[fileArguments[i]] ?? Infinity)
          )
        ) {
          return toolError('File exceeds the advertised size limit.');
        }

        if (state) {
          requireFileCapability(settings, 'upload');
          for (const file of files) {
            const entry = state.targets.get(file.id);
            if (!entry) continue;
            if (
              !entry.bytes ||
              (entry.bytes.length !== file.size &&
                fault !== 'run-after-short-write' &&
                fault !== 'return-success-after-short-write')
            ) {
              return toolError('File bytes failed confirmation.');
            }
            if (
              name === 'save_to_folder' &&
              (file.mimeType !== 'text/plain' || !isUtf8(entry.bytes))
            ) {
              return toolError('File type failed confirmation.');
            }
          }
          if (
            name === 'save_to_folder' &&
            args.folderId === 'unsafe' &&
            unsafeSave &&
            fault !== 'allow-state-replay'
          ) {
            // The fixture has one process and performs confirmation, consumption,
            // and the append synchronously so two retries cannot consume the state.
            state.consumed = true;
          }
          return save(name, args, files, state.targets);
        }

        if (
          name === 'save_to_folder' &&
          files[0].mimeType !== 'text/plain' &&
          fault !== 'defer-metadata-validation'
        ) {
          return toolError('MIME type is not accepted.');
        }
        const staged = files.filter(
          (file) => file.size > 0 && file.data === undefined
        );
        const inline = files.filter((file) => file.data !== undefined);
        if (
          inline.reduce((size, file) => size + file.size, 0) > maxInlineBytes ||
          inline.some((file) => !inlineBytes(file))
        ) {
          return toolError('Invalid inline data.');
        }
        if (
          inline.length &&
          fault === 'require-inline-declaration' &&
          !settings
        )
          return toolError('An extension declaration is required.');
        if (!staged.length) return save(name, args, files);
        requireFileCapability(settings, 'upload');

        const requestState = randomUUID();
        const expiresAt = Date.now() + 60_000;
        const targets = new Map<string, StorageEntry>();
        const uploads: UploadTarget[] = staged.map((file) => {
          const key = randomUUID();
          const entry = {
            size: file.size,
            expiresAt,
            allowShortWrite:
              acceptShortWrites && args.folderId === 'short-write'
          };
          statusEntries.set(statusKey(args.folderId, file.id), entry);
          storage.set(key, entry);
          targets.set(file.id, entry);
          return {
            fileId: file.id,
            path: '/storage/' + key,
            credentials: 'omit'
          };
        });
        pending.set(requestState, {
          name,
          args,
          targets,
          expiresAt,
          consumed: false
        });
        if (name === 'save_files' && fault === 'omit-upload-target')
          uploads.pop();
        if (name === 'save_files' && fault === 'duplicate-upload-target')
          uploads[1] = uploads[0];
        return {
          resultType: 'upload_required',
          uploads,
          requestState:
            name === 'save_files' && fault === 'invalid-request-state'
              ? null
              : requestState
        };
      }
    },
    DRAFT_PROTOCOL_VERSION,
    {
      capabilities: fileCapabilities({ upload: {}, maxInlineBytes }),
      redactWirePayloads: true,
      host: '127.0.0.1',
      mountRoutes: (app) => {
        app.get('/mcp/storage/orders', (_req, res) => {
          if (!ordersReady) {
            res.status(404).end();
            return;
          }
          res.type(ORDER_MIME_TYPE).status(200).end(ORDER_BYTES);
        });
        app.put(
          '/mcp/storage/:key',
          express.raw({ type: () => true, limit: '64kb' }),
          (req, res) => {
            const entry = storage.get(req.params.key);
            if (!entry || entry.expiresAt <= Date.now()) {
              res.status(404).end();
              return;
            }
            if (entry.bytes) {
              res.status(409).end();
              return;
            }
            const bytes = Buffer.isBuffer(req.body)
              ? req.body
              : Buffer.alloc(0);
            if (
              bytes.length !== entry.size &&
              !(entry.allowShortWrite && bytes.length < entry.size)
            ) {
              res.status(400).end();
              return;
            }
            entry.bytes = bytes;
            res.status(204).end();
          }
        );
      }
    }
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startFileUploadsServer({
    fault: process.env.MCP_FILE_UPLOADS_SERVER_FAULT as ServerFault | undefined
  })
    .then(({ url }) => console.log('File Uploads fixture running on ' + url))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}

import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Dirent
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { JsonRpcError } from '../../connection';
import {
  createServerStateless,
  type MockServer,
  type ScenarioContext
} from '../../mock-server';
import {
  DRAFT_PROTOCOL_VERSION,
  type ConformanceCheck,
  type Scenario
} from '../../types';
import {
  FILES_EXTENSION_ID,
  FILES_SOURCE,
  declaredFiles,
  fileCapabilities,
  fileCheck,
  fileSummary,
  filesReference,
  missingFixture,
  record,
  requireFileCapability,
  type FileCheck
} from './common';
import {
  DOWNLOAD_CASES,
  downloadFilename,
  ORDER_BYTES,
  ORDER_MIME_TYPE,
  type DownloadCase
} from './samples';

const DOWNLOAD_CHECKS: Record<DownloadCase, FileCheck> = {
  valid: {
    id: 'files-c19-accept-valid-download',
    name: 'Valid download',
    description:
      'The client keeps the decoded file after verifying its size and digest.',
    specReferences: [
      filesReference('capabilities'),
      filesReference('downloads')
    ]
  },
  short: {
    id: 'files-c19-discard-short-download',
    name: 'Short download',
    description:
      'The client discards a successful HTTP response whose file is shorter than advertised.',
    specReferences: [
      filesReference('capabilities'),
      filesReference('downloads')
    ]
  },
  'wrong-digest': {
    id: 'files-c19-discard-wrong-digest',
    name: 'Download with a wrong digest',
    description:
      'The client discards a file of the correct size when its SHA-256 digest differs.',
    specReferences: [
      filesReference('capabilities'),
      filesReference('downloads')
    ]
  }
};

const EXPORT_TOOL = {
  name: 'export_orders',
  description: 'Export orders as CSV.',
  inputSchema: {
    type: 'object',
    properties: { variant: { type: 'string', enum: DOWNLOAD_CASES } },
    required: ['variant']
  }
};

const BODIES: Record<DownloadCase, Buffer> = {
  valid: gzipSync(ORDER_BYTES),
  short: ORDER_BYTES.subarray(0, -1),
  'wrong-digest': Buffer.from('id,total\n1,4\n')
};

export class FileUploadsClientDownloadScenario implements Scenario {
  name = 'file-uploads-client-download';
  readonly source = FILES_SOURCE;
  description =
    'Exercises verified downloads on MCP 2026-07-28 (C19). Call export_orders for each variant in tools/list with download declared. Use downloadDirectory from the fixture context for all downloads. Keep each accepted file as orders.csv in its variant subdirectory and remove any rejected file and its temporary copies.';

  private mock?: MockServer;
  private directory?: string;
  private issued = new Map<DownloadCase, boolean>();
  private served = new Set<DownloadCase>();
  private listedWithDownload = false;

  async start(ctx: ScenarioContext) {
    if (ctx.specVersion !== DRAFT_PROTOCOL_VERSION)
      throw new Error('File Uploads requires MCP 2026-07-28.');
    this.issued.clear();
    this.served.clear();
    this.listedWithDownload = false;
    this.directory = mkdtempSync(join(tmpdir(), 'mcp-file-uploads-'));
    try {
      for (const variant of DOWNLOAD_CASES)
        mkdirSync(join(this.directory, variant));
      this.mock = await createServerStateless(
        {
          'tools/list': (params) => {
            this.listedWithDownload ||= !!record(
              declaredFiles(params)?.download
            );
            return { tools: [EXPORT_TOOL] };
          },
          'tools/call': (params) => this.exportOrders(params)
        },
        ctx.specVersion,
        {
          capabilities: fileCapabilities({}),
          redactWirePayloads: true,
          host: '127.0.0.1',
          mountRoutes: (app) => {
            for (const variant of DOWNLOAD_CASES) {
              app.get('/mcp/downloads/' + variant, (req, res) => {
                if (req.method !== 'GET' || !this.issued.has(variant)) {
                  res.status(404).end();
                  return;
                }
                if (variant === 'valid') res.set('Content-Encoding', 'gzip');
                const body = BODIES[variant];
                res.set({
                  'Content-Type': ORDER_MIME_TYPE,
                  'Content-Length': String(body.length)
                });
                res.on('finish', () => this.served.add(variant));
                res.status(200).end(body);
              });
            }
          }
        }
      );
      return {
        serverUrl: this.mock.url,
        context: { downloadDirectory: this.directory }
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    if (this.mock) await this.mock.close();
    if (this.directory)
      rmSync(this.directory, { recursive: true, force: true });
    this.mock = undefined;
    this.directory = undefined;
  }

  private exportOrders(params: Record<string, unknown>) {
    const variant = DOWNLOAD_CASES.find(
      (value) => value === record(params.arguments)?.variant
    );
    if (params.name !== 'export_orders' || !variant) {
      throw new JsonRpcError(
        -32602,
        'Call export_orders with a fixture variant.'
      );
    }
    requireFileCapability(declaredFiles(params), 'download');
    if (!this.issued.has(variant)) {
      this.issued.set(variant, this.listedWithDownload);
    }
    const { size, digest } = fileSummary(ORDER_BYTES);
    return {
      content: [{ type: 'text', text: 'Exported orders.' }],
      _meta: {
        [FILES_EXTENSION_ID]: {
          downloads: [
            {
              name: downloadFilename,
              mimeType: ORDER_MIME_TYPE,
              size,
              ...(variant !== 'short' && { digest }),
              path: '/downloads/' + variant,
              credentials: 'omit'
            }
          ]
        }
      }
    };
  }

  getChecks(): ConformanceCheck[] {
    const root = this.directory;
    let rootEntries: Dirent[] | undefined;
    try {
      if (root && lstatSync(root).isDirectory()) {
        rootEntries = readdirSync(root, { withFileTypes: true });
      }
    } catch {
      // Checks below report an unreadable scratch directory.
    }
    const unexpectedScratchEntry = rootEntries?.some(
      ({ name }) => !DOWNLOAD_CASES.some((variant) => variant === name)
    );
    return DOWNLOAD_CASES.map((variant) => {
      const check = DOWNLOAD_CHECKS[variant];
      if (!root || !this.issued.has(variant) || !this.served.has(variant)) {
        return missingFixture(
          check,
          'Call export_orders with download declared and fetch the ' +
            variant +
            ' response.'
        );
      }
      if (!this.issued.get(variant)) {
        return fileCheck(
          check,
          'Expected tools/list with download declared before calling export_orders.'
        );
      }
      try {
        if (!rootEntries) {
          return fileCheck(
            check,
            'Could not inspect the fixture download directory.'
          );
        }
        if (variant !== 'valid' && unexpectedScratchEntry) {
          return fileCheck(
            check,
            'The client left unexpected artifacts in the download scratch directory.'
          );
        }
        const variantEntry = rootEntries.find(({ name }) => name === variant);
        if (variant !== 'valid' && !variantEntry) return fileCheck(check);
        if (!variantEntry?.isDirectory()) {
          return fileCheck(
            check,
            'Expected a directory for the download variant.'
          );
        }
        const directory = join(root, variant);
        const entries = readdirSync(directory, { withFileTypes: true });
        if (variant !== 'valid') {
          return fileCheck(
            check,
            entries.length === 0
              ? undefined
              : 'The client retained an invalid download.'
          );
        }
        const saved =
          entries.length === 1 &&
          entries[0].isFile() &&
          entries[0].name === downloadFilename &&
          readFileSync(join(directory, downloadFilename)).equals(ORDER_BYTES);
        return fileCheck(
          check,
          saved
            ? undefined
            : 'The client did not keep the decoded fixture file.'
        );
      } catch {
        return fileCheck(
          check,
          'Could not inspect the fixture download directory.'
        );
      }
    });
  }
}

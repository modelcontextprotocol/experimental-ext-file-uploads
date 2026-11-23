import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { startFileUploadsServer } from '../examples/servers/typescript/file-uploads-server';
import { runClientProcess } from './client-process';
import { createServerStateless } from './mock-server';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../run.mjs', import.meta.url));

describe('File Uploads runner', () => {
  it('fails a timed-out client that would exit cleanly on SIGTERM', async () => {
    const script = [
      "process.once('SIGTERM', () => process.exit(0));",
      'setTimeout(() => process.exit(0), 2000);'
    ].join('\n');
    await expect(
      runClientProcess(
        [process.execPath, '--eval', script],
        'http://127.0.0.1/mcp',
        {},
        250
      )
    ).rejects.toThrow('The client process exceeded 250 ms.');
  });

  it('records a client process failure after the protocol checks pass', async () => {
    const output = await mkdtemp(join(tmpdir(), 'mcp-files-runner-test-'));
    const client = new URL(
      '../examples/clients/typescript/run.ts',
      import.meta.url
    );
    const script = [
      "process.argv.splice(1, 0, 'fixture-client');",
      'await import(' + JSON.stringify(client.href) + ');',
      "console.error('Client diagnostic output.');",
      'process.exitCode = 7;'
    ].join('\n');
    try {
      await expect(
        exec(
          process.execPath,
          [
            cli,
            'client',
            '--scenario',
            'file-uploads-client-download',
            '--output-dir',
            output,
            '--',
            process.execPath,
            '--import',
            import.meta.resolve('tsx'),
            '--input-type=module',
            '--eval',
            script
          ],
          { timeout: 8000 }
        )
      ).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('FAILURE client-process-failed')
      });
      const [directory] = await readdir(output);
      const report = await readFile(
        join(output, directory, 'checks.json'),
        'utf8'
      );
      expect(JSON.parse(report)).toEqual([
        expect.objectContaining({
          id: 'files-c19-accept-valid-download',
          status: 'SUCCESS'
        }),
        expect.objectContaining({
          id: 'files-c19-discard-short-download',
          status: 'SUCCESS'
        }),
        expect.objectContaining({
          id: 'files-c19-discard-wrong-digest',
          status: 'SUCCESS'
        }),
        expect.objectContaining({ id: 'wire-schema-valid', status: 'SUCCESS' }),
        expect.objectContaining({
          id: 'client-process-failed',
          status: 'FAILURE',
          errorMessage: 'The client process failed (7).'
        })
      ]);
      expect(report).not.toContain('Client diagnostic output.');
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('bounds the full server scenario and cancels its pending request', async () => {
    const cancelled = vi.fn();
    const fixture = await startFileUploadsServer(
      {},
      (handlers, version, options) =>
        createServerStateless(handlers, version, {
          ...options,
          mountRoutes(app) {
            app.post('/mcp', (req, res, next) => {
              const delay = req.get('Mcp-Method') === 'tools/call' ? 1200 : 300;
              const timer = setTimeout(next, delay);
              res.once('close', () => {
                clearTimeout(timer);
                if (!res.writableEnded) cancelled();
              });
            });
            options?.mountRoutes?.(app);
          }
        })
    );
    try {
      await expect(
        exec(
          process.execPath,
          [
            cli,
            'server',
            '--scenario',
            'file-uploads-server-download',
            '--url',
            fixture.url,
            '--timeout',
            '1500'
          ],
          { timeout: 8000 }
        )
      ).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('FAILURE scenario-timeout')
      });
      await expect.poll(() => cancelled.mock.calls.length).toBe(1);
    } finally {
      await fixture.close();
    }
  });
});

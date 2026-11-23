import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startFileUploadsServer } from '../examples/servers/typescript/file-uploads-server';
import { serveTypeScriptSdk } from '../examples/servers/typescript/sdk';
import { runClientProcess } from './client-process';
import {
  runClientConformanceTest,
  runServerConformanceTest,
  scenarioNames
} from './runner';

const exec = promisify(execFile);

async function* runFixtures(
  serverUrl: string,
  clientCommand: readonly string[]
) {
  for (const scenario of scenarioNames('server')) {
    yield {
      scenario,
      ...(await runServerConformanceTest(serverUrl, scenario))
    };
  }
  for (const scenario of scenarioNames('client')) {
    yield {
      scenario,
      ...(await runClientConformanceTest(scenario, (url, env) =>
        runClientProcess(clientCommand, url, env)
      ))
    };
  }
}

export async function* runTypeScriptFixtures() {
  const server = await startFileUploadsServer({}, serveTypeScriptSdk);
  try {
    const client = fileURLToPath(
      new URL('../examples/clients/typescript/run.ts', import.meta.url)
    );
    yield* runFixtures(server.url, [
      process.execPath,
      '--import',
      import.meta.resolve('tsx'),
      client
    ]);
  } finally {
    await server.close();
  }
}

async function loopbackPort(): Promise<number> {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address() as AddressInfo;
  await new Promise<void>((done) => listener.close(() => done()));
  return port;
}

async function waitForGoFixture(process: ChildProcess, port: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && process.exitCode === null) {
    const listening = await new Promise<boolean>((done) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        done(true);
      });
      socket.once('error', () => done(false));
    });
    if (listening) return;
    await delay(30);
  }
  throw new Error('The Go SDK fixture did not start.');
}

export async function* runGoFixtures(sdkPath: string) {
  const scratch = await mkdtemp(join(tmpdir(), 'mcp-files-go-'));
  let server: ChildProcess | undefined;
  let done: Promise<unknown> | undefined;
  try {
    for (const role of ['server', 'client']) {
      await exec(
        'go',
        [
          'build',
          '-mod=readonly',
          '-o',
          join(scratch, role),
          './conformance/everything-' + role
        ],
        { cwd: resolve(sdkPath), timeout: 120000 }
      );
    }
    const port = await loopbackPort();
    const address = '127.0.0.1:' + port;
    server = spawn(
      join(scratch, 'server'),
      ['-http=' + address, '-stateless=true'],
      {
        stdio: 'ignore'
      }
    );
    done = new Promise<void>((ready, reject) => {
      server!.once('spawn', ready);
      server!.once('error', reject);
    });
    await done;
    done = once(server, 'close');
    await waitForGoFixture(server, port);
    yield* runFixtures('http://' + address + '/mcp', [join(scratch, 'client')]);
  } finally {
    if (server?.pid) {
      if (server.exitCode === null && server.signalCode === null) server.kill();
      await done;
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

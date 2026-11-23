import { execFile } from 'node:child_process';
import { DEFAULT_TIMEOUT_MS } from './types';

export async function runClientProcess(
  command: readonly string[],
  serverUrl: string,
  environment: Record<string, string>,
  timeout = DEFAULT_TIMEOUT_MS
) {
  const [file, ...args] = command;
  if (!file) throw new Error('Supply the client command.');
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      file,
      [...args, serverUrl],
      {
        env: { ...process.env, ...environment },
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024
      },
      (error) => {
        clearTimeout(deadline);
        if (!error) {
          resolve();
          return;
        }
        // Client output can contain signed URLs or opaque request state.
        const message =
          error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? 'The client process exceeded its output limit.'
            : 'The client process failed (' +
              (error.signal ?? error.code ?? 'unknown error') +
              ').';
        reject(new Error(message));
      }
    );
    const deadline = setTimeout(() => {
      reject(new Error(`The client process exceeded ${timeout} ms.`));
      child.kill('SIGKILL');
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }, timeout);
  });
}

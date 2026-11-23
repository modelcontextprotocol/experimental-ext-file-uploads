import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
try {
  const run = args.length
    ? [
        '--import',
        import.meta.resolve('tsx'),
        join(directory, 'src/cli.ts'),
        ...args
      ]
    : [
        fileURLToPath(
          new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))
        ),
        'run'
      ];
  const result = spawnSync(process.execPath, run, {
    cwd: args.length ? process.cwd() : directory,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(
      'Install the suite dependencies with npm ci --prefix conformance.'
    );
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
}

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runClientProcess } from './client-process';
import {
  runClientConformanceTest,
  runServerConformanceTest,
  scenarioNames
} from './runner';
import { DEFAULT_TIMEOUT_MS, type ConformanceCheck } from './types';

const usage = [
  'node conformance/run.mjs',
  'node conformance/run.mjs list',
  'node conformance/run.mjs server --url <url> --scenario <name>',
  'node conformance/run.mjs client --scenario <name> -- <client> [args]',
  'node conformance/run.mjs sdk typescript',
  'node conformance/run.mjs sdk go <go-sdk-checkout>',
  'Client and server commands accept --timeout <ms> and --output-dir <directory>.'
].join('\n');

function report(scenario: string, checks: ConformanceCheck[]) {
  const passed = checks.filter((check) => check.status === 'SUCCESS').length;
  const failed = checks.filter((check) => check.status === 'FAILURE').length;
  const warnings = checks.filter((check) => check.status === 'WARNING').length;
  console.log(scenario);
  for (const check of checks) {
    console.log('  ' + check.status + ' ' + check.id);
    if (check.errorMessage) console.log('  ' + check.errorMessage);
  }
  console.log(
    `Passed: ${passed}/${passed + failed + warnings}, ${failed} failed, ${warnings} warnings`
  );
  if (failed) process.exitCode = 1;
}

async function main() {
  const [role, ...args] = process.argv.slice(2);
  if (role === '--help' || role === '-h') {
    console.log(usage);
    return;
  }
  if (role === 'list' && args.length === 0) {
    console.log(
      [...scenarioNames('server'), ...scenarioNames('client')].join('\n')
    );
    return;
  }
  if (role === 'sdk') {
    const [sdk, path] = args;
    const { runGoFixtures, runTypeScriptFixtures } =
      await import('./sdk-fixtures');
    let runs;
    if (sdk === 'go' && args.length === 2 && path) {
      runs = runGoFixtures(path);
    } else if (sdk === 'typescript' && args.length === 1) {
      runs = runTypeScriptFixtures();
    } else {
      throw new Error(usage);
    }
    for await (const result of runs) {
      report(result.scenario, result.checks);
    }
    return;
  }
  if (role !== 'server' && role !== 'client') throw new Error(usage);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      scenario: { type: 'string' },
      url: { type: 'string' },
      command: { type: 'string' },
      'output-dir': { type: 'string' },
      timeout: { type: 'string' }
    }
  });
  const { scenario } = values;
  if (!scenario || !scenarioNames(role).includes(scenario)) {
    throw new Error('Choose one of ' + scenarioNames(role).join(', '));
  }
  const timeout = Number(values.timeout ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) {
    throw new Error('Use a timeout from 1 to 2147483647 milliseconds.');
  }
  let checks: ConformanceCheck[];
  if (role === 'server') {
    if (!values.url || values.command || positionals.length)
      throw new Error('Supply a server URL.');
    const url = new URL(values.url);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Use an HTTP or HTTPS MCP URL.');
    ({ checks } = await runServerConformanceTest(url.href, scenario, timeout));
  } else {
    const command = values.command ? [values.command] : positionals;
    if (
      values.url ||
      !command.length ||
      (values.command && positionals.length)
    ) {
      throw new Error(
        'Supply one client command. Use -- before a command with arguments.'
      );
    }
    ({ checks } = await runClientConformanceTest(scenario, (url, env) =>
      runClientProcess(command, url, env, timeout)
    ));
  }
  if (values['output-dir']) {
    const output = values['output-dir'];
    await mkdir(output, { recursive: true });
    const runDirectory = await mkdtemp(join(output, scenario + '-'));
    await writeFile(
      join(runDirectory, 'checks.json'),
      JSON.stringify(checks, null, 2) + '\n'
    );
  }
  report(scenario, checks);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

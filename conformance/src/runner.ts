import { connectStateless } from './connection';
import { FileUploadsClientDownloadScenario } from './scenarios/files/client-download';
import { FileUploadsClientUploadScenario } from './scenarios/files/client-upload';
import {
  FileUploadsServerDownloadScenario,
  FileUploadsServerUploadScenario
} from './scenarios/files/server';
import {
  DEFAULT_TIMEOUT_MS,
  DRAFT_PROTOCOL_VERSION,
  type ClientScenario,
  type ConformanceCheck,
  type Scenario
} from './types';
import { wireSchemaChecks, withWireRecorder } from './validation/wire-schema';

const clientScenarios = new Map<string, () => Scenario>([
  ['file-uploads-client-upload', () => new FileUploadsClientUploadScenario()],
  [
    'file-uploads-client-download',
    () => new FileUploadsClientDownloadScenario()
  ]
]);
const serverScenarios = new Map<string, () => ClientScenario>([
  ['file-uploads-server-upload', () => new FileUploadsServerUploadScenario()],
  [
    'file-uploads-server-download',
    () => new FileUploadsServerDownloadScenario()
  ]
]);

export function scenarioNames(role: 'client' | 'server'): string[] {
  return [...(role === 'client' ? clientScenarios : serverScenarios).keys()];
}

export async function runClientConformanceTest(
  scenarioName: string,
  runClient: (url: string, env: Record<string, string>) => Promise<void>
) {
  const scenario = clientScenarios.get(scenarioName)?.();
  if (!scenario) throw new Error('Unknown client scenario ' + scenarioName);
  return withWireRecorder(async () => {
    try {
      const { serverUrl, context } = await scenario.start({
        specVersion: DRAFT_PROTOCOL_VERSION
      });
      let clientError: Error | undefined;
      try {
        await runClient(serverUrl, {
          MCP_CONFORMANCE_SCENARIO: scenarioName,
          MCP_CONFORMANCE_PROTOCOL_VERSION: DRAFT_PROTOCOL_VERSION,
          MCP_CONFORMANCE_CONTEXT: JSON.stringify({
            name: scenarioName,
            ...context
          })
        });
      } catch (error) {
        clientError = error instanceof Error ? error : new Error(String(error));
      }
      const checks = [
        ...scenario.getChecks(),
        ...wireSchemaChecks(DRAFT_PROTOCOL_VERSION)
      ];
      if (clientError) {
        checks.push({
          id: 'client-process-failed',
          name: 'Client process',
          description:
            'The client process exits successfully within the timeout.',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: clientError.message
        });
      }
      return { checks, clientError };
    } finally {
      await scenario.stop();
    }
  });
}

export async function runServerConformanceTest(
  serverUrl: string,
  scenarioName: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  const scenario = serverScenarios.get(scenarioName)?.();
  if (!scenario) throw new Error('Unknown server scenario ' + scenarioName);
  return withWireRecorder(async () => {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), timeoutMs);
    let checks: ConformanceCheck[];
    try {
      checks = await scenario.run({
        serverUrl,
        specVersion: DRAFT_PROTOCOL_VERSION,
        signal: deadline.signal,
        connect: (options) =>
          connectStateless(serverUrl, DRAFT_PROTOCOL_VERSION, {
            ...options,
            signal: deadline.signal
          })
      });
      deadline.signal.throwIfAborted();
    } catch (error) {
      if (!deadline.signal.aborted) throw error;
      checks = [
        {
          id: 'scenario-timeout',
          name: 'Server scenario timeout',
          description: 'The server scenario completes within the timeout.',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `The server scenario exceeded ${timeoutMs} ms.`
        }
      ];
    } finally {
      clearTimeout(timeout);
    }
    return { checks: [...checks, ...wireSchemaChecks(DRAFT_PROTOCOL_VERSION)] };
  });
}

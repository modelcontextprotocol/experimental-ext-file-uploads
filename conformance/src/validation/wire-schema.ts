// Validate the JSON-RPC envelope and its method-specific fields against the
// pinned MCP wire schema.

import { AsyncLocalStorage } from 'node:async_hooks';
import { Ajv, type ValidateFunction, type ErrorObject } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { default as addFormats } from 'ajv-formats';
import {
  DRAFT_PROTOCOL_VERSION,
  FILES_EXTENSION_ID,
  type ConformanceCheck,
  type SpecVersion
} from '../types';
import schemaDraft from '../spec-types/draft.schema.json';

export type WireOrigin = 'harness' | 'implementation';

export interface WireMessageInfo {
  /** Who authored the message: the harness or the implementation-under-test. */
  origin: WireOrigin;
  /** Human-readable location, e.g. `stateless request 'tools/call'`. */
  context: string;
  /** For responses: the answered request's method, so the result is validated
   * against its typed result definition. */
  requestMethod?: string;
  /** The corresponding request, when available, identifies File Uploads
   * traffic and the extension settings that apply to the response. */
  request?: unknown;
  /** Redact the payload even when the message has no extension markers. */
  redactPayload?: boolean;
}

export interface WireSchemaViolation {
  origin: WireOrigin;
  specVersion: SpecVersion;
  context: string;
  errors: string[];
  message: unknown;
}

/** Union definitions that alias a single concrete type (and so carry a
 * `method` const) but are not the canonical definition for that method. */
const NON_CANONICAL_DEFS = new Set([
  'ClientRequest',
  'ClientNotification',
  'ClientResult',
  'ClientMessage',
  'ServerRequest',
  'ServerNotification',
  'ServerResult',
  'ServerMessage'
]);

/** resultType values defined by the core schema (SEP-2322). */
const CORE_RESULT_TYPES: ReadonlySet<string> = new Set([
  'complete',
  'input_required'
]);
/**
 * resultType values defined by known protocol extensions whose result schema
 * is not vendored here yet; validated against the generic result envelope.
 * - 'task': io.modelcontextprotocol/tasks CreateTaskResult (SEP-2663).
 * - 'upload_required': io.modelcontextprotocol/files UploadRequiredResult.
 */
const EXTENSION_RESULT_TYPES: ReadonlySet<string> = new Set([
  'task',
  'upload_required'
]);

interface CompiledSpec {
  defsKey: '$defs' | 'definitions';
  defs: Record<string, Record<string, unknown>>;
  /** JSON-RPC method → canonical request/notification definition name. */
  methodDefs: Map<string, string>;
  /** `error.code` const → typed error-response definition name. */
  errorDefs: Map<number, string>;
  /** JSON-RPC method → typed result definition name. */
  resultDefs: Map<string, string>;
  validatorFor(defName: string): ValidateFunction;
}

let compiled: CompiledSpec | undefined;

function compileSpec(): CompiledSpec {
  if (compiled) return compiled;
  const schema: Record<string, unknown> = schemaDraft;
  const is2020 =
    typeof schema.$schema === 'string' && schema.$schema.includes('2020-12');
  // The spec schemas are not authored for ajv strict mode; validate them
  // as-is rather than editing vendored files.
  const options = { strict: false, allErrors: true } as const;
  const ajv = is2020 ? new Ajv2020(options) : new Ajv(options);
  addFormats(ajv);
  // "byte" (base64) is an OpenAPI format ajv-formats doesn't ship; the spec
  // uses it on blob contents. Accept any string rather than reimplementing it.
  ajv.addFormat('byte', true);

  const schemaId = 'mcp://draft/schema.json';
  ajv.addSchema({ ...schema, $id: schemaId });

  const defsKey: '$defs' | 'definitions' =
    '$defs' in schema ? '$defs' : 'definitions';
  const defs = schema[defsKey] as Record<string, Record<string, unknown>>;

  const methodDefs = new Map<string, string>();
  const errorDefs = new Map<number, string>();
  const resultDefs = new Map<string, string>();
  for (const [name, def] of Object.entries(defs)) {
    if (NON_CANONICAL_DEFS.has(name)) continue;
    const props = (def.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const method = props.method?.const;
    if (typeof method === 'string') {
      methodDefs.set(method, name);
      if (name.endsWith('Request')) {
        const resultName = `${name.slice(0, -'Request'.length)}Result`;
        if (resultName in defs) resultDefs.set(method, resultName);
      }
    }
    const errorProp = props.error as
      | { allOf?: { properties?: { code?: { const?: unknown } } }[] }
      | undefined;
    for (const part of errorProp?.allOf ?? []) {
      const code = part.properties?.code?.const;
      if (typeof code === 'number') errorDefs.set(code, name);
    }
  }

  const validators = new Map<string, ValidateFunction>();
  compiled = {
    defsKey,
    defs,
    methodDefs,
    errorDefs,
    resultDefs,
    validatorFor(defName: string): ValidateFunction {
      let v = validators.get(defName);
      if (!v) {
        v = ajv.compile({ $ref: `${schemaId}#/${defsKey}/${defName}` });
        validators.set(defName, v);
      }
      return v;
    }
  };
  return compiled;
}

function formatErrors(
  defName: string,
  errors: ErrorObject[] | null | undefined,
  redactPayload: boolean
): string[] {
  const MAX = 6;
  const formatted = (errors ?? []).map(
    (e) =>
      `${defName}${redactPayload ? ' ' + e.schemaPath : e.instancePath}: ${e.message ?? 'invalid'}` +
      (e.keyword === 'const' || e.keyword === 'enum'
        ? ` (${JSON.stringify(e.params)})`
        : '')
  );
  if (formatted.length > MAX) {
    return [
      ...formatted.slice(0, MAX),
      `... ${formatted.length - MAX} more error(s)`
    ];
  }
  return formatted.length > 0 ? formatted : [`${defName}: invalid`];
}

export function hasConflictingJsonRpcMembers(message: object): boolean {
  const hasResult = 'result' in message;
  const hasError = 'error' in message;
  return (
    (hasResult && hasError) || ('method' in message && (hasResult || hasError))
  );
}

/** Validate a single JSON-RPC message against the given spec version's schema.
 * Returns `[]` when the message is valid. Pure — does not touch the recorder. */
export function wireSchemaErrors(
  specVersion: SpecVersion,
  message: unknown,
  requestMethod?: string,
  options: Pick<WireMessageInfo, 'request' | 'redactPayload'> = {}
): string[] {
  const { request, redactPayload = false } = options;
  if (specVersion !== DRAFT_PROTOCOL_VERSION) {
    const result = object(object(message)?.result);
    return result?.resultType === 'upload_required'
      ? [
          'UploadRequiredResult: upload_required requires tools/call on MCP 2026-07-28 or later'
        ]
      : ['This File Uploads suite validates MCP 2026-07-28.'];
  }
  const spec = compileSpec();
  const validateAgainst = (defName: string, value: unknown): string[] => {
    const validate = spec.validatorFor(defName);
    return validate(value)
      ? []
      : formatErrors(defName, validate.errors, redactPayload);
  };
  const firstDef = (...names: string[]): string =>
    names.find((n) => n in spec.defs) ?? names[names.length - 1];

  if (Array.isArray(message)) {
    return ['JSONRPCMessage: batch arrays are not valid in this spec version'];
  }

  const msg = (
    typeof message === 'object' && message !== null ? message : {}
  ) as Record<string, unknown>;

  if (
    hasConflictingJsonRpcMembers(msg) ||
    (requestMethod !== undefined && 'method' in msg)
  ) {
    return ['JSONRPCMessage: invalid JSON-RPC response envelope'];
  }

  // Classify the message and validate against the most specific definition
  // the schema has for it. The typed definitions include the envelope
  // requirements (jsonrpc, id, method, ...), so they subsume the union check.
  if (typeof msg.method === 'string') {
    const defName =
      spec.methodDefs.get(msg.method) ??
      ('id' in msg ? 'JSONRPCRequest' : 'JSONRPCNotification');
    return validateAgainst(defName, message);
  }

  if (msg.error !== undefined && msg.error !== null) {
    const code = (msg.error as Record<string, unknown>).code;
    const defName =
      (typeof code === 'number' ? spec.errorDefs.get(code) : undefined) ??
      firstDef('JSONRPCErrorResponse', 'JSONRPCError');
    return validateAgainst(defName, message);
  }

  if (msg.result !== undefined) {
    // SEP-2322 (MRTR): any request may be answered with an InputRequiredResult
    // instead of its method's result type; discriminate on resultType. Results
    // introduced by a known extension (e.g. the tasks extension's
    // CreateTaskResult, resultType "task") use the same open discriminator and
    // are checked against the generic result envelope until their schema is
    // vendored here. Any other resultType is validated as the method's own
    // result (the discriminator is open, so it may be a private extension),
    // and a failure names the unrecognised value so the cause is obvious.
    const resultType = (msg.result as Record<string, unknown> | null)
      ?.resultType;
    if (resultType === 'upload_required') {
      if (requestMethod !== 'tools/call') {
        return [
          'UploadRequiredResult: upload_required requires tools/call on MCP 2026-07-28 or later'
        ];
      }
      const settings = object(fileDeclaration(object(request)?.params));
      if (request !== undefined && !object(settings?.upload)) {
        return [
          'UploadRequiredResult: the tools/call request must declare upload support'
        ];
      }
    }
    const inputRequired =
      resultType === 'input_required' && 'InputRequiredResult' in spec.defs;
    const extensionResult =
      typeof resultType === 'string' && EXTENSION_RESULT_TYPES.has(resultType);
    const unrecognisedResultType =
      typeof resultType === 'string' &&
      !CORE_RESULT_TYPES.has(resultType) &&
      !extensionResult
        ? resultType
        : undefined;
    let resultDefName: string | undefined;
    if (inputRequired) {
      resultDefName = 'InputRequiredResult';
    } else if (!extensionResult && requestMethod !== undefined) {
      resultDefName = spec.resultDefs.get(requestMethod);
    }
    if (resultDefName) {
      const hint =
        unrecognisedResultType && !redactPayload
          ? `; resultType '${unrecognisedResultType}' is not a core value or a known extension result (${[...EXTENSION_RESULT_TYPES].map((t) => `'${t}'`).join(', ')}), so it was validated as ${resultDefName}`
          : '';
      const typed = validateAgainst(resultDefName, msg.result).map((e) =>
        redactPayload ? e : `${e} (result of '${requestMethod}')${hint}`
      );
      if (typed.length > 0) return typed;
    }
    return validateAgainst(
      firstDef('JSONRPCResultResponse', 'JSONRPCResponse'),
      message
    );
  }

  return [
    'JSONRPCMessage: not a valid JSON-RPC request, notification, or response'
  ];
}

// Recorder: choke points record every message; runners (and the vitest hook)
// drain the accumulated violations per scenario / test. Suite runs execute
// scenarios concurrently, so each scenario gets its own recorder via
// AsyncLocalStorage; code outside any scope falls back to the global recorder.

interface RecorderState {
  violations: WireSchemaViolation[];
  observed: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function containsFileInput(value: unknown): boolean {
  const pending = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (!next || typeof next !== 'object' || visited.has(next)) continue;
    visited.add(next);
    if ('id' in next && 'mimeType' in next && 'size' in next) return true;
    for (const child of Object.values(next)) pending.push(child);
  }
  return false;
}

function fileDeclaration(params: unknown): unknown {
  const meta = object(object(params)?._meta);
  const capabilities = object(
    meta?.['io.modelcontextprotocol/clientCapabilities']
  );
  return object(capabilities?.extensions)?.[FILES_EXTENSION_ID];
}

function isFileUploadsMessage(message: unknown): boolean {
  if (Array.isArray(message)) return message.some(isFileUploadsMessage);
  const body = object(message);
  const result = object(body?.result);
  const params = object(body?.params);
  return (
    result?.resultType === 'upload_required' ||
    (result !== undefined && 'uploads' in result) ||
    object(result?._meta)?.[FILES_EXTENSION_ID] !== undefined ||
    fileDeclaration(params) !== undefined ||
    (body?.method === 'tools/call' && containsFileInput(params?.arguments))
  );
}

const recorderStorage = new AsyncLocalStorage<RecorderState>();
const globalRecorder: RecorderState = { violations: [], observed: 0 };

function recorder(): RecorderState {
  return recorderStorage.getStore() ?? globalRecorder;
}

/** Run `fn` with its own isolated wire recorder. Async work started inside
 * `fn` (mock servers, transport hooks) records into that recorder, so
 * concurrent scenarios in a suite run cannot steal or wipe each other's
 * violations. */
export function withWireRecorder<T>(fn: () => Promise<T>): Promise<T> {
  return recorderStorage.run({ violations: [], observed: 0 }, fn);
}

/** Validate a wire message and record any violation. Called by choke points. */
export function validateWireMessage(
  specVersion: SpecVersion,
  message: unknown,
  info: WireMessageInfo
): void {
  const state = recorder();
  state.observed++;
  const redactPayload =
    info.redactPayload ||
    isFileUploadsMessage(info.request) ||
    isFileUploadsMessage(message);
  const errors = wireSchemaErrors(specVersion, message, info.requestMethod, {
    request: info.request,
    redactPayload
  });
  if (errors.length > 0) {
    state.violations.push({
      origin: info.origin,
      specVersion,
      context: redactPayload ? 'File Uploads wire message' : info.context,
      errors,
      // Malformed peers can echo transfer secrets in text or error data.
      // Store the schema diagnostics without retaining the File Uploads payload.
      message: redactPayload ? '[File Uploads payload redacted]' : message
    });
  }
}

export function resetWireValidation(): void {
  const state = recorder();
  state.violations = [];
  state.observed = 0;
}

/** Return everything recorded since the last reset, and reset. */
export function takeWireViolations(): {
  violations: WireSchemaViolation[];
  observed: number;
} {
  const state = recorder();
  const result = { violations: state.violations, observed: state.observed };
  resetWireValidation();
  return result;
}

function violationDetails(v: WireSchemaViolation): Record<string, unknown> {
  return {
    origin: v.origin,
    specVersion: v.specVersion,
    context: v.context,
    errors: v.errors,
    message: v.message
  };
}

export function formatWireViolation(v: WireSchemaViolation): string {
  return (
    `[${v.origin}] ${v.context} (spec ${v.specVersion}): ` +
    `${v.errors.join('; ')} — message: ${JSON.stringify(v.message)}`
  );
}

/** Drain the recorder and synthesize the per-scenario conformance checks. Returns `[]`
 * when no wire traffic was observed (e.g. a scenario asserting only on raw HTTP). */
export function wireSchemaChecks(specVersion: SpecVersion): ConformanceCheck[] {
  const { violations: all, observed: count } = takeWireViolations();
  if (count === 0 && all.length === 0) return [];

  const timestamp = new Date().toISOString();
  const specReferences = [
    {
      id: 'MCP-Schema',
      url: `https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/draft/schema.json`
    }
  ];
  const checks: ConformanceCheck[] = [];

  const implViolations = all.filter((v) => v.origin === 'implementation');
  checks.push({
    id: 'wire-schema-valid',
    name: 'WireSchemaValid',
    description:
      'Every JSON-RPC message the implementation sent is valid per the spec JSON schema for the negotiated spec version',
    status: implViolations.length === 0 ? 'SUCCESS' : 'FAILURE',
    timestamp,
    specReferences,
    details: {
      messagesValidated: count,
      violations: implViolations.map(violationDetails)
    },
    errorMessage:
      implViolations.length > 0
        ? implViolations.map(formatWireViolation).join('\n')
        : undefined
  });

  const harnessViolations = all.filter((v) => v.origin === 'harness');
  if (harnessViolations.length > 0) {
    checks.push({
      id: 'wire-schema-harness-error',
      name: 'WireSchemaHarnessError',
      description:
        'HARNESS ERROR: the conformance harness itself sent a JSON-RPC message the spec JSON schema forbids. This is a bug in the harness or a scenario fixture, not in the implementation under test.',
      status: 'FAILURE',
      timestamp,
      specReferences,
      details: { violations: harnessViolations.map(violationDetails) },
      errorMessage:
        'HARNESS ERROR: ' +
        harnessViolations.map(formatWireViolation).join('\n')
    });
  }

  return checks;
}

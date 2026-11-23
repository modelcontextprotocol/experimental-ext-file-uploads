import type { RunContext } from './connection';
import type { ScenarioContext } from './mock-server';

export const DRAFT_PROTOCOL_VERSION = '2026-07-28';
export const FILES_EXTENSION_ID = 'io.modelcontextprotocol/files';
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
export const DEFAULT_TIMEOUT_MS = 30000;
export type SpecVersion = typeof DRAFT_PROTOCOL_VERSION | '2025-11-25';

export interface SpecReference {
  id: string;
  url?: string;
}

export interface ConformanceCheck {
  id: string;
  name: string;
  description: string;
  status: 'SUCCESS' | 'FAILURE' | 'WARNING' | 'SKIPPED';
  timestamp: string;
  specReferences?: SpecReference[];
  details?: Record<string, unknown>;
  errorMessage?: string;
}

export interface ScenarioUrls {
  serverUrl: string;
  context?: Record<string, unknown>;
}

export interface Scenario {
  name: string;
  description: string;
  start(ctx: ScenarioContext): Promise<ScenarioUrls>;
  stop(): Promise<void>;
  getChecks(): ConformanceCheck[];
}

/** A scenario that acts as the client and tests an MCP server. */
export interface ClientScenario {
  name: string;
  description: string;
  run(ctx: RunContext): Promise<ConformanceCheck[]>;
}

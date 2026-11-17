import { createHash, randomBytes } from "node:crypto";
import { canonicalize } from "./types.js";

export interface RequestStateFileBinding {
  fileId: string;
  stagingId: string;
  declaredSize: number;
  mimeType: string;
  name?: string;
}

export interface RequestStateRecord {
  token: string;
  toolName: string;
  argsHash: string;
  principal: string | null;
  files: RequestStateFileBinding[];
  issuedAt: number;
  expiresAt: number;
  consumed: boolean;
}

export type VerifyResult =
  | { ok: true; record: RequestStateRecord }
  | { ok: false; reason: "absent" | "expired" | "consumed" | "binding" };

/**
 * Opaque requestState issue/verify/consume, per the draft's Uploads and
 * Repeated Retries sections. The token is opaque to the client; the server
 * keeps the record until it expires.
 */
export class RequestStateManager {
  private readonly records = new Map<string, RequestStateRecord>();

  constructor(private readonly ttlMs: number = 60_000) {}

  issue(input: {
    toolName: string;
    args: unknown;
    principal?: string | null;
    files: RequestStateFileBinding[];
  }): RequestStateRecord {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const record: RequestStateRecord = {
      token,
      toolName: input.toolName,
      argsHash: hashArgs(input.args),
      principal: input.principal ?? null,
      files: input.files,
      issuedAt: now,
      expiresAt: now + this.ttlMs,
      consumed: false,
    };
    this.records.set(token, record);
    return record;
  }

  verify(
    token: unknown,
    call: { toolName: string; args: unknown; principal?: string | null }
  ): VerifyResult {
    if (typeof token !== "string" || token.length === 0) {
      return { ok: false, reason: "absent" };
    }
    const record = this.records.get(token);
    if (!record) return { ok: false, reason: "absent" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "expired" };
    if (record.consumed) return { ok: false, reason: "consumed" };

    // Step 2: check tool name, arguments (JSON Schema instance equality),
    // and principal against the values bound in requestState.
    if (record.toolName !== call.toolName) return { ok: false, reason: "binding" };
    if (record.argsHash !== hashArgs(call.args)) return { ok: false, reason: "binding" };
    if ((record.principal ?? null) !== (call.principal ?? null)) {
      return { ok: false, reason: "binding" };
    }
    return { ok: true, record };
  }

  /** Atomic consume for tools unsafe to run twice (step 4). */
  consume(token: string): boolean {
    const record = this.records.get(token);
    if (!record || record.consumed || Date.now() > record.expiresAt) return false;
    record.consumed = true;
    return true;
  }

  /** Drop expired records (targets must not outlive their requestState). */
  sweep(now: number = Date.now()): void {
    for (const [token, record] of this.records) {
      if (now > record.expiresAt) this.records.delete(token);
    }
  }

  /** Test helper. */
  get(token: string): RequestStateRecord | undefined {
    return this.records.get(token);
  }
}

export function hashArgs(args: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(args ?? null)))
    .digest("base64url");
}

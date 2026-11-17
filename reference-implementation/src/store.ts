import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface StagingRecord {
  stagingId: string;
  fileId: string;
  declaredSize: number;
  mimeType: string;
  written: boolean;
  actualSize?: number;
  digestValue?: string;
  createdAt: number;
}

export interface ConfirmResult {
  ok: boolean;
  reason?: string;
  size?: number;
  digest?: { algorithm: "sha-256"; value: string };
}

export interface StoreOptions {
  /**
   * When false, the write path does not enforce the declared size, so the
   * server's confirm step (retry step 3) is the only size check. Models a
   * backend that cannot reject an over/under-sized write.
   */
  enforceSizeOnWrite?: boolean;
}

/**
 * Local object store with a staging area, per the draft's Staging section.
 * - Targets write to staging, one write per staging entry.
 * - Bytes are finalized (copied to final/) only on the retry.
 * - Staged bytes are kept until the bound requestState expires.
 */
export class LocalObjectStore {
  private readonly stagingDir: string;
  private readonly finalDir: string;
  private readonly staging = new Map<string, StagingRecord>();
  private readonly enforceSizeOnWrite: boolean;

  constructor(
    root: string,
    private readonly options: StoreOptions = {}
  ) {
    this.stagingDir = join(root, "staging");
    this.finalDir = join(root, "final");
    mkdirSync(this.stagingDir, { recursive: true });
    mkdirSync(this.finalDir, { recursive: true });
    this.enforceSizeOnWrite = options.enforceSizeOnWrite !== false;
  }

  createStaging(input: {
    fileId: string;
    declaredSize: number;
    mimeType: string;
  }): StagingRecord {
    const stagingId = randomBytes(16).toString("hex");
    const record: StagingRecord = {
      stagingId,
      fileId: input.fileId,
      declaredSize: input.declaredSize,
      mimeType: input.mimeType,
      written: false,
      createdAt: Date.now(),
    };
    this.staging.set(stagingId, record);
    return record;
  }

  getStaging(stagingId: string): StagingRecord | undefined {
    return this.staging.get(stagingId);
  }

  /** One write per staging entry. Returns an HTTP-ish status. */
  write(stagingId: string, bytes: Uint8Array): { status: number; error?: string } {
    const record = this.staging.get(stagingId);
    if (!record) return { status: 404, error: "unknown staging id" };
    if (record.written) return { status: 409, error: "already written" };

    if (this.enforceSizeOnWrite && bytes.byteLength !== record.declaredSize) {
      return {
        status: 400,
        error:
          "size mismatch: wrote " +
          bytes.byteLength +
          ", declared " +
          record.declaredSize,
      };
    }

    const path = join(this.stagingDir, stagingId + ".bin");
    writeFileSync(path, bytes);
    record.written = true;
    record.actualSize = bytes.byteLength;
    record.digestValue = createHash("sha256").update(bytes).digest("base64url");
    return { status: 204 };
  }

  /**
   * Retry step 3: confirm with the storage that the bytes arrived.
   * Re-checks size, and digest when the tool requires it.
   */
  confirm(
    stagingId: string,
    expect: { declaredSize: number; digestRequired: boolean; expectedDigest?: string }
  ): ConfirmResult {
    const record = this.staging.get(stagingId);
    if (!record || !record.written) {
      return { ok: false, reason: "bytes have not arrived" };
    }
    const path = join(this.stagingDir, stagingId + ".bin");
    if (!existsSync(path)) {
      return { ok: false, reason: "bytes have not arrived" };
    }
    const bytes = readFileSync(path);
    if (bytes.byteLength !== expect.declaredSize) {
      return {
        ok: false,
        reason:
          "size mismatch: have " + bytes.byteLength + ", declared " + expect.declaredSize,
      };
    }
    const digest = createHash("sha256").update(bytes).digest("base64url");
    if (expect.digestRequired) {
      if (!expect.expectedDigest || expect.expectedDigest !== digest) {
        return { ok: false, reason: "digest mismatch" };
      }
    }
    return {
      ok: true,
      size: bytes.byteLength,
      digest: { algorithm: "sha-256", value: digest },
    };
  }

  /**
   * Retry step 5: finalize a copy of the confirmed bytes into final/.
   * Returns the final relative path, or null when the tool-level check
   * (conflict) rejected it before finalize.
   */
  finalize(stagingId: string, folderId: string, name: string): string | null {
    const record = this.staging.get(stagingId);
    if (!record || !record.written) return null;
    const safeFolder = folderId.replace(/[^A-Za-z0-9._-]/g, "_");
    const safeName = (name || "file").replace(/[\/\\]/g, "_");
    const destDir = join(this.finalDir, safeFolder);
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, safeName);
    if (existsSync(dest)) {
      // The tool decides whether an existing file is a conflict.
      return null;
    }
    const bytes = readFileSync(join(this.stagingDir, stagingId + ".bin"));
    writeFileSync(dest, bytes);
    return join("final", safeFolder, safeName);
  }

  /** Whether finalize would conflict (used by the tool before running). */
  exists(folderId: string, name: string): boolean {
    const safeFolder = folderId.replace(/[^A-Za-z0-9._-]/g, "_");
    const safeName = (name || "file").replace(/[\/\\]/g, "_");
    return existsSync(join(this.finalDir, safeFolder, safeName));
  }

  readFinal(relativePath: string): Uint8Array | undefined {
    const p = join(this.finalDir, relativePath.replace(/^final[\/\\]/, ""));
    if (!existsSync(p)) return undefined;
    return new Uint8Array(readFileSync(p));
  }

  /** Save bytes directly to final/ (used by download exports). */
  putFinal(relativePath: string, bytes: Uint8Array): void {
    const p = join(this.finalDir, relativePath.replace(/^final[\/\\]/, ""));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, bytes);
  }

  /** SHOULD delete bytes no retry finalized after the latest requestState expires. */
  deleteStaging(stagingId: string): void {
    const path = join(this.stagingDir, stagingId + ".bin");
    if (existsSync(path)) rmSync(path);
    this.staging.delete(stagingId);
  }

  /** Test helper: count staged entries with bytes written. */
  stagedWrittenCount(): number {
    let n = 0;
    for (const r of this.staging.values()) if (r.written) n++;
    return n;
  }
}

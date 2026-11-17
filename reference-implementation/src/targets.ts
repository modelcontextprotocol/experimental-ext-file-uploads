import { CallFailedError, DownloadTarget, UploadTarget } from "./types.js";

const FORBIDDEN_REQUEST_HEADERS = new Set(
  [
    "accept-charset","accept-encoding","access-control-request-headers",
    "access-control-request-method","connection","content-length","cookie",
    "cookie2","date","dnt","expect","host","keep-alive","origin","referer",
    "set-cookie","te","trailer","transfer-encoding","upgrade","via",
    "proxy-authenticate","proxy-authorization","proxy-connection",
    "sec-ch-ua","sec-ch-ua-mobile","sec-ch-ua-platform","sec-fetch-dest",
    "sec-fetch-mode","sec-fetch-site","sec-fetch-user",
  ].map((h) => h.toLowerCase())
);

const HOP_BY_HOP_OR_REWRITE_HEADERS = new Set(
  [
    "forwarded","x-original-url","x-rewrite-url","x-http-method-override",
    "x-http-method","x-method-override",
  ].map((h) => h.toLowerCase())
);

const BODY_STRUCTURE_HEADERS = new Set(
  ["content-type","content-encoding","content-range","content-digest","repr-digest"].map((h) => h.toLowerCase())
);

const UPLOAD_KEYS = new Set([
  "fileId","url","path","method","form","headers","credentials","expiresAt","_meta",
]);

const DOWNLOAD_KEYS = new Set([
  "name","mimeType","size","digest","url","path","headers","credentials","expiresAt","_meta",
]);

const FORM_KEYS = new Set(["fields","fileField"]);
const FIELD_KEYS = new Set(["name","value"]);
const DIGEST_KEYS = new Set(["algorithm","value"]);

export interface TargetCheckContext {
  kind: "upload" | "download";
  mcpAddress: string;
  allowLoopbackHttp?: boolean;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function isRfc9110Token(str: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(str);
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function isHeaderValueValid(value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x09) continue;
    if (c < 0x20 || c === 0x7f) return false;
    if (c > 0x7f) return false;
  }
  return true;
}

function isMediaType(value: string): boolean {
  return /^[!#$%&'*+\-.^_`0-9A-Za-z]+\/[!#$%&'*+\-.^_`0-9A-Za-z]+$/.test(value);
}

export function resolvePathTarget(mcpAddress: string, path: string): URL {
  const base = new URL(mcpAddress);
  let basePath = base.pathname;
  if (basePath.endsWith("/")) basePath = basePath.slice(0, -1);
  const resolved = new URL(base.origin + basePath + path);
  resolved.search = base.search;
  return resolved;
}

function checkUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
  errors: string[]
): void {
  for (const key of Object.keys(obj)) {
    if (key === "_meta") continue;
    if (!allowed.has(key)) errors.push(label + ': unknown member "' + key + '"');
  }
}

function validateHeadersCommon(headers: Record<string, string>, errors: string[]): void {
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (name === "authorization" || name === "cookie") {
      errors.push('headers: forbidden header "' + rawName + '"');
      continue;
    }
    if (FORBIDDEN_REQUEST_HEADERS.has(name)) {
      errors.push('headers: forbidden request header "' + rawName + '"');
      continue;
    }
    if (!isRfc9110Token(rawName)) {
      errors.push('headers: invalid header name "' + rawName + '"');
      continue;
    }
    if (typeof rawValue !== "string" || !isHeaderValueValid(rawValue)) {
      errors.push('headers: invalid header value for "' + rawName + '"');
    }
  }
}

function validateForm(
  form: unknown,
  headers: Record<string, string> | undefined,
  errors: string[]
): void {
  if (typeof form !== "object" || form === null || Array.isArray(form)) {
    errors.push("form: must be an object");
    return;
  }
  const f = form as Record<string, unknown>;
  checkUnknownKeys(f, FORM_KEYS, "form", errors);

  const fields = f.fields;
  const fileField = f.fileField;
  if (
    typeof fileField !== "string" ||
    fileField.length === 0 ||
    /["\\]/.test(fileField) ||
    hasControlChars(fileField)
  ) {
    errors.push("form.fileField: empty or contains a control character, quote, or backslash");
  }
  if (!Array.isArray(fields)) {
    errors.push("form.fields: must be an array");
    return;
  }
  for (const field of fields) {
    if (typeof field !== "object" || field === null) {
      errors.push("form.fields: each entry must be an object");
      continue;
    }
    const fe = field as Record<string, unknown>;
    checkUnknownKeys(fe, FIELD_KEYS, "form.fields[]", errors);
    const name = fe.name;
    const value = fe.value;
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      /["\\]/.test(name) ||
      hasControlChars(name)
    ) {
      errors.push("form.fields[].name: empty or contains a control character, quote, or backslash");
      continue;
    }
    if (typeof value !== "string" || /[\r\n]/.test(value) || hasControlChars(value)) {
      errors.push('form.fields[].value for "' + name + '": contains CR, LF, or NUL');
      continue;
    }
    if (name === fileField) {
      errors.push("form.fields[].name: must not equal fileField");
    }
  }

  if (headers) {
    for (const rawName of Object.keys(headers)) {
      if (BODY_STRUCTURE_HEADERS.has(rawName.toLowerCase())) {
        errors.push('form target headers: must not include "' + rawName + '"');
      }
    }
  }
}

export function validateTarget(
  target: UploadTarget | DownloadTarget,
  ctx: TargetCheckContext
): void {
  const errors: string[] = [];
  const kind = ctx.kind;
  const allowedKeys = kind === "upload" ? UPLOAD_KEYS : DOWNLOAD_KEYS;

  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    throw new CallFailedError("target: must be an object");
  }

  const rec = target as unknown as Record<string, unknown>;
  const present = (key: string): boolean => rec[key] !== undefined && rec[key] !== null;

  checkUnknownKeys(rec, allowedKeys, kind, errors);

  const hasUrl = present("url");
  const hasPath = present("path");
  if (hasUrl === hasPath) {
    errors.push("target: exactly one of url and path is required");
  }

  if (kind === "upload") {
    const ut = target as UploadTarget;
    if (typeof ut.fileId !== "string" || ut.fileId.length === 0) {
      errors.push("upload target: fileId must be a non-empty string");
    }
    if (ut.credentials !== "omit" && ut.credentials !== "include") {
      errors.push('upload target: credentials must be "omit" or "include"');
    }
    if (present("method") && ut.method !== "PUT" && ut.method !== "POST") {
      errors.push('upload target: method must be "PUT" or "POST"');
    }
    if (present("expiresAt") && typeof ut.expiresAt !== "string") {
      errors.push("upload target: expiresAt must be a string");
    }
  } else {
    const dt = target as DownloadTarget;
    if (typeof dt.mimeType !== "string") {
      errors.push("download target: mimeType must be a string");
    }
    if (typeof dt.size !== "number" || !Number.isInteger(dt.size) || dt.size < 0) {
      errors.push("download target: size must be a non-negative integer");
    }
    if (dt.credentials !== "omit" && dt.credentials !== "include") {
      errors.push('download target: credentials must be "omit" or "include"');
    }
  }

  let headers: Record<string, string> | undefined;
  if (present("headers")) {
    const h = rec.headers;
    if (typeof h !== "object" || h === null || Array.isArray(h)) {
      errors.push("target: headers must be an object");
    } else {
      headers = h as Record<string, string>;
    }
  }

  if (hasUrl) {
    const urlStr = rec.url as string;
    let url: URL | undefined;
    try {
      url = new URL(urlStr);
    } catch {
      errors.push('url: "' + urlStr + '" is not an absolute URL');
    }
    if (url) {
      if (url.username || url.password) {
        errors.push("url: must not contain userinfo");
      }
      if (url.protocol === "https:") {
        // allowed
      } else if (url.protocol === "http:" && isLoopbackHost(url.hostname) && ctx.allowLoopbackHttp) {
        // operator allowlist permits http on loopback only
      } else {
        errors.push('url: must be an absolute https URL (got "' + url.protocol + '")');
      }
    }
  }

  if (hasPath) {
    const p = rec.path as string;
    if (typeof p !== "string" || !/^\/([A-Za-z0-9\-_~.]+)(\/[A-Za-z0-9\-_~.]+)*$/.test(p)) {
      errors.push('path: "' + String(p) + '" does not match 1*( "/" segment )');
    } else {
      for (const seg of p.split("/").slice(1)) {
        if (seg === "." || seg === "..") {
          errors.push("path: segments must not be . or ..");
        }
      }
    }
  }

  if (headers) validateHeadersCommon(headers, errors);

  const restricted = hasPath || (rec.credentials as string | undefined) === "include";
  if (restricted && headers) {
    for (const rawName of Object.keys(headers)) {
      const lower = rawName.toLowerCase();
      if (HOP_BY_HOP_OR_REWRITE_HEADERS.has(lower) || lower.startsWith("x-forwarded-")) {
        errors.push('headers: "' + rawName + '" not allowed on this target');
      }
    }
  }

  if (present("form")) {
    if (kind !== "upload") {
      errors.push("download target: must not have form");
    } else {
      const ut = target as UploadTarget;
      if (ut.method !== "POST") {
        errors.push('form target: method must be "POST"');
      }
      validateForm(ut.form, headers, errors);
    }
  }

  if (errors.length > 0) {
    throw new CallFailedError("invalid " + kind + " target: " + errors.join("; "));
  }
}

export function validateDigestShape(digest: unknown, errors: string[]): void {
  if (typeof digest !== "object" || digest === null) {
    errors.push("digest: must be an object");
    return;
  }
  const d = digest as Record<string, unknown>;
  checkUnknownKeys(d, DIGEST_KEYS, "digest", errors);
  if (d.algorithm !== "sha-256") errors.push('digest.algorithm must be "sha-256"');
  if (typeof d.value !== "string") errors.push("digest.value must be a string");
}

export { isMediaType };


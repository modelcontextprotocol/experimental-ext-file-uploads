import { randomBytes } from "node:crypto";

/**
 * multipart/form-data encoding per the draft's Transfer section:
 * - boundary with at least 128 bits of randomness
 * - each form field as one part, in array order, file last
 * - part names quoted; filename in UTF-8 with ", CR, LF written as
 *   %22, %0D, %0A (WHATWG multipart/form-data encoding algorithm)
 * - no filename*
 */

export interface FormFilePart {
  fileField: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface MultipartBody {
  body: Uint8Array;
  contentType: string;
}

function quoteName(name: string): string {
  return '"' + name.replace(/\\/g, "%5C").replace(/"/g, "%22") + '"';
}

/** WHATWG filename encoding for the filename parameter value. */
function encodeFilename(name: string): string {
  let out = "";
  for (const ch of name) {
    if (ch === '"') out += "%22";
    else if (ch === "\r") out += "%0D";
    else if (ch === "\n") out += "%0A";
    else out += ch;
  }
  return out;
}

/** Base name after both / and \; fallback "file". */
export function baseName(name?: string): string {
  if (!name) return "file";
  const afterSlash = name.split(/[\/\\]/).pop() ?? "";
  if (!afterSlash || afterSlash === "." || afterSlash === "..") return "file";
  return afterSlash;
}

const MEDIA_TYPE_RE = /^[!#$%&'*+\-.^_`0-9A-Za-z]+\/[!#$%&'*+\-.^_`0-9A-Za-z]+$/;

export function buildMultipart(input: {
  fields: { name: string; value: string }[];
  file: FormFilePart;
}): MultipartBody {
  const boundary = randomBytes(16).toString("hex");
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();

  for (const field of input.fields) {
    chunks.push(
      enc.encode(
        "--" + boundary + "\r\nContent-Disposition: form-data; name=" +
        quoteName(field.name) + "\r\n\r\n" + field.value + "\r\n"
      )
    );
  }

  const { fileField, fileName, mimeType, bytes } = input.file;
  const safeMime = MEDIA_TYPE_RE.test(mimeType) ? mimeType : "application/octet-stream";
  const encodedName = encodeFilename(baseName(fileName));
  chunks.push(
    enc.encode(
      "--" + boundary + "\r\nContent-Disposition: form-data; name=" +
      quoteName(fileField) + '; filename="' + encodedName + '"\r\nContent-Type: ' +
      safeMime + "\r\n\r\n"
    )
  );
  chunks.push(bytes);
  chunks.push(enc.encode("\r\n"));
  chunks.push(enc.encode("--" + boundary + "--\r\n"));

  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return { body, contentType: "multipart/form-data; boundary=" + boundary };
}

/**
 * Minimal multipart parser for the reference server's form endpoint.
 * Works on raw bytes so the file part is extracted exactly.
 */
export function parseMultipart(
  body: Uint8Array,
  contentType: string
): { fields: Record<string, string>; file?: { name: string; bytes: Uint8Array } } {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (m && (m[1] || m[2]) || "").trim();
  if (!boundary) throw new Error("missing boundary");

  const delimiter = Buffer.from("--" + boundary, "latin1");
  const fields: Record<string, string> = {};
  let file: { name: string; bytes: Uint8Array } | undefined;

  // Split body on delimiter.
  let parts: Buffer[] = [];
  {
    let start = 0;
    while (true) {
      const idx = Buffer.from(body).indexOf(delimiter, start);
      if (idx < 0) {
        parts.push(Buffer.from(body.subarray(start)));
        break;
      }
      if (idx > start) parts.push(Buffer.from(body.subarray(start, idx)));
      start = idx + delimiter.byteLength;
      // Skip trailing CRLF or "--" after delimiter.
      if (start + 1 < body.byteLength && body[start] === 0x2d && body[start + 1] === 0x2d) {
        break; // closing delimiter
      }
      if (start + 1 < body.byteLength && body[start] === 0x0d && body[start + 1] === 0x0a) {
        start += 2;
      }
    }
  }

  for (const part of parts) {
    if (part.byteLength === 0) continue;
    // Each part: headers \r\n\r\n content \r\n
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const rawHeaders = part.subarray(0, headerEnd).toString("latin1");
    let contentBuf = part.subarray(headerEnd + 4);
    // Strip trailing CRLF before next delimiter.
    if (contentBuf.byteLength >= 2 &&
        contentBuf[contentBuf.byteLength - 2] === 0x0d &&
        contentBuf[contentBuf.byteLength - 1] === 0x0a) {
      contentBuf = contentBuf.subarray(0, contentBuf.byteLength - 2);
    }

    const nameMatch = /name="([^"]*)"/i.exec(rawHeaders);
    const filenameMatch = /filename="([^"]*)"/i.exec(rawHeaders);
    const name: string = nameMatch ? (nameMatch[1] ?? "") : "";

    if (filenameMatch !== null) {
      file = { name, bytes: new Uint8Array(contentBuf) };
    } else if (name) {
      fields[name] = contentBuf.toString("utf8");
    }
  }

  return { fields, file };
}


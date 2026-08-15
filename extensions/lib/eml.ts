/**
 * A small RFC 5322 / MIME parser built on Node built-ins only.
 *
 * Nothing here imports a third-party package. That is deliberate: the workshop
 * runs on Windows, macOS and Linux laptops with only the Node that pi already
 * needs, so every dependency is one more thing to go wrong in the first hour.
 *
 * Node has no email parser in its standard library, but the parts that carry
 * the most signal (headers) are genuinely small to parse by hand.
 */

import { createHash } from "node:crypto";

/** One header, in the order it appeared. Order matters for `Received:`. */
export interface Header {
  /** Lower-cased field name, e.g. "reply-to". */
  name: string;
  /** Unfolded, RFC 2047-decoded field value. */
  value: string;
  /** Unfolded value before encoded-word decoding, for display. */
  raw: string;
}

export interface MailAddress {
  /** Display name, decoded. Empty string when absent. */
  display: string;
  /** The addr-spec, e.g. "no-reply@example.com". Empty when unparseable. */
  address: string;
  /** Lower-cased domain part of `address`. Empty when unparseable. */
  domain: string;
}

export interface Attachment {
  filename: string;
  /** MIME type as declared by the message. */
  declaredType: string;
  bytes: number;
  sha256: string;
  /** First bytes of the decoded content, for magic-byte comparison. */
  magic: Buffer;
}

export interface MimePart {
  contentType: string;
  charset: string;
  /** Content-Disposition value, e.g. "attachment" or "inline". */
  disposition: string;
  filename: string;
  /** Decoded bytes of this part. */
  content: Buffer;
}

export interface ParsedEmail {
  headers: Header[];
  parts: MimePart[];
  /** Concatenated text/plain content. */
  text: string;
  /** Concatenated text/html content. */
  html: string;
  attachments: Attachment[];
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/**
 * Split a raw message into its header block and body.
 *
 * We work in `latin1` throughout, which maps bytes 1:1 to code points. That
 * lets us use ordinary string operations without ever corrupting binary
 * content — `Buffer.from(s, "latin1")` recovers the exact original bytes.
 */
function splitMessage(raw: Buffer): { headerBlock: string; body: Buffer } {
  const s = raw.toString("latin1");
  // RFC 5322 says CRLF, but plenty of real mail (and every file that has been
  // through a Unix tool) uses bare LF. Accept both.
  const crlf = s.indexOf("\r\n\r\n");
  const lf = s.indexOf("\n\n");

  let idx: number;
  let sepLen: number;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    idx = crlf;
    sepLen = 4;
  } else if (lf !== -1) {
    idx = lf;
    sepLen = 2;
  } else {
    // No body at all — headers only.
    return { headerBlock: s, body: Buffer.alloc(0) };
  }

  return {
    headerBlock: s.slice(0, idx),
    body: Buffer.from(s.slice(idx + sepLen), "latin1"),
  };
}

/**
 * Unfold continuation lines and split each header at its first colon.
 *
 * "Folding" is the rule that a long header may be broken across lines as long
 * as each continuation starts with whitespace. Unfolding is just joining those
 * back up — and it is the step people most often skip, which is why long
 * `Received:` and `Authentication-Results:` headers get mis-read.
 */
export function parseHeaders(headerBlock: string): Header[] {
  const lines = headerBlock.split(/\r?\n/);
  const unfolded: string[] = [];

  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += " " + line.trim();
    } else if (line.length > 0) {
      unfolded.push(line);
    }
  }

  const headers: Header[] = [];
  for (const line of unfolded) {
    const colon = line.indexOf(":");
    if (colon === -1) continue; // Not a valid header line; skip it.
    const name = line.slice(0, colon).trim().toLowerCase();
    const raw = line.slice(colon + 1).trim();
    headers.push({ name, raw, value: decodeEncodedWords(raw) });
  }
  return headers;
}

/**
 * Decode RFC 2047 encoded-words, e.g. `=?UTF-8?B?UGF5UGFs?=`.
 *
 * Phishing leans on these heavily: an encoded display name hides a spoofed
 * brand from anything doing a naive string comparison on the raw header.
 */
export function decodeEncodedWords(input: string): string {
  return input.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (match, charset: string, encoding: string, text: string) => {
      try {
        let bytes: Buffer;
        if (encoding.toUpperCase() === "B") {
          bytes = Buffer.from(text, "base64");
        } else {
          // Q-encoding: underscores are spaces, =XX is a hex byte.
          const fixed = text
            .replace(/_/g, " ")
            .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
              String.fromCharCode(parseInt(hex, 16)),
            );
          bytes = Buffer.from(fixed, "latin1");
        }
        return decodeBytes(bytes, charset);
      } catch {
        return match; // Undecodable: leave it visible rather than lose it.
      }
    },
  );
}

/**
 * Decode bytes using a named charset.
 *
 * `TextDecoder` is a Node global and, on a standard full-ICU build, handles the
 * legacy encodings (windows-1252, iso-8859-*, shift_jis...) that show up in
 * real mail. No dependency required.
 */
function decodeBytes(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

// ---------------------------------------------------------------------------
// Structured header accessors
// ---------------------------------------------------------------------------

export function getHeader(
  headers: Header[],
  name: string,
): string | undefined {
  return headers.find((h) => h.name === name.toLowerCase())?.value;
}

export function getAllHeaders(headers: Header[], name: string): string[] {
  return headers
    .filter((h) => h.name === name.toLowerCase())
    .map((h) => h.value);
}

/**
 * Pull the display name and addr-spec out of a From/To/Reply-To style header.
 *
 * Handles `"Display" <a@b>`, `Display <a@b>`, `<a@b>` and bare `a@b`.
 */
export function parseAddress(value: string | undefined): MailAddress {
  const empty: MailAddress = { display: "", address: "", domain: "" };
  if (!value) return empty;

  const trimmed = value.trim();
  const angle = trimmed.match(/^(.*?)<([^>]*)>/s);

  let display = "";
  let address = "";

  if (angle) {
    display = angle[1].trim().replace(/^"(.*)"$/s, "$1").trim();
    address = angle[2].trim();
  } else {
    address = trimmed.replace(/[(].*?[)]/g, "").trim();
  }

  const at = address.lastIndexOf("@");
  const domain = at === -1 ? "" : address.slice(at + 1).toLowerCase().trim();

  return { display, address, domain };
}

export interface AuthResults {
  spf: string;
  dkim: string;
  dmarc: string;
  /** True when the message carried no Authentication-Results header at all. */
  absent: boolean;
}

/**
 * Read the *recorded* SPF/DKIM/DMARC verdicts from `Authentication-Results`.
 *
 * Note carefully: this reads what the receiving mail server concluded. It does
 * not re-verify anything — that would need live DNS, which we deliberately do
 * not do (see README, "What we deliberately do not do").
 */
export function parseAuthResults(headers: Header[]): AuthResults {
  const all = getAllHeaders(headers, "authentication-results").join("; ");
  if (!all) return { spf: "", dkim: "", dmarc: "", absent: true };

  const pick = (key: string): string => {
    const m = all.match(new RegExp(`\\b${key}=([a-z]+)`, "i"));
    return m ? m[1].toLowerCase() : "";
  };

  return {
    spf: pick("spf"),
    dkim: pick("dkim"),
    dmarc: pick("dmarc"),
    absent: false,
  };
}

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

function parseContentType(value: string | undefined): {
  type: string;
  params: Record<string, string>;
} {
  if (!value) return { type: "text/plain", params: {} };

  const segments = splitOnSemicolons(value);
  const type = (segments.shift() ?? "text/plain").trim().toLowerCase();

  const params: Record<string, string> = {};
  for (const seg of segments) {
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    const key = seg.slice(0, eq).trim().toLowerCase();
    const val = seg
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/s, "$1");
    params[key] = val;
  }
  return { type, params };
}

/** Split on semicolons that are not inside a quoted string. */
function splitOnSemicolons(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ";" && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** Decode a part body according to its Content-Transfer-Encoding. */
function decodeTransferEncoding(body: Buffer, cte: string): Buffer {
  const enc = cte.trim().toLowerCase();

  if (enc === "base64") {
    return Buffer.from(body.toString("latin1").replace(/\s+/g, ""), "base64");
  }

  if (enc === "quoted-printable") {
    const decoded = body
      .toString("latin1")
      .replace(/=\r?\n/g, "") // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    return Buffer.from(decoded, "latin1");
  }

  return body;
}

/**
 * Recursively walk a MIME tree, returning the leaf parts.
 *
 * Multipart bodies are split on their declared boundary. Depth is capped
 * because a malformed (or deliberately hostile) message can otherwise nest
 * far enough to exhaust the stack.
 */
function walkParts(
  body: Buffer,
  headers: Header[],
  depth = 0,
): MimePart[] {
  if (depth > 20) return [];

  const ct = parseContentType(getHeader(headers, "content-type"));
  const cte = getHeader(headers, "content-transfer-encoding") ?? "7bit";
  const disposition = parseContentType(
    getHeader(headers, "content-disposition"),
  );

  if (ct.type.startsWith("multipart/") && ct.params.boundary) {
    const boundary = ct.params.boundary;
    const s = body.toString("latin1");
    const chunks = s.split(new RegExp(`--${escapeRegExp(boundary)}(?:--)?\\r?\\n?`));

    const parts: MimePart[] = [];
    // The first chunk is the preamble before the first boundary; skip it.
    for (const chunk of chunks.slice(1)) {
      if (chunk.trim() === "") continue;
      const sub = splitMessage(Buffer.from(chunk, "latin1"));
      const subHeaders = parseHeaders(sub.headerBlock);
      parts.push(...walkParts(sub.body, subHeaders, depth + 1));
    }
    return parts;
  }

  const filename =
    disposition.params.filename ?? ct.params.name ?? "";

  return [
    {
      contentType: ct.type,
      charset: ct.params.charset ?? "utf-8",
      disposition: disposition.type === "text/plain" ? "" : disposition.type,
      filename: decodeEncodedWords(filename),
      content: decodeTransferEncoding(body, cte),
    },
  ];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Parse a raw `.eml` buffer into headers, decoded parts and attachments. */
export function parseEmail(raw: Buffer): ParsedEmail {
  const { headerBlock, body } = splitMessage(raw);
  const headers = parseHeaders(headerBlock);
  const parts = walkParts(body, headers);

  let text = "";
  let html = "";
  const attachments: Attachment[] = [];

  for (const part of parts) {
    const isAttachment =
      part.disposition === "attachment" || part.filename !== "";

    if (isAttachment) {
      attachments.push({
        filename: part.filename,
        declaredType: part.contentType,
        bytes: part.content.length,
        sha256: createHash("sha256").update(part.content).digest("hex"),
        magic: part.content.subarray(0, 8),
      });
      continue;
    }

    if (part.contentType === "text/plain") {
      text += decodeBytes(part.content, part.charset) + "\n";
    } else if (part.contentType === "text/html") {
      html += decodeBytes(part.content, part.charset) + "\n";
    }
  }

  return { headers, parts, text, html, attachments };
}

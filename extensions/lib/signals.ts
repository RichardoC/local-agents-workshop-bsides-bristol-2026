/**
 * Turn a parsed email into a compact list of deterministic signals.
 *
 * This is the half of the workshop that matters most. Everything here is
 * ordinary code — string comparison, edit distance, byte inspection. None of it
 * asks a model anything. The model's job starts *after* this file, and its
 * entire input is the small JSON object we return.
 *
 * That split is what makes a 4B model running on a laptop useful: it never sees
 * the raw message, only twenty or so pre-computed facts.
 */

import {
  getHeader,
  parseAddress,
  parseAuthResults,
  type ParsedEmail,
} from "./eml.ts";

export type Severity = "high" | "medium" | "low";

export interface Signal {
  /** Stable identifier, so downstream code can match on it. */
  id: string;
  severity: Severity;
  /** Human-readable specifics, including the values that triggered it. */
  detail: string;
}

export interface LinkInfo {
  href: string;
  hostname: string;
  /** Visible anchor text, when the link came from HTML. */
  text: string;
}

export interface Triage {
  subject: string;
  from: ReturnType<typeof parseAddress>;
  replyTo: ReturnType<typeof parseAddress>;
  returnPath: ReturnType<typeof parseAddress>;
  date: string;
  auth: ReturnType<typeof parseAuthResults>;
  hops: number;
  links: LinkInfo[];
  attachments: {
    filename: string;
    declaredType: string;
    bytes: number;
    sha256: string;
  }[];
  signals: Signal[];
}

/** Brands that get impersonated often enough to be worth a built-in list. */
const BRANDS = [
  "paypal", "microsoft", "office365", "apple", "amazon", "google",
  "netflix", "hmrc", "dhl", "fedex", "dpd", "evri", "royalmail",
  "barclays", "hsbc", "lloyds", "natwest", "santander", "monzo",
  "meta", "facebook", "instagram", "linkedin", "docusign", "dropbox",
  "adobe", "coinbase", "binance", "steam", "spotify",
];

/** Extensions that are executable, or are treated as such by Windows. */
const DANGEROUS_EXTENSIONS = [
  "exe", "scr", "com", "pif", "bat", "cmd", "js", "jse", "vbs", "vbe",
  "wsf", "wsh", "hta", "lnk", "ps1", "msi", "jar", "reg", "iso", "img",
];

/** Multi-part public suffixes common enough to matter for a UK audience. */
const MULTI_PART_SUFFIXES = [
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.za", "com.br", "co.jp",
  "com.cn", "co.in", "com.mx", "com.sg",
];

/**
 * Approximate the registrable domain ("example.co.uk" from "a.b.example.co.uk").
 *
 * A correct implementation needs the Public Suffix List, which is a dependency
 * and a download. This handles the common cases; it is an approximation and the
 * workshop says so out loud rather than pretending otherwise.
 */
export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");

  const lastTwo = labels.slice(-2).join(".");
  const take = MULTI_PART_SUFFIXES.includes(lastTwo) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** Levenshtein distance, capped for early exit on obviously distant strings. */
export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Detect a non-ASCII (homoglyph) domain using nothing but the URL parser.
 *
 * Node's WHATWG `URL` applies IDNA automatically, so a hostname containing a
 * Cyrillic character comes back punycode-encoded:
 *
 *   new URL("http://pаypal.com").hostname  ->  "xn--pypal-4ve.com"
 *
 * If `xn--` appears in the parsed hostname but not in the text we started with,
 * the domain was not ASCII. One line, no dependency, and it catches a class of
 * attack that a naive string comparison misses entirely.
 *
 * Caveat: this relies on a full-ICU Node build, which is the default.
 */
export function isPunycoded(original: string, parsedHostname: string): boolean {
  return parsedHostname.includes("xn--") && !original.toLowerCase().includes("xn--");
}

/** Pull hrefs and their visible anchor text out of an HTML body. */
export function extractHtmlLinks(html: string): LinkInfo[] {
  const links: LinkInfo[] = [];
  const anchorRe = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>(.*?)<\/a\s*>/gis;

  for (const m of html.matchAll(anchorRe)) {
    const href = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    const text = m[5].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (!href || href.startsWith("mailto:") || href.startsWith("#")) continue;

    links.push({ href, hostname: safeHostname(href), text });
  }
  return links;
}

/** Pull bare URLs out of a plain-text body. */
export function extractTextLinks(text: string): LinkInfo[] {
  const urlRe = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
  return [...text.matchAll(urlRe)].map((m) => ({
    href: m[0],
    hostname: safeHostname(m[0]),
    text: "",
  }));
}

function safeHostname(href: string): string {
  try {
    return new URL(href).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Identify the file extension, accounting for a trailing dot or spaces. */
function extensionOf(filename: string): string {
  const cleaned = filename.trim().replace(/[.\s]+$/, "");
  const dot = cleaned.lastIndexOf(".");
  return dot === -1 ? "" : cleaned.slice(dot + 1).toLowerCase();
}

/** Compare declared MIME type against the actual leading bytes. */
function magicMismatch(magic: Buffer, declaredType: string): string | null {
  const hex = magic.toString("hex").toUpperCase();
  const ascii = magic.toString("latin1");

  let actual = "";
  if (ascii.startsWith("%PDF")) actual = "application/pdf";
  else if (hex.startsWith("4D5A")) actual = "application/x-msdownload"; // "MZ"
  else if (hex.startsWith("504B0304")) actual = "application/zip"; // "PK"
  else if (hex.startsWith("D0CF11E0")) actual = "application/msword"; // OLE2
  else if (hex.startsWith("7F454C46")) actual = "application/x-elf";
  else return null;

  // A .docx/.xlsx is a zip, so treat OOXML types as compatible with zip.
  const declared = declaredType.toLowerCase();
  if (actual === "application/zip" && declared.includes("openxmlformats")) {
    return null;
  }
  if (declared.includes(actual.split("/")[1])) return null;

  return actual;
}

/**
 * Run every deterministic check and return the compact triage object.
 *
 * The return value is what gets handed to the model. Keep it small.
 */
export function triage(email: ParsedEmail): Triage {
  const { headers } = email;
  const signals: Signal[] = [];
  const add = (id: string, severity: Severity, detail: string) =>
    signals.push({ id, severity, detail });

  const from = parseAddress(getHeader(headers, "from"));
  const replyTo = parseAddress(getHeader(headers, "reply-to"));
  const returnPath = parseAddress(getHeader(headers, "return-path"));
  const auth = parseAuthResults(headers);
  const subject = getHeader(headers, "subject") ?? "";
  const date = getHeader(headers, "date") ?? "";
  const hops = headers.filter((h) => h.name === "received").length;

  const fromReg = registrableDomain(from.domain);

  // --- Envelope consistency -------------------------------------------------

  if (replyTo.domain && fromReg && registrableDomain(replyTo.domain) !== fromReg) {
    add(
      "reply_to_mismatch",
      "high",
      `Reply-To is ${replyTo.domain} but From is ${from.domain}. Replies leave the sender's domain.`,
    );
  }

  if (returnPath.domain && fromReg && registrableDomain(returnPath.domain) !== fromReg) {
    add(
      "return_path_mismatch",
      "medium",
      `Return-Path is ${returnPath.domain} but From is ${from.domain}.`,
    );
  }

  // A display name containing a whole email address is a classic mobile-client
  // spoof: many clients show only the display name.
  const displayAddr = from.display.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (displayAddr && displayAddr[0].toLowerCase() !== from.address.toLowerCase()) {
    add(
      "display_name_is_different_address",
      "high",
      `Display name shows "${displayAddr[0]}" but the real sender is ${from.address}.`,
    );
  }

  // --- Authentication -------------------------------------------------------

  if (auth.absent) {
    add(
      "auth_results_absent",
      "low",
      "No Authentication-Results header. The receiving server recorded no SPF/DKIM/DMARC verdict.",
    );
  } else {
    for (const [mech, verdict] of [
      ["spf", auth.spf],
      ["dkim", auth.dkim],
      ["dmarc", auth.dmarc],
    ] as const) {
      if (verdict === "fail" || verdict === "softfail") {
        add(
          `${mech}_${verdict}`,
          mech === "dmarc" ? "high" : "medium",
          `${mech.toUpperCase()} recorded as ${verdict} by the receiving server.`,
        );
      }
    }
  }

  // --- Brand impersonation in the sender domain -----------------------------

  checkBrand(from.domain, "From address", add);

  // --- Links ----------------------------------------------------------------

  const links = [...extractHtmlLinks(email.html), ...extractTextLinks(email.text)];
  const seenHosts = new Set<string>();

  for (const link of links) {
    if (!link.hostname || seenHosts.has(link.hostname)) continue;
    seenHosts.add(link.hostname);

    if (isPunycoded(link.href, link.hostname)) {
      add(
        "punycode_link",
        "high",
        `Link host ${link.hostname} is a non-ASCII domain (homoglyph). Raw href: ${link.href.slice(0, 120)}`,
      );
    }

    checkBrand(link.hostname, "link", add);
  }

  // Anchor text that names a different domain than the href actually goes to.
  for (const link of links) {
    if (!link.text || !link.hostname) continue;
    const claimed = link.text.match(/\b(?:https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,})\b/i);
    if (!claimed) continue;

    const claimedReg = registrableDomain(claimed[1]);
    const actualReg = registrableDomain(link.hostname);
    if (claimedReg && actualReg && claimedReg !== actualReg) {
      add(
        "href_text_mismatch",
        "high",
        `Link text says "${claimed[1]}" but it points to ${link.hostname}.`,
      );
    }
  }

  if (isPunycoded(from.domain, safeHostname(`http://${from.domain}`))) {
    add(
      "punycode_sender",
      "high",
      `Sender domain ${from.domain} is a non-ASCII domain (homoglyph).`,
    );
  }

  // --- Attachments ----------------------------------------------------------

  for (const att of email.attachments) {
    const ext = extensionOf(att.filename);

    if (DANGEROUS_EXTENSIONS.includes(ext)) {
      add(
        "dangerous_attachment",
        "high",
        `Attachment "${att.filename}" has an executable extension (.${ext}).`,
      );
    }

    // "invoice.pdf.exe" — the middle extension is there to be believed.
    const parts = att.filename.trim().split(".");
    if (parts.length > 2) {
      const inner = parts[parts.length - 2].toLowerCase();
      if (["pdf", "doc", "docx", "xls", "xlsx", "jpg", "png", "txt"].includes(inner)) {
        add(
          "double_extension",
          "high",
          `Attachment "${att.filename}" uses a double extension to disguise its real type.`,
        );
      }
    }

    // U+202E flips the display of everything after it, so "annexe.fdp.exe"
    // renders as "annexe.exe.pdf" in most file listings.
    if (att.filename.includes("‮")) {
      add(
        "rtl_override_filename",
        "high",
        `Attachment filename contains a right-to-left override character (U+202E), disguising its real extension.`,
      );
    }

    const actual = magicMismatch(att.magic, att.declaredType);
    if (actual) {
      add(
        "attachment_type_mismatch",
        "high",
        `Attachment "${att.filename}" is declared ${att.declaredType} but its bytes look like ${actual}.`,
      );
    }
  }

  return {
    subject,
    from,
    replyTo,
    returnPath,
    date,
    auth,
    hops,
    links: links.slice(0, 25), // Cap: the model does not need hundreds.
    attachments: email.attachments.map((a) => ({
      filename: a.filename,
      declaredType: a.declaredType,
      bytes: a.bytes,
      sha256: a.sha256,
    })),
    signals,
  };
}

/** Flag brand names used outside the brand's own registrable domain. */
function checkBrand(
  hostname: string,
  where: string,
  add: (id: string, severity: Severity, detail: string) => void,
): void {
  if (!hostname) return;

  const reg = registrableDomain(hostname);
  const regLabel = reg.split(".")[0];

  for (const brand of BRANDS) {
    // "paypal.com.secure-login.ru" — the brand is present but not registrable.
    if (hostname.includes(brand) && regLabel !== brand) {
      add(
        "brand_in_subdomain",
        "high",
        `${where} host ${hostname} contains "${brand}" but the registrable domain is ${reg}.`,
      );
      return;
    }

    // "paypa1.com", "rnicrosoft.com" — one or two characters off.
    const dist = editDistance(regLabel, brand);
    if (dist > 0 && dist <= 2 && regLabel.length >= 5) {
      add(
        "lookalike_domain",
        "high",
        `${where} host ${hostname} is ${dist} character(s) away from "${brand}".`,
      );
      return;
    }
  }
}

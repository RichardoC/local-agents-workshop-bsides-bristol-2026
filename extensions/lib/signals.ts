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

/**
 * Hostnames the brands themselves own.
 *
 * Without this the brand check fires on the brand's own infrastructure: 890 of
 * its 1,038 hits across 8,614 real messages were Google's CDN, Microsoft's
 * tenant domain or Amazon's S3. A high-severity phishing verdict on a
 * legitimate S3 invoice link is the most likely way this tool embarrasses
 * someone in front of a room.
 */
const BRAND_OWNED_SUFFIXES = [
  "google.com", "googleapis.com", "googleusercontent.com", "googleadservices.com",
  "googlemail.com", "googletagmanager.com", "gstatic.com", "youtube.com", "goo.gl",
  "microsoft.com", "microsoftonline.com", "onmicrosoft.com", "office.com",
  "office365.com", "sharepoint.com", "live.com", "outlook.com", "azure.com",
  "amazon.com", "amazon.co.uk", "amazonaws.com", "amazonses.com", "awstrack.me",
  "media-amazon.com", "ssl-images-amazon.com",
  "apple.com", "icloud.com", "itunes.com",
  "paypal.com", "paypal.co.uk", "paypalobjects.com",
  "dropbox.com", "dropboxusercontent.com", "docusign.com", "docusign.net",
  "adobe.com", "adobelogin.com", "linkedin.com", "licdn.com",
  "facebook.com", "instagram.com", "meta.com", "fbcdn.net", "whatsapp.com",
  "netflix.com", "nflxext.com", "spotify.com", "scdn.co",
  "coinbase.com", "binance.com", "steampowered.com", "steamcommunity.com",
  "hmrc.gov.uk", "royalmail.com", "dhl.com", "fedex.com", "dpd.co.uk", "evri.com",
  "barclays.co.uk", "hsbc.co.uk", "lloydsbank.co.uk", "natwest.com",
  "santander.co.uk", "monzo.com",
];

/**
 * Click-tracking domains used by legitimate mail providers.
 *
 * Every bulk mailer rewrites the href while leaving the brand's own URL as the
 * anchor text — which is href/text mismatch by construction. This check fires on
 * 494 of 8,614 real messages, and a large share are ordinary newsletters. These
 * are still worth reporting, just not as high severity.
 */
const ESP_TRACKING_SUFFIXES = [
  "list-manage.com", "mailchimp.com", "mcsv.net", "mandrillapp.com",
  "sendgrid.net", "sendgrid.com", "sparkpostmail.com", "mailgun.org",
  "createsend.com", "cmail19.com", "cmail20.com", "exacttarget.com",
  "et.email", "click.email", "rs6.net", "constantcontact.com",
  "hubspotlinks.com", "hs-sites.com", "salesforce.com", "pardot.com",
  "klaviyomail.com", "sailthru.com", "braze.com", "iterable.com",
  "customeriomail.com", "postmarkapp.com", "amazonses.com", "awstrack.me",
  "doubleclick.net", "go.pardot.com", "mktoresp.com", "marketo.com",
];

/** Extensions that are executable, or are treated as such by Windows. */
const DANGEROUS_EXTENSIONS = [
  "exe", "scr", "com", "pif", "bat", "cmd", "js", "jse", "vbs", "vbe",
  "wsf", "wsh", "hta", "lnk", "ps1", "msi", "jar", "reg", "iso", "img",
];

/**
 * Suffixes where anyone can register a name, so two sites under one of them are
 * NOT the same organisation.
 *
 * These are the Public Suffix List's *private* section, and the omission was not
 * academic: treating `github.io` as registrable makes alice.github.io and
 * attacker.github.io look like one domain, so every mismatch check goes quiet on
 * exactly the free hosting phishing likes. All of these appear as phishing hosts
 * in the corpus.
 */
const PRIVATE_SUFFIXES = [
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app",
  "netlify.app", "web.app", "firebaseapp.com", "firebasestorage.googleapis.com",
  "cloudfunctions.net", "run.app", "appspot.com", "blogspot.com",
  "bubbleapps.io", "weebly.com", "wixsite.com", "squarespace.com",
  "herokuapp.com", "onrender.com", "glitch.me", "repl.co", "surge.sh",
  "s3.amazonaws.com", "onmicrosoft.com", "sharepoint.com", "myshopify.com",
  "zendesk.com", "notion.site", "webflow.io", "duckdns.org", "ngrok.io",
  "ngrok-free.app", "trycloudflare.com", "azurewebsites.net", "sites.google.com",
];

/** Multi-part public suffixes common enough to matter for a UK audience. */
const MULTI_PART_SUFFIXES = [
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
  // The ones a UK security audience will actually try.
  "nhs.uk", "police.uk", "ltd.uk", "plc.uk", "mod.uk",
  "com.au", "net.au", "org.au", "gov.au", "edu.au", "co.nz", "co.za",
  "com.br", "co.jp", "or.jp", "ne.jp", "ac.jp", "com.cn", "co.in",
  "com.mx", "com.sg", "co.il", "com.tr", "co.kr", "com.tw", "com.hk",
  "co.id", "com.ua",
];

/**
 * Approximate the registrable domain ("example.co.uk" from "a.b.example.co.uk").
 *
 * A correct implementation needs the Public Suffix List, which is a dependency
 * and a download. This handles the common cases; it is an approximation and the
 * workshop says so out loud rather than pretending otherwise.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  // An IP literal has no registrable domain; returning "2.1" for 192.0.2.1 was
  // worse than useless, because it looks like an answer.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return host;

  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");

  // A private (shared-hosting) suffix takes one more label than the suffix
  // itself, so alice.github.io stays distinct from attacker.github.io.
  for (const suffix of PRIVATE_SUFFIXES) {
    if (host === suffix) return host;
    if (host.endsWith("." + suffix)) {
      const depth = suffix.split(".").length + 1;
      return labels.slice(-depth).join(".");
    }
  }

  const lastTwo = labels.slice(-2).join(".");
  const take = MULTI_PART_SUFFIXES.includes(lastTwo) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** Levenshtein distance, capped for early exit on obviously distant strings. */
export function editDistance(a: string, b: string, cap = Infinity): number {
  // Previously this returned the magic number 99 past a hard length delta of 3,
  // which is a *distance* a caller can compare against by accident. Take the cap
  // explicitly instead, and return a real distance otherwise.
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

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
 * Fold characters chosen for visual similarity onto a single representative.
 *
 * Typosquatting is not random: an attacker picks the substitution that survives
 * a glance. Digit-for-letter (paypa1, micros0ft), doubled-letter-for-letter
 * (rnicrosoft for microsoft, vvhatsapp for whatsapp), and l/i confusion account
 * for most of it. Normalising all of them onto one skeleton turns "does this
 * look like the brand?" into a plain string comparison.
 *
 *   confusableSkeleton("paypa1")     === confusableSkeleton("paypal")
 *   confusableSkeleton("micros0ft")  === confusableSkeleton("microsoft")
 *   confusableSkeleton("rnicrosoft") === confusableSkeleton("microsoft")
 *
 * That last one is why this exists: rn -> m is two edits, so edit distance
 * cannot see it at any threshold a real corpus tolerates. This is the right
 * tool for the job and it costs one pass over a short string.
 *
 * Multi-character rules run first, because folding 1 -> i would otherwise stop
 * "cl" -> "d" and "rn" -> "m" from ever matching.
 *
 * This is a good place to extend: Cyrillic and Greek lookalikes (а, о, е, ѕ) are
 * not handled here at all — punycode_link catches those from a different angle.
 */
export function confusableSkeleton(s: string): string {
  return s
    .toLowerCase()
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/cl/g, "d")
    .replace(/[1l]/g, "i")
    .replace(/0/g, "o")
    .replace(/5/g, "s")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/7/g, "t")
    .replace(/8/g, "b")
    .replace(/9/g, "g")
    .replace(/2/g, "z")
    .replace(/\$/g, "s")
    .replace(/[^a-z0-9]/g, "");
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
  // The closing tag is optional: real bulk mail leaves anchors unterminated, and
  // requiring </a> made the link — and every check depending on it — vanish.
  const anchorRe = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>(.*?)(?:<\/a\s*>|$)/gis;

  for (const m of html.matchAll(anchorRe)) {
    const href = decodeHtmlEntities((m[2] ?? m[3] ?? m[4] ?? "").trim());
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

/**
 * Decode the HTML entities an href arrives wrapped in.
 *
 * Without this, 105 corpus messages produced a hostname like "xn--rzj&-9pa" —
 * not a hostname at all, but undecoded entity soup that `new URL()` happily
 * accepted. The signal fired, the reason was fiction, and the real host was
 * never examined. The fiction is what reaches the model.
 */
export function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
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

  const declared = declaredType.toLowerCase();

  // "application/octet-stream" means "I do not know what these bytes are". There
  // is no claim to contradict. 22 of 24 corpus hits were a genuine PDF honestly
  // sent by a mailer that set no specific type — a 92% false-positive rate on a
  // HIGH signal.
  if (declared === "application/octet-stream" || declared === "") return null;

  // A .docx/.xlsx is a zip, so treat OOXML types as compatible with zip.
  if (actual === "application/zip" && /openxmlformats|zip|jar|epub|od[tsp]/.test(declared)) {
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
  // Dedupe on id + detail. Per-link checks repeat themselves on a message with
  // many links, and the design premise is "about twenty facts" — nothing was
  // enforcing that.
  const seen = new Set<string>();
  const add = (id: string, severity: Severity, detail: string) => {
    const key = `${id}\u0000${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    signals.push({ id, severity, detail });
  };

  const from = parseAddress(getHeader(headers, "from"));
  const replyTo = parseAddress(getHeader(headers, "reply-to"));
  const returnPath = parseAddress(getHeader(headers, "return-path"));
  const auth = parseAuthResults(headers);
  const subject = getHeader(headers, "subject") ?? "";
  const date = getHeader(headers, "date") ?? "";
  const hops = headers.filter((h) => h.name === "received").length;

  // Declared here rather than down in the Links section on purpose. Putting it
  // there meant anyone adding a link-based check in the obvious place — under
  // the "--- Links ---" banner but above the const — got
  // "Cannot access 'links' before initialization", with no type error to warn
  // them, because --experimental-strip-types strips types without checking them.
  const links = [...extractHtmlLinks(email.html), ...extractTextLinks(email.text)];

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

  // Reply-To and Return-Path too, which is not an afterthought: corpus message
  // sample-7261.eml name-drops "facebookk.com" (one edit from facebook) in its
  // Reply-To and nowhere else, so checking only From and links missed the one
  // real typosquat in 8,614 messages. The address a reply actually goes to is
  // at least as interesting as the one it claims to come from.
  checkBrand(replyTo.domain, "Reply-To address", add);
  checkBrand(returnPath.domain, "Return-Path", add);

  // --- Links ----------------------------------------------------------------

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

    // Require the anchor text to *be* a bare URL or hostname, not prose that
    // merely mentions a domain ("read our policy at example.org" was firing).
    const textOnly = link.text.trim();
    const claimed = textOnly.match(
      /^(?:https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,})(?:[/?#].*)?$/i,
    );
    if (!claimed) continue;

    const claimedReg = registrableDomain(claimed[1]);
    const actualReg = registrableDomain(link.hostname);
    if (!claimedReg || !actualReg || claimedReg === actualReg) continue;

    // A mail provider's click tracker rewrites the href and leaves the brand's
    // URL as the text. That is the same shape as the attack, so report it — but
    // say which one it looks like rather than crying wolf.
    const isEsp = ESP_TRACKING_SUFFIXES.some(
      (d) => actualReg === d || link.hostname.endsWith("." + d),
    );
    add(
      "href_text_mismatch",
      isEsp ? "low" : "high",
      isEsp
        ? `Link text says "${claimed[1]}" but it points to ${link.hostname}, which is a known mail-provider click tracker. Legitimate bulk mail looks like this.`
        : `Link text says "${claimed[1]}" but it points to ${link.hostname}.`,
    );
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
    // "holiday.png." splits to 3 parts with an empty last one, which looked
    // like a double extension. extensionOf already strips these; match it.
    const parts = att.filename.trim().replace(/[.\s]+$/, "").split(".");
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

  // --------------------------------------------------------------------------
  // ADD YOUR OWN CHECK HERE.
  //
  // Everything you might need is already in scope: `subject`, `date`, `from`,
  // `replyTo`, `returnPath`, `auth`, `hops`, `links`, `email.attachments`,
  // `email.text`, `email.html`, and `headers` (with `getHeader` /
  // `getAllHeaders`). Then call:
  //
  //   add("your_signal_id", "low" | "medium" | "high", "what you found");
  //
  // Put the specifics in the detail string — the model quotes it, so vague
  // wording becomes a vague verdict. And check your signal against the corpus
  // before trusting it: several checks in this file were miscalibrated for
  // exactly as long as nobody measured them.
  // --------------------------------------------------------------------------

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

  // The brand's own hostnames are not the brand impersonating itself.
  if (BRAND_OWNED_SUFFIXES.includes(reg)) return;

  // Only the labels LEFT OF the registrable domain are a subdomain. The old
  // check tested the whole hostname, so any registrable label that merely
  // contained a brand as a substring fired — and the detail string then
  // contradicted itself ("metamask.io contains meta but the registrable domain
  // is metamask.io"). 121 of 1,038 corpus hits were that.
  const subdomain = hostname.endsWith("." + reg)
    ? hostname.slice(0, -(reg.length + 1))
    : "";

  // Collect rather than returning on the first match: a host that both
  // name-drops one brand and typo-squats another was only ever reporting
  // whichever brand happened to come first in the list.
  const hits: { id: string; severity: Severity; detail: string }[] = [];

  for (const brand of BRANDS) {
    // The registrable label IS the brand: amazon.de, santander.com.br,
    // netflix.co.uk. That is the brand on a country TLD, not an impersonation,
    // and BRAND_OWNED_SUFFIXES cannot list every ccTLD every brand owns. The
    // distance check excluded these implicitly via `dist > 0`; the skeleton
    // check needs it said out loud, or every brand's own ccTLD is a lookalike
    // of itself. (Measured: without this, 14 corpus messages were flagged HIGH
    // for using santander.com.br, amazon.de, paypal.de and google.de.)
    if (regLabel === brand) continue;

    if (subdomain.includes(brand)) {
      hits.push({
        id: "brand_in_subdomain",
        severity: "high",
        detail: `${where} host ${hostname} puts "${brand}" in a subdomain of ${reg}, which is not ${brand}'s own domain.`,
      });
      continue;
    }

    // "paypa1.com" — one character off.
    //
    // Two tests, because they fail in different ways and deserve different
    // confidence.
    //
    // 1. CONFUSABLE SKELETON. Fold the characters an attacker substitutes for
    //    visual similarity onto one representative, then compare for equality.
    //    A deliberate lookalike collapses exactly onto the brand: paypa1 and
    //    micros0ft and rnicrosoft and vvhatsapp all do. Measured across 8,614
    //    real messages this fires on nothing, so it is pure recall at no cost
    //    in noise — the useful kind of check.
    //
    // 2. EDIT DISTANCE, deliberately loose. This one does produce false
    //    positives and that is the accepted trade: a detector that never fires
    //    teaches nothing and catches nothing. An earlier version required
    //    brands of 6+ characters at distance 1 and fired on exactly ONE message
    //    in the whole corpus. Better to be occasionally wrong and visibly
    //    useful.
    //
    //    Severity carries the confidence, so a loose match does not shout as
    //    loudly as an exact skeleton collision:
    //      - skeleton match, or distance 1 on a brand of 6+ -> high
    //      - anything looser (short brand, or distance 2)    -> medium
    //
    //    Known false positives, all medium, all worth looking at as a lesson in
    //    what this class of check cannot do: mega.nz~meta, hsb.com~hsbc,
    //    info.mrc.org~hmrc, did.li~dpd, coingate.com~coinbase, team.com~steam.
    //    A four-letter brand sits one edit from a large number of perfectly
    //    ordinary domains. Fixing that properly needs a popularity or
    //    registration-age signal, not a tighter threshold — a good exercise.
    if (confusableSkeleton(regLabel) === confusableSkeleton(brand)) {
      hits.push({
        id: "lookalike_domain",
        severity: "high",
        detail: `${where} host ${hostname} is not "${brand}" but is built to look like it: the two are identical once characters chosen for visual similarity (0/o, 1/l, rn/m) are folded together.`,
      });
      continue;
    }

    // Longer brands get a bigger budget: their edit neighbourhood is sparser,
    // so distance 2 still means something for "microsoft" while it is noise for
    // "dpd".
    const budget = brand.length >= 8 ? 2 : 1;
    const dist = editDistance(regLabel, brand, budget);
    if (
      dist > 0 &&
      dist <= budget &&
      Math.abs(regLabel.length - brand.length) <= budget
    ) {
      const confident = dist === 1 && brand.length >= 6;
      hits.push({
        id: "lookalike_domain",
        severity: confident ? "high" : "medium",
        detail:
          `${where} host ${hostname} is ${dist} character${dist === 1 ? "" : "s"} away from ` +
          `"${brand}", which is a brand this kind of message often impersonates.` +
          (confident
            ? ""
            : ` Short brands and 2-character differences both produce false positives, so treat this as a prompt to look, not a verdict.`),
      });
      continue;
    }
  }

  // Cap so a pathological hostname cannot flood the object handed to the model.
  for (const h of hits.slice(0, 3)) add(h.id, h.severity, h.detail);
}

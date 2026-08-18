/**
 * Generate the synthetic sample emails in samples/synthetic/.
 *
 * Why these exist alongside the real Phishing Pot corpus:
 *
 *   1. The corpus is a 422 MB submodule. Plenty of people will arrive without
 *      it — bad wifi, a clone without --recurse-submodules, a locked-down
 *      laptop. These samples are a few kilobytes and always present, so the
 *      workshop works regardless.
 *   2. Real phishing is messy: any given message trips five signals at once,
 *      which is useless for showing what an individual check does. Each sample
 *      here is built to trip ONE signal, so you can read the .eml, predict the
 *      output, and check yourself.
 *   3. The corpus is CC BY-NC. These are ours, MIT, so they can be copied into
 *      whatever you build afterwards.
 *
 * Every message is invented. The domains use .example (RFC 2606), which is
 * reserved and cannot be registered, so nothing here can accidentally point at
 * a real organisation.
 *
 * Regenerate with:  node tools/make-samples.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = new URL("../samples/synthetic/", import.meta.url).pathname;

/** Wrap a base64 payload at 76 columns, as a real MIME encoder would. */
const b64 = (buf) =>
  Buffer.from(buf)
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n")
    .trim();

/** Join header/body lines with CRLF, which is what RFC 5322 actually says. */
const eml = (lines) => lines.join("\r\n") + "\r\n";

/**
 * A plausible two-hop Received chain. Real messages have these; leaving them
 * out would make every sample look synthetic to a reader.
 */
const received = (fromHost, fromIp) => [
  `Received: from mx-in-04.mailhost.example (mx-in-04.mailhost.example [203.0.113.24])`,
  `\tby imap-01.recipient.example with ESMTPS id 4bK9Lm2Wq3z;`,
  `\tTue, 18 Aug 2026 09:14:22 +0100 (BST)`,
  `Received: from ${fromHost} (${fromHost} [${fromIp}])`,
  `\tby mx-in-04.mailhost.example with ESMTP id 8Rt4Yn6Pv1x;`,
  `\tTue, 18 Aug 2026 09:14:19 +0100 (BST)`,
];

/** An Authentication-Results header in the format Gmail and friends emit. */
const authResults = (spf, dkim, dmarc, domain) =>
  [
    `Authentication-Results: imap-01.recipient.example;`,
    `\tspf=${spf} smtp.mailfrom=${domain};`,
    `\tdkim=${dkim} header.d=${domain};`,
    `\tdmarc=${dmarc} header.from=${domain}`,
  ].join("\r\n");

/** A single-part text/plain message. */
function plain({ headers, body, charset = "utf-8" }) {
  return eml([
    ...headers,
    "MIME-Version: 1.0",
    `Content-Type: text/plain; charset="${charset}"`,
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ]);
}

/** A multipart/alternative message with both a text and an HTML part. */
function html({ headers, text, htmlBody, charset = "utf-8" }) {
  const b = "----=_Part_8812_1739204411";
  return eml([
    ...headers,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${b}"`,
    "",
    `--${b}`,
    `Content-Type: text/plain; charset="${charset}"`,
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    "",
    `--${b}`,
    `Content-Type: text/html; charset="${charset}"`,
    "Content-Transfer-Encoding: 8bit",
    "",
    htmlBody,
    "",
    `--${b}--`,
  ]);
}

/**
 * Encode a filename as an RFC 2047 encoded-word.
 *
 * Header parameters are supposed to be ASCII. A filename carrying U+202E has to
 * be encoded to survive, and an encoded-word is what actually turns up in the
 * wild — it also hides the trick from anything that only greps the raw source.
 */
const encodedWord = (s) => `=?utf-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

/** A multipart/mixed message carrying one attachment. */
function withAttachment({ headers, text, filename, mimeType, bytes, encodeFilename = false }) {
  const b = "----=_Part_5501_2048119903";
  const name = encodeFilename ? encodedWord(filename) : filename;
  return eml([
    ...headers,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    "",
    `--${b}`,
    `Content-Type: ${mimeType}; name="${name}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${name}"`,
    "",
    b64(bytes),
    "",
    `--${b}--`,
  ]);
}

// Byte prefixes used to make an attachment's real type disagree with its label.
const PE_HEADER = Buffer.concat([
  Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1"),
  Buffer.from("This is not really a PDF. The first two bytes say MZ.", "latin1"),
]);
const HARMLESS = Buffer.from(
  "Placeholder attachment content for the BSides Bristol workshop. Not executable.",
  "latin1",
);

const SAMPLES = [
  // ---------------------------------------------------------------- control
  {
    file: "01-clean-newsletter.eml",
    signal: "none — this is the control",
    note: "A legitimate message. The tool should raise nothing at all. Worth trying first: a triage tool that flags everything is worthless, and the model should say so rather than manufacturing a concern.",
    build: () =>
      html({
        headers: [
          ...received("smtp-out-09.bristol-tech.example", "198.51.100.71"),
          authResults("pass", "pass", "pass", "bristol-tech.example"),
          "Return-Path: <newsletter@bristol-tech.example>",
          "From: Bristol Tech Meetup <newsletter@bristol-tech.example>",
          "To: attendee@recipient.example",
          "Subject: August meetup: lightning talks and pizza",
          "Date: Tue, 18 Aug 2026 09:14:18 +0100",
          "Message-ID: <20260818081418.4b2c9@bristol-tech.example>",
          "List-Unsubscribe: <https://bristol-tech.example/unsubscribe?id=4b2c9>",
        ],
        text: [
          "Hello,",
          "",
          "This month we have four lightning talks, and pizza from 18:30.",
          "Doors at 18:00 at the usual place.",
          "",
          "Full details: https://bristol-tech.example/events/august",
          "",
          "See you there,",
          "The organisers",
        ].join("\r\n"),
        htmlBody: [
          "<html><body>",
          "<p>Hello,</p>",
          "<p>This month we have four lightning talks, and pizza from 18:30.</p>",
          '<p><a href="https://bristol-tech.example/events/august">Full details</a></p>',
          "<p>See you there,<br>The organisers</p>",
          "</body></html>",
        ].join("\r\n"),
      }),
  },

  // ------------------------------------------------------ envelope mismatch
  {
    file: "02-reply-to-mismatch.eml",
    signal: "reply_to_mismatch",
    note: "Everything authenticates, and the From domain is genuinely the sender. But hit reply and your answer goes somewhere else entirely. This is what business email compromise looks like on the wire.",
    build: () =>
      plain({
        headers: [
          ...received("smtp-out-02.northgate-services.example", "198.51.100.44"),
          authResults("pass", "pass", "pass", "northgate-services.example"),
          "Return-Path: <accounts@northgate-services.example>",
          "From: Northgate Accounts <accounts@northgate-services.example>",
          "Reply-To: accounts.dept@secure-mail-relay-92.example",
          "To: finance@recipient.example",
          // Non-ASCII in a header has to be an encoded-word; raw UTF-8 there is
          // not legal and real senders do not emit it. This also exercises the
          // parser's RFC 2047 decoding, which is otherwise easy to get wrong.
          `Subject: ${encodedWord("RE: Outstanding invoice 44821 — updated bank details")}`,
          "Date: Tue, 18 Aug 2026 09:14:18 +0100",
          "Message-ID: <20260818081418.7d31f@northgate-services.example>",
        ],
        body: [
          "Hi,",
          "",
          "Following up on invoice 44821. Please note our banking details have",
          "changed since the last payment run — reply to this message and I will",
          "send the updated remittance form over.",
          "",
          "Best regards,",
          "Accounts Department",
        ].join("\r\n"),
      }),
  },
  {
    file: "03-display-name-spoof.eml",
    signal: "display_name_is_different_address",
    note: "The display name is itself an email address — a different one from the actual sender. Most mobile mail clients show only the display name, so this is what the recipient sees. Open it in a client and compare with what the tool reports.",
    build: () =>
      plain({
        headers: [
          ...received("mail.bulk-sender-3x.example", "203.0.113.188"),
          authResults("pass", "pass", "pass", "bulk-sender-3x.example"),
          "Return-Path: <alerts@bulk-sender-3x.example>",
          'From: "helpdesk@recipient.example" <alerts@bulk-sender-3x.example>',
          "To: staff@recipient.example",
          "Subject: Action required: mailbox storage exceeded",
          "Date: Tue, 18 Aug 2026 09:14:18 +0100",
          "Message-ID: <20260818081418.9a04c@bulk-sender-3x.example>",
        ],
        body: [
          "Your mailbox has exceeded its storage quota.",
          "",
          "Reply to this message with your staff number and the IT team will",
          "increase your allocation within one working day.",
          "",
          "IT Helpdesk",
        ].join("\r\n"),
      }),
  },

  // ------------------------------------------------------- authentication
  {
    file: "04-auth-fail.eml",
    signal: "spf_fail, dkim_fail, dmarc_fail",
    note: "The receiving server checked and all three failed. Note what the tool says in its footer: this is a recorded verdict from delivery time, not something re-checked now. We are reading someone else's homework.",
    build: () =>
      plain({
        headers: [
          ...received("unknown-host-44.example", "192.0.2.201"),
          // Deliberately not a brand-like domain: this sample is about the
          // authentication verdicts and nothing else.
          authResults("fail", "fail", "fail", "parcel-notice-77.example"),
          "Return-Path: <noreply@parcel-notice-77.example>",
          "From: Delivery Notifications <noreply@parcel-notice-77.example>",
          "To: recipient@recipient.example",
          "Subject: Your parcel could not be delivered",
          "Date: Tue, 18 Aug 2026 09:14:18 +0100",
          "Message-ID: <20260818081418.1f77b@parcel-notice-77.example>",
        ],
        body: [
          "We attempted delivery of your parcel and a redelivery fee of GBP 2.99",
          "is outstanding.",
          "",
          "Arrange redelivery within 48 hours or the item will be returned.",
        ].join("\r\n"),
      }),
  },
  {
    file: "05-no-auth-headers.eml",
    signal: "auth_results_absent",
    note: "No Authentication-Results header at all — the low-severity case, and deliberately so. Plenty of legitimate internal mail never crosses a checking gateway. Absence of evidence is not evidence, and the severity should reflect that.",
    build: () =>
      plain({
        headers: [
          ...received("relay.internal-legacy.example", "192.0.2.19"),
          "Return-Path: <reports@internal-legacy.example>",
          "From: Nightly Reports <reports@internal-legacy.example>",
          "To: ops@recipient.example",
          "Subject: Batch job 2291 completed",
          "Date: Tue, 18 Aug 2026 09:14:18 +0100",
          "Message-ID: <20260818081418.3c8e1@internal-legacy.example>",
        ],
        body: [
          "Batch job 2291 completed at 03:14 with 0 errors.",
          "",
          "-- automated message, do not reply",
        ].join("\r\n"),
      }),
  },

  // -------------------------------------------------------------- domains
  {
    file: "06-brand-in-subdomain.eml",
    signal: "brand_in_subdomain",
    note: 'The link host is paypal.com.account-verify-4471.example. Read it right-to-left the way a resolver does and the registrable domain is account-verify-4471.example — "paypal.com" is just a label someone chose. This is the single most useful thing to teach a non-technical colleague.',
    build: () =>
      html({
        headers: [
          ...received("smtp.account-verify-4471.example", "203.0.113.99"),
          authResults("pass", "pass", "pass", "account-verify-4471.example"),
          "Return-Path: <service@account-verify-4471.example>",
          "From: Account Services <service@account-verify-4471.example>",
          "To: recipient@recipient.example",
          "Subject: Unusual sign-in attempt on your account",
          "Date: Tue, 18 Aug 2026 09:14:18 +0100",
          "Message-ID: <20260818081418.5b2a7@account-verify-4471.example>",
        ],
        text: [
          "We detected a sign-in from a new device.",
          "",
          "Confirm it was you:",
          "https://paypal.com.account-verify-4471.example/confirm?ref=88213",
        ].join("\r\n"),
        htmlBody: [
          "<html><body>",
          "<p>We detected a sign-in from a new device.</p>",
          '<p><a href="https://paypal.com.account-verify-4471.example/confirm?ref=88213">Confirm it was you</a></p>',
          "</body></html>",
        ].join("\r\n"),
      }),
  },
  {
    file: "07-lookalike-domain.eml",
    signal: "lookalike_domain",
    note: 'micros0ft.example — a zero for the o, one character of edit distance from "microsoft". At a glance in a status bar it is invisible. The check is Levenshtein distance against a small brand list, which is about fifteen lines of ordinary code.',
    build: () =>
      html({
        headers: [
          ...received("smtp.micros0ft.example", "198.51.100.203"),
          authResults("pass", "pass", "pass", "micros0ft.example"),
          "Return-Path: <no-reply@notifications.example>",
          "From: Security Team <no-reply@notifications.example>",
          "To: recipient@recipient.example",
          "Subject: Your password expires today",
          "Date: Tue, 18 Aug 2026 09:14:18 +0100",
          "Message-ID: <20260818081418.6d9f3@notifications.example>",
        ],
        text: [
          "Your password expires in 4 hours.",
          "",
          "Reset it here: https://login.micros0ft.example/reset",
        ].join("\r\n"),
        htmlBody: [
          "<html><body>",
          "<p>Your password expires in 4 hours.</p>",
          '<p><a href="https://login.micros0ft.example/reset">Reset your password</a></p>',
          "</body></html>",
        ].join("\r\n"),
      }),
  },
  {
    file: "08-homoglyph-punycode.eml",
    signal: "punycode_link",
    note: "The link host contains a Cyrillic а (U+0430) instead of a Latin a. It is not merely similar — it is indistinguishable in most fonts. Node's URL parser applies IDNA on its own, so the whole detection is: parse the host, and see whether xn-- appeared out of nowhere.",
    build: () =>
      html({
        headers: [
          ...received("smtp.mail-forward-71.example", "192.0.2.144"),
          authResults("pass", "pass", "pass", "mail-forward-71.example"),
          "Return-Path: <billing@mail-forward-71.example>",
          "From: Billing <billing@mail-forward-71.example>",
          "To: recipient@recipient.example",
          "Subject: Receipt for your recent payment",
          "Date: Tue, 18 Aug 2026 09:14:18 +0100",
          "Message-ID: <20260818081418.8e5c2@mail-forward-71.example>",
        ],
        // The a in "paypal" here is U+0430 CYRILLIC SMALL LETTER A.
        text: [
          "Your payment of GBP 149.99 has been processed.",
          "",
          "If you did not authorise this, cancel here:",
          "https://pаypal.com/dispute",
        ].join("\r\n"),
        htmlBody: [
          "<html><body>",
          "<p>Your payment of GBP 149.99 has been processed.</p>",
          '<p><a href="https://pаypal.com/dispute">Cancel this payment</a></p>',
          "</body></html>",
        ].join("\r\n"),
      }),
  },
  {
    file: "09-href-text-mismatch.eml",
    signal: "href_text_mismatch",
    note: "The visible link text is a full, believable URL. The href goes somewhere else. This is the oldest trick in the book and it still works, because almost nobody hovers. Open this one in a browser-based client and try to spot it by eye first.",
    build: () =>
      html({
        headers: [
          ...received("smtp.delivery-notice-88.example", "203.0.113.55"),
          authResults("pass", "pass", "pass", "delivery-notice-88.example"),
          "Return-Path: <alerts@delivery-notice-88.example>",
          "From: Online Banking <alerts@delivery-notice-88.example>",
          "To: recipient@recipient.example",
          "Subject: Statement ready to view",
          "Date: Tue, 18 Aug 2026 09:14:18 +0100",
          "Message-ID: <20260818081418.2a6b8@delivery-notice-88.example>",
        ],
        text: "Your statement is ready. Sign in to view it.",
        htmlBody: [
          "<html><body>",
          "<p>Your statement is ready.</p>",
          '<p><a href="https://sess-4471.tracking-hop-19.example/r?u=9f2">',
          "https://www.northgate-bank.example/online/statements</a></p>",
          "</body></html>",
        ].join("\r\n"),
      }),
  },

  // ---------------------------------------------------------- attachments
  {
    file: "10-executable-attachment.eml",
    signal: "dangerous_attachment",
    note: "An .exe arriving by mail. Obvious when written down, still the top delivery mechanism for commodity malware. The check is a list of extensions Windows will happily run.",
    build: () =>
      withAttachment({
        headers: [
          ...received("smtp.invoicing-4471.example", "192.0.2.77"),
          authResults("pass", "pass", "pass", "invoicing-4471.example"),
          "Return-Path: <invoices@invoicing-4471.example>",
          "From: Invoicing <invoices@invoicing-4471.example>",
          "To: accounts@recipient.example",
          "Subject: Invoice 29481 attached",
          "Date: Tue, 18 Aug 2026 09:14:18 +0100",
          "Message-ID: <20260818081418.4f1d9@invoicing-4471.example>",
        ],
        text: "Please find invoice 29481 attached.\r\n",
        filename: "invoice_29481.exe",
        mimeType: "application/octet-stream",
        bytes: HARMLESS,
      }),
  },
  {
    file: "11-rtl-override-filename.eml",
    signal: "rtl_override_filename (plus dangerous_attachment)",
    note: 'The filename contains U+202E, which flips the display of everything after it. Most file listings render this as "annexe.exe.pdf" while the actual extension is .exe. Two signals fire here rather than one — real messages rarely trip exactly one check, and that is the point of the control sample.',
    build: () =>
      withAttachment({
        headers: [
          ...received("smtp.docs-transfer-30.example", "198.51.100.12"),
          authResults("pass", "pass", "pass", "docs-transfer-30.example"),
          "Return-Path: <documents@docs-transfer-30.example>",
          "From: Document Transfer <documents@docs-transfer-30.example>",
          "To: recipient@recipient.example",
          "Subject: Signed contract enclosed",
          "Date: Tue, 18 Aug 2026 09:14:18 +0100",
          "Message-ID: <20260818081418.7c3e4@docs-transfer-30.example>",
        ],
        text: "The signed contract is attached.\r\n",
        // U+202E between "annexe" and "fdp.exe". Sent as an encoded-word, which
        // is both what the RFCs require for a non-ASCII parameter and what real
        // samples use — grepping the raw file for the character finds nothing.
        filename: "annexe‮fdp.exe",
        encodeFilename: true,
        mimeType: "application/octet-stream",
        bytes: HARMLESS,
      }),
  },
  {
    file: "12-attachment-type-mismatch.eml",
    signal: "attachment_type_mismatch",
    note: 'Declared as application/pdf, named .pdf, and the first two bytes are "MZ" — a Windows executable. The extension and the MIME type are both attacker-controlled; the bytes are not. Checking eight bytes catches what neither of the other two can.',
    build: () =>
      withAttachment({
        headers: [
          ...received("smtp.remittance-sender.example", "203.0.113.31"),
          authResults("pass", "pass", "pass", "remittance-sender.example"),
          "Return-Path: <payments@remittance-sender.example>",
          "From: Payments <payments@remittance-sender.example>",
          "To: accounts@recipient.example",
          "Subject: Remittance advice",
          "Date: Tue, 18 Aug 2026 09:14:18 +0100",
          "Message-ID: <20260818081418.9b8a5@remittance-sender.example>",
        ],
        text: "Remittance advice attached.\r\n",
        filename: "remittance_advice.pdf",
        mimeType: "application/pdf",
        bytes: PE_HEADER,
      }),
  },
];

mkdirSync(OUT, { recursive: true });

const index = [
  "# Synthetic samples",
  "",
  "Generated by `tools/make-samples.mjs`. **Every message here is invented**, and",
  "every domain uses the reserved `.example` TLD (RFC 2606), which cannot be",
  "registered — so nothing here points at a real organisation.",
  "",
  "These are MIT licensed, unlike the Phishing Pot corpus in",
  "`samples/phishing_pot` (CC BY-NC 4.0), so you can copy them into your own",
  "project. They are also only a few kilobytes, so the workshop works even if the",
  "submodule never downloaded.",
  "",
  "Each file is built to trip **one** check, so you can read the `.eml`, predict",
  "what the tool will say, and see whether you were right. Real phishing trips",
  "five at once and teaches you nothing about any of them individually.",
  "",
  "| File | Signal | What to look at |",
  "|---|---|---|",
];

for (const s of SAMPLES) {
  writeFileSync(join(OUT, s.file), s.build(), "utf8");
  index.push(`| \`${s.file}\` | \`${s.signal}\` | ${s.note} |`);
}

index.push(
  "",
  "Try the control first:",
  "",
  "```bash",
  "node tools/triage-cli.mjs samples/synthetic/01-clean-newsletter.eml",
  "```",
  "",
  "It should report nothing. A triage tool that flags everything is worse than",
  "no tool at all, because people stop reading it.",
  "",
);

writeFileSync(join(OUT, "README.md"), index.join("\n"), "utf8");
console.log(`Wrote ${SAMPLES.length} samples + README.md to samples/synthetic/`);

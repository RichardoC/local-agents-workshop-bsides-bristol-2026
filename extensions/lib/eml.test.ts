/**
 * Tests for the parser and signal detection.
 *
 * Run with:  npm test
 * (which is just `node --experimental-strip-types --test` — no test framework,
 * no build step, no install.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEmail, parseHeaders, decodeEncodedWords, parseAddress } from "./eml.ts";
import { triage, editDistance, registrableDomain, extractHtmlLinks } from "./signals.ts";

const CRLF = "\r\n";

function buildEml(headers: string[], body: string): Buffer {
  return Buffer.from(headers.join(CRLF) + CRLF + CRLF + body, "utf8");
}

test("unfolds folded headers", () => {
  const headers = parseHeaders(
    ["Subject: a very" + CRLF + "  long subject", "From: a@b.com"].join(CRLF),
  );
  // Two spaces, not one: RFC 5322 s.2.2.3 unfolding removes the CRLF and KEEPS
  // the folding whitespace. Collapsing it to a single space reads more nicely
  // but corrupts any value folded mid-token — a Content-Type boundary
  // containing whitespace then matches nothing and the whole body is lost.
  assert.equal(headers[0].value, "a very  long subject");
  assert.equal(headers.length, 2);
});

test("decodes RFC 2047 encoded words", () => {
  assert.equal(decodeEncodedWords("=?UTF-8?B?UGF5UGFs?="), "PayPal");
  assert.equal(decodeEncodedWords("=?utf-8?Q?Pay=50al?="), "PayPal");
  assert.equal(decodeEncodedWords("plain text"), "plain text");
});

test("parses addresses in all the usual shapes", () => {
  assert.deepEqual(parseAddress('"Bank" <a@b.co.uk>'), {
    display: "Bank",
    address: "a@b.co.uk",
    domain: "b.co.uk",
  });
  assert.equal(parseAddress("bare@example.com").address, "bare@example.com");
  assert.equal(parseAddress(undefined).domain, "");
});

test("registrable domain handles multi-part suffixes", () => {
  assert.equal(registrableDomain("a.b.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("mail.example.com"), "example.com");
  assert.equal(registrableDomain("example.com"), "example.com");
});

test("edit distance", () => {
  assert.equal(editDistance("paypal", "paypa1"), 1);
  assert.equal(editDistance("paypal", "paypal"), 0);
});

test("extracts href and anchor text", () => {
  const links = extractHtmlLinks(
    `<a href="https://evil.example/x">www.paypal.com</a>`,
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].hostname, "evil.example");
  assert.equal(links[0].text, "www.paypal.com");
});

test("punycode homoglyph is detected via the URL parser", () => {
  // The 'a' in the middle here is Cyrillic U+0430, not Latin 'a'.
  const links = extractHtmlLinks(`<a href="http://pа-ypal.com/login">click</a>`);
  assert.ok(links[0].hostname.includes("xn--"));
});

test("end to end: a spoofed message raises the expected signals", () => {
  const eml = buildEml(
    [
      "Received: from mx.example.net (mx.example.net [203.0.113.9]) by mail.corp.example",
      "Authentication-Results: mx.corp.example; spf=fail; dkim=none; dmarc=fail",
      "From: =?UTF-8?B?UGF5UGFs?= <service@paypa1-secure.com>",
      "Reply-To: collect@mail.ru",
      "Subject: Your account has been limited",
      "Date: Tue, 18 Aug 2026 09:14:00 +0100",
      "Content-Type: text/html; charset=utf-8",
    ],
    `<html><body><a href="https://paypal.com.secure-login.ru/verify">https://www.paypal.com</a></body></html>`,
  );

  const result = triage(parseEmail(eml));
  const ids = result.signals.map((s) => s.id);

  assert.equal(result.from.display, "PayPal");
  assert.equal(result.from.domain, "paypa1-secure.com");
  assert.equal(result.auth.spf, "fail");
  assert.equal(result.hops, 1);

  assert.ok(ids.includes("reply_to_mismatch"), "expected reply_to_mismatch");
  assert.ok(ids.includes("dmarc_fail"), "expected dmarc_fail");
  assert.ok(ids.includes("href_text_mismatch"), "expected href_text_mismatch");
  assert.ok(
    ids.includes("brand_in_subdomain") || ids.includes("lookalike_domain"),
    "expected brand impersonation to be flagged",
  );
});

test("a legitimate message stays quiet", () => {
  const eml = buildEml(
    [
      "Received: from mx.example.com (mx.example.com [198.51.100.4]) by mail.corp.example",
      "Authentication-Results: mx.corp.example; spf=pass; dkim=pass; dmarc=pass",
      "From: Alice Chen <alice@example.com>",
      "Subject: Notes from Tuesday",
      "Date: Tue, 18 Aug 2026 09:14:00 +0100",
      "Content-Type: text/plain; charset=utf-8",
    ],
    "Here are the notes we discussed. See https://example.com/notes for the full text.",
  );

  const result = triage(parseEmail(eml));
  const high = result.signals.filter((s) => s.severity === "high");
  assert.deepEqual(high, [], `expected no high-severity signals, got ${JSON.stringify(high)}`);
});

test("multipart with a disguised attachment", () => {
  const boundary = "b0undary";
  const body = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please see the attached invoice.",
    `--${boundary}`,
    'Content-Type: application/pdf; name="invoice.pdf.exe"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="invoice.pdf.exe"',
    "",
    Buffer.from("MZ\x90\x00this is not a pdf", "latin1").toString("base64"),
    `--${boundary}--`,
  ].join(CRLF);

  const eml = buildEml(
    [
      "From: Accounts <billing@example.com>",
      "Subject: Invoice 4432",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ],
    body,
  );

  const result = triage(parseEmail(eml));
  const ids = result.signals.map((s) => s.id);

  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].filename, "invoice.pdf.exe");
  assert.ok(ids.includes("dangerous_attachment"), "expected dangerous_attachment");
  assert.ok(ids.includes("double_extension"), "expected double_extension");
  assert.ok(ids.includes("attachment_type_mismatch"), "expected attachment_type_mismatch");
});

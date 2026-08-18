/**
 * Extra tests for the parser and the signal layer.
 *
 * `eml.test.ts` covers the happy paths. This file covers the edges that a real
 * inbox hits — the ones where a parser quietly returns the wrong answer instead
 * of throwing, which is the failure mode that matters in security tooling.
 *
 * Run with:  npm test
 *
 * Two kinds of test live here:
 *
 *   1. Plain `test(...)` — behaviour that is correct today. These are
 *      regression locks: if someone "simplifies" the parser, these break.
 *   2. `test(..., { skip: ... })` — behaviour that is WRONG today, with the
 *      assertion written for the CORRECT answer. Each one is an executable bug
 *      report. They are skipped so `npm test` stays green: delete the skip
 *      option to watch it fail, and delete it for good once the code is fixed.
 *
 * Every skipped test here has a matching entry in the code review notes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { parseEmail, parseHeaders, decodeEncodedWords, parseAddress, parseAuthResults } from "./eml.ts";
import { triage, registrableDomain, editDistance, extractHtmlLinks, extractTextLinks } from "./signals.ts";

const CRLF = "\r\n";

function buildEml(headers: string[], body: string): Buffer {
  return Buffer.from(headers.join(CRLF) + CRLF + CRLF + body, "utf8");
}

function signalIds(headers: string[], body: string): string[] {
  return triage(parseEmail(buildEml(headers, body))).signals.map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Regression locks — correct behaviour today
// ---------------------------------------------------------------------------

test("bare-LF messages parse as well as CRLF ones", () => {
  const lf = Buffer.from("From: a@example.com\nSubject: hi\n\nbody text\n", "utf8");
  const p = parseEmail(lf);
  assert.equal(p.headers.length, 2);
  assert.equal(p.text.trim(), "body text");
});

test("a header block with no body at all does not throw", () => {
  const p = parseEmail(Buffer.from("From: a@example.com\r\nSubject: hi", "utf8"));
  assert.equal(p.headers.length, 2);
  assert.equal(p.text.trim(), "");
});

test("tab-indented continuation lines unfold, keeping the tab", () => {
  // The folding whitespace here is a TAB, and unfolding preserves it rather
  // than normalising it to a space (RFC 5322 s.2.2.3). Callers that want a
  // display-friendly form should collapse whitespace themselves; the parser's
  // job is to reproduce the value a byte at a time, because Content-Type
  // parameters depend on it.
  const h = parseHeaders(["Subject: first", "\tsecond"].join(CRLF));
  assert.equal(h[0].value, "first\tsecond");
});

test("repeated headers are all retained, in order", () => {
  const p = parseEmail(buildEml(["Received: hop-two", "Received: hop-one", "From: a@example.com"], "x"));
  assert.equal(triage(p).hops, 2);
  assert.equal(p.headers.filter((h) => h.name === "received")[0].value, "hop-two");
});

test("nested multipart/alternative inside multipart/mixed yields every leaf", () => {
  const p = parseEmail(
    buildEml(["From: a@example.com", 'Content-Type: multipart/mixed; boundary="OUT"'],
      [
        "--OUT", 'Content-Type: multipart/alternative; boundary="IN"', "",
        "--IN", "Content-Type: text/plain", "", "plain version",
        "--IN", "Content-Type: text/html", "", "<p>html version</p>",
        "--IN--",
        "--OUT", 'Content-Type: application/pdf; name="a.pdf"', "", "%PDF-1.4 x",
        "--OUT--",
      ].join(CRLF)),
  );
  assert.match(p.text, /plain version/);
  assert.match(p.html, /html version/);
  assert.deepEqual(p.attachments.map((a) => a.filename), ["a.pdf"]);
});

test("a multipart message with no terminating boundary still yields its parts", () => {
  const p = parseEmail(
    buildEml(["From: a@example.com", 'Content-Type: multipart/mixed; boundary="XX"'],
      ["--XX", "Content-Type: text/plain", "", "truncated in transit"].join(CRLF)),
  );
  assert.match(p.text, /truncated in transit/);
});

test("quoted-printable decodes multi-byte UTF-8 and soft line breaks", () => {
  const p = parseEmail(
    buildEml(["From: a@example.com", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable"],
      "caf=C3=A9 and a soft=" + CRLF + "break"),
  );
  assert.match(p.text, /café and a softbreak/);
});

test("Content-Transfer-Encoding is matched case-insensitively", () => {
  const p = parseEmail(
    buildEml(["From: a@example.com", "Content-Type: text/plain", "Content-Transfer-Encoding: Base64"], "aGVsbG8="),
  );
  assert.equal(p.text.trim(), "hello");
});

test("an unknown charset falls back rather than throwing", () => {
  assert.equal(decodeEncodedWords("=?x-not-a-charset?B?SGVsbG8=?="), "Hello");
});

test("an attacker-supplied Authentication-Results lower in the block loses to the real one", () => {
  // Each hop prepends its own header, so the topmost is the receiving server's.
  const h = parseHeaders([
    "Authentication-Results: real.mx; spf=fail; dkim=fail; dmarc=fail",
    "Authentication-Results: forged-by-sender; spf=pass; dkim=pass; dmarc=pass",
  ].join(CRLF));
  assert.equal(parseAuthResults(h).dmarc, "fail");
});

test("a message with no Authentication-Results is marked absent, not passing", () => {
  const a = parseAuthResults(parseHeaders("From: a@example.com"));
  assert.equal(a.absent, true);
  assert.equal(a.spf, "");
});

test("a link host that is a bare IP address does not crash registrableDomain", () => {
  assert.doesNotThrow(() => registrableDomain("203.0.113.9"));
  assert.doesNotThrow(() => registrableDomain(""));
});

test("bare URLs in a plain-text body are extracted", () => {
  const links = extractTextLinks("see https://example.com/a and http://other.example/b, thanks");
  assert.deepEqual(links.map((l) => l.hostname), ["example.com", "other.example"]);
});

test("anchor text is flattened past nested markup", () => {
  const l = extractHtmlLinks(`<a href="https://a.example"><img src="x"> Click <b>here</b> </a>`);
  assert.equal(l[0].text, "Click here");
});

test("a legitimate transactional message raises no high-severity signal", () => {
  const ids = signalIds(
    [
      "Received: from mx.example.com by mail.corp.example; Tue, 18 Aug 2026 09:00:00 +0100",
      "Authentication-Results: mx.corp.example; spf=pass; dkim=pass; dmarc=pass",
      "From: Bristol Cycling Club <news@bristolcycling.org.uk>",
      "Reply-To: news@bristolcycling.org.uk",
      "Subject: Saturday ride",
      "List-Unsubscribe: <https://bristolcycling.org.uk/u>",
      "Content-Type: text/html; charset=utf-8",
    ],
    `<p>Meet at nine.</p><a href="https://bristolcycling.org.uk/rides">See the rides</a>`,
  );
  assert.deepEqual(ids, [], `expected silence, got ${JSON.stringify(ids)}`);
});

// ---------------------------------------------------------------------------
// Executable bug reports — assertions written for the CORRECT answer
// ---------------------------------------------------------------------------

test("RFC 2047: whitespace between adjacent encoded-words is dropped", () => {
  // RFC 2047 s.6.2 — linear whitespace separating two encoded-words is not
  // part of the text. Today each word is decoded independently and the space
  // survives, giving "Hello  World".
  assert.equal(decodeEncodedWords("=?utf-8?B?SGVsbG8g?= =?utf-8?B?V29ybGQ=?="), "Hello World");
});

test("RFC 2047: a multi-byte character split across adjacent encoded-words rejoins", () => {
  // Long non-ASCII subjects get folded at 75 chars, routinely mid-character.
  // Decoding each word on its own turns the two halves into U+FFFD.
  assert.equal(decodeEncodedWords("=?utf-8?Q?caf=C3?= =?utf-8?Q?=A9?="), "café");
});

test("a quoted display name containing an addr-spec does not become the sender", () => {
  // "Bob <bob@bigbank.co.uk>" is the DISPLAY NAME; the real sender is the
  // addr-spec in the outer angle brackets. Today the regex matches the inner
  // pair, so the tool reports the spoofed-but-reassuring address as the sender
  // and display_name_is_different_address never fires.
  const a = parseAddress('"Bob Smith <bob@bigbank.co.uk>" <attacker@evil.example>');
  assert.equal(a.address, "attacker@evil.example");
  assert.equal(a.domain, "evil.example");
});

test("a header with several addresses does not silently take the last one", () => {
  // Reply-To with two addresses is legal and common. `lastIndexOf("@")` over
  // the whole unsplit value makes the domain whichever address came last, so
  // "Reply-To: harvest@evil.ru, real@example.com" looks clean.
  const a = parseAddress("harvest@evil.ru, real@example.com");
  assert.equal(a.domain, "evil.ru");
});

test("a MIME boundary is only a delimiter at the start of a line", () => {
  // RFC 2046 s.5.1.1: the delimiter is CRLF + "--" + boundary. Splitting on
  // the boundary anywhere truncates a body that merely mentions it.
  const p = parseEmail(
    buildEml(["From: a@example.com", 'Content-Type: multipart/mixed; boundary="XX"'],
      ["--XX", "Content-Type: text/plain", "", "a line that mentions --XX in prose", "and keeps going", "--XX--"].join(CRLF)),
  );
  assert.match(p.text, /and keeps going/);
});

test("unfolding a header does not inject whitespace into a folded token", () => {
  // RFC 5322 s.2.2.3: unfolding removes the CRLF and keeps the WSP. Replacing
  // the fold with a single space corrupts any value folded mid-token — here the
  // boundary no longer matches and the entire body is lost, silently.
  // Two leading spaces on the continuation. Unfolding keeps both, so the real
  // boundary is "longBoundary  Value123". The old code collapsed them to one and
  // the delimiter then matched nothing — losing the entire body, silently.
  const raw = Buffer.from(
    ["From: a@example.com", 'Content-Type: multipart/mixed; boundary="longBoundary', '  Value123"'].join(CRLF) +
      CRLF + CRLF +
      ["--longBoundary  Value123", "Content-Type: text/plain", "", "the body", "--longBoundary  Value123--"].join(CRLF),
    "utf8",
  );
  assert.match(parseEmail(raw).text, /the body/);
});

test("the reported sha256 is the sha256 of the attachment, not of the MIME chunk", () => {
  // A non-base64 part keeps the CRLF that belongs to the following delimiter,
  // so `bytes` is two too many and the hash does not match the real file — the
  // hash an analyst would paste into a reputation service.
  const payload = "%PDF-1.4 hello";
  const p = parseEmail(
    buildEml(["From: a@example.com", 'Content-Type: multipart/mixed; boundary="XX"'],
      ["--XX", 'Content-Type: application/pdf; name="a.pdf"', "Content-Transfer-Encoding: 8bit",
       'Content-Disposition: attachment; filename="a.pdf"', "", payload, "--XX--"].join(CRLF)),
  );
  assert.equal(p.attachments[0].bytes, payload.length);
  assert.equal(p.attachments[0].sha256, createHash("sha256").update(Buffer.from(payload, "latin1")).digest("hex"));
});

test("an inline text/plain part with a name= parameter stays part of the body", () => {
  // `part.filename !== ""` is treated as proof of an attachment, but a name=
  // parameter on an inline text part is legal. The body then vanishes from
  // .text and every text-based check silently sees an empty message.
  const p = parseEmail(buildEml(["From: a@example.com", 'Content-Type: text/plain; name="notes.txt"'], "the actual message"));
  assert.match(p.text, /the actual message/);
  assert.equal(p.attachments.length, 0);
});

test("Authentication-Results keys are not harvested from a hyphenated prefix", () => {
  // `\bspf=` matches inside "receiver-spf=" because "-" is a word boundary.
  const a = parseAuthResults(parseHeaders("Authentication-Results: mx; receiver-spf=fail; dkim=pass; dmarc=pass"));
  assert.equal(a.spf, "");
});

test("a dkim=fail is not hidden by an earlier dkim=pass on another signature", () => {
  const a = parseAuthResults(parseHeaders("Authentication-Results: mx; dkim=pass header.i=@a.com; dkim=fail header.i=@b.com; spf=pass; dmarc=pass"));
  assert.equal(a.dkim, "fail");
});

test("brand_in_subdomain does not fire on the brand's own infrastructure", () => {
  // 890 of 1038 hits on the 8,614-message corpus are this: googleapis.com,
  // onmicrosoft.com and amazonaws.com are Google's, Microsoft's and Amazon's
  // own hostnames. A HIGH signal on a legitimate S3 download link is the most
  // likely way this tool embarrasses someone in front of a room.
  const ids = signalIds(
    ["Authentication-Results: mx; spf=pass; dkim=pass; dmarc=pass", "From: Acme Billing <billing@acme.example>", "Content-Type: text/html"],
    `<a href="https://acme-invoices.s3.eu-west-2.amazonaws.com/2026-03.pdf">Download your invoice</a>`,
  );
  assert.deepEqual(ids, []);
});

test("brand_in_subdomain requires the brand to be in a SUBDOMAIN", () => {
  // The check tests the whole hostname, so any registrable label that merely
  // contains a brand as a substring fires: metamask.io, appledger.live,
  // googleapis.com. The signal's own detail text contradicts itself.
  const ids = signalIds(["From: MetaMask <no-reply@metamask.io>", "Authentication-Results: mx; spf=pass; dkim=pass; dmarc=pass"], "hello");
  assert.ok(!ids.includes("brand_in_subdomain"), JSON.stringify(ids));
});

test("lookalike_domain does not fire on unrelated real companies", () => {
  // shopify.com is 2 edits from "spotify", ripple.com 2 from "apple",
  // coingate.com 2 from "coinbase", money.com 2 from "monzo". 17 of the 25
  // corpus hits are of this kind.
  for (const domain of ["shopify.com", "ripple.com", "coingate.com", "money.com", "teamz.com.au"]) {
    const ids = signalIds([`From: X <a@${domain}>`, "Authentication-Results: mx; spf=pass; dkim=pass; dmarc=pass"], "hello");
    assert.ok(!ids.includes("lookalike_domain"), `${domain} -> ${JSON.stringify(ids)}`);
  }
  // ...while a real one-character swap still fires.
  assert.ok(
    signalIds(["From: X <a@paypa1.com>", "Authentication-Results: mx; spf=pass; dkim=pass; dmarc=pass"], "hi").includes("lookalike_domain"),
  );
});

test("checkBrand reports every brand signal for a host, not just the first", () => {
  // The loop used to `return` on the first match, so a host that both name-drops
  // one brand and typo-squats another only ever reported one of them.
  //
  // This was written as microsoft-login.appl3.com, but "apple" is five
  // characters and the lookalike check now ignores brands shorter than six —
  // measured, because at four or five characters every corpus hit was an
  // unrelated real domain. "paypa1" vs "paypal" exercises the same property
  // with a brand long enough for edit distance to mean anything.
  const ids = signalIds(["From: IT <admin@microsoft-login.paypa1.com>"], "hello");
  assert.ok(ids.includes("brand_in_subdomain"), JSON.stringify(ids));
  assert.ok(ids.includes("lookalike_domain"), JSON.stringify(ids));
});

test("application/octet-stream is not treated as a type claim", () => {
  // octet-stream means "unknown bytes". 22 of the 24 attachment_type_mismatch
  // hits on the corpus are a genuine PDF honestly sent as octet-stream.
  const ids = signalIds(
    ["From: a@example.com", 'Content-Type: multipart/mixed; boundary="XX"'],
    ["--XX", 'Content-Type: application/octet-stream; name="report.pdf"', "Content-Transfer-Encoding: base64",
     'Content-Disposition: attachment; filename="report.pdf"', "",
     Buffer.from("%PDF-1.7 a genuine pdf", "latin1").toString("base64"), "--XX--"].join(CRLF),
  );
  assert.ok(!ids.includes("attachment_type_mismatch"), JSON.stringify(ids));
});

test("a trailing dot is not a double extension", () => {
  const ids = signalIds(
    ["From: a@example.com", 'Content-Type: multipart/mixed; boundary="XX"'],
    ["--XX", "Content-Type: image/png", 'Content-Disposition: attachment; filename="holiday.png."', "", "x", "--XX--"].join(CRLF),
  );
  assert.ok(!ids.includes("double_extension"), JSON.stringify(ids));
});

test("HTML entities in an href are decoded before the URL is parsed", () => {
  // 105 corpus messages fire punycode_link on a hostname like "xn--rzj&-9pa",
  // which is not a hostname at all — it is undecoded entity soup, and the real
  // host is never examined.
  const l = extractHtmlLinks(`<a href="https://example.com/?a=1&amp;b=2">x</a>`);
  assert.equal(l[0].href, "https://example.com/?a=1&b=2");
});

test("an anchor with no closing tag is still a link", () => {
  // Real bulk mail leaves anchors unterminated. The regex requires </a>, so
  // the link — and every check that depends on it — disappears.
  assert.equal(extractHtmlLinks(`<a href="https://evil.example/login">Sign in`).length, 1);
});

test("registrableDomain separates two sites on a shared hosting suffix", () => {
  // github.io, pages.dev, vercel.app, firebaseapp.com and web.app are in the
  // Public Suffix List's private section — free hosting, and where a lot of
  // phishing lives. Treating them as registrable makes every site on them look
  // like the same organisation, so the mismatch checks go quiet.
  assert.notEqual(registrableDomain("alice.github.io"), registrableDomain("attacker.github.io"));
  const ids = signalIds(["From: Alice <alice@alice.github.io>", "Reply-To: attacker@evil-actor.github.io"], "hi");
  assert.ok(ids.includes("reply_to_mismatch"), JSON.stringify(ids));
});

test("editDistance returns a real distance rather than a sentinel", () => {
  // The length-delta guard returns the magic number 99, which is a distance a
  // caller can accidentally compare against. Cap explicitly or return null.
  assert.equal(editDistance("abc", "abcdefg"), 4);
});

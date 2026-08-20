/**
 * Tests for the verdict/gloss layer.
 *
 * These pin down behaviour that was chosen in response to measured model
 * failures, so they are regression tests in the real sense: if someone
 * "simplifies" the glossing back to raw tokens, the hallucination class it was
 * added to prevent comes back.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { assess, glossAuthVerdict } from "./verdict.ts";
import type { Signal } from "./signals.ts";

const sig = (severity: Signal["severity"], id = "x"): Signal => ({
  id,
  severity,
  detail: "detail",
});

test("pass and fail stay short and unambiguous", () => {
  assert.equal(glossAuthVerdict("pass"), "pass");
  assert.equal(glossAuthVerdict("FAIL"), "FAIL");
});

test("the not-a-failure verdicts say so explicitly", () => {
  // This is the fix for the dominant measured hallucination: the model read
  // `none` and `permerror` as failures, and sometimes as passes.
  for (const v of ["none", "permerror", "temperror", "neutral"]) {
    const out = glossAuthVerdict(v);
    assert.ok(out.includes("not a failure"), `${v} should be marked not-a-failure, got: ${out}`);
  }
});

test("softfail is marked as a weak failure, not a pass", () => {
  const out = glossAuthVerdict("softfail");
  assert.ok(out.includes("failure"));
  assert.ok(!out.includes("not a failure"));
});

test("bestguesspass is not presented as authoritative", () => {
  assert.ok(glossAuthVerdict("bestguesspass").includes("not authoritative"));
});

test("an unknown verdict is passed through with a warning, not guessed at", () => {
  const out = glossAuthVerdict("wibble");
  assert.ok(out.startsWith("wibble"));
  assert.ok(out.includes("do not treat as pass or fail"));
});

test("case and whitespace do not matter", () => {
  assert.equal(glossAuthVerdict("  PaSs "), "pass");
});

test("empty verdict renders as a dash", () => {
  assert.equal(glossAuthVerdict(""), "-");
});

test("no signals produces an explicit unremarkable verdict", () => {
  const a = assess([]);
  assert.equal(a.total, 0);
  assert.ok(a.line.includes("unremarkable"));
  // The measured failure was the model inferring risk from the subject line.
  assert.ok(a.line.includes("subject line"));
});

test("a high-severity signal produces a suspicious verdict", () => {
  const a = assess([sig("high")]);
  assert.equal(a.high, 1);
  assert.ok(a.line.includes("1 high-severity indicator"));
  assert.ok(a.line.includes("suspicious"));
});

test("high severity wins even when auth passed and other signals are mild", () => {
  // The inversion this prevents: the model called a HIGH-signal message
  // "likely legitimate" because SPF passed.
  const a = assess([sig("high"), sig("low"), sig("medium")]);
  assert.ok(a.line.includes("suspicious"));
  assert.ok(a.line.includes("2 lower-severity"));
});

test("only low and medium signals are reported as inconclusive", () => {
  const a = assess([sig("low"), sig("medium")]);
  assert.equal(a.high, 0);
  assert.ok(a.line.includes("none high severity"));
  assert.ok(!a.line.includes("suspicious"));
});

test("counts are accurate", () => {
  const a = assess([sig("high"), sig("high"), sig("medium"), sig("low"), sig("low"), sig("low")]);
  assert.deepEqual([a.high, a.medium, a.low, a.total], [2, 1, 3, 6]);
});

test("singular and plural agree", () => {
  assert.ok(assess([sig("high")]).line.includes("indicator —"));
  assert.ok(assess([sig("high"), sig("high")]).line.includes("indicators"));
  assert.ok(assess([sig("low")]).line.includes("1 indicator,"));
});

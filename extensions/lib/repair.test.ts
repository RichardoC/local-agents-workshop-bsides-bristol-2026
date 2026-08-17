/**
 * Tests for the tool-argument repair layer.
 *
 * Every "broken" case here is a shape a small model has actually been observed
 * to produce. The negative cases matter just as much as the positive ones: a
 * repair function that accepts anything hides real model failures and invents
 * tool calls nobody asked for.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseLooseJson, repairPathArgs } from "./repair.ts";

const P = "samples/synthetic/04-auth-fail.eml";

test("passes a correct call through untouched", () => {
  const r = repairPathArgs({ path: P });
  assert.deepEqual(r.args, { path: P });
  assert.equal(r.repairs.length, 0, "a valid call should need no repairs");
});

test("renames common aliases to path", () => {
  for (const key of ["file", "filename", "file_path", "eml", "email", "target"]) {
    const r = repairPathArgs({ [key]: P });
    assert.deepEqual(r.args, { path: P }, `alias ${key}`);
    assert.ok(r.repairs.some((s) => s.includes("renamed")));
  }
});

test("accepts a single unknown key with a string value", () => {
  // Unambiguous: there is exactly one thing it could have meant.
  const r = repairPathArgs({ theEmailToLookAt: P });
  assert.deepEqual(r.args, { path: P });
});

test("decodes arguments sent as a JSON string", () => {
  const r = repairPathArgs(JSON.stringify({ path: P }));
  assert.deepEqual(r.args, { path: P });
  assert.ok(r.repairs.some((s) => s.includes("JSON string")));
});

test("wraps a bare path string", () => {
  const r = repairPathArgs(P);
  assert.deepEqual(r.args, { path: P });
});

test("unwraps a single-element array of paths", () => {
  assert.deepEqual(repairPathArgs({ path: [P] }).args, { path: P });
});

test("unwraps nested argument wrappers", () => {
  assert.deepEqual(repairPathArgs({ arguments: { path: P } }).args, { path: P });
  assert.deepEqual(repairPathArgs({ parameters: { file: P } }).args, { path: P });
});

test("stringifies a numeric path", () => {
  const r = repairPathArgs({ path: 42 });
  assert.deepEqual(r.args, { path: "42" });
  assert.ok(r.repairs.some((s) => s.includes("stringified")));
});

test("strips quotes the model left in the value", () => {
  assert.deepEqual(repairPathArgs({ path: `"${P}"` }).args, { path: P });
});

test("drops extra keys but keeps the path", () => {
  const r = repairPathArgs({ path: P, verbose: true, reason: "checking" });
  assert.deepEqual(r.args, { path: P });
  assert.ok(r.repairs.some((s) => s.includes("ignored unexpected key")));
});

// --- The negative cases: repair must not invent a call ----------------------

test("leaves genuinely ambiguous input alone", () => {
  // Two plausible paths and no way to know which was meant.
  const input = { first: "a.eml", second: "b.eml" };
  assert.deepEqual(repairPathArgs(input).args, input);
  assert.equal(repairPathArgs(input).repairs.length, 0);
});

test("leaves an empty object alone", () => {
  assert.deepEqual(repairPathArgs({}).args, {});
});

test("does not treat prose as a path", () => {
  const prose = "please analyse the email for me";
  assert.equal(repairPathArgs(prose).args, prose);
});

test("leaves an empty path alone so the schema can reject it", () => {
  const input = { path: "   " };
  assert.deepEqual(repairPathArgs(input).args, input);
});

test("leaves a multi-element array alone", () => {
  const input = { path: ["a.eml", "b.eml"] };
  assert.deepEqual(repairPathArgs(input).args, input);
});

// --- Loose JSON parsing -----------------------------------------------------

test("parses valid JSON", () => {
  assert.deepEqual(parseLooseJson(`{"path":"${P}"}`), { path: P });
});

test("recovers from a trailing comma", () => {
  assert.deepEqual(parseLooseJson(`{"path":"${P}",}`), { path: P });
});

test("recovers from truncation mid-object", () => {
  // The classic: output hit a token limit part-way through the call.
  assert.deepEqual(parseLooseJson(`{"path": "${P}"`), { path: P });
});

test("recovers from truncation mid-string", () => {
  const out = parseLooseJson(`{"path": "${P}`) as { path?: string };
  assert.equal(out?.path, P);
});

test("returns undefined for input that is not JSON at all", () => {
  assert.equal(parseLooseJson("path=x.eml"), undefined);
  assert.equal(parseLooseJson(""), undefined);
});

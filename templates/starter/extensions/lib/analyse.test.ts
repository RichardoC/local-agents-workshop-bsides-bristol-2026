/**
 * Tests for the deterministic core — no pi, no model, no network.
 *
 * This is the payoff for keeping analyse.ts free of imports: the interesting
 * half of your extension is testable in milliseconds, offline, on any machine.
 * Putting a model in the loop here would make these slow, non-deterministic,
 * and a test of the wrong thing.
 *
 *   npm test
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { analyse } from "./analyse.ts";

test("counts words and lines", () => {
  const r = analyse("hello world\nsecond line here");
  assert.equal(r.words, 5);
  assert.equal(r.lines, 2);
});

test("unique words ignore case", () => {
  const r = analyse("The the THE cat");
  assert.equal(r.words, 4);
  assert.equal(r.uniqueWords, 2);
});

test("finds the longest word", () => {
  assert.equal(analyse("a bb cccc ddd").longestWord, "cccc");
});

test("empty input does not throw", () => {
  const r = analyse("");
  assert.equal(r.words, 0);
  assert.equal(r.longestWord, "");
});

test("collapses runs of whitespace", () => {
  // A naive split(" ") gets this wrong, which is exactly the sort of thing
  // worth pinning down before building anything on top of it.
  assert.equal(analyse("a   b\t\tc\n\nd").words, 4);
});

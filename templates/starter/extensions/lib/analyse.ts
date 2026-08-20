/**
 * The deterministic core. This is where your real work goes.
 *
 * Note what this file does NOT import: no pi, no typebox, nothing but Node
 * built-ins. That is deliberate and it is the most useful habit to take from
 * this workshop.
 *
 *   - It is testable with plain `node --test`, in milliseconds, offline.
 *   - It runs anywhere: a CI job, a script, someone else's tool.
 *   - It keeps working when the model server does not.
 *
 * (There is a practical reason too. pi bundles `typebox`, so an extension can
 * import it with nothing installed — but bare Node cannot resolve it. Import
 * typebox in this file and `npm test` stops working.)
 *
 * Keep functions here pure: data in, data out. Do the file reading and the pi
 * plumbing one level up, in my-tool.ts.
 */

export interface Analysis {
  lines: number;
  words: number;
  uniqueWords: number;
  longestWord: string;
}

export function analyse(text: string): Analysis {
  const words = text.split(/\s+/).filter(Boolean);
  const unique = new Set(words.map((w) => w.toLowerCase()));

  return {
    lines: text.split("\n").length,
    words: words.length,
    uniqueWords: unique.size,
    longestWord: words.reduce((a, b) => (b.length > a.length ? b : a), ""),
  };
}

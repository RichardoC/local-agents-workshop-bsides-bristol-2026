// Detect degenerate repetition in generated text.
//
// The failure being measured is the model emitting the same ~30-word phrase over
// and over ("Next I'm going to X. Next I'm going to X. ..."). Turn counts and
// wall-clock cannot see this at all; only the text can.
//
// Usage:  node repetition.mjs <file>     (or pipe text on stdin)
// Prints a JSON object of metrics.

import { readFileSync } from "node:fs";

export function analyse(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const total = words.length;

  if (total < 20) {
    return {
      words: total,
      loopScore: 0,
      worstPhrase: null,
      worstRepeats: 0,
      worstPhraseWords: 0,
      distinctRatio: 1,
      verdict: "too short to judge",
    };
  }

  // For each phrase length, find the phrase repeated most often.
  let worst = { repeats: 0, phrase: null, n: 0, covered: 0 };

  for (let n = 5; n <= 40 && n <= Math.floor(total / 2); n++) {
    const counts = new Map();
    for (let i = 0; i + n <= words.length; i++) {
      const key = words
        .slice(i, i + n)
        .join(" ")
        .toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [phrase, repeats] of counts) {
      if (repeats < 2) continue;
      const covered = repeats * n; // words accounted for by this phrase
      if (covered > worst.covered) {
        worst = { repeats, phrase, n, covered };
      }
    }
  }

  // Fraction of the output taken up by the single most repeated phrase.
  const loopScore = Math.min(1, worst.covered / total);

  // Global lexical diversity over 8-grams: low means the text churns.
  const grams = new Set();
  const gramN = 8;
  let gramTotal = 0;
  for (let i = 0; i + gramN <= words.length; i++) {
    grams.add(words.slice(i, i + gramN).join(" ").toLowerCase());
    gramTotal++;
  }
  const distinctRatio = gramTotal > 0 ? grams.size / gramTotal : 1;

  let verdict = "clean";
  if (worst.repeats >= 3 && worst.n >= 8) verdict = "*** LOOPING ***";
  else if (loopScore > 0.3) verdict = "*** LOOPING ***";
  else if (worst.repeats >= 2 && worst.n >= 15) verdict = "** repetitive **";
  else if (distinctRatio < 0.7) verdict = "** repetitive **";

  return {
    words: total,
    loopScore: Number(loopScore.toFixed(3)),
    worstPhrase: worst.phrase ? worst.phrase.slice(0, 120) : null,
    worstRepeats: worst.repeats,
    worstPhraseWords: worst.n,
    distinctRatio: Number(distinctRatio.toFixed(3)),
    verdict,
  };
}

// Only act as a CLI when run directly - importing this module must not read stdin.
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  const text = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
  console.log(JSON.stringify(analyse(text)));
}

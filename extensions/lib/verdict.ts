/**
 * Turn signals and raw auth tokens into language a small model cannot misread.
 *
 * Both functions here exist because of measured model failures, not theory.
 * Stress-testing Bonsai-8B-Q1_0 over 37 real messages found two dominant error
 * classes, and both were failures of *presentation* rather than of the model:
 *
 *  1. It never saw an overall verdict. render() gave it a signal list and
 *     nothing else, so it supplied its own conclusion from whatever looked
 *     salient — usually the subject line or the auth results. On real messages
 *     that raised zero signals it still said "phishing" 19 times out of 19,
 *     and once called a message with a HIGH signal "likely legitimate" because
 *     SPF passed. The instruction to say "unremarkable" lived only in the
 *     system prompt, hundreds of tokens away from the data.
 *
 *  2. It misread the SPF/DKIM/DMARC vocabulary. `none`, `permerror`,
 *     `temperror` and `bestguesspass` are not failures, but they are not
 *     `pass` either, and the model mapped them onto pass/fail language in both
 *     directions — "does not pass" when all three were `none`, "authenticated
 *     successfully" when SPF was `permerror`.
 *
 * The fix for both is to state the conclusion next to the evidence, in words,
 * rather than emitting bare tokens and hoping. Proximity matters more than
 * instruction for a model this size.
 *
 * No pi imports and no typebox, so `npm test` can load this directly.
 */

import type { Severity, Signal } from "./signals.ts";

/**
 * Explain an SPF/DKIM/DMARC result, marking explicitly whether it is a failure.
 *
 * The parenthetical is the whole point: a bare `none` invites a small model to
 * guess, and it guesses wrong in both directions.
 */
export function glossAuthVerdict(verdict: string): string {
  switch (verdict.toLowerCase().trim()) {
    case "pass":
      return "pass";
    case "fail":
      return "FAIL";
    case "softfail":
      return "softfail (a weak failure)";
    case "neutral":
      return "neutral (the domain asserts nothing — not a failure)";
    case "none":
      return "none (no verdict recorded — not a failure)";
    case "permerror":
      return "permerror (the check itself errored — not a failure)";
    case "temperror":
      return "temperror (the check errored temporarily — not a failure)";
    case "bestguesspass":
      return "bestguesspass (a heuristic pass, not authoritative)";
    case "":
      return "-";
    default:
      // Unknown token: pass it through rather than inventing a meaning for it.
      return `${verdict} (unrecognised verdict — do not treat as pass or fail)`;
  }
}

export interface Assessment {
  high: number;
  medium: number;
  low: number;
  total: number;
  /** One line, written for the model to reuse rather than reinterpret. */
  line: string;
}

/** Count signals by severity and state the overall conclusion in words. */
export function assess(signals: Signal[]): Assessment {
  const count = (s: Severity) => signals.filter((x) => x.severity === s).length;
  const high = count("high");
  const medium = count("medium");
  const low = count("low");
  const total = signals.length;

  let line: string;
  if (total === 0) {
    line =
      "no phishing indicators were found by any check. Describe this message as " +
      "unremarkable unless the user gives you other evidence. Do not infer risk " +
      "from the subject line or sender name alone.";
  } else if (high > 0) {
    line =
      `${high} high-severity indicator${high === 1 ? "" : "s"}` +
      (total > high ? ` (and ${total - high} lower-severity)` : "") +
      " — treat this message as suspicious.";
  } else {
    line =
      `${total} indicator${total === 1 ? "" : "s"}, none high severity — worth ` +
      "noting, but not conclusive on its own.";
  }

  return { high, medium, low, total, line };
}

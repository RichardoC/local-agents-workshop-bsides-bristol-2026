/**
 * Run the triage engine from the command line, with no model and no agent.
 *
 * This exists for two reasons.
 *
 * The practical one: if your model will not start, your laptop is locked down,
 * or the download never finished, you are not stuck watching. The whole
 * deterministic half of this workshop runs here, with nothing but Node. You can
 * write signals, test them, and publish an extension without ever loading a
 * model — the agent is the last mile, not the foundation.
 *
 * The pedagogical one: it makes the split obvious. Everything this program
 * prints was computed without a model. The agent's entire contribution is
 * turning that into a sentence a human wants to read.
 *
 * Usage:
 *   npm run triage -- samples/synthetic/01-clean-newsletter.eml
 *   npm run triage -- samples/synthetic/*.eml
 *   npm run triage -- --json samples/synthetic/04-auth-fail.eml
 */
import { readFileSync } from "node:fs";

import { parseEmail } from "../extensions/lib/eml.ts";
import { triage } from "../extensions/lib/signals.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const paths = args.filter((a) => !a.startsWith("--"));

if (paths.length === 0) {
  console.error("Usage: npm run triage -- <file.eml> [more.eml ...] [--json]");
  console.error("Try:   npm run triage -- samples/synthetic/*.eml");
  process.exit(2);
}

// Only colour when writing to a terminal, so piping to a file stays clean.
const tty = process.stdout.isTTY;
const paint = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => paint("1", s);
const dim = (s: string) => paint("2", s);

const SEVERITY_COLOUR: Record<string, string> = {
  high: "31", // red
  medium: "33", // yellow
  low: "36", // cyan
};

let filesWithSignals = 0;
const collected: unknown[] = [];

for (const path of paths) {
  let result;
  try {
    result = triage(parseEmail(readFileSync(path)));
  } catch (err) {
    console.error(`${path}: ${(err as Error).message}`);
    process.exitCode = 1;
    continue;
  }

  if (asJson) {
    collected.push({ path, ...result });
    continue;
  }

  if (result.signals.length > 0) filesWithSignals++;

  const high = result.signals.filter((s) => s.severity === "high").length;
  const headline =
    result.signals.length === 0
      ? paint("32", "no signals")
      : paint(high > 0 ? "31" : "33", `${result.signals.length} signal(s), ${high} high`);

  console.log(`\n${bold(path)}  ${headline}`);
  console.log(dim(`  subject: ${result.subject || "(none)"}`));
  console.log(
    dim(
      `  from:    ${result.from.address || "(unparseable)"}` +
        (result.from.display ? `  ("${result.from.display}")` : ""),
    ),
  );
  console.log(
    dim(
      result.auth.absent
        ? "  auth:    no Authentication-Results header"
        : `  auth:    spf=${result.auth.spf || "-"} dkim=${result.auth.dkim || "-"} dmarc=${result.auth.dmarc || "-"}`,
    ),
  );

  for (const s of result.signals) {
    const tag = paint(SEVERITY_COLOUR[s.severity] ?? "0", s.severity.toUpperCase().padEnd(6));
    console.log(`  ${tag} ${bold(s.id)}`);
    console.log(`         ${s.detail}`);
  }
}

if (asJson) {
  console.log(JSON.stringify(collected, null, 2));
} else if (paths.length > 1) {
  console.log(
    `\n${bold(`${filesWithSignals}/${paths.length}`)} file(s) raised at least one signal. ` +
      dim("No model was involved in any of this."),
  );
}

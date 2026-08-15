/**
 * pi extension: phishing triage for .eml files.
 *
 * This file is deliberately thin. All the actual work happens in ./lib, which
 * imports nothing but Node built-ins and can be tested without pi running at
 * all (`npm test`).
 *
 * The division of labour is the whole point of the exercise:
 *
 *   lib/eml.ts      parses      - deterministic, exact, no model involved
 *   lib/signals.ts  judges      - deterministic, explainable, no model involved
 *   this file       summarises  - hands ~20 facts to the model and steps back
 *
 * A 4B model asked to parse a Received: chain will invent one. The same model
 * given "SPF fail, Reply-To on a different domain, link text disagrees with
 * href" will write you an accurate, readable verdict. Do the parsing yourself.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { parseEmail } from "./lib/eml.ts";
import { triage, type Triage } from "./lib/signals.ts";

/**
 * Directories to fall back to when a bare filename is given.
 *
 * Small local models routinely drop the directory part of a path — they see
 * "sample-1004.eml" in the conversation and pass that, not the full relative
 * path. Rather than burn a slow round-trip on a retry, resolve the obvious
 * candidates ourselves and say which one we used.
 */
const FALLBACK_DIRS = ["samples/phishing_pot/email", "samples", "."];

function resolveEmlPath(input: string): string | undefined {
  if (existsSync(input) && statSync(input).isFile()) return input;

  const name = basename(input);
  for (const dir of FALLBACK_DIRS) {
    const candidate = join(dir, name);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/**
 * Render the triage result as compact labelled text.
 *
 * Text rather than raw JSON, on purpose: small local models follow labelled
 * lines more reliably than nested JSON, and it costs fewer tokens. The full
 * structured object still goes back in `details` for anything downstream.
 */
function render(t: Triage, path: string): string {
  const lines: string[] = [];

  lines.push(`FILE: ${path}`);
  lines.push(`SUBJECT: ${t.subject || "(none)"}`);
  lines.push(
    `FROM: display="${t.from.display}" address=${t.from.address || "(unparseable)"}`,
  );
  if (t.replyTo.address) lines.push(`REPLY-TO: ${t.replyTo.address}`);
  if (t.returnPath.address) lines.push(`RETURN-PATH: ${t.returnPath.address}`);
  lines.push(`DATE: ${t.date || "(none)"}`);
  lines.push(
    t.auth.absent
      ? "AUTH: no Authentication-Results header present"
      : `AUTH: spf=${t.auth.spf || "-"} dkim=${t.auth.dkim || "-"} dmarc=${t.auth.dmarc || "-"}`,
  );
  lines.push(`RECEIVED HOPS: ${t.hops}`);

  if (t.attachments.length) {
    lines.push("");
    lines.push("ATTACHMENTS:");
    for (const a of t.attachments) {
      lines.push(
        `  - ${a.filename || "(unnamed)"}  type=${a.declaredType}  ${a.bytes} bytes  sha256=${a.sha256.slice(0, 16)}...`,
      );
    }
  }

  const hosts = [...new Set(t.links.map((l) => l.hostname).filter(Boolean))];
  if (hosts.length) {
    lines.push("");
    lines.push(`LINK HOSTS (${hosts.length}): ${hosts.slice(0, 15).join(", ")}`);
  }

  lines.push("");
  if (t.signals.length === 0) {
    lines.push("DETERMINISTIC SIGNALS: none raised.");
  } else {
    lines.push(`DETERMINISTIC SIGNALS (${t.signals.length}):`);
    for (const s of t.signals) {
      lines.push(`  [${s.severity.toUpperCase()}] ${s.id}: ${s.detail}`);
    }
  }

  lines.push("");
  lines.push(
    "NOTE: signals above are facts extracted from the message itself. No DNS, " +
      "WHOIS or reputation lookup was performed, so SPF/DKIM/DMARC values are " +
      "what the receiving server recorded at delivery time, not a re-check.",
  );

  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "phish_triage",
    label: "Phishing triage",
    description:
      "Analyse a .eml email file for phishing indicators. Extracts headers, " +
      "authentication results, links and attachments deterministically, then " +
      "returns the findings for you to interpret. Use this whenever the user " +
      "asks about a suspicious email, or points at a .eml file.",
    promptSnippet: "phish_triage: analyse a .eml file for phishing indicators",
    promptGuidelines: [
      "When the user names a .eml file, call phish_triage with the path exactly as they wrote it.",
      "Base your verdict only on the signals the tool returns. Do not invent header values.",
      "If the tool returns no signals, say the message looks unremarkable rather than inventing concerns.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          "Path to the .eml file to analyse, as the user wrote it (relative to the current directory).",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { path } = params as { path: string };

      const resolved = resolveEmlPath(path);
      if (!resolved) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No such .eml file: ${path}. Give a path relative to the current directory.`,
            },
          ],
          details: { error: "not_found" },
        };
      }

      let raw: Buffer;
      try {
        raw = readFileSync(resolved);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not read ${resolved}: ${(err as Error).message}`,
            },
          ],
          details: { error: "unreadable" },
        };
      }

      const result = triage(parseEmail(raw));
      const note =
        resolved === path ? "" : `\n(Resolved "${path}" to ${resolved}.)`;

      return {
        content: [{ type: "text" as const, text: render(result, resolved) + note }],
        details: result as unknown as Record<string, unknown>,
      };
    },
  });

  pi.registerCommand("phish", {
    description: "Triage a .eml file for phishing indicators",
    handler: async (args: string, ctx: any) => {
      const path = args.trim();
      if (!path) {
        ctx.ui.notify("Usage: /phish <path-to-eml>", "warning");
        return;
      }
      const resolved = resolveEmlPath(path);
      if (!resolved) {
        ctx.ui.notify(`No such .eml file: ${path}`, "error");
        return;
      }
      try {
        const result = triage(parseEmail(readFileSync(resolved)));
        const high = result.signals.filter((s) => s.severity === "high").length;
        ctx.ui.notify(
          `${result.signals.length} signal(s), ${high} high severity — ${result.subject || "(no subject)"}`,
          high > 0 ? "warning" : "info",
        );
      } catch (err) {
        ctx.ui.notify(`Failed: ${(err as Error).message}`, "error");
      }
    },
  });
}

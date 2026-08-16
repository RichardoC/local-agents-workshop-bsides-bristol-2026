/**
 * A starter pi extension. Copy this folder, rename things, make it yours.
 *
 *   cp -r templates/starter ../my-extension
 *   cd ../my-extension
 *   /path/to/pi -e ./extensions/my-tool.ts
 *
 * It works as it stands: `word_count` is a real, if unambitious, tool. Run it,
 * watch the agent call it, then start replacing the middle.
 *
 * This file is deliberately thin — plumbing only. The actual work lives in
 * lib/analyse.ts, which imports nothing and can be tested without pi running
 * at all. That is the one habit worth keeping from the phishing example: the
 * tool does the work deterministically, and the model only explains the result.
 *
 * A small local model asked to count words will guess. Handed a number, it
 * reports it accurately. Push everything you can below the model.
 */

import { readFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { analyse } from "./lib/analyse.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "word_count",
    label: "Word count",

    // Written for the model to read, not for you. Say what it does and when to
    // reach for it; a vague description is the usual reason a tool never fires.
    description:
      "Count lines, words and unique words in a text file. Use this whenever " +
      "the user asks about the size, length or vocabulary of a file.",

    // A one-line reminder injected into the system prompt.
    promptSnippet: "word_count: count lines and words in a text file",

    // Rules that stop a small model going off-piste. Be specific, and few.
    promptGuidelines: [
      "Call word_count with the path exactly as the user wrote it.",
      "Report only the numbers the tool returns. Do not estimate.",
    ],

    parameters: Type.Object({
      path: Type.String({
        description: "Path to the text file, relative to the current directory.",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { path } = params as { path: string };

      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        // Return the error as content rather than throwing: the model can read
        // this, and often recovers by retrying with a corrected path.
        return {
          content: [
            { type: "text" as const, text: `Could not read ${path}: ${(err as Error).message}` },
          ],
          details: { error: "unreadable" },
        };
      }

      const result = analyse(text);

      // Labelled lines rather than JSON. Small local models follow this format
      // noticeably better, and it costs fewer tokens. The structured object
      // still goes back in `details` for anything downstream.
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `FILE: ${path}`,
              `LINES: ${result.lines}`,
              `WORDS: ${result.words}`,
              `UNIQUE WORDS: ${result.uniqueWords}`,
              `LONGEST WORD: ${result.longestWord}`,
            ].join("\n"),
          },
        ],
        details: result,
      };
    },
  });

  /**
   * A slash command running the same core, with no model involved.
   *
   * Worth adding to anything you build. It is how you test the deterministic
   * half quickly, and it keeps working when the model server does not:
   *
   *   pi -e ./extensions/my-tool.ts -p "/wc README.md"
   *
   * Note the ctx.hasUI guard. Every ctx.ui method is a no-op outside the TUI,
   * so without it this command prints absolutely nothing in print or JSON mode
   * — a silent failure, and a self-inflicted one.
   */
  pi.registerCommand("wc", {
    description: "Count words in a file (no model involved)",
    handler: async (args: string, ctx: any) => {
      const path = args.trim();
      if (!path) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /wc <path>", "warning");
        else console.error("Usage: /wc <path>");
        return;
      }
      try {
        const r = analyse(readFileSync(path, "utf8"));
        const summary = `${r.words} words, ${r.uniqueWords} unique, ${r.lines} lines`;
        if (ctx.hasUI) ctx.ui.notify(summary, "info");
        else console.log(summary);
      } catch (err) {
        const msg = `Failed: ${(err as Error).message}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else console.error(msg);
      }
    },
  });
}

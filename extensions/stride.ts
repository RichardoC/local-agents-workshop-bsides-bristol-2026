/**
 * pi extension: let the STRIDE skill read a document from disk.
 *
 * This exists because of one specific interaction, and it is worth understanding
 * before you write a skill of your own.
 *
 * pi loads skills by PROGRESSIVE DISCLOSURE: only a skill's name and description
 * sit in the system prompt, and the agent is expected to fetch the full SKILL.md
 * with the built-in `read` tool when a task looks like a match.
 *
 * `pi-workshop.sh` passes `-nbt`, which removes the built-in tools -- `read`
 * included. That has two consequences, and together they are why the skill used
 * to refuse everything:
 *
 *   1. The skill body cannot be fetched on demand, so a plain "threat model this
 *      design" never loads it. `/skill:stride-threat-model` forces it, which is
 *      why that form worked and nothing else did.
 *
 *   2. Once loaded, the skill still had no way to READ a document. Hand it a
 *      path and it did exactly what it was told to do with something that is not
 *      a design document -- it refused:
 *
 *        /skill:stride-threat-model docs/design.md
 *        -> "This is not a design document, so I cannot threat model it."
 *
 *      Correct behaviour on a path. Useless to the person asking.
 *
 * So this gives it a reading tool, and nothing else. Same division of labour as
 * the phishing extension: getting bytes off a disk is not the model's job.
 *
 * (A `/stride <path>` slash command looks like the tidier answer and is not.
 * Injecting the document with pi.sendUserMessage hangs in print mode, awaited or
 * not -- measured, it times out. A tool is the flow the model already handles.)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { repairPathArgs } from "./lib/repair.ts";

/** Truncate rather than silently overflowing a small model's context window. */
const MAX_CHARS = 40_000;

/** Directories not worth walking when hunting for a document by name. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "samples", "pi", ".pi", "dist", "coverage",
]);

/**
 * Find a document even when the model mangles the path.
 *
 * Measured, and the reason this function exists: asked for
 * `skills/stride-threat-model/example-design.md`, a 3B model called the tool with
 * bare `example-design.md` and then reported the file did not exist. Dropping the
 * directory is the single most common way a small model gets a path wrong, and
 * the recovery is cheap: match on the basename.
 *
 * Bounded to two levels so this never turns into a filesystem crawl.
 */
function resolveDocPath(input: string): string | undefined {
  if (existsSync(input) && statSync(input).isFile()) return input;

  const name = basename(input);
  const seen: string[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === name) seen.push(join(dir, e.name));
      else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
        walk(join(dir, e.name), depth + 1);
      }
    }
  };
  walk(".", 0);

  // Exactly one match is a safe repair. Several means guessing, so don't.
  return seen.length === 1 ? seen[0] : undefined;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_design_document",
    label: "Read design document",

    description:
      "Read a design document, architecture note, README or feature spec from " +
      "disk so it can be threat modelled. Use this whenever the user names a " +
      "file to threat model instead of pasting its contents.",

    promptSnippet: "read_design_document: read a document from disk to threat model it",

    promptGuidelines: [
      "If the user names a file to threat model, call read_design_document with that path before doing anything else.",
      "Threat model only what read_design_document returned. Do not add components the document does not mention.",
    ],

    parameters: Type.Object({
      path: Type.String({
        description: "Path to the document, relative to the current directory.",
      }),
    }),

    // Runs before schema validation and before execute(), so it is the place to
    // repair a near-miss rather than bouncing it back to the model. Shared with
    // the phishing tool, which hits the same three mistakes.
    prepareArguments(args) {
      return repairPathArgs(args).args as typeof args;
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { path } = params as { path: string };

      const resolved = resolveDocPath(path);
      if (!resolved) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No such document: ${path}. Give a path relative to the current ` +
                `directory, for example skills/stride-threat-model/example-design.md`,
            },
          ],
          details: { error: "not-found", path },
        };
      }

      let text: string;
      try {
        if (statSync(resolved).isDirectory()) {
          return {
            content: [{ type: "text" as const, text: `${resolved} is a directory, not a document.` }],
            details: { error: "directory" },
          };
        }
        text = readFileSync(resolved, "utf8");
      } catch (err) {
        // Returned as content rather than thrown: the model reads this and
        // often recovers by retrying with a corrected path.
        return {
          content: [
            { type: "text" as const, text: `Could not read ${resolved}: ${(err as Error).message}` },
          ],
          details: { error: "unreadable" },
        };
      }

      if (!text.trim()) {
        return {
          content: [{ type: "text" as const, text: `${resolved} is empty.` }],
          details: { error: "empty" },
        };
      }

      const truncated = text.length > MAX_CHARS;
      if (truncated) text = text.slice(0, MAX_CHARS);

      return {
        content: [
          {
            type: "text" as const,
            text:
              `DOCUMENT: ${resolved}\n` +
              `CHARACTERS: ${text.length}${truncated ? ` (truncated to the first ${MAX_CHARS})` : ""}\n` +
              `--- BEGIN DOCUMENT ---\n${text}\n--- END DOCUMENT ---`,
          },
        ],
        details: { path: resolved, characters: text.length, truncated },
      };
    },
  });
}

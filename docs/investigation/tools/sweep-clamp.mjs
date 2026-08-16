// Map perceived context depth -> max_completion_tokens that pi actually sends.
//
// pi derives depth from the last assistant message's usage.totalTokens, so we can
// clone one real session, rewrite that single field, and read off the clamp curve
// without needing genuinely long conversations.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR =
  "/workspace/local-agents-workshop-bsides-bristol-2026/.pi/agent/sessions/--workspace-local-agents-workshop-bsides-bristol-2026--";
const SRC = join(DIR, "2026-08-15T19-10-07-842Z_bsideslong.jsonl");

const depths = [2000, 4000, 6000, 8000, 10000, 10900, 11500, 12000, 12288, 13000];
const lines = readFileSync(SRC, "utf8").trim().split("\n");

// Index of the last assistant message carrying usage.
let lastAssistant = -1;
for (let i = 0; i < lines.length; i++) {
  const o = JSON.parse(lines[i]);
  if (o.type === "message" && o.message?.role === "assistant" && o.message.usage) {
    lastAssistant = i;
  }
}
if (lastAssistant === -1) throw new Error("no assistant message with usage found");

const ids = [];
for (const d of depths) {
  const id = `sweep${d}`;
  const out = lines.slice();

  const sess = JSON.parse(out[0]);
  sess.id = id;
  out[0] = JSON.stringify(sess);

  const rec = JSON.parse(out[lastAssistant]);
  const outTokens = rec.message.usage.output || 100;
  rec.message.usage.input = d - outTokens;
  rec.message.usage.output = outTokens;
  rec.message.usage.cacheRead = 0;
  rec.message.usage.cacheWrite = 0;
  rec.message.usage.totalTokens = d;
  out[lastAssistant] = JSON.stringify(rec);

  writeFileSync(join(DIR, `2026-08-15T20-00-00-000Z_${id}.jsonl`), out.join("\n") + "\n");
  ids.push(id);
}

console.log(ids.join(" "));

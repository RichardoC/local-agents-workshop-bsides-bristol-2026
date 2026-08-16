// Does this model fall into phrase loops in LONG generations, and does
// temperature or an anti-repetition sampler prevent it?
//
// The earlier sweep capped output at 160 tokens and every run ended on
// finish_reason "length" - cut off long before a loop could form. Loops emerge
// once the model runs out of things to say, so this generates far more.
//
// Bonsai-8B's model card recommends temperature 0.5-0.7. The workshop config
// currently uses 0.2, which is below that range and closer to greedy decoding -
// a well-known way to induce repetition. That is the primary comparison here.
import { analyse } from "/workspace/repetition.mjs";
import { writeFileSync, appendFileSync } from "node:fs";

const URL = "http://127.0.0.1:8080/v1/chat/completions";
const OUT = "/workspace/longgen-results.json";
const LOG = "/workspace/longgen.log";
const MAX_TOKENS = 900;

const PROMPT =
  "You are triaging suspicious emails. Explain in exhaustive detail every step of your " +
  "investigation process, narrating each step as you go, and keep going until you have " +
  "covered every aspect thoroughly.";

// Two samples of the key configs, because output is not reproducible even at a
// fixed seed on this build - single samples would be noise.
const VARIANTS = [
  { label: "temp0.2-rp1.05-PI-CURRENT", params: { temperature: 0.2, top_p: 0.9, top_k: 40, repeat_penalty: 1.05 } },
  { label: "temp0.2-rp1.05-PI-CURRENT#2", params: { temperature: 0.2, top_p: 0.9, top_k: 40, repeat_penalty: 1.05 } },
  { label: "temp0.6-cardrec", params: { temperature: 0.6, top_p: 0.9, top_k: 20 } },
  { label: "temp0.6-cardrec#2", params: { temperature: 0.6, top_p: 0.9, top_k: 20 } },
  { label: "temp0.2-rp1.30-w1024", params: { temperature: 0.2, top_p: 0.9, top_k: 40, repeat_penalty: 1.3, repeat_last_n: 1024 } },
  { label: "temp0.2-dry0.8", params: { temperature: 0.2, top_p: 0.9, top_k: 40, dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2, dry_penalty_last_n: 2048 } },
  { label: "temp0.6-dry0.8", params: { temperature: 0.6, top_p: 0.9, top_k: 20, dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2, dry_penalty_last_n: 2048 } },
  { label: "temp0.0-greedy-WORSTCASE", params: { temperature: 0.0, top_p: 1.0, top_k: 1 } },
];

const results = [];
writeFileSync(LOG, `long-generation sweep ${new Date().toISOString()} max_tokens=${MAX_TOKENS}\n`);
console.error(`starting ${VARIANTS.length} variants at ${MAX_TOKENS} max_tokens`);

for (const v of VARIANTS) {
  const body = {
    model: "bonsai-8b",
    messages: [{ role: "user", content: PROMPT }],
    max_tokens: MAX_TOKENS,
    stream: false,
    ...v.params,
  };

  const t0 = Date.now();
  let text = "", status = 0, error = null, finish = null;

  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_600_000),
    });
    status = res.status;
    const json = await res.json().catch(() => null);
    if (json?.choices?.[0]) {
      text = json.choices[0].message?.content ?? "";
      finish = json.choices[0].finish_reason ?? null;
    } else {
      error = JSON.stringify(json)?.slice(0, 300) ?? "no json";
    }
  } catch (e) {
    error = e.message;
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  const m = text ? analyse(text) : null;
  results.push({ label: v.label, params: v.params, status, secs, finish, error, metrics: m, text });

  const line =
    `${v.label.padEnd(30)} ${String(secs).padStart(4)}s words=${String(m?.words ?? 0).padStart(4)} ` +
    `loop=${String(m?.loopScore ?? "-").padStart(5)} distinct=${String(m?.distinctRatio ?? "-").padStart(5)} ` +
    `rep=${m?.worstRepeats ?? "-"}x${m?.worstPhraseWords ?? "-"}w  ${m?.verdict ?? error ?? ""}`;
  console.error(line);
  appendFileSync(LOG, line + "\n");
  writeFileSync(OUT, JSON.stringify(results, null, 1));
}

appendFileSync(LOG, "LONGGEN_DONE\n");
console.error("LONGGEN_DONE");

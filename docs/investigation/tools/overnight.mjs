// Overnight experiment: when does Bonsai-8B fall into phrase loops, and what stops it?
//
// The reported failure is the model repeating the same ~30-word phrase over and
// over, appearing at roughly two-thirds of the context window. Two candidate
// drivers are tested independently:
//
//   1. TEMPERATURE. The model card recommends 0.5-0.7; the workshop config uses
//      0.2, which is near-greedy and a classic way to induce loops.
//   2. CONTEXT DEPTH. Loops are reported deep into a session, so each config is
//      run at shallow depth and at ~2/3 of a 16384 window.
//
// Anti-repetition samplers (repeat_penalty with a wide window, and DRY) are
// tested as mitigations at both depths.
//
// Requests go through node:http rather than fetch: undici imposes a 300s
// timeout that cannot be raised, and deep prompts here take far longer.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { postJson } from "/workspace/post.mjs";
import { analyse } from "/workspace/repetition.mjs";

const OUT = "/workspace/overnight-results.json";
const LOG = "/workspace/overnight.log";
const MAX_TOKENS = 900;

const SHALLOW_PROMPT =
  "You are triaging suspicious emails. Explain in exhaustive detail every step of your " +
  "investigation process, narrating each step as you go, and keep going until you have " +
  "covered every aspect thoroughly.";

// The follow-up appended to a deep fixture. Fixtures already end on a user turn,
// so for those we simply generate from the conversation as-is.
const CONFIGS = [
  { label: "temp0.0-greedy-WORSTCASE", params: { temperature: 0.0, top_k: 1, top_p: 1.0 } },
  { label: "temp0.2-rp1.05-PI-CURRENT", params: { temperature: 0.2, top_p: 0.9, top_k: 40, repeat_penalty: 1.05 } },
  { label: "temp0.6-CARD-RECOMMENDED", params: { temperature: 0.6, top_p: 0.9, top_k: 20 } },
  { label: "temp0.2-rp1.30-w1024", params: { temperature: 0.2, top_p: 0.9, top_k: 40, repeat_penalty: 1.3, repeat_last_n: 1024 } },
  { label: "temp0.2-dry0.8", params: { temperature: 0.2, top_p: 0.9, top_k: 40, dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2, dry_penalty_last_n: 2048 } },
];

// Repeat the two headline configs at shallow depth, since output is not
// reproducible on this build and one sample would be noise.
const SHALLOW_EXTRA = ["temp0.2-rp1.05-PI-CURRENT", "temp0.6-CARD-RECOMMENDED"];

const JOBS = [];

// Phase 1: shallow, cheap, establishes whether depth is even necessary.
for (const c of CONFIGS) JOBS.push({ phase: "shallow", depth: 0, fixture: null, ...c });
for (const label of SHALLOW_EXTRA) {
  const c = CONFIGS.find((x) => x.label === label);
  JOBS.push({ phase: "shallow", depth: 0, fixture: null, ...c, label: c.label + "#2" });
}

// Phase 2 and 3: at depth. The first request at each depth pays full prompt
// evaluation; later ones reuse the KV cache, so ordering matters.
for (const f of ["/workspace/fixtures/conv-11000.json", "/workspace/fixtures/conv-8000.json"]) {
  if (!existsSync(f)) continue;
  for (const c of CONFIGS) JOBS.push({ phase: `depth:${f.match(/conv-(\d+)/)[1]}`, fixture: f, ...c });
}

const results = [];
writeFileSync(LOG, `overnight run ${new Date().toISOString()} - ${JOBS.length} jobs, max_tokens=${MAX_TOKENS}\n`);
const log = (s) => { console.error(s); appendFileSync(LOG, s + "\n"); };

for (const [i, job] of JOBS.entries()) {
  let messages;
  if (job.fixture) {
    messages = JSON.parse(readFileSync(job.fixture, "utf8")).messages;
  } else {
    messages = [{ role: "user", content: SHALLOW_PROMPT }];
  }

  const body = {
    model: "bonsai-8b",
    messages,
    max_tokens: MAX_TOKENS,
    stream: false,
    ...job.params,
  };

  const t0 = Date.now();
  let text = "", status = 0, error = null, finish = null, usage = null;
  try {
    const r = await postJson("/v1/chat/completions", body);
    status = r.status;
    if (r.json?.choices?.[0]) {
      text = r.json.choices[0].message?.content ?? "";
      finish = r.json.choices[0].finish_reason ?? null;
      usage = r.json.usage ?? null;
    } else {
      error = (r.raw || "").slice(0, 300);
    }
  } catch (e) {
    error = e.message;
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  const m = text ? analyse(text) : null;
  results.push({ ...job, status, secs, finish, usage, error, metrics: m, text });
  writeFileSync(OUT, JSON.stringify(results, null, 1));

  log(
    `[${String(i + 1).padStart(2)}/${JOBS.length}] ${job.phase.padEnd(12)} ${job.label.padEnd(28)} ` +
      `${String(secs).padStart(4)}s prompt=${usage?.prompt_tokens ?? "?"} words=${String(m?.words ?? 0).padStart(4)} ` +
      `loop=${String(m?.loopScore ?? "-").padStart(5)} distinct=${String(m?.distinctRatio ?? "-").padStart(5)} ` +
      `rep=${m?.worstRepeats ?? "-"}x${m?.worstPhraseWords ?? "-"}w ${m?.verdict ?? error ?? ""}`,
  );
}

log("OVERNIGHT_DONE");

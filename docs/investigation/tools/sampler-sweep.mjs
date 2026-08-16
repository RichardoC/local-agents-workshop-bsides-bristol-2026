// Which sampling parameters does this llamafile actually APPLY?
//
// Source inspection says the OAI endpoint forwards llama.cpp-native params and
// silently discards unknown ones. That predicts: an ignored parameter yields
// byte-identical output at a fixed seed. This measures it.
import { analyse } from "/workspace/repetition.mjs";
import { writeFileSync, appendFileSync } from "node:fs";

const URL = "http://127.0.0.1:8080/v1/chat/completions";
const OUT = "/workspace/sampler-sweep-results.json";
const LOG = "/workspace/sampler-sweep.log";

// A prompt that invites open-ended continuation - the situation where a heavily
// quantized model tends to fall into a phrase loop.
const PROMPT =
  "You are triaging suspicious emails. Explain, step by step and at length, what you " +
  "will do next to investigate a suspected phishing message, narrating each step as you go.";

const VARIANTS = [
  { label: "baseline-seed42", params: {} },
  { label: "baseline-seed42-again", params: {} }, // seed reproducibility check
  { label: "baseline-seed99", params: {}, seed: 99 },
  { label: "pi-current-rp1.05", params: { repeat_penalty: 1.05 } },
  { label: "rp1.15", params: { repeat_penalty: 1.15 } },
  { label: "rp1.30", params: { repeat_penalty: 1.3 } },
  { label: "rp1.15-window1024", params: { repeat_penalty: 1.15, repeat_last_n: 1024 } },
  { label: "rp1.30-window1024", params: { repeat_penalty: 1.3, repeat_last_n: 1024 } },
  { label: "frequency_penalty1.0", params: { frequency_penalty: 1.0 } },
  { label: "presence_penalty1.0", params: { presence_penalty: 1.0 } },
  {
    label: "dry0.8",
    params: {
      dry_multiplier: 0.8,
      dry_base: 1.75,
      dry_allowed_length: 2,
      dry_penalty_last_n: 2048,
    },
  },
  {
    label: "dry0.8-plus-rp1.15w1024",
    params: {
      dry_multiplier: 0.8,
      dry_base: 1.75,
      dry_allowed_length: 2,
      dry_penalty_last_n: 2048,
      repeat_penalty: 1.15,
      repeat_last_n: 1024,
    },
  },
  // Predicted to be silently ignored -> identical to baseline at same seed.
  { label: "no_repeat_ngram_size6-EXPECT-IGNORED", params: { no_repeat_ngram_size: 6 } },
  // Predicted to be rejected with HTTP 400.
  { label: "repeat_last_n-negative-EXPECT-400", params: { repeat_penalty: 1.15, repeat_last_n: -1 } },
];

const results = [];
writeFileSync(LOG, `sampler sweep started ${new Date().toISOString()}\n`);

for (const v of VARIANTS) {
  const body = {
    model: "bonsai-8b",
    messages: [{ role: "user", content: PROMPT }],
    max_tokens: 160,
    temperature: 0.7,
    top_p: 0.95,
    seed: v.seed ?? 42,
    stream: false,
    ...v.params,
  };

  const t0 = Date.now();
  let text = "";
  let status = 0;
  let error = null;
  let finish = null;

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
  const metrics = text ? analyse(text) : null;
  const row = { label: v.label, params: v.params, seed: v.seed ?? 42, status, secs, finish, error, metrics, text };
  results.push(row);

  const line =
    `${v.label.padEnd(38)} http=${status} ${String(secs).padStart(4)}s ` +
    `loop=${metrics ? metrics.loopScore : "-"} distinct=${metrics ? metrics.distinctRatio : "-"} ` +
    `${metrics ? metrics.verdict : error ?? ""}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
  writeFileSync(OUT, JSON.stringify(results, null, 1));
}

// Seed reproducibility: are the two identical-config runs byte-identical?
const a = results.find((r) => r.label === "baseline-seed42");
const b = results.find((r) => r.label === "baseline-seed42-again");
const ign = results.find((r) => r.label.startsWith("no_repeat_ngram_size6"));
const seedRepro = a && b ? a.text === b.text : null;
const ngramIgnored = a && ign ? a.text === ign.text : null;

const summary = [
  "",
  `SEED REPRODUCIBLE (same seed, byte-identical): ${seedRepro}`,
  `no_repeat_ngram_size IGNORED (identical to baseline): ${ngramIgnored}`,
  "SWEEP_DONE",
].join("\n");
console.log(summary);
appendFileSync(LOG, summary + "\n");

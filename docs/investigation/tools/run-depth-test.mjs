#!/usr/bin/env node
/**
 * run-depth-test.mjs — replay a fixture conversation against the local llamafile
 * server once per sampling variant, and measure the repetition of what it
 * generates at that context depth.
 *
 *   node /workspace/run-depth-test.mjs \
 *     --fixture /workspace/fixtures/conv-8000.json \
 *     --variants /workspace/variants.json \
 *     --out /workspace/results-8000.json
 *
 * The fixture supplies an OpenAI-format `messages` array that ends on a user
 * turn, so every request asks the model for exactly one fresh assistant reply.
 *
 * Variants file: a JSON array of { "label": string, "params": object }, e.g.
 *   [ {"label":"baseline","params":{"temperature":0.2}},
 *     {"label":"rp1.3","params":{"temperature":0.2,"repeat_penalty":1.3}} ]
 *
 * Variants run STRICTLY SEQUENTIALLY: the server has a single slot, and
 * concurrent requests would queue and corrupt the wall-clock measurements.
 *
 * ── Why node:http rather than fetch ──────────────────────────────────────────
 * A cold deep prompt can take 40+ minutes before the server emits its first
 * response byte. Node's global fetch is undici, whose *headersTimeout* defaults
 * to 300 s and cannot be raised without importing undici (not resolvable from a
 * plain script on this install). An AbortSignal.timeout(3_600_000) does not
 * help: undici aborts on its own headers timeout long before the signal fires.
 * node:http has no such default, so the deadline below is the only one in play.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";

// The local llamafile must never be reached through the agent proxy.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

const DEFAULTS = {
  url: "http://127.0.0.1:8080/v1/chat/completions",
  model: "bonsai-8b",
  maxTokens: 400,
  /** Inactivity deadline per request. Well above the 40 min worst case seen. */
  timeoutMs: 3_600_000,
};

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture") out.fixture = argv[++i];
    else if (a === "--variants") out.variants = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--max-tokens") out.maxTokens = Number(argv[++i]);
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.fixture || !args.variants || !args.out) {
  console.error(
    `usage: node run-depth-test.mjs --fixture <fixture.json> --variants <variants.json> --out <results.json>\n` +
      `       [--url ${DEFAULTS.url}] [--model ${DEFAULTS.model}]\n` +
      `       [--max-tokens ${DEFAULTS.maxTokens}] [--timeout-ms ${DEFAULTS.timeoutMs}]`,
  );
  process.exit(args.help ? 0 : 1);
}
if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 3_600_000) {
  console.error(
    `--timeout-ms must be at least 3600000 (1 hour): a cold deep prompt can take 40+ minutes.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// repetition metrics
//
// /workspace/repetition.mjs exports analyse() and also runs as a CLI. Current
// versions guard the CLI block with an import.meta.url check, so importing it
// is inert — but older copies run it unconditionally, reading process.argv[2]
// as a file path and printing a JSON line. Under those, importing from here
// would try to open our own "--fixture" flag as a file and abort. Point argv at
// a file that really exists and swallow any line printed, then restore both;
// this is a no-op against the guarded version and a fix against the other.
// ---------------------------------------------------------------------------

async function loadAnalyse(existingFile) {
  const savedArgv = process.argv;
  const savedLog = console.log;
  process.argv = [savedArgv[0], savedArgv[1], existingFile];
  console.log = () => {};
  try {
    const mod = await import("/workspace/repetition.mjs");
    if (typeof mod.analyse !== "function") {
      throw new Error("repetition.mjs does not export analyse()");
    }
    return mod.analyse;
  } finally {
    process.argv = savedArgv;
    console.log = savedLog;
  }
}

// ---------------------------------------------------------------------------
// one POST, no early give-up
// ---------------------------------------------------------------------------

function postJson(url, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(bodyObj), "utf8");
    const req = httpRequest(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          Connection: "close",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* leave null; caller reports the raw text */
          }
          resolve({ status: res.statusCode, text, json });
        });
        res.on("error", reject);
      },
    );

    // Inactivity deadline. The socket is silent while the server evaluates the
    // prompt, so this must comfortably exceed the longest expected think time.
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error(`no response within ${Math.round(timeoutMs / 1000)}s (inactivity timeout)`),
      );
    });
    req.on("error", reject);
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function loadJson(path, what) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${what} at ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${what} at ${path} is not valid JSON: ${err.message}`);
  }
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n).slice(0, n);
const oneLine = (s, n) => {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
};

async function main() {
  const fixture = loadJson(args.fixture, "fixture");
  if (!Array.isArray(fixture.messages) || !fixture.messages.length) {
    throw new Error(`fixture ${args.fixture} has no messages array`);
  }
  if (fixture.messages.at(-1).role !== "user") {
    console.error(
      `WARNING: fixture does not end on a user message (ends on ` +
        `"${fixture.messages.at(-1).role}") — the model may not produce a fresh reply.`,
    );
  }

  const variants = loadJson(args.variants, "variants file");
  if (!Array.isArray(variants) || !variants.length) {
    throw new Error(`variants file ${args.variants} must be a non-empty JSON array`);
  }
  variants.forEach((v, i) => {
    if (!v || typeof v.label !== "string") throw new Error(`variant ${i}: missing "label"`);
    if (v.params != null && typeof v.params !== "object")
      throw new Error(`variant ${i} (${v.label}): "params" must be an object`);
  });

  const analyse = await loadAnalyse(args.fixture);

  console.error(
    `fixture   : ${args.fixture}\n` +
      `            target=${fixture.targetTokens ?? "?"} measured=${fixture.measuredTokens ?? "?"} ` +
      `messages=${fixture.messages.length} (ends on ${fixture.messages.at(-1).role})\n` +
      `variants  : ${variants.length} from ${args.variants}\n` +
      `endpoint  : ${args.url}  model=${args.model} max_tokens=${args.maxTokens}\n` +
      `timeout   : ${Math.round(args.timeoutMs / 1000)}s per request, run sequentially\n`,
  );

  const results = [];
  const startedAll = new Date().toISOString();

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const params = v.params ?? {};
    const body = {
      model: args.model,
      messages: fixture.messages,
      max_tokens: args.maxTokens,
      stream: false,
      ...params,
    };

    console.error(
      `[${i + 1}/${variants.length}] ${v.label} — params ${JSON.stringify(params)} … sending`,
    );
    const t0 = performance.now();
    const record = {
      label: v.label,
      params,
      startedAt: new Date().toISOString(),
      seconds: null,
      text: null,
      finishReason: null,
      usage: null,
      metrics: null,
      httpStatus: null,
      error: null,
    };

    try {
      const res = await postJson(args.url, body, args.timeoutMs);
      record.seconds = Number(((performance.now() - t0) / 1000).toFixed(2));
      record.httpStatus = res.status;

      if (res.status !== 200) {
        record.error = `HTTP ${res.status}: ${oneLine(res.text, 400)}`;
        console.error(
          `[${i + 1}/${variants.length}] ${v.label} — FAILED after ${record.seconds}s: ${record.error}`,
        );
      } else {
        const choice = res.json?.choices?.[0];
        const text = choice?.message?.content ?? "";
        record.text = text;
        record.finishReason = choice?.finish_reason ?? null;
        record.usage = res.json?.usage ?? null;
        record.metrics = analyse(text);
        console.error(
          `[${i + 1}/${variants.length}] ${v.label} — ok in ${record.seconds}s, ` +
            `${text.length} chars, finish=${record.finishReason}, ` +
            `loop=${record.metrics.loopScore} distinct=${record.metrics.distinctRatio} ` +
            `${record.metrics.verdict}`,
        );
      }
    } catch (err) {
      record.seconds = Number(((performance.now() - t0) / 1000).toFixed(2));
      record.error = String(err?.message || err);
      console.error(
        `[${i + 1}/${variants.length}] ${v.label} — ERROR after ${record.seconds}s: ${record.error}`,
      );
    }

    results.push(record);

    // Persist after every variant so a long run is never lost wholesale.
    writeFileSync(
      args.out,
      JSON.stringify(
        {
          fixture: args.fixture,
          targetTokens: fixture.targetTokens ?? null,
          measuredTokens: fixture.measuredTokens ?? null,
          messageCount: fixture.messages.length,
          endpoint: args.url,
          model: args.model,
          maxTokens: args.maxTokens,
          timeoutMs: args.timeoutMs,
          startedAt: startedAll,
          finishedAt: new Date().toISOString(),
          complete: results.length === variants.length,
          results,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }

  // ---- summary table -------------------------------------------------------
  const head =
    `${pad("label", 18)} ${padL("secs", 8)} ${padL("loop", 6)} ${padL("distinct", 9)} ` +
    `${pad("verdict", 18)} output`;
  console.log(`\n${head}`);
  console.log("-".repeat(head.length + 20));
  for (const r of results) {
    if (r.error) {
      console.log(
        `${pad(r.label, 18)} ${padL(r.seconds ?? "-", 8)} ${padL("-", 6)} ${padL("-", 9)} ` +
          `${pad("ERROR", 18)} ${oneLine(r.error, 80)}`,
      );
      continue;
    }
    console.log(
      `${pad(r.label, 18)} ${padL(r.seconds, 8)} ${padL(r.metrics.loopScore, 6)} ` +
        `${padL(r.metrics.distinctRatio, 9)} ${pad(r.metrics.verdict, 18)} ${oneLine(r.text, 80)}`,
    );
  }
  const failed = results.filter((r) => r.error).length;
  console.log(
    `\n${results.length} variant(s) run, ${failed} failed. Results written to ${args.out}`,
  );
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

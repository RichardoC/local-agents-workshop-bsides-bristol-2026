# Investigation: why a local model + pi goes wrong in long sessions

Working notes from a debugging session against Bonsai-8B-Q1_0 running under
llamafile, driven by the pi coding agent. Written so the work can be resumed
without re-deriving anything.

**Status: two failure modes proven and fixed, one reported failure NOT
reproduced.** Read "The open question" before assuming the job is done.

---

## Environment these numbers came from

Everything below is specific to this setup. The wall-clock figures in particular
are dominated by very slow hardware — do not generalise them to a laptop.

| | |
|---|---|
| Model | `prism-ml/Bonsai-8B-gguf : Bonsai-8B-Q1_0.gguf` (1.16 GB) |
| Base architecture | Qwen3-8B dense, GQA 32 query / 8 KV heads, native context 65,536 |
| Quantisation | **Q1_0 only** — no other quant exists in that repo |
| Card-recommended sampling | temperature 0.5–0.7, top_k 20–40, top_p 0.85–0.95 |
| Runtime | llamafile v0.10.5 (wraps a recent llama.cpp) |
| Server command | `./bonsai.llamafile --server --gpu disable --host 127.0.0.1 --port 8080 -c 16384 -np 1` |
| Agent | pi (`@earendil-works/pi-coding-agent`) 0.84.2, Node 22.22.2 |
| Hardware | 4 vCPU Intel Xeon @ 2.8 GHz, **no GPU**, 15 GB RAM |
| Measured throughput | **~3.5–3.7 tok/s prompt eval, ~1.5 tok/s generation** |

That throughput is the single most important environmental fact. It means a cold
prompt of more than about 1,000 tokens cannot be evaluated inside a 300-second
client timeout, which shaped — and repeatedly broke — the experiments below.

---

## Summary

| # | Finding | Status |
|---|---|---|
| 1 | Reply allowance collapses to 1 token as context grows; empty reply, exit 0 | **Proven, measured** |
| 2 | A 300s client timeout aborts deep prompts; identical request re-sent 4× | **Proven, reproduced** |
| 3 | The 300s limit is Node's `fetch`/undici default, not a pi setting | **PARTLY WRONG — see corrections** |
| 4 | `-np 1` is required or the KV cache is thrown away every turn | **Proven, measured** |
| 5 | Compaction is manual only — no automatic trigger, no warning | **Right effect, wrong reason — see corrections** |
| 6 | llamafile's anti-repetition samplers are off by default | **Proven (source + `--help`)** |
| 7 | Phrase-level looping (the original complaint) | **NOT REPRODUCED** |

### Corrections found later

Reading pi's shipped `docs/settings.md` (in the static build, `pi/docs/`)
overturned parts of findings 2, 3 and 5. Full write-up in
[../small-model-tuning.md](../small-model-tuning.md); in brief:

- **`httpIdleTimeoutMs` is a pi setting**, default `300000`, and the docs say
  "set to `0` to disable". Finding 3 asserted no such setting existed. It does.
  One caveat pointing the other way: a deep-session run on *default* settings
  later survived 500 seconds without erroring, so the ceiling may be idle-based
  rather than total, and the original 300s observation may have come from
  `fetch`/undici inside the measurement scripts rather than from pi itself.
- **The four identical requests were `retry.maxRetries` (default 3)** — one
  attempt plus three agent-level retries. This report called that unexplained
  because the provider-level SDK was constructed with `maxRetries: 0`, which was
  the wrong layer to look at.
- **Compaction is not manual-only by design.** `compaction.enabled` defaults to
  `true`; it is inert here because `reserveTokens` (16384) and
  `keepRecentTokens` (20000) both exceed the 16384-token window. The observed
  behaviour was right; the stated cause was not. Sizing both below the window
  (`.pi/agent/settings.json`) was later confirmed to make compaction fire —
  see [small-model-tuning.md §4](../small-model-tuning.md#4-verified-against-a-real-gpu-backed-endpoint).
  That confirmation needed a much faster endpoint than this machine, since the
  first attempt at reduced values still hadn't fired within the time available
  on this hardware — not because it doesn't work, but because a compaction call
  is itself an LLM request that was too slow to complete here in a reasonable
  test window.

Method note, since it cost time twice: pi's own `pi/docs/` directory ships inside
the static build. Read it before concluding that something is not configurable.

---

## 1. The reply-allowance clamp

pi decides how many tokens the model may reply with as:

```
allowance = contextWindow − contextUsed − 4096      (floored at 1, not 0)
```

`4096` is `CONTEXT_SAFETY_TOKENS`, and the floor is `MIN_MAX_TOKENS = 1`, both in
`pi-ai/dist/api/simple-options.js`. The result is sent as
`max_completion_tokens`.

Two consequences, both silent:

- **At startup**, declaring `contextWindow: 4096` makes the sum negative, so the
  model is told it may emit exactly one token. It emits one, stops, and pi prints
  nothing at all with no error. This is why the workshop uses 16384.
- **In a long session**, the allowance decays linearly until it hits the same
  floor. The agent goes from full answers, to truncated ones, to an **empty
  response with exit code 0** — a reported success containing nothing.

### Measured, on a 16384 window

Two independently built session sets, agreeing to within 24 tokens (the width of
the pending user message):

Hand-patched copies of a real session (~3,400 tokens of trailing content):

| declared depth | allowance sent |
|---|---|
| 2,000 | 6,888 |
| 4,000 | 4,888 |
| 6,000 | 2,888 |
| 8,000 | 888 |
| 10,000+ | **1** |

Purpose-built clean fixtures (ending on an assistant message, so trailing ≈ 0):

| `usage.totalTokens` | allowance sent |
|---|---|
| 7,974 | 4,290 |
| 10,861 | 1,403 |
| 11,962 | 302 |
| 12,978 | **1** |

### The detail that makes this hard to diagnose

**Depth is not counted from the conversation text.** `estimateMessages` in
`pi-ai/dist/utils/estimate.js` reads `usage.totalTokens` from the *last assistant
message* and only falls back to a chars/4 estimate if no assistant usage exists:

```js
const usageInfo = getLastAssistantUsageInfo(messages);
if (usageInfo) {
    const usageTokens = calculateContextTokens(usageInfo.usage);
    return { tokens: usageTokens + trailingTokens, ... };
}
```

So depth is a recorded field, not a recount. That is exploitable: you can clone
one real session, rewrite that single field, and map the whole clamp curve in
minutes instead of growing conversations for hours. `tools/sweep-clamp.mjs` does
exactly this.

It also means a real session hits the wall *earlier* than the clean fixtures
suggest, because real `usage` includes non-zero `cacheRead` in the total.

### Where the wall sits

`(contextWindow − 4096 − overhead) / contextWindow`. With lean overhead that is
about three-quarters of the window; with pi's full default system prompt and all
built-in tool schemas loaded, overhead is larger and it arrives nearer
two-thirds. It is not a fixed fraction, which is why it moves between configs.

**Cannot be disabled.** The allowance is always sent, and the one code path that
skips the clamp requires `contextWindow: 0`, which `provider-composer.js` rejects
with `invalid contextWindow`.

**Mitigations:** `/compact`; start fresh sessions; raise `-c` and `contextWindow`
together; keep tool output small; keep overhead down (`-nbt`, short system
prompt).

---

## 2 & 3. The 300-second timeout, and where it actually comes from

On deep sessions pi reports `Request timed out` after ~1216 seconds. The proxy
capture shows why:

- 4 requests, **byte-identical** (`content-length: 46281` each)
- `x-stainless-timeout: 300` on every one
- `x-stainless-retry-count: 0` on every one
- **zero completed responses**
- 1216 s ≈ 4 × 304 s

Meanwhile the server was working correctly, just slowly:

```
task 3363 | prompt processing, n_tokens = 4096, progress = 0.49, t = 1169.12 s / 3.50 tokens per second
```

49% of the prompt after 19 minutes. A cold 12k prompt needs ~40 minutes here and
can never finish inside 300 s, so every attempt is abandoned at the same point
and reissued unchanged.

**The 300 s is Node's, not pi's.** Confirmed independently: a plain
`fetch()` from my own script died at exactly 301 s with `fetch failed`, and
`AbortSignal.timeout(3_600_000)` did **not** override it — undici enforces its
own header/body timeout. The OpenAI SDK runs on the same stack. This is why no
pi setting, `models.json` key or environment variable exposes it.

**Workaround for tooling:** use `node:http` directly, which imposes no timeout.
`tools/post.mjs` is a drop-in helper; a request that previously failed at 301 s
completes fine through it.

**Unexplained:** the four attempts. `DEFAULT_MAX_RETRIES = 0`, the SDK client is
constructed with `maxRetries: 0`, and every request carried
`x-stainless-retry-count: 0`. Nothing in the code should retry. Reproduced with
*and* without the logging proxy, so it is not an instrumentation artefact. Still
open.

**Practical rule:** what matters is cold versus warm evaluation. With `-np 1` and
the server left running, a turn evaluates only new tokens and stays well under
the limit. Anything forcing full re-evaluation is dangerous on slow hardware:
`--fork`, `--resume`, `--continue`, restarting the server, or slot eviction.

---

## 4. `-np 1` is not optional

llamafile defaults to four parallel slots and dispatches by LRU. An agent's turns
share a growing prefix, so bouncing between slots discards the KV cache and
reprocesses the whole conversation every turn.

Measured: one turn spent **349 s re-evaluating 1,149 tokens**. With `-np 1` the
same turn processed **307 new tokens**. End-to-end run time went from a 9-minute
timeout to 3m30s.

---

## 5. Compaction is manual

`/compact` is a slash command. There is no threshold, no context-pressure
trigger, nothing automatic in the session loop. pi will walk a conversation into
the clamp wall with no compaction and no warning.

---

## 6. Sampler defaults (llamafile / llama.cpp)

From the running binary's `--help`:

```
--repeat-penalty N   default: 1.00   (1.0 = disabled)
--repeat-last-n N    default: 64
--dry-multiplier N   default: 0.00   (0.0 = disabled)
```

Started with no sampler flags, **every anti-repetition sampler is off**. pi's
`samplingParams` do reach the server (verified on the wire), but the workshop
config only set `repeat_penalty: 1.05` — barely above disabled — and left
`repeat_last_n` at 64. A ~30-word phrase is 40+ tokens, so a 64-token window
barely spans one repetition.

Other findings:

- **`no_repeat_ngram_size` does not exist in llama.cpp.** Zero hits in the source
  tree, absent from the binary. Returns HTTP 200 and is silently discarded — the
  endpoint never validates unknown fields.
- The **DRY sampler is available**: `dry_multiplier`, `dry_base`,
  `dry_allowed_length`, `dry_penalty_last_n`. Better suited to phrase-level loops
  than per-token `repeat_penalty`.
- **`repeat_last_n: -1` returned HTTP 200**, contradicting a source-derived
  prediction of 400. Do not trust that prediction.
- **`seed` is not reproducible on this build.** Two runs at seed 42 shared an
  opening then diverged. Byte-identity therefore cannot be used to detect
  silently-ignored parameters; comparisons must be behavioural, with repeat
  samples.

---

## 7. The open question: phrase looping was NOT reproduced

**The original complaint:** the model repeats the same ~30-word phrase over and
over ("Next I'm going to X. Next I'm going to X…"), reportedly at two-thirds or
more of the context window, on pi's default configuration with tools.

**It did not happen in 12 controlled runs.** Scored with `tools/repetition.mjs`
(validated: synthetic looping text scores 1.0, clean text 0).

`loopScore`, 900-token generations:

| config | shallow | at 11k depth |
|---|---|---|
| greedy (temp 0.0) | 0 | 0 |
| **temp 0.2 + rp 1.05 (the workshop config)** | 0.021 / 0.019 | **0.126** |
| temp 0.6 (card recommended) | 0.031 / 0 | 0 |
| temp 0.2 + rp 1.30, window 1024 | 0 | 0 |
| temp 0.2 + DRY 0.8 | 0.017 | 0 |

Every run scored **"clean"**. Worst repeat anywhere: a 10-word phrase twice.

**The temperature hypothesis does not survive its own data.** At depth, temp 0.2
scored 0.126 against 0 for everything else — suggestive. But at shallow depth
temp 0.6 scored *higher* than temp 0.2 (0.031 vs 0.021). Single samples at depth,
inconsistent direction at shallow. Treat as noise, not an effect.

**Why the reproduction probably failed.** At depth the model produced 83–159
words and stopped cleanly (`finish_reason: "stop"`), versus 543–686 words at
shallow depth. It was not rambling — it answered tersely and finished. Loops
emerge when a model runs out of substance and pads; the synthetic fixtures are
coherent and information-rich, giving it plenty to ground on.

**The most promising untested hypothesis:** the loop is triggered by *degraded
conversation state*, not depth alone. Findings 1 and 2 both leave exactly that
behind — a history containing a reply truncated mid-sentence, or an empty
assistant turn. A conversation in that state is a far better loop candidate than
a clean fixture. **Build damaged fixtures and retest.** That is the next
experiment.

Also untested: the depth-8000 arm (server died at job 13 of 17), and whether
`phish_triage`'s identical ~45-word `NOTE:` trailer on every tool result primes
repetition — a byte-identical trailer of that size was enough to score as looping
across a conversation during fixture construction.

---

## Tooling

Copied into `tools/` because `/workspace` is ephemeral. Paths inside the scripts
are absolute to `/workspace` and will need adjusting.

| file | purpose |
|---|---|
| `repetition.mjs` | Loop detector. Exports `analyse(text)`; also a CLI. Returns `loopScore`, `worstPhrase`, `worstRepeats`, `distinctRatio`, verdict. |
| `post.mjs` | `node:http` POST helper. **Use instead of `fetch`** — no 300s timeout. |
| `overnight.mjs` | The depth × sampler matrix runner. Writes results after every job. |
| `sampler-sweep.mjs` | Short-prompt sampler comparison (note: 160 tokens is too short, see pitfalls). |
| `longgen-sweep.mjs` | 900-token generation sweep. |
| `measure-clamp.sh` | Reads `max_completion_tokens` off the wire per session, killing pi once captured — seconds instead of a full generation. |
| `sweep-clamp.mjs` | Clones a real session at many declared depths by rewriting `usage.totalTokens`. |
| `gen-session.mjs` | Generates synthetic **pi session JSONL** at a target depth. |
| `gen-fixture.mjs` | Generates synthetic **OpenAI `messages` fixtures** at a target depth. |
| `run-depth-test.mjs` | Runs a fixture against a variants file. |
| `proxy.mjs` | Logging proxy on 8081 → 8080. Aborts upstream on client disconnect (the first version did not, which caused a queue pile-up that corrupted a whole run). |

`fixtures/` holds verified conversations at 1,936 / 3,983 / 7,974 / 10,844
tokens, each ending on a user turn, inputs verified non-repetitive
(distinctRatio ≥ 0.993). `results/` holds the raw JSON and logs.

---

## Pitfalls that cost real time

Recorded so they are not repeated.

1. **`fetch` dies at 301 s** with an unhelpful `fetch failed`, and
   `AbortSignal.timeout` does not help. Use `tools/post.mjs`.
2. **Short generations cannot show loops.** An early sweep capped output at 160
   tokens; every run ended `finish_reason: "length"` and scored zero repetition.
   That measured nothing. Use 900+.
3. **`prompt eval time = N tokens` is not conversation depth.** With cache reuse
   it is only the newly-evaluated tokens, so depth appears to shrink. Use
   `stop processing: n_tokens = N`.
4. **The first logging proxy did not abort upstream on disconnect**, so abandoned
   requests held llamafile's single slot and later requests queued behind them.
   One "no-proxy control" run was silently contaminated by this — the request
   never reached the server at all (`delta 0` launch_slot events).
5. **`--fork` cannot be combined with `--no-session`.**
6. **Importing a module that also acts as a CLI** made `repetition.mjs` read
   stdin on import. Guard with `import.meta.url === \`file://${process.argv[1]}\``.
7. **The llamafile server died unprompted at least three times** during long
   runs, twice mid-experiment, once wedged in shutdown while a stale proxy held
   keep-alive sockets open. Health-check and restart between jobs, and check the
   server is actually alive before trusting a null result.
8. **Cold vs warm cache dominates wall-clock** and will masquerade as a real
   effect. An apparent 2× speedup from raising `repeat_penalty` turned out to be
   entirely cache warmth; re-running the baseline warm matched it to within four
   seconds. Always run a warm control.

---

## If picking this up again

1. Restart the server: `cd /workspace && ./bonsai.llamafile --server --gpu disable --host 127.0.0.1 --port 8080 -c 16384 -np 1`, and verify `/health`.
2. Build **damaged** fixtures — conversations whose last assistant turn is cut
   mid-sentence, or empty — and rerun `overnight.mjs` against them. This is the
   leading hypothesis for the unreproduced loop.
3. Finish the depth-8000 arm.
4. Test whether removing `phish_triage`'s repeated `NOTE:` trailer changes
   anything.
5. Resolve the four-attempt mystery in finding 2.

Worth reporting upstream to pi regardless of the above: a reply allowance floored
at 1 that returns success with no output is arguably a bug — erroring, or
warning, would turn a baffling silent failure into an obvious one.

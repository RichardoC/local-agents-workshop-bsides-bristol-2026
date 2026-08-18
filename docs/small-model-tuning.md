# Tuning pi for a small model on limited compute

Two questions this answers:

1. Can we use **subagents** to keep context short, and so keep inference fast?
2. Can pi **recover** when the model returns a broken tool call?

Short version: (2) yes, and the repair is now in this repo. (1) yes, pi ships a
subagent extension — but on a single-slot CPU server it will usually make things
*slower*, and the reasons are worth understanding before you reach for it.

Measurements below come from the same 4-core, no-GPU VM as
[the investigation notes](investigation/README.md): **5.74 tokens/second of
prompt processing**, Bonsai-8B-Q1_0 via llamafile 0.10.5, pi 0.84.2. A laptop
with a working GPU is one to two orders of magnitude faster and most of the
pain here disappears.

Each claim is marked **[verified]** (measured in this repo), **[documented]**
(stated in pi's own docs, shipped in `pi/docs/`, not independently checked), or
**[reasoned]** (a conclusion drawn from the above).

---

## 1. Subagents

### What pi provides

pi ships a complete subagent extension at `pi/examples/extensions/subagent/`,
with agent definitions as markdown files. **[documented]**

- Each invocation **spawns a separate `pi` process**, so the subagent gets its
  own context window and returns only its final answer to the parent.
- Three modes: single, parallel (`MAX_PARALLEL_TASKS = 8`, `MAX_CONCURRENCY = 4`),
  and chain, where each step receives `{previous}`.
- Agents are markdown files in `~/.pi/agent/agents/*.md`. Project-local agents
  (`.pi/agents/`) are **off by default** and prompt for confirmation, because a
  repo-supplied agent prompt can tell the model to run shell commands.

Installing it is a copy and a flag, no build step:

```bash
mkdir -p ~/.pi/agent/extensions/subagent
cp pi/examples/extensions/subagent/{index,agents}.ts ~/.pi/agent/extensions/subagent/
mkdir -p ~/.pi/agent/agents && cp pi/examples/extensions/subagent/agents/*.md ~/.pi/agent/agents/
```

### Why it will probably not speed things up here

The instinct — "shorter context means faster inference" — is right about
*generation* and wrong about the thing that actually dominates on a CPU.

On this hardware the cost is **prompt processing**, and the saving grace of a
normal agent session is the KV cache: with `-np 1` and a warm server, turn *N+1*
only evaluates the tokens added since turn *N*. We measured that directly — a
second turn went from reprocessing 1,149 tokens to processing 307 new ones.
**[verified]**

A subagent breaks that in two ways:

1. **A subagent is a cache miss by construction.** It is a new process with a
   different system prompt, so its prefix has never been seen. It pays full
   prompt evaluation. **[reasoned]**
2. **Worse, it evicts the parent's prefix.** One slot holds one prefix. Main
   agent → subagent → main agent means the main agent's next turn is *also* a
   full re-evaluation. You have turned one cheap incremental turn into two
   expensive cold ones. **[reasoned]**

And "parallel" is not parallel on one slot: llamafile serialises requests, so
four concurrent subagents queue. **[reasoned]**

### If you want subagents anyway

Give the subagents their own slot so they stop evicting the parent:

```bash
./bonsai.llamafile --server --gpu disable -c 32768 -np 2
```

llama.cpp divides the KV cache between slots, so `-np 2` wants roughly double
`-c` to keep the same usable window per slot — and roughly double the RAM.
**[documented — the division is upstream llama.cpp behaviour; not re-verified
here, so check `/props` reports the `n_ctx` you expect before relying on it.]**

Then keep subagent prompts genuinely short. A subagent whose prompt is 600
tokens costs about 105 seconds of prompt evaluation at 5.74 tok/s; one that
inherits a 5,000-token briefing costs about fifteen minutes, and you would have
been better off not delegating.

### What subagents are actually good for here

Not latency — **avoiding the context cliff**. Long sessions on a small window
fail in two documented ways: the reply allowance shrinks until the model is
allowed one token and returns nothing, and prompt evaluation eventually exceeds
whatever request timeout applies. A subagent that reads twenty files and returns
one paragraph keeps the *parent* session shallow, so the parent never reaches
either wall. That is a real benefit, and it is a different benefit from speed.

For this workshop specifically, cheaper levers come first, and the launcher
already uses all three: a short system prompt, `-nbt` to drop built-in tool
schemas, and a tool that returns ~20 facts instead of a raw email.

---

## 2. Recovering from broken tool calls

### What pi already does

- **Truncated JSON arguments are recovered.** pi parses streaming tool arguments
  tolerantly (`parseStreamingJson` / partial parse), and against a mock server
  returning `{"path": "…"` with no closing brace, pi executed the call and
  continued to a second turn. **[verified]**
- **An unknown tool name is fed back to the model.** pi emits
  `Invalid tool_call: "<name>". Available options are: … Please try again` as a
  tool result, so the model gets a correction rather than a dead end.
  **[documented — string present in the shipped binary]**
- **Agent-level retry is on by default**, `retry.maxRetries: 3`. **[documented]**
  This also explains something the investigation notes had recorded as
  unexplained: four identical requests reaching the server. That is one attempt
  plus three retries, not a bug.

### What pi does not do, and what we added

Schema validation failures are *not* auto-repaired: `{"file": "x.eml"}` when the
schema says `path` is simply invalid. On a cloud model, letting the model retry
is correct. Here a retry costs a full prompt evaluation — minutes — so it is
worth repairing recognisable near-misses before validation instead.

pi provides exactly the right hook: **`prepareArguments(args)` runs before schema
validation and before `execute()`**. **[documented]**

`extensions/lib/repair.ts` uses it. It handles what this model actually does:

| The model sends | Repair |
|---|---|
| `{"file": "x.eml"}` and other aliases | rename to `path` |
| `{"theEmailToCheck": "x.eml"}` | single key, single string — unambiguous |
| `"{\"path\": \"x.eml\"}"` | arguments arrived as a JSON string |
| `"x.eml"` | bare string wrapped as `{path}` |
| `{"path": ["x.eml"]}` | single-element array unwrapped |
| `{"arguments": {"path": …}}` | nested wrapper unwrapped |
| `{"path": 42}` | stringified |
| `{"path": "\"x.eml\""}` | surrounding quotes stripped |
| `{"path": "dir/'x.eml'"}` (quotes around only the filename) | matching pair stripped wherever it sits, not just at the string's outer edges |
| `{"path": "x", "verbose": true}` | extra keys dropped |
| `{"path": "x.eml",}` | trailing comma (`parseLooseJson`) |
| `{"path": "x.eml"` | truncated mid-object or mid-string |

The published schema stays strict — the model is still told exactly one correct
shape. This widens only what we tolerate.

**It is deliberately conservative, and that half matters more.** Input that is
not an obvious near-miss is returned untouched so validation produces a real
error. `{"first": "a.eml", "second": "b.eml"}` is ambiguous and left alone;
prose is not treated as a path; an empty path is not accepted. A repair layer
that accepts anything hides genuine model failures and invents calls nobody
made. Roughly a third of `extensions/lib/repair.test.ts` is negative cases for
that reason. **[verified — 33 tests, `npm test`]**

### Also worth having

`resolveEmlPath()` in `phish-triage.ts` handles the most common miss of all: the
model drops the directory and sends `04-auth-fail.eml`. That is a *valid* call
the schema accepts, so `prepareArguments` never sees it — it needs fixing at
execute time instead. Both layers are necessary.

---

## 3. Settings worth changing

`.pi/agent/settings.json` in this repo, so it is version-controlled and applies
only to the workshop:

```json
{
  "httpIdleTimeoutMs": 0,
  "retry": {
    "enabled": true, "maxRetries": 1, "baseDelayMs": 2000,
    "provider": { "timeoutMs": 3600000, "maxRetries": 0 }
  },
  "compaction": { "enabled": true, "reserveTokens": 6144, "keepRecentTokens": 3000 }
}
```

**`httpIdleTimeoutMs: 0`.** Default 300000, and pi's docs say "set to `0` to
disable". **[documented]** This corrects
[the investigation notes](investigation/README.md), which state the 300-second
request ceiling "is not configurable: nothing in pi's settings, `models.json` or
any environment variable exposes it". That was wrong — it is a documented
setting. Treat the correction as provisional in one respect: a deep-session run
with default settings survived 500 seconds without erroring **[verified]**, so
the ceiling may be idle-based rather than total, and the original 300s
observation may have come from `fetch`/undici in the measurement scripts rather
than from pi. Setting this to `0` is harmless either way.

**`retry.maxRetries: 1`.** Default 3. When a request takes twenty minutes, three
extra attempts is over an hour of identical failing work — and it presents as an
agent stuck in a loop. One retry keeps transient-error recovery without the
hour.

**`compaction`.** The defaults are `reserveTokens: 16384` and
`keepRecentTokens: 20000`. **[documented]** Both are larger than this workshop's
entire 16,384-token window, which makes auto-compaction inert: the trigger is
`contextTokens > contextWindow - reserveTokens`, i.e. `> 0`, while the cut-point
search wants 20,000 recent tokens it can never find. Sizing both below the window
is what makes automatic compaction possible at all.

**Resolved — compaction does fire with these values.** Earlier testing on the
slow local machine could not confirm this within the time available: at depth
10,995 with defaults, and with `reserveTokens: 6144` alone, no compaction entry
appeared before the run was cut off. Retested against a GPU-backed endpoint
running the same Bonsai-8B-Q1_0 model (~100x the local prompt-processing speed,
so a compaction call that would take minutes locally completes in seconds): a
synthetic session at depth 10,972 tokens, run with the settings above, produced
exactly one `compaction` entry with `tokensBefore: 10972` — the trigger firing
at precisely the depth engineered — and a well-formed structured summary.
**[verified]** The full turn, including the compaction call itself, took 11–15
seconds on that hardware. Locally, expect compaction to add a multi-minute
summarisation call on top of whatever the triggering turn already costs — real,
but no longer a mystery. `/compact` on demand remains the lower-latency choice
when you would rather control exactly when that cost is paid.

---

## 4. Verified against a real GPU-backed endpoint

Everything above up to the compaction result was developed against a CPU-only
local llamafile at 5.74 tok/s, which makes iteration slow and some questions
(does compaction fire? does the repair layer ever actually engage against a
real model, not a mock?) expensive to answer properly. Re-running the same
extension against the same Bonsai-8B-Q1_0 model on a GPU-backed OpenAI-compatible
endpoint (~100x the local prompt-processing speed) made a full verification pass
practical. Method: a second provider entry in a scratch `models.json` outside
this repo, with `apiKey` set to `"$SOME_ENV_VAR"` — pi's own environment
interpolation syntax — so no endpoint URL or token needed to touch a committed
file. If you have your own fast endpoint for this model, the same pattern works:
add a provider block per pi's [model configuration docs](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md) (shipped as `docs/models.md` inside the static build too) with your `baseUrl`
and an env-var `apiKey`, keeping the specifics out of version control.

**Correctness: 12/12.** Every one of `samples/synthetic/*.eml` got the verdict
its filename promises, with the right signal named, no fabricated header values,
appropriate hedging on the low-severity case (`05-no-auth-headers`), and no
false alarm on the clean control (`01-clean-newsletter`) or on a message whose
link is bad despite passing SPF/DKIM/DMARC (`08-homoglyph-punycode` — the model
correctly did not let a passing auth check override a live phishing link).
**[verified]**

**Two real bugs, found because a fast endpoint made it practical to actually try
things instead of reasoning about them:**

- `FALLBACK_DIRS` in `phish-triage.ts` was never updated when
  `samples/synthetic/` was added — asking about a bare filename from that
  directory failed to resolve. One-line fix.
- The quote-stripping repair only anchored at the very start/end of the whole
  string. A real prompt ("wrap the path in quotes when you call the tool") got
  the model to echo quotes around just the filename segment
  (`samples/synthetic/'02-...eml'`), which the old regex partially missed —
  it stripped the trailing quote but not the embedded leading one, leaving a
  path that could not resolve. Generalised to strip any quote character that
  occurs exactly twice anywhere in the string, which covers both the
  fully-wrapped and embedded case without guessing when three or more make the
  intent ambiguous. Both bugs have regression tests now. **[verified]**

**The repair layer does engage on real near-misses, and — just as importantly —
stays out of the way otherwise.** Instrumented logging across a batch of
naturally-phrased and mildly adversarial prompts showed: well-formed calls and
calls where the user's prose used the wrong field name (`file=...`) both passed
through with zero repairs, because Bonsai-8B is schema-driven — it read the
tool's declared parameter name and used `path` regardless of how the prompt
phrased it. Repairs engaged specifically when the model reproduced quoting
found in the prompt. **[verified]** This is a genuinely useful negative result:
a model this size did not need the alias-renaming or JSON-string-unwrapping
rules to fire in ordinary use, but the conservative design means they cost
nothing when unused and are ready for a different model or a longer session
where they might.

---

## Summary

| Want | Best lever here |
|---|---|
| Lower latency per turn | Keep the cache warm: `-np 1`, warm server, short system prompt, `-nbt`, small tool outputs |
| Avoid the long-session cliff | Fresh sessions between jobs; `/compact`; subagents for read-heavy fan-out |
| Survive slow prompt evaluation | `httpIdleTimeoutMs: 0`, `retry.maxRetries: 1` |
| Survive broken tool calls | `prepareArguments` + a conservative repair function, unit-tested |
| Genuine parallelism | More slots (`-np 2 -c 32768`) and the RAM to pay for it |

The one that pays best is the least glamorous: **keep the context small by
construction**. A tool returning twenty facts instead of a raw email is worth
more than any setting on this page.

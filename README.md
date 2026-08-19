# Local agents workshop — BSides Bristol 2026

Run a capable model on your own laptop, point an open source agent at it, and
extend that agent to do something you actually need. No API keys, no accounts,
and nothing leaving the machine in front of you.

**Session:** Friday 21 August 2026, 13:30–16:00, Workshops room.

By the end you should have a working pi extension of your own, published under
an open source licence so other people can install it.

---

## Before you arrive — please do this at home

The conference wifi will not survive forty people downloading gigabytes at once.
Everything below is a one-off download. **Do it before Friday.**

> **In a hurry?** [**BEFORE-YOU-ARRIVE.md**](BEFORE-YOU-ARRIVE.md) is the
> two-minute version: download a model, and if you have time, get pi. That is
> genuinely all you have to do. The rest of this page is the detail behind it.

### 1. This repository

```bash
git clone https://github.com/RichardoC/local-agents-workshop-bsides-bristol-2026
cd local-agents-workshop-bsides-bristol-2026
```

That is the whole clone: a few hundred kilobytes, including twelve sample emails
to work on.

<details>
<summary>Optional: 8,600 real phishing samples (422 MB)</summary>

There is a submodule of real phishing emails. It is genuinely optional — every
exercise works without it — but it is the interesting thing to point your own
signals at, so fetch it at home if you can:

```bash
git submodule update --init --depth 1
```

Or clone with `--recurse-submodules` in the first place. Do **not** attempt this
on conference wifi with forty other people.
</details>

### 2. pi

pi ships as a self-contained binary. **No Node.js, no npm, nothing to install** —
download, extract, done.

Take the file for your platform from the
[v0.84.2 release](https://github.com/earendil-works/pi/releases/tag/v0.84.2):

| Your machine | File |
|---|---|
| macOS, Apple silicon (M1–M4) | `pi-darwin-arm64.tar.gz` |
| macOS, Intel | `pi-darwin-x64.tar.gz` |
| Linux, x86-64 | `pi-linux-x64.tar.gz` |
| Linux, ARM | `pi-linux-arm64.tar.gz` |
| Windows, x86-64 | `pi-windows-x64.zip` |
| Windows, ARM | `pi-windows-arm64.zip` |

Extract it **inside this repository folder**, so that `pi/pi` exists
(`pi\pi.exe` on Windows). The launcher looks for it there.

macOS and Linux — the tarball already contains a `pi/` directory, so plain
extraction is enough:

```bash
tar -xzf pi-darwin-arm64.tar.gz      # adjust to the file you downloaded
./pi/pi --version                    # should print 0.84.2
```

Windows — **the zip is flat**, with `pi.exe` at its root rather than inside a
`pi\` folder. Extract it into a `pi` directory explicitly, or it will scatter
its files over this repository and overwrite our `README.md` and `package.json`
with pi's own:

```powershell
Expand-Archive -Path pi-windows-x64.zip -DestinationPath .\pi
.\pi\pi.exe --version              # should print 0.84.2
```

The launcher finds it there by itself. Installed pi some other way? Also fine —
anything on your `PATH`, or set `PI_BIN=/path/to/pi`.

<details>
<summary>Verifying the download — worth doing, at a security conference</summary>

The release includes `SHA256SUMS`. Download it alongside the archive:

```bash
sha256sum -c --ignore-missing SHA256SUMS          # Linux
shasum -a 256 -c --ignore-missing SHA256SUMS      # macOS
```

```powershell
Get-FileHash pi-windows-x64.zip -Algorithm SHA256   # compare against the file
```

You are about to run a binary from the internet, which will then run TypeScript
from a repository you also got from the internet. Checking the hash is the cheap
half of that problem. The other half is reading the extension source, which is
about 1,900 lines and part of the point of the afternoon.
</details>

<details>
<summary>Optional: Node.js 22.6+</summary>

**Not required.** pi bundles everything an extension imports — `typebox`, its own
types — so extensions run with no `npm install` at all.

Node unlocks two extras: `npm test`, and `npm run triage`, a command-line version
of the analyser. Already have Node 22.6+? You get them for free. If not, ignore
this: `/phish` inside pi does the same job.
</details>

### 3. A model — pick one

Two are configured and both work correctly. The real trade-off is download size
against speed.

| | **Bonsai 8B** | **Granite 4.1 3B** |
|---|---|---|
| Download | **1.41 GiB** | 2.93 GiB |
| Quantisation | Q1_0 — one bit per weight, extremely aggressive | Q6_K — near-lossless |
| Parameters | 8 billion | 3.4 billion |
| Prompt speed, CPU-only laptop | 5.8 tok/s | **30 tok/s** |
| RAM at the 16k window we use | **3.3 GiB** | 4.1 GiB |
| Native context | 65,536 | **131,072** |
| Verdict accuracy on our test set | 38/38 | 38/38 |
| Model id for `--model` | `bonsai-8b` | `granite-3b` |

Both were correct on everything we tested, so this is not about accuracy. It is
about speed: measured on a CPU-only machine with no GPU, **Granite processes
prompts about five times faster**, which is the difference between an agent that
feels usable and one that feels stuck. Counter-intuitive given it has fewer than
half the parameters — Q1_0 saves disk and spends it on arithmetic.

**Take Granite if you can afford the 2.93 GiB download** — it is the configured
default. Take Bonsai if you cannot: metered connection, slow line, no time before
Friday. You give up speed rather than correctness. You do not have to tell the
launcher which one you chose; it asks the server.

Measurements — RAM at every window size, speed, and what happens at full
context — are in [docs/model-comparison.md](docs/model-comparison.md).

**Bonsai 8B** (the default):

```bash
curl -L -o bonsai.llamafile \
  "https://richardoc-llamafile-generator.hf.space/download?model=prism-ml%2FBonsai-8B-gguf%3ABonsai-8B-Q1_0.gguf&version=latest&mode=auto"
chmod +x bonsai.llamafile
```

**Granite 4.1 3B**:

```bash
curl -L -o granite.llamafile \
  "https://richardoc-llamafile-generator.hf.space/download?model=unsloth%2Fgranite-4.1-3b-GGUF%3Agranite-4.1-3b-Q6_K.gguf&version=latest&mode=auto"
chmod +x granite.llamafile
```

On Windows, add `.exe` to whichever you downloaded — `bonsai.llamafile.exe` or
`granite.llamafile.exe`.

Those URLs build the llamafile on demand from a GGUF on Hugging Face, via
[RichardoC/llamafile-generator](https://huggingface.co/spaces/RichardoC/llamafile-generator).
Two things about it are worth knowing before Friday:

- It is rate limited to **5 builds per IP per hour, 2 concurrent**. Forty people
  on one conference network share a single public IP. This is the strongest reason
  in this document to download at home.
- Nothing is cached server-side; each request rebuilds and restreams. If the Space
  is asleep the first request also pulls the ~320 MB loader, so give it a minute.

<details>
<summary>If your machine is too slow to run a model at all</summary>

There is a `hosted` provider in `.pi/agent/models.json` for exactly this. It
ships as a **placeholder** — `baseUrl` says `REPLACE-ME` — and is invisible to pi
until both the URL is filled in and a token is present, so it cannot get in your
way if it is unused.

If a hosted endpoint has been set up for the session:

```bash
export HF_TOKEN=hf_...
WORKSHOP_PROVIDER=hosted WORKSHOP_MODEL=granite-3b-hosted ./pi-workshop.sh
```

```powershell
$env:HF_TOKEN = "hf_..."
$env:WORKSHOP_PROVIDER = "hosted"; $env:WORKSHOP_MODEL = "granite-3b-hosted"
.\pi-workshop.ps1
```

No local server is needed on this path, and the launcher skips the health check.
The token is read from the environment and never written to a file — do not paste
it into `models.json`, which is committed.

Everything else behaves identically, because the endpoint runs the same
llama.cpp server the local llamafile does. Two things to expect: an endpoint
scaled to zero returns HTTP 503 for a minute or two while it wakes, and the
`contextWindow` in the config must match whatever the endpoint actually serves
(`curl -s -H "Authorization: Bearer $HF_TOKEN" <host>/props | grep -o '"n_ctx":[0-9]*'`).
</details>

<details>
<summary>Using a different model entirely</summary>

Any GGUF on Hugging Face works — point the generator at
`owner/repo:path/file.gguf` and add a matching entry to
`.pi/agent/models.json`. Check it first without downloading gigabytes:

```bash
curl "https://richardoc-llamafile-generator.hf.space/api/validate?model=owner/repo:file.gguf&version=0.10.5"
```

The one hard requirement is that the GGUF's chat template supports **tool
calling** — without it the extension's tool is never invoked and the whole
exercise collapses into a chatbot. Once the server is running, check with:

```bash
curl -s http://127.0.0.1:8080/props | grep -o '"supports_tools":[a-z]*'
```

Note the base model repo (`ibm-granite/granite-4.1-3b`) holds `.safetensors`,
not GGUF. You want a quantised repo — usually `unsloth/…-GGUF` or
`bartowski/…-GGUF`.
</details>

Then check it starts:

```bash
./bonsai.llamafile --version
```

If Linux or WSL answers with `Exec format error` or
`run-detectors: unable to find an interpreter`, that is not a corrupt download.
A llamafile is an [APE binary](https://justine.lol/ape.html) — one file that runs
on several operating systems — and some Linux installs (notably any with WINE
registered) hand the file to the wrong interpreter because of its `MZ` header.
Run it through the shell instead, which works everywhere:

```bash
sh ./bonsai.llamafile --version
```

### 4. Check it all worked

```bash
./doctor.sh                   # macOS, Linux, Git Bash
.\doctor.ps1                  # Windows PowerShell
```

This is the one thing worth running before you leave home. It checks the things
that otherwise fail *silently* — a context window that does not match, a proxy
intercepting requests to your own machine, a truncated model download, a server
running four slots instead of one — and tells you the exact command to fix each.
Green across the board means Friday will be about extensions, not setup.

---

## Running it

Two terminals. In the first, start the model server and leave it running —
**the same command whichever model you downloaded**:

```bash
./bonsai.llamafile  --server --gpu disable -c 16384 -np 1     # Bonsai
./granite.llamafile --server --gpu disable -c 16384 -np 1     # or Granite
```

It takes a minute or two to load the weights before it will answer anything.

In the second, start the agent. Bonsai is the default, so if that is what you
downloaded there is nothing to choose:

```bash
./pi-workshop.sh              # macOS, Linux, Git Bash
.\pi-workshop.ps1             # Windows PowerShell
```

**You do not normally need to say which model you are using.** The launcher asks
the server which weights it loaded and matches them, printing what it chose:

```
Using --model bonsai-8b: the server has Bonsai-8B-Q1_0.gguf loaded.
Set WORKSHOP_MODEL to override.
```

Override it if you want to:

```bash
WORKSHOP_MODEL=granite-3b ./pi-workshop.sh
```

```powershell
$env:WORKSHOP_MODEL = "granite-3b"; .\pi-workshop.ps1
```

That auto-detection exists because the mismatch is otherwise **silent**, and this
is the one to understand rather than skim. llamafile serves whatever weights it
loaded and ignores the model name in the request, so running the Granite llamafile
while pi is told `bonsai-8b` gives you Granite's answers labelled as Bonsai — with
Bonsai's sampling applied, since the two are configured differently. No error, no
warning, and a plausible answer either way. `./doctor.sh` and `.\doctor.ps1` both
report which weights the server actually has loaded.

Then ask it something:

```
Is samples/synthetic/09-href-text-mismatch.eml a phishing email?
```

You should get back something along these lines — the agent calls the tool, then
writes its verdict from the signals that come back:

> The email file `samples/synthetic/09-href-text-mismatch.eml` appears to be a
> phishing email. [...] The most notable finding is a **high signal** indicating
> a mismatch between the link text ("www.northgate-bank.example") and the actual
> destination ("sess-4471.tracking-hop-19.example"), which is a classic phishing
> tactic.

Every claim there traces back to a deterministic check. Nothing was guessed.

Worth trying next, because it is the harder test:

```
Is samples/synthetic/01-clean-newsletter.eml a phishing email?
```

That one is legitimate and the tool raises nothing. A triage tool that flags
everything is worse than no tool, because people stop reading it — so the model
has to be willing to say "this looks fine". Watch whether yours does.

The launcher uses the model configuration committed in this repository
(`.pi/agent/models.json`) rather than anything in your home directory, so it does
not disturb an existing pi setup. Delete the folder and every trace of the
workshop is gone.

### If your model will not start

You are not stuck, and you do not have to sit and watch. The deterministic half
of this workshop is the half that does the work, and it needs no model, no
server and no download:

```bash
./pi-workshop.sh --no-model
```

Then, inside pi:

```
/phish samples/synthetic/06-brand-in-subdomain.eml
```

You get the full report with no model in the loop at all. Every exercise up to
and including "write your own signal" works this way; you can develop, test and
publish an extension without ever loading a model. The agent is the last mile,
not the foundation.

With Node installed there is also a command-line version, handy for running over
the whole set at once:

```bash
npm run triage -- samples/synthetic/*.eml
```

---

## The flags that are not optional

Three of these were found the hard way. Each one fails silently rather than with
an error message, which is exactly why they are worth knowing.

**`-c 16384`.** pi decides how many tokens the model may reply with using:

```
room for the reply = contextWindow - (tokens used so far) - 4096
```

That 4096 is a fixed safety margin in pi, and the result is floored at **1**, not
at zero. So if the declared context window is *also* 4096, the sum is negative,
the floor kicks in, and the model is told it may emit exactly one token. It emits
one, stops, and pi prints *nothing at all* — no error, no warning. It looks
completely broken.

The `-c` value must match `contextWindow` in `.pi/agent/models.json`; both are
16384 here. Change one, change the other.

There is no way to make pi omit the limit entirely: it is always sent, and the
one code path that skips the clamp requires `contextWindow: 0`, which the config
loader rejects outright as invalid.

### The same arithmetic kills long sessions

This is worth understanding properly, because it is the single most confusing
thing you are likely to hit, and it arrives after everything has been working
fine for half an hour.

The allowance shrinks as the conversation grows. We measured what pi actually
sends, against sessions built at known depths on a 16384-token window:

| Conversation depth | Reply allowance sent | What you see |
|---|---|---|
| 2,000 | 6,888 | fine |
| 7,974 | 4,290 | fine |
| 10,861 | 1,403 | fine |
| 11,962 | **302** | long answers cut off mid-sentence |
| 12,978 | **1** | **nothing at all** |

It is a straight line, not a cliff edge you can feel coming: allowance is
`contextWindow − depth − 4096 − overhead`, and it simply runs out. At the bottom
the agent returns an empty response and **exit code 0** — a success, with no
output and no error.

Depth is not measured from the text, incidentally. pi reads `usage.totalTokens`
off the last assistant message in the session file, so it is a recorded number
rather than a recount.

**Where the wall sits depends on your overhead.** With a lean setup it is around
three-quarters of the window; with pi's full default system prompt and every
built-in tool schema in play, the fixed overhead is larger and the wall arrives
closer to two-thirds. That is one more reason the launcher uses `-nbt` and a
short system prompt — both push the wall further away.

**What to do about it:**

- `/compact` when replies start getting shorter. Compaction is manual — nothing
  triggers it automatically, and you get no warning as you approach the limit.
- Start a fresh session between unrelated jobs. Cheap, and it resets the depth.
- Raise `-c` and `contextWindow` together if you have the RAM. Every extra token
  of window is an extra token of runway.
- Keep tool output small. `phish_triage` returns roughly twenty facts rather than
  the raw email precisely so that a session lasts.

### The other long-session failure: repeated identical requests

There is a second, separate way depth breaks things, and this one is what people
usually mean when they say the agent "started looping".

Out of the box, pi gives each request a 300-second **idle** timeout. Prompt
processing on a slow machine runs at a few tokens per second, so a deep
conversation takes far longer than that to evaluate — we measured a cold
12k-token prompt at 3.5 tokens/second, still only 49% processed after 19 minutes.
Worse, prompt processing sends no bytes at all while it works, so an idle timeout
is exactly the wrong shape for it: the request is abandoned at 300 s, the
identical request goes out again, and it fails at the same point.

From the outside this looks exactly like an agent stuck in a loop: the same work,
over and over, no progress. It is not the model, and it is not the sampler —
turning up `repeat_penalty` does nothing for it (we tried).

The critical detail is **cold versus warm**. With `-np 1` and the server left
running, each turn only evaluates the *new* tokens, which stays comfortably under
the timeout. Everything that forces a full re-evaluation is dangerous on a slow
machine:

- resuming or forking a deep session (`--continue`, `--resume`, `--fork`)
- restarting the model server, which discards the cache
- anything that evicts the prefix, which is what multiple slots do — hence `-np 1`

**This repository already defuses it**, which is worth knowing before you spend
an afternoon on the symptom. `.pi/agent/settings.json` sets `httpIdleTimeoutMs: 0`,
which disables the idle timeout, and `retry.provider.timeoutMs: 3600000`, which
gives a request an hour. Confirmed on the wire — pi sends `X-Stainless-Timeout:
3600`. It also sets `retry.maxRetries: 1`, so a genuine failure is two attempts
rather than four.

The consequence is that a slow prompt now *waits* instead of timing out, which is
the behaviour you want, and the failure mode changes shape: instead of
`Request timed out` you get a turn that takes minutes and looks like a hang. That
is why the advice below still matters — the levers that keep evaluation short are
a warm cache, a smaller context, `/compact` and faster hardware. They are just no
longer the difference between working and not working.

If you see `Request timed out` anyway, you are not picking up this repository's
settings: check you launched from the repo root.

On a laptop with a working GPU this may never appear: at 100+ tokens/second a 12k
prompt is roughly thirty seconds, nowhere near the limit. It is very much a
slow-machine failure, which is why it can look intermittent across a room.

**`-np 1`.** llamafile defaults to four parallel slots and hands each request to
whichever is free. An agent makes a sequence of calls that share a growing
prefix, so bouncing between slots throws away the KV cache and reprocesses the
entire conversation every turn. With one slot the cache is reused: in our
testing the second turn went from reprocessing 1149 tokens to processing 307 new
ones. On a laptop that is the difference between snappy and apparently frozen.

**`--gpu disable`.** Only needed if the server crashes on startup with a Vulkan
or driver error. If your GPU works, leave it off and enjoy the speed.

If the agent seems to hang, check `NO_PROXY` includes `127.0.0.1` — a corporate
proxy will otherwise intercept requests to your own machine. The wrapper scripts
set this for you.

### Sampling

Sampling is pinned per model in `.pi/agent/models.json`, with a note next to each
value saying where it came from. pi merges `samplingParams` verbatim into every
request, so what is written there is what the server gets.

The two models are configured differently, on purpose, because their vendors say
different things:

```json
"granite-3b": { "temperature": 0, "top_p": 1.0, "top_k": 0, "min_p": 0.0, "repeat_penalty": 1.0 }
"bonsai-8b":  { "temperature": 0.2, "top_p": 0.9, "top_k": 20, "min_p": 0.0, "repeat_penalty": 1.0 }
```

Granite is **greedy**, because that is IBM's declared default — its
`generation_config.json` sets no sampling fields at all and every official
example calls `generate()` with no sampling arguments, which in transformers
means `do_sample=False`. Bonsai follows its model card, which does publish a
table (top-k 20, top-p 0.9, repetition penalty 1.0), except for temperature: the
card suggests 0.5 and we use 0.2, because the job is reporting what a tool found
rather than writing prose. An A/B at 0.6 across 25 real messages produced no
improvement and some new garbles.

**`min_p` is the one to notice.** Neither card mentions it, and it is tempting to
conclude it is therefore off. It is not: llama.cpp defaults `min_p` to `0.05`,

```c
float   min_p              = 0.05f;  // 0.0 = disabled   — common/common.h
```

so a config that sets `temperature` and `top_p` but says nothing about `min_p`
leaves a truncation sampler running that nobody chose. Setting it to `0` is what
actually makes greedy greedy. The general lesson is worth more than the specific
value: **an unspecified sampler is not a disabled one**, and the only way to know
is to read the server's defaults.

`repeat_penalty` is worth a note, because raising it is the obvious guess when an
agent starts looping and it is the wrong lever. We tested 1.05, 1.15 and 1.30
with the built-in tools enabled: all three answered correctly in two turns, and
the wall-clock differences turned out to be a cold-versus-warm cache artifact —
re-running the 1.05 baseline with a warm cache matched the 1.30 time to within a
few seconds. Repetition penalties only look back a limited window (64 tokens by
default), so they cannot see a previous tool call on the other side of a tool
result. If your agent loops, fix the system prompt and check `-np 1`; leave the
sampler alone.

### On speed

The workshop machines will be faster than the one this was built on: a 4-core
cloud VM with no GPU at all, where Granite processed prompts at about 30
tokens/second and Bonsai at about 5.8. A laptop with Metal or a modern GPU is
typically far quicker. For scale, a full triage of one message end-to-end —
launcher, tool call, model explanation — took **42 seconds** on that VM with
Granite.

If a first response takes a while, that is prompt processing, not a hang — watch
the server terminal and you will see it counting.

---

## What's in here

```
extensions/
  lib/eml.ts          .eml parser      — node: built-ins only, no dependencies
  lib/signals.ts      signal detection — node: built-ins only, no dependencies
  lib/verdict.ts      the ASSESSMENT line the model is told to follow
  lib/repair.ts       repairs near-miss tool arguments before validation
  lib/*.test.ts       tests            — node:test, no framework
  phish-triage.ts     the pi extension — a thin wrapper over the libraries
templates/starter/       copy this to begin your own extension (a TOOL)
templates/starter-skill/ copy this to begin your own extension (a SKILL)
skills/stride-threat-model/  a worked skill: STRIDE over a design document
skills/write-a-skill/    a skill that helps you write your own skill
tools/
  make-samples.mjs    regenerates the synthetic samples
  triage-cli.ts       run the analyser from the shell, with no agent at all
doctor.sh/.ps1        setup check — run this first if anything misbehaves
pi-workshop.sh/.ps1   the launcher: finds pi, sets the config, loads extensions
workshop-system-prompt.md  the short system prompt the launcher uses
.pi/agent/models.json model config, committed so nobody edits their home directory
.pi/agent/settings.json    timeout, retry and compaction values for a slow model
samples/synthetic/    12 samples we wrote, MIT, built around one signal each
samples/phishing_pot  optional submodule of 8,600 real emails (see Credits)
```

The wrapper scripts replace pi's default system prompt with
`workshop-system-prompt.md`. pi's built-in prompt is written for large cloud
models — it is long, which costs real time when your laptop is processing a
couple of thousand tokens before it says anything, and a small model given that
much instruction tends to loop instead of answering. A short, task-focused
prompt is markedly better here. It is a plain markdown file; edit it and see what
changes.

Run the tests with no build step and no install:

```bash
npm test
```

---

## The idea worth taking away

A model small enough to run on your laptop will invent things if you ask it to
parse. Ask it to *judge* a handful of facts you extracted yourself and it does
well. So the work splits three ways:

| File | Job | Model involved? |
|---|---|---|
| `lib/eml.ts` | Parse the message | No |
| `lib/signals.ts` | Decide what is suspicious | No |
| `phish-triage.ts` | Summarise and explain | Yes |

`phish_triage` hands the model about twenty pre-computed facts — who the message
claims to be from, what the receiving server concluded about SPF/DKIM/DMARC,
whether the link text agrees with the link target — and nothing else. The model
never sees the raw email. That is what makes a small local model useful rather
than merely present.

Across all 8,614 real samples in the corpus, the deterministic checks alone raise
at least one signal on **62.5%** of them, and a high-severity one on 29.1%, at
about 1 ms each.

**Read that as recall, not accuracy**, because the corpus is 100% phishing — it is
a honeypot collection with no legitimate mail in it. So 62.5% is "how much
phishing we catch with no model", and the matching precision number — how often we
are wrong about legitimate mail — is one we cannot compute, because we have no
legitimate mail to test against. Every figure in this repository was measured for
recall and eyeballed for precision. That is a real limitation and it is worth
knowing before quoting any of it.

Those numbers used to be higher — 69% and 41% — until the checks were measured
against the corpus properly. `brand_in_subdomain` alone was firing on 11.7% of
all mail, and 97% of those hits were the impersonated brand's *own* servers.
Calibrating it down to 0.2% is the single biggest improvement in this repo, and
the exercise that found it is in the run of show.

Note how that was found, since it bears on the caveat above: not by measuring
precision, which the corpus cannot support, but by *reading* the hosts it fired on
and recognising `storage.googleapis.com`. Eyeballing 1,038 hits is a poor
substitute for a ham corpus, and it still found a bug that a passing test suite
did not.

The model earns its place on the other 37.5%, and on turning a list of signals
into something a human can act on.

### Signals detected without a model

Sender/Reply-To/Return-Path divergence, display names containing a different
address, recorded SPF/DKIM/DMARC verdicts, brand names appearing outside the
brand's own domain, lookalike domains by edit distance and by confusable-character
skeleton, non-ASCII homoglyph
domains, link text disagreeing with the link target, executable and
double-extension attachments, right-to-left override characters in filenames,
and attachments whose leading bytes contradict their declared type.

`lookalike_domain` is the one to argue about, and the argument is the lesson.
Tuned for precision it fired on **one** message in 8,614 — technically accurate
and useless. It now runs two tests: a *confusable skeleton*, which folds the
characters attackers substitute for visual similarity (`0`/`o`, `1`/`l`, `rn`/`m`)
onto one representative and compares for equality, and a deliberately loose
*edit distance*. The skeleton catches `rnicrosoft` → `microsoft`, which is two
edits and therefore invisible to any distance threshold a real corpus tolerates.

The distance half does produce false positives — `mega.nz` against "meta",
`hsb.com` against "hsbc", `coingate.com` against "coinbase". They are reported at
`medium`, never `high`, because **severity is where the confidence lives**. A
detector tuned until it never fires catches nothing; one that shouts about
everything gets ignored. Six real false positives you can explain are a better
teacher than silence, and improving them is one of the exercises.

The homoglyph check is the neatest of them. Node's URL parser applies IDNA
automatically, so this is the whole detection:

```ts
new URL("http://pаypal.com").hostname   // → "xn--pypal-4ve.com"
```

That `а` is Cyrillic U+0430. If `xn--` shows up in the parsed hostname but not in
the text you started with, the domain was never ASCII.

### One signal at a time

Real phishing trips five checks at once, which teaches you nothing about any of
them individually. So `samples/synthetic/` has twelve messages we wrote, each
built *around* one signal:

| File | Signal |
|---|---|
| `01-clean-newsletter.eml` | none — the control |
| `02-reply-to-mismatch.eml` | `reply_to_mismatch` |
| `03-display-name-spoof.eml` | `display_name_is_different_address` |
| `04-auth-fail.eml` | `spf_fail`, `dkim_fail`, `dmarc_fail` |
| `05-no-auth-headers.eml` | `auth_results_absent` |
| `06-brand-in-subdomain.eml` | `brand_in_subdomain` |
| `07-lookalike-domain.eml` | `lookalike_domain` |
| `08-homoglyph-punycode.eml` | `punycode_link` |
| `09-href-text-mismatch.eml` | `href_text_mismatch` |
| `10-executable-attachment.eml` | `dangerous_attachment` |
| `11-rtl-override-filename.eml` | `rtl_override_filename`, `dangerous_attachment` |
| `12-attachment-type-mismatch.eml` | `attachment_type_mismatch` |

Two of them raise more than one signal — `04` records three failed
authentication verdicts, and `11` is both an RTL-override filename *and* an
executable — so if you are predicting the output, predict a set rather than a
single answer. An `.exe` hidden behind a reversed filename genuinely is two
problems.

Open the `.eml` in a text editor, work out what should fire, then check yourself
with `/phish`. They are a few kilobytes each and MIT licensed, so you can copy
them into whatever you build. Every domain uses the reserved `.example` TLD, so
none of them can point at a real organisation even by accident.

Start with `01`. It is legitimate, and the correct output is silence.

### Skills: the no-code path

Two skills ship here. `write-a-skill` interviews you and writes a skill for you;
`stride-threat-model` is a worked example that produces a STRIDE table from a
design document. Neither is code, and you can publish one without writing any.

```bash
./pi-workshop.sh -p "/skill:stride-threat-model skills/stride-threat-model/example-design.md"
./pi-workshop.sh -p "/skill:write-a-skill"
```

**The `/skill:<name>` prefix is not optional, and this is the thing nobody guesses.**
pi loads skills by progressive disclosure: only a skill's name and description sit
in the system prompt, and the agent is expected to fetch the body with the built-in
`read` tool when a task matches. The launcher passes `-nbt`, which removes that
tool — so without the prefix the body never loads. The symptom is not an error. The
model improvises, or grabs whatever tool it does have, and you get a confident
answer in the wrong format.

Each skill has a `README.md` next to it explaining what it does and why it is
written the way it is. That separation is deliberate: anything inside `SKILL.md` is
text the model may echo into its answer.

### What we deliberately do not do

No DNS, no WHOIS, no URL reputation, no hash lookups. Everything happens offline,
on data already in the file. That means the SPF/DKIM/DMARC values are what the
receiving server recorded *at delivery time* — we are reading a verdict, not
re-checking one. Re-verification is a good thing to add at work; it is a bad
thing to depend on at a conference.

---

## Build your own

Start from the template rather than a blank file. It is a complete, working
package — tool, slash command, tests, licence, `package.json`:

```bash
cp -r templates/starter ../my-extension
cd ../my-extension
../local-agents-workshop-bsides-bristol-2026/pi/pi -e ./extensions/my-tool.ts
```

Ask it "how many words are in README.md?" and it works immediately. Then start
replacing the middle.

`/reload` inside pi picks up your edits without restarting. The launcher also
loads anything in this repo's `extensions/`, so dropping a file there is enough
if you would rather work in place.

**No `npm install` required.** pi bundles what extensions import — `typebox`,
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`
— plus every `node:` built-in. You only need a `node_modules` if you reach for
something outside that list.

### The one structural rule

Keep the deterministic core in `lib/`, importing **nothing** but `node:` modules:

```
extensions/
  lib/analyse.ts        the real work — no pi, no typebox, testable with node --test
  lib/analyse.test.ts   fast, offline, no model
  my-tool.ts            thin pi wrapper: parameters in, labelled text out
```

Three reasons, in increasing order of importance: it runs in CI, it keeps working
when the model server does not, and `npm test` can actually load it — bare Node
cannot resolve `typebox`, because that comes from inside pi.

Ideas that suit this treatment: log and alert triage, honeypot session summaries,
`gitleaks` false-positive triage, shadow-AI scanning of a repository, firmware
`strings` triage, ADS-B anomaly narration, ICS asset inventory summaries.

## Publish it

Do this **early**, while your tool is still a stub. Publishing takes five minutes
when nothing is on fire and twenty when you are also debugging.

```bash
git init -b main && git add -A && git commit -m "Initial extension"
git remote add origin https://github.com/<you>/<your-repo>
git push -u origin main
```

Anyone can then install it straight from the repository — git is a first-class
package source, so no npm publish is involved:

```bash
pi install https://github.com/<you>/<your-repo>
```

Three things make that work, and the template already has all three:

```json
{
  "name": "my-package",
  "license": "MIT",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions"] }
}
```

...plus an actual `LICENSE` file. Without one, your repository is visible but not
open source, and nobody can safely use it.

Add the repository topic **`bsides-bristol-2026`** so the room can find each
other's work afterwards — then go and install a neighbour's.

---

## Credits and licensing

The code in this repository is MIT licensed.

The email samples in `samples/phishing_pot` come from
[Phishing Pot](https://github.com/rf-peixoto/phishing_pot) by rf-peixoto and are
licensed **CC BY-NC 4.0**. They are included as a git submodule rather than
copied in, so this repository does not redistribute them and you are getting
them from the original author. That also means the non-commercial term applies
to those samples, not to anything you write here.

Please don't feed the samples into a live mail system.

---

## Tuning pi for a small model

`.pi/agent/settings.json` in this repository carries a few values that matter
when the model is slow. They are already applied by the launcher, but they are
worth understanding rather than copying:

```json
{
  "httpIdleTimeoutMs": 0,
  "retry": { "maxRetries": 1, "provider": { "timeoutMs": 3600000 } },
  "compaction": { "reserveTokens": 6144, "keepRecentTokens": 3000 }
}
```

- **`retry.maxRetries: 1`** — the default is 3. When a request takes twenty
  minutes, three extra attempts is over an hour of identical failing work, and it
  looks exactly like an agent stuck in a loop.
- **`compaction`** — the defaults are `reserveTokens` 16384 and
  `keepRecentTokens` 20000, and both are at or above this workshop's entire
  16,384-token window. The two break it in different ways, which is worth
  separating because only one of them is the reason nothing happens.

  Compaction triggers when `contextTokens > contextWindow - reserveTokens`. At a
  16,384 window with 16384 reserved that threshold is **zero**, so the trigger is
  always true from the first message. Then, to decide what to summarise, pi walks
  backwards from the newest message keeping `keepRecentTokens` of it — and 20,000
  is more than the window can hold, so the walk keeps *everything* and there is
  nothing left to summarise.

  So the trigger fires constantly and then does nothing: **`keepRecentTokens` is
  what makes it inert**, not `reserveTokens`. Both have to sit below the window.
  6144 and 3000 give a trigger at 10,240 tokens and keep the last 3,000, which
  behaves as intended.
- **`httpIdleTimeoutMs: 0`** — pi's HTTP idle timeout, 300 s by default, and `0`
  disables it. This is an **idle** timeout, not a total one: it measures the gap
  between bytes, so a streaming response that is slow but still arriving does not
  trip it. What does trip it is prompt processing, where the server accepts the
  request and sends nothing at all for minutes while it works through a long
  prompt. On a slow CPU that is exactly the shape of a normal first request, so
  the ceiling comes off. Keeping the context small remains the real fix.

One counter-intuitive finding worth knowing before you reach for it: **pi's
subagent extension will usually make things *slower* here.** On a single-slot
server the KV cache is what keeps turns cheap, and every subagent is a cache miss
that also evicts the parent's prefix — one cheap incremental turn becomes two
expensive cold ones. Subagents are the right tool for avoiding the long-session
context cliff, not for latency.

---

## Running the workshop yourself

The facilitator run of show — timings, what to say when, a symptom-to-fix triage
table, and contingencies for no wifi or a machine that cannot run the model — is
in [RUNSHEET.md](RUNSHEET.md). The material is MIT licensed; take it and run it
at your own event.

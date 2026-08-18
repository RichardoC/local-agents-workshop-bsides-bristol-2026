# Which model? Bonsai 8B Q1_0 vs Granite 4.1 3B Q6_K

**Short answer: either. Pick on download size.** They scored the same on every
correctness measure we could construct, and the difference that remains is
structural rather than qualitative.

Both are configured in `.pi/agent/models.json`, so switching is one environment
variable.

## The numbers

| | Bonsai 8B | Granite 4.1 3B |
|---|---|---|
| GGUF | `prism-ml/Bonsai-8B-gguf : Bonsai-8B-Q1_0.gguf` | `unsloth/granite-4.1-3b-GGUF : granite-4.1-3b-Q6_K.gguf` |
| llamafile download | **1,509,507,986 bytes (1.41 GiB)** | 3,146,466,204 bytes (2.93 GiB) |
| Parameters | 8B (Qwen3-8B base) | 3.4B |
| Quantisation | **Q1_0** — one bit per weight | **Q6_K** — near-lossless |
| Native context | 65,536 | **131,072** |
| Tool calling | yes | yes |
| pi model id | `bonsai-8b` | `granite-3b` |

Measured on a GPU-backed endpoint serving each model, 38 emails each (all 12
synthetic samples, 6 real messages that raise zero signals, and 20 spread across
the 8,614-message corpus), graded against the deterministic engine's own output:

| | Bonsai 8B | Granite 4.1 3B |
|---|---|---|
| Verdict correct (phishing vs unremarkable) | **38/38** | **38/38** |
| False positives on zero-signal messages | 0 | 0 |
| Missed a signal-bearing message | 0 | 0 |
| HIGH signals correctly conveyed | 27/31 (87%) | 26/31 (83%) |
| Claimed a DNS/WHOIS/reputation check it did not do | 0 | 1 |
| Median answer length | 58 words | 51 words |

The 87% vs 83% gap is four signals out of thirty-one. At that sample size it is
noise, and we are not going to pretend otherwise.

## Speed and memory, measured on the real llamafiles

The correctness numbers above came from a GPU-backed endpoint. That says nothing
useful about a laptop, so both llamafiles were also run locally on a 4-core
CPU-only VM with no GPU — the pessimistic case, and the one that hurts.

`--gpu disable -np 1`, llamafile 0.10.5, figures taken after a real inference
request. Speed is consistent across three context sizes each, so it is a property
of the models, not of one run.

| | Bonsai 8B Q1_0 | Granite 4.1 3B Q6_K |
|---|---|---|
| Prompt processing | 5.5–5.9 tok/s | **28.9–32.0 tok/s** |
| Generation | 3.3–3.5 tok/s | **6.7–7.8 tok/s** |

**Granite is roughly five times faster at prompt processing and twice as fast at
generation, on the same machine.** That is the opposite of what the parameter
counts suggest, and it is the single most consequential difference between them.
Prompt processing is what makes a local agent feel broken: at 5.8 tok/s a
2,000-token conversation costs about six minutes before the model says anything,
and it is what drives the request timeouts described in the README. At 30 tok/s
the same turn is about one minute. Q1_0 saves bytes on disk and spends them on arithmetic.

### RAM at a 10,240-token window

| | Bonsai 8B Q1_0 | Granite 4.1 3B Q6_K |
|---|---|---|
| Resident total (what `top` shows) | **2.47 GiB** | 3.43 GiB |
| — anonymous: KV cache and buffers | 1.46 GiB | **0.82 GiB** |
| — file-backed: mmapped weights | 1.01 GiB | 2.61 GiB |
| KV cache per 1,000 tokens | 140.7 MiB | **78.1 MiB** |

The split matters more than the total. **Anonymous memory cannot be evicted** —
under pressure the kernel has nowhere to put it, and you get an OOM kill or
swap-death. **File-backed weight pages can be dropped and re-read**, so pressure
there makes things slow rather than fatal. Bonsai has the smaller footprint
overall; Granite has less of the dangerous kind.

The KV figures are not mysterious. Bonsai is `qwen3`, 36 layers × 8 KV heads ×
128 head dim × 2 (K and V) × 2 bytes = 144 KiB/token. Granite is 40 layers × 8 ×
**64** × 2 × 2 = 80 KiB/token — half the head dimension is doing all the work.
Measured 140.7 and 78.1 KiB/token respectively, so the arithmetic holds and you
can predict any window size from it.

### RAM at full context

Each model at its own native maximum, on a 16 GB machine:

| | Bonsai @ 65,536 | Granite @ 131,072 |
|---|---|---|
| Resident total | 10.07 GiB | **12.66 GiB** |
| — anonymous (KV) | 9.06 GiB | 10.05 GiB |
| — weights still resident | 1.01 GiB | **1.7 MiB** |
| llamafile warned it could not fit | no | **yes** |

Both loaded and answered correctly. But look at the third row: at full context
Granite's weight pages were **almost entirely evicted** — 2.61 GiB down to under
2 MiB — because the kernel needed the space for a 10 GiB KV cache. llamafile also
logged `unable to fit model into system memory by reducing context, abort` and
then carried on regardless.

That is a machine running on the edge. A single short prompt still completed at
6.7 tok/s, so it did not collapse, but every token is now re-reading weights from
disk and any real workload will thrash. **Do not run either model at full context
on 16 GB.** If you want a big window, 32,768 is the sensible ceiling there:
roughly 4.6 GiB of KV for Bonsai, 2.6 GiB for Granite.

### What this means for the workshop

The workshop uses **16,384**, which is comfortable for both — about 2.3 GiB of KV
for Bonsai and 1.3 GiB for Granite, so 8 GB of RAM is enough with a browser open.
If you are on 8 GB and it struggles, drop to `-c 8192` — and change
`contextWindow` in `.pi/agent/models.json` to match, or you hit the silent
one-token failure the README describes.

## The honest caveat

**Our test saturated.** Both models scored 38/38, so this comparison cannot
distinguish them — it can only establish that both clear the bar. Earlier
measurements, before the `ASSESSMENT` line was added to the tool output, had
Bonsai calling zero-signal messages "phishing" 19 times out of 19. Fixing the
*tool* took both models to perfect. That is the more interesting result: on this
task, presentation of the evidence mattered far more than which model read it.

Which is the workshop's whole argument, arrived at accidentally. When the
deterministic layer does the parsing and the judging, the model is doing
comprehension and prose — and a 3.4B model is as good at that as an 8B one.
Model choice matters much less here than it would if the model were parsing.

## So how do you choose?

**Take Granite unless the download is the problem.** It is five times faster at
prompt processing on a CPU-only machine, which on this hardware is the difference
between an agent that feels usable and one that feels broken. It also uses less
of the memory that cannot be reclaimed, has a gentler quantisation, and has twice
the context. The price is 2.93 GiB of download instead of 1.41 GiB, and about
1 GiB more resident memory at the workshop's window size.

**Take Bonsai if** the download is genuinely awkward — a metered connection, a
slow line, no time before Friday. It is correct on everything we tested, half the
size, and it is the configured default so there is nothing to change. You give up
speed, not accuracy.

An earlier draft of this page recommended the opposite, on the grounds that the
two were indistinguishable and Bonsai was the smaller download. That was measured
against a GPU-backed endpoint, where both are fast and the difference vanishes.
On the hardware attendees actually bring, it does not vanish — it is 5x. Worth
recording as a methodology lesson: benchmark the deployment you have, not the one
that is convenient to test.

Note we configure **both** at `contextWindow: 16384` and run the server with
`-c 16384`. That is deliberate: 16k is ample for a 2.5-hour session, and full
context would dominate a laptop's RAM — measured above, 12.66 GiB for Granite at
131k, with its weights evicted. If you have the memory and want a bigger window,
raise `-c` and `contextWindow` **together** — they must match, or you hit the
silent one-token failure described in the README. On 16 GB, 32,768 is the
sensible ceiling.

## Sampling

Both are pinned to the same values, and this was tested rather than assumed:

```json
"samplingParams": { "temperature": 0.2, "top_p": 0.9, "top_k": 40, "repeat_penalty": 1.05 }
```

Temperature 0.2 despite Bonsai's model card recommending 0.5–0.7, because we are
asking the model to report findings, not to write imaginatively. A full A/B at
0.6 on 25 real messages produced no measurable improvement and introduced new
garbles, so 0.2 stays. Granite's server default is 0.8; we override it for the
same reason.

## Running either one

The server command is identical — only the file differs:

```bash
./bonsai.llamafile  --server --gpu disable -c 16384 -np 1
./granite.llamafile --server --gpu disable -c 16384 -np 1
```

Then:

```bash
./pi-workshop.sh                              # Bonsai (default)
WORKSHOP_MODEL=granite-3b ./pi-workshop.sh    # Granite
```

```powershell
.\pi-workshop.ps1
$env:WORKSHOP_MODEL = "granite-3b"; .\pi-workshop.ps1
```

**They must agree.** llamafile serves whatever weights it loaded and ignores the
model name in the request, so pointing pi at `bonsai-8b` while running the
Granite llamafile does not error — you just get Granite's answers under the wrong
label, and any conclusion you draw about "which model is better" is wrong.
`./doctor.sh` prints which weights the server actually has loaded, and which
`--model` value matches.

## Adding a third

Any GGUF with a tool-calling chat template works.

```bash
# Preflight without downloading gigabytes (5 builds per IP per hour, so don't waste them)
curl "https://richardoc-llamafile-generator.hf.space/api/validate?model=owner/repo:file.gguf&version=0.10.5"

# Build and download
curl -L -o mymodel.llamafile \
  "https://richardoc-llamafile-generator.hf.space/download?model=owner%2Frepo%3Afile.gguf&version=latest&mode=auto"
```

Add a matching block to the `models` array in `.pi/agent/models.json`, then
confirm the template supports tools once the server is up:

```bash
curl -s http://127.0.0.1:8080/props | grep -o '"supports_tools":[a-z]*'
```

If that says `false`, the extension's tool will never be called and the session
becomes a chatbot demo. It is the one hard requirement.

The generator's `mode=custom` can also bake `--ctx-size`, `--gpu disable` and
`-np 1` into the llamafile's own `.args`, so attendees need no flags at all. We
deliberately do not: those flags are three of the workshop's better lessons.

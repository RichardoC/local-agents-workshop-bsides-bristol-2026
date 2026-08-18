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
| Median latency, whole turn incl. tool call | 2.6 s | 4.4 s |
| Median answer length | 58 words | 51 words |

The 87% vs 83% gap is four signals out of thirty-one. At that sample size it is
noise, and we are not going to pretend otherwise.

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

**Take Bonsai if** the download matters. It is half the size, it is the default,
and it loses you nothing measurable today.

**Take Granite if** you intend to keep using this after Friday:

- **Q6_K vs Q1_0 is a real difference in headroom.** One bit per weight is
  extraordinarily aggressive, and Bonsai is impressive for what it is. But when
  you extend the extension in directions we have not tested, Q6_K is far less
  likely to be the thing that breaks.
- **131,072 tokens of context vs 65,536.** More importantly, the whole class of
  failures documented in [small-model-tuning.md](small-model-tuning.md) — the
  reply allowance decaying to a single token, compaction, prompt evaluation
  outrunning the request timeout — is a function of running out of context. A
  larger window pushes that wall much further away.

Note we configure **both** at `contextWindow: 16384` and run the server with
`-c 16384`. That is deliberate: 16k is ample for a 2.5-hour session, and the KV
cache for 131k tokens would dominate a laptop's RAM. If you have the memory and
want Granite's full window, raise `-c` and `contextWindow` **together** — they
must match, or you hit the silent one-token failure described in the README.

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

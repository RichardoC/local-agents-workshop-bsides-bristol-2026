# Run of show — facilitator notes

**Friday 21 August 2026, 13:30–16:00, Workshops room.** 150 minutes.

Attendee-facing docs are in [README.md](README.md). This file is for whoever is
running the room.

## The one design decision

**Everyone publishes at 15:05, before their extension is finished.**

The stated goal is that every attendee leaves with something published under an
open source licence. The obvious running order — build, then publish — fails
that goal, because publishing lands in the last fifteen minutes when a third of
the room is still debugging and nobody has spare attention for `git remote add`.

So we invert it. The repository goes up while it is still a working stub, and
the rest of the session is `git push` on something that already exists. A
half-finished tool in a public repo meets the goal. A brilliant tool on a laptop
does not.

---

## Before the room opens

- [ ] Model server running on your own machine, warm, with one sample already
      analysed — a cold first run in front of forty people takes minutes.
- [ ] `./doctor.sh` output on screen as people come in. It tells them what to run
      and it advertises that the check exists.
- [ ] USB sticks with `bonsai.llamafile` and all six pi release archives. Assume
      the wifi will fail. This is the single highest-value thing you can bring.
- [ ] The repo URL somewhere permanently visible. Write it on the whiteboard.
- [ ] Know your own answer to "can I use Ollama / LM Studio / my own model
      instead?" — yes, and `.pi/agent/models.json` is where they change it.

---

## 13:30 — Start (10 min)

Do not open with slides about transformers.

Open by running the thing: `./pi-workshop.sh`, ask it about
`samples/synthetic/09-href-text-mismatch.eml`, and let the room watch a model on
a laptop call a tool and explain a real finding. Thirty seconds of that is worth
ten minutes of framing.

Then the framing, briefly:

- Everything today runs on the machine in front of you. No API key, no account,
  no data leaving the room. That is the point, not a limitation.
- A model this small will **invent** things if you ask it to parse. It is good at
  *judging* facts you extracted yourself. Everything else follows from that.
- By 16:00 you will have published an extension. Yes, everyone.

**Room check.** "Hands up if `./doctor.sh` is all green." Get the number now — it
determines how you spend the next fifteen minutes.

## 13:40 — Everyone gets to a working state (15 min)

Target: **nobody is a spectator by 13:55.**

Work the room. The failure triage table below covers essentially everything that
has come up. Two things to say loudly:

- Anyone whose model will not start runs `./pi-workshop.sh --no-model` and uses
  `/phish`. They lose nothing until 14:40 and can still publish.
- Anyone without the submodule uses `samples/synthetic/`. That is what it is for.

Recruit the people who are already green to help their neighbours. It halves your
walking and it is how a room like this is supposed to work.

## 13:55 — Explore (15 min)

Hand out the sample table from the README and let them play. Suggested order:

1. `01-clean-newsletter.eml` — legitimate. Does the model correctly say so, or
   does it manufacture a concern to seem useful? This is the interesting one.
2. `06-brand-in-subdomain.eml` — `paypal.com.account-verify-4471.example`. Ask
   the room to read it right-to-left the way a resolver does.
3. `08-homoglyph-punycode.eml` — nobody spots the Cyrillic а by eye. Nobody.
4. Anything from `samples/phishing_pot/` if they have it.

**The moment to land:** ask someone to open a sample and predict the output
before running it. When they get it right, that is the lesson — the checks are
comprehensible and the model is not doing anything mysterious.

## 14:10 — Read the code (20 min)

Three files, in this order. Keep it to twenty minutes; they can read properly
later.

| File | What to point at |
|---|---|
| `lib/eml.ts` | Node built-ins only, zero dependencies. Works in `latin1` so binary survives string ops. |
| `lib/signals.ts` | The judgement layer, still no model. The homoglyph one-liner. |
| `phish-triage.ts` | Thin. Twenty facts to the model; the raw email never goes near it. |

The homoglyph check is the crowd-pleaser and takes ninety seconds:

```ts
new URL("http://pаypal.com").hostname   // → "xn--pypal-4ve.com"
```

Then the table that is the actual takeaway:

| File | Job | Model involved? |
|---|---|---|
| `lib/eml.ts` | Parse the message | No |
| `lib/signals.ts` | Decide what is suspicious | No |
| `phish-triage.ts` | Summarise and explain | Yes |

77% of 8,600 real samples raise a signal with no model at all, at about a
millisecond each. Say that number out loud — it reframes what the model is for.

## 14:30 — Break (10 min)

Take it. Use it to unblock anyone still stuck; those conversations go better
one-to-one than with the room watching.

## 14:40 — Write a signal (25 min)

Warm-up, in the existing codebase. Add a check to `lib/signals.ts` and a test to
`lib/eml.test.ts`. Ideas, roughly in order of difficulty:

- Subject line contains urgency words ("immediate", "within 24 hours", "suspended")
- `Date` header in the future, or wildly inconsistent with the `Received` chain
- More than N distinct link hosts in one message
- A link whose host is a bare IP address
- Attachment with no filename at all
- `List-Unsubscribe` absent on something claiming to be a newsletter

This runs entirely without a model, so the whole room can do it regardless of
setup state. **Say that explicitly** — the people on the no-model path need to
hear that they are not doing a lesser version.

## 15:05 — Publish (20 min)

**Everyone stops and does this together.** It is the goal of the session and it
is not optional. Nobody's tool is finished. That is fine and intended.

```bash
cp -r templates/starter ../my-extension
cd ../my-extension
git init && git add -A && git commit -m "Initial extension"
```

Create the repo on GitHub, then:

```bash
git remote add origin https://github.com/<you>/<repo>
git push -u origin main
```

Three things to check before they move on:

1. A `LICENSE` file exists. The template ships MIT. Without it, "open source" is
   just "visible", and nobody can safely use their work.
2. `package.json` has `"keywords": ["pi-package"]` and the `pi` block. That is
   what makes it installable.
3. Add the repository topic **`bsides-bristol-2026`** so the room can find each
   other afterwards.

Then the bit that makes it real — **install a neighbour's**:

```bash
pi install https://github.com/<them>/<their-repo>
```

Git is a first-class package source; no npm publish involved. Watching someone
else's extension load on your machine, ninety seconds after they pushed it, is
the moment the afternoon clicks.

## 15:25 — Build (25 min)

Now they extend their own thing. The template's `word_count` is a placeholder to
be replaced. Same rule as everything else: deterministic core in `lib/`, thin pi
wrapper on top, model explains the result.

Suggestions that suit this treatment, all with a deterministic core:

- log and alert triage
- honeypot session summaries
- `gitleaks` false-positive triage
- shadow-AI scanning of a repository
- firmware `strings` triage
- ADS-B anomaly narration
- ICS asset inventory summaries
- STRIDE prompts over a design document

Keep pushing commits. The repo is already public, so every improvement is
already published.

## 15:50 — Show and tell, and wrap (10 min)

Three or four volunteers, two minutes each, screen shared. Prioritise people who
hit something unexpected over people whose tool is most polished.

Close on:

- The `bsides-bristol-2026` topic — go and install each other's work.
- Everything here runs offline, on your own hardware, under licences you can
  actually use at work.
- The split — deterministic core, model on top — is not specific to email. It is
  the thing to take back.

---

## Failure triage

Walk the room with this. Symptom on the left, because that is what people
describe. Almost all of these fail *silently*, which is exactly why `doctor.sh`
checks them.

| Symptom | Cause | Fix |
|---|---|---|
| Agent prints nothing, exit code 0 | `contextWindow` and `-c` disagree; the reply allowance floored at 1 | Match them. Both 16384. `./doctor.sh` catches it. |
| Replies truncate mid-sentence after a while | Conversation depth ate the allowance | `/compact`, or start a fresh session |
| First response takes minutes | Cold prompt processing, no GPU | It is not hung. Watch the server terminal count. |
| Every turn slow, not just the first | Server running >1 slot, KV cache discarded | Restart with `-np 1` |
| "Request timed out" after ~20 min | 300s per-request limit vs slow prompt eval | Keep the server warm, avoid `--resume`/`--fork`, `/compact` |
| Same request repeats over and over | The above, retrying — **not** a sampler problem | Do not touch `repeat_penalty` |
| Server crashes at startup | Vulkan/driver | `--gpu disable` |
| `Exec format error` / `run-detectors: unable to find an interpreter` | APE binary handed to the wrong interpreter (common with WINE installed, and under WSL) | `sh ./bonsai.llamafile --server ...` — works everywhere |
| Hangs before any output | Corporate proxy intercepting 127.0.0.1 | `NO_PROXY=127.0.0.1,localhost` (the launcher sets it) |
| `pi: command not found` | Static build not extracted, or extracted elsewhere | Extract so `./pi/pi` exists, or set `PI_BIN` |
| Windows: script will not run | Execution policy | `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` |
| Windows: llamafile will not start | Missing `.exe` extension | Rename to `bonsai.llamafile.exe` |
| Windows: SmartScreen blocks it | Unsigned binary | Properties → Unblock, or "More info" → "Run anyway" |
| `samples/` is empty | Cloned without submodule | Use `samples/synthetic/` — it is not a lesser path |
| `Cannot find package 'typebox'` | Running under bare Node, not pi | Keep `lib/` free of pi/typebox imports. Only `npm test` is affected. |
| Model invents header values | System prompt got replaced or lost | The launcher passes `workshop-system-prompt.md`; check it is still being used |

## Contingencies

**No wifi at all.** USB sticks. Everything needed is local: repo, pi archives,
model. Publishing is the only step that needs the network — if it is down at
15:05, have them commit locally and push from the pub.

**A machine cannot run the model at all.** `--no-model` plus `/phish`. They can
complete every exercise through 15:25 and publish normally.

**Room is much slower than expected.** Drop the 15:25 build block and let the
15:05 publish run long. Publishing is the goal; building is the enjoyable part.

**Room is much faster than expected.** Push people at the corpus: run their new
signal across all 8,600 samples and look at the false positives. That question —
"why does this fire on legitimate mail?" — is where the real learning is.

**A machine has no Node.** Fine. pi is a static binary and bundles what
extensions import. They lose `npm test` and `npm run triage`, nothing else.

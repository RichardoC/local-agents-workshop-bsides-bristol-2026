# Run of show — facilitator notes

**Friday 21 August 2026, 13:30–16:00, Workshops room.** 150 minutes.

Attendee-facing docs are in [README.md](README.md). This file is for whoever is
running the room.

## The one design decision

**Everyone publishes at 15:00, before their extension is finished.**

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
- [ ] USB sticks with **`granite.llamafile`** (the default and recommended model), plus
      `bonsai.llamafile` for anyone short on disk, and all six pi release
      archives. Assume the wifi will fail. This is the single highest-value thing
      you can bring. 2.93 GiB over USB beats 2.93 GiB over hotel wifi by a margin
      that decides whether the session works.
- [ ] If you have set up a hosted endpoint, **wake it before the room opens**. A
      Hugging Face endpoint scaled to zero returns 503 for the first minute or
      two, which looks exactly like a broken URL when you are demoing it.
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

Do not try to get all forty people to the same place. Sort the room into three
tracks out loud, so nobody spends this block wondering whether they are behind:

| Track | Who | What they do now |
|---|---|---|
| **Green** | `doctor.sh` all green | Start on 13:55's samples early, then help a neighbour. Recruit these people explicitly — it halves your walking. |
| **No model** | Model will not start, download unfinished, machine too slow | `./pi-workshop.sh --no-model` and `/phish`. Every exercise through 15:25 works. They publish normally. |
| **Hosted** | Cannot run a local binary at all — managed laptop, 8 GB RAM, blocked executables | If an endpoint is set up: `export HF_TOKEN=... ; WORKSHOP_PROVIDER=hosted WORKSHOP_MODEL=granite-3b-hosted ./pi-workshop.sh`. Otherwise pair with a neighbour for the agent half. |

Say this next part explicitly, because it is the difference between a track and a
consolation prize: **the no-model track is not a lesser version of the workshop.**
The deterministic half is the half this session argues is important. They lose the
model explaining the result, which is the last mile, not the foundation.

Anyone without the submodule uses `samples/synthetic/`. That is what it is for.

## 13:55 — Explore (15 min)

Hand out the sample table from the README and let them play. Suggested order:

1. `01-clean-newsletter.eml` — legitimate. Does the model correctly say so, or
   does it manufacture a concern to seem useful? This is the interesting one.

   **Know what to expect here, because it is subtler than pass/fail.** The model
   does reach the right verdict, and it embellishes getting there — observed
   output describes "a legitimate-looking newsletter sender address" and "a benign
   link to a known domain". The tool said neither of those things, and
   `bristol-tech.example` is not a known domain. It is reading the subject line
   and the sender name, which is precisely the habit this session argues against.

   That is a gift, not a problem: **right answer, wrong reasons.** Ask the room to
   compare the model's prose against the tool output above it and find the claims
   the tool never made. It is the sharpest version of the whole lesson, and it only
   works if you are expecting it.
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

62.5% of 8,614 real samples raise at least one signal with no model at all —
29.1% raise a high-severity one — at about 1 ms each. Say that number out loud;
it reframes what the model is for.

Worth telling the room where those numbers came from, because it is the best
story in the codebase. They were 69% and 41% until the checks were measured
against the whole corpus: `brand_in_subdomain` was firing on 11.7% of all mail
and **97% of its hits were the brand's own servers** — `storage.googleapis.com`
alone accounted for 444 of them. A legitimate S3 invoice link was getting a
high-severity phishing verdict, and the model then explained the fabricated
reason in fluent prose. That is the failure this whole workshop argues against,
found in our own code. It now fires on 0.2%.

Then the other half of that story, which is the better discussion because it has
no clean answer. `lookalike_domain` was tuned the same way, and tuned too far: at
its most precise it fired on **one message out of 8,614**. Technically accurate,
completely useless.

Ask the room what they would do about it. The answer we shipped is two checks
instead of one:

- A **confusable skeleton** — fold `0`/`o`, `1`/`l`, `rn`/`m` onto one
  representative and compare for equality. `rnicrosoft` becomes `microsoft`
  exactly. Note that this is *two* edits, so no edit-distance threshold could ever
  have caught it; a different idea was needed, not a bigger number.
- A **deliberately loose edit distance**, which does produce false positives —
  `mega.nz` against "meta", `hsb.com` against "hsbc" — reported at `medium`, never
  `high`.

The point to land: **severity is where confidence lives.** A check tuned until it
never fires catches nothing; one that shouts about everything gets ignored. Six
false positives you can name and explain are a better outcome than silence, and
fixing them properly needs a popularity or domain-age signal rather than a tighter
threshold. That is on the exercise list for a reason.

## 14:30 — Break (10 min)

Take it. Use it to unblock anyone still stuck; those conversations go better
one-to-one than with the room watching.

## 14:40 — Write a signal (20 min)

Warm-up, in the existing codebase. Add a check to `lib/signals.ts` and a test to
`lib/signals.test.ts`. This runs entirely without a model, so the whole room can
do it regardless of setup state — **say that out loud again.**

One caveat to say with it: `npm test` needs Node 22.6 or newer, because the tests
are TypeScript run without a build step. Anyone with no Node, or older Node,
checks their work with `/phish <file>` in pi instead. Same check, same result, no
test runner — they have not failed at anything.

Point at the `ADD YOUR OWN CHECK HERE` comment in `lib/signals.ts`. It exists so
that nobody has to decide where to start typing.

Give the ladder explicitly rather than a flat list of ideas. Mixed-ability rooms
fail here when strong participants gold-plate and beginners freeze, and both are
fixed by naming the rungs:

**Rung 1 — never written TypeScript.** Copy the check immediately above the
anchor comment and change what it looks for. Concretely: subject line contains an
urgency word (`immediate`, `within 24 hours`, `suspended`, `verify now`). It is
one `if`, one `add(...)` call, one test. If someone is stuck for more than three
minutes at this rung, sit down next to them — the blocker is never the idea.

**Rung 2 — comfortable, wants something real.** One of:

- A link whose host is a bare IP address
- More than N distinct link hosts in one message
- Attachment with no filename at all
- `List-Unsubscribe` absent on something claiming to be a newsletter
- `Date` header in the future, or inconsistent with the `Received` chain

**Rung 3 — finished early, or already knew all this.** Now the interesting
problem: run your check against the whole corpus and make it *survive* real mail.

```bash
npm run triage -- samples/phishing_pot/email/*.eml --json > /tmp/out.json
```

Anything firing on more than a percent or two of 8,614 real messages is almost
certainly wrong, and finding out why is the actual skill. The worked example is in
the 14:10 notes: `brand_in_subdomain` went from 11.7% to 0.2% that way.

The best rung-3 task, if someone wants it, is fixing `lookalike_domain`'s known
false positives with a signal other than string distance — domain age, or a list
of the top few thousand real domains. Nobody has done that here yet.

**Watch for:** anyone still on rung 1 at 14:55 needs a hand, not more time.

## 15:00 — Publish (25 min)

**Everyone stops and does this together.** It is the goal of the session and it is
not optional. Nobody's tool is finished. That is fine and intended.

Twenty-five minutes for what looks like a five-minute task, because it is forty
people doing an unfamiliar thing at once, and roughly a quarter of them will hit
authentication. Budget for that rather than discovering it.

```bash
cp -r templates/starter ../my-extension
cd ../my-extension
git init -b main && git add -A && git commit -m "Initial extension"
```

Now publish. **Push the `gh` path first** — it replaces a browser round-trip with
one command, and across a room of forty that is the difference between this block
finishing on time and running over:

```bash
gh repo create my-extension --public --source=. --push
```

`doctor.sh` already checks `gh auth status`, so anyone green there is one command
from done. If `gh` is missing or unauthenticated, the browser path still works:
create the repo on github.com, then

```bash
git remote add origin https://github.com/<you>/<repo>
git push -u origin main
```

**Have the auth answer ready before you need it.** `gh auth login` wants a browser
and a device code; if the wifi is marginal this is where the block stalls. HTTPS
with a personal access token is the reliable fallback, and someone who has neither
should commit locally and push later — a local commit plus a pushed repo an hour
later still meets the goal.

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

**Already ahead, or not a programmer?** There is a second track nobody finds on
their own. A skill is instructions, not code — no TypeScript at all — which makes it
the better path for anyone strong on security and light on programming.

```bash
./pi-workshop.sh -p "/skill:write-a-skill"                      # writes a skill for them
./pi-workshop.sh -p "/skill:stride-threat-model docs/design.md" # a worked example
```

**Two things to say out loud here.**

First, how skills load: pi keeps only a skill's description in the prompt and
fetches the body with the built-in `read` tool, which `-nbt` removes. `/skill:<name>`
forces it in; without the prefix the body never loads, with no error. That detail
cost the most debugging time in this repo, and it is why the STRIDE skill does its
real work in a tool that returns the document and the format together.

Second, **model choice matters on this track and nowhere else.** Both models are
6/6 on the phishing exercise. On STRIDE, Granite produces the six-row table;
Bonsai produces a grounded but free-form analysis, and with the `/skill:` prefix it
threat models the skill instructions instead of the document. **Steer anyone on
Bonsai to `Threat model <path>` without the prefix, and set expectations: they get
real findings in the wrong shape.** If they want the table, they want Granite.

Worth showing the room deliberately: run `/skill:write-a-skill` and have it produce
a skill, then read what it wrote. Granite reliably slips on one of its own rules —
told not to include filled-in examples, it includes them and sometimes adds a line
claiming it did not. **Small models follow structure well and self-assess badly**,
and seeing that live is worth more than being told.

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
| "Request timed out" after ~20 min | pi's HTTP **idle** timeout. It is 300 s by default and prompt processing sends no bytes at all while it works | `.pi/agent/settings.json` already sets `httpIdleTimeoutMs: 0`, so this should not happen here — if it does, they are not picking up the repo's settings. Check they launched from the repo root. |
| Same request repeats over and over | The above, retrying — **not** a sampler problem | Do not touch `repeat_penalty` |
| Server crashes at startup | Vulkan/driver | `--gpu disable` |
| Machine far too slow to be usable, or cannot run the binary at all | 8 GB RAM and a browser open, ancient CPU, or a managed laptop that blocks unsigned executables | If a hosted endpoint has been set up: `export HF_TOKEN=... ; WORKSHOP_PROVIDER=hosted WORKSHOP_MODEL=granite-3b-hosted ./pi-workshop.sh`. Otherwise `--no-model` plus `/phish`, and pair them with a neighbour for the agent half. |
| `Exec format error` / `run-detectors: unable to find an interpreter` | APE binary handed to the wrong interpreter (common with WINE installed, and under WSL) | `sh ./bonsai.llamafile --server ...` — works everywhere |
| Hangs before any output | Corporate proxy intercepting 127.0.0.1 | `NO_PROXY=127.0.0.1,localhost` (the launcher sets it) |
| `git init -b main`: `unknown switch 'b'` | git older than 2.28 | `git init && git add -A && git commit -m "Initial extension" && git branch -M main` |
| `error: src refspec main does not match any` | They ran plain `git init`, which creates `master`, then pushed `main` | `git branch -M main` then push again. `doctor.sh` warns when `init.defaultBranch` is unset. |
| `pi: command not found` | Static build not extracted, or extracted elsewhere | Extract so `./pi/pi` exists, or set `PI_BIN` |
| Windows: script will not run | Execution policy | `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` |
| Windows: llamafile will not start | Missing `.exe` extension | Rename to `bonsai.llamafile.exe` |
| Windows: SmartScreen blocks it | Unsigned binary | Properties → Unblock, or "More info" → "Run anyway" |
| `samples/` is empty | Cloned without submodule | Use `samples/synthetic/` — it is not a lesser path |
| `Cannot find package 'typebox'` | Running under bare Node, not pi | Keep `lib/` free of pi/typebox imports. Only `npm test` is affected. |
| Model invents header values | System prompt got replaced or lost | The launcher passes `workshop-system-prompt.md`; check it is still being used |
| Hosted endpoint returns `503 Service Unavailable` | Endpoint scaled to zero and is cold | **Not a misconfiguration.** Retry for one to two minutes; it wakes. Wake it yourself before the session. |
| Changed the endpoint URL, pi still talks to the old one | pi caches provider state in `models-store.json` in its config dir | Delete that file, or use a fresh `PI_CODING_AGENT_DIR`. This one wastes a lot of time because everything looks correctly configured. |
| Answers are confident and wrong about the email | The `--model` id and the weights the server actually loaded disagree | llamafile serves whatever it loaded and ignores the model field, so this fails silently. `curl -s 127.0.0.1:8080/props \| grep model_path`, and `./doctor.sh` reports it. |
| `npm test` fails on `--experimental-strip-types` | Node older than 22.6 | Nothing to fix during the session. TypeScript stripping needs 22.6+; run the tests through pi instead, or skip them. Node is optional here. |
| `git submodule update --init` prints nothing and does nothing | Cloned a revision without `.gitmodules`, so there is no submodule to init | Exits 0, which is why it fools people. Use `samples/synthetic/`. |
| `pi install <neighbour's repo>` does nothing useful | Their `package.json` is missing the `pi` block or the `pi-package` keyword | Check theirs, not yours. It is the most common reason a published extension will not load. |

## Contingencies

**No wifi at all.** USB sticks. Everything needed is local: repo, pi archives,
model. Publishing is the only step that needs the network — if it is down at
15:00, have them commit locally and push from the pub.

**A machine cannot run the model at all.** `--no-model` plus `/phish`. They can
complete every exercise through 15:25 and publish normally.

**Room is much slower than expected.** Drop the 15:25 build block and let the
15:00 publish run long. Publishing is the goal; building is the enjoyable part.

**Room is much faster than expected.** Push people at the corpus:

```bash
npm run triage -- samples/phishing_pot/email/*.eml --json > /tmp/out.json
```

Ask them to read the *hosts and headers their signal fired on* and decide whether
each hit is the mechanism they meant to catch or something incidental that happens
to correlate.

Phrase it that way rather than "find the false positives", because **the corpus is
100% phishing** — it is a honeypot collection, with no legitimate mail in it at
all. There is no ham to measure precision against, so every hit is arguably a true
positive and a hunt for false positives has no answer. What the corpus *can* tell
you is whether a signal fires for the reason you intended, which is the more
useful question anyway.

Say the limitation out loud if it comes up. "We measured recall and eyeballed
precision" is the honest description of every number in this repo, and noticing
that is a better lesson than any of the numbers.

**A machine has no Node.** Fine. pi is a static binary and bundles what
extensions import. They lose `npm test` and `npm run triage`, nothing else.

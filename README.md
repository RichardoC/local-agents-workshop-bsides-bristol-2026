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

### 1. Node.js 22 or newer

```bash
node --version      # must print v22.x or higher
```

Node 22 is required: extensions are TypeScript, and pi runs them without a build
step. If you need to install it, get it from https://nodejs.org.

### 2. pi

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

### 3. This repository, including the sample emails

```bash
git clone --recurse-submodules \
  https://github.com/RichardoC/local-agents-workshop-bsides-bristol-2026
```

**`--recurse-submodules` matters.** The email samples are a submodule of about
**420 MB**. If you clone without it you will get an empty `samples/` directory.
Already cloned it the wrong way? Fix it with:

```bash
git submodule update --init --depth 1
```

### 4. The model

Roughly **1.5 GB**. Download it into the repository folder:

```bash
curl -L -o bonsai.llamafile \
  "https://richardoc-llamafile-generator.hf.space/download?model=prism-ml%2FBonsai-8B-gguf%3ABonsai-8B-Q1_0.gguf&version=latest&mode=auto"
chmod +x bonsai.llamafile
```

On Windows, rename it to `bonsai.llamafile.exe`.

Then check it starts:

```bash
./bonsai.llamafile --version
```

---

## Running it

Two terminals. In the first, start the model server and leave it running:

```bash
./bonsai.llamafile --server --gpu disable -c 16384
```

In the second, start the agent:

```bash
./pi-workshop.sh              # macOS, Linux, Git Bash
.\pi-workshop.ps1             # Windows PowerShell
```

Then ask it something:

```
Is samples/phishing_pot/email/sample-1004.eml a phishing email?
```

The wrapper script uses the model configuration committed in this repository
(`.pi/agent/models.json`) rather than anything in your home directory, so it
does not disturb an existing pi setup. Delete the folder and every trace of the
workshop is gone.

---

## Two flags that are not optional

**`-c 16384`.** pi reserves a fixed 4096-token safety margin when working out how
much room is left for a reply. If the model's declared context window is also
4096, the arithmetic leaves room for exactly **one token** — so the model emits a
single token and stops, and pi prints *nothing at all*, with no error message.
It looks completely broken. The context size you pass to `--gpu`/`-c` must match
`contextWindow` in `.pi/agent/models.json`; both are 16384 here. If you change
one, change the other.

**`--gpu disable`.** Only needed if the server crashes on startup with a Vulkan
or driver error. If your GPU works, leave it off and enjoy the speed.

If the agent seems to hang, check `NO_PROXY` includes `127.0.0.1` — a corporate
proxy will otherwise intercept requests to your own machine. The wrapper scripts
set this for you.

---

## What's in here

```
extensions/
  lib/eml.ts          .eml parser      — node: built-ins only, no dependencies
  lib/signals.ts      signal detection — node: built-ins only, no dependencies
  lib/eml.test.ts     tests            — node:test, no framework
  phish-triage.ts     the pi extension — a thin wrapper over the two libraries
.pi/agent/models.json model config, committed so nobody edits their home directory
workshop-system-prompt.md  the short system prompt the wrapper scripts use
samples/phishing_pot  submodule of real phishing emails (see Credits)
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

Across 800 real samples from the corpus, the deterministic checks alone raise at
least one signal on **77%** of them, in about a millisecond each. The model earns
its place on the other 23%, and on turning a list of signals into something a
human can act on.

### Signals detected without a model

Sender/Reply-To/Return-Path divergence, display names containing a different
address, recorded SPF/DKIM/DMARC verdicts, brand names appearing outside the
brand's own domain, lookalike domains by edit distance, non-ASCII homoglyph
domains, link text disagreeing with the link target, executable and
double-extension attachments, right-to-left override characters in filenames,
and attachments whose leading bytes contradict their declared type.

The homoglyph check is the neatest of them. Node's URL parser applies IDNA
automatically, so this is the whole detection:

```ts
new URL("http://pаypal.com").hostname   // → "xn--pypal-4ve.com"
```

That `а` is Cyrillic U+0430. If `xn--` shows up in the parsed hostname but not in
the text you started with, the domain was never ASCII.

### What we deliberately do not do

No DNS, no WHOIS, no URL reputation, no hash lookups. Everything happens offline,
on data already in the file. That means the SPF/DKIM/DMARC values are what the
receiving server recorded *at delivery time* — we are reading a verdict, not
re-checking one. Re-verification is a good thing to add at work; it is a bad
thing to depend on at a conference.

---

## Build your own

Develop against a file directly — no install, no publish step:

```bash
pi -e ./extensions/my-thing.ts
```

Or drop it in `~/.pi/agent/extensions/` and use `/reload` for hot reload. The
wrapper script picks up anything in `extensions/`, so adding a file is enough.

A minimal extension:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What it does, written for the model to read.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return { content: [{ type: "text", text: "..." }], details: {} };
    },
  });
}
```

Ideas that suit this treatment, all following the same deterministic-core rule:
log and alert triage, honeypot session summaries, `gitleaks` false-positive
triage, shadow-AI scanning of a repository, firmware `strings` triage, ADS-B
anomaly narration, ICS asset inventory summaries.

## Publish it

Push to GitHub with a `package.json` and anyone can install it directly from the
repository — no npm publish required:

```bash
pi install https://github.com/<you>/<your-repo>
```

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions"], "skills": ["./skills"] }
}
```

Add the topic **`bsides-bristol-2026`** to your repository so the room can find
each other's work afterwards.

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

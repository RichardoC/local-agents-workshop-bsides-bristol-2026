# Before you arrive

**BSides Bristol 2026 — Friday 21 August, 13:30–16:00**

Ten minutes of preparation now buys you the whole session. Skip it and you will
spend the first half hour watching a progress bar on shared conference wifi.

---

## Priority: download a model

**This is the only thing that really matters.** It is 1.4–2.9 GiB, and forty
people downloading it at once over hotel wifi will not work. Do it at home.

Pick one. Both work; the trade-off is download size against speed.

| | **Granite 4.1 3B** — recommended | **Bonsai 8B** |
|---|---|---|
| Download | 2.93 GiB | **1.41 GiB** |
| Prompt speed, CPU-only | **~30 tok/s** | ~5.8 tok/s |
| RAM while running | ~3.5 GiB | **~2.6 GiB** |

**Take Granite unless the download is a problem for you** — metered connection,
slow line, not much disk. It is roughly five times faster on a machine with no
GPU, which is the difference between an agent that feels usable and one that
feels broken. Bonsai is the smaller download and gives up speed, not accuracy.

macOS / Linux:

```bash
# Granite — recommended
curl -L -o granite.llamafile \
  "https://richardoc-llamafile-generator.hf.space/download?model=unsloth%2Fgranite-4.1-3b-GGUF%3Agranite-4.1-3b-Q6_K.gguf&version=latest&mode=auto"
chmod +x granite.llamafile

# or Bonsai — smaller
curl -L -o bonsai.llamafile \
  "https://richardoc-llamafile-generator.hf.space/download?model=prism-ml%2FBonsai-8B-gguf%3ABonsai-8B-Q1_0.gguf&version=latest&mode=auto"
chmod +x bonsai.llamafile
```

Windows — same URLs, but name the file `granite.llamafile.exe` (or
`bonsai.llamafile.exe`). In PowerShell:

```powershell
curl.exe -L -o granite.llamafile.exe `
  "https://richardoc-llamafile-generator.hf.space/download?model=unsloth%2Fgranite-4.1-3b-GGUF%3Agranite-4.1-3b-Q6_K.gguf&version=latest&mode=auto"
```

Those URLs build the file on demand, so the first request takes a few minutes
before the download starts. **The service allows five builds per IP per hour**,
which is the other reason not to leave this until Friday.

### Then check it actually runs

Worth thirty seconds, because this is where the surprises live:

```bash
./granite.llamafile --version
```

If you get `Exec format error` (some Linux and WSL setups), this works instead,
and is not a problem:

```bash
sh ./granite.llamafile --version
```

If your machine has under 8 GiB of RAM, or corporate policy blocks unsigned
binaries outright, **come anyway** — bring it up at the start and we will put you
on a hosted endpoint. Everything except the model runs on any laptop.

---

## Less pressing: get pi and have a play

pi is the agent we will drive the model with. It is a **single self-contained
binary — no Node.js, no npm, nothing to install**, and it is a small download, so
this one is genuinely fine to do on the day.

Grab your platform's file from the
[v0.84.2 release](https://github.com/earendil-works/pi/releases/tag/v0.84.2)
(`pi-darwin-arm64.tar.gz`, `pi-linux-x64.tar.gz`, `pi-windows-x64.zip`, …),
extract it, and run `./pi/pi --version`.

If you would like a head start, clone the workshop repo too — it is small, and
having it locally means you can read the example extension on the train:

```bash
git clone https://github.com/RichardoC/local-agents-workshop-bsides-bristol-2026.git
cd local-agents-workshop-bsides-bristol-2026
./doctor.sh          # tells you what is ready and what is missing
```

`doctor.sh` (`doctor.ps1` on Windows) checks everything above and prints what is
still needed. If it is happy, you are fully set up.

Playing with pi beforehand is genuinely useful — you will get more out of the
session if the interface is already familiar — but it is not required. We start
from zero.

---

## What to bring

- A laptop you can install and run things on. **Admin rights are not needed**,
  but a locked-down work machine that blocks unsigned binaries is worth knowing
  about in advance.
- About 4 GiB of free disk.
- A GitHub account, if you want to publish what you build — which is how the
  session ends. If you would rather not use GitHub, that is fine; we will cover
  other options.

Anything not working? Bring it to the start of the session rather than fighting
it alone — there is a fallback for every step, and getting you unstuck early is
more useful to everyone than you missing the first hour.

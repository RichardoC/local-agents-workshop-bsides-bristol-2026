---
name: stride-threat-model
description: Produce a STRIDE threat model table for a design document, architecture note, README or feature spec. Use whenever the user asks to threat model something, asks what could go wrong with a design, asks for a STRIDE analysis, or supplies a design document and asks about its security risks.
license: MIT
---

# STRIDE threat model

The document is already in this conversation. Do not call any tool.

**First, check it is a design document.** It must name at least two parts of a
system and say something about how data moves between them or who can reach
them. Installation steps, a changelog, meeting notes and a plain prose article
are not design documents. If it is not one, reply with exactly this line and
nothing else:

> This is not a design document, so I cannot threat model it. Give me something
> that describes components and how data moves between them.

Otherwise write one report in exactly the shape shown below, then stop. Never
answer with the print-room example below — it is only there to show the layout.

STRIDE is six categories. Use all six, in this order, once each:

- **S**poofing — someone pretends to be a user, a service or a machine.
- **T**ampering — someone changes data, a file, a message or a setting.
- **R**epudiation — someone denies what they did, and no log proves otherwise.
- **I**nformation disclosure — someone reads data they should not.
- **D**enial of service — someone makes it slow, expensive or unavailable.
- **E**levation of privilege — someone ends up with more access than they were given.

R is Repudiation. It is not Replay. Do not rename it.

## Worked example — a DIFFERENT document, for shape only

This example is about a print room, which is **not** the user's document. Copy
its layout. Do not copy any of its assets, threats or wording.

Given a document describing *a print room where staff drop PDFs onto a shared
network folder and a script prints anything it finds*, the report is:

# Threat model: shared print folder

## Assets

- The shared network folder anyone on the LAN can write to
- The PDFs waiting to be printed, which contain payroll letters
- The printing script, which runs as a service account

## STRIDE

| Letter | Category | Threat | Where | Fix |
|---|---|---|---|---|
| S | Spoofing | Anyone on the LAN can drop a file and it prints as though HR sent it. | The shared network folder is writable by everyone. | Require an authenticated upload instead of an open share. |
| T | Tampering | A waiting PDF can be swapped for a different one before it prints. | Files sit in the folder until the script picks them up. | Move files to a location only the script can write, and check a hash. |
| R | Repudiation | Nobody can show who submitted a given document. | The script logs nothing about who wrote the file. | Log the submitting account and file hash for every print job. |
| I | Information disclosure | Payroll letters can be read by anyone who lists the folder. | The folder is readable by all LAN users. | Restrict read access to HR and the service account. |
| D | Denial of service | A huge or malformed PDF stalls the queue for everyone. | The script prints anything it finds, with no size limit. | Cap file size and time out a job that will not render. |
| E | Elevation of privilege | A crafted PDF that exploits the renderer runs as the service account. | The script runs as a service account with broad rights. | Run the renderer as an unprivileged user with no network access. |

## Now do the same for the user's document

Replace every cell. Keep the letters and the categories exactly as they are.

- **Threat** — one sentence saying what an attacker does. Not a question.
- **Where** — the component or note *from the user's document* that makes it
  possible. If you cannot name one from the document, the threat is invented;
  replace it with one you can. Do not add facts the document does not state.
- **Fix** — one sentence saying what change would stop it.

Rules:

- Six rows. Never add one, never drop one.
- The title after `# Threat model:` is the title of the user's document.
- 3 to 5 assets, in the user's document's own words. Nothing from the print-room
  example belongs in your answer.
- One sentence per cell. No paragraphs, no bullets inside cells.
- No CVSS scores, no severity or likelihood ratings — you do not have the data.
- Do not name a vendor or product as a fix.
- If a letter genuinely does not apply, still write the row: put
  `not applicable` in Threat and the reason in Fix.
- Stop after the last table row. No summary, no closing remarks.

## How to run it

```bash
./pi-workshop.sh -p "/skill:stride-threat-model $(cat design.md)"
```

The `/skill:` prefix must be the **first thing** in the message — that is what
makes pi load this file. `example-design.md` sits next to it, small and
deliberately flawed, to try it on:

```bash
./pi-workshop.sh -p "/skill:stride-threat-model $(cat skills/stride-threat-model/example-design.md)"
```

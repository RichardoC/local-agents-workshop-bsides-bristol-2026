---
name: stride-threat-model
description: Produce a STRIDE threat model table for a design document, architecture note, README or feature spec. Use whenever the user asks to threat model something, asks what could go wrong with a design, asks for a STRIDE analysis, or names a document and asks about its security risks.
license: MIT
---

# STRIDE threat model

Two steps. Do not skip the first one.

## Step 1 — call `threat_model`

Call the `threat_model` tool with the path the user gave you. If they pasted the
document text instead of a path, skip to Step 2 and use what they pasted.

**This file is not the document.** The words below are instructions for you, not a
system to analyse. If your answer describes "the guide" or "the instructions", you
threat modelled the wrong thing — call `threat_model` and start again.

## Step 2 — follow the INSTRUCTIONS the tool returned

`threat_model` returns the document followed by an `INSTRUCTIONS` block giving the
exact report format. **Follow that block.** It is the authority on the output shape,
and it arrives with the document so the two cannot drift apart.

Everything below is reference for the human reading this file. The tool's
`INSTRUCTIONS` block is what you obey.

## Reference — what STRIDE is

Six categories, always these six, in this order:

- **S**poofing — someone pretends to be a user, a service or a machine.
- **T**ampering — someone changes data, a file, a message or a setting.
- **R**epudiation — someone denies what they did, and no log proves otherwise.
- **I**nformation disclosure — someone reads data they should not.
- **D**enial of service — someone makes it slow, expensive or unavailable.
- **E**levation of privilege — someone ends up with more access than they were given.

R is Repudiation, not Replay. There is no Confidentiality, Integrity or
Availability category — that is a different framework.

## Reference — what makes a good row

- **Threat** — one sentence saying what an attacker does. Not a question.
- **Where** — the component or line from the *user's document* that makes it
  possible. If you cannot name one, the threat is invented.
- **Fix** — one sentence saying what change would stop it. Never name a vendor.

No CVSS scores, no severity or likelihood ratings — you do not have the data.

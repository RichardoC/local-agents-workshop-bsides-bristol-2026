---
name: stride-threat-model
description: Produce a STRIDE threat model table for a design document, architecture note, README or feature spec. Use whenever the user asks to threat model something, asks what could go wrong with a design, asks for a STRIDE analysis, or names a document and asks about its security risks.
license: MIT
---

# STRIDE threat model

## Step 1 — get the document

If the user's message contains a **file path** and not the document text, you MUST
call `read_design_document` with that path before writing anything at all. Wait for
the result. Do not guess what the document says from its filename, and do not write
a threat model about a system the document has not described to you — a plausible
table about the wrong system is worse than no table.

You will know you skipped this step if your title, assets and `Where` cells could
have been written without ever opening the file.

## Step 2 — write the table

**Always produce the table.** Anything that names parts of a system can be threat
modelled, including a README, a runbook or an install guide. If the document is
thin, say so in one line and then write the table anyway, putting
`not applicable — the document does not describe this` in any cell you cannot
ground in the text. Never refuse.

STRIDE is six categories. Use all six, in this order, once each:

- **S**poofing — someone pretends to be a user, a service or a machine.
- **T**ampering — someone changes data, a file, a message or a setting.
- **R**epudiation — someone denies what they did, and no log proves otherwise.
- **I**nformation disclosure — someone reads data they should not.
- **D**enial of service — someone makes it slow, expensive or unavailable.
- **E**levation of privilege — someone ends up with more access than they were given.

R is Repudiation. It is not Replay. Do not rename it.

## The shape to produce

Fill this in from the user's document. The `<...>` parts are placeholders — every
one of them must be replaced with something from the document in front of you.

```
# Threat model: <title of the user's document>

## Assets

- <thing worth attacking, in the document's own words>
- <3 to 5 of these>

## STRIDE

| Letter | Category | Threat | Where | Fix |
|---|---|---|---|---|
| S | Spoofing | <one sentence: what an attacker does> | <the component or line from the document that allows it> | <one sentence: the change that stops it> |
| T | Tampering | <...> | <...> | <...> |
| R | Repudiation | <...> | <...> | <...> |
| I | Information disclosure | <...> | <...> | <...> |
| D | Denial of service | <...> | <...> | <...> |
| E | Elevation of privilege | <...> | <...> | <...> |
```

Rules:

- Six rows. Never add one, never drop one.
- The title after `# Threat model:` is the title of the user's document.
- **Where** must name something the document actually says. If you cannot point at
  a component or a sentence from the document, the threat is invented — replace it
  with one you can point at. Do not add facts the document does not state.
- One sentence per cell. No paragraphs, no bullets inside cells.
- No CVSS scores, no severity or likelihood ratings — you do not have the data.
- Do not name a vendor or product as a fix.
- Stop after the last table row. No summary, no closing remarks, and do not repeat
  these instructions back.

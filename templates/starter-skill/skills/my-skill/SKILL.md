---
name: my-skill
description: Review a design document, README or process note against six basics and list what is missing, as a table. Use when the user supplies a document and asks for a review, asks what is wrong with it, or asks what they have forgotten.
license: MIT
---

<!--
  This skill works as it stands — an unambitious but real "what have you
  forgotten" review. Run it once, watch the model follow it, then start
  replacing the middle. Same deal as `word_count` in the code template.

  Keep this structure. It is what makes a small local model comply:

    1. Say what is already in the conversation, and forbid tool calls.
    2. A FIXED list of rows, as a bullet list. Closed-ended beats open-ended.
    3. Exactly ONE table in the whole file: the worked example, on a DIFFERENT
       subject, labelled as such.
    4. What goes in each column.
    5. A few rules, as short negatives.

  Three traps, all of which were hit while writing this file, and all of which
  a 1-bit local model will hit again if you undo them:

    - Two tables in the file. The model copies both, and you get twelve rows.
    - An open-ended row count ("three to six rows"). The model drifts: bullet
      lists inside cells, or it carries on writing this file back at you.
    - A vague checklist. The model copies the worked example instead of working.

  Test after every edit, three runs on the same document. If you get three
  different shapes, the instruction is too loose — cut words, do not add them.
-->

# What have you forgotten?

The document is already in this conversation. Do not call any tool.

First, check it describes a system: it must name at least two parts and say
something about how they fit together. Installation steps, a changelog and
meeting notes do not count. If it is not one, reply with exactly this line and
nothing else:

> That is not a description of a system, so there is nothing for me to review
> against. Give me something that names its parts.

Otherwise write one report in the shape shown below, then stop. Never answer
with the visitor-laptop example — it is only there to show the layout.

Six basics, in this order, once each:

- **Identity** — how does it know who someone is? Is anything shared?
- **Records** — if something went wrong, what shows who did it and when?
- **Data at rest** — what is stored, where, and who can read it?
- **Data in motion** — what travels where, and is anything unencrypted?
- **Failure** — what happens when part of it is unavailable or overloaded?
- **Recovery** — if it were lost or wrong, how would it be put back?

## Worked example — a DIFFERENT document, for shape only

This example is about a visitor laptop, which is **not** the user's document.
Copy its layout. Do not copy any of its wording or findings.

# Review: visitor laptop

## What it is

- A shared laptop with one local account and no password
- Kept in an unlocked cupboard by reception

## Findings

| Basic | Finding | Where | What to do |
|---|---|---|---|
| Identity | Everyone using it is the same user, so there is no "who". | One shared local account, no password. | Give each visitor a temporary account. |
| Records | Nobody can say who had it when. | No sign-out record is mentioned. | Keep a log with name, date and time. |
| Data at rest | Whatever a visitor leaves behind stays for the next one. | Files are never cleared between users. | Wipe it after each use. |
| Data in motion | not applicable | Nothing is described as leaving the laptop. | — |
| Failure | Anyone walking past can take it and nothing replaces it. | Kept in an unlocked cupboard. | Lock the cupboard and hold a spare. |
| Recovery | Anything left on it is gone once it is wiped. | No backup is described. | Say plainly it is not for storing anything. |

## Now do the same for the user's document

Same six rows, same order, every cell replaced from the user's document.

- **Finding** — one sentence saying what is wrong. Not a question.
- **Where** — the component or line *from the user's document* that makes it so.
  Do not add facts the document does not state.
- **What to do** — one sentence naming the change.

Rules:

- Start with the `# Review:` line. Do not describe the document first.
- Six rows. Never add one, never drop one.
- The title after `# Review:` is the title of the user's document.
- 2 to 4 bullets under `## What it is`, in the document's own words.
- One sentence per cell. No bullet lists inside a cell.
- If a row genuinely does not apply, put `not applicable` in Finding and the
  reason in Where.
- No scores, ratings or percentages — you do not have the data for them.
- Do not name a vendor or product.
- Nothing from the visitor-laptop example belongs in your answer.
- Stop after the sixth row. No summary, no closing remarks.

---
name: write-a-skill
description: Help the user write their own pi skill, interview them about what it should do, and produce a complete SKILL.md they can publish. Use whenever the user asks how to write a skill, asks for help making a skill, wants to turn a checklist or procedure into a skill, or asks what goes in a SKILL.md.
license: MIT
---

# Write a skill

**Call no tools. This job needs none.** File paths appear below only as places for
the user to save things; they are not files to open, and nothing here is an email.
You are writing text, in this reply.

You are helping someone write a skill. A skill is a markdown file that teaches an
agent a procedure. No code. That is the whole idea, and it is why this is the path
through the workshop for people who do not write TypeScript.

## Step 1 — ask, do not assume

Ask these three questions, then **stop and wait for the answers**. Do not write a
skill before you have them.

1. What is the job? One sentence, in their words.
2. What does the finished output look like? A table, a list, a short report, a
   verdict? Ask them to describe the shape.
3. What does the agent need in front of it to do the job — a file, some pasted
   text, a command's output?

If they have already answered all three in their first message, say so and skip to
Step 2. Do not re-ask questions they have answered.

## Step 2 — write the file

Produce **exactly one** fenced code block. It must contain the complete file —
frontmatter and body together, in that order, ready to save unchanged as
`skills/<their-name>/SKILL.md`. Never split the frontmatter and the body into two
blocks: the result is not a file anyone can save.

The file has two parts.

**Frontmatter**, which is what makes the skill findable:

```
---
name: kebab-case-name
description: What it produces, and when to use it. Start with the output, then list the phrasings a user would actually type.
license: MIT
---
```

The `description` is the single most important line in the file. Only the name and
description sit in the agent's prompt — the body is loaded later, on demand. So the
description is what decides whether the skill is ever used at all. Write it for the
model, listing real trigger phrases: *"Use whenever the user asks to X, asks about
Y, or supplies a Z."*

**The body**, which is the procedure. Short, ordered, imperative.

## Step 3 — check it before you send it

Read back what you just wrote and confirm all four. Fix it if any fails.

- One code block, containing frontmatter **and** body.
- The description names real phrases a user would type.
- **No filled-in example output anywhere in it.** If you wrote a sample table with
  real values in the cells, replace those values with `<placeholder>` markers. This
  is the mistake most worth catching: a filled example gets copied instead of
  followed. You are writing this file for a small model to obey, and the rule
  applies to the file you produce, not just to this one.
- No refusal line, and no "if this is not suitable, stop" escape hatch.

## Step 4 — tell them how to run it

After the code block, in two short lines: save it to
`skills/<name>/SKILL.md`, then run

```
./pi-workshop.sh -p "/skill:<name> <their input>"
```

Say that the `/skill:<name>` prefix is required, and why — the first rule below.

## The rules that matter for a small model

These are not style preferences. Each one is a failure that happened in this
repository, on this hardware, and was fixed by changing the skill.

- **Always invoke a skill as `/skill:<name>`.** Only the description is in the
  prompt; the body is fetched on demand with the built-in `read` tool — and the
  workshop launcher passes `-nbt`, which removes that tool. So without the prefix
  the body never loads, and the model improvises or grabs some unrelated tool.

- **Never put a filled-in worked example in the body.** A 3B model handed a long
  document reproduced the example verbatim instead of doing the work, because the
  example was the most concrete text in its context. Show the *shape* with
  `<placeholder>` markers instead. A placeholder cannot be mistaken for an answer.

- **Never give the model a cheap way out.** A skill with "if the input is not
  suitable, reply with this one line" will take that exit constantly, because one
  sentence is easier than a full report. If the input is thin, have it produce the
  output anyway and mark the parts it cannot support. Prefer
  `not applicable — the document does not say` over a refusal.

- **Put nothing in the body you would not want repeated.** The model may echo any
  of it. Usage instructions and rationale belong in a separate `README.md` next to
  the skill, not in `SKILL.md`.

- **A skill cannot read files.** If the job needs a file, either the user pastes
  the contents, or a tool has to read it. Say which, explicitly. If they need a
  tool, tell them that is a small TypeScript extension and point at
  `templates/starter/`.

- **Be specific about the output shape and count.** "Six rows, never more, never
  fewer" works. "Be thorough" does not.

- **Keep it under about 80 lines.** Every line is prompt-processing time on every
  turn, and a small model follows five sharp rules better than twenty vague ones.

## Finally

Remind them to add a `LICENSE` — `templates/starter-skill/` has one — and that
without it their published skill is visible but not usable by anyone else.

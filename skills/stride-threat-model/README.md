# stride-threat-model

A skill, not code: a markdown file that tells the model how to produce a STRIDE
threat model from a design document. This is the no-TypeScript path through the
workshop — you can build and publish something useful here without writing a line
of code.

## Running it

```bash
./pi-workshop.sh -p "/skill:stride-threat-model skills/stride-threat-model/example-design.md"
```

Or interactively, which is nicer:

```
/skill:stride-threat-model docs/my-design.md
```

`example-design.md` sits next to this file — small, and deliberately flawed, so
there is plenty for the model to find.

## Two things that will bite you when you write your own skill

Both of these cost real debugging time here, and neither is obvious.

**1. Skills load on demand, and the workshop launcher removes the tool that loads
them.** pi puts only a skill's *name and description* in the system prompt, then
expects the agent to fetch the full `SKILL.md` with the built-in `read` tool.
`pi-workshop.sh` passes `-nbt`, which removes the built-in tools — so the body can
never be fetched that way. **Always invoke a skill as `/skill:<name>`**, which
forces the body into context. "Threat model this design" on its own will not load
it, and the model will improvise or reach for whatever tool it does have.

**2. A worked example in a skill gets copied.** This skill used to contain a
complete filled-in example table about a print room. A 3B model handed a long
document simply reproduced the print-room table verbatim — the most concrete,
most confident-looking text in its context. Replaced with a `<placeholder>`
skeleton, which cannot be copied because it is not an answer.

A related one: the usage instructions used to live at the bottom of `SKILL.md`,
and the model echoed them into its output. Anything in a skill body is content the
model may repeat. Documentation about the skill belongs in a file like this one.

**3. Never give a small model a cheap way out.** The original had a refusal line
to use when the input was not a design document. Faced with a six-row table or one
short sentence of refusal, it refused — including on documents that were perfectly
fine. The gate is gone: it now always produces the table and marks ungroundable
cells `not applicable`.

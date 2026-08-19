# stride-threat-model

A skill, not code: a markdown file that tells the model how to produce a STRIDE
threat model from a design document. This is the no-TypeScript path through the
workshop — you can build and publish something useful here without writing a line
of code.

## Running it

```bash
./pi-workshop.sh -p "Threat model skills/stride-threat-model/example-design.md"
```

The `/skill:stride-threat-model <path>` form also works and is what forces the
skill body into context. On **Granite** both give the same six-row table. On
**Bonsai**, prefer the plain form: with the prefix it threat models the skill
instructions instead of your document.

Either way the work is done by the `threat_model` tool, which reads the file and
returns it with the required format attached — see below for why.

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

**3. A placeholder skeleton can be as bad as a filled example.** After removing the
print-room table, the skill showed the shape with `<placeholder>` markers instead.
Granite handled that. **Bonsai echoed the placeholders back as its answer** — a
table of `<...>` cells. The lesson is stronger than "don't use real values": do not
show a small model any shape it can copy. Describe the format instead, and put the
description where the data is. `threat_model` now returns the document and the
format together, which is what finally made both models produce grounded output.

**4. Never give a small model a cheap way out.** The original had a refusal line
to use when the input was not a design document. Faced with a six-row table or one
short sentence of refusal, it refused — including on documents that were perfectly
fine. The gate is gone: it now always produces the table and marks ungroundable
cells `not applicable`.

## What each model actually does

Measured, both via GPU endpoints:

| | Bonsai 8B Q1_0 | Granite 4.1 3B Q6_K |
|---|---|---|
| Reads the document via the tool | yes | yes |
| Findings grounded in the document | yes | yes |
| Six-row table, correct STRIDE categories | no | yes |
| Works with the `/skill:` prefix | no | yes |

Bonsai gives you true things about your document in whatever shape it likes, and
sometimes invents categories from a different framework (Confidentiality, Integrity,
Availability). That is what one bit per weight costs. The phishing half of the
workshop is unaffected — both models are 6/6 there.

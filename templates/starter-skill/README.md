# My pi skill

<!-- Replace this with a description of what yours actually does. -->

A pi skill built at the BSides Bristol 2026 local agents workshop. No TypeScript
in this repository — a skill is a Markdown file plus a `package.json`.

## Install

```bash
pi install https://github.com/<you>/<this-repo>
```

No npm publish needed — git is a first-class package source for pi.

## Use it

```bash
./pi-workshop.sh -p "/skill:my-skill $(cat some-document.md)"
```

The `/skill:` prefix must be the **first** thing in the message. That is what
makes pi load the skill file. In the interactive TUI, type `/skill:` and pick
it from the list.

## Develop

Edit `skills/my-skill/SKILL.md` and run it again. There is no build step and
nothing to install — the file *is* the program.

Test it the same way you would test code: run it on the same document three
times and check you get the same shape of answer each time. A small local model
will follow a short, mechanical instruction and ignore a long, discursive one,
so when it goes off the rails, cut words rather than adding them.

What reliably helps a small model:

- One worked example, clearly labelled as being about a *different* subject.
- A fixed output skeleton to fill in, rather than a description of one.
- Explicit "never add a row, never drop a row" style constraints.
- A short list of things not to do.

## Licence

MIT. See LICENSE.

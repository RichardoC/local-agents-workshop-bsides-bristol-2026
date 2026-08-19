# write-a-skill

A skill that helps you write a skill. Start here if you would rather not write
TypeScript — a skill is a markdown file, and this one interviews you and produces
the file for you.

```bash
./pi-workshop.sh -p "/skill:write-a-skill I want a skill that reviews Terraform for public S3 buckets"
```

Or just `/skill:write-a-skill` on its own, and it will ask you three questions.

## What it encodes

Every rule in `SKILL.md` is a failure that actually happened while building this
repository, on this hardware. They are worth reading even if you never use the
skill:

- Skills load **on demand** via the built-in `read` tool, and `pi-workshop.sh`
  passes `-nbt`, which removes it. So always invoke with `/skill:<name>`, or the
  body never reaches the model.
- A **filled-in worked example** in a skill body gets copied instead of followed.
- A **refusal line** in a skill body gets used constantly, because it is cheaper
  than doing the work.
- Anything in a skill body **may be echoed** into the output, which is why this
  explanation lives here and not in `SKILL.md`.

## A known limit, stated honestly

Granite 3B follows most of this and reliably slips on one rule: told not to put
filled-in examples in the skill it writes, it often includes them anyway — and
sometimes adds a line claiming it did not. Read what it produces before you publish
it. That is not a reason to skip the skill; it is the most useful thing this
workshop can show you about small models. They follow structure well and
self-assessment badly.

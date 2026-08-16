# My pi extension

<!-- Replace this with a description of what yours actually does. -->

A pi extension built at the BSides Bristol 2026 local agents workshop.

## Install

```bash
pi install https://github.com/<you>/<this-repo>
```

No npm publish needed — git is a first-class package source for pi.

## Develop

```bash
pi -e ./extensions/my-tool.ts
```

Then `/reload` inside pi after each edit. No build step: pi runs the TypeScript
directly, and bundles `typebox` and its own types, so there is nothing to
install.

```bash
npm test        # needs Node 22.6+; the extension itself does not
```

## Licence

MIT. See LICENSE.

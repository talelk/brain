# Domain docs

How engineering skills should use this repo's domain documentation.

## Before exploring, read these

- **`docs/model.md`**: the whole product model, on one page.
- **`GLOSSARY.md`** at the repo root: the words, and the ones to avoid.
- **`docs/architecture.md`**: how the model is built, when you are about to change code.

This is a single-context repo: one vocabulary and one model. `apps/*` and
`packages/contracts` are packaging boundaries, not separate contexts. Do not create
per-package glossaries.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a test
name), use the term as defined in `GLOSSARY.md`, not a synonym it lists under _Avoid_.

If the concept you need is not in the glossary, either you are inventing language the
project does not use (reconsider), or the model has a real gap: say so, and change
`docs/model.md` first.

## Decisions

There is no ADR folder. A decision that changes the model is made by editing
`docs/model.md` or `docs/architecture.md`, with the reason in the commit message. If
your output contradicts one of those pages, say so explicitly instead of silently
overriding it.

# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a **single-context** repo: one domain vocabulary, one set of decisions.

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-<decision>.md
│   └── 0002-<decision>.md
├── apps/        ← governor, runner, launcher, web
└── packages/    ← contracts (shared DTOs only)
```

`apps/*` and `packages/contracts` are packaging boundaries, not separate bounded contexts. The architecture is a deliberate modular monolith — one Governor process, one domain — so a decision or term applies across the whole repo. Do not create per-package `GLOSSARY.md` files.

Note: this repo's prose conventions also live under `docs/implementation/` and `contracts/v1/`. Those are the authoritative architecture and contract authorities; the glossary and ADRs record the vocabulary and decisions that those documents assume but never define.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

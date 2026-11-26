# Keyrus Brain

Brain runs agents on your projects and keeps a record you can trust: what ran, what it
cost, what was checked, and who approved.

You give it a goal. It turns the goal into tasks, runs each on an agent in a sandbox,
has every result checked by something other than the agent that produced it, and asks
you before anything with an effect leaves the sandbox. Code changes arrive as pull
requests.

## The model in one minute

A **workspace** is a folder that is a git repository. It lists the **projects** it works
on and holds its **agents**, **tools**, **Plays** and **memory** as plain files. **Packs**
are bundles of those you can pick from. A **task** is a goal and its result.

The whole model is one page: [docs/model.md](docs/model.md). How it is built:
[docs/architecture.md](docs/architecture.md). The words: [GLOSSARY.md](GLOSSARY.md).

## Start

Requirements: Linux, Node 24, pnpm 12, git, and Docker for the sandboxes.

```bash
pnpm install --frozen-lockfile
pnpm brain start                        # the Governor, the launcher and one runner
BRAIN_PROFILE=fixture pnpm brain start  # or: try it with no Docker and no model
```

Open the printed link, create your account, and connect a model. Brain has made a
workspace named Starter; start its "Say hello" Play to see a goal become a checked result.

`pnpm brain stop | status | logs | backup [file] | restore <file> | audit-verify` do the
rest. Data is in `~/.local/share/brain` (`BRAIN_HOME`); the port is 3100 (`BRAIN_PORT`).

To work on your own code, create a workspace, pick a pack, add a repository, and type a
goal.

## Develop

```bash
pnpm verify        # lint (ESLint, Biome, knip), typecheck, unit, runner, core and e2e tests, the pack tools' test.sh, complexity budget
pnpm test:browser  # the first-time-user walkthrough in a real browser
```

`pnpm verify` fails when the product grows past the budget in
[docs/complexity.json](docs/complexity.json): tables, commands and queries, glossary
terms, screens.

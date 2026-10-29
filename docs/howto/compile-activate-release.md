# Compile and activate a release

Configuration is declared in a release directory (start from
`examples/v1/starter-release/`), compiled into an immutable digest-addressed manifest,
and activated separately. Compile never activates.

## Layout

```text
config/*.yaml      Agents, Workflows, policies, evaluators, tools, runner groups, workspaces
agents/*.md        Instruction bytes named by each Agent's instructionsPath
schemas/*.json     Confined JSON schemas; network references are rejected
tools/<id>/<entry> The declared entrypoint script; bytes are pinned and served over the runner protocol
```

## Compile, inspect, activate

```bash
rtk pnpm exec tsx apps/cli/src/main.ts config compile examples/v1/starter-release --json
export RELEASE_DIGEST='sha256:paste-the-returned-digest'
rtk pnpm exec tsx apps/cli/src/main.ts config inspect "$RELEASE_DIGEST"
rtk pnpm exec tsx apps/cli/src/main.ts config activate "$RELEASE_DIGEST"
```

Compile collects the bundle's declared assets, rejects missing instructions/schemas and
bad references, and uses the bundle content digest as the source revision unless you
pass `--source-revision sha1:<commit>` or `sha256:<digest>`. Activation re-checks the
observed active digest; a concurrent activation from elsewhere fails the command and
requires a fresh inspection.

## Changing documents

Documents reference each other by SHA-256 of their exact bytes. After editing an
Agent, Tool or Evaluator document, recompute and update every referring document's
digest (for example the workflow step that pins the Agent, or the Agent's tool entry).
The compiler enforces the references; a stale digest fails compile or dispatch, it is
never silently accepted.

For a tool, the pin covers both the Tool document digest (in the Agent allowlist and
workflow) and the entrypoint script bytes (`sha256` of the staged file, verified at
fetch and execution time).

## Verify the activated release

```bash
rtk pnpm exec tsx apps/cli/src/main.ts workflow list --workspace <id>
rtk pnpm exec tsx apps/cli/src/main.ts doctor --workspace <id>
rtk pnpm exec tsx apps/cli/src/main.ts workflow run agent-smoke --workspace <id> --input '{"message":"BRAIN_OK"}'
```

`doctor` returns nonzero when no active release or capable runner placement exists.
The smoke check stays unverified until an independently accepted smoke run exists.

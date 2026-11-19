# Plan: reliable tasks, a lighter web, a gateway of its own

Decided with the owner after the architecture critique. Nothing here is built yet.

## 1. Preflight: a task never fails for a reason Brain could have seen first

**Why.** In production, three tasks failed for causes known before they started: a project's
default credential was ignored, a workspace had no model, a conversation outgrew the model's
window. Brain found out only when the attempt died.

**What.** One function, `preflight(workspace, project, agent)`, in `apps/governor/src/attempts/`,
returns a list of problems, each with a plain sentence and the file or setting that fixes it:

| Check | Problem it names |
|---|---|
| `modelsOf` is empty (own and admin's) | "No model: add a `[[model]]` to `models.toml` or ask the admin." |
| the project's credential (`credentialOf`) is missing from the keys | "Project `p` needs credential `c`, which is not set." |
| `context_tokens` of the routed model is under the agent's prompt size | "The prompt alone fills the model's window." |

**Built (step 1):** the checks above that need nothing outside the Governor (no model, model key not set, credential not set, prompt larger than the window), as a new wait `unready` in the queue (`attempts/preflight.ts`, called by `blockOf`). Dropped: the agent's model (the folder's validation already refuses an unknown one) and the repository probe (a network call has no place in the claim loop; left for later, as its own check when a task is created).

**Where it shows.** Wherever the queue shows why a task waits (the queue, the task, Today). It is
looked at again on every claim, so a secret set later starts the task at once. Not done: a "Ready to
run" line on the workspace screen, and a note at task creation (the wait already says it, and a note
would be a second copy of the same fact).

**Model.** `docs/model.md`, "The queue": a task that cannot work waits with the sentence of the first
thing wrong. No new table: nothing is stored.

## 2. The RPG village: its own chunk (done)

**Finding.** The village already has its own view (`/village`, apart from `/live`), so a setting
would hide nothing. What was wrong: both views shared one chunk, so Live fetched the village's
map, sprites and music too.

**Done.** `World` is loaded on demand inside the village view. Live chunk 111 kB to 36 kB
(gzip 37 to 11); the village is its own 75 kB chunk (gzip 26), fetched only on `/village`.
The browser test of Live and the village passes.

## 3. The model gateway in its own process

**Why.** `/model/v1` streams long responses. In one process, a burst of model calls competes
with the API, the timers and the audit chain.

**What.** The same binary, started as `governor --gateway` on `BRAIN_GATEWAY_PORT`. It mounts
only `registerGateway` and shares the SQLite file (WAL, `busy_timeout`). The main process stops
mounting it when `BRAIN_GATEWAY_URL` points elsewhere.

**Risks to settle before building.**
1. Two writers on one SQLite file: the audit chain's head must be read inside the write
   transaction (`BEGIN IMMEDIATE`) so two processes cannot extend the same head.
2. The spend hold and release (`trust/usage.ts`) must stay atomic across processes: same rule.
3. `deploy/` gains a second service; the demo and the launcher's sandbox network must reach
   the new port (`BRAIN_GATEWAY_URL` already exists for this).

If risk 1 cannot be met with a small change, stop and keep one process.

## Order

1. Preflight (largest benefit, no new moving part).
2. Village setting and the size report.
3. Gateway process, only after the two SQLite risks are checked.

Each step: change `docs/model.md` or `docs/architecture.md` first, then code, then
`pnpm verify`, then the browser suite for the screens touched. No push or deploy without the
owner's word.

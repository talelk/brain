# Live server operations

As of `talelk/brain@e4017e5` (2026-11-11):
- Demo URL `https://brain.mykeyrus.tn`; the browser is already signed in as Administrator in the user's Chrome (Claude-in-Chrome tools).
- SSH: `demos.mykeyrus.tn:42242` timed out after many connections on 2026-11-10; use the Tailscale host `ns390729` port 42242 user `talel`. The key `/home/talel/dev/keys/id_rsa` is only configured for the other host name, so start a temporary `ssh-agent` + `ssh-add` inside the same shell command (agent env does not persist between Bash calls) and pass `-p 42242`.
- Deploy: `BRAIN_DEPLOY_HOST=ns390729 BRAIN_DEPLOY_PORT=42242 BRAIN_DEPLOY_SUDO_PASSWORD=<ask the user> ./scripts/deploy-demo.sh`. It rsyncs, repairs live schema, recreates the governor container, restarts launcher and runners; it never resets data. Runners restart right after: wait ~1 min before judging planning/runs.
- Inspect data: `scp` a `node:sqlite` script to the host, `docker cp` it into `brain-governor-1`, `docker exec brain-governor-1 node /tmp/x.mjs`. DBs: `/data/control.db`, `/data/workspaces/ws-ded6091d-fea2-44b0-b46a-2a5cb10ae7c1.db` (workspace id `ws-ded6091d-fea2-44b0-b46a-2a5cb10ae7c1`). The container is recreated on deploy, so re-copy scripts.
- Tests: `export TMPDIR=$HOME/.cache/tmp` (the default /tmp fills); `pnpm verify:fast`, `pnpm test:integration`, `pnpm test:chaos`, `pnpm test:security`; browser: `pnpm build` then `npx playwright test <spec> --project=1440-light --forbid-only --update-snapshots=none`. Kill orphaned Playwright runs.
- The live release catalog holds only two workflows (`operations-triage` takes `{situation}`, `support-draft`), pinned by digest; changing an agent markdown file re-pins digests and needs a release restage + activation.

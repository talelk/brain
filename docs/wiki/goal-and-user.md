# Goal and user

- On 2026-11-11 the user (owner of `talelk/brain`) asked for Brain to become "the best product of the world", usable by a first-time user with nothing manual: "i dont want to do anything manual", "all features seem complex & non intuitive".
- On 2026-11-10/11 the user said the product "is not usable" and listed: launch, live, config, outputs, UI, administration screens.
- Working style: wants action over questions; gives short imperative messages; accepts recommendations ("yes", "all"). The live demo is `brain.mykeyrus.tn`; deploys go through `scripts/deploy-demo.sh` (see [ops-live-server.md](ops-live-server.md)).
- Standing policy (AGENTS.md at `5b27f06`): build the target architecture directly; no compatibility shims or migrations.
- The user typed the server sudo password into chat on 2026-11-10; it must never be copied into prompts, files or commits. Ask the user to rotate it.
- On 2026-11-11 the user set a standing rule: "always use browser as user to validate enhance & fix & optimize". Passing tests is not enough; each change is checked by clicking through the real app as a first-time user (live site after deploy, or a local instance with Playwright screenshots for subagents).

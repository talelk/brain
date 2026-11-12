# Access, safety and change rules

- No agent receives SSH keys, sudo passwords, `.env` files or tokens. If a task seems to need one, stop and ask a person.
- Allowed to propose: restarts of one compose project, nginx reloads, log reads, disk reports.
- Needs the owner's explicit yes: deleting anything under `/srv/demos/backups`, `docker volume rm`, `docker compose down -v`, firewall or Tailscale changes, certificate removal, changing a `.env`.
- Never run on the shared host: anything that restarts all containers, `docker system prune -a`, kernel or package upgrades during demos.
- Record every change as a note on the task it belongs to: what, why, how to undo.
- SSH reaches the host as `talel` on port 42242 over the Tailscale name; `demos.mykeyrus.tn:42242` has timed out before, so prefer Tailscale.
- Brain deploys use `scripts/deploy-demo.sh` and `scripts/stage-demo-release.sh` in the Brain repository.

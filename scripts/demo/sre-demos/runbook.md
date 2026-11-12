# SRE runbook for the demos server

Rule zero: Brain agents here only read and reason. They never hold SSH access. Every command below is run by a person (or approved by one); an agent proposes it with the evidence.

## A demo site is down
1. Public check: `curl -sI https://<name>.mykeyrus.tn | head -1`.
2. Upstream check: `curl -sI http://127.0.0.1:<port>` using the port in the inventory.
3. Container: `docker ps -a --filter name=<name>`, then `docker logs --tail 100 <container>`.
4. nginx: `sudo nginx -t`, then `sudo systemctl status nginx`.
5. Restart only the one project: `cd /srv/demos/<folder> && docker compose up -d` (never `down -v`: it deletes volumes).
6. Verify the public URL again and record what you did.

## Disk filling up
1. `df -h /srv`, then `du -xh --max-depth=1 /srv/demos | sort -h | tail`.
2. Known large items: `backups/synthetic-*-control-plane.db` (about 3 GB), `brain-src-backup-*.tar.gz`, docker images (`docker system df`).
3. Propose, with sizes, what could go. Deleting backups or volumes always needs the owner's yes.

## Brain is unhealthy
1. `docker ps` shows `brain-governor-1` healthy; `curl -s http://127.0.0.1:3100/v1/doctor`.
2. `systemctl is-active brain-launcher brain-runner-agents brain-runner-evaluators`.
3. Restart the units with sudo; wait one minute before judging runs.
4. Redeploying is `scripts/deploy-demo.sh` from the Brain repository, never a manual compose edit.

## Certificate or nginx change
1. `sudo certbot certificates` for expiry; `sudo certbot renew --dry-run`.
2. Edit a vhost, run `sudo nginx -t`, then `sudo systemctl reload nginx`. Keep a copy of the old file.

## Weekly review (the Play this workspace is built around)
Read the inventory and monitoring documents, compare against the latest findings the owner pastes in (Gatus state, `docker ps`, `df -h`), and produce: what is red, what is trending badly, and the three most useful fixes with commands and risk.

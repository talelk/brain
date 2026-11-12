# Demos server inventory (as of 2026-11-12)

One Ubuntu host (Tailscale name `ns390729`, SSH port 42242), 1.8 TB disk (about 67% used), 125 GB RAM. Every demo lives in its own folder under `/srv/demos/<name>` with a `docker-compose.yml`; nginx terminates TLS (certbot renews on a systemd timer) and proxies each `*.mykeyrus.tn` name to a loopback port.

| Public name | Upstream | Folder / container | What it is |
|---|---|---|---|
| brain.mykeyrus.tn | 127.0.0.1:3100 | `brain` / `brain-governor-1` | Keyrus Brain Governor (plus systemd units brain-launcher, brain-runner-agents, brain-runner-evaluators) |
| cvinsights.mykeyrus.tn | 8730 (3070 Rill) | `cvinsights` / `cvinsights-web-1` | CV Insights dashboards |
| ps-insights.mykeyrus.tn | 3070 | `ps-insights` / `ps-insights-rill-1` | PS Insights (Rill) |
| health360.mykeyrus.tn | 3602 | `health360` | Health 360 |
| docus.mykeyrus.tn | 3000 | `omniflow-docus` | Docus site |
| docus-zain.mykeyrus.tn | 3003 | `zain-docus` | Docus site for Zain |
| newqlik.mykeyrus.tn, newqlik-studio.mykeyrus.tn | 3200, 3210 | `newqlik` (query, build) | NewQlik |
| synthetic.mykeyrus.tn | 4500 | `of-synthetic` (api, worker, redis, redroid, runners 6-10) | Synthetic runner farm |
| vue360.mykeyrus.tn | 4000 | `of-vue360-ai` | Vue 360 AI |
| kiosrh.mykeyrus.tn | 3044 | `kios-newrh` | Kiosk RH |
| teknova.mykeyrus.tn, presence.mykeyrus.tn | 5005 | `ai-teknova-demo` (teknova-nao) | Teknova demo |
| auto.mykeyrus.tn | 5678 | `n8n` | n8n automation |
| ai.mykeyrus.tn | 3022 (Open WebUI), 11434 (Ollama) | `open-webui`, `ollama` | Local models |
| memory.mykeyrus.tn, captree.mykeyrus.tn | 8125, 8420, 8424, 8096 | tdai-memory-hub / core, tdai-proxy | TencentDB agent memory |
| victoria.mykeyrus.tn | 8428 (metrics), 9428 (logs), 3060 (Grafana) | `victoria` | VictoriaMetrics, VictoriaLogs, Grafana, vmagent, vector, node-exporter, cAdvisor |
| mgcatalog.mykeyrus.tn | n/a | `mgcatalog` | Catalog demo |
| demos.mykeyrus.tn | n/a | nginx | Demos hub page |

Also present in `/srv/demos`: `gatus` (uptime checks), `backups`, `captree`, `mistral`, `unsloth`, `presence`, and `limits-*` (resource-limit snapshots).

## Ownership
Everything runs as user `talel` (docker group). Sudo is needed for systemd units and nginx reloads. Never copy `.env` files, tokens or passwords into documents, tasks or chat.

---
type: Reference
title: Demos server inventory (as of 2026-11-12)
---

One Ubuntu host (Tailscale name `ns390729`, SSH port 42242), 1.8 TB disk (about 67% used), 125 GB RAM. Every demo lives in its own folder under `/srv/demos/<name>` with a `docker-compose.yml`; nginx terminates TLS (certbot renews on a systemd timer) and proxies each `*.mykeyrus.tn` name to a loopback port.

| Public name | Upstream | Folder / container | What it is |
|---|---|---|---|
| brain.mykeyrus.tn | 127.0.0.1:3100 | `brain` / `brain-governor-1` | Keyrus Brain Governor (plus systemd units brain-launcher, brain-runner-agents, brain-runner-evaluators) |
| cvinsights.mykeyrus.tn | 8730 (the web app; the Rill dashboards it embeds are on 3070, shared with ps-insights) | `cvinsights` / `cvinsights-web-1` | CV Insights dashboards |
| ps-insights.mykeyrus.tn | 3070 | `ps-insights` / `ps-insights-rill-1` | PS Insights (Rill) |
| health360.mykeyrus.tn | 3602 | `health360` / `health360-web-1` | Health 360 |
| docus.mykeyrus.tn | 3000 | `omniflow-docus` / `omniflow-docus-docus-1` | Docus site |
| docus-zain.mykeyrus.tn | 3003 | `zain-docus` / `zain-docus-docus-1` | Docus site for Zain |
| newqlik.mykeyrus.tn, newqlik-studio.mykeyrus.tn | 3200, 3210 | `newqlik` (query, build) | NewQlik |
| synthetic.mykeyrus.tn | 4500 | `of-synthetic` (api, worker, redis, redroid, runners 6-10) | Synthetic runner farm |
| vue360.mykeyrus.tn | 4000 | `of-vue360-ai` | Vue 360 AI |
| kiosrh.mykeyrus.tn | 3044 | `kios-newrh` | Kiosk RH |
| teknova.mykeyrus.tn | 5005 (nao; 8005 is its API) | `ai-teknova-demo` / `teknova-nao` | Teknova demo |
| presence.mykeyrus.tn | none (static files served by nginx) | `presence` (carte_opportunites.html, carte_projets.html) | Presence maps |
| auto.mykeyrus.tn | 5678 | `n8n` | n8n automation |
| ai.mykeyrus.tn | 3022 (Open WebUI), 11434 (Ollama) | `open-webui`, `ollama` | Local models |
| memory.mykeyrus.tn | 8125 (hub), 8420 (core), 8424, 8096 (proxy) | containers tdai-memory-hub, tdai-memory-core, tdai-proxy | TencentDB agent memory |
| captree.mykeyrus.tn | none (static `index.html` served by nginx) | `captree` | Captree page |
| victoria.mykeyrus.tn | 8428 (metrics), 9428 (logs), 3060 (Grafana) | `victoria` | VictoriaMetrics, VictoriaLogs, Grafana, vmagent, vector, node-exporter, cAdvisor |
| mgcatalog.mykeyrus.tn | none (static files served by nginx) | `mgcatalog` | Catalog demo (browser-side app.js and sql.js) |
| demos.mykeyrus.tn | none (served directly by nginx) | nginx | Demos hub page |

Also present in `/srv/demos`: `gatus` (uptime checks), `backups`, `mistral` and `unsloth` (model experiments, no public name, nothing running from them as of 2026-11-12), and `limits-*` (root-owned resource-limit snapshots).

## Retired names (nginx config disabled 2026-10-27, kept in `/etc/nginx/disabled/`)
`sf1prod.mykeyrus.tn`, `m.nouvelair.mykeyrus.tn` and `autorobot` are not served by this host any more. Gatus still checks them, so those checks are expected to be red until they are removed from `/srv/demos/gatus/config/config.yaml` (owner's call).

## Ownership
Owner of every demo: the demos-server owner (user `talel`, docker group); there is no per-demo owner. If a demo gets its own maintainer, add an Owner column. Sudo is needed for systemd units and nginx reloads. Never copy `.env` files, tokens or passwords into documents, tasks or chat.

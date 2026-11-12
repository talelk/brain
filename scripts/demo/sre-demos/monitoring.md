# Monitoring and signals

- **Gatus** (`/srv/demos/gatus/config/config.yaml`): HTTPS checks on docus, docus-zain, ai (Open WebUI), n8n-auto, demos-hub, vue360, teknova, synthetic, kiosrh, sf1prod, nouvelair-m and autorobot. A red Gatus entry is the first signal for "site is down".
- **VictoriaMetrics** (127.0.0.1:8428, public path `victoria.mykeyrus.tn`): host metrics from node-exporter, container metrics from cAdvisor, scraped by vmagent.
- **VictoriaLogs** (127.0.0.1:9428): container logs shipped by vector.
- **Grafana** (127.0.0.1:3060, `ai.mykeyrus.tn` path): dashboards over both.
- **Docker health**: `docker ps` shows `(healthy)` for most services. Containers without a health check (n8n, kios-rh-new-1, of-vue360-ai-app-1, victoria-vmagent, victoria-vector, victoria-node-exporter) can be "Up" and still broken: check their logs and the public URL.
- **Brain** itself: `https://brain.mykeyrus.tn/v1/doctor` (readiness) and the Health page in Administration.

## What counts as a problem
| Signal | Threshold | First action |
|---|---|---|
| Public URL not 200/302 | two consecutive Gatus failures | check container state, then nginx upstream port |
| Disk used | above 80% of 1.8 TB | find the biggest folder under `/srv/demos` and docker images/volumes; report, do not delete |
| Memory available | below 8 GB | list containers by memory (`docker stats --no-stream`) |
| Container restarting | more than 3 restarts in an hour | read the last 100 log lines, report the cause |
| Certificate expiry | fewer than 14 days | confirm the certbot timer is active |

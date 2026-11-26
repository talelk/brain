# The egress proxy: one file, node built-ins only, run with node's own type stripping. Grants come from /grants (read-only).
# Build from the repository root: docker build -f deploy/egress-proxy.Dockerfile -t brain-egress-proxy .
FROM node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
COPY apps/launcher/src/egress-proxy.ts /app/egress-proxy.ts
USER node
ENV BRAIN_PROXY_PORT=18080 BRAIN_EGRESS_GRANTS_DIR=/grants
EXPOSE 18080
CMD ["node", "/app/egress-proxy.ts"]

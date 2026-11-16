# The Governor: the API and the built web app in one process (docs/architecture.md section 1).
# It runs from its TypeScript sources with tsx, as everywhere in this repository. The packs it ships with are in the image
# (/app/packs). Data lives outside it, on /data. Runners and the launcher are not in this image: they run on a runner host.
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/governor apps/governor
COPY apps/web apps/web
# Only what the Governor and the web app need: the engines belong to the runner.
RUN pnpm install --frozen-lockfile --filter "@brain/governor..." --filter "@brain/web..." \
  && pnpm --filter @brain/web build
COPY packs packs

ENV NODE_ENV=production \
    HOME=/tmp \
    BRAIN_DATA_DIR=/data \
    PORT=3100 \
    BRAIN_BIND_HOST=0.0.0.0 \
    BRAIN_BASE_URL=http://localhost:3100

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3100/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/apps/governor
CMD ["node", "--import", "tsx", "src/main.ts"]

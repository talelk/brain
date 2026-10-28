# Keyrus Brain Governor deployment image (T48).
# The workspace runs from TypeScript sources via tsx (repo convention);
# native deps (better-sqlite3) compile in-image. Data lives on the /data
# volume; the process runs as the unprivileged node user.
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm approve-builds better-sqlite3 esbuild \
  && pnpm rebuild better-sqlite3 \
  && pnpm --filter @brain/web build

ENV NODE_ENV=production \
    BRAIN_DATA_DIR=/data \
    PORT=3100 \
    BRAIN_BASE_URL=http://127.0.0.1:3100

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3100/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@brain/governor", "start"]

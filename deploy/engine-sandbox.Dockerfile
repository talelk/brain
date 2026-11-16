# The engine sandbox image: the runner's engines (Pi, Claude, an ACP agent) and the host process that serves one of them to the runner
# over the launcher. The launcher runs it per attempt with a read-only root, no capabilities, resource limits, the attempt's folders
# (/work, /out, /state) and a network only through the egress proxy; nothing here may assume more.
# The engines' own tools run here, on the working copy: git, a shell, and the search programs Pi and Claude call (ripgrep, fd). What a
# project needs to build and test (its own toolchain) belongs in an image derived from this one, under the same name.
# Build from the repository root: docker build -f deploy/engine-sandbox.Dockerfile -t brain-sandbox-engine .
# An ACP agent (OpenCode, a Codex ACP adapter) is not part of this image: add its binary in a derived image and name it with
# BRAIN_OPENCODE_COMMAND / BRAIN_CODEX_COMMAND there (the launcher passes no command to the container).
FROM node:24-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git ripgrep fd-find \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate && npm install --global tsx@4.20.6
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/runner/package.json apps/runner/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile --filter @brain/runner...
COPY apps/runner apps/runner
COPY packages/contracts packages/contracts
ENV NODE_ENV=production BRAIN_ENGINE_HOST=1
# Stdin and stdout are the engine port; the launcher decides the user, the mounts and the network.
CMD ["tsx", "/app/apps/runner/src/engines/sandbox-host.ts"]

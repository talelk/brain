# The engine sandbox image (ADR 0067): the runner's engines (Pi, Claude, an ACP agent) and the host process that serves one of them to the
# runner over the launcher. The launcher runs it per attempt with a read-only root, no capabilities, resource limits, one writable mount
# (the attempt's state) and a network only through the egress proxy; nothing here may assume more.
# Build from the repository root: docker build -f deploy/engine-sandbox.Dockerfile -t brain-sandbox-engine .
# An ACP agent (OpenCode or another) is not part of this image: add its binary and name it with BRAIN_OPENCODE_COMMAND / BRAIN_ACP_COMMAND on the
# runner (the runner forwards those settings), or build a derived image under the same name.
FROM node:24-slim
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

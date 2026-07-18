# Built from the monorepo root (see build-backend.yaml `context: .`).
# The backend imports packages/rill-sdk source directly (../../../packages/rill-sdk/src),
# so the image needs the workspace layout, and the install must use the root
# workspace lockfile — which is the one CI keeps consistent. The previous
# isolated `./rill-backend` context could neither resolve the SDK source nor
# validate its stale standalone lockfile, so this build never passed.
FROM oven/bun:1.3.9 AS base
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# Copy every workspace member's manifest first so `--frozen-lockfile` can validate
# the root lockfile, then install once. Deps hoist to /app/node_modules, reachable
# by both rill-backend and packages/rill-sdk (whose only dep, zod, resolves there).
COPY package.json bun.lock ./
COPY rill-backend/package.json ./rill-backend/
COPY rill-frontend/package.json ./rill-frontend/
COPY packages/rill-sdk/package.json ./packages/rill-sdk/
COPY packages/rill-signer/package.json ./packages/rill-signer/
RUN bun install --frozen-lockfile

# Only the backend and the SDK source it imports at runtime.
COPY rill-backend ./rill-backend
COPY packages/rill-sdk ./packages/rill-sdk

ENV PORT=3939
EXPOSE 3939

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=20s \
  CMD curl -f http://localhost:3939/health || exit 1

WORKDIR /app/rill-backend
CMD ["bun", "run", "src/index.ts"]

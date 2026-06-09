ARG BUN_VERSION=1.3.14

FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN corepack enable \
  && corepack prepare pnpm@10.15.1 --activate

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/ai-worker/package.json apps/ai-worker/package.json
COPY apps/finance-worker/package.json apps/finance-worker/package.json
COPY apps/indexer-dflow/package.json apps/indexer-dflow/package.json
COPY apps/indexer-hyperliquid/package.json apps/indexer-hyperliquid/package.json
COPY apps/indexer-kalshi/package.json apps/indexer-kalshi/package.json
COPY apps/indexer-limitless/package.json apps/indexer-limitless/package.json
COPY apps/indexer-polymarket/package.json apps/indexer-polymarket/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/infra/package.json packages/infra/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY apps apps
COPY packages packages
COPY ops ops

RUN pnpm --filter @hunch/config build \
  && pnpm --filter api... build \
  && pnpm --filter ai-worker... build \
  && pnpm --filter finance-worker... build \
  && pnpm --filter indexer-dflow... build \
  && pnpm --filter indexer-hyperliquid... build \
  && pnpm --filter indexer-kalshi... build \
  && pnpm --filter indexer-limitless... build \
  && pnpm --filter indexer-polymarket... build

# Bun is a single executable. Use the official image as the binary source
# instead of running the installer script inside the production runtime image.
FROM oven/bun:${BUN_VERSION} AS bun-runtime

FROM node:20-bookworm-slim AS runtime

ARG BUN_VERSION=1.3.14
WORKDIR /app
ENV NODE_ENV=production

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun

RUN test "$(bun --version)" = "${BUN_VERSION}" \
  && bun --revision

RUN groupadd --system --gid 10001 hunch \
  && useradd --system --uid 10001 --gid hunch --home-dir /home/hunch --create-home hunch \
  && chown hunch:hunch /app

COPY --chown=10001:10001 --from=builder /app/node_modules /app/node_modules
COPY --chown=10001:10001 --from=builder /app/package.json /app/package.json
COPY --chown=10001:10001 --from=builder /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --chown=10001:10001 --from=builder /app/apps /app/apps
COPY --chown=10001:10001 --from=builder /app/packages /app/packages
COPY --chown=10001:10001 --from=builder /app/ops/run-js-runtime.sh /app/ops/run-js-runtime.sh

USER hunch

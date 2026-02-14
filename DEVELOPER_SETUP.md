# Developer Setup Guide

This guide will help you set up the Hunch project for local development.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Project Overview](#project-overview)
3. [Initial Setup](#initial-setup)
4. [Environment Configuration](#environment-configuration)
5. [Database Setup](#database-setup)
6. [Running the Project](#running-the-project)
7. [Development Workflow](#development-workflow)
8. [External Documentation](#external-documentation)

---

## Prerequisites

Before you begin, ensure you have the following installed:

### Required Software

- **Node.js**: v18 or higher ([Download](https://nodejs.org/))
- **pnpm**: v10.15.1 or higher ([Installation Guide](https://pnpm.io/installation))
  ```bash
  npm install -g pnpm@10.15.1
  ```
- **Docker & Docker Compose**: For running PostgreSQL and Redis locally ([Download](https://www.docker.com/products/docker-desktop))
- **Git**: For version control ([Download](https://git-scm.com/))

### Optional but Recommended

- **PostgreSQL Client**: For direct database access (pgAdmin, DBeaver, or psql CLI)
- **Redis CLI**: For debugging Redis (usually comes with Redis installation)
- **VS Code** or your preferred IDE with TypeScript support

---

## Project Overview

**Hunch** is a unified prediction market terminal that aggregates markets from multiple platforms (Polymarket, Kalshi, Limitless) into a single dashboard. The project consists of:

- **API Server** (`apps/api`): Fastify-based REST API for market data, orders, and user management
- **Indexers** (`apps/indexer-*`): Background services that fetch and normalize market data from various venues
  - `indexer-polymarket`: Indexes Polymarket markets
  - `indexer-kalshi`: Indexes Kalshi markets
  - `indexer-limitless`: Indexes Limitless markets
- **Shared Packages** (`packages/*`): Shared utilities and database schemas

### Tech Stack

- **Runtime**: Node.js with TypeScript
- **API Framework**: Fastify
- **Database**: PostgreSQL with TimescaleDB extension
- **Cache**: Redis
- **Package Manager**: pnpm (monorepo with workspaces)
- **Build Tool**: Turbo (for monorepo task orchestration)
- **Authentication**: Privy (wallet-based authentication)

---

## Initial Setup

### 1. Clone the Repository

```bash
git clone <repository-url>
cd hunch
```

### 2. Install Dependencies

```bash
pnpm install
```

This will install all dependencies for the monorepo, including all apps and packages.

### 3. Verify Installation

```bash
# Check pnpm version
pnpm --version  # Should be 10.15.1 or higher

# Check Node version
node --version  # Should be v18 or higher

# Verify Docker is running
docker --version
docker compose version
```

---

## Environment Configuration

### 1. Create Environment File

Create a `.env` file in the root directory:

```bash
cp .env.example .env 
# OR create manually
touch .env
```

### 2. Required Environment Variables

Add variables to your `.env` file

At minimum (for auth + safely storing venue credentials), set:

- `JWT_SECRET`
- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`
- `CREDENTIALS_ENCRYPTION_KEY` (32 bytes; base64 or 64-char hex). Generate with:
  ```bash
  openssl rand -base64 32
  ```

For Polymarket positions sync (on-chain reads), also set:

- Optional: `POLYGON_RPC_URL` (defaults to `https://polygon-rpc.com`)
- Optional overrides:
  - `POLYGON_RPC_TIMEOUT_MS`
  - `POLYMARKET_CONDITIONAL_TOKENS_ADDRESS` (defaults to `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`)

### 3. Get API Credentials

#### Privy Credentials

1. Sign up at [Privy](https://privy.io/)
2. Create a new app
3. Copy the App ID and App Secret to your `.env` file

#### Kalshi Credentials (if using Kalshi indexer)

1. Sign up for a Kalshi API account
2. Generate API credentials
3. Download the private key file
4. Update `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY_PATH` in `.env`


---

## Database Setup

### 1. Start Infrastructure Services

Start PostgreSQL and Redis using Docker Compose:

```bash
# Docker Compose v2 (recommended)
pnpm infra2:up

# If you have legacy docker-compose v1 installed
# pnpm infra:up
```

This will:
- Start PostgreSQL (TimescaleDB) on port 5432 (default)
- Start Redis on port 6379 (default)
- Create necessary volumes for data persistence

#### Port Conflicts (Common)

If you already have PostgreSQL/Redis running on your machine (or in other Docker projects), you may hit an error like:

- `Bind for 0.0.0.0:6379 failed: port is already allocated`

All host ports are configurable via `.env` because `ops/docker-compose.yml` uses:

- `PGPORT` for Postgres port mapping
- `REDIS_PORT` for Redis port mapping

If you change host ports, also update the app connection strings (apps run on your host):

```bash
# Example: run Hunch Postgres on 5433 and Redis on 6380
PGPORT=5433
DATABASE_URL=postgresql://hunch:hunch@localhost:5433/hunch

REDIS_PORT=6380
REDIS_URL=redis://localhost:6380
```

### 2. Verify Services are Running

```bash
# Check Docker containers
docker ps

# You should see:
# - hunch-postgres
# - hunch-redis

# Test PostgreSQL connection
docker exec -it hunch-postgres psql -U hunch -d hunch -c "SELECT version();"
# Or use the helper script:
pnpm psql:docker

# Test Redis connection
docker exec -it hunch-redis redis-cli ping
# Should return: PONG
# Or use the helper script:
pnpm redis:docker
```

### 3. Run Database Migrations

```bash
pnpm migrate
```

This will run all database migrations from `packages/db/migrations/` in order.

### 4. Stop Infrastructure Services

When you're done:

```bash
# Docker Compose v2 (recommended)
pnpm infra2:down

# If you have legacy docker-compose v1 installed
# pnpm infra:down
```

To stop and remove containers (data persists in volumes):

### 5. Smoke Test API

With `pnpm dev` running in another terminal:

```bash
pnpm smoke:api
```

```bash
pnpm infra2:down -- -v  # Also removes volumes (⚠️ deletes data)
```

---

## Running the Project

### Development Mode

Run all services in development mode:

```bash
pnpm dev
```

This will start:
- API server on `http://localhost:3001`
- All indexers (polymarket, kalshi, limitless)

### Polymarket Sync Tuning (Optional)

The Polymarket indexer is designed to be fast on restart and avoid re-syncing the full dataset every time:

- **Periodic hot refresh**: fetches the most recently updated events using `order=updatedAt&ascending=false` in a bounded time window.
  - Runs **two passes**: `closed=false` (open) and `closed=true` (closed) to reliably catch closures and status transitions.
- **Background catch-up**: continues an inventory crawl using `order=id&ascending=true` from a saved `offset` cursor in Redis.

Common knobs:

- `POLYMARKET_REFRESH_MIN=10` (how often to run hot refresh)
- `POLYMARKET_PAGE_SIZE=500` (Gamma page size; API caps at 500)
- `POLYMARKET_HOT_LOOKBACK_MIN=30` (how far back in time to refresh by `updatedAt`; default is `max(REFRESH_MIN*2, 30)`)
- `POLYMARKET_HOT_MAX_PAGES=10` (safety cap for hot refresh pagination)
- `POLYMARKET_OVERLAP_PAGES=2` (rewind the catch-up cursor by this many pages on restart)

WS orderbook streaming (best bid/ask) is always a subset:

- `INDEXER_WS_SUBSET=200` (max subscribed tokens)
- `INDEXER_TOP_BOOK_SNAPSHOT=150` (how many tokens to snapshot once at startup)
- `INDEXER_WS_REFRESH_SEC=60` (how often to recompute and resubscribe WS targets, independent from HTTP refresh)
- `INDEXER_WS_RESUBSCRIBE_SEC=60` (how often to re-send full WS subscriptions to heal drift)
- `INDEXER_WS_SUB_CHUNK_SIZE=250` (batch size for subscribe/unsubscribe frames)
- Optional per-indexer overrides: `POLYMARKET_WS_REFRESH_SEC`, `DFLOW_WS_REFRESH_SEC`, `LIMITLESS_WS_REFRESH_SEC`
- `HOT_TOKENS_TTL_SEC=1800` and `HOT_TOKENS_MAX=5000` (global hot-token retention/cap)
- `HOT_STREAM_TOKENS_TTL_SEC=1800`, `HOT_STREAM_TOKENS_MAX=5000`, `HOT_STREAM_MARK_INTERVAL_SEC=60` (sticky retention for actively streamed token sets)

---

## Development Workflow

### Making Changes

1. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** in the relevant app/package

3. **Test locally**:
   ```bash
   pnpm dev  # Run in development mode
   ```

4. **Run type checking**:
   ```bash
   pnpm typecheck
   ```

5. **Run linter** (if configured):
   ```bash
   pnpm lint
   ```

### Database Changes

If you need to modify the database schema:

1. **Create a new migration**:
   ```bash
   # Create migration file in packages/db/migrations/
   # Name format: XXXX_description.sql (where XXXX is next number)
   ```

2. **Write migration SQL**:
   ```sql
   -- Example: packages/db/migrations/0024_add_new_column.sql
   ALTER TABLE unified_markets ADD COLUMN new_column TEXT;
   ```

3. **Test migration**:
   ```bash
   # Reset database (⚠️ deletes all data)
   pnpm infra2:down -- -v
   pnpm infra2:up
   pnpm migrate
   ```

---

## Admin + Debug Utilities

These helpers live in `apps/api` and load the repo root `.env` automatically.

### Admin user helper

Grant/revoke admin access and inspect users:

```bash
# Grant admin by wallet address
pnpm -C hunch-monorepo -F api run admin:user -- --wallet 0x... --grant

# Revoke admin by user id
pnpm -C hunch-monorepo -F api run admin:user -- --user-id <uuid> --revoke

# Show a user record
pnpm -C hunch-monorepo -F api run admin:user -- --user-id <uuid> --show

# List all admins
pnpm -C hunch-monorepo -F api run admin:user -- --list-admins
```

If a wallet maps to multiple users, pass `--user-id` to disambiguate.

### Admin points helper

Add manual clout points by inserting a `volume_events` row:

```bash
# Add 500 points to a user
pnpm -C hunch-monorepo -F api run admin:points -- --user-id <uuid> --amount 500

# Add points by wallet lookup (uses that wallet as the event wallet)
pnpm -C hunch-monorepo -F api run admin:points -- --wallet 0x... --amount 250
```

Optional flags: `--source-id`, `--source-type order|execution`, `--venue`, `--wallet-address`, `--dry-run`.

### Polymarket CLOB curl helper

Use it to query the Polymarket CLOB API with your L2 credentials:

```bash
# Use env creds (POLYMARKET_L2_* and optional POLYMARKET_L2_ADDRESS)
pnpm -C hunch-monorepo -F api run polycurl -- 0x... /data/trades?maker=0x...&after=1710000000

# Use DB creds (requires DATABASE_URL + CREDENTIALS_ENCRYPTION_KEY)
pnpm -C hunch-monorepo -F api run polycurl -- --use-db 0x... /data/orders
```

Optional flags: `--method`, `--body`, `--user-id`.

### Limitless curl helper

Use it to query Limitless endpoints with a session cookie:

```bash
# Use env session (LIMITLESS_SESSION and optional LIMITLESS_WALLET_ADDRESS)
pnpm -C hunch-monorepo -F api run limitlesscurl -- /portfolio/positions

# Use DB session (requires DATABASE_URL + CREDENTIALS_ENCRYPTION_KEY)
pnpm -C hunch-monorepo -F api run limitlesscurl -- --use-db 0x... /portfolio/positions
```

Optional flags: `--method`, `--body`, `--user-id`, `--base-url`.

### Fees + rewards operations

```bash
# Collect Polymarket fees (fee collector wallet signs)
pnpm -C hunch-monorepo -F api run fees:collect

# Collect fees and archive expired fee auths (prevents repeat skips)
pnpm -C hunch-monorepo -F api run fees:collect -- --archive-legacy

# Reconcile pending Solana fee events
pnpm -C hunch-monorepo -F api run fees:reconcile -- --limit 25 --min-age-sec 60

# Payout rewards (EVM + Solana)
pnpm -C hunch-monorepo -F api run rewards:payout -- --dry-run --chain solana

# Fail pending claims (no payout)
pnpm -C hunch-monorepo -F api run rewards:payout -- --fail-pending --chain solana
```

Required env depends on venue:

- `HUNCH_FEE_BPS_POLYMARKET`, `HUNCH_FEE_COLLECTOR_PRIVATE_KEY` (Polymarket fee collector)
- `HUNCH_FEE_BPS_KALSHI`, `HUNCH_FEE_SCALE_KALSHI`, `DFLOW_USDC_FEE_ACCOUNT` (DFlow/Kalshi fees)
- `HUNCH_REWARDS_PAYOUT_PRIVATE_KEY` / `HUNCH_REWARDS_SOLANA_SECRET_KEY` (reward payouts)

---

## External Documentation

- [Fastify Documentation](https://www.fastify.io/docs/latest/)
- [TimescaleDB Documentation](https://docs.timescale.com/)
- [Privy Documentation](https://docs.privy.io/)
- [pnpm Documentation](https://pnpm.io/)
- [Turbo Documentation](https://turbo.build/repo/docs)

---

**Happy Coding! 🚀**

If you encounter any issues not covered here, please document them and update this guide.

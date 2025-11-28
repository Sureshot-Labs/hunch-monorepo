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
docker-compose --version
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
pnpm infra:up
```

This will:
- Start PostgreSQL (TimescaleDB) on port 5432
- Start Redis on port 6379
- Create necessary volumes for data persistence

### 2. Verify Services are Running

```bash
# Check Docker containers
docker ps

# You should see:
# - hunch-postgres
# - hunch-redis

# Test PostgreSQL connection
docker exec -it hunch-postgres psql -U hunch -d hunch -c "SELECT version();"

# Test Redis connection
docker exec -it hunch-redis redis-cli ping
# Should return: PONG
```

### 3. Run Database Migrations

```bash
pnpm migrate
```

This will run all database migrations from `packages/db/migrations/` in order.

### 4. Stop Infrastructure Services

When you're done:

```bash
pnpm infra:down
```

To stop and remove containers (data persists in volumes):

```bash
pnpm infra:down -v  # Also removes volumes (⚠️ deletes data)
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
   pnpm infra:down -v
   pnpm infra:up
   pnpm migrate
   ```

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

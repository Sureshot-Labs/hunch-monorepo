# Deployment (Docker, production)

This repo ships a full-Docker production setup for the backend (API + indexers)
and local Postgres/Redis. Only Nginx is exposed publicly; all other services bind
to localhost.

## Files
- `ops/docker-compose.prod.yml` - production compose
- `ops/Dockerfile.app` - build for API + indexers
- `ops/nginx/*` - Nginx config + entrypoint
- `ops/.env.prod.example` - env template

## Prereqs
- Docker + Docker Compose v2 on the host
- Enough disk for volumes (default `/opt/hunch-data`)
- ARM64 note: `t4g.medium` is ARM; build on the instance or use `buildx` for `linux/arm64`

## Environment
Create `/opt/hunch/.env` from the template:
```
cp ops/.env.prod.example /opt/hunch/.env
```
Fill at least:
- `PGUSER`, `PGPASSWORD`, `PGDATABASE`
- `DATABASE_URL` (must point to `postgres` service)
- `REDIS_URL`
- `PRIVY_APP_ID`, `PRIVY_APP_SECRET`
- `CREDENTIALS_ENCRYPTION_KEY`

Venue keys are optional. Kalshi is not included in prod compose.

## Volumes
```
sudo mkdir -p /opt/hunch-data/postgres /opt/hunch-data/redis /opt/hunch-data/nginx
```

## Run
```
docker compose -f ops/docker-compose.prod.yml --env-file /opt/hunch/.env up -d --build
```

Run migrations once:
```
docker compose -f ops/docker-compose.prod.yml --env-file /opt/hunch/.env run --rm api pnpm migrate
```

## Health checks
```
curl http://127.0.0.1:3001/health
curl http://localhost/health
```

## Ports / Security groups
- Public: `80`, `443` (Nginx)
- Internal only (localhost bind): `3001` (API), `5432` (Postgres), `6379` (Redis)
- SSH: `22` from your IP

## Updating
```
docker compose -f ops/docker-compose.prod.yml --env-file /opt/hunch/.env up -d --build
```

## TLS
TLS is not included. Add certs and update the Nginx template when a domain is ready.

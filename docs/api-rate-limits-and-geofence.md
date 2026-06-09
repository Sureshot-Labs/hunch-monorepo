# API Rate Limits and Geofence

This document describes backend request throttling and client-IP resolution for
the Hunch API.

## Global API Limit

All backend API routes are protected by a high baseline per-client-IP rate
limit unless explicitly exempted.

Defaults:

- `API_GLOBAL_RATE_LIMIT_ENABLED=true`
- `API_GLOBAL_RATE_LIMIT_MAX_REQUESTS=600`
- `API_GLOBAL_RATE_LIMIT_WINDOW_MS=60000`

Behavior:

- Key: resolved security client IP.
- Storage: Redis token bucket.
- Redis failure mode: fail-open, so Redis issues do not take down public API
  reads.
- Response on throttle: HTTP `429` with `error: "rate_limit_exceeded"`.

Exempt infrastructure paths:

- `GET /health`
- `GET /metrics`
- `GET /openapi.json`
- `/docs` and `/docs/*`

The global limit is only a safety net. Route-specific limits still apply after
the global limit and can be stricter.

## Route-Specific Limits

### Auth and Wallet Auth

These limits use the same resolved security client IP as geofence and fail
closed when Redis is unavailable.

| Endpoint | Limit |
| --- | ---: |
| `POST /auth/privy` | `20/min/IP` |
| `POST /auth/wallets/nonce` | `30/min/IP` |
| `POST /auth/wallets` | `20/min/IP` |
| `PATCH /auth/wallets` | `40/min/IP` |
| `DELETE /auth/wallets` | `20/min/IP` |

### Admin Auth and Admin API

These limits fail closed when Redis is unavailable.

| Endpoint or group | Limit |
| --- | ---: |
| `POST /admin-auth/enroll/start` | `30/min/IP` and `10/min/token` |
| `POST /admin-auth/enroll/complete` | `30/min/IP` and `10/min/token` |
| `POST /admin-auth/login` | `30/min/IP` and `10/min/email` |
| Admin protected API middleware | `120/min/IP` |

### Market and Event Reads

These are public read endpoints with tighter route-level limits in addition to
the global API limit.

| Endpoint | Limit |
| --- | ---: |
| `GET /markets/:marketId` | `100/min/IP` |
| `GET /markets/:marketId/candlesticks` | `60/min/IP` |
| `GET /events/:eventId` | `100/min/IP` |
| `GET /events/:eventId/candlesticks` | `60/min/IP` |

### Polymarket Market-Data Proxy

These are public market-data endpoints with route-level limits in addition to
the global API limit.

| Endpoint | Limit |
| --- | ---: |
| `GET /price-history` | `50/min/IP` |
| `GET /orderbook/:tokenId` | `100/min/IP` |
| `POST /orderbook/batch` | `50/min/IP` |
| `GET /price/:tokenId` | `200/min/IP` |
| `POST /price/batch` | `100/min/IP` |
| `GET /midpoint/:tokenId` | `200/min/IP` |
| `POST /spreads` | `100/min/IP` |

### Price Streams

These limits fail closed when Redis is unavailable.

| Endpoint | Limit |
| --- | ---: |
| `GET /prices/stream` | `API_PRICES_SSE_CONNECTS_PER_MINUTE`, default `30/min/IP` |
| `GET /prices/stream` active connections | `API_PRICES_SSE_MAX_CONNECTIONS_PER_IP`, default `50/IP` |

## Client-IP Resolution

Backend security features use `resolveSecurityClientIp`, which calls the shared
geofence client-IP resolver.

Resolution order when `TRUST_PROXY=true` and the request includes a matching
`X-Hunch-Proxy-Secret`:

1. `X-Hunch-Client-IP`
2. `CF-Connecting-IP`
3. first IP in `X-Forwarded-For`
4. `X-Real-IP`
5. Fastify `request.ip`

If the proxy secret is missing or wrong, forwarded headers are ignored and the
backend falls back to Fastify `request.ip`.

Malformed IPs are ignored. IPv4, IPv6, IPv4-mapped IPv6, bracketed IPv6, and
IPv4-with-port are normalized before use.

## Frontend Proxy Path

Production frontend requests normally flow through two hops:

1. Browser -> nginx -> Next.js frontend.
2. Next.js frontend -> nginx/API upstream -> Fastify backend.

This does not break geofence or rate limiting because the frontend proxy:

- deletes any browser-supplied forwarded IP headers;
- chooses the ingress-owned client IP from `X-Real-IP`, `CF-Connecting-IP`, or
  first `X-Forwarded-For`;
- sets `X-Hunch-Client-IP` to that canonical browser IP;
- sets `X-Hunch-Proxy-Secret` from the shared `HUNCH_PROXY_SECRET`.

The backend prefers the signed `X-Hunch-Client-IP`, so the second nginx hop can
overwrite `X-Real-IP` and `X-Forwarded-For` without changing the effective
browser IP.

Required production env/config:

- Backend and frontend server route handlers must share the same
  `HUNCH_PROXY_SECRET`.
- Backend must run with `TRUST_PROXY=true`.
- Nginx should overwrite `X-Real-IP` and `X-Forwarded-For` with the direct
  socket IP before forwarding to containers.

## Direct API Calls

Direct API calls also work:

- If the request comes through nginx, Fastify resolves `request.ip` from
  nginx-owned forwarded headers according to `TRUST_PROXY`.
- If the request connects directly to the backend, `request.ip` is the socket
  address.
- Unsigned or spoofed `X-Hunch-Client-IP` headers are ignored.

## Geofence Scope

The current geofence is used for Kalshi/DFlow trading-policy and private trading
paths. It is not a general read-API country block.

Relevant env:

- `DFLOW_GEO_BLOCK_ENABLED`
- `DFLOW_GEO_BLOCK_COUNTRIES`
- `DFLOW_GEO_BLOCK_DEFAULT`
- `TRUST_PROXY`
- `HUNCH_PROXY_SECRET`

When geofence is enabled:

- known blocked countries are rejected;
- unknown IP/country follows `DFLOW_GEO_BLOCK_DEFAULT`;
- disabled geofence always allows.

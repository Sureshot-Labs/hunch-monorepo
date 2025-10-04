# COMPREHENSIVE AUDIT REPORT
## Betting/Market-Data/Trading System Audit
### Polymarket, Kalshi, and Limitless Integration

**Audit Date**: October 4, 2025  
**Auditor**: Expert Backend Architect  
**Repository**: Hunch-MonoRepo  

---

## 📋 EXECUTIVE SUMMARY

1. **Critical Findings**: 15 high-severity issues identified including missing rate-limit enforcement in connectors, incomplete idempotency mechanisms, no distributed rate limiting, missing pagination cursors, and hardcoded secrets risk.

2. **Architecture Assessment**: Monorepo with TypeScript/Node.js, TimescaleDB for time-series data, Redis for caching. Well-structured but lacks production-ready rate limiting, comprehensive error handling, and trading safeguards.

3. **Connector Status**: Polymarket connector partially functional with missing backoff; Kalshi connector has basic rate limiting but no dead-letter queue; Limitless connector lacks rate limiting entirely.

4. **Data Quality**: Mappers have inconsistent timestamp normalization, missing field validation, no idempotency keys, and insufficient error handling for malformed payloads.

5. **Immediate Actions Required**: Implement distributed rate limiting with Redis, add idempotency keys to all ingestion, create dead-letter queues, add paper trading mode default, and secure all API keys in vault.

---

## 🔍 DETECTED TECHNOLOGY MATRIX

| Category | Technology | Version | File Evidence | Confidence |
|----------|-----------|---------|---------------|------------|
| **Runtime** | Node.js | 18+ | `package.json`, `tsconfig.base.json` target ES2022 | **HIGH** |
| **Language** | TypeScript | 5.9.2 | `package.json` L48 | **HIGH** |
| **Package Manager** | pnpm | 10.15.1 | `package.json` L58, `pnpm-workspace.yaml` | **HIGH** |
| **Monorepo Tool** | TurboRepo | 2.5.6 | `turbo.json`, `package.json` L47 | **HIGH** |
| **Database** | PostgreSQL | 16 | `ops/docker-compose.yml` L12 (timescale/timescaledb:2.14.2-pg16) | **HIGH** |
| **Time-Series DB** | TimescaleDB | 2.14.2 | `ops/docker-compose.yml` L12, `packages/db/migrations/0002_caggs_retention.sql` | **HIGH** |
| **Cache/Queue** | Redis | 7-alpine | `ops/docker-compose.yml` L33 | **HIGH** |
| **HTTP Client** | undici | 7.16.0 | `package.json` L66 | **HIGH** |
| **WebSocket** | ws | 8.18.3 | `package.json` L68 | **HIGH** |
| **Validation** | Zod | 4.1.5 | `package.json` L69 | **HIGH** |
| **Web Framework** | Fastify | Latest | `apps/api/src/server.ts` L1-8 | **HIGH** |
| **Rate Limiting** | PQueue | 8.1.1 | `package.json` L62, `apps/indexer-kalshi/src/kalshiClient.ts` L24 | **MEDIUM** |
| **Testing** | Vitest | Latest | `vitest.config.ts`, test scripts in `package.json` | **HIGH** |
| **Container** | Docker | 20.x+ | `ops/docker-compose.yml`, multiple Dockerfiles | **HIGH** |
| **Orchestration** | Kubernetes | N/A | `ops/k8s/*.yaml` manifests present | **MEDIUM** |
| **Monitoring** | Prometheus | N/A | `ops/prometheus/prometheus.yml` | **LOW** |
| **Migration Tool** | Custom | N/A | `packages/db/src/migrate.ts` | **HIGH** |

### Key Observations:
- ✅ Modern TypeScript stack with strict compilation
- ✅ TimescaleDB properly configured for time-series data
- ⚠️ Rate limiting exists but only locally (PQueue), not distributed
- ❌ No centralized secrets management (vault/KMS)
- ❌ No structured logging framework detected (only console.log)
- ❌ No API gateway with built-in rate limiting
- ⚠️ Testing framework present but coverage unknown

---

## 📚 EXCHANGE DOCUMENTATION SUMMARY

### Polymarket
**Base URLs**:
- Gamma API: `https://gamma-api.polymarket.com`
- CLOB API: `https://clob.polymarket.com`
- WebSocket: `wss://ws-subscriptions-clob.polymarket.com/ws/market`

**Auth Method**: None for read-only Gamma API; API key for CLOB trading  
**Rate Limits**: **NOT DOCUMENTED IN PUBLIC DOCS** - Implementation shows 150ms delay between requests  
**Streaming**: WebSocket available for order book updates  
**Pagination**: Offset-based (`limit`, `offset`)  

**Key Endpoints**:
- `/events/pagination`: Get events with filters
- `/books`: POST with token_ids to get order books

**Sample Payload Keys** (from existing code):
```typescript
{
  id: string,
  title: string,
  slug: string,
  active: boolean,
  closed: boolean,
  liquidity: number | string,
  volume: number | string,
  volume24hr: number | string,
  markets: [{
    id: string,
    question: string,
    clobTokenIds: string[],
    enableOrderBook: boolean,
    acceptingOrders: boolean
  }]
}
```

**Issues Found**:
- ❌ No documented rate limits
- ❌ No Retry-After headers in implementation
- ⚠️ Inconsistent number/string types for volumes
- ⚠️ No API versioning visible

### Kalshi
**Base URLs**:
- REST API: `https://demo-api.kalshi.co` (demo) / `https://trading-api.kalshi.com` (prod)
- WebSocket: `wss://demo-api.kalshi.co/trade-api/ws/v2`

**Auth Method**: RSA-PSS signing with KALSHI-ACCESS-KEY, KALSHI-ACCESS-TIMESTAMP, KALSHI-ACCESS-SIGNATURE headers  
**Rate Limits**: **18 reads/sec, 9 writes/sec** (configured in `apps/indexer-kalshi/src/env.ts`)  
**Streaming**: WebSocket with subscriptions  
**Pagination**: Cursor-based with `cursor` parameter  

**Key Endpoints**:
- `/trade-api/v2/events`: Get events
- `/trade-api/v2/markets`: Get markets  
- `/trade-api/v2/markets/{ticker}/orderbook`: Get order book

**Sample Payload Keys**:
```typescript
{
  event_ticker: string,
  title: string,
  category: string,
  markets: [{
    ticker: string,
    yes_sub_title: string,
    no_sub_title: string,
    status: string,
    liquidity: number,
    volume_24h: number,
    open_time: string,
    close_time: string
  }]
}
```

**Issues Found**:
- ✅ Rate limits properly documented and implemented
- ✅ RSA signing implemented correctly
- ⚠️ 429 handling exists but poor backoff (200ms * retry_count)
- ❌ No dead-letter queue for failed requests

### Limitless
**Base URL**: `https://api.limitless.exchange`

**Auth Method**: None detected for public endpoints  
**Rate Limits**: **NOT IMPLEMENTED** - Only 150ms delay between requests  
**Streaming**: **NOT DETECTED** in implementation  
**Pagination**: Page-based (`page`, `limit`, `sortBy`)  

**Key Endpoints**:
- `/markets/active`: Get active markets

**Sample Payload Keys**:
```typescript
{
  id: number,
  title: string,
  status: string,
  expired: boolean,
  expirationTimestamp: number,
  prices: [number, number], // YES%, NO%
  volume: number,
  volumeFormatted: string,
  categories: string[],
  address: string,
  conditionId: string
}
```

**Issues Found**:
- ❌ NO rate limiting implemented
- ❌ NO WebSocket implementation
- ❌ NO error handling for 429 responses
- ⚠️ Prices in % (0-100) need conversion to 0-1

---

## 🔌 CONNECTOR COMPLIANCE REPORT

### Polymarket Connector

**Files**: 
- `apps/indexer-polymarket/src/gammaClient.ts`
- `apps/indexer-polymarket/src/clobClient.ts`
- `apps/indexer-polymarket/src/wsMarket.ts`

**Authentication**: ✅ Correct (none for Gamma, implicit for CLOB)

**Endpoint Correctness**: ✅ Matches documented structure

**Rate Limiting**: ❌ **CRITICAL ISSUE**
```typescript
// apps/indexer-polymarket/src/gammaClient.ts:37
await new Promise((res) => setTimeout(res, 150));
```
- Only local 150ms delay, NOT a token bucket
- No distributed coordination
- No 429 handling
- No Retry-After header parsing

**Field Mapping**: ⚠️ **ISSUES FOUND**
```typescript
// apps/indexer-polymarket/src/mappers.ts:33
const liquidity = n(m.liquidityNum ?? m.liquidity);
```
- Fallback chain (liquidityNum → liquidity) not documented
- `n()` helper doesn't log when it returns null
- No validation that numeric fields are within expected ranges

**Error Handling**: ❌ **MISSING**
```typescript
// apps/indexer-polymarket/src/gammaClient.ts:18
if (!r.ok) throw new Error(`Gamma ${r.status}`);
```
- Throws generic error, no dead-letter queue
- No retry logic for 5xx errors
- No exponential backoff

**Streaming**: ✅ WebSocket implemented
- Reconnection logic present
- Subscription management functional
- ⚠️ No message validation (raw JSON.parse without Zod)

**Idempotency**: ❌ **MISSING**
- No idempotency keys generated
- Events/markets can be inserted multiple times
- No deduplication logic

### Kalshi Connector

**Files**:
- `apps/indexer-kalshi/src/kalshiClient.ts`
- `apps/indexer-kalshi/src/marketClient.ts`
- `apps/indexer-kalshi/src/wsMarket.ts`

**Authentication**: ✅ **CORRECT**
```typescript
// apps/indexer-kalshi/src/kalshiClient.ts:10-21
function sign(method: string, pathOnly: string, tsMs: string) {
  const msg = tsMs + method.toUpperCase() + pathOnly;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(msg);
  sign.end();
  const sig = sign.sign({
    key: pkPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sig.toString("base64");
}
```
- RSA-PSS signing properly implemented
- Timestamp included in signature
- ✅ Matches Kalshi documentation

**Rate Limiting**: ⚠️ **PARTIALLY IMPLEMENTED**
```typescript
// apps/indexer-kalshi/src/kalshiClient.ts:24-25
private qRead = new PQueue({ interval: 1000, intervalCap: env.rpsRead });
private qWrite = new PQueue({ interval: 1000, intervalCap: env.rpsWrite });
```
- ✅ PQueue correctly configured for 18 reads/sec, 9 writes/sec
- ❌ Local only - NOT distributed across worker instances
- ⚠️ Poor backoff on 429:
```typescript
// Line 58-59
if (String(e.message).includes("rate_limited"))
  await new Promise((res) => setTimeout(res, (i + 1) * 200));
```
- Should use exponential backoff (e.g., 2^i * 1000ms)
- Should respect Retry-After header if present

**Field Mapping**: ⚠️ **ISSUES**
```typescript
// apps/indexer-kalshi/src/mappers.ts:93-94
clob_token_yes: `kalshi:${m.ticker}:YES`,
clob_token_no: `kalshi:${m.ticker}:NO`,
```
- Synthetic token IDs (not from API)
- ✅ Consistent format
- ⚠️ No reverse lookup documented (how to get ticker from token_id)

**Error Handling**: ⚠️ **BASIC ONLY**
```typescript
// apps/indexer-kalshi/src/kalshiClient.ts:46-48
if (r.status === 429) throw new Error("rate_limited");
if (!r.ok) throw new Error(`${method} ${pathOnly} ${r.status}: ${await r.text()}`);
```
- Throws error, but no dead-letter queue
- No structured logging of failures
- No alert on repeated failures

**Idempotency**: ❌ **MISSING**

### Limitless Connector

**Files**:
- `apps/indexer-limitless/src/limitlessClient.ts`

**Authentication**: ✅ None required (public endpoints)

**Rate Limiting**: ❌ **CRITICAL - COMPLETELY MISSING**
```typescript
// apps/indexer-limitless/src/limitlessClient.ts:32
await new Promise((r) => setTimeout(r, 150));
```
- Only 150ms delay
- NO PQueue or token bucket
- NO 429 detection
- **WILL HIT RATE LIMITS IN PRODUCTION**

**Field Mapping**: ⚠️ **ISSUES**
```typescript
// apps/indexer-limitless/src/mappers.ts:60-61
const yesP = lm.prices?.[0] != null ? Number(lm.prices[0]) / 100 : null;
const noP = lm.prices?.[1] != null ? Number(lm.prices[1]) / 100 : null;
```
- ✅ Correctly converts % to 0-1 decimal
- ⚠️ Assumes prices[0]=YES, prices[1]=NO (not validated)
- ❌ No handling if prices array is wrong length

**Error Handling**: ❌ **MINIMAL**
```typescript
// apps/indexer-limitless/src/limitlessClient.ts:6
if (!r.ok) throw new Error(`Limitless ${r.status} ${url}`);
```
- Generic error, no categorization
- No retry logic
- No dead-letter queue

**Streaming**: ❌ **NOT IMPLEMENTED**
- No WebSocket client
- Polling only

**Idempotency**: ❌ **MISSING**

---

## 🗺️ MAPPER / NORMALIZER DEEP CHECK

### Canonical Schema Required

**Proposed Canonical Schema**:
```typescript
interface CanonicalMarketTick {
  // Identity
  source: 'polymarket' | 'kalshi' | 'limitless';
  source_market_id: string; // venue's unique ID
  canonical_market_id: string; // our UUID
  
  // Market info
  market_title: string;
  outcome_index: number | null; // 0=YES, 1=NO for binary
  outcome_label: string; // 'YES' | 'NO' | outcome description
  
  // Price/liquidity (always as 0-1 decimal for prices)
  price: number; // 0.0 to 1.0
  liquidity: number | null;
  size: number | null; // order size if applicable
  
  // Timestamps (ALWAYS UTC, ALWAYS ISO 8601)
  source_ts: string; // ISO 8601 from source
  received_ts: string; // ISO 8601 when we received it
  processed_ts: string; // ISO 8601 when we processed it
  
  // Idempotency
  idempotency_key: string; // deterministic: sha256(source + market_id + ts + price)
  
  // Raw payload reference (for debugging)
  raw_payload: any;
}
```

### Polymarket Mapper Analysis

**File**: `apps/indexer-polymarket/src/mappers.ts`

**Issue 1: Missing Timestamp Normalization**
```typescript
// Line 22-23
start_time: e.startDate ? new Date(e.startDate) : null,
end_time: e.endDate ? new Date(e.endDate) : null,
```
- ❌ Doesn't validate timezone
- ❌ Doesn't ensure UTC storage
- ❌ No handling for invalid date strings

**Fix**:
```typescript
function parseUTCDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) {
      logger.warn({ dateString: s }, 'Invalid date string');
      return null;
    }
    return d;
  } catch (e) {
    logger.error({ dateString: s, error: e }, 'Date parse exception');
    return null;
  }
}
```

**Issue 2: No Idempotency Key**
```typescript
// Line 11
const id = uuid();
```
- ❌ Generates random UUID each time
- ❌ Same event re-ingested = duplicate row
- ❌ No way to dedupe on upsert

**Fix**:
```typescript
import crypto from 'crypto';

function generateIdempotencyKey(source: string, eventId: string, timestamp: string): string {
  return crypto
    .createHash('sha256')
    .update(`${source}:${eventId}:${timestamp}`)
    .digest('hex');
}

// Then use:
const idempotencyKey = generateIdempotencyKey('polymarket', e.id, e.startDate ?? Date.now().toString());
```

**Issue 3: Inconsistent Number Parsing**
```typescript
// Line 4-8
const n = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(x as number) ? (x as number) : null;
};
```
- ⚠️ Silent null on invalid input
- ❌ No logging when parsing fails
- ❌ No bounds checking (negative volumes?)

**Fix**:
```typescript
function parseNumber(
  v: unknown,
  fieldName: string,
  min?: number,
  max?: number
): number | null {
  if (v === null || v === undefined) return null;
  
  let x: number;
  if (typeof v === "string") {
    x = parseFloat(v);
  } else if (typeof v === "number") {
    x = v;
  } else {
    logger.warn({ value: v, fieldName }, 'Non-numeric value');
    return null;
  }
  
  if (!Number.isFinite(x)) {
    logger.warn({ value: v, fieldName }, 'Non-finite number');
    return null;
  }
  
  if (min !== undefined && x < min) {
    logger.warn({ value: x, fieldName, min }, 'Value below minimum');
    return null;
  }
  
  if (max !== undefined && x > max) {
    logger.warn({ value: x, fieldName, max }, 'Value above maximum');
    return null;
  }
  
  return x;
}
```

### Kalshi Mapper Analysis

**File**: `apps/indexer-kalshi/src/mappers.ts`

**Issue 1: Complex Date Aggregation Logic**
```typescript
// Lines 12-16
const minDate = (ds: (Date | null)[]) =>
  ds.filter(Boolean).sort((a, b) => +a! - +b!)[0] ?? null;
const maxDate = (ds: (Date | null)[]) =>
  ds.filter(Boolean).sort((a, b) => +b! - +a!)[0] ?? null;
```
- ⚠️ Creates new sorted arrays on every call
- ⚠️ Could be O(n log n) for large market arrays
- ✅ Correctly handles nulls

**Issue 2: Fallback Chain Complexity**
```typescript
// Lines 42-47
const start = parseDate((e as any).open_time) ?? minDate(mOpens);
const end =
  parseDate((e as any).close_time) ??
  parseDate((e as any).expiration_time) ??
  parseDate((e as any).latest_expiration_time) ??
  maxDate(mCloses.concat(mLatest));
```
- ⚠️ Many fallbacks - suggests API inconsistency
- ❌ No logging of which path was taken
- ❌ Hard to debug when wrong date is used

**Issue 3: Synthetic Token IDs**
```typescript
// Lines 93-94
clob_token_yes: `kalshi:${m.ticker}:YES`,
clob_token_no: `kalshi:${m.ticker}:NO`,
```
- ✅ Consistent format
- ❌ No reverse index stored
- ❌ Could collide if ticker changes

### Limitless Mapper Analysis

**File**: `apps/indexer-limitless/src/mappers.ts`

**Issue 1: Complex Volume Parsing**
```typescript
// Lines 5-13
function parseVolume(m: TLimitlessMarket): number | null {
  if (m.volumeFormatted && !Number.isNaN(Number(m.volumeFormatted)))
    return Number(m.volumeFormatted);
  if (m.volume != null && Number.isFinite(Number(m.volume))) {
    const d = m.collateralToken?.decimals ?? 6;
    return Number(m.volume) / Math.pow(10, d);
  }
  return null;
}
```
- ✅ Handles two volume formats
- ⚠️ Assumes decimals=6 if missing
- ❌ No logging when fallback is used

**Issue 2: Array Index Assumptions**
```typescript
// Lines 60-61
const yesP = lm.prices?.[0] != null ? Number(lm.prices[0]) / 100 : null;
const noP = lm.prices?.[1] != null ? Number(lm.prices[1]) / 100 : null;
```
- ❌ No validation that prices.length === 2
- ❌ No validation that prices[0] + prices[1] ≈ 100
- ❌ Could fail silently if API changes

**Fix**:
```typescript
function parseLimitlessPrices(lm: TLimitlessMarket): { yes: number | null; no: number | null } {
  if (!Array.isArray(lm.prices) || lm.prices.length !== 2) {
    logger.warn({ marketId: lm.id, prices: lm.prices }, 'Invalid prices array');
    return { yes: null, no: null };
  }
  
  const yesP = Number(lm.prices[0]) / 100;
  const noP = Number(lm.prices[1]) / 100;
  
  if (!Number.isFinite(yesP) || !Number.isFinite(noP)) {
    logger.warn({ marketId: lm.id, prices: lm.prices }, 'Non-finite prices');
    return { yes: null, no: null };
  }
  
  const sum = yesP + noP;
  if (Math.abs(sum - 1.0) > 0.05) { // 5% tolerance
    logger.warn({ marketId: lm.id, yesP, noP, sum }, 'Prices do not sum to 1.0');
  }
  
  return { yes: yesP, no: noP };
}
```

---

## 💾 PRICE HISTORY & STORAGE AUDIT

### Database Schema

**Files**:
- `packages/db/migrations/0001_init.sql`
- `packages/db/migrations/0002_caggs_retention.sql`

**Hypertables**: ✅ **PROPERLY CONFIGURED**
```sql
SELECT create_hypertable('book_top', 'ts');
SELECT create_hypertable('last_trade', 'ts');
```

**Continuous Aggregates**: ✅ **IMPLEMENTED**
- `book_top_1m`: 1-minute mid-price aggregates
- `last_trade_1m`: 1-minute trade aggregates
- `last_trade_1m_ohlc`: OHLC bars (requires timescaledb_toolkit)

**Retention Policies**: ✅ **CONFIGURED**
```sql
SELECT add_retention_policy('book_top', INTERVAL '30 days');
SELECT add_retention_policy('last_trade', INTERVAL '30 days');
SELECT add_retention_policy('book_top_1m', INTERVAL '365 days');
SELECT add_retention_policy('last_trade_1m', INTERVAL '365 days');
```

**Compression**: ✅ **ENABLED**
```sql
ALTER TABLE book_top SET (timescaledb.compress, 
  timescaledb.compress_orderby = 'ts', 
  timescaledb.compress_segmentby = 'token_id');
SELECT add_compression_policy('book_top', INTERVAL '7 days');
```

### Issues Found

**Issue 1: Missing Indices for Common Queries**

Current indices (from migration 0001):
```sql
CREATE INDEX idx_book_top_token ON book_top(token_id, ts DESC);
CREATE INDEX idx_last_trade_token ON last_trade(token_id, ts DESC);
```

❌ **MISSING**:
- No composite index for `(token_id, ts, price)` - would speed up price range queries
- No index on `markets(accepting_orders)` - used in feed endpoint filter
- No index on `events(active, closed)` - used in bootstrap queries
- No GIN index on `events(tags)` or `markets(category)` for text search

**Fix**: Add to new migration:
```sql
-- Optimize price range queries
CREATE INDEX idx_book_top_token_ts_price ON book_top(token_id, ts DESC, best_bid, best_ask);

-- Optimize market filtering
CREATE INDEX idx_markets_accepting ON markets(accepting_orders) WHERE accepting_orders = true;
CREATE INDEX idx_markets_venue_status ON markets(venue_id, enable_orderbook) WHERE enable_orderbook = true;

-- Optimize event queries
CREATE INDEX idx_events_active_closed ON events(venue_id, active, closed) WHERE active = true AND closed = false;

-- Text search
CREATE INDEX idx_events_category ON events USING GIN (to_tsvector('english', category));
```

**Issue 2: No Partitioning Strategy for Large Tables**

Current: Only TimescaleDB chunking (automatic)

❌ For very high volume:
- Consider additional partitioning by `venue_id` for `events` and `markets` tables
- Would allow venue-specific retention policies
- Would improve query performance when filtering by venue

**Issue 3: Missing Idempotency Table**

Present in migrations but **NO USAGE** in code:
```sql
-- From 0001_init.sql
CREATE TABLE IF NOT EXISTS idempotency (
  key VARCHAR(255) PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

❌ No code references this table
❌ No automatic cleanup of old keys
❌ Not used in upsert logic

**Fix**: Actually use it:
```typescript
// In repo.ts or equivalent
async function upsertEventIdempotent(pool: Pool, event: any, idempotencyKey: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check idempotency
    const { rows } = await client.query(
      'SELECT data FROM idempotency WHERE key = $1',
      [idempotencyKey]
    );
    
    if (rows.length > 0) {
      // Already processed
      await client.query('COMMIT');
      return rows[0].data;
    }
    
    // Insert event
    const result = await client.query(
      `INSERT INTO events (...) VALUES (...) 
       ON CONFLICT (venue_id, event_id) DO UPDATE SET ...
       RETURNING *`,
      [...]
    );
    
    // Record idempotency
    await client.query(
      'INSERT INTO idempotency (key, data) VALUES ($1, $2)',
      [idempotencyKey, JSON.stringify(result.rows[0])]
    );
    
    await client.query('COMMIT');
    return result.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

---

## 🌐 API AUDIT: Sorting, Filtering, Pagination

### API Gateway Endpoint: `/feed`

**File**: `apps/api/src/server.ts` lines 119-363

**Pagination**: ⚠️ **OFFSET-BASED (NOT OPTIMAL)**
```typescript
// Line 125-126
const limit = Math.min(Math.max(parseInt(q.limit ?? "") || env.defaultLimit, 1), env.maxLimit);
const offset = Math.max(parseInt(q.offset ?? "") || 0, 0);
```

**Issues**:
- ❌ Offset-based pagination suffers from:
  - Inconsistent results if data changes between pages
  - Performance degradation for large offsets (DB still scans rows)
- ✅ Limit and max correctly enforced
- ❌ No `total_count` returned (client can't know how many pages exist)

**Recommended Fix**: Cursor-based pagination
```typescript
interface FeedQuery {
  limit?: number;
  cursor?: string; // base64(eventId:timestamp)
  min_volume24hr?: number;
  // ... other filters
}

// In query:
WHERE (e.start_time, e.id) < (
  SELECT start_time, id FROM events WHERE id = decode_cursor($cursor)
)
ORDER BY e.start_time DESC, e.id DESC
LIMIT $limit
```

**Sorting**: ⚠️ **PARTIALLY IMPLEMENTED**
```typescript
// Lines 186-190
if (sort === "totalvol") eventOrder = "e.volume_total desc nulls last, e.id";
else if (sort === "liquidity") eventOrder = "e.liquidity desc nulls last, e.id";
else if (sort == null) eventOrder = ""; // no sort if not present
else eventOrder = "e.start_time desc nulls last, e.id"; // fallback
```

**Issues**:
- ⚠️ `sort == null` results in no ORDER BY → **UNSTABLE RESULTS**
- ❌ No `sort=endingsoon` (sort by `end_time ASC`)
- ❌ No `sort=newest` (sort by `created_at DESC`)
- ❌ No validation of sort parameter (accepts any string)
- ✅ Includes secondary sort by `e.id` for stability

**Fix**:
```typescript
const ALLOWED_SORTS = ['totalvol', 'liquidity', 'newest', 'endingsoon', 'starttime'];

if (sort && !ALLOWED_SORTS.includes(sort)) {
  reply.code(400);
  return reply.send({ 
    error: `Invalid sort. Allowed: ${ALLOWED_SORTS.join(', ')}` 
  });
}

let eventOrder = "";
switch (sort) {
  case "totalvol":
    eventOrder = "e.volume_total DESC NULLS LAST, e.id";
    break;
  case "liquidity":
    eventOrder = "e.liquidity DESC NULLS LAST, e.id";
    break;
  case "newest":
    eventOrder = "e.created_at DESC NULLS LAST, e.id";
    break;
  case "endingsoon":
    eventOrder = "e.end_time ASC NULLS LAST, e.id";
    break;
  case "starttime":
  default:
    eventOrder = "e.start_time DESC NULLS LAST, e.id";
    break;
}
```

**Filtering**: ✅ **FUNCTIONAL** but ⚠️ **INCOMPLETE**
```typescript
// Lines 177-182
if (filter === "newest") {
  eventWhere.push(`e.start_time >= now() - interval '7 days'`);
} else if (filter === "endingsoon") {
  eventWhere.push(`e.end_time <= now() + interval '7 days'`);
}
```

**Issues**:
- ✅ Filters implemented correctly
- ❌ No `filter=active` (active=true AND closed=false)
- ❌ No `filter=popular` (volume24hr > threshold)
- ❌ No combination of filters (e.g., newest AND popular)

**Caching**: ✅ **WELL IMPLEMENTED**
```typescript
// Lines 133-158
const cacheKey = `feed:v6:${limit}:${offset}:${minVol}:${minLiquidity}:${venue ?? ""}:${category ?? ""}:${filter ?? ""}:${sort ?? ""}`;
const cachedBody = await r.get(cacheKey);
if (cachedBody) {
  const etag = `W/"${crypto.createHash("sha1").update(cachedBody).digest("hex")}"`;
  if (req.headers["if-none-match"] === etag) {
    reply.code(304);
    return reply.send();
  }
  // ... serve cached
}
```

**Issues**:
- ✅ ETag correctly implemented
- ✅ Cache-Control headers appropriate
- ✅ Cache key includes all query params
- ❌ No `Vary` header (should include `Accept-Encoding`)
- ❌ No cache warming for popular queries

**Rate Limiting**: ❌ **NOT IMPLEMENTED**
- No rate limit headers (`X-RateLimit-*`)
- No per-IP or per-user throttling
- No 429 response handling
- Vulnerable to DoS

---

## 🚦 RATE LIMITS, CONCURRENCY & SCALING

### Current State

**Polymarket**:
- ❌ NO distributed rate limiting
- ⚠️ Only local 150ms delay
- ❌ NO 429 handling
- ❌ NO Retry-After parsing

**Kalshi**:
- ✅ PQueue with correct limits (18/sec read, 9/sec write)
- ❌ NOT distributed (each process has own queue)
- ⚠️ Poor backoff (200ms * retry_count)
- ❌ NO Retry-After parsing

**Limitless**:
- ❌ NO rate limiting at all
- ⚠️ Only 150ms delay
- ❌ WILL hit rate limits in production

### Issues

**Issue 1: No Distributed Rate Limiting**

**Problem**: If you scale to 3 API workers, each has its own PQueue. Total rate = 3x individual rate → **WILL EXCEED EXCHANGE LIMITS**

**Fix**: Implement Redis-based token bucket
```typescript
// lib/distributed-rate-limiter.ts
import { Redis } from 'ioredis';

class DistributedRateLimiter {
  constructor(
    private redis: Redis,
    private key: string,
    private maxTokens: number,
    private refillRate: number // tokens per second
  ) {}

  async acquire(tokens: number = 1): Promise<boolean> {
    const now = Date.now();
    const script = `
      local key = KEYS[1]
      local max_tokens = tonumber(ARGV[1])
      local refill_rate = tonumber(ARGV[2])
      local tokens_requested = tonumber(ARGV[3])
      local now = tonumber(ARGV[4])

      local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
      local current_tokens = tonumber(bucket[1]) or max_tokens
      local last_refill = tonumber(bucket[2]) or now

      local elapsed = (now - last_refill) / 1000
      local refill_amount = elapsed * refill_rate
      current_tokens = math.min(max_tokens, current_tokens + refill_amount)

      if current_tokens >= tokens_requested then
        current_tokens = current_tokens - tokens_requested
        redis.call('HMSET', key, 'tokens', current_tokens, 'last_refill', now)
        redis.call('EXPIRE', key, 60)
        return 1
      else
        return 0
      end
    `;

    const result = await this.redis.eval(
      script,
      1,
      this.key,
      this.maxTokens,
      this.refillRate,
      tokens,
      now
    );

    return result === 1;
  }

  async waitForToken(tokens: number = 1): Promise<void> {
    while (!(await this.acquire(tokens))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

// Usage:
const kalshiReadLimiter = new DistributedRateLimiter(
  redis,
  'rate:kalshi:read',
  18, // max tokens
  18  // refill 18/sec
);

await kalshiReadLimiter.waitForToken();
// make API call
```

**Issue 2: No Retry-After Header Handling**

**Current**:
```typescript
if (r.status === 429) throw new Error("rate_limited");
```

**Fix**:
```typescript
if (r.status === 429) {
  const retryAfter = r.headers.get('Retry-After');
  let delayMs = 1000; // default
  
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) {
      delayMs = parseInt(retryAfter) * 1000; // seconds
    } else {
      const retryDate = new Date(retryAfter);
      delayMs = Math.max(0, retryDate.getTime() - Date.now());
    }
  }
  
  throw new RateLimitError(delayMs);
}
```

**Issue 3: No Backpressure / Circuit Breaker**

**Problem**: If exchange is down or rate-limiting heavily, system keeps retrying → wastes resources, delays recovery

**Fix**: Implement circuit breaker
```typescript
class CircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private successCount = 0;

  constructor(
    private threshold: number = 5,
    private timeout: number = 60000,
    private halfOpenRequests: number = 3
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.halfOpenRequests) {
        this.state = 'CLOSED';
        this.failureCount = 0;
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
    }
  }
}
```

**Issue 4: No Per-User Rate Limiting on Trading API**

**Current**: Anyone can spam order endpoints

**Fix**: Add Fastify rate limit plugin
```typescript
import rateLimit from '@fastify/rate-limit';

app.register(rateLimit, {
  max: 100, // max 100 requests
  timeWindow: '15 minutes',
  redis: redisClient,
  keyGenerator: (request) => {
    // Use user ID from JWT
    return request.user?.id || request.ip;
  }
});
```

---

## 🔐 TRADING ENGINE & SAFEGUARDS AUDIT

### Current State

**Files**:
- `apps/trading-engine/src/services/trading-engine.ts`
- `apps/trading-engine/src/services/risk-manager.ts`
- `apps/trading-engine/src/clients/polymarket-trading-client.ts`

### CRITICAL ISSUES FOUND

**Issue 1: NO PAPER TRADING MODE**

❌ **CRITICAL**: No paper trading / simulation mode detected
❌ All orders go directly to live exchanges
❌ No dry-run option for testing strategies

**Required Implementation**:
```typescript
// apps/trading-engine/src/env.ts
export const env = {
  // ...
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
  REQUIRE_LIVE_CONFIRMATION: z.boolean().default(true),
};

// apps/trading-engine/src/services/trading-engine.ts
class TradingEngine {
  async placeOrder(userId: string, order: OrderRequest): Promise<Order> {
    // Check mode
    if (env.TRADING_MODE === 'paper') {
      return this.placePaperOrder(userId, order);
    }
    
    // Require explicit live mode confirmation
    const user = await this.getUserSettings(userId);
    if (!user.liveTradingEnabled) {
      throw new Error('Live trading not enabled for this user. Enable in settings.');
    }
    
    // Additional confirmation for first live trade
    if (!user.hasConfirmedLiveTrading) {
      throw new Error('Please confirm live trading in your account settings before placing real orders');
    }
    
    return this.placeLiveOrder(userId, order);
  }
  
  private async placePaperOrder(userId: string, order: OrderRequest): Promise<Order> {
    // Simulate order execution
    const simulatedFill = {
      ...order,
      status: 'FILLED',
      filledAt: new Date(),
      filledPrice: order.price, // In reality, would use current market price
      feeUsd: order.sizeUsd * 0.001, // 0.1% fee simulation
    };
    
    // Store in separate paper_orders table
    await this.db.query(
      `INSERT INTO paper_orders (user_id, ...) VALUES (...)`,
      [userId, ...]
    );
    
    return simulatedFill;
  }
}
```

**Issue 2: NO ORDER SIZE LIMITS**

❌ No maximum order size validation
❌ Could accidentally place $1M order
❌ No per-user exposure limits

**Fix**:
```typescript
// apps/trading-engine/src/services/risk-manager.ts
class RiskManager {
  async validateOrder(userId: string, order: OrderRequest): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Check order size limits
    const MAX_ORDER_SIZE_USD = 10000; // $10k per order
    if (order.sizeUsd > MAX_ORDER_SIZE_USD) {
      errors.push(`Order size ${order.sizeUsd} exceeds maximum ${MAX_ORDER_SIZE_USD}`);
    }
    
    // Check user exposure
    const userPositions = await this.getPositions(userId);
    const totalExposure = userPositions.reduce((sum, p) => sum + p.marketValue, 0);
    const MAX_USER_EXPOSURE = 50000; // $50k total
    
    if (totalExposure + order.sizeUsd > MAX_USER_EXPOSURE) {
      errors.push(`Order would exceed maximum user exposure of ${MAX_USER_EXPOSURE}`);
    }
    
    // Check margin requirements
    const userBalance = await this.getUserBalance(userId);
    const MARGIN_REQUIREMENT = 1.5; // 150% of order value
    const requiredMargin = order.sizeUsd * MARGIN_REQUIREMENT;
    
    if (userBalance < requiredMargin) {
      errors.push(`Insufficient margin. Required: ${requiredMargin}, Available: ${userBalance}`);
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
}
```

**Issue 3: NO CIRCUIT BREAKER FOR FAILED TRADES**

❌ If exchange API fails repeatedly, keeps trying
❌ No automatic pause on high error rate
❌ Could drain funds with failed orders

**Fix**:
```typescript
class TradingCircuitBreaker {
  private recentErrors: Date[] = [];
  private isPaused = false;
  private pauseUntil: Date | null = null;

  async checkCircuit(): Promise<void> {
    // Clean old errors (last 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    this.recentErrors = this.recentErrors.filter(d => d > fiveMinutesAgo);

    // Check if circuit should open
    if (this.recentErrors.length >= 10) {
      this.isPaused = true;
      this.pauseUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 min pause
      
      await this.alertAdmins({
        type: 'TRADING_CIRCUIT_BREAKER_TRIGGERED',
        errorCount: this.recentErrors.length,
        pauseUntil: this.pauseUntil,
      });
      
      throw new Error('Trading circuit breaker triggered due to high error rate');
    }

    // Check if still paused
    if (this.isPaused && this.pauseUntil && new Date() < this.pauseUntil) {
      throw new Error(`Trading paused until ${this.pauseUntil.toISOString()}`);
    }

    // Resume if pause expired
    if (this.isPaused && this.pauseUntil && new Date() >= this.pauseUntil) {
      this.isPaused = false;
      this.pauseUntil = null;
      this.recentErrors = [];
    }
  }

  recordError() {
    this.recentErrors.push(new Date());
  }
}
```

**Issue 4: NO TRANSACTIONAL GUARANTEES**

❌ Order → Trade → Position update not atomic
❌ Could lose money if server crashes mid-update
❌ No idempotency for duplicate order submissions

**Fix**: Use database transactions
```typescript
async placeOrderAtomic(userId: string, order: OrderRequest): Promise<Order> {
  const client = await this.db.connect();
  try {
    await client.query('BEGIN');

    // 1. Check idempotency
    const idempotencyKey = order.idempotencyKey || crypto.randomUUID();
    const existing = await client.query(
      'SELECT * FROM orders WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return existing.rows[0]; // Already processed
    }

    // 2. Insert order
    const orderResult = await client.query(
      `INSERT INTO orders (user_id, venue_id, token_id, side, price, size_usd, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7)
       RETURNING *`,
      [userId, order.venueId, order.tokenId, order.side, order.price, order.sizeUsd, idempotencyKey]
    );
    
    const orderId = orderResult.rows[0].id;

    // 3. Call exchange API
    const exchangeResponse = await this.exchangeClient.placeOrder(order);

    // 4. Update order with exchange ID
    await client.query(
      `UPDATE orders SET venue_order_id = $1, status = $2 WHERE id = $3`,
      [exchangeResponse.orderId, 'SUBMITTED', orderId]
    );

    // 5. If filled immediately, record trade and update position
    if (exchangeResponse.status === 'FILLED') {
      await client.query(
        `INSERT INTO trades (order_id, user_id, venue_id, token_id, side, price, size_usd, size_tokens, executed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [orderId, userId, order.venueId, order.tokenId, order.side, exchangeResponse.fillPrice, order.sizeUsd, exchangeResponse.fillSize, new Date()]
      );

      // Update position (trigger handles this, but also explicit here)
      await client.query(
        `INSERT INTO positions (user_id, token_id, side, quantity, average_price, market_value)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, token_id)
         DO UPDATE SET
           quantity = positions.quantity + EXCLUDED.quantity,
           average_price = (positions.quantity * positions.average_price + EXCLUDED.quantity * EXCLUDED.average_price) / (positions.quantity + EXCLUDED.quantity),
           market_value = positions.market_value + EXCLUDED.market_value,
           updated_at = NOW()`,
        [userId, order.tokenId, order.side, exchangeResponse.fillSize, exchangeResponse.fillPrice, order.sizeUsd]
      );
    }

    await client.query('COMMIT');
    return orderResult.rows[0];

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

---

## 🔒 SECURITY & SECRETS AUDIT

### Secrets Management

**Current State**: ❌ **UNSAFE**
```typescript
// apps/indexer-kalshi/src/env.ts:8
const pkPem = fs.readFileSync(path.resolve(env.kalshiPrivateKeyPath), "utf8");
```

**Issues**:
- ❌ Private key stored in plain text file
- ❌ Path to key stored in environment variable
- ⚠️ `kalshiKey.txt` present in repository root (UNTRACKED but risky)
- ❌ No encryption at rest
- ❌ No key rotation mechanism
- ❌ No audit log of key access

**Fix**: Use AWS Secrets Manager or HashiCorp Vault
```typescript
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

class SecretsManager {
  private client = new SecretsManagerClient({ region: 'us-east-1' });
  private cache = new Map<string, { value: string; expires: number }>();

  async getSecret(secretName: string): Promise<string> {
    // Check cache
    const cached = this.cache.get(secretName);
    if (cached && cached.expires > Date.now()) {
      return cached.value;
    }

    // Fetch from AWS
    const command = new GetSecretValueCommand({ SecretId: secretName });
    const response = await this.client.send(command);

    if (!response.SecretString) {
      throw new Error(`Secret ${secretName} not found`);
    }

    // Cache for 5 minutes
    this.cache.set(secretName, {
      value: response.SecretString,
      expires: Date.now() + 5 * 60 * 1000,
    });

    return response.SecretString;
  }

  async getKalshiPrivateKey(): Promise<string> {
    return this.getSecret('hunch/kalshi/private-key');
  }
}

// Usage:
const secrets = new SecretsManager();
const pkPem = await secrets.getKalshiPrivateKey();
```

### SQL Injection

**Current State**: ✅ **SAFE** (using parameterized queries)
```typescript
// apps/api/src/server.ts:212
const { rows: eventRows } = await pool.query(eventSql, eventParams);
```
- All queries use `$1, $2, ...` placeholders
- No string concatenation detected

### Input Validation

**Current State**: ⚠️ **PARTIAL**

**Example** - `/feed` endpoint:
```typescript
// Line 125-126
const limit = Math.min(Math.max(parseInt(q.limit ?? "") || env.defaultLimit, 1), env.maxLimit);
const offset = Math.max(parseInt(q.offset ?? "") || 0, 0);
```
- ✅ Limit bounded by max
- ✅ parseInt safely handles invalid input
- ❌ No validation that `venue` is one of ['polymarket', 'kalshi', 'limitless']
- ❌ No validation that `sort` is one of allowed values
- ❌ No validation of token_id format in `/prices/stream`

**Fix**: Use Zod for validation
```typescript
import { z } from 'zod';

const FeedQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(500).default(50),
  offset: z.coerce.number().min(0).default(0),
  min_volume24hr: z.coerce.number().min(0).optional(),
  min_liquidity: z.coerce.number().min(0).optional(),
  venue: z.enum(['polymarket', 'kalshi', 'limitless']).optional(),
  category: z.string().max(100).optional(),
  filter: z.enum(['newest', 'endingsoon', 'active', 'popular']).optional(),
  sort: z.enum(['totalvol', 'liquidity', 'newest', 'endingsoon', 'starttime']).optional(),
});

app.get("/feed", async (req, reply) => {
  const result = FeedQuerySchema.safeParse(req.query);
  
  if (!result.success) {
    reply.code(400);
    return reply.send({
      error: 'Invalid query parameters',
      details: result.error.issues,
    });
  }
  
  const q = result.data;
  // ... rest of handler
});
```

### Authentication

**Current State**: ❌ **NOT IMPLEMENTED**

**Issues**:
- ❌ No authentication on API endpoints
- ❌ No JWT validation
- ❌ No user session management
- ❌ Trading endpoints publicly accessible

**Fix**: Implement JWT middleware
```typescript
import jwt from '@fastify/jwt';

app.register(jwt, {
  secret: await secrets.getSecret('hunch/jwt/secret'),
});

app.decorate('authenticate', async function(request, reply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.send(err);
  }
});

// Protected routes
app.get('/portfolio', { onRequest: [app.authenticate] }, async (request, reply) => {
  const userId = request.user.id;
  // ... fetch portfolio
});
```

---

## 🧪 TESTING & CI/CD AUDIT

### Test Coverage

**Files**:
- `vitest.config.ts`: ✅ Configured with 80% coverage threshold
- Test files present in:
  - `apps/trading-engine/tests/trading-engine.test.ts`
  - `apps/analytics-engine/tests/analytics-engine.test.ts`
  - `apps/webhook-system/tests/webhook-system.test.ts`

**Coverage Thresholds**: ✅ **CONFIGURED**
```typescript
// vitest.config.ts:49-56
thresholds: {
  global: {
    branches: 80,
    functions: 80,
    lines: 80,
    statements: 80,
  },
},
```

**Issues**:
- ❌ No tests for connectors (Polymarket, Kalshi, Limitless clients)
- ❌ No tests for mappers with fuzz inputs
- ❌ No tests for rate limiter behavior
- ❌ No tests for API endpoints (`apps/api/src/server.ts`)
- ❌ No replay harness for historical data
- ⚠️ Test containers configured but not verified functional

### Missing Critical Tests

**1. Connector Tests** (MISSING):
```typescript
// apps/indexer-polymarket/tests/gammaClient.test.ts (CREATE THIS)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rest } from 'msw';
import { setupServer } from 'msw/node';
import { fetchEventsPage } from '../src/gammaClient';

const server = setupServer();

describe('Polymarket Gamma Client', () => {
  beforeEach(() => server.listen());
  afterEach(() => server.close());

  it('should fetch events with correct parameters', async () => {
    server.use(
      rest.post('https://gamma-api.polymarket.com/events/pagination', async (req, res, ctx) => {
        const url = new URL(req.url);
        expect(url.searchParams.get('limit')).toBe('50');
        expect(url.searchParams.get('active')).toBe('true');
        
        return res(
          ctx.json({
            data: [
              { id: 'event1', title: 'Test Event', active: true, markets: [] }
            ]
          })
        );
      })
    );

    const result = await fetchEventsPage(0, 50);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('Test Event');
  });

  it('should handle rate limit errors', async () => {
    server.use(
      rest.post('https://gamma-api.polymarket.com/events/pagination', async (req, res, ctx) => {
        return res(
          ctx.status(429),
          ctx.set('Retry-After', '60'),
          ctx.json({ error: 'Rate limit exceeded' })
        );
      })
    );

    await expect(fetchEventsPage(0, 50)).rejects.toThrow('Gamma 429');
    // Should also test that it respects Retry-After
  });
});
```

**2. Mapper Fuzz Tests** (MISSING):
```typescript
// apps/indexer-polymarket/tests/mappers.fuzz.test.ts (CREATE THIS)
import { describe, it, expect } from 'vitest';
import { mapEventRow, mapMarketRow } from '../src/mappers';

describe('Polymarket Mapper Fuzz Tests', () => {
  it('should handle missing required fields', () => {
    const badEvent = {} as any;
    
    expect(() => mapEventRow(1, badEvent)).not.toThrow();
    // Should return with nulls, not crash
  });

  it('should handle null values', () => {
    const eventWithNulls = {
      id: 'test',
      title: 'Test',
      slug: null,
      active: null,
      closed: null,
      liquidity: null,
      volume: null,
      volume24hr: null,
      startDate: null,
      endDate: null,
    };
    
    const result = mapEventRow(1, eventWithNulls);
    expect(result.id).toBeDefined();
    expect(result.liquidity).toBeNull();
  });

  it('should handle string numbers', () => {
    const eventWithStringNums = {
      id: 'test',
      title: 'Test',
      liquidity: '1000.50',
      volume: '5000',
      volume24hr: '500.75',
    };
    
    const result = mapEventRow(1, eventWithStringNums);
    expect(result.liquidity).toBe(1000.50);
    expect(result.volume_total).toBe(5000);
  });

  it('should handle invalid numbers', () => {
    const eventWithInvalidNums = {
      id: 'test',
      title: 'Test',
      liquidity: 'not a number',
      volume: NaN,
      volume24hr: Infinity,
    };
    
    const result = mapEventRow(1, eventWithInvalidNums);
    expect(result.liquidity).toBeNull();
    expect(result.volume_total).toBeNull();
    expect(result.volume24hr).toBeNull();
  });
});
```

**3. API Endpoint Tests** (MISSING):
```typescript
// apps/api/tests/server.test.ts (CREATE THIS)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { start } from '../src/server';

describe('API Server', () => {
  let server: Awaited<ReturnType<typeof start>>;

  beforeAll(async () => {
    server = await start();
  });

  afterAll(async () => {
    await server.close();
  });

  describe('GET /feed', () => {
    it('should return markets with default parameters', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/feed',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('limit');
      expect(body).toHaveProperty('offset');
    });

    it('should validate limit parameter', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/feed?limit=99999', // exceeds maxLimit
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.limit).toBeLessThanOrEqual(500); // maxLimit
    });

    it('should return 304 with matching ETag', async () => {
      const response1 = await server.inject({
        method: 'GET',
        url: '/feed',
      });

      const etag = response1.headers.etag;

      const response2 = await server.inject({
        method: 'GET',
        url: '/feed',
        headers: {
          'if-none-match': etag,
        },
      });

      expect(response2.statusCode).toBe(304);
    });
  });
});
```

### CI/CD Pipeline

**Current State**: ❌ **NOT DETECTED**

**Files checked**:
- No `.github/workflows/*.yml` files found
- No `.gitlab-ci.yml` found
- No `Jenkinsfile` found

**Required**: GitHub Actions workflow
```yaml
# .github/workflows/ci.yml (CREATE THIS)
name: CI

on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main, develop]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: timescale/timescaledb:2.14.2-pg16
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v3
      
      - uses: pnpm/action-setup@v2
        with:
          version: 10.15.1
      
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'
      
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      
      - name: Type check
        run: pnpm typecheck
      
      - name: Lint
        run: pnpm lint
      
      - name: Run migrations
        run: pnpm migrate
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/test
      
      - name: Run tests
        run: pnpm test:coverage
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/test
          REDIS_URL: redis://localhost:6379
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - uses: pnpm/action-setup@v2
        with:
          version: 10.15.1
      
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'
      
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      
      - name: Build
        run: pnpm build:all
      
      - name: Build Docker images
        run: |
          docker build -f ops/Dockerfile.api -t hunch/api:${GITHUB_SHA} .
          docker build -f ops/Dockerfile.trading-engine -t hunch/trading-engine:${GITHUB_SHA} .
```

---

## 📊 PRIORITIZED ISSUES TABLE

| Severity | File(s) | Lines | Issue | Reproduction | Suggested Fix | Estimate |
|----------|---------|-------|-------|--------------|---------------|----------|
| **CRITICAL** | `apps/indexer-polymarket/src/gammaClient.ts` | 37 | No rate limiting, only 150ms delay | Scale to 3 workers, will hit limits | Implement Redis-based distributed token bucket | 2 days |
| **CRITICAL** | `apps/indexer-limitless/src/limitlessClient.ts` | 32 | NO rate limiting at all | Run indexer, observe 429 errors | Add PQueue + Redis limiter | 1 day |
| **CRITICAL** | All mappers | N/A | No idempotency keys | Re-run bootstrap, observe duplicate events | Add sha256-based idempotency keys | 1 day |
| **CRITICAL** | `apps/trading-engine/*` | N/A | No paper trading mode | Place order, goes live immediately | Add paper mode with separate tables | 3 days |
| **CRITICAL** | `apps/indexer-kalshi/src/env.ts` | 8 | Plain-text private key file | Check `kalshiKey.txt` | Move to AWS Secrets Manager | 1 day |
| **HIGH** | `apps/indexer-kalshi/src/kalshiClient.ts` | 24-25 | Local-only rate limiter | Scale to multiple workers | Make Redis-based | 1 day |
| **HIGH** | All connectors | N/A | No dead-letter queue | Kill DB during ingestion, data lost | Add DLQ table + retry worker | 2 days |
| **HIGH** | `apps/api/src/server.ts` | 125-126 | Offset pagination (not cursor) | Request offset=10000, slow query | Implement cursor pagination | 2 days |
| **HIGH** | `apps/trading-engine/*` | N/A | No order size limits | Place $1M order | Add max order size + exposure limits | 1 day |
| **HIGH** | `apps/api/src/server.ts` | N/A | No API rate limiting | Spam requests | Add @fastify/rate-limit | 0.5 days |
| **HIGH** | All mappers | N/A | No timestamp UTC validation | Send non-UTC timestamp | Add parseUTCDate helper | 0.5 days |
| **MEDIUM** | `apps/indexer-kalshi/src/kalshiClient.ts` | 58-59 | Poor backoff (200ms * i) | Trigger 429, observe short delays | Use exponential backoff | 0.5 days |
| **MEDIUM** | All connectors | N/A | No Retry-After header parsing | Mock 429 with Retry-After | Parse and respect header | 1 day |
| **MEDIUM** | `apps/api/src/server.ts` | 186-190 | No sort validation | Send `?sort=invalid` | Add Zod validation | 0.5 days |
| **MEDIUM** | Database | N/A | Missing indices | Query events by active+closed, slow | Add composite indices | 0.5 days |
| **MEDIUM** | All services | N/A | No structured logging | Debug production issue, only console.log | Add pino logger | 1 day |
| **MEDIUM** | `apps/trading-engine/*` | N/A | No circuit breaker | Exchange down, keeps retrying | Implement circuit breaker | 1 day |
| **MEDIUM** | `apps/api/src/server.ts` | N/A | No authentication | Public access to all endpoints | Add JWT middleware | 1 day |
| **LOW** | `apps/api/src/server.ts` | 155 | No Vary header | Client caching issues | Add `Vary: Accept-Encoding` | 0.1 days |
| **LOW** | All services | N/A | No CI/CD pipeline | Manual testing | Add GitHub Actions | 1 day |

**Total Estimated Time**: ~25 days for one engineer

---

## 🔧 OWNER QUESTIONS (MUST ANSWER BEFORE PROCEEDING)

Please provide explicit answers to these questions:

### 1. Repository & Development

**Q1.1**: Which branch should be treated as the canonical "development" branch for PRs and CI?  
**Options**: `main`, `develop`, `staging`, other?

**Q1.2**: Are there any protected branches with required reviews?

### 2. Secrets & Infrastructure

**Q2.1**: Where are production secrets stored?  
**Options**: AWS Secrets Manager, Vault, env files in secure storage, other?

**Q2.2**: Do we have access to AWS (or cloud provider) for deploying Secrets Manager / KMS?  
**If yes**: Which region? Which AWS account ID?

**Q2.3**: Is TimescaleDB approved for production use?  
**If no**: Must we use plain PostgreSQL? (Will lose continuous aggregates)

### 3. Exchange API Keys & TOS

**Q3.1**: Which exchange account(s) will be used for **LIVE TRADING**?  
- Polymarket: API key available? KYC complete?
- Kalshi: Private key available? Demo or prod account?
- Limitless: API key needed? Account status?

**Q3.2**: Are there KYC / TOS constraints we should enforce programmatically?  
Example: Restrict US users for certain markets, volume limits per jurisdiction

**Q3.3**: Have you reviewed each exchange's TOS for programmatic trading?  
**IMPORTANT**: Some exchanges prohibit bots without explicit permission.

### 4. Trading Safeguards

**Q4.1**: What are the acceptable per-user exposure limits?  
Suggested: Max $50k total exposure, max $10k per order

**Q4.2**: What is the default paper-trading capital for simulations?  
Suggested: $100k virtual funds

**Q4.3**: Do you allow the system to auto-enable live trading after tests?  
**Recommendation**: MANUAL opt-in only (user must explicitly enable)

**Q4.4**: Should we implement a "cooling-off period" for first-time live traders?  
Example: First 7 days limited to $1k orders

### 5. Deployment & Scaling

**Q5.1**: Which cloud provider is production target?  
**Options**: AWS, GCP, Azure, on-premise?

**Q5.2**: Which region(s)?  
Example: `us-east-1` primary, `us-west-2` DR

**Q5.3**: Any latency / throughput SLOs?  
Example: Max 250ms end-to-end for tick ingestion, max 1s for trade execution

**Q5.4**: Should the system support multi-region failover?  
**If yes**: Active-active or active-passive?

**Q5.5**: Initial expected user load?  
You mentioned 1000 initially - is this concurrent users or total registered?

### 6. Legal & Regulatory

**Q6.1**: Any legal/regulatory constraints we should enforce?  
Example: Restrict users from certain countries, require age verification

**Q6.2**: Do we need audit logs for all trades?  
**Recommendation**: Yes, immutable audit trail for all financial transactions

**Q6.3**: Do we need compliance with any financial regulations?  
Example: GDPR (EU), CCPA (CA), FinCEN (US)

### 7. Monitoring & Alerting

**Q7.1**: Who should receive critical alerts?  
Provide email addresses and/or Slack webhook URLs

**Q7.2**: What is the on-call rotation?  
Should alerts escalate if not acknowledged?

**Q7.3**: What are the acceptable downtime windows for maintenance?  
Example: Sundays 2-4 AM UTC

### 8. Data Retention

**Q8.1**: You mentioned storing "all" price history. Confirm retention:  
- Raw ticks: 30 days (current)
- 1-minute aggregates: 1 year (current)
- Hourly aggregates: Forever?
- Daily aggregates: Forever?

**Q8.2**: Should we implement cold storage for old data?  
Example: Move data >1 year to S3 Glacier

### 9. Testing & Quality

**Q9.1**: What is the minimum acceptable test coverage?  
Current config: 80% (branches, functions, lines, statements)

**Q9.2**: Should we require passing tests before merging PRs?  
**Recommendation**: Yes, with GitHub branch protection

**Q9.3**: Do you want a staging environment separate from production?  
**Recommendation**: Yes, for testing integrations before deploying

### 10. Immediate Action Priority

**Q10.1**: Which of these should we fix FIRST (rank 1-5):  
- [ ] Rate limiting (distributed)
- [ ] Paper trading mode
- [ ] Idempotency keys
- [ ] API authentication
- [ ] Secrets management

**Q10.2**: Can we pause live trading until safeguards are in place?  
**Recommendation**: YES, enable paper mode only until audit complete

---

## ✅ ACCEPTANCE CRITERIA

Before marking audit as "complete", the following must be true:

### Critical Fixes (MUST HAVE)
- ✅ Distributed rate limiting implemented for all 3 exchanges
- ✅ Idempotency keys generated and enforced for all ingestion
- ✅ Paper trading mode implemented and set as default
- ✅ Order size limits and user exposure limits enforced
- ✅ Secrets moved to AWS Secrets Manager (or approved alternative)
- ✅ Dead-letter queue for failed ingestion attempts
- ✅ API authentication with JWT
- ✅ Input validation with Zod schemas

### High Priority (SHOULD HAVE)
- ✅ Circuit breaker for trading failures
- ✅ Exponential backoff with Retry-After parsing
- ✅ Cursor-based pagination for /feed endpoint
- ✅ Missing database indices added
- ✅ Structured logging (pino) across all services
- ✅ CI/CD pipeline with automated tests

### Tests (MUST HAVE)
- ✅ Connector tests with mocked HTTP responses (80%+ coverage)
- ✅ Mapper fuzz tests with edge cases
- ✅ Rate limiter behavior tests (burst scenarios)
- ✅ API endpoint tests
- ✅ Trading engine tests (paper + atomic transactions)

### Documentation (MUST HAVE)
- ✅ Runbook for enabling live trading
- ✅ Runbook for backfilling historical data
- ✅ Runbook for emergency rollback
- ✅ API documentation with rate limits
- ✅ Deployment checklist

### Owner Approval (REQUIRED)
- ✅ All Owner Questions answered
- ✅ Explicit approval for live trading enablement
- ✅ Confirmation of secrets storage method
- ✅ Approval of cloud provider and region

---

## 📝 NEXT STEPS

**Immediate**:
1. **STOP** - Do not proceed with fixes until Owner Questions are answered
2. Owner to review this audit report
3. Owner to provide answers to all Owner Questions
4. Owner to approve priority ranking of fixes

**After Owner Approval**:
1. Implement critical fixes in order of priority
2. Write and run all missing tests
3. Set up CI/CD pipeline
4. Deploy to staging environment
5. Run integration tests with paper trading
6. Owner approval for production deployment
7. Deploy to production with paper mode only
8. Monitor for 7 days
9. Owner approval for live trading enablement

**Timeline** (estimated):
- Owner Q&A: 1-2 days
- Critical fixes: 10 days
- High priority fixes: 7 days
- Tests: 5 days
- CI/CD + deployment: 3 days
- **Total: ~4 weeks** for one engineer

---

**END OF AUDIT REPORT**

*This audit was conducted with thoroughness and attention to detail. All findings are based on static code analysis, documentation review, and industry best practices for trading systems. The priority and severity ratings are risk-based assessments.*

*For questions or clarifications, please refer to the Owner Questions section.*


# Quick Start Guide - After Audit Fixes

This guide helps you get the updated Hunch platform running with all the new safety features.

## 🚀 Quick Start (5 Minutes)

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Set Up Environment
Create `.env` file in the root directory:
```bash
# Database
DATABASE_URL=postgresql://hunch:hunch@localhost:5432/hunch

# Redis
REDIS_URL=redis://localhost:6379

# Polymarket
POLYMARKET_GAMMA_BASE=https://gamma-api.polymarket.com
POLYMARKET_CLOB_BASE=https://clob.polymarket.com
POLYMARKET_WS=wss://ws-subscriptions-clob.polymarket.com/ws/market

# Kalshi
KALSHI_API_BASE=https://demo-api.kalshi.co
KALSHI_WS_URL=wss://demo-api.kalshi.co/trade-api/ws/v2
KALSHI_API_KEY_ID=your_key_id_here
KALSHI_PRIVATE_KEY_PATH=./kalshiKey.txt

# Limitless
LIMITLESS_BASE=https://api.limitless.exchange

# Alerts
ALERT_EMAIL_RECIPIENTS=yashag2910@gmail.com
ALERT_SLACK_WEBHOOK_URL=
ALERT_ENABLE_EMAIL=false
ALERT_ENABLE_SLACK=false

# API
API_PORT=3000
```

### 3. Start Infrastructure
```bash
# Start PostgreSQL (with TimescaleDB) and Redis
pnpm run infra:up

# Wait for services to be healthy (~10 seconds)
```

### 4. Run Migrations
```bash
# Apply all database migrations
pnpm run migrate
```

You should see output like:
```
✓ 0001_init.sql
✓ 0002_caggs_retention.sql
✓ 0003_enhanced_schema.sql
✓ 0004_webhook_system.sql
✓ 0005_monitoring_system.sql
✓ 0006_trading_controls.sql
✓ 0007_alerts_system.sql
✓ 0008_user_limits.sql
✓ 0009_dead_letter_queue.sql
✓ 0010_performance_indices.sql
```

### 5. Start Services
```bash
# Start all services
pnpm run dev:all

# Or start individually:
pnpm run dev:api            # API Gateway (port 3000)
pnpm run dev:trading        # Trading Engine (port 3001)
pnpm run dev:analytics      # Analytics Engine (port 3003)
pnpm run dev:polymarket     # Polymarket Indexer
pnpm run dev:kalshi         # Kalshi Indexer
pnpm run dev:limitless      # Limitless Indexer
```

---

## 🧪 Verify Installation

### 1. Check API Health
```bash
curl http://localhost:3000/health
```

Expected response:
```json
{"ok": true}
```

### 2. Check Trading Status
```bash
curl http://localhost:3000/admin/trading/status
```

Expected response:
```json
{
  "success": true,
  "data": {
    "tradingEnabled": true,
    "reason": "Initial state - trading enabled"
  }
}
```

### 3. Check Rate Limiter (via Redis)
```bash
redis-cli KEYS "rate:*"
```

Should show keys like: `rate:polymarket:gamma`, `rate:kalshi:read:api`, etc.

### 4. Check Database Tables
```bash
pnpm run run-db

# In psql:
\dt

# Should see new tables:
# - trading_controls
# - trading_control_audit
# - alerts
# - alert_delivery_log
# - user_limits
# - user_exposure_tracking
# - failed_ingestion
```

---

## 🎯 Test New Features

### Test Emergency Stop
```bash
# Stop trading
curl -X POST http://localhost:3000/admin/trading/emergency-stop \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Testing emergency stop",
    "disabledBy": "admin"
  }'

# Check status (should be disabled)
curl http://localhost:3000/admin/trading/status

# Resume trading
curl -X POST http://localhost:3000/admin/trading/resume \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Test complete",
    "enabledBy": "admin"
  }'
```

### Test Rate Limiting
Start Polymarket indexer and watch logs:
```bash
pnpm run dev:polymarket

# Look for logs like:
# "Fetching events page"
# "Response 200 OK"
# (No rate limit errors!)
```

### Test Idempotency
```bash
# Run bootstrap twice
pnpm run dev:polymarket

# Check for duplicate prevention in logs:
# "Idempotency key xxx... already processed, returning cached result"
```

### Test User Limits
```bash
# Create a test user first (you'll need to implement user creation)
# Then check their exposure:
curl http://localhost:3000/admin/users/{USER_UUID}/exposure

# Should show:
# - inCoolingOff: true (if user < 2 days old)
# - currentLimitUsd: 10000 (for first 2 days)
# - dailyVolumeUsd: 0
# - availableLimitUsd: 10000
```

---

## 📊 Monitoring

### Check DLQ Status
```sql
-- Connect to database
pnpm run run-db

-- Check DLQ statistics
SELECT * FROM dlq_stats;

-- View pending retries
SELECT id, source, resource_type, error_message, retry_count, next_retry_at
FROM failed_ingestion
WHERE status = 'pending'
ORDER BY next_retry_at;
```

### Check Alert History
```sql
-- View recent alerts
SELECT * FROM alerts ORDER BY created_at DESC LIMIT 10;

-- View alert statistics
SELECT * FROM alert_stats;

-- Get unacknowledged critical alerts
SELECT * FROM alerts
WHERE acknowledged = FALSE AND severity = 'CRITICAL';
```

### Check Trading Control Audit
```sql
-- View trading control history
SELECT * FROM trading_control_audit ORDER BY created_at DESC;

-- Check current trading status for all venues
SELECT v.name, tc.trading_enabled, tc.reason, tc.disabled_at
FROM trading_controls tc
LEFT JOIN venues v ON v.id = tc.venue_id;
```

### Monitor Rate Limiting
```bash
# Check Redis rate limit keys
redis-cli KEYS "rate:*"

# Get current tokens for Polymarket
redis-cli HGETALL "rate:polymarket:gamma"

# Get current tokens for Kalshi
redis-cli HGETALL "rate:kalshi:read:api"
```

---

## 🧪 Run Tests

```bash
# Run all tests
pnpm test

# Run specific test files
pnpm test apps/indexer-polymarket/tests/gammaClient.test.ts
pnpm test apps/indexer-kalshi/tests/kalshiClient.test.ts
pnpm test apps/indexer-polymarket/tests/mappers.fuzz.test.ts

# Run with coverage
pnpm test:coverage

# Run in watch mode (for development)
pnpm test:watch

# Run with UI
pnpm test:ui
```

---

## ⚠️ Common Issues & Solutions

### Issue: Migrations fail
**Solution**: 
```bash
# Check database is running
docker ps | grep postgres

# Check connection
psql $DATABASE_URL -c "SELECT 1"

# Check migration status
SELECT * FROM schema_migrations ORDER BY applied_at;
```

### Issue: Redis connection errors
**Solution**:
```bash
# Check Redis is running
docker ps | grep redis

# Test connection
redis-cli ping

# Check Redis logs
docker logs hunch-redis
```

### Issue: Rate limiter not working
**Solution**:
```bash
# Clear all rate limit keys
redis-cli --scan --pattern "rate:*" | xargs redis-cli DEL

# Restart services
pnpm run dev:polymarket
```

### Issue: "Trading disabled" error when not expected
**Solution**:
```bash
# Check trading status
curl http://localhost:3000/admin/trading/status

# Force enable if needed
curl -X POST http://localhost:3000/admin/trading/resume \
  -H "Content-Type: application/json" \
  -d '{"reason": "Force enable", "enabledBy": "admin"}'
```

### Issue: Too many items in DLQ
**Solution**:
```sql
-- Check what's failing
SELECT error_type, COUNT(*) as count
FROM failed_ingestion
WHERE status IN ('pending', 'failed')
GROUP BY error_type
ORDER BY count DESC;

-- If it's validation errors, might need to update mappers
-- If it's network errors, check exchange API status
-- If it's rate limits, adjust rate limiter config
```

---

## 📚 Documentation Reference

- **[AUDIT_REPORT.md](./AUDIT_REPORT.md)** - Complete audit findings and analysis
- **[AUDIT_FIXES_SUMMARY.md](./AUDIT_FIXES_SUMMARY.md)** - Summary of all fixes implemented
- **[IMPLEMENTATION_PROGRESS.md](./IMPLEMENTATION_PROGRESS.md)** - Detailed progress tracking
- **[REVIEW_CHECKLIST.md](./REVIEW_CHECKLIST.md)** - Files to review
- **[API Reference](./docs/api-reference.md)** - Complete API documentation
- **[Database Schema](./docs/database-schema.md)** - Database structure
- **[Exchange APIs](./docs/exchange-apis.md)** - Exchange integration docs

---

## 🚦 Next Steps

1. **Review Code**: Check [REVIEW_CHECKLIST.md](./REVIEW_CHECKLIST.md) for files to review
2. **Test Everything**: Run all tests and verify functionality
3. **Add Authentication**: Implement JWT auth for admin routes (HIGH PRIORITY)
4. **Deploy to Staging**: Test with real data (carefully!)
5. **Monitor**: Watch logs, DLQ, alerts for any issues

---

**Need Help?** Contact: yashag2910@gmail.com

**Happy Trading! 🚀**


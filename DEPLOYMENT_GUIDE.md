# Production Deployment Guide

Complete step-by-step guide for deploying the Hunch platform to production.

---

## 🚀 PRE-DEPLOYMENT CHECKLIST

### 1. Code Review
- [ ] Review all files in `REVIEW_CHECKLIST.md`
- [ ] All tests passing: `pnpm test`
- [ ] No linter errors: `pnpm lint`
- [ ] Type check passing: `pnpm typecheck`

### 2. Security
- [ ] **Change JWT_SECRET** to secure random value
- [ ] **Update password hashing** to use bcrypt (currently SHA-256)
- [ ] Review all admin routes are protected
- [ ] Verify no secrets in code/git
- [ ] Set up AWS Secrets Manager (recommended)

### 3. Configuration
- [ ] Create production `.env` from `env.template`
- [ ] Configure alert recipients
- [ ] Set up SMTP for email alerts (if using)
- [ ] Configure Slack webhook (if using)
- [ ] Set proper rate limits

### 4. Database
- [ ] Run migrations on staging first
- [ ] Backup production database before migration
- [ ] Verify all indices are created
- [ ] Test query performance

### 5. Infrastructure
- [ ] PostgreSQL 16+ with TimescaleDB 2.14+ ready
- [ ] Redis 7+ ready
- [ ] Sufficient disk space for data retention
- [ ] Network connectivity to exchange APIs

---

## 📋 STEP-BY-STEP DEPLOYMENT

### Step 1: Prepare Environment

```bash
# Generate secure JWT secret
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Create production .env
cp env.template .env
nano .env  # Edit with production values
```

**Critical values to set**:
- `JWT_SECRET` - Use generated value above
- `DATABASE_URL` - Production PostgreSQL connection
- `REDIS_URL` - Production Redis connection
- `KALSHI_API_KEY_ID` - Real API key
- `ALERT_EMAIL_RECIPIENTS` - Admin emails
- `NODE_ENV=production`

### Step 2: Build All Services

```bash
# Install dependencies
pnpm install --frozen-lockfile

# Build all services
pnpm build:all
```

Verify builds:
```bash
ls -la apps/api/dist
ls -la apps/trading-engine/dist
# ... etc for all services
```

### Step 3: Database Migration

```bash
# Backup current database
pnpm run backup

# Run migrations
pnpm run migrate

# Verify migrations applied
psql $DATABASE_URL -c "SELECT * FROM schema_migrations ORDER BY applied_at"
```

Expected migrations:
- 0001_init.sql
- 0002_caggs_retention.sql
- 0003_enhanced_schema.sql
- 0004_webhook_system.sql
- 0005_monitoring_system.sql
- 0006_trading_controls.sql ← NEW
- 0007_alerts_system.sql ← NEW
- 0008_user_limits.sql ← NEW
- 0009_dead_letter_queue.sql ← NEW
- 0010_performance_indices.sql ← NEW

### Step 4: Seed Initial Data

```bash
# Create venues
psql $DATABASE_URL << EOF
INSERT INTO venues (name, display_name, is_active) VALUES
  ('polymarket', 'Polymarket', TRUE),
  ('kalshi', 'Kalshi', TRUE),
  ('limitless', 'Limitless', TRUE)
ON CONFLICT (name) DO NOTHING;
EOF

# Initialize trading controls (already done by migration)
# Verify:
psql $DATABASE_URL -c "SELECT * FROM trading_controls"
```

### Step 5: Create Admin User

```bash
# Start API temporarily
pnpm run dev:api &
API_PID=$!

# Wait for API to start
sleep 5

# Register admin user
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@hunch.com",
    "username": "admin",
    "password": "SecureAdminPassword123!",
    "firstName": "System",
    "lastName": "Administrator"
  }'

# Update to admin role
psql $DATABASE_URL -c "UPDATE users SET role = 'admin' WHERE email = 'admin@hunch.com'"

# Stop temporary API
kill $API_PID
```

### Step 6: Deploy Services

#### Option A: Docker Compose (Recommended for staging)
```bash
# Build Docker images
docker-compose -f ops/docker-compose.prod.yml build

# Start all services
docker-compose -f ops/docker-compose.prod.yml up -d

# Check status
docker-compose -f ops/docker-compose.prod.yml ps
```

#### Option B: Kubernetes (Recommended for production)
```bash
# Create namespace
kubectl apply -f ops/k8s/namespace.yaml

# Create secrets
kubectl create secret generic hunch-secrets \
  --from-literal=jwt-secret=$JWT_SECRET \
  --from-literal=database-url=$DATABASE_URL \
  --from-literal=redis-url=$REDIS_URL \
  -n hunch

# Apply configurations
kubectl apply -f ops/k8s/configmap.yaml
kubectl apply -f ops/k8s/postgres.yaml
kubectl apply -f ops/k8s/redis.yaml

# Deploy services (create deployment YAMLs for each service)
# kubectl apply -f ops/k8s/api-deployment.yaml
# kubectl apply -f ops/k8s/trading-engine-deployment.yaml
# ... etc
```

### Step 7: Verify Deployment

```bash
# Check API health
curl http://your-domain.com/health

# Check trading status
TOKEN=$(curl -X POST http://your-domain.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@hunch.com","password":"SecureAdminPassword123!"}' \
  | jq -r '.data.token')

curl http://your-domain.com/admin/trading/status \
  -H "Authorization: Bearer $TOKEN"

# Check DLQ
curl http://your-domain.com/admin/dlq/stats \
  -H "Authorization: Bearer $TOKEN"
```

### Step 8: Start Indexers

```bash
# Start all indexers
pnpm run dev:polymarket &
pnpm run dev:kalshi &
pnpm run dev:limitless &

# Or use Docker/K8s deployments
```

### Step 9: Monitor Initial Run

Watch logs for:
- ✅ Successful data ingestion
- ✅ No rate limit errors (429)
- ✅ No duplicate events (idempotency working)
- ✅ No DLQ items (or expected transient failures)

---

## 🔍 POST-DEPLOYMENT VERIFICATION

### 1. Rate Limiting Check
```bash
# Check Redis rate limit keys
redis-cli KEYS "rate:*"

# Get current tokens
redis-cli HGETALL "rate:polymarket:gamma"
redis-cli HGETALL "rate:kalshi:read:api"

# Should see keys being created and updated
```

### 2. Idempotency Check
```sql
-- Check idempotency table
SELECT COUNT(*) FROM idempotency;

-- View recent idempotency keys
SELECT key, created_at FROM idempotency ORDER BY created_at DESC LIMIT 10;

-- Run bootstrap twice and verify no duplicates
```

### 3. Trading Controls Check
```sql
-- Verify trading is enabled
SELECT * FROM trading_controls;

-- Should show: trading_enabled = TRUE
```

### 4. User Limits Check
```sql
-- Verify user limits are created
SELECT COUNT(*) FROM user_limits;

-- Check default limits
SELECT * FROM user_limits LIMIT 5;
```

### 5. Performance Check
```sql
-- Verify indices exist
SELECT tablename, indexname FROM pg_indexes 
WHERE tablename IN ('events', 'markets', 'orders', 'trades')
ORDER BY tablename, indexname;

-- Should see 30+ new indices

-- Test query performance (should be fast)
EXPLAIN ANALYZE
SELECT * FROM events 
WHERE venue_id = 1 AND active = TRUE AND closed = FALSE
ORDER BY start_time DESC LIMIT 50;
```

### 6. DLQ Check
```sql
-- Should be empty initially
SELECT * FROM failed_ingestion;

-- View DLQ stats
SELECT * FROM dlq_stats;
```

### 7. Alerts Check
```sql
-- Should be empty initially
SELECT * FROM alerts;

-- Create test alert by placing large order (when trading is implemented)
```

---

## 📊 MONITORING SETUP

### 1. Database Monitoring
```sql
-- Check database size
SELECT pg_size_pretty(pg_database_size('hunch'));

-- Check table sizes
SELECT 
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Check index usage
SELECT 
  schemaname,
  tablename,
  indexname,
  idx_scan,
  idx_tup_read
FROM pg_stat_user_indexes
ORDER BY idx_scan DESC;
```

### 2. Redis Monitoring
```bash
# Check memory usage
redis-cli INFO memory

# Check key count
redis-cli DBSIZE

# Monitor rate limit keys
watch -n 1 'redis-cli KEYS "rate:*" | wc -l'
```

### 3. Application Logs
```bash
# View logs
docker-compose -f ops/docker-compose.prod.yml logs -f

# Or with K8s
kubectl logs -f deployment/api -n hunch
```

### 4. Health Checks
```bash
# API health
curl http://your-domain.com/health

# Trading health
curl http://your-domain.com/admin/trading/health \
  -H "Authorization: Bearer $TOKEN"

# DLQ health
curl http://your-domain.com/admin/dlq/stats \
  -H "Authorization: Bearer $TOKEN"
```

---

## 🚨 INCIDENT RESPONSE

### Emergency Stop Trading

```bash
# Get admin token
TOKEN=$(curl -X POST http://your-domain.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@hunch.com","password":"password"}' \
  | jq -r '.data.token')

# STOP ALL TRADING
curl -X POST http://your-domain.com/admin/trading/emergency-stop \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Suspected issue - investigating",
    "disabledBy": "admin@hunch.com"
  }'

# Verify stopped
curl http://your-domain.com/admin/trading/status \
  -H "Authorization: Bearer $TOKEN"
```

### Resume Trading

```bash
# After issue is resolved
curl -X POST http://your-domain.com/admin/trading/resume \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Issue resolved, resuming trading",
    "enabledBy": "admin@hunch.com"
  }'
```

### Clear Rate Limiter (if stuck)

```bash
# Clear all rate limit keys
redis-cli --scan --pattern "rate:*" | xargs redis-cli DEL

# Or specific exchange
redis-cli DEL "rate:polymarket:gamma"
```

### Reprocess Failed DLQ Items

```sql
-- View failed items
SELECT * FROM failed_ingestion WHERE status = 'failed';

-- Manually reset for retry
UPDATE failed_ingestion 
SET status = 'pending', next_retry_at = NOW(), retry_count = 0
WHERE id = 'item-uuid';

-- Or ignore permanently
SELECT ignore_dlq_item('item-uuid', 'admin', 'Data no longer relevant');
```

---

## 🔧 MAINTENANCE TASKS

### Daily (Automated via Cron):

```bash
# Reset daily user exposure (at midnight UTC)
0 0 * * * curl -X POST http://localhost:3000/admin/exposure/reset-daily \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Clean up old idempotency keys (keep last 7 days)
0 1 * * * psql $DATABASE_URL -c "SELECT cleanup_old_idempotency_keys(7)"

# Clean up old DLQ items (resolved items > 30 days)
0 2 * * * psql $DATABASE_URL -c "SELECT cleanup_old_dlq_items()"

# Clean up old alerts (acknowledged items > 90 days)
0 3 * * * psql $DATABASE_URL -c "SELECT cleanup_old_alerts()"
```

### Weekly:

```bash
# Database vacuum
psql $DATABASE_URL -c "VACUUM ANALYZE"

# Check for unused indices
psql $DATABASE_URL -c "
SELECT 
  schemaname,
  tablename,
  indexname,
  idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 10"

# Backup database
pnpm run backup
```

### Monthly:

```bash
# Review alert patterns
psql $DATABASE_URL -c "SELECT * FROM alert_stats"

# Review DLQ patterns
psql $DATABASE_URL -c "SELECT * FROM dlq_stats"

# Review user limit usage
psql $DATABASE_URL -c "
SELECT 
  COUNT(*) as users_in_cooling_off,
  COUNT(*) FILTER (WHERE is_user_in_cooling_off(id) = FALSE) as users_post_cooling_off
FROM users"

# Check TimescaleDB compression
psql $DATABASE_URL -c "SELECT * FROM timescaledb_information.compression_settings"
```

---

## 📈 SCALING GUIDE

### Horizontal Scaling (Add More Workers)

Rate limiting is distributed, so you can add workers safely:

```bash
# Scale indexers
docker-compose -f ops/docker-compose.prod.yml up -d --scale indexer-polymarket=3

# Or with K8s
kubectl scale deployment indexer-polymarket --replicas=3 -n hunch
```

**No coordination needed** - rate limiter handles it automatically!

### Vertical Scaling (More Resources)

If queries are slow:
1. Increase PostgreSQL max_connections
2. Increase shared_buffers
3. Increase work_mem for complex queries
4. Add more Redis memory

### Database Scaling

If database becomes bottleneck:
1. Add read replicas for analytics queries
2. Partition large tables by venue_id
3. Use connection pooling (PgBouncer)
4. Consider TimescaleDB multi-node

---

## 🔄 ROLLBACK PROCEDURE

### If Issues After Deployment:

```bash
# 1. Emergency stop trading
curl -X POST http://your-domain.com/admin/trading/emergency-stop \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Rollback in progress","disabledBy":"admin"}'

# 2. Stop all services
docker-compose -f ops/docker-compose.prod.yml down

# 3. Restore database backup
pnpm run backup:restore

# 4. Revert code to previous version
git checkout previous-stable-commit

# 5. Rebuild
pnpm install
pnpm build:all

# 6. Restart services
docker-compose -f ops/docker-compose.prod.yml up -d

# 7. Resume trading (if safe)
curl -X POST http://your-domain.com/admin/trading/resume \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Rollback complete","enabledBy":"admin"}'
```

---

## ✅ POST-DEPLOYMENT CHECKLIST

### Within 1 Hour:
- [ ] All services running
- [ ] Health checks passing
- [ ] No errors in logs
- [ ] Rate limiting working
- [ ] No DLQ items (or expected only)

### Within 24 Hours:
- [ ] Data ingestion working correctly
- [ ] No duplicate events (idempotency working)
- [ ] Alerts working (test with large order if needed)
- [ ] User limits enforced correctly
- [ ] Emergency stop tested

### Within 1 Week:
- [ ] Performance metrics stable
- [ ] No unexpected rate limit errors
- [ ] DLQ mostly empty
- [ ] Database size as expected
- [ ] All indices being used

---

## 📞 SUPPORT

**Primary Contact**: yashag2910@gmail.com

**Emergency Procedures**:
1. Stop trading: Use emergency stop endpoint
2. Check logs: `docker-compose logs` or `kubectl logs`
3. Check DLQ: Query `failed_ingestion` table
4. Check alerts: Query `alerts` table
5. Check trading controls: Query `trading_controls` table

**Documentation**:
- `AUDIT_REPORT.md` - Understanding the changes
- `FINAL_SUMMARY.md` - What was implemented
- `QUICK_START_GUIDE.md` - Local development
- `REVIEW_CHECKLIST.md` - Code review

---

## 🎉 SUCCESS CRITERIA

Deployment is successful when:
- ✅ All services running without errors
- ✅ Data ingestion working (no 429 errors)
- ✅ No duplicate events in database
- ✅ Emergency stop tested and working
- ✅ User limits enforced correctly
- ✅ Alerts triggered for large orders
- ✅ DLQ processing failed items
- ✅ Admin authentication working

---

**Ready to deploy! 🚀**


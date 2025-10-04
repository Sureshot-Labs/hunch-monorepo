# Hunch Platform Deployment Guide

This directory contains all the necessary files and scripts for deploying the Hunch platform to production.

## 📁 Directory Structure

```
ops/
├── docker-compose.prod.yml     # Production Docker Compose configuration
├── Dockerfile.*               # Dockerfiles for each service
├── nginx/                     # Nginx reverse proxy configuration
├── k8s/                       # Kubernetes manifests
├── prometheus/                # Prometheus configuration
├── grafana/                   # Grafana configuration
├── deploy.sh                  # Deployment script
├── backup.sh                  # Backup and restore script
├── env.prod.example           # Environment configuration template
└── README.md                  # This file
```

## 🚀 Quick Start

### Prerequisites

- Docker and Docker Compose
- kubectl (for Kubernetes deployment)
- AWS CLI (for S3 backups)
- PostgreSQL client tools (pg_dump, psql)
- Redis client tools (redis-cli)

### 1. Environment Setup

```bash
# Copy environment template
cp ops/env.prod.example .env.prod

# Edit environment variables
nano .env.prod
```

### 2. Docker Deployment

```bash
# Deploy with Docker Compose
pnpm run deploy:docker

# Or manually
ops/deploy.sh docker
```

### 3. Kubernetes Deployment

```bash
# Deploy to Kubernetes
pnpm run deploy:k8s

# Or manually
ops/deploy.sh kubernetes
```

## 🐳 Docker Deployment

### Services

The Docker Compose setup includes:

- **PostgreSQL** (TimescaleDB) - Database with time-series extensions
- **Redis** - Caching and message queuing
- **API Gateway** - Main API service
- **Trading Engine** - Trading operations
- **Analytics Engine** - Market analysis and indicators
- **Webhook System** - Event notifications
- **Price History Service** - Historical data management
- **Data Ingestion Service** - Data collection from exchanges
- **Monitoring Service** - System monitoring and alerting
- **Nginx** - Reverse proxy and load balancer
- **Prometheus** - Metrics collection
- **Grafana** - Monitoring dashboards

### Configuration

Edit `docker-compose.prod.yml` to customize:

- Service ports
- Resource limits
- Health check intervals
- Volume mounts
- Network configuration

### Health Checks

All services include health check endpoints:

- API Gateway: `http://localhost:3000/health`
- Trading Engine: `http://localhost:3001/health`
- Analytics Engine: `http://localhost:3003/health`
- Webhook System: `http://localhost:3004/health`
- Price History: `http://localhost:3005/health`
- Data Ingestion: `http://localhost:3006/health`
- Monitoring: `http://localhost:3007/health`

## ☸️ Kubernetes Deployment

### Prerequisites

- Kubernetes cluster (1.20+)
- kubectl configured
- Storage class for persistent volumes
- Load balancer or ingress controller

### Deployment Steps

1. **Create namespace and secrets**:
   ```bash
   kubectl apply -f ops/k8s/namespace.yaml
   kubectl apply -f ops/k8s/secrets.yaml
   ```

2. **Deploy database and cache**:
   ```bash
   kubectl apply -f ops/k8s/postgres.yaml
   kubectl apply -f ops/k8s/redis.yaml
   ```

3. **Deploy services**:
   ```bash
   kubectl apply -f ops/k8s/services.yaml
   ```

### Scaling

Scale services horizontally:

```bash
# Scale trading engine
kubectl scale deployment trading-engine --replicas=3

# Scale analytics engine
kubectl scale deployment analytics-engine --replicas=2
```

### Resource Management

Configure resource requests and limits in the Kubernetes manifests:

```yaml
resources:
  requests:
    memory: "512Mi"
    cpu: "250m"
  limits:
    memory: "1Gi"
    cpu: "500m"
```

## 🔧 Configuration

### Environment Variables

Key environment variables:

```bash
# Database
POSTGRES_PASSWORD=your-secure-password
DATABASE_URL=postgresql://hunch:password@postgres:5432/hunch

# Redis
REDIS_PASSWORD=your-secure-password
REDIS_URL=redis://:password@redis:6379

# API Keys
POLYMARKET_API_KEY=your-api-key
LIMITLESS_API_KEY=your-api-key

# Monitoring
ALERT_EMAIL=admin@your-domain.com
ALERT_SLACK_WEBHOOK=https://hooks.slack.com/...
```

### Nginx Configuration

The Nginx reverse proxy provides:

- Load balancing across service instances
- SSL termination
- Rate limiting
- Security headers
- WebSocket support

Edit `nginx/conf.d/hunch.conf` to customize routing and security.

### Monitoring Configuration

Prometheus scrapes metrics from all services:

- Service metrics: CPU, memory, request rates
- Business metrics: orders, trades, webhooks
- Custom metrics: application-specific data

Grafana provides dashboards for:

- System overview
- Service health
- Performance metrics
- Alert management

## 💾 Backup and Restore

### Automated Backups

```bash
# Create backup
pnpm run backup

# List available backups
pnpm run backup:list

# Restore from backup
pnpm run backup:restore hunch_backup_20240101_120000
```

### Backup Components

- **PostgreSQL**: Database schema and data
- **Redis**: Cache and queue data
- **Application**: Source code and configuration
- **Configuration**: Environment and deployment files

### S3 Integration

Configure S3 backup:

```bash
export BACKUP_S3_BUCKET=your-backup-bucket
export BACKUP_S3_REGION=us-east-1
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
```

## 🔍 Monitoring and Alerting

### Metrics Collection

Prometheus collects metrics from:

- All Hunch services
- System resources (CPU, memory, disk)
- Database performance
- Redis performance
- Nginx access logs

### Alerting Rules

Default alerts include:

- High CPU usage (>80%)
- High memory usage (>90%)
- High database connections (>80)
- Service health check failures
- High error rates

### Dashboards

Grafana dashboards:

- **System Overview**: High-level system status
- **Service Health**: Individual service monitoring
- **Performance**: Response times and throughput
- **Business Metrics**: Trading and analytics data
- **Alerts**: Active alerts and notifications

## 🔒 Security

### Network Security

- Services communicate over private Docker network
- Nginx provides SSL termination
- Rate limiting prevents abuse
- Security headers protect against common attacks

### Data Security

- Database passwords encrypted
- API keys stored securely
- Redis password protected
- Backup data encrypted

### Access Control

- JWT-based authentication
- Role-based authorization
- API rate limiting
- CORS configuration

## 🚨 Troubleshooting

### Common Issues

1. **Service won't start**:
   - Check environment variables
   - Verify database connectivity
   - Check port conflicts

2. **Database connection errors**:
   - Verify PostgreSQL is running
   - Check connection string
   - Verify credentials

3. **Redis connection errors**:
   - Verify Redis is running
   - Check password configuration
   - Verify network connectivity

4. **High memory usage**:
   - Check for memory leaks
   - Increase container limits
   - Optimize queries

### Logs

View service logs:

```bash
# Docker Compose
docker-compose -f ops/docker-compose.prod.yml logs -f service-name

# Kubernetes
kubectl logs -f deployment/service-name -n hunch
```

### Health Checks

Check service health:

```bash
# Individual services
curl http://localhost:3000/health
curl http://localhost:3001/health

# All services
curl http://localhost/health
```

## 📈 Performance Optimization

### Database Optimization

- Enable TimescaleDB compression
- Configure retention policies
- Optimize queries with indexes
- Monitor slow queries

### Caching Strategy

- Redis for session storage
- Application-level caching
- CDN for static assets
- Database query caching

### Load Balancing

- Nginx round-robin
- Health check integration
- Session affinity
- Circuit breakers

## 🔄 Updates and Maintenance

### Rolling Updates

```bash
# Docker Compose
docker-compose -f ops/docker-compose.prod.yml up -d --no-deps service-name

# Kubernetes
kubectl rollout restart deployment/service-name -n hunch
```

### Database Migrations

```bash
# Run migrations
docker-compose -f ops/docker-compose.prod.yml exec postgres psql -U hunch -d hunch -f /migrations/migration.sql
```

### Monitoring Updates

- Update Prometheus configuration
- Refresh Grafana dashboards
- Adjust alert thresholds
- Review retention policies

## 📞 Support

For deployment issues:

1. Check service logs
2. Verify configuration
3. Test connectivity
4. Review monitoring data
5. Check GitHub Issues

## 📚 Additional Resources

- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Kubernetes Documentation](https://kubernetes.io/docs/)
- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/)
- [TimescaleDB Documentation](https://docs.timescale.com/)
- [Redis Documentation](https://redis.io/documentation)

## Hunch

**Hunch** is a unified prediction market terminal that aggregates markets from platforms such as Polymarket, Kalshi, PredictBase, and others into a single dashboard. It aims to give traders one place to see cross-platform odds, liquidity, volume, and "smart money" flows, with discovery, alerts, wallet tracking, and analytics. Think: a prediction-markets terminal that lets users discover, compare, and route trades to the underlying venues via native integrations.

This ingestor feeds that future: it normalizes markets and streams price/TOB data into storage/cache layers that downstream services (APIs, UI) can consume.

## Getting Started

### For New Developers

If you're new to the project, start with the **[Developer Setup Guide](./DEVELOPER_SETUP.md)** which covers:
- Prerequisites and installation
- Environment configuration
- Database setup
- Running the project locally
- Development workflow
- Troubleshooting

### Quick Start

```bash
# Install dependencies
pnpm install

# Start infrastructure (PostgreSQL, Redis)
pnpm infra:up

# Run database migrations
pnpm migrate

# Start all services in development mode
pnpm dev
```

### Documentation

- **[Developer Setup Guide](./DEVELOPER_SETUP.md)** - Complete setup instructions for new developers
- **[API Documentation](./API_DOCUMENTATION.md)** - Complete API reference

# Environment Variables for Privy Authentication

## Required Environment Variables

Add these environment variables to your `.env` file in the project root:

```bash
# Privy Authentication
PRIVY_APP_ID=your-privy-app-id-here
PRIVY_APP_SECRET=your-privy-app-secret-here

# JWT Configuration (optional - defaults provided)
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=24h
```

## How to Get Privy Credentials

1. **PRIVY_APP_ID**: This is the same App ID you're using in your frontend Privy configuration
   - Found in your Privy dashboard under "App Settings"
   - Should match the `appId` in your frontend `PrivyProviderBase` configuration

2. **PRIVY_APP_SECRET**: This is your Privy API secret
   - Found in your Privy dashboard under "App Settings" → "API Keys"
   - Generate a new API key if you don't have one
   - Keep this secret secure - never commit it to version control

## Security Notes

- **Never commit these secrets to version control**
- Use different credentials for development, staging, and production environments
- Rotate your API secrets regularly
- Consider using environment variable management tools for production deployments

## Example .env File

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/hunch_db

# Redis (optional)
REDIS_URL=redis://localhost:6379

# Privy Authentication
PRIVY_APP_ID=clxxxxxxxxxxxxxxxxxxxxx
PRIVY_APP_SECRET=privy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=24h

# API Configuration
PORT=3001
API_DEFAULT_LIMIT=50
API_MAX_LIMIT=200
API_FEED_TTL_SEC=2
```

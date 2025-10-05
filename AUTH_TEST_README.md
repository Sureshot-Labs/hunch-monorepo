# Authentication Flow Test Script

This script tests the complete authentication flow for the Hunch Trading Platform API using your wallet's private and public keys.

## 🚀 Quick Start

### 1. Setup
```bash
# Run the setup script
./setup-auth-test.sh

# Or manually install ethers
npm install ethers
```

### 2. Configure Your Wallet
Edit `test-auth.env` and add your wallet details:
```bash
WALLET_PRIVATE_KEY=0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
WALLET_ADDRESS=0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6
API_BASE_URL=http://localhost:3001
```

### 3. Start API Server
```bash
cd apps/api && npm run dev
```

### 4. Run Test
```bash
# Using environment file
source test-auth.env && node test-auth-flow.js

# Or with command line arguments
node test-auth-flow.js --private-key 0x... --address 0x...
```

## 🔧 Usage Options

### Command Line Arguments
```bash
node test-auth-flow.js [options]

Options:
  --private-key <key>    Wallet private key
  --address <address>    Wallet address  
  --api-url <url>        API base URL (default: http://localhost:3001)
  --help                 Show help message
```

### Environment Variables
```bash
WALLET_PRIVATE_KEY     # Your wallet's private key
WALLET_ADDRESS         # Your wallet's address
API_BASE_URL           # API base URL
```

## 🧪 What the Test Does

The script performs a complete authentication flow:

1. **Initialize Wallet** - Creates ethers wallet from private key
2. **Get Nonce** - Requests nonce from `/auth/nonce` endpoint
3. **Sign Message** - Signs the authentication message with your wallet
4. **Authenticate** - Sends signature to `/auth/verify` endpoint
5. **Test Protected Endpoints** - Tests authenticated endpoints:
   - `/auth/me` - Get user profile
   - `/auth/wallets` - Get user wallets
   - `/auth/venue-credentials` - Get venue credentials
6. **Test Venue Credentials** - Sets up credentials for:
   - Polymarket
   - Kalshi (with additional data)
7. **Test Logout** - Tests session invalidation

## 📊 Expected Output

```
🚀 Starting Authentication Flow Test
API Base URL: http://localhost:3001
Wallet Address: 0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6

Step 1: Getting nonce from API
✅ Nonce received: a1b2c3d4e5f6...
ℹ️  Message to sign: Sign this message to authenticate...

Step 2: Signing message with wallet
✅ Message signed: 0x1234567890abcdef...

Step 3: Authenticating with API
✅ Authentication successful!
ℹ️  User ID: uuid-here
ℹ️  Session expires: 2025-10-06T08:00:00Z

Step 4: Testing protected endpoints
ℹ️  Testing /auth/me...
✅ User profile retrieved: Test User
ℹ️  Testing /auth/wallets...
✅ Wallets retrieved: 1 wallet(s)
ℹ️  Testing /auth/venue-credentials...
✅ Venue credentials retrieved: 0 credential(s)

Step 5: Testing venue credentials setup
ℹ️  Setting Polymarket credentials...
✅ Polymarket credentials set: uuid-here
ℹ️  Setting Kalshi credentials...
✅ Kalshi credentials set: uuid-here

Step 6: Testing logout
✅ Logout successful: Successfully logged out

🎉 Authentication Flow Test Completed Successfully!
```

## 🔐 Security Notes

- **Never commit private keys** to version control
- **Use test wallets** for development/testing
- **Keep private keys secure** - they control your wallet
- **The script only signs messages** - it doesn't send private keys to the API

## 🐛 Troubleshooting

### Common Issues

1. **"Please set WALLET_PRIVATE_KEY"**
   - Make sure you've set the environment variables or command line arguments

2. **"Wallet address mismatch"**
   - Verify your private key corresponds to the wallet address

3. **"HTTP 500: Authentication failed"**
   - Check if the API server is running
   - Verify the database is properly set up
   - Check server logs for detailed error messages

4. **"Failed to get nonce"**
   - Ensure the API server is running on the correct port
   - Check if Redis is running (for nonce storage)

### Debug Mode
Add `console.log` statements in the script to debug specific steps.

## 📁 Files

- `test-auth-flow.js` - Main test script
- `setup-auth-test.sh` - Setup script
- `test-auth.env` - Environment configuration (created by setup)
- `test-auth-package.json` - Package configuration

## 🔄 Integration with Frontend

This script simulates the exact flow your frontend will use:

1. **Get nonce** from API
2. **Sign message** with MetaMask/WalletConnect
3. **Send signature** to authenticate
4. **Use JWT token** for authenticated requests

The frontend will use the same API endpoints but with browser wallet integration instead of private keys.


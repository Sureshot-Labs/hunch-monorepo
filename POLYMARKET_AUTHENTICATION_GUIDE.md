# Polymarket Authentication Guide

## Quick Answer: Use Your MetaMask EOA Keys

**You should use your MetaMask EOA (Externally Owned Account) private/public keys**, not a Polymarket proxy account.

## Why MetaMask EOA Keys?

### 1. **Non-Custodial Trading**
- Your funds stay in your control
- No need to deposit funds to Polymarket
- Direct trading from your wallet

### 2. **L1 Authentication Required**
- Polymarket uses **L1 authentication** for order placement
- Requires your actual wallet's private key
- Used to sign EIP-712 messages

### 3. **No Separate Account Creation**
- No need to create a Polymarket account
- API keys are generated dynamically using your wallet signature
- Your wallet IS your Polymarket identity

## How It Works

```
Your MetaMask Wallet (EOA)
    ↓ (private key)
Sign EIP-712 Message
    ↓ (signature)
Polymarket API
    ↓ (generates)
Temporary API Keys
    ↓ (used for)
Order Placement
```

## Step-by-Step Process

### 1. **Wallet Setup**
- Use your MetaMask wallet
- Ensure it's connected to Polygon network
- Have some MATIC for gas fees

### 2. **API Key Generation**
- Sign EIP-712 message with your private key
- Send signature to Polymarket's API
- Receive temporary API keys

### 3. **Order Placement**
- Use API keys for order placement
- Orders are signed with your private key
- Funds remain in your wallet

## Common Issues & Solutions

### Issue: "Could not create api key"
**Possible causes:**
1. **Wallet not funded**: Need REAL MATIC/POL tokens (not testnet)
2. **Wallet not verified**: Some wallets need verification
3. **Network issues**: Connection problems
4. **Wrong keys**: Private key doesn't match address

**Solutions:**
1. **Buy REAL MATIC/POL tokens** from exchanges (Coinbase, Binance, etc.)
2. Visit https://polymarket.com and connect your wallet
3. Check network connectivity
4. Verify your private key matches your address
5. **Note**: MATIC has been rebranded to POL, but both work

### Issue: "Authentication failed"
**Possible causes:**
1. Wrong private key
2. Address mismatch
3. Network configuration issues

**Solutions:**
1. Double-check your private key
2. Ensure address matches private key
3. Verify Polygon network configuration

## Security Best Practices

### ✅ Do:
- Use a dedicated test wallet
- Keep private keys secure
- Use testnet for development
- Never share private keys

### ❌ Don't:
- Use your main wallet's private key
- Share private keys with anyone
- Use production wallets for testing
- Store private keys in code

## Testing Setup

### 1. **Create Test Wallet**
```bash
# Use the helper script
node get-wallet-keys.js
```

### 2. **Fund Test Wallet**
- **Buy REAL MATIC/POL tokens** from exchanges (Coinbase, Binance, etc.)
- **NOT testnet MATIC/POL** - Polymarket is on mainnet
- Use small amounts for testing (e.g., $5-10 worth)
- **Note**: MATIC has been rebranded to POL, but both work

### 3. **Run Test**
```bash
# Set your test keys in .env
TEST_PRIVATE_KEY=0x...
TEST_PUBLIC_KEY=0x...

# Run the test
node test-live-polymarket-trading.js
```

## What You Need

### Required:
- MetaMask EOA private key
- MetaMask EOA public key (address)
- **REAL MATIC/POL tokens** (not testnet) for gas fees
- Polygon mainnet access

### Not Required:
- Polymarket account creation
- Depositing funds to Polymarket
- Separate API key registration
- Proxy account setup

## Summary

**Use your MetaMask EOA keys directly.** Polymarket's L1 authentication is designed to work with your existing wallet - no separate account creation needed. The API keys are just temporary credentials generated from your wallet signature.

The error you're seeing is likely due to:
1. **Wallet not having REAL MATIC/POL tokens** (not testnet MATIC/POL)
2. Wallet not being "verified" on Polymarket (try visiting polymarket.com first)
3. Network connectivity issues

**Important**: Polymarket is on Polygon **mainnet**, so you need **real MATIC/POL tokens** purchased from exchanges, not testnet MATIC/POL from faucets.

**Note**: MATIC has been rebranded to POL as part of Polygon 2.0, but both tokens work for gas fees and trading.

Try the updated test script - it now includes wallet balance checking and better error guidance!

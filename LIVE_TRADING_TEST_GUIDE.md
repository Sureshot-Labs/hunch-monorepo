# Live Polymarket Trading Test Guide

## 🚀 **Complete Live Trading Test**

This guide will help you test real trading on Polymarket with actual API keys and minimum trades.

## 📋 **Prerequisites**

### 1. **Wallet Setup**
- ✅ MetaMask or compatible wallet
- ✅ Wallet connected to **Polygon network**
- ✅ **USDC balance** on Polygon (minimum $1-5 for testing)
- ✅ Wallet **connected to Polymarket** (visit polymarket.com and connect)

### 2. **Environment Setup**
- ✅ API server running (`npm run dev`)
- ✅ Database connected
- ✅ Your private/public keys ready

## 🔧 **Setup Instructions**

### Step 1: Configure Your Keys
```bash
# Copy the example file
cp test-live-trading.env.example .env

# Edit .env and add your actual keys
TEST_PRIVATE_KEY=0xYOUR_ACTUAL_PRIVATE_KEY_HERE
TEST_PUBLIC_KEY=0xYOUR_ACTUAL_PUBLIC_KEY_HERE
```

### Step 2: Get Your Wallet Keys
1. **Open MetaMask**
2. **Click on your account** (top right)
3. **Click "Account Details"**
4. **Click "Export Private Key"**
5. **Enter your password**
6. **Copy the private key** (starts with 0x...)
7. **Copy your public address** (starts with 0x...)

### Step 3: Fund Your Wallet
1. **Go to Polymarket.com**
2. **Connect your wallet**
3. **Deposit some USDC** (minimum $1-5 for testing)
4. **Make sure it's on Polygon network**

## 🧪 **Running the Test**

### Basic Test
```bash
node test-live-polymarket-trading.js
```

### With Environment Variables
```bash
# Set environment variables
export TEST_PRIVATE_KEY="0xYOUR_PRIVATE_KEY"
export TEST_PUBLIC_KEY="0xYOUR_PUBLIC_KEY"

# Run test
node test-live-polymarket-trading.js
```

## 📊 **What the Test Does**

### Step 1: Authentication
- ✅ Authenticates with our API using wallet signature
- ✅ Creates JWT token for session

### Step 2: Generate Polymarket API Keys
- ✅ Creates L1 authentication signature
- ✅ Calls Polymarket's `/auth/api-key` endpoint
- ✅ Generates API key, secret, and passphrase
- ✅ Stores credentials for order placement

### Step 3: Find Active Market
- ✅ Fetches active markets from Polymarket Gamma API
- ✅ Finds markets accepting orders
- ✅ Gets token IDs for YES/NO positions

### Step 4: Check Order Book
- ✅ Fetches current order book for selected token
- ✅ Analyzes bid/ask prices
- ✅ Calculates optimal order price

### Step 5: Place Minimum Order
- ✅ Creates EIP-712 signature for order
- ✅ Builds order structure
- ✅ Places order via our API
- ✅ Submits to Polymarket with L1 headers

### Step 6: Check Order Status
- ✅ Retrieves order status from our database
- ✅ Shows order details and status

## 💰 **Test Parameters**

The test uses **minimum values** for safety:
- **Order Size**: $0.01 USDC
- **Order Price**: $0.01 (minimum)
- **Order Type**: GTC (Good Till Cancelled)
- **Side**: BUY (purchasing YES tokens)

## 🔍 **Expected Results**

### ✅ **Success Case**
```
🚀 Starting Live Polymarket Trading Test...

🔐 Step 1: Authenticating with our API...
✅ Authentication successful

🔑 Step 2: Generating Polymarket API keys...
✅ Polymarket API keys generated successfully

🔍 Step 3: Finding an active market...
✅ Found active market:
   Market ID: 0x1234...
   Question: Will Bitcoin reach $100k by 2024?
   Volume: 1234567

📊 Step 4: Checking order book...
✅ Order book retrieved:
   Best Bid: 0.45
   Best Ask: 0.55
   Spread: 0.10

📝 Step 5: Placing minimum order...
✅ Order placed successfully!
   Order ID: abc123...
   Venue Order ID: def456...
   Status: submitted

🔍 Step 6: Checking order status...
✅ Order status retrieved:
   Status: live
   Price: 0.46
   Size: 0.01

📊 Live Test Results:
   ✅ Passed: 6
   ❌ Failed: 0
   📈 Success Rate: 100%

🎉 Live trading test completed successfully!
```

### ⚠️ **Common Issues**

#### **"Failed to generate Polymarket API keys"**
- **Cause**: Wallet not connected to Polymarket or insufficient funds
- **Solution**: 
  1. Visit polymarket.com and connect your wallet
  2. Deposit some USDC on Polygon
  3. Try again

#### **"No suitable active markets found"**
- **Cause**: No markets accepting orders
- **Solution**: Wait a few minutes and try again

#### **"Order placement failed"**
- **Cause**: Insufficient balance or market closed
- **Solution**: 
  1. Check your USDC balance
  2. Try a different market
  3. Reduce order size

## 🛡️ **Safety Notes**

### ⚠️ **Important Warnings**
1. **Use a test wallet** - Never use your main wallet
2. **Start small** - Use minimum amounts ($0.01)
3. **Monitor your funds** - Check your balance before/after
4. **Test on Polygon** - Make sure you're on Polygon network
5. **Keep private keys secure** - Never share or commit them

### 🔒 **Security Best Practices**
- ✅ Use environment variables for keys
- ✅ Never commit private keys to git
- ✅ Use a dedicated test wallet
- ✅ Monitor all transactions
- ✅ Test with small amounts first

## 📱 **Verification**

After running the test:

1. **Check Polymarket.com**
   - Log in with your wallet
   - Go to "My Orders"
   - Verify your order appears

2. **Check Your Wallet**
   - Check USDC balance
   - Look for transaction history

3. **Check Our Database**
   - Order should be stored in `orders` table
   - Status should be `submitted` or `live`

## 🎯 **Next Steps**

Once the test passes:

1. **✅ Order Management System** - Fully functional
2. **✅ Real Trading** - Ready for production
3. **🚀 Phase 4** - Real-time Updates & WebSockets
4. **🚀 Phase 5** - Risk Management & Safety Features

## 📞 **Support**

If you encounter issues:

1. **Check the logs** - Look for specific error messages
2. **Verify prerequisites** - Wallet, funds, network
3. **Try smaller amounts** - Reduce order size
4. **Check Polymarket status** - Ensure their API is working

**The system is now ready for live trading!** 🚀

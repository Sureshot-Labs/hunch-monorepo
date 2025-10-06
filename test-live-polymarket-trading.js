#!/usr/bin/env node

// Live Polymarket Trading Test
// This script tests real trading on Polymarket with actual API keys and minimum trades

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { ethers } from 'ethers';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '.env') });

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const POLYMARKET_CLOB_URL = 'https://clob.polymarket.com';

// Test configuration - REPLACE WITH YOUR ACTUAL KEYS
const TEST_CONFIG = {
  // Your wallet keys for testing
  privateKey: process.env.TEST_PRIVATE_KEY || 'YOUR_PRIVATE_KEY_HERE',
  publicKey: process.env.TEST_PUBLIC_KEY || 'YOUR_PUBLIC_KEY_HERE',
  
  // Test parameters
  testAmount: 0.01, // Minimum test amount in USDC
  testPrice: 0.01,   // Minimum price for testing
};

let authToken = '';
let polymarketApiKey = '';
let polymarketApiSecret = '';
let polymarketPassphrase = '';
let testOrderId = '';

async function makeRequest(method, endpoint, data = null, headers = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (data) {
    options.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(url, options);
    const responseData = await response.json();
    
    return {
      status: response.status,
      data: responseData,
      success: response.ok,
    };
  } catch (error) {
    return {
      status: 0,
      data: { error: error.message },
      success: false,
    };
  }
}

async function makePolymarketRequest(method, endpoint, data = null, headers = {}) {
  const url = `${POLYMARKET_CLOB_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (data) {
    options.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(url, options);
    const responseData = await response.json();
    
    return {
      status: response.status,
      data: responseData,
      success: response.ok,
    };
  } catch (error) {
    return {
      status: 0,
      data: { error: error.message },
      success: false,
    };
  }
}

async function authenticate() {
  console.log('🔐 Step 1: Authenticating with our API...');
  
  const nonceResponse = await makeRequest('POST', '/auth/nonce', {
    walletAddress: TEST_CONFIG.publicKey,
  });
  console.log('nonceResponse', nonceResponse);

  if (!nonceResponse.success) {
    console.error('❌ Failed to get nonce:', nonceResponse.data);
    return false;
  }

  console.log('✅ Nonce received');

  const wallet = new ethers.Wallet(TEST_CONFIG.privateKey);
  console.log('wallet', wallet);
  const signature = await wallet.signMessage(nonceResponse.data.message);
  
  const authResponse = await makeRequest('POST', '/auth/verify', {
    walletAddress: TEST_CONFIG.publicKey,
    signature: signature,
    message: nonceResponse.data.message,
  });

  if (!authResponse.success) {
    console.error('❌ Authentication failed:', authResponse.data);
    return false;
  }

  authToken = authResponse.data.session.token;
  console.log('authToken', authToken);
  console.log('✅ Authentication successful');
  
  return true;
}

async function generatePolymarketApiKeys() {
  console.log('\n🔑 Step 2: Generating Polymarket API keys...');
  console.log('ℹ️  Note: Polymarket uses L1 authentication (your wallet private key)');
  console.log('   No separate Polymarket account creation needed!');
  
  // Check if wallet has sufficient balance for gas fees
  console.log('🔍 Checking wallet balance...');
  try {
    const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
    const balance = await provider.getBalance(TEST_CONFIG.publicKey);
    const balanceInMatic = ethers.formatEther(balance);
    console.log(`   Wallet balance: ${balanceInMatic} MATIC/POL`);
    
    if (balance === 0n) {
      console.log('⚠️  Warning: Wallet has 0 MATIC/POL balance');
      console.log('   You need REAL MATIC/POL tokens (not testnet) for Polymarket');
      console.log('   Buy MATIC/POL from exchanges like Coinbase, Binance, etc.');
      console.log('   Or swap ETH for MATIC/POL on Uniswap/PancakeSwap');
      console.log('   Note: MATIC has been rebranded to POL, but both work');
    }
  } catch (error) {
    console.log('⚠️  Could not check wallet balance:', error.message);
  }
  
  const wallet = new ethers.Wallet(TEST_CONFIG.privateKey);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = '125';

  // Create L1 authentication signature for API key generation
  const domain = {
    name: "ClobAuthDomain",
    version: "1",
    chainId: 137, // Polygon Chain ID
  };

  const types = {
    ClobAuth: [
      { name: "address", type: "address" },
      { name: "timestamp", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "message", type: "string" },
    ],
  };

  const value = {
    address: TEST_CONFIG.publicKey,
    timestamp: timestamp,
    nonce: nonce,
    message: "This message attests that I control the given wallet",
  };

  const l1Signature = await wallet.signTypedData(domain, types, value);
  console.log('l1Signature', l1Signature);
  console.log('📝 Creating L1 signature for API key generation...');
  console.log('   Signature:', l1Signature.substring(0, 20) + '...');
  console.log('   Timestamp:', timestamp);
  console.log('   Nonce:', nonce);
  console.log('   Public Key:', TEST_CONFIG.publicKey);
  // Generate API key using Polymarket's API
  const apiKeyResponse = await makePolymarketRequest('POST', '/auth/api-key', {
    // Empty body - Polymarket generates keys based on signature
  }, {
    'POLY_ADDRESS': TEST_CONFIG.publicKey,
    'POLY_SIGNATURE': l1Signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_NONCE': nonce,
  });
  console.log('apiKeyResponse', apiKeyResponse);

  if (!apiKeyResponse.success) {
    console.error('❌ Failed to generate Polymarket API keys:', apiKeyResponse.data);
    console.log('\n💡 Possible solutions:');
    console.log('   1. Ensure your wallet has REAL MATIC/POL tokens (not testnet)');
    console.log('   2. Buy MATIC/POL from exchanges like Coinbase, Binance, etc.');
    console.log('   3. Try visiting https://polymarket.com and connect your wallet');
    console.log('   4. Make sure your wallet is properly configured for Polygon mainnet');
    console.log('   5. Check if your private key is correct');
    console.log('   6. Ensure the wallet address matches the private key');
    console.log('   7. Note: MATIC has been rebranded to POL, but both work');
    return false;
  }

  polymarketApiKey = apiKeyResponse.data.apiKey;
  polymarketApiSecret = apiKeyResponse.data.secret;
  polymarketPassphrase = apiKeyResponse.data.passphrase;

  console.log('✅ Polymarket API keys generated successfully');
  console.log('   API Key:', polymarketApiKey.substring(0, 10) + '...');
  console.log('   Secret:', polymarketApiSecret.substring(0, 10) + '...');
  console.log('   Passphrase:', polymarketPassphrase.substring(0, 10) + '...');
  
  return true;
}

async function findActiveMarket() {
  console.log('\n🔍 Step 3: Finding an active market...');
  
  // Get markets from Polymarket's Gamma API
  const marketsResponse = await fetch('https://gamma-api.polymarket.com/markets?ascending=false&volume_num_min=1000&closed=false&limit=10');
  
  if (!marketsResponse.ok) {
    console.error('❌ Failed to fetch markets');
    return null;
  }

  const marketsData = await marketsResponse.json();
  const markets = marketsData || [];

  // Find a market that's active and accepting orders
  for (const market of markets) {
    if (market.active && market.volume > 0) {
      console.log('✅ Found active market:');
      console.log('   Market ID:', market.id);
      console.log('   Question:', market.question);
      console.log('   Volume:', market.volume);
      console.log('   End Date:', market.endDate);
      
      // Get token IDs for this market
      const tokensResponse = await fetch(`https://gamma-api.polymarket.com/markets/${market.id}`);
      if (tokensResponse.ok) {
        const marketData = await tokensResponse.json();
        console.log('marketData', marketData);
        let tokens = marketData.clobTokenIds || '';
        tokens=JSON.parse(tokens);
        console.log('tokens', tokens);
        if (tokens.length >= 2) {
          console.log('   YES Token ID:', tokens[0]);
          console.log('   NO Token ID:', tokens[1]);
          return {
            marketId: market.id,
            question: market.question,
            yesTokenId: tokens[0],
            noTokenId: tokens[1],
            endDate: market.endDate,
          };
        }
      }
    }
  }

  console.log('❌ No suitable active markets found');
  return null;
}

async function checkMarketOrderBook(tokenId) {
  console.log(`\n📊 Step 4: Checking order book for token ${tokenId.substring(0, 10)}...`);
  
  const orderBookResponse = await makePolymarketRequest('GET', `/book?token_id=${tokenId}`);
  
  if (!orderBookResponse.success) {
    console.error('❌ Failed to fetch order book');
    return null;
  }

  const orderBook = orderBookResponse.data;
  
  console.log('✅ Order book retrieved:');
  console.log('   Best Bid:', orderBook.bids?.[0]?.price || 'No bids');
  console.log('   Best Ask:', orderBook.asks?.[0]?.price || 'No asks');
  console.log('   Spread:', orderBook.spread || 'N/A');
  
  return orderBook;
}

async function placeMinimumOrder(market) {
  console.log('\n📝 Step 5: Placing minimum order...');
  
  // Use the YES token for a small buy order
  const tokenId = market.yesTokenId;
  console.log('tokenId', tokenId);
  
  // Check current order book to find a good price
  const orderBook = await checkMarketOrderBook(tokenId);
  console.log('orderBook', orderBook);
  if (!orderBook) {
    console.log('❌ Cannot place order - no order book data');
    return false;
  }

  // Find a price that's likely to be filled (slightly above best bid)
  const bestBid = orderBook.bids?.[0]?.price;
  const bestAsk = orderBook.asks?.[0]?.price;
  const minOrderSize = orderBook?.min_order_size;
  console.log('minOrderSize', minOrderSize);
  let orderPrice;
  if (bestBid && bestAsk) {
    // Place order between bid and ask
    orderPrice = Math.min(parseFloat(bestBid) + 0.001, parseFloat(bestAsk) - 0.001);
  } else if (bestBid) {
    // Only bids available, place slightly above
    orderPrice = parseFloat(bestBid) + 0.001;
  } else {
    // No orders, use a conservative price
    orderPrice = 0.01;
  }

  // Ensure minimum price
  orderPrice = Math.max(orderPrice, 0.01);
  
  console.log(`📊 Order details:`);
  console.log(`   Token ID: ${tokenId}`);
  console.log(`   Price: ${orderPrice}`);
  console.log(`   Size: ${minOrderSize}`);
  console.log(`   Side: BUY`);

  // Create L1 authentication signature for order placement
  const wallet = new ethers.Wallet(TEST_CONFIG.privateKey);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = '126';

  const domain = {
    name: "ClobAuthDomain",
    version: "1",
    chainId: 137,
  };

  const types = {
    ClobAuth: [
      { name: "address", type: "address" },
      { name: "timestamp", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "message", type: "string" },
    ],
  };

  const value = {
    address: TEST_CONFIG.publicKey,
    timestamp: timestamp,
    nonce: nonce,
    message: "This message attests that I control the given wallet",
  };

  const l1Signature = await wallet.signTypedData(domain, types, value);
  console.log('l1Signature', l1Signature);
  // Place order via our API
  const orderData = {
    venue: 'polymarket',
    tokenId: tokenId,
    side: 'BUY',
    orderType: 'GTC',
    price: orderPrice,
    size: minOrderSize,
    l1Signature: l1Signature,
    l1Timestamp: timestamp,
    l1Nonce: nonce,
  };

  console.log('🚀 Placing order...');
  console.log("polymarketApiKey", polymarketApiKey);
  console.log("polymarketPassphrase", polymarketPassphrase);
  
  // Generate HMAC signature for L2 authentication
  const message = `${timestamp}POST/order${JSON.stringify(orderData)}`;
  const hmacSignature = crypto.createHmac("sha256", polymarketApiSecret)
                            .update(message)
                            .digest("hex");
  
  console.log("TEST_CONFIG.publicKey", TEST_CONFIG.publicKey);
  console.log("timestamp", timestamp);
  console.log("nonce", nonce);
  console.log("l1Signature", l1Signature);
  console.log("hmacSignature", hmacSignature);
  
  const response = await makeRequest('POST', '/orders', orderData, {
    'Authorization': `Bearer ${authToken}`,
    'POLY_ADDRESS': TEST_CONFIG.publicKey,
    'POLY_SIGNATURE': hmacSignature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_API_KEY': polymarketApiKey,
    'POLY_PASSPHRASE': polymarketPassphrase
  });
  console.log('response', response);

  if (!response.success) {
    console.error('❌ Order placement failed:', response.data);
    return false;
  }

  testOrderId = response.data.orderId;
  console.log('✅ Order placed successfully!');
  console.log('   Order ID:', testOrderId);
  console.log('   Venue Order ID:', response.data.venueOrderId);
  console.log('   Status:', response.data.status);
  
  return true;
}

async function checkOrderStatus() {
  if (!testOrderId) {
    console.log('\n⚠️  Step 6: No order ID to check');
    return;
  }

  console.log('\n🔍 Step 6: Checking order status...');
  
  const response = await makeRequest('GET', `/orders/${testOrderId}`, null, {
    'Authorization': `Bearer ${authToken}`,
  });

  if (!response.success) {
    console.error('❌ Failed to get order status:', response.data);
    return;
  }

  const order = response.data.order;
  console.log('✅ Order status retrieved:');
  console.log('   Status:', order.status);
  console.log('   Price:', order.price);
  console.log('   Size:', order.size);
  console.log('   Filled Size:', order.filledSize);
  console.log('   Created At:', order.createdAt);
  console.log('   Updated At:', order.updatedAt);
  
  if (order.venueOrderId) {
    console.log('   Venue Order ID:', order.venueOrderId);
  }
}

async function checkExistingApiKeys() {
    console.log('🔍 Checking for existing API keys...');
    
    const wallet = new ethers.Wallet(TEST_CONFIG.privateKey);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = '1';
  
    const domain = {
      name: "ClobAuthDomain",
      version: "1",
      chainId: 137,
    };
  
    const types = {
      ClobAuth: [
        { name: "address", type: "address" },
        { name: "timestamp", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "message", type: "string" },
      ],
    };
  
    const value = {
      address: TEST_CONFIG.publicKey,
      timestamp: timestamp,
      nonce: nonce,
      message: "This message attests that I control the given wallet",
    };
  
    const l1Signature = await wallet.signTypedData(domain, types, value);
  
    try {
      const response = await fetch('https://clob.polymarket.com/auth/derive-api-key', {
        method: 'GET',
        headers: {
          'POLY_ADDRESS': TEST_CONFIG.publicKey,
          'POLY_SIGNATURE': l1Signature,
          'POLY_TIMESTAMP': timestamp,
          'POLY_NONCE': nonce,
        },
      });
  
      if (response.ok) {
        const keys = await response.json();
        console.log('📋 Existing API keys:', keys.length);
        return keys.length > 0;
      }
    } catch (error) {
      console.log('⚠️  Could not check existing keys:', error.message);
    }
    
    return false;
  }

async function runLiveTest() {
  console.log('🚀 Starting Live Polymarket Trading Test...\n');
  
  // Validate configuration
  if (TEST_CONFIG.privateKey === 'YOUR_PRIVATE_KEY_HERE' || 
      TEST_CONFIG.publicKey === 'YOUR_PUBLIC_KEY_HERE') {
    console.log('❌ Please set your actual private and public keys in TEST_CONFIG');
    console.log('   Or set TEST_PRIVATE_KEY and TEST_PUBLIC_KEY in your .env file');
    return;
  }

  const steps = [
    { name: 'Authentication', fn: authenticate },
    // { name: 'Check Existing API Keys', fn: checkExistingApiKeys },
    { name: 'Generate Polymarket API Keys', fn: generatePolymarketApiKeys },
    { name: 'Find Active Market', fn: findActiveMarket },
    { name: 'Place Minimum Order', fn: placeMinimumOrder },
    // { name: 'Check Order Status', fn: checkOrderStatus },
  ];

  let passed = 0;
  let failed = 0;
  let market = null;

  for (const step of steps) {
    try {
      if (step.name === 'Place Minimum Order') {
        // Pass market data to this step
        const result = await step.fn(market);
        if (result) {
          passed++;
        } else {
          failed++;
        }
      } else if (step.name === 'Find Active Market') {
        market = await step.fn();
        if (market) {
          passed++;
        } else {
          failed++;
        }
      } else {
        const success = await step.fn();
        if (success) {
          passed++;
        } else {
          failed++;
        }
      }
    } catch (error) {
      console.error(`❌ ${step.name} failed with error:`, error.message);
      failed++;
    }
  }

  console.log('\n📊 Live Test Results:');
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📈 Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%`);

  if (failed === 0) {
    console.log('\n🎉 Live trading test completed successfully!');
    console.log('   Your order has been placed on Polymarket');
    console.log('   Check your Polymarket account to see the order');
  } else {
    console.log('\n⚠️  Some steps failed. Please check the errors above.');
  }
}

// Run the live test
runLiveTest().catch(console.error);

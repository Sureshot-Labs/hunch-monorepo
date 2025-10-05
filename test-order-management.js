#!/usr/bin/env node

// Test Order Management APIs
// This script tests the order management endpoints

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { ethers } from 'ethers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '.env') });

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

// Test configuration
const TEST_CONFIG = {
  privateKey: '0x5088ed69009e59eb9013fd17c000977333307c5681d99762205c5a3945f2af78',
  publicKey: '0xb45aFF451DB78b7A63E3AC7a8A7Bf4Ca7aDb9075',
  tokenId: '28238304963115391468520084611709080022027216241044579007402765414035709535435',
  // Note: Polymarket uses L1 authentication (private key) for order placement
  // No separate API key/secret needed - uses wallet private key directly
};

let authToken = '';
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

async function authenticate() {
  console.log('🔐 Step 1: Getting nonce...');
  
  const nonceResponse = await makeRequest('POST', '/auth/nonce', {
    walletAddress: TEST_CONFIG.publicKey,
  });

  if (!nonceResponse.success) {
    console.error('❌ Failed to get nonce:', nonceResponse.data);
    return false;
  }

  console.log('✅ Nonce received:', nonceResponse.data.nonce);

  console.log('\n🔐 Step 2: Signing message...');
  
  // Sign the message with the private key using ethers.js
  // Use ethers from the global scope (assume it's imported at the top for browser/ESM)
  const wallet = new ethers.Wallet(TEST_CONFIG.privateKey);
  const mockSignature = await wallet.signMessage(nonceResponse.data.message);
  
  console.log('✅ Mock signature generated');

  console.log('\n🔐 Step 3: Authenticating...');
  
  const authResponse = await makeRequest('POST', '/auth/verify', {
    walletAddress: TEST_CONFIG.publicKey,
    signature: mockSignature,
    message: nonceResponse.data.message,
  });

  if (!authResponse.success) {
    console.error('❌ Authentication failed:', authResponse.data);
    return false;
  }
 
  authToken = authResponse.data.session.token;
  console.log('✅ Authentication successful');
  console.log('   Token:', authToken.substring(0, 20) + '...');
  
  return true;
}

async function setupPolymarketCredentials() {
  console.log('\n🔑 Step 4: Polymarket authentication setup...');
  
  console.log('ℹ️  Polymarket uses L1 authentication (private key) for order placement');
  console.log('   No separate API key/secret needed - uses wallet private key directly');
  console.log('   Your wallet private key will be used to sign orders');
  
  // Check if user has a wallet connected
  const userResponse = await makeRequest('GET', '/auth/me', null, {
    'Authorization': `Bearer ${authToken}`,
  });

  if (!userResponse.success) {
    console.error('❌ Failed to get user info:', userResponse.data);
    return false;
  }

  console.log('✅ Wallet authentication ready');
  console.log('   Wallet Address:', userResponse.data.currentWallet);
  console.log('   Wallet Type:', userResponse.data.wallets[0]?.walletType || 'ethereum');
  
  return true;
}

async function testPlaceOrder() {
  console.log('\n📝 Step 5: Testing place order...');
  
  // Create L1 authentication signature
  console.log('🔐 Creating L1 authentication signature...');
  const wallet = new ethers.Wallet(TEST_CONFIG.privateKey);
  
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = '0';
  
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
  console.log('✅ L1 signature created');
  
  const orderData = {
    venue: 'polymarket',
    tokenId: TEST_CONFIG.tokenId,
    side: 'BUY',
    orderType: 'GTC',
    price: 0.5,
    size: 10,
    l1Signature: l1Signature,
    l1Timestamp: timestamp,
    l1Nonce: nonce,
  };
console.log('orderData', orderData);  
  const response = await makeRequest('POST', '/orders', orderData, {
    'Authorization': `Bearer ${authToken}`,
  });
console.log('response', response);  
  if (!response.success) {
    console.error('❌ Place order failed:', response.data);
    return false;
  }
console.log('response.data', response.data);  
  testOrderId = response.data.orderId;
  console.log('✅ Order placed successfully');
  console.log('   Order ID:', testOrderId);
  console.log('   Venue Order ID:', response.data.venueOrderId);
  console.log('   Status:', response.data.status);
  
  return true;
}

async function testGetOrders() {
  console.log('\n📋 Step 5: Testing get orders...');
  
  const response = await makeRequest('GET', '/orders', null, {
    'Authorization': `Bearer ${authToken}`,
  });

  if (!response.success) {
    console.error('❌ Get orders failed:', response.data);
    return false;
  }

  console.log('✅ Orders retrieved successfully');
  console.log('   Total orders:', response.data.orders.length);
  
  if (response.data.orders.length > 0) {
    const order = response.data.orders[0];
    console.log('   Sample order:');
    console.log('     ID:', order.id);
    console.log('     Venue:', order.venue);
    console.log('     Token ID:', order.tokenId);
    console.log('     Side:', order.side);
    console.log('     Status:', order.status);
  }
  
  return true;
}

async function testGetOrderById() {
  if (!testOrderId) {
    console.log('\n⚠️  Step 6: Skipping get order by ID (no order ID available)');
    return true;
  }

  console.log('\n🔍 Step 6: Testing get order by ID...');
  
  const response = await makeRequest('GET', `/orders/${testOrderId}`, null, {
    'Authorization': `Bearer ${authToken}`,
  });

  if (!response.success) {
    console.error('❌ Get order by ID failed:', response.data);
    return false;
  }

  console.log('✅ Order retrieved successfully');
  console.log('   Order ID:', response.data.order.id);
  console.log('   Venue:', response.data.order.venue);
  console.log('   Status:', response.data.order.status);
  console.log('   Price:', response.data.order.price);
  console.log('   Size:', response.data.order.size);
  
  return true;
}

async function testGetOrderHistory() {
  console.log('\n📚 Step 7: Testing get order history...');
  
  const response = await makeRequest('GET', '/orders/history?limit=10', null, {
    'Authorization': `Bearer ${authToken}`,
  });

  if (!response.success) {
    console.error('❌ Get order history failed:', response.data);
    return false;
  }

  console.log('✅ Order history retrieved successfully');
  console.log('   Total orders:', response.data.orders.length);
  console.log('   Pagination:', response.data.pagination);
  
  return true;
}

async function testGetPositions() {
  console.log('\n💰 Step 8: Testing get positions...');
  
  const response = await makeRequest('GET', '/positions', null, {
    'Authorization': `Bearer ${authToken}`,
  });

  if (!response.success) {
    console.error('❌ Get positions failed:', response.data);
    return false;
  }

  console.log('✅ Positions retrieved successfully');
  console.log('   Total positions:', response.data.positions.length);
  
  if (response.data.positions.length > 0) {
    const position = response.data.positions[0];
    console.log('   Sample position:');
    console.log('     Token ID:', position.tokenId);
    console.log('     Side:', position.side);
    console.log('     Size:', position.size);
    console.log('     Average Price:', position.averagePrice);
  }
  
  return true;
}

async function testCancelOrder() {
  if (!testOrderId) {
    console.log('\n⚠️  Step 9: Skipping cancel order (no order ID available)');
    return true;
  }

  console.log('\n❌ Step 9: Testing cancel order...');
  
  const response = await makeRequest('DELETE', `/orders/${testOrderId}`, null, {
    'Authorization': `Bearer ${authToken}`,
  });

  if (!response.success) {
    console.error('❌ Cancel order failed:', response.data);
    return false;
  }

  console.log('✅ Order cancelled successfully');
  console.log('   Message:', response.data.message);
  
  return true;
}

async function runTests() {
  console.log('🚀 Starting Order Management API Tests...\n');
  
  // Check if wallet private key is configured
  if (TEST_CONFIG.privateKey === '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef') {
    console.log('⚠️  WARNING: Using default test private key!');
    console.log('   For real trading, use your actual wallet private key.');
    console.log('   See POLYMARKET_CREDENTIALS_GUIDE.md for instructions.\n');
  }
  
  const steps = [
    { name: 'Authentication', fn: authenticate },
    { name: 'Setup Polymarket Credentials', fn: setupPolymarketCredentials },
    { name: 'Place Order', fn: testPlaceOrder },
    // { name: 'Get Orders', fn: testGetOrders },
    // { name: 'Get Order by ID', fn: testGetOrderById },
    // { name: 'Get Order History', fn: testGetOrderHistory },
    // { name: 'Get Positions', fn: testGetPositions },
    // { name: 'Cancel Order', fn: testCancelOrder },
  ];

  let passed = 0;
  let failed = 0;

  for (const step of steps) {
    try {
      const success = await step.fn();
      if (success) {
        passed++;
      } else {
        failed++;
      }
    } catch (error) {
      console.error(`❌ ${step.name} failed with error:`, error.message);
      failed++;
    }
  }

  console.log('\n📊 Test Results:');
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📈 Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%`);

  if (failed === 0) {
    console.log('\n🎉 All tests passed! Order Management APIs are working correctly.');
  } else {
    console.log('\n⚠️  Some tests failed. Please check the implementation.');
  }
}

// Run tests
runTests().catch(console.error);

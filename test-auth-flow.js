#!/usr/bin/env node

import { ethers } from 'ethers';
import crypto from 'node:crypto';

// Configuration
const API_BASE_URL = 'http://localhost:3000';
const WALLET_PRIVATE_KEY = '0x12ee62ec1092342af9a5618b4a5664abe1d82f09f38a8398a0d06846904a1d92';
const WALLET_ADDRESS = '0xbF6AFb528E7e747786D310653Ac5f05AD40a860E';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logStep(step, message) {
  log(`\n${colors.cyan}Step ${step}:${colors.reset} ${colors.bright}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`${colors.green}✅ ${message}${colors.reset}`);
}

function logError(message) {
  log(`${colors.red}❌ ${message}${colors.reset}`);
}

function logInfo(message) {
  log(`${colors.blue}ℹ️  ${message}${colors.reset}`);
}

// Initialize wallet
function initializeWallet() {
  try {
    if (WALLET_PRIVATE_KEY === 'YOUR_PRIVATE_KEY_HERE' || WALLET_ADDRESS === 'YOUR_WALLET_ADDRESS_HERE') {
      throw new Error('Please set WALLET_PRIVATE_KEY and WALLET_ADDRESS environment variables or update the script');
    }

    const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY);
    
    if (wallet.address.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
      throw new Error(`Wallet address mismatch. Expected: ${WALLET_ADDRESS}, Got: ${wallet.address}`);
    }

    logSuccess(`Wallet initialized: ${wallet.address}`);
    return wallet;
  } catch (error) {
    logError(`Failed to initialize wallet: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

// Step 1: Get nonce from API
async function getNonce(walletAddress) {
  logStep(1, 'Getting nonce from API');
  
  try {
    const response = await fetch(`${API_BASE_URL}/auth/nonce`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ walletAddress }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }

    const data = await response.json();
    logSuccess(`Nonce received: ${data.nonce.substring(0, 16)}...`);
    logInfo(`Message to sign: ${data.message}`);
    
    return data;
  } catch (error) {
    logError(`Failed to get nonce: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

// Step 2: Sign message with wallet
function signMessage(wallet, message) {
  logStep(2, 'Signing message with wallet');
  
  try {
    const signature = wallet.signMessageSync(message);
    logSuccess(`Message signed: ${signature.substring(0, 20)}...`);
    return signature;
  } catch (error) {
    logError(`Failed to sign message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

// Step 3: Verify signature and authenticate
async function authenticate(walletAddress, signature, userData) {
  logStep(3, 'Authenticating with API');
  
  try {
    const response = await fetch(`${API_BASE_URL}/auth/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        walletAddress,
        signature,
        userData: userData || {
          email: 'test12345@example.com',
          username: 'testuser12345',
          displayName: 'Test User12345',
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }

    const data = await response.json();
    logSuccess(`Authentication successful!`);
    logInfo(`User ID: ${data.user.id}`);
    logInfo(`Session expires: ${data.session.expiresAt}`);
    
    return data;
  } catch (error) {
    logError(`Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

// Step 4: Test protected endpoints
async function testProtectedEndpoints(token) {
  logStep(4, 'Testing protected endpoints');
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Test /auth/me
  try {
    logInfo('Testing /auth/me...');
    const response = await fetch(`${API_BASE_URL}/auth/me`, { headers });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const userData = await response.json();
    logSuccess(`User profile retrieved: ${userData.user.displayName}`);
  } catch (error) {
    logError(`Failed to get user profile: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Test /auth/wallets
  try {
    logInfo('Testing /auth/wallets...');
    const response = await fetch(`${API_BASE_URL}/auth/wallets`, { headers });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const walletsData = await response.json();
    logSuccess(`Wallets retrieved: ${walletsData.wallets.length} wallet(s)`);
  } catch (error) {
    logError(`Failed to get wallets: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Test /auth/venue-credentials
  try {
    logInfo('Testing /auth/venue-credentials...');
    const response = await fetch(`${API_BASE_URL}/auth/venue-credentials`, { headers });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const credentialsData = await response.json();
    logSuccess(`Venue credentials retrieved: ${credentialsData.credentials.length} credential(s)`);
  } catch (error) {
    logError(`Failed to get venue credentials: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Step 5: Test venue credentials setup
async function testVenueCredentials(token, walletAddress) {
  logStep(5, 'Testing venue credentials setup');
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Test Polymarket credentials
  try {
    logInfo('Setting Polymarket credentials...');
    const response = await fetch(`${API_BASE_URL}/auth/venue-credentials`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        venue: 'polymarket',
        apiKey: 'test-polymarket-api-key',
        apiSecret: 'test-polymarket-api-secret',
      }),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    logSuccess(`Polymarket credentials set: ${data.credentials.id}`);
  } catch (error) {
    logError(`Failed to set Polymarket credentials: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Test Kalshi credentials
  try {
    logInfo('Setting Kalshi credentials...');
    const response = await fetch(`${API_BASE_URL}/auth/venue-credentials`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        venue: 'kalshi',
        apiKey: 'test-kalshi-api-key',
        apiSecret: 'test-kalshi-api-secret',
        additionalData: {
          username: 'test-kalshi-user',
        },
      }),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    logSuccess(`Kalshi credentials set: ${data.credentials.id}`);
  } catch (error) {
    logError(`Failed to set Kalshi credentials: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Step 6: Test logout
async function testLogout(token) {
  logStep(6, 'Testing logout');
  
  try {
    const response = await fetch(`${API_BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    logSuccess(`Logout successful: ${data.message}`);
  } catch (error) {
    logError(`Logout failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Main test function
async function runAuthFlowTest() {
  log(`${colors.bright}${colors.magenta}🚀 Starting Authentication Flow Test${colors.reset}`);
  log(`${colors.yellow}API Base URL: ${API_BASE_URL}${colors.reset}`);
  log(`${colors.yellow}Wallet Address: ${WALLET_ADDRESS}${colors.reset}`);
  
  try {
    // Initialize wallet
    const wallet = initializeWallet();
    
    // Step 1: Get nonce
    const { nonce, message } = await getNonce(WALLET_ADDRESS);
    
    // Step 2: Sign message
    const signature = signMessage(wallet, message);
    
    // Step 3: Authenticate
    const authData = await authenticate(WALLET_ADDRESS, signature);
    const token = authData.session.token;
    
    // Step 4: Test protected endpoints
    await testProtectedEndpoints(token);
    
    // Step 5: Test venue credentials
    await testVenueCredentials(token, WALLET_ADDRESS);
    
    // Step 6: Test logout
    await testLogout(token);
    
    log(`\n${colors.bright}${colors.green}🎉 Authentication Flow Test Completed Successfully!${colors.reset}`);
    
  } catch (error) {
    log(`\n${colors.bright}${colors.red}💥 Test Failed: ${error instanceof Error ? error.message : 'Unknown error'}${colors.reset}`);
    process.exit(1);
  }
}

// Handle command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--private-key':
        process.env.WALLET_PRIVATE_KEY = args[++i];
        break;
      case '--address':
        process.env.WALLET_ADDRESS = args[++i];
        break;
      case '--api-url':
        process.env.API_BASE_URL = args[++i];
        break;
      case '--help':
        console.log(`
Usage: node test-auth-flow.js [options]

Options:
  --private-key <key>    Wallet private key
  --address <address>    Wallet address
  --api-url <url>        API base URL (default: http://localhost:3001)
  --help                 Show this help message

Environment Variables:
  WALLET_PRIVATE_KEY     Wallet private key
  WALLET_ADDRESS         Wallet address
  API_BASE_URL           API base URL

Examples:
  node test-auth-flow.js --private-key 0x123... --address 0x456...
  WALLET_PRIVATE_KEY=0x123... WALLET_ADDRESS=0x456... node test-auth-flow.js
        `);
        process.exit(0);
        break;
    }
  }
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  parseArgs();
  runAuthFlowTest().catch(console.error);
}

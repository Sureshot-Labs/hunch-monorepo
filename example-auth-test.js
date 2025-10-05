#!/usr/bin/env node

// Example usage of the authentication flow test script
// This demonstrates how to test the auth flow with your wallet

import { ethers } from 'ethers';

console.log('🔧 Authentication Flow Test Example');
console.log('=====================================\n');

// Example wallet (DO NOT USE IN PRODUCTION - THIS IS JUST FOR TESTING)
const examplePrivateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const exampleAddress = '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6';

console.log('📝 Example Configuration:');
console.log(`Private Key: ${examplePrivateKey}`);
console.log(`Address: ${exampleAddress}`);
console.log(`API URL: http://localhost:3001\n`);

console.log('🚀 How to run the test:');
console.log('');
console.log('Method 1 - Command line arguments:');
console.log(`node test-auth-flow.js --private-key ${examplePrivateKey} --address ${exampleAddress}`);
console.log('');
console.log('Method 2 - Environment variables:');
console.log(`WALLET_PRIVATE_KEY=${examplePrivateKey} WALLET_ADDRESS=${exampleAddress} node test-auth-flow.js`);
console.log('');
console.log('Method 3 - Using the .env file:');
console.log('1. Edit test-auth.env and add your wallet details');
console.log('2. Run: source test-auth.env && node test-auth-flow.js');
console.log('');

console.log('⚠️  Important Notes:');
console.log('- Replace the example private key with your actual wallet private key');
console.log('- Make sure your API server is running: cd apps/api && npm run dev');
console.log('- Never commit private keys to version control');
console.log('- Use test wallets for development');
console.log('');

console.log('🔍 What the test will do:');
console.log('1. Get nonce from API');
console.log('2. Sign authentication message with your wallet');
console.log('3. Authenticate with the API');
console.log('4. Test protected endpoints');
console.log('5. Set up venue credentials (Polymarket, Kalshi)');
console.log('6. Test logout');
console.log('');

console.log('📊 Expected output:');
console.log('✅ Nonce received');
console.log('✅ Message signed');
console.log('✅ Authentication successful');
console.log('✅ User profile retrieved');
console.log('✅ Wallets retrieved');
console.log('✅ Venue credentials set');
console.log('✅ Logout successful');
console.log('🎉 Authentication Flow Test Completed Successfully!');
console.log('');

console.log('🐛 If you encounter errors:');
console.log('- Check if API server is running on port 3001');
console.log('- Verify your private key and address match');
console.log('- Check database connection');
console.log('- Look at server logs for detailed error messages');
console.log('');

console.log('📚 For more help:');
console.log('node test-auth-flow.js --help');


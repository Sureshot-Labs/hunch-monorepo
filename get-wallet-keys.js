#!/usr/bin/env node

// Wallet Key Helper
// This script helps you safely get your wallet keys for testing

import { ethers } from 'ethers';

console.log('🔑 Wallet Key Helper for Polymarket Testing\n');

console.log('📋 Instructions to get your wallet keys:');
console.log('');
console.log('1. Open MetaMask (or your wallet)');
console.log('2. Click on your account (top right)');
console.log('3. Click "Account Details"');
console.log('4. Click "Export Private Key"');
console.log('5. Enter your password');
console.log('6. Copy the private key (starts with 0x...)');
console.log('7. Copy your public address (starts with 0x...)');
console.log('');

console.log('⚠️  IMPORTANT SAFETY NOTES:');
console.log('');
console.log('✅ DO:');
console.log('   - Use a TEST wallet (not your main wallet)');
console.log('   - Only use small amounts for testing');
console.log('   - Keep private keys secure');
console.log('   - Use environment variables');
console.log('');
console.log('❌ DON\'T:');
console.log('   - Use your main wallet');
console.log('   - Share private keys');
console.log('   - Commit keys to git');
console.log('   - Use large amounts for testing');
console.log('');

console.log('🔧 Configuration:');
console.log('');
console.log('1. Copy test-live-trading.env.example to .env');
console.log('2. Add your keys to .env:');
console.log('   TEST_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE');
console.log('   TEST_PUBLIC_KEY=0xYOUR_PUBLIC_KEY_HERE');
console.log('');

console.log('💰 Funding your wallet:');
console.log('');
console.log('1. Go to polymarket.com');
console.log('2. Connect your wallet');
console.log('3. Deposit some USDC (minimum $1-5)');
console.log('4. Make sure you\'re on Polygon network');
console.log('');

console.log('🧪 Running the test:');
console.log('');
console.log('   node test-live-polymarket-trading.js');
console.log('');

console.log('📚 For detailed instructions, see:');
console.log('   LIVE_TRADING_TEST_GUIDE.md');
console.log('');

// Optional: Generate a test wallet for demonstration
console.log('🔧 Optional: Generate a test wallet (for demonstration only):');
console.log('');

const testWallet = ethers.Wallet.createRandom();
console.log('Test Wallet (DO NOT USE FOR REAL TRADING):');
console.log('Private Key:', testWallet.privateKey);
console.log('Public Key:', testWallet.address);
console.log('');
console.log('⚠️  This is a random test wallet - DO NOT use for real trading!');
console.log('   Only use wallets you control and have funded.');

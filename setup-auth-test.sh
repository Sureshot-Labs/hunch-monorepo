#!/bin/bash

# Auth Flow Test Setup Script
echo "🔧 Setting up Authentication Flow Test..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version 18+ is required. Current version: $(node -v)"
    exit 1
fi

echo "✅ Node.js version: $(node -v)"

# Install ethers if not already installed
if ! npm list ethers &> /dev/null; then
    echo "📦 Installing ethers package..."
    npm install ethers
else
    echo "✅ ethers package already installed"
fi

# Create .env file for test if it doesn't exist
if [ ! -f "test-auth.env" ]; then
    echo "📝 Creating test-auth.env file..."
    cat > test-auth.env << EOF
# Authentication Flow Test Configuration
# Replace these values with your actual wallet details

# Your wallet private key (keep this secure!)
WALLET_PRIVATE_KEY=0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef

# Your wallet address
WALLET_ADDRESS=0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6

# API base URL (default: localhost:3001)
API_BASE_URL=http://localhost:3001
EOF
    echo "✅ Created test-auth.env file"
    echo "⚠️  Please edit test-auth.env and add your actual wallet details!"
else
    echo "✅ test-auth.env file already exists"
fi

echo ""
echo "🚀 Setup complete! Next steps:"
echo ""
echo "1. Edit test-auth.env and add your wallet details:"
echo "   - WALLET_PRIVATE_KEY: Your wallet's private key"
echo "   - WALLET_ADDRESS: Your wallet's address"
echo ""
echo "2. Make sure your API server is running:"
echo "   cd apps/api && npm run dev"
echo ""
echo "3. Run the test:"
echo "   source test-auth.env && node test-auth-flow.js"
echo ""
echo "4. Or run with command line arguments:"
echo "   node test-auth-flow.js --private-key 0x... --address 0x..."
echo ""
echo "5. For help:"
echo "   node test-auth-flow.js --help"
echo ""
echo "⚠️  Security Note: Never commit your private key to version control!"
echo "   The test-auth.env file is already added to .gitignore"


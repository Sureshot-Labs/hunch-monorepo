// Frontend EIP-712 Signature Helper for Polymarket Orders
// This shows how to create the L1 signature on the frontend

import { ethers } from 'ethers';

export interface PolymarketL1AuthData {
  signature: string;
  timestamp: string;
  nonce: string;
}

export class PolymarketSignatureHelper {
  private readonly chainId = 137; // Polygon Chain ID

  /**
   * Create L1 authentication signature for Polymarket
   * This should be called on the frontend with user's wallet
   */
  async createL1Signature(
    walletAddress: string,
    provider: ethers.providers.Provider | ethers.Signer
  ): Promise<PolymarketL1AuthData> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = '0';

    const domain = {
      name: "ClobAuthDomain",
      version: "1",
      chainId: this.chainId,
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
      address: walletAddress,
      timestamp: timestamp,
      nonce: nonce,
      message: "This message attests that I control the given wallet",
    };

    // Sign the typed data
    const signature = await (provider as ethers.Signer).signTypedData(domain, types, value);

    return {
      signature,
      timestamp,
      nonce,
    };
  }

  /**
   * Create order signature for Polymarket order
   * This signs the actual order structure
   */
  async createOrderSignature(
    order: any,
    provider: ethers.providers.Provider | ethers.Signer
  ): Promise<string> {
    const domain = {
      name: "Polymarket",
      version: "1",
      chainId: this.chainId,
    };

    const types = {
      Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "taker", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "expiration", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "feeRateBps", type: "uint256" },
        { name: "side", type: "uint256" },
        { name: "signatureType", type: "uint256" },
      ],
    };

    const signature = await (provider as ethers.Signer).signTypedData(domain, types, order);
    return signature;
  }
}

// Example usage in React/Next.js frontend:
/*
import { useWeb3React } from '@web3-react/core';
import { PolymarketSignatureHelper } from './polymarket-signature-helper';

export function PlaceOrderComponent() {
  const { account, library } = useWeb3React();
  const signatureHelper = new PolymarketSignatureHelper();

  const placeOrder = async (orderData) => {
    try {
      // 1. Create L1 authentication signature
      const l1Auth = await signatureHelper.createL1Signature(account, library.getSigner());
      
      // 2. Create order structure
      const order = {
        tokenId: orderData.tokenId,
        side: orderData.side,
        orderType: orderData.orderType,
        price: orderData.price,
        size: orderData.size,
        expiresAt: orderData.expiresAt,
        // Add L1 authentication data
        l1Signature: l1Auth.signature,
        l1Timestamp: l1Auth.timestamp,
        l1Nonce: l1Auth.nonce,
      };

      // 3. Send to backend
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify(order),
      });

      const result = await response.json();
      
      if (result.success) {
        console.log('Order placed successfully:', result);
      } else {
        console.error('Order placement failed:', result.error);
      }
    } catch (error) {
      console.error('Error placing order:', error);
    }
  };

  return (
    <div>
      <button onClick={() => placeOrder({
        tokenId: '28238304963115391468520084611709080022027216241044579007402765414035709535435',
        side: 'BUY',
        orderType: 'GTC',
        price: 0.5,
        size: 10,
      })}>
        Place Order
      </button>
    </div>
  );
}
*/

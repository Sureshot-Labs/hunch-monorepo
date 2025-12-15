// Polymarket Order Manager Implementation
// Handles all Polymarket-specific order operations

import {
  VenueOrderManager,
  PlaceOrderRequest,
  PlaceOrderResponse,
  CancelOrderResponse,
  GetOrderResponse,
  GetActiveOrdersResponse,
  GetPositionsResponse,
  Order,
  Position,
  OrderStatus,
  PolymarketOrder,
  PolymarketOrderResponse,
  PolymarketOrderStatus,
  VENUE_ERROR_MAPPING,
  VENUE_STATUS_MAPPING,
} from "./order-types.js";
import { AuthService } from "./auth.js";

type HeaderValue = string | string[] | undefined;
type HeaderRecord = Record<string, HeaderValue>;

function isHeaderRecord(value: unknown): value is HeaderRecord {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  return true;
}

function getHeaderValue(
  headers: HeaderRecord,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

function parsePolymarketAuthHeaders(
  headers: unknown,
): { hmacSignature: string; apiKey: string; passphrase: string } | null {
  if (!isHeaderRecord(headers)) return null;

  const hmacSignature =
    getHeaderValue(headers, "hmacsignature") ??
    getHeaderValue(headers, "poly_hmac_signature") ??
    getHeaderValue(headers, "poly-hmac-signature");
  const apiKey =
    getHeaderValue(headers, "apikey") ??
    getHeaderValue(headers, "poly_api_key") ??
    getHeaderValue(headers, "poly-api-key");
  const passphrase =
    getHeaderValue(headers, "passphrase") ??
    getHeaderValue(headers, "poly_passphrase") ??
    getHeaderValue(headers, "poly-passphrase");

  if (!hmacSignature || !apiKey || !passphrase) return null;
  return { hmacSignature, apiKey, passphrase };
}

export class PolymarketOrderManager implements VenueOrderManager {
  venue = "polymarket" as const;
  private readonly clobEndpoint = "https://clob.polymarket.com";
  private readonly chainId = 137; // Polygon

  async placeOrder(
    userId: string,
    walletAddress: string,
    headers: unknown,
    request: PlaceOrderRequest & {
      l1Signature?: string;
      l1Timestamp?: string;
      l1Nonce?: string;
    },
  ): Promise<PlaceOrderResponse> {
    try {
      // Validate order
      const validation = this.validateOrder(request);
      if (!validation.valid) {
        return {
          success: false,
          errorMessage: validation.error,
        };
      }

      // Create the order structure
      const order = await this.createOrderStructure(request, walletAddress);

      const authHeaders = parsePolymarketAuthHeaders(headers);
      if (!authHeaders) {
        return {
          success: false,
          errorMessage:
            "Missing Polymarket auth headers (hmacSignature/apiKey/passphrase)",
        };
      }

      const timestamp = Math.floor(Date.now() / 1000).toString();
      // Submit to Polymarket with L1 and L2 headers
      const response = await this.submitOrderToPolymarket(
        order,
        walletAddress,
        authHeaders.hmacSignature,
        timestamp,
        authHeaders.apiKey,
        authHeaders.passphrase,
      );

      if (response.success) {
        if (!response.orderId) {
          await this.logOrderError(
            userId,
            request,
            "Order placed but no orderId returned from venue",
            response,
          );
          return {
            success: false,
            errorMessage: "Failed to place order. Please try again.",
            rawError: "Missing venue orderId",
          };
        }

        // Store order in our database
        const orderId = await this.storeOrderInDatabase(
          userId,
          request,
          response.orderId,
        );

        return {
          success: true,
          orderId,
          venueOrderId: response.orderId,
          status: "submitted",
        };
      } else {
        // Log error and return user-friendly message
        await this.logOrderError(
          userId,
          request,
          response.errorMsg || "Unknown error",
          response,
        );

        return {
          success: false,
          errorMessage: this.mapVenueError(
            response.errorMsg || "Unknown error",
          ),
          rawError: response.errorMsg,
        };
      }
    } catch (error) {
      console.error("Polymarket placeOrder error:", error);
      await this.logOrderError(
        userId,
        request,
        error instanceof Error ? error.message : "Unknown error",
        error,
      );

      return {
        success: false,
        errorMessage: "Failed to place order. Please try again.",
        rawError: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async cancelOrder(
    userId: string,
    walletAddress: string,
    orderId: string,
  ): Promise<CancelOrderResponse> {
    try {
      // Get order from database
      const order = await this.getOrderFromDatabase(orderId);
      if (!order || order.userId !== userId) {
        return {
          success: false,
          errorMessage: "Order not found or access denied",
        };
      }

      if (!order.venueOrderId) {
        return {
          success: false,
          errorMessage: "Order has not been submitted to venue yet",
        };
      }

      // Get user's Polymarket credentials
      const credentials = await AuthService.getPolymarketCredentials(
        userId,
        walletAddress,
      );
      if (!credentials) {
        return {
          success: false,
          errorMessage: "Polymarket credentials not found",
        };
      }

      // Cancel order on Polymarket
      const response = await this.cancelOrderOnPolymarket(
        order.venueOrderId,
        credentials.apiKey,
      );

      if (response.success) {
        // Update order status in database
        await this.updateOrderStatus(orderId, "cancelled");

        return {
          success: true,
        };
      } else {
        await this.logOrderError(
          userId,
          order,
          response.errorMsg || "Unknown error",
          response,
        );

        return {
          success: false,
          errorMessage: this.mapVenueError(
            response.errorMsg || "Unknown error",
          ),
          rawError: response.errorMsg,
        };
      }
    } catch (error) {
      console.error("Polymarket cancelOrder error:", error);

      return {
        success: false,
        errorMessage: "Failed to cancel order. Please try again.",
        rawError: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async getOrder(
    userId: string,
    walletAddress: string,
    orderId: string,
  ): Promise<GetOrderResponse> {
    try {
      const order = await this.getOrderFromDatabase(orderId);
      if (!order || order.userId !== userId) {
        return {
          success: false,
          errorMessage: "Order not found or access denied",
        };
      }

      // If order has been submitted to venue, fetch latest status
      if (order.venueOrderId) {
        const credentials = await AuthService.getPolymarketCredentials(
          userId,
          walletAddress,
        );
        if (credentials) {
          const venueStatus = await this.getOrderStatusFromPolymarket(
            order.venueOrderId,
            credentials.apiKey,
          );
          if (venueStatus) {
            // Update order with latest venue status
            await this.updateOrderFromVenueStatus(orderId, venueStatus);
            // Refetch updated order
            const updatedOrder = await this.getOrderFromDatabase(orderId);
            if (!updatedOrder) {
              return {
                success: false,
                errorMessage: "Order not found",
              };
            }
            return {
              success: true,
              order: updatedOrder,
            };
          }
        }
      }

      return {
        success: true,
        order,
      };
    } catch (error) {
      console.error("Polymarket getOrder error:", error);

      return {
        success: false,
        errorMessage: "Failed to fetch order details",
      };
    }
  }

  async getActiveOrders(
    userId: string,
    walletAddress: string,
  ): Promise<GetActiveOrdersResponse> {
    try {
      const orders = await this.getActiveOrdersFromDatabase(userId);

      // Update orders with latest venue status
      const credentials = await AuthService.getPolymarketCredentials(
        userId,
        walletAddress,
      );
      if (credentials) {
        for (const order of orders) {
          if (order.venueOrderId) {
            try {
              const venueStatus = await this.getOrderStatusFromPolymarket(
                order.venueOrderId,
                credentials.apiKey,
              );
              if (venueStatus) {
                await this.updateOrderFromVenueStatus(order.id, venueStatus);
              }
            } catch (error) {
              console.warn(
                `Failed to update order ${order.id} status:`,
                error instanceof Error ? error.message : "Unknown error",
              );
            }
          }
        }
      }

      // Refetch updated orders
      const updatedOrders = await this.getActiveOrdersFromDatabase(userId);

      return {
        success: true,
        orders: updatedOrders,
      };
    } catch (error) {
      console.error("Polymarket getActiveOrders error:", error);

      return {
        success: false,
        errorMessage: "Failed to fetch active orders",
        orders: [],
      };
    }
  }

  async getPositions(
    userId: string,
    _walletAddress: string,
  ): Promise<GetPositionsResponse> {
    try {
      // For now, return positions from our database
      // In Phase 4, we'll implement real-time position fetching via WebSocket
      const positions = await this.getPositionsFromDatabase(userId);

      return {
        success: true,
        positions,
      };
    } catch (error) {
      console.error("Polymarket getPositions error:", error);

      return {
        success: false,
        errorMessage: "Failed to fetch positions",
        positions: [],
      };
    }
  }

  validateOrder(request: PlaceOrderRequest): {
    valid: boolean;
    error?: string;
  } {
    if (!request.tokenId) {
      return { valid: false, error: "Token ID is required" };
    }

    if (!request.side || !["BUY", "SELL"].includes(request.side)) {
      return { valid: false, error: "Valid side (BUY/SELL) is required" };
    }

    if (
      !request.orderType ||
      !["GTC", "GTD", "FAK", "FOK"].includes(request.orderType)
    ) {
      return {
        valid: false,
        error: "Valid order type (GTC/GTD/FAK/FOK) is required",
      };
    }

    if (!request.price || request.price <= 0) {
      return { valid: false, error: "Valid price is required" };
    }

    if (!request.size || request.size <= 0) {
      return { valid: false, error: "Valid size is required" };
    }

    if (request.orderType === "GTD" && !request.expiresAt) {
      return {
        valid: false,
        error: "Expiration time is required for GTD orders",
      };
    }

    return { valid: true };
  }

  mapVenueStatus(venueStatus: string): OrderStatus {
    return VENUE_STATUS_MAPPING[venueStatus] || "pending";
  }

  mapVenueError(venueError: string): string {
    return (
      VENUE_ERROR_MAPPING[venueError] ||
      "Order placement failed. Please try again."
    );
  }

  // Private helper methods

  private async createOrderStructure(
    request: PlaceOrderRequest,
    walletAddress: string,
  ): Promise<PolymarketOrder> {
    // Generate a random salt for the order
    const salt = Math.floor(Math.random() * 1000000000);

    // Calculate expiration time (24 hours from now by default)
    const expiration = request.expiresAt
      ? Math.floor(new Date(request.expiresAt).getTime() / 1000)
      : Math.floor(Date.now() / 1000) + 86400; // 24 hours default

    // Calculate maker and taker amounts based on side
    // For BUY orders: maker pays USDC, taker pays tokens
    // For SELL orders: maker pays tokens, taker pays USDC
    const makerAmount =
      request.side === "BUY"
        ? (request.price * request.size).toString()
        : request.size.toString();
    const takerAmount =
      request.side === "BUY"
        ? request.size.toString()
        : (request.price * request.size).toString();

    const order: PolymarketOrder = {
      salt,
      maker: walletAddress,
      signer: walletAddress,
      taker: "0x0000000000000000000000000000000000000000", // Zero address for public orders
      tokenId: request.tokenId,
      makerAmount,
      takerAmount,
      expiration: expiration.toString(),
      nonce: request.l1Nonce || "", // This should be fetched from Polymarket's API
      feeRateBps: "0", // This should be fetched from Polymarket's API
      side: request.side === "BUY" ? 0 : 1,
      signatureType: 0, // Browser wallet signature type
      signature: request.l1Signature || "", // This will be set when the order is signed
    };

    return order;
  }

  private async submitOrderToPolymarket(
    order: PolymarketOrder,
    walletAddress: string,
    hmacSignature: string,
    timestamp: string,
    polymarketApiKey: string,
    polymarketPassphrase: string,
  ): Promise<PolymarketOrderResponse> {
    const response = await fetch(`${this.clobEndpoint}/order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        POLY_ADDRESS: walletAddress,
        POLY_SIGNATURE: hmacSignature, // L2 HMAC signature
        POLY_TIMESTAMP: timestamp,
        POLY_API_KEY: polymarketApiKey,
        POLY_PASSPHRASE: polymarketPassphrase,
      },
      body: JSON.stringify({
        order,
        owner: walletAddress,
        orderType: "GTC",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Polymarket API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    return await response.json();
  }

  private async verifyL1Signature(
    walletAddress: string,
    signature: string,
    timestamp: string,
    nonce: string,
  ): Promise<boolean> {
    try {
      // Import ethers for signature verification
      const { ethers } = await import("ethers");

      const domain = {
        name: "ClobAuthDomain",
        version: "1",
        chainId: this.chainId, // Polygon Chain ID 137
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

      // Recover the address from the signature
      const recoveredAddress = ethers.verifyTypedData(
        domain,
        types,
        value,
        signature,
      );

      // Check if the recovered address matches the wallet address
      return recoveredAddress.toLowerCase() === walletAddress.toLowerCase();
    } catch (error) {
      console.error("Signature verification failed:", error);
      return false;
    }
  }

  private async cancelOrderOnPolymarket(
    venueOrderId: string,
    apiKey: string,
  ): Promise<{ success: boolean; errorMsg?: string }> {
    const response = await fetch(
      `${this.clobEndpoint}/orders/${venueOrderId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        errorMsg: errorData.errorMsg || `HTTP ${response.status}`,
      };
    }

    return { success: true };
  }

  private async getOrderStatusFromPolymarket(
    venueOrderId: string,
    apiKey: string,
  ): Promise<PolymarketOrderStatus | null> {
    try {
      const response = await fetch(
        `${this.clobEndpoint}/orders/${venueOrderId}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        },
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      return {
        orderId: venueOrderId,
        status: data.status,
        filledSize: data.filledSize,
        averageFillPrice: data.averageFillPrice,
      };
    } catch (error) {
      console.warn(
        `Failed to fetch order status for ${venueOrderId}:`,
        error instanceof Error ? error.message : "Unknown error",
      );
      return null;
    }
  }

  // Database operations (these would be implemented with proper database queries)
  private async storeOrderInDatabase(
    _userId: string,
    _request: PlaceOrderRequest,
    _venueOrderId: string,
  ): Promise<string> {
    // TODO: Implement database insertion
    // Return a mock UUID for now
    return "mock-order-id-" + Date.now();
  }

  private async getOrderFromDatabase(_orderId: string): Promise<Order | null> {
    // TODO: Implement database query
    return null;
  }

  private async updateOrderStatus(
    _orderId: string,
    _status: OrderStatus,
  ): Promise<void> {
    // TODO: Implement database update
  }

  private async updateOrderFromVenueStatus(
    _orderId: string,
    _venueStatus: PolymarketOrderStatus,
  ): Promise<void> {
    // TODO: Implement database update
  }

  private async getActiveOrdersFromDatabase(_userId: string): Promise<Order[]> {
    // TODO: Implement database query
    return [];
  }

  private async getPositionsFromDatabase(_userId: string): Promise<Position[]> {
    // TODO: Implement database query
    return [];
  }

  private async logOrderError(
    userId: string,
    context: unknown,
    message: string,
    rawData: unknown,
  ): Promise<void> {
    // TODO: Implement error logging to order_logs table
    console.error("Order error logged:", { userId, context, message, rawData });
  }
}

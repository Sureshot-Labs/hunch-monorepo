# UI Integration Guide

Complete guide for integrating the Hunch platform APIs into your UI application.

## 📋 Table of Contents

1. [Quick Start](#quick-start)
2. [Authentication Setup](#authentication-setup)
3. [API Client Setup](#api-client-setup)
4. [WebSocket Integration](#websocket-integration)
5. [UI Components](#ui-components)
6. [State Management](#state-management)
7. [Error Handling](#error-handling)
8. [Performance Optimization](#performance-optimization)
9. [Testing](#testing)
10. [Deployment](#deployment)

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install axios socket.io-client @tanstack/react-query zustand
# or
yarn add axios socket.io-client @tanstack/react-query zustand
```

### 2. Environment Setup
```bash
# .env.local
NEXT_PUBLIC_API_URL=http://localhost:3000/api
NEXT_PUBLIC_TRADING_URL=http://localhost:3001
NEXT_PUBLIC_ANALYTICS_URL=http://localhost:3003
NEXT_PUBLIC_WEBSOCKET_URL=ws://localhost:3000/ws
```

### 3. Basic API Client
```typescript
// lib/api-client.ts
import axios from 'axios';

const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  timeout: 10000,
});

// Add auth interceptor
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default apiClient;
```

---

## 🔐 Authentication Setup

### 1. Login Component
```typescript
// components/LoginForm.tsx
import { useState } from 'react';
import apiClient from '../lib/api-client';

export default function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    
    try {
      const response = await apiClient.post('/auth/login', {
        email,
        password,
      });
      
      localStorage.setItem('auth_token', response.data.token);
      window.location.reload();
    } catch (error) {
      console.error('Login failed:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        required
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        required
      />
      <button type="submit" disabled={loading}>
        {loading ? 'Logging in...' : 'Login'}
      </button>
    </form>
  );
}
```

### 2. Auth Context
```typescript
// contexts/AuthContext.tsx
import { createContext, useContext, useEffect, useState } from 'react';

interface User {
  id: string;
  email: string;
  username: string;
}

interface AuthContextType {
  user: User | null;
  login: (token: string) => void;
  logout: () => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    if (token) {
      // Verify token and get user info
      fetchUser(token);
    } else {
      setLoading(false);
    }
  }, []);

  const fetchUser = async (token: string) => {
    try {
      const response = await apiClient.get('/auth/me');
      setUser(response.data.user);
    } catch (error) {
      localStorage.removeItem('auth_token');
    } finally {
      setLoading(false);
    }
  };

  const login = (token: string) => {
    localStorage.setItem('auth_token', token);
    fetchUser(token);
  };

  const logout = () => {
    localStorage.removeItem('auth_token');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
```

---

## 🔌 API Client Setup

### 1. Trading API Client
```typescript
// lib/trading-client.ts
import axios from 'axios';

const tradingClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_TRADING_URL,
  timeout: 10000,
});

// Add auth interceptor
tradingClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const tradingApi = {
  // Orders
  createOrder: (data: CreateOrderData) => 
    tradingClient.post('/orders', data),
  
  getOrders: (params?: OrderParams) => 
    tradingClient.get('/orders', { params }),
  
  cancelOrder: (orderId: string) => 
    tradingClient.delete(`/orders/${orderId}`),
  
  // Positions
  getPositions: () => 
    tradingClient.get('/positions'),
  
  // Portfolio
  getPortfolio: () => 
    tradingClient.get('/portfolio'),
  
  // Trades
  getTrades: (params?: TradeParams) => 
    tradingClient.get('/trades', { params }),
};

export interface CreateOrderData {
  venue: 'polymarket' | 'kalshi' | 'limitless';
  tokenId: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  price?: number;
  sizeUsd: number;
  timeInForce: 'GTC' | 'IOC' | 'FOK';
}

export interface OrderParams {
  status?: string;
  venue?: string;
  tokenId?: string;
  limit?: number;
  offset?: number;
}

export interface TradeParams {
  orderId?: string;
  tokenId?: string;
  limit?: number;
  offset?: number;
}
```

### 2. Analytics API Client
```typescript
// lib/analytics-client.ts
import axios from 'axios';

const analyticsClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_ANALYTICS_URL,
  timeout: 10000,
});

export const analyticsApi = {
  // Market Analysis
  analyzeMarket: (tokenId: string, params?: AnalysisParams) => 
    analyticsClient.get(`/analyze/${tokenId}`, { params }),
  
  // Technical Indicators
  getIndicators: (tokenId: string, params?: IndicatorParams) => 
    analyticsClient.get(`/indicators/${tokenId}`, { params }),
  
  // Price History
  getPriceHistory: (tokenId: string, params?: PriceHistoryParams) => 
    analyticsClient.get(`/price-history/${tokenId}`, { params }),
};

export interface AnalysisParams {
  resolution?: '1m' | '5m' | '1h' | '1d' | '1w';
  period?: '1d' | '7d' | '30d' | '90d' | '1y' | 'all';
}

export interface IndicatorParams {
  resolution?: '1m' | '5m' | '1h' | '1d' | '1w';
  period?: '1d' | '7d' | '30d' | '90d' | '1y' | 'all';
}

export interface PriceHistoryParams {
  resolution?: '1m' | '5m' | '1h' | '1d' | '1w';
  start?: string;
  end?: string;
  limit?: number;
}
```

---

## 🔌 WebSocket Integration

### 1. WebSocket Hook
```typescript
// hooks/useWebSocket.ts
import { useEffect, useRef, useState } from 'react';

interface WebSocketMessage {
  type: string;
  data: any;
}

export function useWebSocket(url: string) {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'Connecting' | 'Open' | 'Closing' | 'Closed'>('Closed');
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    const ws = new WebSocket(url);
    
    ws.onopen = () => {
      setConnectionStatus('Open');
      setSocket(ws);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        setLastMessage(message);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      setConnectionStatus('Closed');
      setSocket(null);
      
      // Reconnect after 5 seconds
      reconnectTimeoutRef.current = setTimeout(() => {
        setConnectionStatus('Connecting');
      }, 5000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      ws.close();
    };
  }, [url]);

  const sendMessage = (message: any) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  return {
    socket,
    lastMessage,
    connectionStatus,
    sendMessage,
  };
}
```

### 2. Market Data WebSocket
```typescript
// hooks/useMarketData.ts
import { useEffect, useState } from 'react';
import { useWebSocket } from './useWebSocket';

export function useMarketData(marketId: string) {
  const { lastMessage, sendMessage, connectionStatus } = useWebSocket(
    process.env.NEXT_PUBLIC_WEBSOCKET_URL + '/market-data'
  );
  const [priceData, setPriceData] = useState({
    yesPrice: 0,
    noPrice: 0,
    lastUpdate: null,
  });

  useEffect(() => {
    if (connectionStatus === 'Open') {
      // Subscribe to market updates
      sendMessage({
        type: 'subscribe',
        channels: [`market:${marketId}`, `price:${marketId}`],
      });
    }
  }, [connectionStatus, marketId, sendMessage]);

  useEffect(() => {
    if (lastMessage) {
      switch (lastMessage.type) {
        case 'price_update':
          if (lastMessage.data.marketId === marketId) {
            setPriceData({
              yesPrice: lastMessage.data.yesPrice,
              noPrice: lastMessage.data.noPrice,
              lastUpdate: lastMessage.data.timestamp,
            });
          }
          break;
        case 'trade':
          if (lastMessage.data.marketId === marketId) {
            // Handle trade update
            console.log('New trade:', lastMessage.data);
          }
          break;
      }
    }
  }, [lastMessage, marketId]);

  return {
    priceData,
    connectionStatus,
  };
}
```

---

## 🎨 UI Components

### 1. Market List Component
```typescript
// components/MarketList.tsx
import { useState, useEffect } from 'react';
import apiClient from '../lib/api-client';

interface Market {
  id: string;
  title: string;
  yesPrice: number;
  noPrice: number;
  volume24h: number;
  status: string;
}

export default function MarketList() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    venue: '',
    status: 'active',
    category: '',
  });

  useEffect(() => {
    fetchMarkets();
  }, [filters]);

  const fetchMarkets = async () => {
    try {
      setLoading(true);
      const response = await apiClient.get('/markets', {
        params: filters,
      });
      setMarkets(response.data.markets);
    } catch (error) {
      console.error('Failed to fetch markets:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="market-list">
      <div className="filters">
        <select
          value={filters.venue}
          onChange={(e) => setFilters({ ...filters, venue: e.target.value })}
        >
          <option value="">All Venues</option>
          <option value="polymarket">Polymarket</option>
          <option value="kalshi">Kalshi</option>
          <option value="limitless">Limitless</option>
        </select>
        
        <select
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
        >
          <option value="active">Active</option>
          <option value="closed">Closed</option>
          <option value="settled">Settled</option>
        </select>
      </div>

      {loading ? (
        <div>Loading markets...</div>
      ) : (
        <div className="markets">
          {markets.map((market) => (
            <div key={market.id} className="market-card">
              <h3>{market.title}</h3>
              <div className="prices">
                <span className="yes-price">Yes: {market.yesPrice}</span>
                <span className="no-price">No: {market.noPrice}</span>
              </div>
              <div className="volume">
                24h Volume: {market.volume24h}
              </div>
              <div className="status">
                Status: {market.status}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

### 2. Order Form Component
```typescript
// components/OrderForm.tsx
import { useState } from 'react';
import { tradingApi, CreateOrderData } from '../lib/trading-client';

interface OrderFormProps {
  marketId: string;
  tokenId: string;
  venue: 'polymarket' | 'kalshi' | 'limitless';
}

export default function OrderForm({ marketId, tokenId, venue }: OrderFormProps) {
  const [orderData, setOrderData] = useState<CreateOrderData>({
    venue,
    tokenId,
    side: 'BUY',
    orderType: 'LIMIT',
    price: 0,
    sizeUsd: 0,
    timeInForce: 'GTC',
  });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const response = await tradingApi.createOrder(orderData);
      console.log('Order created:', response.data);
      // Reset form or show success message
    } catch (error) {
      console.error('Failed to create order:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="order-form">
      <div className="form-group">
        <label>Side:</label>
        <select
          value={orderData.side}
          onChange={(e) => setOrderData({ ...orderData, side: e.target.value as 'BUY' | 'SELL' })}
        >
          <option value="BUY">Buy</option>
          <option value="SELL">Sell</option>
        </select>
      </div>

      <div className="form-group">
        <label>Order Type:</label>
        <select
          value={orderData.orderType}
          onChange={(e) => setOrderData({ ...orderData, orderType: e.target.value as 'MARKET' | 'LIMIT' })}
        >
          <option value="LIMIT">Limit</option>
          <option value="MARKET">Market</option>
        </select>
      </div>

      {orderData.orderType === 'LIMIT' && (
        <div className="form-group">
          <label>Price:</label>
          <input
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={orderData.price || ''}
            onChange={(e) => setOrderData({ ...orderData, price: parseFloat(e.target.value) })}
            required
          />
        </div>
      )}

      <div className="form-group">
        <label>Size (USD):</label>
        <input
          type="number"
          step="0.01"
          min="0"
          value={orderData.sizeUsd}
          onChange={(e) => setOrderData({ ...orderData, sizeUsd: parseFloat(e.target.value) })}
          required
        />
      </div>

      <button type="submit" disabled={loading}>
        {loading ? 'Creating Order...' : 'Create Order'}
      </button>
    </form>
  );
}
```

### 3. Price Chart Component
```typescript
// components/PriceChart.tsx
import { useEffect, useState } from 'react';
import { analyticsApi } from '../lib/analytics-client';

interface PriceData {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface PriceChartProps {
  tokenId: string;
  resolution: '1m' | '5m' | '1h' | '1d' | '1w';
  period: '1d' | '7d' | '30d' | '90d' | '1y' | 'all';
}

export default function PriceChart({ tokenId, resolution, period }: PriceChartProps) {
  const [priceData, setPriceData] = useState<PriceData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPriceData();
  }, [tokenId, resolution, period]);

  const fetchPriceData = async () => {
    try {
      setLoading(true);
      const response = await analyticsApi.getPriceHistory(tokenId, {
        resolution,
        period,
      });
      setPriceData(response.data.priceHistory.data);
    } catch (error) {
      console.error('Failed to fetch price data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div>Loading chart...</div>;
  }

  return (
    <div className="price-chart">
      <h3>Price Chart - {resolution} resolution</h3>
      <div className="chart-container">
        {/* Implement your chart library here (e.g., Chart.js, D3.js, etc.) */}
        <div className="chart-placeholder">
          Chart data: {priceData.length} data points
        </div>
      </div>
    </div>
  );
}
```

---

## 🗃️ State Management

### 1. Zustand Store
```typescript
// stores/marketStore.ts
import { create } from 'zustand';

interface Market {
  id: string;
  title: string;
  yesPrice: number;
  noPrice: number;
  volume24h: number;
  status: string;
}

interface MarketStore {
  markets: Market[];
  selectedMarket: Market | null;
  setMarkets: (markets: Market[]) => void;
  setSelectedMarket: (market: Market | null) => void;
  updateMarketPrice: (marketId: string, yesPrice: number, noPrice: number) => void;
}

export const useMarketStore = create<MarketStore>((set) => ({
  markets: [],
  selectedMarket: null,
  setMarkets: (markets) => set({ markets }),
  setSelectedMarket: (selectedMarket) => set({ selectedMarket }),
  updateMarketPrice: (marketId, yesPrice, noPrice) =>
    set((state) => ({
      markets: state.markets.map((market) =>
        market.id === marketId
          ? { ...market, yesPrice, noPrice }
          : market
      ),
    })),
}));
```

### 2. Order Store
```typescript
// stores/orderStore.ts
import { create } from 'zustand';

interface Order {
  id: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  price: number;
  sizeUsd: number;
  status: string;
  createdAt: string;
}

interface OrderStore {
  orders: Order[];
  setOrders: (orders: Order[]) => void;
  addOrder: (order: Order) => void;
  updateOrder: (orderId: string, updates: Partial<Order>) => void;
  removeOrder: (orderId: string) => void;
}

export const useOrderStore = create<OrderStore>((set) => ({
  orders: [],
  setOrders: (orders) => set({ orders }),
  addOrder: (order) =>
    set((state) => ({ orders: [...state.orders, order] })),
  updateOrder: (orderId, updates) =>
    set((state) => ({
      orders: state.orders.map((order) =>
        order.id === orderId ? { ...order, ...updates } : order
      ),
    })),
  removeOrder: (orderId) =>
    set((state) => ({
      orders: state.orders.filter((order) => order.id !== orderId),
    })),
}));
```

---

## ❌ Error Handling

### 1. Error Boundary
```typescript
// components/ErrorBoundary.tsx
import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <h2>Something went wrong.</h2>
          <details style={{ whiteSpace: 'pre-wrap' }}>
            {this.state.error && this.state.error.toString()}
          </details>
        </div>
      );
    }

    return this.props.children;
  }
}
```

### 2. API Error Handler
```typescript
// lib/error-handler.ts
export interface ApiError {
  code: string;
  message: string;
  details?: any[];
  timestamp: string;
  requestId: string;
}

export function handleApiError(error: any): string {
  if (error.response?.data?.error) {
    const apiError: ApiError = error.response.data.error;
    return apiError.message;
  }
  
  if (error.message) {
    return error.message;
  }
  
  return 'An unexpected error occurred';
}

export function isApiError(error: any): error is { response: { data: { error: ApiError } } } {
  return error.response?.data?.error;
}
```

---

## ⚡ Performance Optimization

### 1. React Query Setup
```typescript
// lib/query-client.ts
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      cacheTime: 10 * 60 * 1000, // 10 minutes
      retry: 3,
      refetchOnWindowFocus: false,
    },
  },
});
```

### 2. Market Data Query
```typescript
// hooks/useMarkets.ts
import { useQuery } from '@tanstack/react-query';
import apiClient from '../lib/api-client';

export function useMarkets(filters: MarketFilters) {
  return useQuery({
    queryKey: ['markets', filters],
    queryFn: async () => {
      const response = await apiClient.get('/markets', { params: filters });
      return response.data;
    },
    staleTime: 30 * 1000, // 30 seconds
  });
}
```

### 3. WebSocket Optimization
```typescript
// hooks/useOptimizedWebSocket.ts
import { useCallback, useEffect, useRef } from 'react';

export function useOptimizedWebSocket(url: string) {
  const messageQueue = useRef<any[]>([]);
  const isConnected = useRef(false);

  const processQueue = useCallback(() => {
    if (isConnected.current && messageQueue.current.length > 0) {
      const message = messageQueue.current.shift();
      // Process message
      console.log('Processing message:', message);
    }
  }, []);

  useEffect(() => {
    const ws = new WebSocket(url);
    
    ws.onopen = () => {
      isConnected.current = true;
      processQueue();
    };

    ws.onclose = () => {
      isConnected.current = false;
    };

    return () => {
      ws.close();
    };
  }, [url, processQueue]);

  return {
    queueMessage: (message: any) => {
      messageQueue.current.push(message);
      processQueue();
    },
  };
}
```

---

## 🧪 Testing

### 1. API Mock
```typescript
// __mocks__/api-client.ts
export default {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  interceptors: {
    request: {
      use: jest.fn(),
    },
    response: {
      use: jest.fn(),
    },
  },
};
```

### 2. Component Test
```typescript
// components/__tests__/MarketList.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import MarketList from '../MarketList';

// Mock the API client
jest.mock('../../lib/api-client');

describe('MarketList', () => {
  it('renders markets correctly', async () => {
    const mockMarkets = [
      {
        id: '1',
        title: 'Test Market',
        yesPrice: 0.65,
        noPrice: 0.35,
        volume24h: 1000,
        status: 'active',
      },
    ];

    // Mock API response
    require('../../lib/api-client').default.get.mockResolvedValue({
      data: { markets: mockMarkets },
    });

    render(<MarketList />);

    await waitFor(() => {
      expect(screen.getByText('Test Market')).toBeInTheDocument();
      expect(screen.getByText('Yes: 0.65')).toBeInTheDocument();
      expect(screen.getByText('No: 0.35')).toBeInTheDocument();
    });
  });
});
```

---

## 🚀 Deployment

### 1. Environment Variables
```bash
# Production environment
NEXT_PUBLIC_API_URL=https://api.hunch.com
NEXT_PUBLIC_TRADING_URL=https://trading.hunch.com
NEXT_PUBLIC_ANALYTICS_URL=https://analytics.hunch.com
NEXT_PUBLIC_WEBSOCKET_URL=wss://ws.hunch.com
```

### 2. Build Configuration
```typescript
// next.config.js
module.exports = {
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_TRADING_URL: process.env.NEXT_PUBLIC_TRADING_URL,
    NEXT_PUBLIC_ANALYTICS_URL: process.env.NEXT_PUBLIC_ANALYTICS_URL,
    NEXT_PUBLIC_WEBSOCKET_URL: process.env.NEXT_PUBLIC_WEBSOCKET_URL,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL}/:path*`,
      },
    ];
  },
};
```

### 3. Docker Configuration
```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
```

---

This comprehensive UI integration guide provides everything needed to build a complete frontend application that integrates with the Hunch platform APIs, including authentication, WebSocket connections, state management, error handling, and deployment.

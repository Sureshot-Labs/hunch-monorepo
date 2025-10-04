// Environment configuration for trading engine
import { config } from 'dotenv';
import { resolve } from 'path';
import { z } from 'zod';

// Load environment variables
config({ path: resolve(process.cwd(), '../../.env'), override: true });

// Environment schema validation
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().default('postgresql://hunch:hunch@localhost:5432/hunch'),
  
  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),
  
  // API Keys and Authentication
  POLYMARKET_API_KEY: z.string().optional(),
  KALSHI_API_KEY_PATH: z.string().default('/Users/yashagarwal/Desktop/Code_Dev/Hunch-MonoRepo/kalshiKey.txt'),
  LIMITLESS_API_KEY: z.string().optional(),
  
  // API Base URLs
  POLYMARKET_API_BASE: z.string().default('https://clob.polymarket.com'),
  KALSHI_API_BASE: z.string().default('https://trading-api.kalshi.com'),
  LIMITLESS_API_BASE: z.string().default('https://api.limitless.com'),
  
  // Trading Engine Configuration
  MAX_EXPOSURE_PER_MARKET: z.string().default('10000'),
  MAX_TOTAL_EXPOSURE: z.string().default('50000'),
  MAX_ORDER_SIZE: z.string().default('5000'),
  MIN_ORDER_SIZE: z.string().default('1'),
  
  // Service Configuration
  PORT: z.string().default('3001'),
  ENABLE_HEALTH_CHECK: z.string().default('true'),
  HEALTH_CHECK_PORT: z.string().default('3002'),
  
  // Logging
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.string().default('development'),
});

// Parse and validate environment variables
const env = envSchema.parse(process.env);

// Export validated environment variables
export {
  env,
};

// Helper function to read Kalshi API key from file
export async function getKalshiApiKey(): Promise<string> {
  try {
    const fs = await import('fs/promises');
    const key = await fs.readFile(env.KALSHI_API_KEY_PATH, 'utf-8');
    return key.trim();
  } catch (error) {
    console.error('Failed to read Kalshi API key:', error);
    throw new Error('Kalshi API key file not found or unreadable');
  }
}

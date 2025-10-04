// JWT authentication utilities
import crypto from 'crypto';

export interface JWTPayload {
  userId: string;
  email: string;
  username: string;
  role: 'user' | 'admin';
  iat: number; // Issued at
  exp: number; // Expires at
}

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiry: number; // seconds
  refreshTokenExpiry: number; // seconds
}

/**
 * Generate JWT token (simplified - use jsonwebtoken library in production)
 */
export function generateJWT(
  payload: Omit<JWTPayload, 'iat' | 'exp'>,
  secret: string,
  expirySeconds: number = 3600
): string {
  const now = Math.floor(Date.now() / 1000);
  
  const fullPayload: JWTPayload = {
    ...payload,
    iat: now,
    exp: now + expirySeconds,
  };

  // In production, use a proper JWT library like 'jsonwebtoken'
  // This is a simplified version for demonstration
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadEncoded = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payloadEncoded}`)
    .digest('base64url');

  return `${header}.${payloadEncoded}.${signature}`;
}

/**
 * Verify JWT token
 */
export function verifyJWT(token: string, secret: string): JWTPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [header, payload, signature] = parts;

    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    if (signature !== expectedSignature) {
      return null;
    }

    // Decode payload
    const decoded: JWTPayload = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf-8')
    );

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp < now) {
      return null; // Token expired
    }

    return decoded;
  } catch (error) {
    return null;
  }
}

/**
 * Extract token from Authorization header
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }
  
  return parts[1];
}

/**
 * Hash password (use bcrypt in production)
 */
export function hashPassword(password: string): string {
  // In production, use bcrypt or argon2
  // This is simplified for demonstration
  return crypto
    .createHash('sha256')
    .update(password + 'salt-should-be-random')
    .digest('hex');
}

/**
 * Verify password
 */
export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

/**
 * Generate refresh token
 */
export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Check if user has required role
 */
export function hasRole(user: JWTPayload, requiredRole: 'user' | 'admin'): boolean {
  if (requiredRole === 'admin') {
    return user.role === 'admin';
  }
  return true; // 'user' role is always allowed
}

/**
 * Create auth error
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public code: 'MISSING_TOKEN' | 'INVALID_TOKEN' | 'EXPIRED_TOKEN' | 'INSUFFICIENT_PERMISSIONS' = 'INVALID_TOKEN'
  ) {
    super(message);
    this.name = 'AuthError';
  }
}


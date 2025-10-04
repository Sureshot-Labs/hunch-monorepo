// Authentication middleware for Fastify
import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyJWT, extractBearerToken, AuthError, JWTPayload, hasRole } from '@hunch/shared';

// Extend Fastify request type to include user
declare module 'fastify' {
  interface FastifyRequest {
    user?: JWTPayload;
  }
}

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production-use-env-var';

/**
 * Authentication middleware
 * Verifies JWT token and attaches user to request
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const token = extractBearerToken(request.headers.authorization);
    
    if (!token) {
      throw new AuthError('Missing authorization token', 'MISSING_TOKEN');
    }

    const payload = verifyJWT(token, JWT_SECRET);
    
    if (!payload) {
      throw new AuthError('Invalid or expired token', 'INVALID_TOKEN');
    }

    // Attach user to request
    request.user = payload;
  } catch (error) {
    if (error instanceof AuthError) {
      return reply.code(401).send({
        success: false,
        error: error.message,
        code: error.code,
      });
    }
    
    return reply.code(500).send({
      success: false,
      error: 'Authentication failed',
    });
  }
}

/**
 * Admin-only middleware
 * Requires authentication + admin role
 */
export async function adminMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await authMiddleware(request, reply);
  
  if (!request.user) {
    // Auth middleware already sent error
    return;
  }

  if (!hasRole(request.user, 'admin')) {
    return reply.code(403).send({
      success: false,
      error: 'Insufficient permissions. Admin role required.',
      code: 'INSUFFICIENT_PERMISSIONS',
    });
  }
}

/**
 * Optional authentication middleware
 * Attaches user if token is valid, but doesn't require it
 */
export async function optionalAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const token = extractBearerToken(request.headers.authorization);
    
    if (token) {
      const payload = verifyJWT(token, JWT_SECRET);
      if (payload) {
        request.user = payload;
      }
    }
  } catch (error) {
    // Silently ignore auth errors for optional auth
  }
}


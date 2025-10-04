// Authentication routes (login, register, etc.)
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../db';
import { generateJWT, hashPassword, verifyPassword } from '@hunch/shared';

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production-use-env-var';
const JWT_EXPIRY = parseInt(process.env.JWT_EXPIRY || '3600'); // 1 hour default

// Validation schemas
const LoginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const RegisterSchema = z.object({
  email: z.string().email('Invalid email format'),
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores, and hyphens'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
});

/**
 * Register authentication routes
 */
export async function registerAuthRoutes(app: FastifyInstance) {
  
  // POST /auth/register - Register new user
  app.post('/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const validation = RegisterSchema.safeParse(request.body);
      
      if (!validation.success) {
        return reply.code(400).send({
          success: false,
          error: 'Validation failed',
          details: validation.error.issues,
        });
      }

      const { email, username, password, firstName, lastName } = validation.data;

      // Check if user already exists
      const existingUser = await pool.query(
        'SELECT id FROM users WHERE email = $1 OR username = $2',
        [email, username]
      );

      if (existingUser.rows.length > 0) {
        return reply.code(409).send({
          success: false,
          error: 'User with this email or username already exists',
        });
      }

      // Hash password
      const passwordHash = hashPassword(password);

      // Create user
      const result = await pool.query(
        `INSERT INTO users (email, username, password_hash, first_name, last_name, role)
         VALUES ($1, $2, $3, $4, $5, 'user')
         RETURNING id, email, username, role, created_at`,
        [email, username, passwordHash, firstName, lastName]
      );

      const user = result.rows[0];

      // Generate JWT token
      const token = generateJWT(
        {
          userId: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
        },
        JWT_SECRET,
        JWT_EXPIRY
      );

      return reply.code(201).send({
        success: true,
        message: 'User registered successfully',
        data: {
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            role: user.role,
            createdAt: user.created_at,
          },
          token,
          expiresIn: JWT_EXPIRY,
        },
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // POST /auth/login - Login user
  app.post('/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const validation = LoginSchema.safeParse(request.body);
      
      if (!validation.success) {
        return reply.code(400).send({
          success: false,
          error: 'Validation failed',
          details: validation.error.issues,
        });
      }

      const { email, password } = validation.data;

      // Find user
      const result = await pool.query(
        'SELECT id, email, username, password_hash, role, is_active FROM users WHERE email = $1',
        [email]
      );

      if (result.rows.length === 0) {
        return reply.code(401).send({
          success: false,
          error: 'Invalid email or password',
        });
      }

      const user = result.rows[0];

      // Check if user is active
      if (!user.is_active) {
        return reply.code(403).send({
          success: false,
          error: 'Account is disabled',
        });
      }

      // Verify password
      if (!verifyPassword(password, user.password_hash)) {
        return reply.code(401).send({
          success: false,
          error: 'Invalid email or password',
        });
      }

      // Generate JWT token
      const token = generateJWT(
        {
          userId: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
        },
        JWT_SECRET,
        JWT_EXPIRY
      );

      return reply.send({
        success: true,
        message: 'Login successful',
        data: {
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            role: user.role,
          },
          token,
          expiresIn: JWT_EXPIRY,
        },
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // GET /auth/me - Get current user
  app.get('/auth/me', {
    onRequest: [async (request, reply) => {
      const { authMiddleware } = await import('../middleware/auth');
      await authMiddleware(request, reply);
    }],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({
        success: false,
        error: 'Not authenticated',
      });
    }

    // Get full user details from database
    const result = await pool.query(
      'SELECT id, email, username, first_name, last_name, role, created_at FROM users WHERE id = $1',
      [request.user.userId]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({
        success: false,
        error: 'User not found',
      });
    }

    return reply.send({
      success: true,
      data: {
        user: result.rows[0],
      },
    });
  });

  // POST /auth/refresh - Refresh JWT token
  app.post('/auth/refresh', {
    onRequest: [async (request, reply) => {
      const { authMiddleware } = await import('../middleware/auth');
      await authMiddleware(request, reply);
    }],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({
        success: false,
        error: 'Not authenticated',
      });
    }

    // Generate new token
    const token = generateJWT(
      {
        userId: request.user.userId,
        email: request.user.email,
        username: request.user.username,
        role: request.user.role,
      },
      JWT_SECRET,
      JWT_EXPIRY
    );

    return reply.send({
      success: true,
      data: {
        token,
        expiresIn: JWT_EXPIRY,
      },
    });
  });
}


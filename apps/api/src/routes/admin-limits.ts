// Admin API routes for user limit management
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../db';
import { createExposureTracker } from '@hunch/shared';

const exposureTracker = createExposureTracker(pool);

// Zod schemas
const UpdateUserLimitsSchema = z.object({
  userId: z.string().uuid(),
  coolingOffEnabled: z.boolean().optional(),
  coolingOffLimitUsd: z.number().positive().optional(),
  dailyLimitUsd: z.number().positive().optional(),
  maxSingleOrderUsd: z.number().positive().optional(),
  limitsDisabled: z.boolean().optional(),
  updatedBy: z.string().min(1),
  reason: z.string().optional(),
});

const GetUserExposureSchema = z.object({
  userId: z.string().uuid(),
});

/**
 * Register admin routes for user limit management
 */
export async function registerAdminLimitRoutes(app: FastifyInstance) {
  
  // Get user exposure summary
  app.get('/admin/users/:userId/exposure', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { userId: string };
      const validation = GetUserExposureSchema.safeParse({ userId: params.userId });

      if (!validation.success) {
        return reply.code(400).send({
          success: false,
          error: 'Invalid user ID',
          details: validation.error.issues,
        });
      }

      const exposure = await exposureTracker.getUserExposure(validation.data.userId);

      return reply.send({
        success: true,
        data: exposure,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Get user limits configuration
  app.get('/admin/users/:userId/limits', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { userId: string };
      const limits = await exposureTracker.getUserLimits(params.userId);

      return reply.send({
        success: true,
        data: limits,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Update user limits
  app.post('/admin/users/limits', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const validation = UpdateUserLimitsSchema.safeParse(request.body);

      if (!validation.success) {
        return reply.code(400).send({
          success: false,
          error: 'Validation failed',
          details: validation.error.issues,
        });
      }

      const { userId, updatedBy, reason, ...updates } = validation.data;

      await exposureTracker.updateUserLimits(userId, updates, updatedBy, reason);

      const updatedLimits = await exposureTracker.getUserLimits(userId);

      return reply.send({
        success: true,
        message: 'User limits updated successfully',
        data: updatedLimits,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Get users approaching limits
  app.get('/admin/users/approaching-limits', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const users = await exposureTracker.getUsersApproachingLimits();

      return reply.send({
        success: true,
        data: users,
        count: users.length,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Reset daily exposure (manual trigger, also runs via cron)
  app.post('/admin/exposure/reset-daily', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const resetCount = await exposureTracker.resetDailyExposure();

      return reply.send({
        success: true,
        message: `Reset daily exposure for ${resetCount} users`,
        count: resetCount,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Check if specific order would exceed limits (preview)
  app.post('/admin/users/:userId/check-order', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { userId: string };
      const body = request.body as { orderSizeUsd: number };

      if (!body.orderSizeUsd || body.orderSizeUsd <= 0) {
        return reply.code(400).send({
          success: false,
          error: 'Invalid order size',
        });
      }

      const check = await exposureTracker.checkOrderLimits(params.userId, body.orderSizeUsd);

      return reply.send({
        success: true,
        data: check,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
}


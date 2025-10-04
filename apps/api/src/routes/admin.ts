// Admin API routes for trading controls and emergency stop
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../db';
import { getRedis } from '../redis';
import { EmergencyStopService } from '@hunch/shared';

let emergencyStop: EmergencyStopService | null = null;

async function getEmergencyStopService() {
  if (!emergencyStop) {
    const redis = await getRedis();
    emergencyStop = new EmergencyStopService(redis, pool);
  }
  return emergencyStop;
}

// Zod schemas for validation
const EmergencyStopSchema = z.object({
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
  venueId: z.number().optional(),
  disabledBy: z.string().min(1, 'DisabledBy is required'),
});

const ResumeTradingSchema = z.object({
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
  venueId: z.number().optional(),
  enabledBy: z.string().min(1, 'EnabledBy is required'),
});

/**
 * Register admin routes
 * All routes require admin authentication
 */
export async function registerAdminRoutes(app: FastifyInstance) {
  
  // Import auth middleware
  const { adminMiddleware } = await import('../middleware/auth');
  
  // Get trading status
  app.get('/admin/trading/status', {
    onRequest: [adminMiddleware],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as { venueId?: string };
      const venueId = query.venueId ? parseInt(query.venueId) : undefined;
      
      const service = await getEmergencyStopService();
      const status = await service.getTradingStatus(venueId);
      
      return reply.send({
        success: true,
        data: status,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Emergency stop - disable trading
  app.post('/admin/trading/emergency-stop', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const validation = EmergencyStopSchema.safeParse(request.body);
      
      if (!validation.success) {
        return reply.code(400).send({
          success: false,
          error: 'Validation failed',
          details: validation.error.issues,
        });
      }

      const { reason, venueId, disabledBy } = validation.data;
      
      const service = await getEmergencyStopService();
      await service.emergencyStop({ reason, venueId, disabledBy });
      
      return reply.send({
        success: true,
        message: `Trading disabled ${venueId !== undefined ? `for venue ${venueId}` : 'globally'}`,
        data: {
          tradingEnabled: false,
          reason,
          disabledBy,
          venueId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Resume trading - enable trading
  app.post('/admin/trading/resume', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const validation = ResumeTradingSchema.safeParse(request.body);
      
      if (!validation.success) {
        return reply.code(400).send({
          success: false,
          error: 'Validation failed',
          details: validation.error.issues,
        });
      }

      const { reason, venueId, enabledBy } = validation.data;
      
      const service = await getEmergencyStopService();
      await service.resumeTrading({ reason, venueId, enabledBy });
      
      return reply.send({
        success: true,
        message: `Trading enabled ${venueId !== undefined ? `for venue ${venueId}` : 'globally'}`,
        data: {
          tradingEnabled: true,
          reason,
          enabledBy,
          venueId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Get audit log
  app.get('/admin/trading/audit-log', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as { venueId?: string; limit?: string };
      const venueId = query.venueId ? parseInt(query.venueId) : undefined;
      const limit = query.limit ? parseInt(query.limit) : 100;
      
      const service = await getEmergencyStopService();
      const auditLog = await service.getAuditLog({ venueId, limit });
      
      return reply.send({
        success: true,
        data: auditLog,
        count: auditLog.length,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Health check for trading system
  app.get('/admin/trading/health', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const service = await getEmergencyStopService();
      
      // Check global and all venues
      const globalStatus = await service.getTradingStatus();
      
      // Get all venues
      const venuesResult = await pool.query('SELECT id, name FROM venues WHERE is_active = TRUE');
      const venues = await Promise.all(
        venuesResult.rows.map(async (venue) => {
          const status = await service.getTradingStatus(venue.id);
          return {
            id: venue.id,
            name: venue.name,
            tradingEnabled: status.tradingEnabled,
            reason: status.reason,
          };
        })
      );

      return reply.send({
        success: true,
        data: {
          global: globalStatus,
          venues,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Force cache refresh
  app.post('/admin/trading/refresh-cache', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as { venueId?: number };
      const venueId = body.venueId;
      
      const service = await getEmergencyStopService();
      await service.refreshCache(venueId);
      
      return reply.send({
        success: true,
        message: 'Cache refreshed successfully',
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
}


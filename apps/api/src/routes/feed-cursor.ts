// Cursor-based feed endpoint (improved pagination)
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { pool } from '../db';
import { getRedis } from '../redis';
import {
  normalizePaginationParams,
  buildCursorWhereClause,
  createPaginationResponse,
} from '@hunch/shared';

// Zod schema for feed query validation
const FeedQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(500).default(50),
  cursor: z.string().optional(),
  min_volume24hr: z.coerce.number().min(0).optional(),
  min_liquidity: z.coerce.number().min(0).optional(),
  venue: z.enum(['polymarket', 'kalshi', 'limitless']).optional(),
  category: z.string().max(100).optional(),
  filter: z.enum(['newest', 'endingsoon', 'active', 'popular']).optional(),
  sort: z.enum(['totalvol', 'liquidity', 'newest', 'endingsoon', 'starttime']).default('starttime'),
});

export async function registerFeedCursorRoutes(app: FastifyInstance) {
  
  /**
   * GET /feed/v2 - Cursor-based pagination (recommended)
   * 
   * Query params:
   * - limit: number (1-500, default 50)
   * - cursor: string (base64 encoded)
   * - min_volume24hr: number
   * - min_liquidity: number
   * - venue: polymarket | kalshi | limitless
   * - category: string
   * - filter: newest | endingsoon | active | popular
   * - sort: totalvol | liquidity | newest | endingsoon | starttime
   */
  app.get('/feed/v2', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      // Validate query params
      const validation = FeedQuerySchema.safeParse(req.query);
      
      if (!validation.success) {
        return reply.code(400).send({
          success: false,
          error: 'Invalid query parameters',
          details: validation.error.issues,
        });
      }

      const q = validation.data;
      
      // Normalize pagination params
      const { limit, cursor } = normalizePaginationParams({
        limit: q.limit,
        cursor: q.cursor,
        maxLimit: 500,
        defaultLimit: 50,
      });

      const minVol = q.min_volume24hr ?? 1e-9;
      const minLiquidity = q.min_liquidity ?? 0;

      // Build cache key
      const cacheKey = `feed:v7:cursor:${limit}:${q.cursor || 'null'}:${minVol}:${minLiquidity}:${q.venue ?? ''}:${q.category ?? ''}:${q.filter ?? ''}:${q.sort}`;
      const redis = await getRedis();

      // Check cache
      if (redis) {
        const cachedBody = await redis.get(cacheKey);
        if (cachedBody) {
          const etag = `W/"${crypto.createHash('sha1').update(cachedBody).digest('hex')}"`;
          
          if (req.headers['if-none-match'] === etag) {
            reply.header('ETag', etag);
            reply.code(304);
            return reply.send();
          }
          
          reply.header('x-cache', 'hit');
          reply.header('ETag', etag);
          reply.header('Cache-Control', 'private, max-age=2, stale-while-revalidate=30');
          reply.header('Content-Type', 'application/json; charset=utf-8');
          return reply.send(cachedBody);
        }
      }

      // Build WHERE clauses
      const eventParams: any[] = [];
      const eventWhere: string[] = [];
      let paramIdx = 1;

      // Add cursor condition
      if (cursor) {
        const { where, params } = buildCursorWhereClause(cursor, 'e.start_time', 'e.id');
        if (where) {
          eventWhere.push(where);
          eventParams.push(...params);
          paramIdx += params.length;
        }
      }

      // Venue filter
      if (q.venue) {
        eventParams.push(q.venue);
        eventWhere.push(`lower(v.name) = $${paramIdx++}`);
      }

      // Category filter
      if (q.category) {
        eventParams.push(q.category);
        eventWhere.push(`e.category = $${paramIdx++}`);
      }

      // Filter conditions
      if (q.filter === 'newest') {
        eventWhere.push(`e.start_time >= now() - interval '7 days'`);
      } else if (q.filter === 'endingsoon') {
        eventWhere.push(`e.end_time <= now() + interval '7 days'`);
      } else if (q.filter === 'active') {
        eventWhere.push(`e.active = TRUE AND e.closed = FALSE`);
      } else if (q.filter === 'popular') {
        eventWhere.push(`e.volume24hr > 1000`);
      }

      // Sort order
      let orderClause = '';
      switch (q.sort) {
        case 'totalvol':
          orderClause = 'e.volume_total DESC NULLS LAST, e.id';
          break;
        case 'liquidity':
          orderClause = 'e.liquidity DESC NULLS LAST, e.id';
          break;
        case 'newest':
          orderClause = 'e.created_at DESC NULLS LAST, e.id';
          break;
        case 'endingsoon':
          orderClause = 'e.end_time ASC NULLS LAST, e.id';
          break;
        case 'starttime':
        default:
          orderClause = 'e.start_time DESC NULLS LAST, e.id';
          break;
      }

      // Query events with aggregated volume/liquidity
      const eventSql = `
        SELECT
          e.id,
          e.start_time,
          e.end_time,
          e.created_at,
          SUM(COALESCE(m.volume24hr, 0)) AS total_volume,
          SUM(COALESCE(m.liquidity, 0)) AS total_liquidity
        FROM events e
        JOIN markets m ON m.event_id = e.id
        ${q.venue ? 'JOIN venues v ON v.id = e.venue_id' : ''}
        ${eventWhere.length ? 'WHERE ' + eventWhere.join(' AND ') : ''}
        GROUP BY e.id, e.start_time, e.end_time, e.created_at
        HAVING SUM(COALESCE(m.volume24hr, 0)) >= $${paramIdx++}
          AND SUM(COALESCE(m.liquidity, 0)) >= $${paramIdx++}
        ORDER BY ${orderClause}
        LIMIT $${paramIdx}
      `;
      
      eventParams.push(minVol, minLiquidity, limit);

      const { rows: eventRows } = await pool.query(eventSql, eventParams);
      const eventIds = eventRows.map(r => r.id);

      if (eventIds.length === 0) {
        const payload = {
          success: true,
          data: [],
          pagination: {
            nextCursor: null,
            hasMore: false,
            limit,
          },
        };
        
        const body = JSON.stringify(payload);
        const etag = `W/"${crypto.createHash('sha1').update(body).digest('hex')}"`;
        
        reply.header('ETag', etag);
        reply.header('Content-Type', 'application/json; charset=utf-8');
        return reply.send(body);
      }

      // Fetch full event and market data
      const marketSql = `
        SELECT
          e.id AS event_id,
          e.title AS event_title,
          e.category,
          e.start_time,
          e.end_time,
          e.created_at,
          e.liquidity AS event_liquidity,
          e.volume_total AS event_volume,
          m.id AS market_uuid,
          v.name AS venue,
          m.market_id,
          m.title AS market_title,
          m.volume24hr,
          m.liquidity,
          m.accepting_orders,
          m.clob_token_yes,
          m.clob_token_no,
          ly.best_bid AS yes_bid,
          ly.best_ask AS yes_ask,
          ln.best_bid AS no_bid,
          ln.best_ask AS no_ask,
          GREATEST(COALESCE(ly.ts, '-infinity'), COALESCE(ln.ts, '-infinity')) AS last_update
        FROM events e
        JOIN markets m ON m.event_id = e.id
        JOIN venues v ON v.id = m.venue_id
        LEFT JOIN (
          SELECT DISTINCT ON (bt.token_id)
            bt.token_id, bt.best_bid, bt.best_ask, bt.ts
          FROM book_top bt
          ORDER BY bt.token_id, bt.ts DESC
        ) ly ON ly.token_id = m.clob_token_yes
        LEFT JOIN (
          SELECT DISTINCT ON (bt.token_id)
            bt.token_id, bt.best_bid, bt.best_ask, bt.ts
          FROM book_top bt
          ORDER BY bt.token_id, bt.ts DESC
        ) ln ON ln.token_id = m.clob_token_no
        WHERE m.event_id = ANY($1::uuid[])
          AND COALESCE(m.volume24hr, 0) >= $2
          AND COALESCE(m.liquidity, 0) >= $3
          AND m.enable_orderbook = TRUE
        ORDER BY ${orderClause}
      `;

      const { rows } = await pool.query(marketSql, [eventIds, minVol, minLiquidity]);

      // Group markets under events
      const eventMap: Record<string, any> = {};
      for (const r of rows) {
        const eid = r.event_id;
        if (!eventMap[eid]) {
          eventMap[eid] = {
            eventId: eid,
            eventTitle: r.event_title,
            category: r.category,
            startTime: r.start_time,
            endTime: r.end_time,
            createdAt: r.created_at,
            eventLiquidity: r.event_liquidity != null ? Number(r.event_liquidity) : 0,
            eventVolume: r.event_volume != null ? Number(r.event_volume) : 0,
            markets: [],
          };
        }
        
        eventMap[eid].markets.push({
          venue: r.venue,
          marketId: r.market_id,
          marketTitle: r.market_title,
          volume24h: r.volume24hr != null ? Number(r.volume24hr) : 0,
          liquidity: r.liquidity != null ? Number(r.liquidity) : 0,
          acceptingOrders: r.accepting_orders,
          tokens: { yes: r.clob_token_yes, no: r.clob_token_no },
          top: {
            yesBid: r.yes_bid != null ? Number(r.yes_bid) : null,
            yesAsk: r.yes_ask != null ? Number(r.yes_ask) : null,
            noBid: r.no_bid != null ? Number(r.no_bid) : null,
            noAsk: r.no_ask != null ? Number(r.no_ask) : null,
          },
          lastUpdate: r.last_update,
        });
      }

      const data = eventIds.map(eid => eventMap[eid] || {
        eventId: eid,
        markets: [],
      });

      // Create paginated response
      const response = createPaginationResponse(data, limit, 'createdAt');

      const payload = {
        success: true,
        ...response,
      };

      // Serialize and cache
      const body = JSON.stringify(payload);
      const etag = `W/"${crypto.createHash('sha1').update(body).digest('hex')}"`;

      if (redis) {
        await redis.set(cacheKey, body, { EX: 2 }); // 2 second TTL
        reply.header('x-cache', 'miss');
      }

      reply.header('ETag', etag);
      reply.header('Cache-Control', 'private, max-age=2, stale-while-revalidate=30');
      reply.header('Content-Type', 'application/json; charset=utf-8');
      return reply.send(body);

    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
}


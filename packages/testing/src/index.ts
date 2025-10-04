// Testing package exports
export * from './test-utils';
export * from './test-containers';

// Re-export common testing utilities
export { v4 as uuid } from 'uuid';
export { Pool } from 'pg';
export { createClient, RedisClientType } from 'redis';
export { FastifyInstance } from 'fastify';

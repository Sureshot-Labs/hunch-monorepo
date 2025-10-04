// Environment configuration for monitoring service
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  
  // Monitoring service configuration
  MONITORING_PORT: z.coerce.number().default(3007),
  MONITORING_METRICS_PORT: z.coerce.number().default(9090),
  MONITORING_METRICS_PATH: z.string().default('/metrics'),
  
  // Alert configuration
  MONITORING_ALERT_INTERVAL: z.coerce.number().default(10),
  MONITORING_ALERT_COOLDOWN: z.coerce.number().default(5),
  MONITORING_ALERT_MAX_RETRIES: z.coerce.number().default(3),
  
  // Retention configuration
  MONITORING_METRICS_RETENTION: z.coerce.number().default(30),
  MONITORING_ALERTS_RETENTION: z.coerce.number().default(90),
  MONITORING_LOGS_RETENTION: z.coerce.number().default(7),
  
  // Notification configuration
  ALERT_EMAIL: z.string().email().optional(),
  ALERT_SLACK_WEBHOOK: z.string().url().optional(),
  ALERT_PAGERDUTY_KEY: z.string().optional(),
  ALERT_SMS_PROVIDER: z.string().optional(),
  
  // SMTP configuration for email alerts
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z.coerce.boolean().default(false),
  
  // Health check configuration
  HEALTH_CHECK_TIMEOUT: z.coerce.number().default(5000),
  HEALTH_CHECK_INTERVAL: z.coerce.number().default(30),
  
  // Metrics collection configuration
  METRICS_COLLECTION_INTERVAL: z.coerce.number().default(10),
  METRICS_BATCH_SIZE: z.coerce.number().default(100),
  
  // Logging configuration
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('pretty'),
});

export const env = envSchema.parse(process.env);

// Export individual configuration objects
export const monitoringConfig = {
  port: env.MONITORING_PORT,
  metrics: {
    port: env.MONITORING_METRICS_PORT,
    path: env.MONITORING_METRICS_PATH,
    collectionInterval: env.METRICS_COLLECTION_INTERVAL,
    batchSize: env.METRICS_BATCH_SIZE,
  },
  alerts: {
    evaluationInterval: env.MONITORING_ALERT_INTERVAL,
    cooldownPeriod: env.MONITORING_ALERT_COOLDOWN,
    maxRetries: env.MONITORING_ALERT_MAX_RETRIES,
  },
  retention: {
    metricsRetentionDays: env.MONITORING_METRICS_RETENTION,
    alertsRetentionDays: env.MONITORING_ALERTS_RETENTION,
    logsRetentionDays: env.MONITORING_LOGS_RETENTION,
  },
  healthChecks: {
    timeout: env.HEALTH_CHECK_TIMEOUT,
    interval: env.HEALTH_CHECK_INTERVAL,
  },
  notifications: {
    email: env.ALERT_EMAIL,
    slack: env.ALERT_SLACK_WEBHOOK,
    pagerduty: env.ALERT_PAGERDUTY_KEY,
    sms: env.ALERT_SMS_PROVIDER,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      secure: env.SMTP_SECURE,
    },
  },
  logging: {
    level: env.LOG_LEVEL,
    format: env.LOG_FORMAT,
  },
};

import type { FastifyReply } from "fastify";

import { ContentError } from "../services/content-errors.js";

const RETRYABLE_DATABASE_CODES = new Set(["57014", "55P03", "40P01", "40001"]);

export function sendContentError(
  reply: FastifyReply,
  error: unknown,
  options: {
    databaseBusyMessage: string;
    onRevisionConflict?: () => void;
  },
) {
  if (!(error instanceof ContentError)) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (RETRYABLE_DATABASE_CODES.has(code)) {
      reply.header("Retry-After", "1");
      return reply.code(503).send({
        error: "content_database_busy",
        message: options.databaseBusyMessage,
      });
    }
    throw error;
  }
  if (error.code === "content_revision_conflict") {
    options.onRevisionConflict?.();
  }
  reply.code(error.statusCode);
  return reply.send({
    error: error.code,
    message: error.message,
    ...(error.issues ? { issues: error.issues } : {}),
    ...(error.details ? { details: error.details } : {}),
  });
}

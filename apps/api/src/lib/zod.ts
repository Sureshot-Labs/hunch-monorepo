import type { FastifyReply } from "fastify";
import type { ZodType } from "zod";

export function parseOrReply<T>(
  reply: FastifyReply,
  schema: ZodType<T>,
  input: unknown,
): T | null {
  const result = schema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? "Invalid request";
    reply.code(400);
    reply.send({ error: message });
    return null;
  }
  return result.data;
}

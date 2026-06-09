import type { FastifyReply } from "fastify";

export const UNSUPPORTED_HYPERLIQUID_VENUE = "hyperliquid";

export function hasUnsupportedHyperliquidVenue(input: {
  venue?: string | null;
  venues?: readonly string[] | null;
}): boolean {
  return (
    input.venue === UNSUPPORTED_HYPERLIQUID_VENUE ||
    Boolean(input.venues?.includes(UNSUPPORTED_HYPERLIQUID_VENUE))
  );
}

export function sendUnsupportedVenue(
  reply: FastifyReply,
  venue = UNSUPPORTED_HYPERLIQUID_VENUE,
) {
  reply.code(400);
  return reply.send({
    error: `${venue} is not supported for this endpoint.`,
    code: "unsupported_venue",
    venue,
  });
}

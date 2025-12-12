import "fastify";
import type { AuthSession, User } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
    walletAddress?: string;
    session?: AuthSession;
    _t0?: number;
  }
}

import "fastify";
import type { AuthSession, User } from "./auth.js";
import type {
  AdminAccount,
  AdminActor,
  AdminSession,
} from "./services/admin-auth.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
    walletAddress?: string;
    session?: AuthSession;
    adminAccount?: AdminAccount;
    adminActor?: AdminActor;
    adminSession?: AdminSession;
    _t0?: number;
  }
}

import "fastify";
import type { AuthSession, User } from "./auth.js";
import type {
  AdminAccount,
  AdminActor,
  AdminSession,
} from "./services/admin-auth.js";
import type {
  AdminServiceCredential,
  AdminServicePrincipal,
} from "./services/admin-service-auth.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
    walletAddress?: string;
    session?: AuthSession;
    adminAccount?: AdminAccount;
    adminActor?: AdminActor;
    adminSession?: AdminSession;
    adminServicePrincipal?: AdminServicePrincipal;
    adminServiceCredential?: AdminServiceCredential;
    _t0?: number;
  }
}

import "fastify";
import type { AuthSession, User } from "./auth.js";
import type {
  AdminAccount,
  AdminActor,
  AdminSession,
} from "./services/admin-auth.js";
import type { ContentActor } from "./services/content-actor.js";
import type {
  JournalServiceCredential,
  JournalServicePrincipal,
} from "./services/journal-service-auth.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
    walletAddress?: string;
    session?: AuthSession;
    adminAccount?: AdminAccount;
    adminActor?: AdminActor;
    adminSession?: AdminSession;
    contentActor?: ContentActor;
    journalServicePrincipal?: JournalServicePrincipal;
    journalServiceCredential?: JournalServiceCredential;
    journalServiceRequiredScope?: string;
    _t0?: number;
  }
}

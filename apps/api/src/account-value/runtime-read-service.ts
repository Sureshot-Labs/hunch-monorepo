import { pool } from "../db.js";
import { createAccountValueReadService } from "./read-service.js";
import { buildAccountValueReadModel } from "./runtime-service.js";

export const accountValueReadService = createAccountValueReadService(
  (userId) => buildAccountValueReadModel({ pool, userId }),
  { maxEntries: 500, retentionMs: 60_000, ttlMs: 2_000 },
);

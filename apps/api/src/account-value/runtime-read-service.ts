import { pool } from "../db.js";
import { buildAccountValueReadModel } from "./runtime-service.js";
import { createAccountValueSnapshotLoader } from "./snapshot-loader.js";

export const accountValueReadService = createAccountValueSnapshotLoader(
  (userId) => buildAccountValueReadModel({ pool, userId }),
  { maxEntries: 500, ttlMs: 2_000 },
);
